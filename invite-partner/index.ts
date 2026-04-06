// ============================================================
// TPCH — invite-partner Edge Function
// Deploy: supabase functions deploy invite-partner
//
// Handles two invite types:
//   type: "partner"  — admin invites a new channel partner directly
//   type: "staff"    — partner owner invites a staff member
//
// Secrets required (auto-injected):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   PORTAL_URL  — base URL for the invite redirect (default: https://tpch.com.au)
//   RESEND_API_KEY — if set, sends a branded invite email instead of Supabase default
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const portalUrl = Deno.env.get('PORTAL_URL') || 'https://tpch.com.au'
  const redirectTo = `${portalUrl}#login`

  try {
    const body = await req.json()
    const { type } = body

    // ── Partner invite (admin → new channel partner) ──────────────
    if (type === 'partner') {
      const { full_name, email, company_name, role_type, state, notes } = body

      if (!full_name || !email || !company_name) {
        return json({ error: 'full_name, email and company_name are required' }, 400)
      }

      // Upsert channel_partners row
      const { data: partner, error: partnerErr } = await supabase
        .from('channel_partners')
        .upsert(
          { full_name, email, company_name, role_type, state, notes, status: 'active' },
          { onConflict: 'email', ignoreDuplicates: false }
        )
        .select('id')
        .single()

      if (partnerErr) return json({ error: partnerErr.message }, 500)

      // Send Supabase Auth invite email
      const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
        data: { full_name, partner_id: partner.id, tpch_role: 'partner' },
        redirectTo,
      })

      // "User already registered" is fine — they may be re-invited
      if (inviteErr && !inviteErr.message.includes('already')) {
        return json({ error: inviteErr.message }, 500)
      }

      return json({ success: true, partner_id: partner.id })
    }

    // ── Staff invite (partner owner → their team member) ──────────
    if (type === 'staff') {
      const { full_name, email, role, partner_id, comm_display_type, comm_custom_value } = body

      if (!full_name || !email || !partner_id) {
        return json({ error: 'full_name, email and partner_id are required' }, 400)
      }

      // Upsert partner_staff row
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

      // Get firm name for the invite email context
      const { data: firm } = await supabase
        .from('channel_partners')
        .select('company_name, full_name')
        .eq('id', partner_id)
        .single()

      // Send Supabase Auth invite
      const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
        data: {
          full_name,
          staff_id: staff.id,
          partner_id,
          tpch_role: 'staff',
          firm_name: firm?.company_name,
        },
        redirectTo,
      })

      if (inviteErr && !inviteErr.message.includes('already')) {
        return json({ error: inviteErr.message }, 500)
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

      // Try invite first; if user already exists fall back to recovery (password reset)
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

      // Send branded welcome email via Resend
      const welcomeHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Your portal access link, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">New access link — ${company_name || 'TPCH Partner Network'}</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">A new access link has been generated for your account. Click the button below to set your password and access the TPCH Partner Portal.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">This link is valid for <strong style="color:#1A1A16;">24 hours</strong>. If it expires, please contact us and we will send a new one.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C9A84C;color:#0A0A08;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Access Portal →
        </a>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#3A3A35;line-height:1.7;">If you have any questions, reach out to us at <a href="mailto:${adminEmail}" style="color:#C9A84C;text-decoration:none;">${adminEmail}</a>.</p>
      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">We look forward to working with you.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">You're receiving this email because an admin resent your portal access link.</p>
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

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
