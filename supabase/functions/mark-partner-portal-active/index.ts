// ============================================================
// TPCH — mark-partner-portal-active Edge Function
// Deploy: supabase functions deploy mark-partner-portal-active --project-ref oreklvbzwgbufbkvvzny
//
// Called fire-and-forget by the portal frontend on every partner
// login. Idempotent: only does work the first time after a partner
// has actually logged in.
//
// Flow:
//   1. Verify caller's JWT, derive auth.uid().
//   2. Look up the caller's channel_partners row.
//        - If role is staff (no own row), no-op.
//        - If monday_status_pushed_at is already set, no-op.
//        - If monday_item_id is missing, no-op (nothing to update).
//   3. Push status "Portal" (label index 1) to the Monday card via
//      the Channel Partners board column color_mm2x5va8.
//   4. Stamp monday_status_pushed_at = now().
//   5. If the partner was invited within the last 7 days, send
//      an admin notification email via Resend. Older rows (back-
//      filled historical partners) suppress the email so we don't
//      spam Mick the first time the cron runs.
//
// Secrets required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   MONDAY_API_TOKEN — Monday GraphQL token
// Optional:
//   RESEND_API_KEY  — branded admin email if set
//   ADMIN_EMAIL     — destination for the activation email (default: admin@tpch.com.au)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = new Set([
  'https://portal.tpch.com.au',
  'https://tpch.com.au',
])

const MONDAY_API                = 'https://api.monday.com/v2'
const PARTNERS_BOARD_ID         = 8393705888
const STATUS_COLUMN_ID          = 'color_mm2x5va8'
const STATUS_PORTAL_LABEL_INDEX = 1                    // "Portal" (green) on the Channel Partners board
const FRESH_ACTIVATION_DAYS     = 7                    // window for sending the admin notification email

function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://portal.tpch.com.au'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  }
}

async function setMondayStatusPortal(itemId: string, token: string): Promise<boolean> {
  const query = `mutation {
    change_column_value(
      board_id: ${PARTNERS_BOARD_ID},
      item_id: ${itemId},
      column_id: ${JSON.stringify(STATUS_COLUMN_ID)},
      value: ${JSON.stringify(JSON.stringify({ index: STATUS_PORTAL_LABEL_INDEX }))}
    ) { id }
  }`
  try {
    const res = await fetch(MONDAY_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': token,
        'API-Version':   '2023-10',
      },
      body: JSON.stringify({ query }),
    })
    const json = await res.json()
    if (json.errors) {
      console.error('Monday GraphQL error:', JSON.stringify(json.errors))
      return false
    }
    return !!json?.data?.change_column_value?.id
  } catch (e) {
    console.error('Monday GraphQL exception:', e)
    return false
  }
}

async function sendActivationEmail(opts: {
  resendKey: string
  to:        string
  partner: { full_name: string; email: string; company_name: string; created_at: string }
}): Promise<void> {
  const { full_name, email, company_name, created_at } = opts.partner
  const invitedAt = new Date(created_at)
  const invitedDisplay = invitedAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;">
    <div style="background:#080F1A;padding:24px 32px;">
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;">Partner Activation</div>
      <div style="font-size:18px;color:#F5F3EE;font-weight:600;margin-top:4px;">${full_name} just connected to the portal</div>
    </div>
    <div style="padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#2A3A50;">
        <tr><td style="padding:6px 0;width:140px;color:#5A6878;">Firm</td><td style="padding:6px 0;color:#080F1A;font-weight:600;">${company_name}</td></tr>
        <tr><td style="padding:6px 0;color:#5A6878;">Contact</td><td style="padding:6px 0;color:#080F1A;">${full_name}</td></tr>
        <tr><td style="padding:6px 0;color:#5A6878;">Email</td><td style="padding:6px 0;color:#080F1A;">${email}</td></tr>
        <tr><td style="padding:6px 0;color:#5A6878;">Invited</td><td style="padding:6px 0;color:#080F1A;">${invitedDisplay}</td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:13px;color:#5A6878;line-height:1.6;">Their card on the Channel Partners board has been flipped to <strong style="color:#080F1A;">Portal</strong>.</p>
    </div>
  </div>
</body>
</html>`
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${opts.resendKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from:    'TPCH Partner Network <noreply@tpch.com.au>',
      to:      [opts.to],
      subject: `Portal activated: ${full_name} (${company_name})`,
      html,
    }),
  })
  if (!res.ok) console.error('Resend error:', await res.text())
}

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  function json(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const jwtToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwtToken) return json({ error: 'Sign in required' }, 401)

    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwtToken)
    if (userErr || !userRes?.user) return json({ error: 'Invalid session' }, 401)
    const callerUid = userRes.user.id

    const { data: partner, error: partnerErr } = await supabase
      .from('channel_partners')
      .select('id, full_name, email, company_name, monday_item_id, monday_status_pushed_at, created_at')
      .eq('user_id', callerUid)
      .eq('status', 'active')
      .maybeSingle()

    if (partnerErr) return json({ error: partnerErr.message }, 500)
    if (!partner)  return json({ skipped: 'not_a_partner_owner' })           // staff or admin
    if (partner.monday_status_pushed_at) return json({ skipped: 'already_pushed' })
    if (!partner.monday_item_id)         return json({ skipped: 'no_monday_item' })

    const mondayToken = Deno.env.get('MONDAY_API_TOKEN') || ''
    if (!mondayToken) {
      console.warn('MONDAY_API_TOKEN not set; cannot push status')
      return json({ error: 'monday_token_missing' }, 500)
    }

    const ok = await setMondayStatusPortal(partner.monday_item_id, mondayToken)
    if (!ok) return json({ error: 'monday_update_failed' }, 502)

    const now = new Date().toISOString()
    const { error: updErr } = await supabase
      .from('channel_partners')
      .update({ monday_status_pushed_at: now })
      .eq('id', partner.id)
    if (updErr) console.error('Failed to stamp monday_status_pushed_at:', updErr.message)

    // Notify admin only for genuinely fresh activations (not back-fill).
    const ageDays = (Date.now() - new Date(partner.created_at).getTime()) / 86_400_000
    const resendKey  = Deno.env.get('RESEND_API_KEY') || ''
    const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'
    if (resendKey && ageDays <= FRESH_ACTIVATION_DAYS) {
      await sendActivationEmail({
        resendKey,
        to: adminEmail,
        partner: {
          full_name:    partner.full_name,
          email:        partner.email,
          company_name: partner.company_name,
          created_at:   partner.created_at,
        },
      })
    }

    return json({ success: true, partner_id: partner.id, emailed: resendKey && ageDays <= FRESH_ACTIVATION_DAYS })
  } catch (err: any) {
    console.error('mark-partner-portal-active error:', err)
    return json({ error: err.message }, 500)
  }
})
