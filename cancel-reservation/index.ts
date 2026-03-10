// ============================================================
// TPCH — cancel-reservation Edge Function
// Called by portal when a partner cancels a reservation.
//
// POST body: { reservation_id: string, partner_id: string }
//
// 1. Validates reservation belongs to partner
// 2. Marks reservation cancelled in Supabase
// 3. Reverts stock.availability → Available in Supabase
// 4. Reverts Monday.com item → Available
//
// Secrets required:
//   MONDAY_API_TOKEN      — Monday.com API token
//   MONDAY_STOCK_BOARD_ID — 6070412774
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MONDAY_API     = 'https://api.monday.com/v2'
const MONDAY_TOKEN   = Deno.env.get('MONDAY_API_TOKEN')          ?? ''
const STOCK_BOARD_ID = Deno.env.get('MONDAY_STOCK_BOARD_ID')    || '6070412774'
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')             ?? ''
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const AVAIL_COL = 'color'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    })
  }

  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

  try {
    const body = await req.json()
    const { reservation_id, partner_id } = body

    if (!reservation_id || !partner_id) {
      return new Response(JSON.stringify({ error: 'Missing reservation_id or partner_id' }), { status: 400, headers: corsHeaders })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 1. Fetch reservation and validate ownership
    const { data: rsv, error: fetchErr } = await supabase
      .from('reservations')
      .select('id, stock_id, status, partner_id')
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

    // 2. Mark reservation cancelled
    await supabase
      .from('reservations')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'partner' })
      .eq('id', reservation_id)

    // 3. Revert stock availability in Supabase
    await supabase
      .from('stock')
      .update({ availability: 'Available' })
      .eq('id', rsv.stock_id)

    // 4. Revert Monday.com (non-blocking)
    setMondayAvailability(rsv.stock_id, 'Available').catch(e =>
      console.error('Monday.com revert failed:', e)
    )

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders })
  } catch (err) {
    console.error('cancel-reservation error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: corsHeaders })
  }
})
