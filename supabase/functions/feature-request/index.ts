// ============================================================
// TPCH Portal — Feature Request mailer
// Supabase Edge Function: feature-request
//
// Receives a "Request a feature" form submission from the portal,
// authenticates the caller against auth.users, and emails the
// request to FEATURE_REQUEST_TO (default: michal@tpch.com.au)
// via Resend, with reply-to set to the requester so Mick can
// reply directly.
//
// POST /feature-request
//   Headers: Authorization: Bearer <jwt>
//   Body:    { title, description, name, phone }
//   Returns: { ok: true } on success, { error, ... } otherwise.
//
// Secrets:
//   SUPABASE_URL                (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   RESEND_API_KEY              (required)
//   FEATURE_REQUEST_TO          (optional, default michal@tpch.com.au)
//   FEATURE_REQUEST_FROM        (optional, default 'TPCH Portal <noreply@tpch.com.au>')
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const FEATURE_REQUEST_TO   = Deno.env.get('FEATURE_REQUEST_TO')   || 'michal@tpch.com.au'
const FEATURE_REQUEST_FROM = Deno.env.get('FEATURE_REQUEST_FROM') || 'TPCH Portal <noreply@tpch.com.au>'

const sb = createClient(SUPABASE_URL, SERVICE_ROLE)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return json(405, { error: 'POST only' })

  // 1. Resolve caller from JWT — only signed-in portal users may submit.
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json(401, { error: 'Missing bearer token' })
  const { data: userData, error: userErr } = await sb.auth.getUser(token)
  if (userErr || !userData?.user?.email) {
    return json(401, { error: 'Invalid session' })
  }
  const userEmail = userData.user.email

  // 2. Parse + validate payload.
  let body: any
  try { body = await req.json() } catch { return json(400, { error: 'Invalid JSON' }) }
  const title       = String(body.title       || '').trim().slice(0, 120)
  const description = String(body.description || '').trim().slice(0, 2000)
  const name        = String(body.name        || '').trim().slice(0, 120)
  const phone       = String(body.phone       || '').trim().slice(0, 40)
  if (!title || !description || !name || !phone) {
    return json(400, { error: 'title, description, name and phone are all required' })
  }

  // 3. Best-effort: enrich with partner_users context if the caller is a partner.
  let partnerLine = ''
  try {
    const { data: pu } = await sb.from('partner_users')
      .select('full_name, company_name, role')
      .eq('email', userEmail)
      .maybeSingle()
    if (pu) {
      const parts = [pu.full_name, pu.company_name].filter(Boolean).join(' — ')
      partnerLine = parts ? `${parts} (${pu.role || 'partner'})` : `(${pu.role || 'partner'})`
    }
  } catch (_) { /* non-fatal */ }

  // 4. Compose + send via Resend.
  const subject = `Portal feature request: ${title}`
  const html = `
    <div style="font-family:Georgia,serif;color:#080F1A;max-width:640px;">
      <h2 style="font-family:'Playfair Display',Georgia,serif;color:#080F1A;border-bottom:1px solid #C8A951;padding-bottom:6px;">Portal feature request</h2>
      <p style="font-size:14px;"><strong>${escapeHtml(title)}</strong></p>
      <p style="font-size:14px;white-space:pre-wrap;">${escapeHtml(description)}</p>
      <hr style="border:none;border-top:1px solid #C8A951;margin:18px 0;">
      <table style="font-size:13px;border-collapse:collapse;">
        <tr><td style="padding:2px 12px 2px 0;color:#666;">From</td><td>${escapeHtml(name)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666;">Email</td><td>${escapeHtml(userEmail)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666;">Phone</td><td>${escapeHtml(phone)}</td></tr>
        ${partnerLine ? `<tr><td style="padding:2px 12px 2px 0;color:#666;">Account</td><td>${escapeHtml(partnerLine)}</td></tr>` : ''}
      </table>
    </div>`
  const text =
    `Portal feature request — ${title}\n\n${description}\n\n` +
    `--\nFrom: ${name}\nEmail: ${userEmail}\nPhone: ${phone}\n` +
    (partnerLine ? `Account: ${partnerLine}\n` : '')

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:     FEATURE_REQUEST_FROM,
      to:       [FEATURE_REQUEST_TO],
      reply_to: userEmail,
      subject,
      html,
      text,
    }),
  })
  if (!resendRes.ok) {
    const detail = await resendRes.text()
    return json(502, { error: 'Email send failed', detail })
  }

  return json(200, { ok: true })
})
