// ============================================================
// TPCH — set-team-password Edge Function
// Deploy: supabase functions deploy set-team-password
//
// Lets an admin set another team member's portal password directly, for
// when the emailed invite / reset link isn't a workable route (a mail
// filter that prefetches and burns one-time links, someone who needs
// access in the next five minutes, an address that bounces).
//
// Auth:
//   * JWT verification REQUIRED (verify_jwt: true).
//   * Caller must be an active tpch_team row (admin).
//   * A plain admin cannot set a super_admin's password — otherwise the
//     lower role could take over the higher one's account. Super admins
//     can set anyone's.
//   * You cannot use this on yourself: use "Change Password", which
//     requires knowing the current session, not this admin override.
//   * CORS locked to portal.tpch.com.au + tpch.com.au.
//
// The password is used once to call the Auth admin API and is never
// stored, echoed back, or written to logs.
//
// Body: { member_id, password }
//
// Secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = new Set([
  'https://portal.tpch.com.au',
  'https://tpch.com.au',
])

const MIN_PASSWORD_LENGTH = 8

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
    const callerUid = userRes.user.id

    const { data: caller } = await supabase
      .from('tpch_team')
      .select('id, role')
      .eq('user_id', callerUid)
      .eq('status', 'active')
      .maybeSingle()
    if (!caller) return json({ error: 'Admin only' }, 403)

    const body      = await req.json()
    const memberId  = String(body.member_id || '').trim()
    const password  = String(body.password || '')

    if (!memberId) return json({ error: 'member_id is required' }, 400)
    if (password.length < MIN_PASSWORD_LENGTH) {
      return json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400)
    }

    // ── Target must be a real team member ───────────────────────────────
    const { data: member, error: memberErr } = await supabase
      .from('tpch_team')
      .select('id, full_name, email, role, status, user_id')
      .eq('id', memberId)
      .maybeSingle()
    if (memberErr) return json({ error: memberErr.message }, 500)
    if (!member)   return json({ error: 'Team member not found' }, 404)

    if (member.id === caller.id) {
      return json({ error: 'Use Change Password to change your own password.' }, 400)
    }
    if (member.role === 'super_admin' && caller.role !== 'super_admin') {
      return json({ error: 'Only a super admin can set a super admin\'s password.' }, 403)
    }

    // ── Resolve the auth account ────────────────────────────────────────
    // tpch_team.user_id is backfilled on first sign-in, so someone who has
    // never logged in may not have it yet. Fall back to matching on email
    // and repair the row while we're here.
    let authUserId = member.user_id
    if (!authUserId) {
      const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const match = (list?.users || []).find(
        (u: any) => (u.email || '').toLowerCase() === String(member.email || '').toLowerCase()
      )
      authUserId = match?.id || null
    }
    if (!authUserId) {
      return json({ error: 'No portal login exists for this member yet. Send them an invite first.' }, 404)
    }

    // ── Set it ──────────────────────────────────────────────────────────
    const { error: updErr } = await supabase.auth.admin.updateUserById(authUserId, {
      password,
      email_confirm: true,   // an admin-set password also confirms the address
    })
    if (updErr) return json({ error: updErr.message }, 500)

    if (!member.user_id) {
      await supabase.from('tpch_team').update({ user_id: authUserId }).eq('id', member.id)
    }

    // Log WHO did it and to WHOM, never the password itself.
    console.log(`admin ${caller.id} set password for team member ${member.id} (${member.email})`)

    return json({ success: true, full_name: member.full_name, email: member.email })

  } catch (err: any) {
    console.error('set-team-password error:', err)
    return json({ error: err.message }, 500)
  }
})
