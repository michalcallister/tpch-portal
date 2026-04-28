// ============================================================
// TPCH — expire-reservations Edge Function
// Cron-triggered every 15 minutes.
// 1. Calls expire_reservations() SQL RPC — marks expired rows,
//    reverts stock.availability to 'Available' in Supabase,
//    returns list of expired reservations.
// 2. For each expired reservation, reverts Monday.com item
//    availability column back to 'Available'.
// 3. Sends expiry notification email to the partner.
//
// Secrets required:
//   RESEND_API_KEY       — Resend API key
//   MONDAY_API_TOKEN     — Monday.com API token
//   MONDAY_STOCK_BOARD_ID — 6070412774
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.
//
// Cron: set up in Supabase Dashboard → Edge Functions → expire-reservations
// Expression: */15 * * * *
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY        = Deno.env.get('RESEND_API_KEY')          ?? ''
const MONDAY_API        = 'https://api.monday.com/v2'
const MONDAY_TOKEN      = Deno.env.get('MONDAY_API_TOKEN')        ?? ''
const STOCK_BOARD_ID    = Deno.env.get('MONDAY_STOCK_BOARD_ID')  || '6070412774'
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')           ?? ''
const SUPABASE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const AVAIL_COL         = 'color'
const PARTNER_LINK_COL  = 'link_to_accounts_mkmv2zxe'  // board_relation on Property board → Channel Partners board (8393705888)

// ── Helpers ──────────────────────────────────────────────────

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
  if (json.errors) console.error(`Monday.com revert failed for ${itemId}:`, JSON.stringify(json.errors))
}

// Remove a partner item id from the property item's Channel Partner board-relation column.
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
    console.error(`Monday partner-link read failed for ${stockItemId}:`, JSON.stringify(readJson.errors))
    return
  }
  const existing: string[] = (readJson.data?.items?.[0]?.column_values?.[0]?.linked_item_ids ?? []).map(String)
  if (!existing.includes(String(partnerItemId))) return

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
  if (writeJson.errors) console.error(`Monday partner-unlink failed for ${stockItemId}:`, JSON.stringify(writeJson.errors))
}

async function sendExpiryEmail(r: any) {
  const firstName = r.partner_name?.split(' ')[0] || r.partner_name || 'there'

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">

    <!-- Header -->
    <div style="background:#1A1A16;padding:36px 48px 28px;text-align:center;">
      <div style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#C9A84C;font-weight:600;margin-bottom:6px;">THE PROPERTY CLEARING HOUSE</div>
      <div style="height:1px;background:linear-gradient(to right,transparent,#C9A84C,transparent);margin:12px 0;"></div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8A8A7A;">Reservation Expired</div>
    </div>

    <!-- Body -->
    <div style="background:#FFFFFF;padding:40px 48px;">
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">Hi ${firstName},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        Your 48-hour reservation for <strong>${r.stock_name}</strong>${r.project_name ? ` (${r.project_name})` : ''} has now expired and the property has been returned to <strong>Available</strong> status.
      </p>

      <!-- Details -->
      <div style="background:#F4F4F0;border-left:3px solid #C9A84C;padding:20px 24px;margin:0 0 24px;border-radius:2px;">
        <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8A8A7A;margin-bottom:12px;">Reservation Details</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#3A3A35;">
          <tr><td style="padding:5px 0;color:#6A6A5A;width:40%;">Property</td><td style="padding:5px 0;font-weight:600;">${r.stock_name}</td></tr>
          ${r.project_name ? `<tr><td style="padding:5px 0;color:#6A6A5A;">Project</td><td style="padding:5px 0;">${r.project_name}</td></tr>` : ''}
          <tr><td style="padding:5px 0;color:#6A6A5A;">Client Name</td><td style="padding:5px 0;">${r.client_name}</td></tr>
          <tr><td style="padding:5px 0;color:#6A6A5A;">Status</td><td style="padding:5px 0;color:#C0392B;font-weight:600;">Expired</td></tr>
        </table>
      </div>

      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        If your client is still interested in this property, please log in to the Partner Portal to check availability and make a new reservation.
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        If you have any questions, please contact your TPCH account manager.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#1A1A16;padding:24px 48px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#6A6A5A;letter-spacing:0.5px;">
        The Property Clearing House &nbsp;·&nbsp; <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a>
      </p>
    </div>
  </div>
</body>
</html>`

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'TPCH Partner Portal <noreply@tpch.com.au>',
      to:      [r.partner_email],
      subject: `Reservation Expired — ${r.stock_name}`,
      html,
    }),
  })
  if (!emailRes.ok) {
    console.error(`Expiry email failed for ${r.partner_email}:`, await emailRes.text())
  }
}

// ── Main handler ─────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 1. Run expire_reservations() — atomically expires records + reverts Supabase stock
    const { data, error } = await supabase.rpc('expire_reservations')
    if (error) {
      console.error('expire_reservations RPC error:', error)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    const expired: any[] = Array.isArray(data) ? data : []
    console.log(`Expired ${expired.length} reservation(s)`)

    if (expired.length === 0) {
      return new Response(JSON.stringify({ expired: 0 }), { status: 200 })
    }

    // 2. For each expired reservation: revert Monday.com + remove partner link + send email
    await Promise.allSettled(
      expired.map(async (r: any) => {
        // Revert Monday.com availability → Available
        if (r.stock_id) {
          await setMondayAvailability(r.stock_id, 'Available')
        }
        // Remove the partner from the property item's Channel Partner column
        if (r.stock_id && r.partner_id) {
          const { data: cp } = await supabase
            .from('channel_partners')
            .select('monday_item_id')
            .eq('id', r.partner_id)
            .maybeSingle()
          if (cp?.monday_item_id) {
            await removeMondayPartnerLink(r.stock_id, cp.monday_item_id)
          }
        }
        // Send expiry email to partner
        if (r.partner_email) {
          await sendExpiryEmail(r)
        }
      })
    )

    return new Response(JSON.stringify({ expired: expired.length }), { status: 200 })
  } catch (err) {
    console.error('expire-reservations error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 })
  }
})
