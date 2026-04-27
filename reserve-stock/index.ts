// ============================================================
// TPCH — reserve-stock Edge Function (HARDENED)
//
// Called by portal when a partner reserves a stock item.
//
// SECURITY HARDENING (Apr 2026):
//   * JWT verification is REQUIRED (set Verify JWT: ON in dashboard).
//   * partner_id, partner_name, partner_email are now DERIVED from the
//     authenticated caller's auth.uid() — the body cannot spoof another
//     partner.
//   * Catches 23505 (duplicate active reservation) raised by the new
//     unique partial index `reservations_one_active_per_stock`. If the
//     existing reservation belongs to the same caller, returns it
//     idempotently (200). If it belongs to someone else, returns 409.
//   * CORS locked to portal.tpch.com.au + tpch.com.au.
//
// POST body (only stock + client fields are trusted from the client):
//   {
//     stock_id, stock_name, project_id?, project_name?,
//     client_name, client_email, client_phone?, notes?
//   }
//
// On success returns: { reservation_id, expires_at, idempotent? }
//
// Secrets required:
//   RESEND_API_KEY, MONDAY_API_TOKEN, MONDAY_STOCK_BOARD_ID
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY     = Deno.env.get('RESEND_API_KEY')           ?? ''
const MONDAY_API     = 'https://api.monday.com/v2'
const MONDAY_TOKEN   = Deno.env.get('MONDAY_API_TOKEN')         ?? ''
const STOCK_BOARD_ID = Deno.env.get('MONDAY_STOCK_BOARD_ID')   || '6070412774'
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')            ?? ''
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const AVAIL_COL      = 'color'

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

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney',
  }) + ' AEST'
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
  if (json.errors) console.error('Monday.com mutation error:', JSON.stringify(json.errors))
}

async function sendConfirmationEmail(body: any, reservationId: string, expiresAt: string) {
  const firstName = body.partner_name?.split(' ')[0] || body.partner_name || 'there'
  const expiryDisplay = fmtDate(expiresAt)

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F5F3EE;">
    <div style="background:#112240;padding:28px 36px;text-align:center;">
      <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMDAgNjQiIGZpbGw9Im5vbmUiPgogIDwhLS0gRW1ibGVtIC0tPgogIDxyZWN0IHg9IjE4IiB5PSIxMCIgd2lkdGg9IjM0IiBoZWlnaHQ9IjM0IiByeD0iMyIgdHJhbnNmb3JtPSJyb3RhdGUoNDUgMzUgMjcpIiBmaWxsPSIjQzhBOTUxIi8+CiAgPHBvbHlnb24gcG9pbnRzPSIyMSwxMCA4LDIyIDM0LDIyIiBmaWxsPSIjRjVGM0VFIi8+CiAgPHJlY3QgeD0iMTAiIHk9IjIxIiB3aWR0aD0iMjQiIGhlaWdodD0iMTgiIGZpbGw9IiNGNUYzRUUiLz4KICA8cmVjdCB4PSIxNiIgeT0iMzAiIHdpZHRoPSIxMCIgaGVpZ2h0PSI5IiBmaWxsPSIjQzhBOTUxIi8+CiAgPCEtLSBXb3JkbWFyayAtLT4KICA8dGV4dCB4PSI3NiIgeT0iMzYiIGZvbnQtZmFtaWx5PSJHZW9yZ2lhLCBzZXJpZiIgZm9udC1zaXplPSIyMiIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iI0Y1RjNFRSIgbGV0dGVyLXNwYWNpbmc9IjIiPlRQQ0g8L3RleHQ+CiAgPHRleHQgeD0iNzYiIHk9IjUwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iIzk4QTVCMyIgbGV0dGVyLXNwYWNpbmc9IjIiPlRIRSBQUk9QRVJUWSBDTEVBUklORyBIT1VTRTwvdGV4dD4KPC9zdmc+Cg==" width="220" height="47" alt="TPCH" style="display:block;margin:0 auto;">
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;margin-top:10px;">Stock Reservation Confirmation</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C8A951,#E8D48B,#C8A951);"></div>
    <div style="background:#FFFFFF;padding:40px 44px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">Reservation confirmed, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C8A951;letter-spacing:1px;text-transform:uppercase;">48-hour hold — ${body.stock_name}</p>
      <p style="margin:0 0 24px;font-size:15px;color:#2A3A50;line-height:1.7;">
        Your reservation has been confirmed. The property has been placed on hold for <strong style="color:#080F1A;">48 hours</strong> exclusively for your client.
      </p>
      <div style="background:#F5F3EE;border-left:3px solid #C8A951;padding:20px 24px;margin:0 0 24px;">
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#C8A951;margin-bottom:12px;">Reservation Details</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#2A3A50;">
          <tr><td style="padding:6px 0;color:#98A5B3;width:40%;">Property</td><td style="padding:6px 0;font-weight:600;color:#080F1A;">${body.stock_name}</td></tr>
          ${body.project_name ? `<tr><td style="padding:6px 0;color:#98A5B3;">Project</td><td style="padding:6px 0;color:#080F1A;">${body.project_name}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#98A5B3;">Client Name</td><td style="padding:6px 0;color:#080F1A;">${body.client_name}</td></tr>
          <tr><td style="padding:6px 0;color:#98A5B3;">Client Email</td><td style="padding:6px 0;color:#080F1A;">${body.client_email}</td></tr>
          ${body.client_phone ? `<tr><td style="padding:6px 0;color:#98A5B3;">Client Phone</td><td style="padding:6px 0;color:#080F1A;">${body.client_phone}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#98A5B3;">Reservation ID</td><td style="padding:6px 0;font-family:monospace;font-size:12px;color:#5A6878;">${reservationId}</td></tr>
        </table>
      </div>
      <div style="background:#FFF8E7;border:1px solid rgba(200,169,81,0.4);padding:16px 20px;margin:0 0 24px;">
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#C8A951;margin-bottom:8px;">Reservation Expires</div>
        <div style="font-size:14px;font-weight:600;color:#080F1A;margin-bottom:6px;">${expiryDisplay}</div>
        <div style="font-size:12px;color:#5A6878;line-height:1.6;">
          If the reservation is not converted to an EOI before this time, the property will automatically revert to Available status.
        </div>
      </div>
      <p style="margin:0 0 16px;font-size:15px;color:#2A3A50;line-height:1.7;">
        To manage this reservation or proceed to EOI, log in to the Partner Portal and visit <strong style="color:#080F1A;">My Deals</strong>.
      </p>
      <p style="margin:0 0 0;font-size:15px;color:#2A3A50;line-height:1.7;">
        You can cancel the reservation from My Deals at any time before expiry.
      </p>
    </div>
    <div style="background:#112240;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A6878;">
        The Property Clearing House &nbsp;·&nbsp; <a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a>
      </p>
      <p style="margin:0;font-size:10px;color:#98A5B3;">You're receiving this because you submitted a reservation via the TPCH Partner Portal.</p>
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

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  const corsHeaders = { ...cors, 'Content-Type': 'application/json' }

  try {
    // ── 1. Auth: derive caller from JWT ──────────────────────────────────
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) {
      return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: corsHeaders })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: corsHeaders })
    }
    const callerUid   = userRes.user.id
    const callerEmail = (userRes.user.email || '').toLowerCase()

    // Resolve caller → partner_id (owner first, then active staff). Trust DB,
    // not the body.
    let partner_id: string | null = null
    let partner_name  = ''
    let partner_email = callerEmail

    const { data: ownerRow } = await supabase
      .from('channel_partners')
      .select('id, full_name, email')
      .eq('user_id', callerUid)
      .eq('status', 'active')
      .maybeSingle()

    if (ownerRow) {
      partner_id    = ownerRow.id
      partner_name  = ownerRow.full_name || ''
      partner_email = ownerRow.email || callerEmail
    } else {
      const { data: staffRow } = await supabase
        .from('partner_staff')
        .select('partner_id, full_name, email')
        .eq('user_id', callerUid)
        .eq('status', 'active')
        .maybeSingle()
      if (staffRow) {
        partner_id    = staffRow.partner_id
        partner_name  = staffRow.full_name || ''
        partner_email = staffRow.email || callerEmail
      }
    }

    if (!partner_id) {
      return new Response(JSON.stringify({ error: 'No active partner record for caller' }), { status: 403, headers: corsHeaders })
    }

    // ── 2. Body validation (only stock + client fields trusted from client)
    const body = await req.json()
    const required = ['stock_id', 'stock_name', 'client_name', 'client_email']
    for (const f of required) {
      if (!body[f]) {
        return new Response(JSON.stringify({ error: `Missing field: ${f}` }), { status: 400, headers: corsHeaders })
      }
    }

    // ── 3. Stock available?
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

    // ── 4. Insert reservation. Catch 23505 (duplicate active reservation):
    //       if the existing one belongs to THIS caller, return idempotently.
    //       Otherwise return the original 409.
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const { data: reservation, error: resErr } = await supabase
      .from('reservations')
      .insert({
        stock_id:      body.stock_id,
        stock_name:    body.stock_name,
        project_id:    body.project_id   || null,
        project_name:  body.project_name || null,
        partner_id,
        partner_name,
        partner_email,
        client_name:   body.client_name,
        client_email:  body.client_email,
        client_phone:  body.client_phone || null,
        notes:         body.notes        || null,
        expires_at:    expiresAt,
        status:        'active',
      })
      .select('id, expires_at')
      .single()

    if (resErr) {
      if ((resErr as any).code === '23505') {
        const { data: existing } = await supabase
          .from('reservations')
          .select('id, expires_at, partner_id')
          .eq('stock_id', body.stock_id)
          .eq('status', 'active')
          .maybeSingle()
        if (existing && existing.partner_id === partner_id) {
          return new Response(
            JSON.stringify({ reservation_id: existing.id, expires_at: existing.expires_at, idempotent: true }),
            { status: 200, headers: corsHeaders }
          )
        }
        return new Response(
          JSON.stringify({ error: 'This property is no longer available (status: Reserved)' }),
          { status: 409, headers: corsHeaders }
        )
      }
      console.error('Insert reservation error:', resErr)
      return new Response(JSON.stringify({ error: 'Failed to create reservation' }), { status: 500, headers: corsHeaders })
    }

    // ── 5. Update Supabase stock + Monday + email (last two non-blocking)
    await supabase.from('stock').update({ availability: 'Reserved' }).eq('id', body.stock_id)

    setMondayAvailability(body.stock_id, 'Reserved').catch(e =>
      console.error('Monday.com update failed:', e)
    )
    sendConfirmationEmail(
      { ...body, partner_name, partner_email },
      reservation.id,
      reservation.expires_at
    ).catch(e => console.error('Confirmation email failed:', e))

    return new Response(
      JSON.stringify({ reservation_id: reservation.id, expires_at: reservation.expires_at }),
      { status: 200, headers: corsHeaders }
    )
  } catch (err) {
    console.error('reserve-stock error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
