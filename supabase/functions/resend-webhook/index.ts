// ============================================================
// TPCH — resend-webhook Edge Function
// Deploy: supabase functions deploy resend-webhook --no-verify-jwt
//
// Receives Resend delivery events (Svix-signed) and stamps the matching
// team member's row with real delivery status — so the team list can show
// Delivered / Bounced / Marked-spam instead of just "Invite sent".
//
// PUBLIC endpoint (Resend has no Supabase JWT) — secured by verifying the
// Svix signature against RESEND_WEBHOOK_SECRET. Without a valid signature the
// request is rejected, so it can't be spoofed.
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   RESEND_WEBHOOK_SECRET                     (set this — the whsec_... from Resend)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Only stamp delivery status for the invite emails (these subjects), so
// unrelated Resend mail (reservation alerts etc.) is ignored.
const INVITE_SUBJECTS = new Set([
  "You've been invited to the TPCH Partner Portal",
  'Your TPCH Partner Portal access link',
])

// Resend event type → the status we store.
const STATUS_MAP: Record<string, string> = {
  'email.delivered':  'delivered',
  'email.bounced':    'bounced',
  'email.complained': 'complained',
}

// Verify a Svix/Resend webhook signature.
async function verifySvix(
  secret: string, id: string, timestamp: string, body: string, sigHeader: string,
): Promise<boolean> {
  if (!secret || !id || !timestamp || !sigHeader) return false
  const key = secret.startsWith('whsec_') ? secret.slice(6) : secret
  let keyBytes: Uint8Array
  try {
    keyBytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0))
  } catch {
    return false
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signed = `${id}.${timestamp}.${body}`
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signed))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
  // svix-signature is a space-separated list of "v1,<base64sig>" entries.
  return sigHeader.split(' ').some((part) => part.split(',')[1] === expected)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET') || ''
  const body = await req.text()
  const ok = await verifySvix(
    secret,
    req.headers.get('svix-id') || '',
    req.headers.get('svix-timestamp') || '',
    body,
    req.headers.get('svix-signature') || '',
  )
  if (!ok) return new Response('Invalid signature', { status: 401 })

  let evt: any
  try { evt = JSON.parse(body) } catch { return new Response('Bad JSON', { status: 400 }) }

  const status = STATUS_MAP[evt?.type || '']
  if (!status) return new Response('ignored (untracked event)', { status: 200 })

  const subject = evt?.data?.subject || ''
  if (!INVITE_SUBJECTS.has(subject)) return new Response('ignored (non-invite)', { status: 200 })

  const recipients: string[] = Array.isArray(evt?.data?.to) ? evt.data.to : []
  const when = evt?.created_at || new Date().toISOString()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  for (const email of recipients) {
    if (!email) continue
    // No matching team member = harmless no-op (e.g. a partner-level invite).
    await supabase
      .from('partner_staff')
      .update({ invite_delivery_status: status, invite_delivery_at: when })
      .eq('email', String(email).toLowerCase())
  }

  return new Response('ok', { status: 200 })
})
