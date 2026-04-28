// ============================================================
// TPCH — cancel-reservation Edge Function (HARDENED)
//
// Called by portal when a partner cancels a reservation.
//
// SECURITY HARDENING (Apr 2026):
//   * JWT verification REQUIRED (set Verify JWT: ON in dashboard).
//   * partner_id derived from auth.uid() — body cannot spoof another partner.
//   * Reservation ownership verified server-side; mismatch returns 403.
//   * CORS locked to portal.tpch.com.au + tpch.com.au.
//
// POST body: { reservation_id: string }
//   (partner_id is no longer accepted from the body — derived from JWT.)
//
// 1. Authenticate caller → derive partner_id
// 2. Validate reservation belongs to caller's partner_id
// 3. Mark reservation cancelled in Supabase
// 4. Revert stock.availability → Available in Supabase
// 5. Revert Monday.com item → Available
//
// Secrets required:
//   MONDAY_API_TOKEN, MONDAY_STOCK_BOARD_ID
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MONDAY_API        = 'https://api.monday.com/v2'
const MONDAY_TOKEN      = Deno.env.get('MONDAY_API_TOKEN')          ?? ''
const STOCK_BOARD_ID    = Deno.env.get('MONDAY_STOCK_BOARD_ID')    || '6070412774'
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')             ?? ''
const SUPABASE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const AVAIL_COL         = 'color'
const PARTNER_LINK_COL  = 'link_to_accounts_mkmv2zxe'  // board_relation on Property board → Channel Partners board (8393705888)

const ALLOWED_ORIGINS = new Set([
  'https://portal.tpch.com.au',
  'https://tpch.com.au',
])

function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://portal.tpch.com.au'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'Vary': 'Origin',
  }
}

async function setMondayAvailability(itemId: string, label: string) {
  const query = `mutation {
    change_column_value(
      board_id: ${STOCK_BOARD_ID},
      item_id: ${itemId},
      column_id: "${AVAIL_COL}",
      value: "{\\"label\\":\\"${label}\\"}"
    ) { id }
  }`
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': MONDAY_TOKEN,
      'API-Version':   '2023-10',
    },
    body: JSON.stringify({ query }),
  })
  const json = await res.json()
  if (json.errors) console.error('Monday.com revert error:', JSON.stringify(json.errors))
}

// Remove a partner item id from the property item's Channel Partner board-relation
// column. Reads existing linked ids first, removes only the target, writes the
// rest back. No-op if the partner isn't currently linked.
async function removeMondayPartnerLink(stockItemId: string, partnerItemId: string) {
  const readQuery = `query {
    items(ids: [${stockItemId}]) {
      column_values(ids: ["${PARTNER_LINK_COL}"]) {
        ... on BoardRelationValue { linked_item_ids }
      }
    }
  }`
  const readRes = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2023-10' },
    body: JSON.stringify({ query: readQuery }),
  })
  const readJson = await readRes.json()
  if (readJson.errors) {
    console.error('Monday partner-link read error:', JSON.stringify(readJson.errors))
    return
  }
  const existing: string[] = (readJson.data?.items?.[0]?.column_values?.[0]?.linked_item_ids ?? []).map(String)
  if (!existing.includes(String(partnerItemId))) return  // nothing to remove

  const remaining = existing.filter(id => id !== String(partnerItemId)).map(Number)
  const writeQuery = `mutation {
    change_column_value(
      board_id: ${STOCK_BOARD_ID},
      item_id: ${stockItemId},
      column_id: "${PARTNER_LINK_COL}",
      value: ${JSON.stringify(JSON.stringify({ item_ids: remaining }))}
    ) { id }
  }`
  const writeRes = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2023-10' },
    body: JSON.stringify({ query: writeQuery }),
  })
  const writeJson = await writeRes.json()
  if (writeJson.errors) console.error('Monday partner-unlink mutation error:', JSON.stringify(writeJson.errors))
}

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  const corsHeaders = { ...cors, 'Content-Type': 'application/json' }

  try {
    // ── 1. Auth: derive caller from JWT ──────────────────────────────────
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) {
      return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: corsHeaders })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: corsHeaders })
    }
    const callerUid = userRes.user.id

    let partner_id: string | null = null
    const { data: owner } = await supabase
      .from('channel_partners')
      .select('id')
      .eq('user_id', callerUid)
      .eq('status', 'active')
      .maybeSingle()
    if (owner) {
      partner_id = owner.id
    } else {
      const { data: staff } = await supabase
        .from('partner_staff')
        .select('partner_id')
        .eq('user_id', callerUid)
        .eq('status', 'active')
        .maybeSingle()
      partner_id = staff?.partner_id ?? null
    }
    if (!partner_id) {
      return new Response(JSON.stringify({ error: 'No active partner record for caller' }), { status: 403, headers: corsHeaders })
    }

    // ── 2. Validate body
    const body = await req.json()
    const reservation_id = body?.reservation_id
    if (!reservation_id) {
      return new Response(JSON.stringify({ error: 'Missing reservation_id' }), { status: 400, headers: corsHeaders })
    }

    // ── 3. Fetch reservation and validate ownership
    const { data: rsv, error: fetchErr } = await supabase
      .from('reservations')
      .select('id, stock_id, status, partner_id, channel_partners(monday_item_id)')
      .eq('id', reservation_id)
      .single()

    if (fetchErr || !rsv) {
      return new Response(JSON.stringify({ error: 'Reservation not found' }), { status: 404, headers: corsHeaders })
    }
    if (rsv.partner_id !== partner_id) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 403, headers: corsHeaders })
    }
    if (rsv.status !== 'active') {
      return new Response(JSON.stringify({ error: 'Reservation is not active' }), { status: 409, headers: corsHeaders })
    }

    // ── 4. Mark cancelled + revert stock
    await supabase
      .from('reservations')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'partner' })
      .eq('id', reservation_id)

    await supabase
      .from('stock')
      .update({ availability: 'Available' })
      .eq('id', rsv.stock_id)

    // ── 5. Revert Monday.com (non-blocking)
    setMondayAvailability(rsv.stock_id, 'Available').catch(e =>
      console.error('Monday.com revert failed:', e)
    )
    const partnerMid = (rsv as any).channel_partners?.monday_item_id
    if (partnerMid) {
      removeMondayPartnerLink(rsv.stock_id, partnerMid).catch(e =>
        console.error('Monday partner-unlink failed:', e)
      )
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders })
  } catch (err) {
    console.error('cancel-reservation error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: corsHeaders })
  }
})
