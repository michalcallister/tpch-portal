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

    return json({ error: 'type must be "partner" or "staff"' }, 400)

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
