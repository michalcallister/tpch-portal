// ============================================================
// TPCH — reserve-stock Edge Function
// Called by portal when a partner reserves a stock item.
//
// POST body:
//   {
//     stock_id:      string   (Supabase stock.id / Monday item ID)
//     stock_name:    string
//     project_id:    string   (optional)
//     project_name:  string   (optional)
//     partner_id:    string   (uuid)
//     partner_name:  string
//     partner_email: string
//     client_name:   string
//     client_email:  string
//     client_phone:  string   (optional)
//     notes:         string   (optional)
//   }
//
// On success returns: { reservation_id, expires_at }
//
// Secrets required:
//   RESEND_API_KEY       — Resend API key
//   MONDAY_API_TOKEN     — Monday.com API token
//   MONDAY_STOCK_BOARD_ID — 6070412774
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY      = Deno.env.get('RESEND_API_KEY')          ?? ''
const MONDAY_API      = 'https://api.monday.com/v2'
const MONDAY_TOKEN    = Deno.env.get('MONDAY_API_TOKEN')        ?? ''
const STOCK_BOARD_ID  = Deno.env.get('MONDAY_STOCK_BOARD_ID')  || '6070412774'
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')           ?? ''
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Monday.com column ID for availability on the Stock board
const AVAIL_COL = 'color'

// ── Helpers ──────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  return '$' + Math.round(n).toLocaleString('en-AU')
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney',
  }) + ' AEST'
}

async function setMondayAvailability(itemId: string, label: string) {
  // Monday.com change_column_value — set status (color) column by label
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
  if (json.errors) console.error('Monday.com mutation error:', JSON.stringify(json.errors))
}

async function sendConfirmationEmail(body: any, reservationId: string, expiresAt: string) {
  const firstName = body.partner_name?.split(' ')[0] || body.partner_name || 'there'
  const expiryDisplay = fmtDate(expiresAt)

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">

    <!-- Header -->
    <div style="background:#1A1A16;padding:36px 48px 28px;text-align:center;">
      <div style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#C9A84C;font-weight:600;margin-bottom:6px;">THE PROPERTY CLEARING HOUSE</div>
      <div style="height:1px;background:linear-gradient(to right,transparent,#C9A84C,transparent);margin:12px 0;"></div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8A8A7A;">Stock Reservation Confirmation</div>
    </div>

    <!-- Body -->
    <div style="background:#FFFFFF;padding:40px 48px;">
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">Hi ${firstName},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        Your reservation has been confirmed. The property has been placed on hold for <strong>48 hours</strong> exclusively for your client.
      </p>

      <!-- Reservation Details -->
      <div style="background:#F4F4F0;border-left:3px solid #C9A84C;padding:20px 24px;margin:0 0 24px;border-radius:2px;">
        <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8A8A7A;margin-bottom:12px;">Reservation Details</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#3A3A35;">
          <tr><td style="padding:5px 0;color:#6A6A5A;width:40%;">Property</td><td style="padding:5px 0;font-weight:600;">${body.stock_name}</td></tr>
          ${body.project_name ? `<tr><td style="padding:5px 0;color:#6A6A5A;">Project</td><td style="padding:5px 0;">${body.project_name}</td></tr>` : ''}
          <tr><td style="padding:5px 0;color:#6A6A5A;">Client Name</td><td style="padding:5px 0;">${body.client_name}</td></tr>
          <tr><td style="padding:5px 0;color:#6A6A5A;">Client Email</td><td style="padding:5px 0;">${body.client_email}</td></tr>
          ${body.client_phone ? `<tr><td style="padding:5px 0;color:#6A6A5A;">Client Phone</td><td style="padding:5px 0;">${body.client_phone}</td></tr>` : ''}
          <tr><td style="padding:5px 0;color:#6A6A5A;">Reservation ID</td><td style="padding:5px 0;font-family:monospace;font-size:12px;">${reservationId}</td></tr>
        </table>
      </div>

      <!-- Expiry Warning -->
      <div style="background:#FFF8E7;border:1px solid #E8C84A;padding:16px 20px;margin:0 0 24px;border-radius:3px;">
        <div style="font-size:13px;font-weight:600;color:#8A6A00;margin-bottom:4px;">⏱ Reservation Expires</div>
        <div style="font-size:14px;color:#6A5000;">${expiryDisplay}</div>
        <div style="font-size:12px;color:#8A6A00;margin-top:8px;">
          If the reservation is not converted to an EOI before this time, the property will automatically revert to Available status.
        </div>
      </div>

      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        To manage this reservation or proceed to EOI, please log in to the Partner Portal and visit <strong>My Deals</strong>.
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        If you need to cancel the reservation for any reason, you can do so from My Deals at any time before expiry.
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

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'TPCH Partner Portal <noreply@tpch.com.au>',
      to:      [body.partner_email],
      subject: `Reservation Confirmed — ${body.stock_name}`,
      html,
    }),
  })
}

// ── Main handler ─────────────────────────────────────────────

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    })
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Content-Type': 'application/json',
  }

  try {
    const body = await req.json()

    const required = ['stock_id','stock_name','partner_id','partner_name','partner_email','client_name','client_email']
    for (const f of required) {
      if (!body[f]) {
        return new Response(JSON.stringify({ error: `Missing field: ${f}` }), { status: 400, headers: corsHeaders })
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 1. Check stock is still Available
    const { data: stockRow, error: stockErr } = await supabase
      .from('stock')
      .select('id, availability')
      .eq('id', body.stock_id)
      .single()

    if (stockErr || !stockRow) {
      return new Response(JSON.stringify({ error: 'Stock item not found' }), { status: 404, headers: corsHeaders })
    }

    if (stockRow.availability !== 'Available') {
      return new Response(JSON.stringify({ error: `This property is no longer available (status: ${stockRow.availability})` }), { status: 409, headers: corsHeaders })
    }

    // 2. Calculate expiry (48 hours from now)
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

    // 3. Insert reservation
    const { data: reservation, error: resErr } = await supabase
      .from('reservations')
      .insert({
        stock_id:      body.stock_id,
        stock_name:    body.stock_name,
        project_id:    body.project_id   || null,
        project_name:  body.project_name || null,
        partner_id:    body.partner_id,
        partner_name:  body.partner_name,
        partner_email: body.partner_email,
        client_name:   body.client_name,
        client_email:  body.client_email,
        client_phone:  body.client_phone || null,
        notes:         body.notes        || null,
        expires_at:    expiresAt,
        status:        'active',
      })
      .select('id, expires_at')
      .single()

    if (resErr || !reservation) {
      console.error('Insert reservation error:', resErr)
      return new Response(JSON.stringify({ error: 'Failed to create reservation' }), { status: 500, headers: corsHeaders })
    }

    // 4. Update stock availability in Supabase
    await supabase
      .from('stock')
      .update({ availability: 'Reserved' })
      .eq('id', body.stock_id)

    // 5. Update Monday.com (non-blocking — fire and forget)
    setMondayAvailability(body.stock_id, 'Reserved').catch(e =>
      console.error('Monday.com update failed:', e)
    )

    // 6. Send confirmation email to partner (non-blocking)
    sendConfirmationEmail(body, reservation.id, reservation.expires_at).catch(e =>
      console.error('Confirmation email failed:', e)
    )

    return new Response(
      JSON.stringify({ reservation_id: reservation.id, expires_at: reservation.expires_at }),
      { status: 200, headers: corsHeaders }
    )
  } catch (err) {
    console.error('reserve-stock error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: corsHeaders })
  }
})
