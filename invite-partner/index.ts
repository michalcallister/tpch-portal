// ============================================================
// TPCH — invite-partner Edge Function (HARDENED)
// Deploy: supabase functions deploy invite-partner
//
// SECURITY HARDENING (Apr 2026):
//   * JWT verification REQUIRED (verify_jwt: true).
//   * type='partner' and type='resend' require an admin JWT
//     (caller's auth.uid() must match an active tpch_team row).
//   * type='staff' requires the caller to either be admin OR own
//     the supplied partner_id (channel_partners.user_id = caller).
//   * CORS locked to portal.tpch.com.au + tpch.com.au.
//
// Handles three invite types:
//   type: "partner"  — admin invites a new channel partner directly
//   type: "staff"    — partner owner invites a staff member
//   type: "resend"   — admin resends portal access link to existing partner
//
// Secrets required (auto-injected):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   PORTAL_URL     — base URL for the invite redirect (default: https://tpch.com.au)
//   RESEND_API_KEY — if set, sends branded email via Resend instead of Supabase default
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

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const portalUrl = Deno.env.get('PORTAL_URL') || 'https://tpch.com.au'
  const redirectTo = `${portalUrl}#login`

  function json(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    // ── Auth: derive caller from JWT ─────────────────────────────────────
    const jwtToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwtToken) return json({ error: 'Sign in required' }, 401)

    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwtToken)
    if (userErr || !userRes?.user) return json({ error: 'Invalid session' }, 401)
    const callerUid = userRes.user.id

    // Determine if caller is admin
    const { data: adminRow } = await supabase
      .from('tpch_team')
      .select('id')
      .eq('user_id', callerUid)
      .eq('status', 'active')
      .maybeSingle()
    const isAdmin = !!adminRow

    const body = await req.json()
    const { type } = body

    // ── Type-specific authorisation ──────────────────────────────────────
    if (type === 'partner' || type === 'resend') {
      if (!isAdmin) return json({ error: 'Admin only' }, 403)
    } else if (type === 'staff') {
      // Caller must be admin OR own the supplied partner_id
      if (!isAdmin) {
        if (!body.partner_id) return json({ error: 'partner_id is required' }, 400)
        const { data: ownerRow } = await supabase
          .from('channel_partners')
          .select('id')
          .eq('user_id', callerUid)
          .eq('id', body.partner_id)
          .eq('status', 'active')
          .maybeSingle()
        if (!ownerRow) return json({ error: 'Not authorised for this partner firm' }, 403)
      }
    } else {
      return json({ error: 'type must be "partner", "staff", or "resend"' }, 400)
    }

    // ── Partner invite (admin → new channel partner) ──────────────
    if (type === 'partner') {
      const { full_name, email, company_name, role_type, state, notes } = body

      if (!full_name || !email || !company_name) {
        return json({ error: 'full_name, email and company_name are required' }, 400)
      }

      const { data: partner, error: partnerErr } = await supabase
        .from('channel_partners')
        .upsert(
          { full_name, email, company_name, role_type, state, notes, status: 'active' },
          { onConflict: 'email', ignoreDuplicates: false }
        )
        .select('id')
        .single()

      if (partnerErr) return json({ error: partnerErr.message }, 500)

      const resendKey  = Deno.env.get('RESEND_API_KEY') || ''
      const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'
      const firstName  = full_name?.split(' ')[0] || full_name || 'there'

      let linkData: any = null
      const { data: inviteData, error: inviteErr } = await supabase.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo, data: { full_name, partner_id: partner.id, tpch_role: 'partner' } },
      })

      if (inviteErr && inviteErr.message.toLowerCase().includes('already')) {
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

      if (resendKey) {
        const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F5F3EE;">
    <div style="background:#112240;padding:28px 36px;text-align:center;">
      <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMDAgNjQiIGZpbGw9Im5vbmUiPgogIDwhLS0gRW1ibGVtIC0tPgogIDxyZWN0IHg9IjE4IiB5PSIxMCIgd2lkdGg9IjM0IiBoZWlnaHQ9IjM0IiByeD0iMyIgdHJhbnNmb3JtPSJyb3RhdGUoNDUgMzUgMjcpIiBmaWxsPSIjQzhBOTUxIi8+CiAgPHBvbHlnb24gcG9pbnRzPSIyMSwxMCA4LDIyIDM0LDIyIiBmaWxsPSIjRjVGM0VFIi8+CiAgPHJlY3QgeD0iMTAiIHk9IjIxIiB3aWR0aD0iMjQiIGhlaWdodD0iMTgiIGZpbGw9IiNGNUYzRUUiLz4KICA8cmVjdCB4PSIxNiIgeT0iMzAiIHdpZHRoPSIxMCIgaGVpZ2h0PSI5IiBmaWxsPSIjQzhBOTUxIi8+CiAgPCEtLSBXb3JkbWFyayAtLT4KICA8dGV4dCB4PSI3NiIgeT0iMzYiIGZvbnQtZmFtaWx5PSJHZW9yZ2lhLCBzZXJpZiIgZm9udC1zaXplPSIyMiIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iI0Y1RjNFRSIgbGV0dGVyLXNwYWNpbmc9IjIiPlRQQ0g8L3RleHQ+CiAgPHRleHQgeD0iNzYiIHk9IjUwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iIzk4QTVCMyIgbGV0dGVyLXNwYWNpbmc9IjIiPlRIRSBQUk9QRVJUWSBDTEVBUklORyBIT1VTRTwvdGV4dD4KPC9zdmc+Cg==" width="220" height="47" alt="TPCH" style="display:block;margin:0 auto;">
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;margin-top:10px;">Vision. Intelligence. Advantage.</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C8A951,#E8D48B,#C8A951);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">Welcome to the network, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C8A951;letter-spacing:1px;text-transform:uppercase;">Partner access — ${company_name}</p>
      <p style="margin:0 0 20px;font-size:15px;color:#2A3A50;line-height:1.7;">You've been added as a channel partner at <strong style="color:#080F1A;">${company_name}</strong>. Click the button below to set your password and access the TPCH Partner Portal.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#2A3A50;line-height:1.7;">This link is valid for <strong style="color:#080F1A;">24 hours</strong>.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C8A951;color:#080F1A;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Access Portal →
        </a>
      </div>
      <div style="background:#F5F3EE;border:1px solid rgba(200,169,81,0.22);padding:24px;margin-bottom:32px;">
        <div style="font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#C8A951;margin-bottom:16px;">What you'll find in the portal</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${[
            ['Research Intelligence',  'AI-powered suburb analysis, demand drivers, and market conviction ratings'],
            ['Live Stock Portal',       'Browse available properties with yields, floor plans, and commission schedules'],
            ['My Deals',               'Track your pipeline from reservation through to settlement in real time'],
            ['White-Label Reports',    'Generate branded investor research reports in one click'],
          ].map(([title, desc]) => `
          <tr style="border-bottom:1px solid rgba(200,169,81,0.15);">
            <td style="padding:10px 0;vertical-align:top;">
              <div style="font-size:12px;font-weight:600;color:#080F1A;margin-bottom:2px;">${title}</div>
              <div style="font-size:12px;color:#5A6878;line-height:1.5;">${desc}</div>
            </td>
          </tr>`).join('')}
        </table>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#2A3A50;line-height:1.7;">Questions? Contact us at <a href="mailto:${adminEmail}" style="color:#C8A951;text-decoration:none;">${adminEmail}</a>.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#080F1A;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#112240;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A6878;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#98A5B3;">You're receiving this because you were invited to join the TPCH Partner Portal.</p>
    </div>
  </div>
</body>
</html>`

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'TPCH Partner Network <noreply@tpch.com.au>',
            to: [email],
            subject: `You've been invited to the TPCH Partner Portal`,
            html,
          }),
        })
        if (!emailRes.ok) console.error('Resend error:', await emailRes.text())
      }

      return json({ success: true, partner_id: partner.id })
    }

    // ── Staff invite (partner owner → their team member) ──────────
    if (type === 'staff') {
      const { full_name, email, role, partner_id, comm_display_type, comm_custom_value } = body

      if (!full_name || !email || !partner_id) {
        return json({ error: 'full_name, email and partner_id are required' }, 400)
      }

      const { data: staff, error: staffErr } = await supabase
        .from('partner_staff')
        .upsert(
          {
            full_name,
            email,
            role: role || null,
            partner_id,
            comm_display_type: comm_display_type || 'portal',
            comm_custom_value: comm_custom_value || null,
            invited_at: new Date().toISOString(),
          },
          { onConflict: 'email', ignoreDuplicates: false }
        )
        .select('id')
        .single()

      if (staffErr) return json({ error: staffErr.message }, 500)

      const { data: firm } = await supabase
        .from('channel_partners')
        .select('company_name, full_name')
        .eq('id', partner_id)
        .single()

      const resendKey  = Deno.env.get('RESEND_API_KEY') || ''
      const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'
      const firmName   = firm?.company_name || 'TPCH Partner Network'
      const firstName  = full_name?.split(' ')[0] || full_name || 'there'

      let linkData: any = null
      const { data: inviteData, error: inviteErr } = await supabase.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo: portalUrl, data: { full_name, staff_id: staff.id, partner_id, tpch_role: 'staff', firm_name: firmName } },
      })

      if (inviteErr && inviteErr.message.toLowerCase().includes('already')) {
        const { data: recoveryData, error: recoveryErr } = await supabase.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo: portalUrl },
        })
        if (recoveryErr) return json({ error: recoveryErr.message }, 500)
        linkData = recoveryData
      } else if (inviteErr) {
        return json({ error: inviteErr.message }, 500)
      } else {
        linkData = inviteData
      }

      const inviteLink = linkData?.properties?.action_link ?? portalUrl

      if (resendKey) {
        const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F5F3EE;">
    <div style="background:#112240;padding:28px 36px;text-align:center;">
      <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMDAgNjQiIGZpbGw9Im5vbmUiPgogIDwhLS0gRW1ibGVtIC0tPgogIDxyZWN0IHg9IjE4IiB5PSIxMCIgd2lkdGg9IjM0IiBoZWlnaHQ9IjM0IiByeD0iMyIgdHJhbnNmb3JtPSJyb3RhdGUoNDUgMzUgMjcpIiBmaWxsPSIjQzhBOTUxIi8+CiAgPHBvbHlnb24gcG9pbnRzPSIyMSwxMCA4LDIyIDM0LDIyIiBmaWxsPSIjRjVGM0VFIi8+CiAgPHJlY3QgeD0iMTAiIHk9IjIxIiB3aWR0aD0iMjQiIGhlaWdodD0iMTgiIGZpbGw9IiNGNUYzRUUiLz4KICA8cmVjdCB4PSIxNiIgeT0iMzAiIHdpZHRoPSIxMCIgaGVpZ2h0PSI5IiBmaWxsPSIjQzhBOTUxIi8+CiAgPCEtLSBXb3JkbWFyayAtLT4KICA8dGV4dCB4PSI3NiIgeT0iMzYiIGZvbnQtZmFtaWx5PSJHZW9yZ2lhLCBzZXJpZiIgZm9udC1zaXplPSIyMiIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iI0Y1RjNFRSIgbGV0dGVyLXNwYWNpbmc9IjIiPlRQQ0g8L3RleHQ+CiAgPHRleHQgeD0iNzYiIHk9IjUwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iIzk4QTVCMyIgbGV0dGVyLXNwYWNpbmc9IjIiPlRIRSBQUk9QRVJUWSBDTEVBUklORyBIT1VTRTwvdGV4dD4KPC9zdmc+Cg==" width="220" height="47" alt="TPCH" style="display:block;margin:0 auto;">
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;margin-top:10px;">Vision. Intelligence. Advantage.</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C8A951,#E8D48B,#C8A951);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">You've been invited, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C8A951;letter-spacing:1px;text-transform:uppercase;">Portal access — ${firmName}</p>
      <p style="margin:0 0 20px;font-size:15px;color:#2A3A50;line-height:1.7;">You've been added to the <strong style="color:#080F1A;">${firmName}</strong> team on the TPCH Partner Portal. Click the button below to set your password and get access.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#2A3A50;line-height:1.7;">This link is valid for <strong style="color:#080F1A;">24 hours</strong>.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C8A951;color:#080F1A;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Access Portal →
        </a>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#2A3A50;line-height:1.7;">Questions? Contact us at <a href="mailto:${adminEmail}" style="color:#C8A951;text-decoration:none;">${adminEmail}</a>.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#080F1A;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#112240;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A6878;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#98A5B3;">You're receiving this because you were invited to join the TPCH Partner Portal.</p>
    </div>
  </div>
</body>
</html>`

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'TPCH Partner Network <noreply@tpch.com.au>',
            to: [email],
            subject: `You've been invited to the TPCH Partner Portal`,
            html,
          }),
        })
        if (!emailRes.ok) console.error('Resend error:', await emailRes.text())
      }

      return json({ success: true, staff_id: staff.id })
    }

    // ── Resend invite (admin → existing approved partner) ─────────
    if (type === 'resend') {
      const { email, full_name, company_name } = body

      if (!email) return json({ error: 'email is required' }, 400)

      const resendKey = Deno.env.get('RESEND_API_KEY') || ''
      const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'
      const firstName = full_name?.split(' ')[0] || full_name || 'there'

      let linkData: any = null
      let { data: inviteData, error: inviteError } = await supabase.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo: portalUrl, data: { full_name, company_name } },
      })

      if (inviteError && inviteError.message.toLowerCase().includes('already')) {
        const { data: recoveryData, error: recoveryError } = await supabase.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo: portalUrl },
        })
        if (recoveryError) return json({ error: recoveryError.message }, 500)
        linkData = recoveryData
      } else if (inviteError) {
        return json({ error: inviteError.message }, 500)
      } else {
        linkData = inviteData
      }

      const inviteLink = linkData?.properties?.action_link ?? portalUrl

      const welcomeHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F5F3EE;">
    <div style="background:#112240;padding:28px 36px;text-align:center;">
      <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMDAgNjQiIGZpbGw9Im5vbmUiPgogIDwhLS0gRW1ibGVtIC0tPgogIDxyZWN0IHg9IjE4IiB5PSIxMCIgd2lkdGg9IjM0IiBoZWlnaHQ9IjM0IiByeD0iMyIgdHJhbnNmb3JtPSJyb3RhdGUoNDUgMzUgMjcpIiBmaWxsPSIjQzhBOTUxIi8+CiAgPHBvbHlnb24gcG9pbnRzPSIyMSwxMCA4LDIyIDM0LDIyIiBmaWxsPSIjRjVGM0VFIi8+CiAgPHJlY3QgeD0iMTAiIHk9IjIxIiB3aWR0aD0iMjQiIGhlaWdodD0iMTgiIGZpbGw9IiNGNUYzRUUiLz4KICA8cmVjdCB4PSIxNiIgeT0iMzAiIHdpZHRoPSIxMCIgaGVpZ2h0PSI5IiBmaWxsPSIjQzhBOTUxIi8+CiAgPCEtLSBXb3JkbWFyayAtLT4KICA8dGV4dCB4PSI3NiIgeT0iMzYiIGZvbnQtZmFtaWx5PSJHZW9yZ2lhLCBzZXJpZiIgZm9udC1zaXplPSIyMiIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iI0Y1RjNFRSIgbGV0dGVyLXNwYWNpbmc9IjIiPlRQQ0g8L3RleHQ+CiAgPHRleHQgeD0iNzYiIHk9IjUwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iIzk4QTVCMyIgbGV0dGVyLXNwYWNpbmc9IjIiPlRIRSBQUk9QRVJUWSBDTEVBUklORyBIT1VTRTwvdGV4dD4KPC9zdmc+Cg==" width="220" height="47" alt="TPCH" style="display:block;margin:0 auto;">
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;margin-top:10px;">Vision. Intelligence. Advantage.</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C8A951,#E8D48B,#C8A951);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">Your portal access link, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C8A951;letter-spacing:1px;text-transform:uppercase;">New access link — ${company_name || 'TPCH Partner Network'}</p>
      <p style="margin:0 0 20px;font-size:15px;color:#2A3A50;line-height:1.7;">A new access link has been generated for your account. Click the button below to set your password and access the TPCH Partner Portal.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#2A3A50;line-height:1.7;">This link is valid for <strong style="color:#080F1A;">24 hours</strong>. If it expires, please contact us and we will send a new one.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C8A951;color:#080F1A;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Access Portal →
        </a>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#2A3A50;line-height:1.7;">If you have any questions, reach out to us at <a href="mailto:${adminEmail}" style="color:#C8A951;text-decoration:none;">${adminEmail}</a>.</p>
      <p style="margin:0;font-size:14px;color:#2A3A50;line-height:1.7;">We look forward to working with you.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#080F1A;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#112240;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A6878;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#98A5B3;">You're receiving this email because an admin resent your portal access link.</p>
    </div>
  </div>
</body>
</html>`

      if (resendKey) {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'TPCH Partner Network <noreply@tpch.com.au>',
            to: [email],
            subject: `Your TPCH Partner Portal access link`,
            html: welcomeHtml,
          }),
        })
        if (!emailRes.ok) console.error('Resend error:', await emailRes.text())
      }

      return json({ success: true })
    }

    return json({ error: 'type must be "partner", "staff", or "resend"' }, 400)

  } catch (err: any) {
    console.error('invite-partner error:', err)
    return json({ error: err.message }, 500)
  }
})
