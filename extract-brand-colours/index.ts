// ============================================================
// TPCH — extract-brand-colours Edge Function
// Deploy: supabase functions deploy extract-brand-colours
//
// Fetches the partner's website and extracts a primary + accent
// brand colour, then caches them on `channel_partners.brand_primary`
// and `channel_partners.brand_accent`. Used by the public Property
// Marketing Flyer to white-label the page in the partner's brand.
//
// Auth: requires a valid Supabase auth JWT belonging to a partner.
// The function verifies the JWT, finds the matching channel_partners
// row via user_id, and only updates THAT row.
//
// Strategy (in priority order):
//   1. <meta name="theme-color" content="#XXX">      — official browser tab colour
//   2. CSS custom properties: --primary, --brand, --accent, etc.
//   3. Most-frequent non-grey hex code in the corpus
//
// Corpus = page HTML + up to 3 referenced stylesheets (skipping font CDNs).
// Pulling external CSS is essential for Vite/Next/Tailwind sites where the
// brand vars live in a compiled bundle, not inline.
//
// Secrets required (auto-injected):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    // ── Auth: verify the caller's JWT and resolve their partner row ──
    const authHeader = req.headers.get('authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'auth_required' }, 401)

    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ error: 'invalid_token' }, 401)
    const userId = userData.user.id

    const { data: partner, error: pErr } = await supabase
      .from('channel_partners')
      .select('id, website')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()
    if (pErr || !partner) return json({ error: 'partner_not_found' }, 404)

    // ── Resolve the target URL ─────────────────────────────────
    const body = await req.json().catch(() => ({}))
    const requestedUrl = (body?.website || partner.website || '').toString().trim()
    if (!requestedUrl) return json({ error: 'website_required' }, 400)

    const targetUrl = normaliseUrl(requestedUrl)
    if (!targetUrl) return json({ error: 'invalid_url' }, 400)

    // ── Fetch the website (10s timeout, follow redirects) ──────
    let html = ''
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 10_000)
      const r = await fetch(targetUrl, {
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 TPCH-BrandColour-Bot',
          'Accept': 'text/html,*/*',
        },
      })
      clearTimeout(t)
      if (!r.ok) return json({ error: 'fetch_failed', status: r.status }, 502)
      html = await r.text()
    } catch (e) {
      return json({ error: 'fetch_error', detail: String(e?.message || e) }, 502)
    }

    if (html.length > 2_000_000) html = html.slice(0, 2_000_000)

    // ── Pull referenced stylesheets so we can see compiled brand vars
    //    (Tailwind / Vite / Next bundles). Cap at 3 sheets / 1.5 MB.
    const sheetUrls = resolveStylesheets(html, targetUrl)
    let cssBytes = 0
    let combinedCss = ''
    for (const sheet of sheetUrls) {
      try {
        const ac2 = new AbortController()
        const t2 = setTimeout(() => ac2.abort(), 8_000)
        const cr = await fetch(sheet, {
          redirect: 'follow',
          signal: ac2.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 TPCH-BrandColour-Bot', 'Accept': 'text/css,*/*' },
        })
        clearTimeout(t2)
        if (!cr.ok) continue
        const body = await cr.text()
        if (cssBytes + body.length > 1_500_000) {
          combinedCss += '\n' + body.slice(0, 1_500_000 - cssBytes)
          break
        }
        combinedCss += '\n' + body
        cssBytes += body.length
      } catch { /* skip individual sheet failures */ }
    }

    const corpus = combinedCss ? html + '\n' + combinedCss : html

    // ── Extract colours ───────────────────────────────────────
    const extracted = extractColours(corpus)
    if (!extracted.primary) {
      return json({ error: 'no_colours_found', message: 'Could not detect a brand colour from this site.' }, 422)
    }

    // ── Persist on channel_partners ───────────────────────────
    const { error: updErr } = await supabase
      .from('channel_partners')
      .update({
        brand_primary: extracted.primary,
        brand_accent:  extracted.accent,
        brand_colours_extracted_at: new Date().toISOString(),
      })
      .eq('id', partner.id)
    if (updErr) return json({ error: 'persist_failed', detail: updErr.message }, 500)

    return json({
      ok: true,
      primary: extracted.primary,
      accent:  extracted.accent,
      source:  extracted.source,
    })
  } catch (e) {
    return json({ error: 'unexpected', detail: String((e as Error)?.message || e) }, 500)
  }
})

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Find <link rel="stylesheet"> hrefs in the page, resolve them against the
// page URL, and skip font CDNs (Google Fonts, Adobe Typekit) — they don't
// carry brand colours. Cap at 3 sheets to keep latency in check.
function resolveStylesheets(html: string, pageUrl: string): string[] {
  const re = /<link[^>]+rel\s*=\s*["']?stylesheet["']?[^>]*>/gi
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i)
    if (!hrefMatch) continue
    let href: string
    try {
      href = new URL(hrefMatch[1], pageUrl).toString()
    } catch { continue }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net/i.test(href)) continue
    if (out.includes(href)) continue
    out.push(href)
    if (out.length >= 3) break
  }
  return out
}

function normaliseUrl(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

interface ExtractResult {
  primary: string | null
  accent:  string | null
  source:  string
}

function extractColours(html: string): ExtractResult {
  // 1. theme-color meta — most authoritative
  const meta = html.match(/<meta[^>]+name\s*=\s*["']?theme-color["']?[^>]*>/i)
  if (meta) {
    const c = meta[0].match(/content\s*=\s*["']?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))["']?/i)
    if (c) {
      const hex = toHex(c[1])
      if (hex && !isGrey(hex)) {
        return { primary: hex, accent: deriveAccent(hex), source: 'theme-color-meta' }
      }
    }
  }

  // 2. CSS custom properties — a brand often defines --primary, --brand, --accent
  const cssVarRe = /--(?:primary|brand|brand-primary|brand-color|brand-colour|accent|theme|main-color|main-colour)[a-z0-9-]*\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/gi
  const varColours: string[] = []
  let m: RegExpExecArray | null
  while ((m = cssVarRe.exec(html)) !== null) {
    const hex = toHex(m[1])
    if (hex && !isGrey(hex)) varColours.push(hex)
  }
  if (varColours.length > 0) {
    const counted = mostFrequent(varColours)
    return {
      primary: counted[0] || null,
      accent:  counted[1] || (counted[0] ? deriveAccent(counted[0]) : null),
      source:  'css-variable',
    }
  }

  // 3. Frequency: most common non-grey hex/rgb in the document
  const all: string[] = []
  const hexRe = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g
  let h: RegExpExecArray | null
  while ((h = hexRe.exec(html)) !== null) {
    const hex = toHex('#' + h[1])
    if (hex && !isGrey(hex) && !isExtreme(hex)) all.push(hex)
  }
  const rgbRe = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/gi
  let r: RegExpExecArray | null
  while ((r = rgbRe.exec(html)) !== null) {
    const hex = toHex(r[0])
    if (hex && !isGrey(hex) && !isExtreme(hex)) all.push(hex)
  }
  if (all.length > 0) {
    const ranked = mostFrequent(all)
    return {
      primary: ranked[0] || null,
      accent:  ranked[1] || (ranked[0] ? deriveAccent(ranked[0]) : null),
      source:  'frequency',
    }
  }

  return { primary: null, accent: null, source: 'none' }
}

function toHex(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (/^[0-9a-f]{3}$/.test(h)) {
      return '#' + h.split('').map(c => c + c).join('')
    }
    if (/^[0-9a-f]{6}$/.test(h)) return '#' + h
    if (/^[0-9a-f]{8}$/.test(h)) return '#' + h.slice(0, 6) // drop alpha
    return null
  }
  if (s.startsWith('rgb')) {
    const m = s.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    if (!m) return null
    const r = clamp(+m[1], 0, 255)
    const g = clamp(+m[2], 0, 255)
    const b = clamp(+m[3], 0, 255)
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')
  }
  return null
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)) }

function isGrey(hex: string): boolean {
  // R, G, B all within 8 of each other → effectively grey.
  const [r, g, b] = hexToRgb(hex)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return max - min <= 8
}

function isExtreme(hex: string): boolean {
  // Pure black, pure white, near-white. Skip.
  const [r, g, b] = hexToRgb(hex)
  if (r >= 245 && g >= 245 && b >= 245) return true
  if (r <= 12  && g <= 12  && b <= 12)  return true
  return false
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('')
}

function mostFrequent(items: string[]): string[] {
  const counts = new Map<string, number>()
  for (const it of items) counts.set(it, (counts.get(it) || 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
}

// Darken a colour by ~25% in luminance for the accent role.
function deriveAccent(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r * 0.75, g * 0.75, b * 0.75)
}
