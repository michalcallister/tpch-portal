// ============================================================
// TPCH — invite-team Edge Function
// Deploy: supabase functions deploy invite-team
//
// Adds a TPCH admin (a tpch_team row) and the Supabase Auth account
// that backs their portal login, then emails them a branded invite so
// they set their own password.
//
// WHY THIS EXISTS
//   The portal's "Add Member" form used to POST straight to
//   public.tpch_team with a plaintext `password` column. The Apr 2026
//   security hardening moved admins onto Supabase Auth and dropped that
//   column, so the insert started failing with a bare "Could not add
//   member" — and even if it had succeeded, no auth.users account would
//   exist for the person to log in with. Creating an auth user needs the
//   service role, so it has to happen server-side, here.
//
// Auth:
//   * JWT verification REQUIRED (verify_jwt: true).
//   * Caller must be an active tpch_team row (admin).
//   * Only a super_admin may create another super_admin.
//   * CORS locked to portal.tpch.com.au + tpch.com.au.
//
// Body: { full_name, email, role? }   role: 'admin' (default) | 'super_admin'
//
// Secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: PORTAL_URL, RESEND_API_KEY, ADMIN_EMAIL
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = new Set([
  'https://portal.tpch.com.au',
  'https://tpch.com.au',
])

function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://portal.tpch.com.au'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  }
}

// Send via Resend with one retry on a transient (429 / 5xx) failure, and
// report honestly whether it actually went out so the portal can tell the
// admin to fall back to "Forgot password" instead of silently succeeding.
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

function inviteHtml(opts: { firstName: string; roleLabel: string; inviteLink: string; adminEmail: string }) {
  const { firstName, roleLabel, inviteLink, adminEmail } = opts
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
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">Welcome to the team, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C8A951;letter-spacing:1px;text-transform:uppercase;">${roleLabel} access</p>
      <p style="margin:0 0 20px;font-size:15px;color:#2A3A50;line-height:1.7;">You have been given <strong style="color:#080F1A;">${roleLabel}</strong> access to the TPCH Partner Portal. Use the button below to set your password and sign in.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#2A3A50;line-height:1.7;">This link is valid for <strong style="color:#080F1A;">24 hours</strong>.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C8A951;color:#080F1A;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Sign In
        </a>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#2A3A50;line-height:1.7;">Questions? Contact us at <a href="mailto:${adminEmail}" style="color:#C8A951;text-decoration:none;">${adminEmail}</a>.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#080F1A;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#112240;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A6878;">The Property Clearing House &middot; <a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#98A5B3;">You are receiving this because you were added to the TPCH team.</p>
    </div>
  </div>
</body>
</html>`
}

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Where the invite link lands. MUST be the portal origin: tpch.com.au is the
  // marketing site and has no set-password screen, so landing there spends the
  // one-time token and leaves the person confirmed with no password set.
  // Plain URL, no hash fragment: Supabase appends #access_token=... itself and
  // the portal's hash parser cannot decode a doubled hash.
  const redirectTo = Deno.env.get('PORTAL_URL') || 'https://portal.tpch.com.au'

  function json(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    // ── Auth: caller must be an active admin ────────────────────────────
    const jwtToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwtToken) return json({ error: 'Sign in required' }, 401)

    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwtToken)
    if (userErr || !userRes?.user) return json({ error: 'Invalid session' }, 401)

    const { data: adminRow } = await supabase
      .from('tpch_team')
      .select('id, role')
      .eq('user_id', userRes.user.id)
      .eq('status', 'active')
      .maybeSingle()
    if (!adminRow) return json({ error: 'Admin only' }, 403)

    const body = await req.json()
    const full_name = String(body.full_name || '').trim()
    const email     = String(body.email || '').trim().toLowerCase()
    const teamRole  = body.role === 'super_admin' ? 'super_admin' : 'admin'

    if (!full_name || !email) return json({ error: 'full_name and email are required' }, 400)
    if (teamRole === 'super_admin' && adminRow.role !== 'super_admin') {
      return json({ error: 'Only a super admin can create a super admin' }, 403)
    }

    // ── Auth account: invite, or a set-password link if one already exists
    let linkData: any = null
    const { data: inviteData, error: inviteErr } = await supabase.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { redirectTo, data: { full_name, tpch_role: 'admin' } },
    })

    if (inviteErr && inviteErr.message.toLowerCase().includes('already')) {
      // Already has an account (e.g. re-invite, or they were a partner first).
      const { data: recoveryData, error: recoveryErr } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo },
      })
      if (recoveryErr) return json({ error: recoveryErr.message }, 500)
      linkData = recoveryData
    } else if (inviteErr) {
      return json({ error: inviteErr.message }, 500)
    } else {
      linkData = inviteData
    }

    const inviteLink = linkData?.properties?.action_link ?? redirectTo
    const authUserId = linkData?.user?.id ?? null

    // ── tpch_team row (upsert so a re-invite refreshes rather than 409s)
    const { data: member, error: memberErr } = await supabase
      .from('tpch_team')
      .upsert(
        {
          full_name,
          email,
          role: teamRole,
          status: 'active',
          ...(authUserId ? { user_id: authUserId } : {}),
        },
        { onConflict: 'email', ignoreDuplicates: false }
      )
      .select('id, full_name, email, role, status, joined_at, updated_at, user_id')
      .single()

    if (memberErr) return json({ error: memberErr.message }, 500)

    // ── Branded invite email
    const resendKey  = Deno.env.get('RESEND_API_KEY') || ''
    const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'
    const firstName  = full_name.split(' ')[0] || full_name
    const roleLabel  = teamRole === 'super_admin' ? 'Super Admin' : 'Admin'

    let emailResult: { sent: boolean; error: string | null } =
      { sent: false, error: 'email provider not configured (RESEND_API_KEY missing)' }
    if (resendKey) {
      emailResult = await sendResendEmail(resendKey, {
        from: 'TPCH <noreply@tpch.com.au>',
        to: [email],
        subject: 'Your TPCH Partner Portal admin access',
        html: inviteHtml({ firstName, roleLabel, inviteLink, adminEmail }),
      })
    }

    // redirect_to is echoed back so a misconfigured PORTAL_URL / Supabase
    // "Site URL" is visible instead of silently swallowing the invite.
    return json({ success: true, member, redirect_to: redirectTo, email_sent: emailResult.sent, email_error: emailResult.error })

  } catch (err: any) {
    console.error('invite-team error:', err)
    return json({ error: err.message }, 500)
  }
})
