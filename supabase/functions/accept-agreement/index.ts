// ============================================================
// TPCH — accept-agreement Edge Function
// Deploy: supabase functions deploy accept-agreement --no-verify-jwt
//
// Records a partner's acceptance of the TPCH Marketing Agreement
// to the append-only `agreement_acceptances` audit table, then
// updates the denormalised summary fields on the parent row
// (`pending_enquiries` for new applicants, `channel_partners`
// for the blocker-modal flow on existing partners).
//
// Server-side captures (NOT trusted from the client):
//   - accepted_at  (NOW())
//   - ip_address   (x-forwarded-for / cf-connecting-ip)
//   - user_agent   (User-Agent header)
//   - agreement_sha256 (canonical hash for the version)
//
// Client-supplied:
//   - context: 'enquiry' | 'blocker' | 'admin_invite'
//   - email
//   - enquiry_id  (when context='enquiry')
//   - partner_id  (when context='blocker' or 'admin_invite')
//   - agreement_version
//   - checkbox_text  (the exact wording shown next to the checkbox)
//
// Returns: { acceptance_id, accepted_at, agreement_sha256, agreement_version }
//
// Secrets required (auto-injected by Supabase):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   RESEND_API_KEY  — if set, sends a Certificate of Acceptance email
//   ADMIN_EMAIL     — fallback contact in the email
//   PORTAL_URL      — link target for the email CTA
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Canonical hash of the published v1.0 .docx artifact
// (TPCH_Marketing_Agreement_v1.docx at the repo root / portal.tpch.com.au).
// Bumping the agreement requires a new version key here.
const KNOWN_VERSIONS: Record<string, string> = {
  '1.0': 'eb6e9a4f145a6c011f1686a09063a6b82a1995ea7684008e4b1963d8d0fa307a',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const body = await req.json()
    const {
      context,
      enquiry_id,
      partner_id,
      email,
      agreement_version,
      checkbox_text,
      parties_snapshot,
      registered_address,
    } = body || {}

    // ── Validate input ──────────────────────────────────────
    if (!email || !agreement_version || !checkbox_text || !context) {
      return json({ error: 'context, email, agreement_version and checkbox_text are required' }, 400)
    }
    if (!['enquiry', 'blocker', 'admin_invite'].includes(context)) {
      return json({ error: 'context must be "enquiry", "blocker" or "admin_invite"' }, 400)
    }
    const sha = KNOWN_VERSIONS[agreement_version]
    if (!sha) {
      return json({ error: `Unknown agreement_version: ${agreement_version}` }, 400)
    }
    if (context === 'enquiry' && !enquiry_id) {
      return json({ error: 'enquiry_id required when context="enquiry"' }, 400)
    }
    if ((context === 'blocker' || context === 'admin_invite') && !partner_id) {
      return json({ error: 'partner_id required for this context' }, 400)
    }

    const normEmail = String(email).trim().toLowerCase()

    // ── Anti-spoof: confirm enquiry/partner row matches email ──
    if (context === 'enquiry') {
      const { data: enq, error } = await supabase
        .from('pending_enquiries')
        .select('id, email')
        .eq('id', enquiry_id)
        .maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!enq) return json({ error: 'Enquiry not found' }, 404)
      if (String(enq.email).toLowerCase() !== normEmail) {
        return json({ error: 'Email does not match enquiry record' }, 403)
      }
    } else {
      const { data: p, error } = await supabase
        .from('channel_partners')
        .select('id, email')
        .eq('id', partner_id)
        .maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!p) return json({ error: 'Partner not found' }, 404)
      if (String(p.email).toLowerCase() !== normEmail) {
        return json({ error: 'Email does not match partner record' }, 403)
      }
    }

    // ── Capture request metadata server-side ────────────────
    const fwd = req.headers.get('x-forwarded-for') || ''
    const cf  = req.headers.get('cf-connecting-ip') || ''
    const ip  = (fwd.split(',')[0] || cf || '').trim() || null
    const ua  = req.headers.get('user-agent') || null

    const rawHeaders: Record<string, string> = {}
    for (const [k, v] of req.headers.entries()) {
      // Keep a minimal forensic snapshot; skip secrets.
      if (['authorization', 'apikey', 'cookie'].includes(k.toLowerCase())) continue
      rawHeaders[k] = v
    }

    // ── If the client supplied a new registered_address (blocker flow),
    //    persist it on the partner row before snapshotting. ────────
    if (registered_address && (context === 'blocker' || context === 'admin_invite') && partner_id) {
      const { error } = await supabase
        .from('channel_partners')
        .update({ registered_address: String(registered_address).trim() })
        .eq('id', partner_id)
      if (error) console.error('registered_address update failed:', error.message)
    }

    // ── Insert audit row (legal source of truth) ────────────
    const { data: ack, error: ackErr } = await supabase
      .from('agreement_acceptances')
      .insert({
        partner_id: partner_id || null,
        enquiry_id: enquiry_id || null,
        email: normEmail,
        agreement_version,
        agreement_sha256: sha,
        ip_address: ip,
        user_agent: ua,
        method: context,
        checkbox_text,
        raw_headers: rawHeaders,
        parties_snapshot: parties_snapshot || null,
      })
      .select('id, accepted_at')
      .single()

    if (ackErr) return json({ error: ackErr.message }, 500)

    // ── Update denormalised summary on parent row ───────────
    const summary = {
      agreement_version,
      agreement_accepted_at: ack.accepted_at,
      agreement_acceptance_id: ack.id,
    }

    if (context === 'enquiry') {
      const { error } = await supabase
        .from('pending_enquiries')
        .update(summary)
        .eq('id', enquiry_id)
      if (error) console.error('pending_enquiries update failed:', error.message)
    } else {
      const { error } = await supabase
        .from('channel_partners')
        .update(summary)
        .eq('id', partner_id)
      if (error) console.error('channel_partners update failed:', error.message)
    }

    // ── Fire-and-forget Certificate of Acceptance email ─────
    const resendKey = Deno.env.get('RESEND_API_KEY') || ''
    if (resendKey) {
      sendCertificate({
        to: normEmail,
        acceptanceId: ack.id,
        acceptedAt: ack.accepted_at,
        version: agreement_version,
        sha256: sha,
        ip,
        userAgent: ua,
        checkboxText: checkbox_text,
      }).catch((e) => console.error('Certificate email failed:', e?.message || e))
    }

    return json({
      acceptance_id: ack.id,
      accepted_at: ack.accepted_at,
      agreement_sha256: sha,
      agreement_version,
    })
  } catch (err: any) {
    console.error('accept-agreement error:', err)
    return json({ error: err?.message || 'Internal error' }, 500)
  }
})

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function sendCertificate(p: {
  to: string
  acceptanceId: string
  acceptedAt: string
  version: string
  sha256: string
  ip: string | null
  userAgent: string | null
  checkboxText: string
}) {
  const resendKey = Deno.env.get('RESEND_API_KEY')!
  const portalUrl = Deno.env.get('PORTAL_URL') || 'https://portal.tpch.com.au'
  const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'admin@tpch.com.au'

  const acceptedDisplay = new Date(p.acceptedAt).toUTCString()

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:'Arial',sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#F5F3EE;">
    <div style="background:#080F1A;padding:28px 36px;text-align:center;">
      <div style="font-family:Georgia,serif;color:#F5F3EE;font-size:22px;letter-spacing:3px;">TPCH</div>
      <div style="font-size:9px;color:#C8A951;letter-spacing:2px;text-transform:uppercase;margin-top:6px;">Vision. Intelligence. Advantage.</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C8A951,#E8D48B,#C8A951);"></div>
    <div style="background:#ffffff;padding:44px 44px 32px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#C8A951;margin-bottom:10px;">Certificate of Acceptance</div>
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#080F1A;line-height:1.3;">TPCH Marketing Agreement</p>
      <p style="margin:0 0 24px;font-size:14px;color:#5A6878;">Version ${escapeHtml(p.version)}</p>

      <p style="margin:0 0 18px;font-size:14px;color:#2A3A50;line-height:1.7;">
        This certificate confirms that the TPCH Marketing Agreement was electronically accepted on the terms set out below. Please retain it for your records.
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0 8px;border-top:1px solid rgba(200,169,81,0.3);">
        ${row('Acceptance ID', p.acceptanceId)}
        ${row('Accepted (UTC)', acceptedDisplay)}
        ${row('Email', p.to)}
        ${row('IP address', p.ip || 'not recorded')}
        ${row('User agent', truncate(p.userAgent || 'not recorded', 90))}
        ${row('Document SHA-256', `<code style="font-size:11px;word-break:break-all;">${escapeHtml(p.sha256)}</code>`)}
        ${row('Acceptance text', `&ldquo;${escapeHtml(p.checkboxText)}&rdquo;`)}
      </table>

      <div style="background:#F5F3EE;border-left:3px solid #C8A951;padding:16px 20px;margin:24px 0 24px;font-size:13px;color:#2A3A50;line-height:1.6;">
        Under the Electronic Transactions Act 1999 (Cth) and corresponding State legislation, this electronic acceptance has the same legal effect as a written signature. The Acceptance ID above is the audit-trail key for this transaction.
      </div>

      <div style="text-align:center;margin:0 0 28px;">
        <a href="${portalUrl}" style="display:inline-block;background:#C8A951;color:#080F1A;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:14px 32px;">
          Open Partner Portal →
        </a>
      </div>

      <p style="margin:0;font-size:13px;color:#5A6878;line-height:1.7;">
        Questions? Reply to this email or contact <a href="mailto:${adminEmail}" style="color:#C8A951;text-decoration:none;">${adminEmail}</a>.
      </p>
    </div>
    <div style="background:#080F1A;padding:22px 36px;text-align:center;">
      <p style="margin:0 0 4px;font-size:11px;color:#98A5B3;">The Property Clearing House · Channel Partner Intelligence — Australia</p>
      <p style="margin:0;font-size:10px;color:#5A6878;"><a href="https://tpch.com.au" style="color:#C8A951;text-decoration:none;">tpch.com.au</a></p>
    </div>
  </div>
</body>
</html>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'TPCH Partner Network <noreply@tpch.com.au>',
      to: [p.to],
      bcc: [adminEmail],
      subject: `TPCH Marketing Agreement — Certificate of Acceptance (v${p.version})`,
      html,
    }),
  })
  if (!res.ok) console.error('Resend cert error:', await res.text())
}

function row(label: string, value: string) {
  return `<tr style="border-bottom:1px solid rgba(200,169,81,0.18);">
    <td style="padding:10px 12px 10px 0;vertical-align:top;font-family:'Courier New',monospace;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#C8A951;width:38%;">${label}</td>
    <td style="padding:10px 0;vertical-align:top;color:#080F1A;">${value}</td>
  </tr>`
}

function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}
