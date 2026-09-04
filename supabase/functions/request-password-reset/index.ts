// ============================================================
// TPCH — request-password-reset Edge Function
// Deploy: supabase functions deploy request-password-reset --no-verify-jwt
//
// Branded "Forgot password?" for the portal.
//
// WHY THIS EXISTS
//   The login screen used to POST straight to Supabase's /auth/v1/recover,
//   which hands the whole job to Supabase: its mailer, its sender address,
//   its plain default template. Every other email the portal sends (invites,
//   certificates, reservations) goes out branded through Resend from
//   noreply@tpch.com.au. Reset was the odd one out, and it looked it.
//   This mints the recovery link ourselves and sends our own template.
//
// Auth: NONE — a logged-out person has to be able to call it
//   (verify_jwt: false). That removes GoTrue's own rate limiting from in
//   front of the send, so we throttle per email ourselves via
//   public.password_reset_requests. CORS is locked to the portal.
//
// Never reveals whether an address is registered: every outcome returns the
// same 200 body, so the form can't be used to enumerate partner emails.
//
// Body: { email }
//
// Secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: PORTAL_URL, RESEND_API_KEY, ADMIN_EMAIL
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = new Set([
  'https://portal.tpch.com.au',
  'https://tpch.com.au',
])

// How long an address must wait between reset emails. Long enough to stop
// someone using the form as an inbox-bombing tool, short enough that a person
// who mistypes their address and retries isn't left waiting.
const COOLDOWN_SECONDS = 60

function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://portal.tpch.com.au'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  }
}

async function sendResendEmail(
  resendKey: string,
  payload: { from: string; to: string[]; subject: string; html: string },
): Promise<{ sent: boolean; error: string | null }> {
  if (!resendKey) return { sent: false, error: 'email provider not configured (RESEND_API_KEY missing)' }
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) return { sent: true, error: null }
      lastErr = `Resend responded ${res.status}: ${await res.text()}`
      if (res.status < 500 && res.status !== 429) break
    } catch (e: any) {
      lastErr = e?.message || String(e)
    }
  }
  console.error('Resend send failed:', lastErr)
  return { sent: false, error: lastErr }
}

function resetHtml(opts: { firstName: string; resetLink: string; adminEmail: string }) {
  const { firstName, resetLink, adminEmail } = opts
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F5F3EE;">
    <div style="background:#112240;padding:28px 36px;text-align:center;">
      <div style="font-family:Georgia,serif;font-size:24px;font-weight:600;letter-spacing:3px;color:#F5F3EE;">TPCH</div>
      <div style="font-size:8px;color:#98A5B3;letter-spacing:2px;text-transform:uppercase;margin-top:4px;">The Property Clearing House</div>
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;margin-top:10px;">Vision. Intelligence. Advantage.</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C8A951,#E8D48B,#C8A951);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">Reset your password, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C8A951;letter-spacing:1px;text-transform:uppercase;">Partner Portal access</p>
      <p style="margin:0 0 20px;font-size:15px;color:#2A3A50;line-height:1.7;">We received a request to reset the password on your TPCH Partner Portal account. Use the button below to choose a new one.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#2A3A50;line-height:1.7;">This link is valid for <strong style="color:#080F1A;">24 hours</strong> and can only be used once.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${resetLink}" style="display:inline-block;background:#C8A951;color:#080F1A;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Choose a New Password
        </a>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#2A3A50;line-height:1.7;">If you did not request this, you can safely ignore this email. Your password will not change until you use the link above.</p>
      <p style="margin:0 0 8px;font-size:14px;color:#2A3A50;line-height:1.7;">Questions? Contact us at <a href="mailto:${adminEmail}" style="color:#C8A951;text-decoration:none;">${adminEmail}</a>.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#080F1A;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#112240;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A6878;">The Property Clearing House &middot; <a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#98A5B3;">You are receiving this because a password reset was requested for this address.</p>
    </div>
  </div>
</body>
</html>`
}

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  // One response for every outcome — sent, throttled, unknown address, or a
  // Resend failure. Anything that varies by outcome tells an attacker which
  // addresses are real.
  const GENERIC = { success: true }
  function json(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Must be the portal origin: tpch.com.au is the marketing site and has no
  // set-password screen. Plain URL, no hash — Supabase appends its own.
  const redirectTo = Deno.env.get('PORTAL_URL') || 'https://portal.tpch.com.au'

  try {
    const body  = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(GENERIC)

    // ── Per-email cooldown ──────────────────────────────────────────────
    const { data: throttle } = await supabase
      .from('password_reset_requests')
      .select('last_sent_at, send_count')
      .eq('email', email)
      .maybeSingle()

    if (throttle?.last_sent_at) {
      const since = (Date.now() - new Date(throttle.last_sent_at).getTime()) / 1000
      if (since < COOLDOWN_SECONDS) {
        console.log(`reset throttled for ${email} (${Math.round(since)}s since last)`)
        return json(GENERIC)
      }
    }

    // ── Mint the recovery link ──────────────────────────────────────────
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    })

    if (linkErr) {
      // Unknown address is the normal case here, not an incident: log it and
      // return the same body as a success so the form stays non-enumerable.
      console.log(`no recovery link for ${email}: ${linkErr.message}`)
      return json(GENERIC)
    }

    const resetLink = linkData?.properties?.action_link
    if (!resetLink) return json(GENERIC)

    // ── Send it branded ─────────────────────────────────────────────────
    const resendKey  = Deno.env.get('RESEND_API_KEY') || ''
    const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'
    const fullName   = String(linkData?.user?.user_metadata?.full_name || '').trim()
    const firstName  = fullName.split(' ')[0] || 'there'

    const emailResult = await sendResendEmail(resendKey, {
      from: 'TPCH <noreply@tpch.com.au>',
      to: [email],
      subject: 'Reset your TPCH Partner Portal password',
      html: resetHtml({ firstName, resetLink, adminEmail }),
    })

    if (!emailResult.sent) console.error(`reset email failed for ${email}: ${emailResult.error}`)

    await supabase
      .from('password_reset_requests')
      .upsert(
        {
          email,
          last_sent_at: new Date().toISOString(),
          send_count: (throttle?.send_count ?? 0) + 1,
        },
        { onConflict: 'email' }
      )

    return json(GENERIC)

  } catch (err: any) {
    // Even a crash returns the generic body: the person is told to check their
    // inbox either way, and we surface the real reason in the function logs.
    console.error('request-password-reset error:', err)
    return json(GENERIC)
  }
})
