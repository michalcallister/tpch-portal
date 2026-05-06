// ============================================================
// TPCH Portal — Morning Brief Agent
// Supabase Edge Function: morning-brief-agent
//
// Generates the daily Morning Brief shown on the partner dashboard.
// Two sections per brief:
//   1. market_pulse — 4 real Australian property news articles, fetched
//                     via Claude's server-side web_search tool from a
//                     curated allow-list of reputable AU outlets. Each
//                     item carries headline, summary, source_name,
//                     source_url, and published_date.
//   2. send_this    — one general market-read paragraph the partner can
//                     broadcast to their client list (NOT project-specific)
//
// Triggers:
//   - Cron (set via Supabase Dashboard → Edge Functions → cron):
//     `0 20 * * *` UTC ≈ 04:00 AWST. Body empty → process all active
//     partners. Existing briefs for today are skipped unless force=true.
//   - HTTP POST { partner_id, force? } from admin/dev preview.
//
// Secrets required:
//   CLAUDE_API_KEY            (Anthropic API key)
//   SUPABASE_URL              (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { TPCH_TONE_RULES } from '../_shared/tpch-tone.ts'

const CLAUDE_API_KEY = Deno.env.get('CLAUDE_API_KEY')!
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Curated AU real-estate news allow-list ────────────────────
// Web search is restricted to these domains. The big mainstream mastheads
// (AFR, The Australian, SMH, The Age, ABC, news.com.au, Domain,
// realestate.com.au) all block Anthropic's web-search crawler in robots.txt
// as of 2026-05, so they're omitted here — including them would 400 the
// whole call. We're left with specialist property/investment publications,
// commercial / new-build portals, and the official data houses.
const AU_NEWS_ALLOW_LIST = [
  // Property portals with editorial (commercial + new-build)
  'commercialrealestate.com.au',
  'view.com.au',
  // Specialist property / investment press
  'propertyupdate.com.au',
  'realestatebusiness.com.au',
  'yourinvestmentpropertymag.com.au',
  'apimagazine.com.au',
  'urban.com.au',
  'eliteagent.com',
  'macrobusiness.com.au',
  // Data houses (often publish their own news / commentary)
  'corelogic.com.au',
  'sqmresearch.com.au',
  'rba.gov.au',
  'abs.gov.au',
]

// ── Brand-faithful brief author prompt ────────────────────────
const BRIEF_SYSTEM_PROMPT = `You are the TPCH Morning Brief author. Each morning you research and write a brief for one channel partner. Your audience is a busy buyer's agent or financial adviser who logs in once a day and wants two things in 30 seconds:

1. Four current Australian property news articles they could send to a client or quote in a meeting today.
2. One short paragraph they can copy-paste straight to their entire client base right now — a general market read, NOT about any specific project.

${TPCH_TONE_RULES}

YOUR RESEARCH PROCESS:
- Use the web_search tool 3–5 times to find the most relevant Australian residential property market news.
- Strongly prefer articles published in the last 24–48 hours. Only extend to the last 7 days if recent coverage is genuinely thin on the chosen angle.
- Always include "Australia" or a state/city name in your queries to bias to AU sources. Bias to current dates ("today", "this week", current month/year).
- Vary your queries across themes: macro (RBA, lending, prices, inflation), regional (Brisbane, Perth, Melbourne, Sydney, regional QLD/WA), and supply/demand (auctions, listings, rents, approvals, completions).
- If the partner's tracked book is concentrated in one state or suburb, lean queries toward that geography — but do NOT name a specific project, lot, or property in any output.

ARTICLE SELECTION:
- Pick exactly 4 articles. Each from a different angle — don't pick 4 articles all about the same single story.
- Prefer substantive analysis from urban.com.au (new-build / development), CoreLogic, propertyupdate.com.au, macrobusiness.com.au, the RBA, ABS, and SQM Research over thin agent-industry write-ups.
- Skip listicles, sponsored content, agent self-promotion, or "10 hottest suburbs" filler. We want substance.

FORMAT RULES (per article):
- headline: the article's actual headline (or a tight ≤120-char paraphrase if the original is sensational/clickbait).
- summary: 1–2 sentences in TPCH voice. Lead with the substantive fact (number, decision, trend), not the journalist's framing. Plain English.
- kind: "tailwind" if the article suggests support for property values/demand; "headwind" if it suggests pressure; "neutral" otherwise.
- source_name: the publication (e.g. "Urban Developer", "CoreLogic", "Property Update", "Macro Business", "Your Investment Property", "RBA", "ABS").
- source_url: the actual article URL you cited (must be a real URL returned by the search tool — do not invent).
- published_date: ISO-8601 (YYYY-MM-DD). Use the article's publication date.

SEND_THIS paragraph:
- 50–90 words. Addressed to "[Client first name]" as a placeholder.
- Synthesise what the day's coverage collectively says about the market. Don't restate every article — give the partner the one useful read they'd text every client this morning.
- Plain English. No marketing fluff. NEVER mention a specific project, suburb-of-the-week, lot, or property — this is general market commentary.
- If the day's coverage is genuinely thin and you cannot synthesise a defensible market read, return null for send_this. Do not fabricate.

OUTPUT — strict JSON only, no preamble, no markdown fences. Return EXACTLY this schema:
{
  "market_pulse": [{
    "headline": string,
    "summary": string,
    "kind": "tailwind" | "headwind" | "neutral",
    "source_name": string,
    "source_url": string,
    "published_date": string
  }],
  "send_this": null | { "paragraph": string }
}

Return exactly 4 market_pulse items.`

// ── Per-partner context gather ────────────────────────────────
type Ctx = {
  partner: any
  activeDeals: any[]
  expiringReservations: any[]
  stalledDeals: any[]
  shortlistProjects: any[]
  recentlyViewedProjects: any[]
  recentEvents: any[]
  suburbSnapshots: any[]
}

async function gatherContext(partnerId: string): Promise<Ctx | null> {
  const { data: partner } = await sb
    .from('channel_partners')
    .select('id, full_name, company_name, state, role_type')
    .eq('id', partnerId)
    .single()
  if (!partner) return null

  const { data: deals } = await sb
    .from('partner_deals')
    .select('id, name, stage, property_id, property_name, client_name, expected_settlement_date, channel_partner_name, fully_paid_date, stage_changed_at')
    .ilike('channel_partner_name', partner.company_name || '___no_match___')
  const allDeals = deals || []
  const activeDeals = allDeals.filter(d => !d.fully_paid_date)

  const stalledDeals = activeDeals.filter(d => {
    if (!d.stage_changed_at) return false
    const days = (Date.now() - new Date(d.stage_changed_at).getTime()) / 86400000
    return days >= 14
  })

  const { data: reservations } = await sb
    .from('reservations')
    .select('id, status, expires_at, stock_name, project_name, client_name')
    .eq('partner_id', partnerId)
    .eq('status', 'reserved')
  const expiringReservations = (reservations || []).filter(r => {
    if (!r.expires_at) return false
    const hrs = (new Date(r.expires_at).getTime() - Date.now()) / 3600000
    return hrs > 0 && hrs <= 48
  })

  const { data: shortlistItems } = await sb
    .from('shortlist_items')
    .select('project_id, project_name, stock_id, stock_name')
    .eq('partner_id', partnerId)
    .order('added_at', { ascending: false })
    .limit(20)
  const shortlistProjectIds = dedupeBy(
    (shortlistItems || []).filter(s => s.project_id),
    s => s.project_id
  ).map((s: any) => s.project_id)

  const { data: views } = await sb
    .from('partner_recent_views')
    .select('entity_type, entity_id, viewed_at')
    .eq('partner_id', partnerId)
    .gte('viewed_at', new Date(Date.now() - 30 * 86400000).toISOString())
    .order('viewed_at', { ascending: false })
    .limit(20)
  const viewedProjectIds = (views || []).filter(v => v.entity_type === 'project').map(v => v.entity_id)

  // Hydrate both shortlisted and viewed projects in one round-trip so we have
  // suburb/state for prompt context (shortlist_items only stores project_name).
  const allTrackedIds = [...new Set([...shortlistProjectIds, ...viewedProjectIds])]
  const trackedProjects = allTrackedIds.length
    ? (await sb.from('projects').select('id, name, suburb, state').in('id', allTrackedIds)).data || []
    : []
  const shortlistSet = new Set(shortlistProjectIds)
  const shortlistProjects = trackedProjects.filter((p: any) => shortlistSet.has(p.id))
  const recentlyViewedProjects = trackedProjects.filter((p: any) => viewedProjectIds.includes(p.id) && !shortlistSet.has(p.id))

  // Stock events relevant to partner — small enough to inline.
  const { data: eventsRaw } = await sb.rpc('get_partner_stock_events', { p_limit: 15 })
  const recentEvents = Array.isArray(eventsRaw) ? eventsRaw : []

  // Suburb research snapshots for the suburbs of partner's tracked projects.
  // Use real project.suburb values, not project names.
  const suburbList = [...new Set(trackedProjects.map((p: any) => p.suburb).filter(Boolean))].slice(0, 6) as string[]
  let suburbSnapshots: any[] = []
  if (suburbList.length) {
    const { data: sr } = await sb
      .from('suburb_research')
      .select('suburb, state_code, thesis_short, vacancy_rate, median_price, capital_growth_10yr, avg_yield')
      .in('suburb', suburbList)
      .eq('status', 'published')
    suburbSnapshots = sr || []
  }

  return {
    partner,
    activeDeals,
    expiringReservations,
    stalledDeals,
    shortlistProjects,
    recentlyViewedProjects,
    recentEvents,
    suburbSnapshots,
  }
}

function dedupeBy<T>(items: T[], key: (i: T) => string | null | undefined): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const i of items) {
    const k = key(i)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(i)
  }
  return out
}

// ── Compose user prompt from gathered context ─────────────────
function buildUserPrompt(c: Ctx): string {
  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const lines: string[] = []
  lines.push(`PARTNER: ${c.partner.full_name} at ${c.partner.company_name || 'unnamed firm'}`)
  if (c.partner.state) lines.push(`Primary state: ${c.partner.state}`)
  if (c.partner.role_type) lines.push(`Role: ${c.partner.role_type}`)
  lines.push(`Today: ${today}`)
  lines.push('')

  // Partner pipeline context (deals, reservations, settlements) intentionally
  // omitted from this prompt — the brief is now market commentary only and
  // including book-specific data risks the model leaking it into send_this.

  const tracked = dedupeBy(
    [
      ...c.shortlistProjects.map((p: any) => ({ id: p.id, name: p.name, suburb: p.suburb, state: p.state, source: 'shortlist' })),
      ...c.recentlyViewedProjects.map((p: any) => ({ id: p.id, name: p.name, suburb: p.suburb, state: p.state, source: 'viewed' })),
    ],
    (i: any) => i.id
  ).slice(0, 8)
  if (tracked.length) {
    lines.push('PARTNER\'S TRACKED PROJECTS (shortlisted + viewed in last 30 days):')
    for (const p of tracked as any[]) {
      const loc = p.suburb ? ` (${p.suburb}${p.state ? ', ' + p.state : ''})` : ''
      lines.push(`- ${p.name}${loc} [project_id=${p.id}, source=${p.source}]`)
    }
    lines.push('')
  }

  if (c.recentEvents.length) {
    lines.push('STOCK MARKET CHANGES IN PARTNER\'S BOOK (last 14 days):')
    for (const e of c.recentEvents.slice(0, 8)) {
      lines.push(`- ${e.event_type} on ${e.stock_name || e.project_name || '?'}: ${JSON.stringify(e.payload || {})}`)
    }
    lines.push('')
  }

  if (c.suburbSnapshots.length) {
    lines.push('PUBLISHED TPCH SUBURB RESEARCH for partner\'s relevant suburbs:')
    for (const s of c.suburbSnapshots.slice(0, 6)) {
      const bits = [
        s.vacancy_rate != null         ? `vacancy ${s.vacancy_rate}%` : null,
        s.median_price != null         ? `median $${Math.round(s.median_price).toLocaleString('en-AU')}` : null,
        s.avg_yield != null            ? `yield ${s.avg_yield}%` : null,
        s.capital_growth_10yr != null  ? `10-yr growth ${s.capital_growth_10yr}% p.a.` : null,
      ].filter(Boolean).join(' · ')
      lines.push(`- ${s.suburb}, ${s.state_code || ''}: ${bits || 'no headline stats'}`)
      if (s.thesis_short) lines.push(`  Thesis: ${s.thesis_short}`)
    }
    lines.push('')
  }

  lines.push('Compose the brief now. Output strict JSON per the schema in the system prompt.')
  return lines.join('\n')
}

// ── Cost tracking ────────────────────────────────────────────
// Anthropic pricing in USD per million tokens. Update when pricing changes.
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001':  { in: 1,  out: 5  },
  'claude-haiku-4-5':           { in: 1,  out: 5  },
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-sonnet-4-6-20251015': { in: 3,  out: 15 },
  'claude-opus-4-7':            { in: 15, out: 75 },
}

const AGENT_SLUG = 'morning-brief-agent'

async function logAgentRun(opts: {
  model: string
  usage?: { input_tokens?: number; output_tokens?: number } | null
  status?: 'completed' | 'failed'
  startedAt: number
  triggeredBy?: string
  errorMessage?: string | null
}) {
  try {
    if (!opts.usage) return
    const inTok  = opts.usage.input_tokens  || 0
    const outTok = opts.usage.output_tokens || 0
    const price  = MODEL_PRICING[opts.model] || { in: 3, out: 15 }
    const cost   = Math.round(inTok * price.in + outTok * price.out)
    const { data: agent } = await sb.from('agents').select('id').eq('slug', AGENT_SLUG).single()
    if (!agent) return
    await sb.from('agent_runs').insert({
      agent_id:        agent.id,
      status:          opts.status || 'completed',
      triggered_by:    opts.triggeredBy || AGENT_SLUG,
      started_at:      new Date(opts.startedAt).toISOString(),
      completed_at:    new Date().toISOString(),
      duration_ms:     Date.now() - opts.startedAt,
      model_used:      opts.model,
      input_tokens:    inTok,
      output_tokens:   outTok,
      cost_usd_micros: cost,
      error:           opts.errorMessage || null,
    })
  } catch (_) { /* never block primary flow on telemetry */ }
}

// ── Claude call ───────────────────────────────────────────────
async function callClaudeForBrief(systemPrompt: string, userPrompt: string, triggeredBy?: string): Promise<any> {
  const startedAt = Date.now()
  const model = 'claude-sonnet-4-6'
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        // Server-side web search restricted to the curated AU news allow-list.
        // max_uses caps cost (~$0.01/search) and bounds latency. 5 is enough
        // to find 4 well-varied articles in practice.
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: AU_NEWS_ALLOW_LIST,
          max_uses: 5,
        }],
      }),
    })
  } catch (e) {
    await logAgentRun({ model, startedAt, status: 'failed', triggeredBy, errorMessage: (e as Error).message })
    throw e
  }
  if (!res.ok) {
    const errText = await res.text()
    await logAgentRun({ model, startedAt, status: 'failed', triggeredBy, errorMessage: `Claude API ${res.status}: ${errText.slice(0, 200)}` })
    throw new Error(`Claude API ${res.status}: ${errText}`)
  }
  const data = await res.json()
  await logAgentRun({ model, startedAt, status: 'completed', triggeredBy, usage: data.usage })

  const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
  const extracted = extractJsonObject(text)
  if (!extracted) {
    throw new Error(`Brief JSON parse failed: no JSON object found in model output. Raw: ${text.slice(0, 400)}`)
  }
  let parsed: any
  try {
    parsed = JSON.parse(extracted)
  } catch (e) {
    throw new Error(`Brief JSON parse failed: ${(e as Error).message}. Raw: ${extracted.slice(0, 400)}`)
  }
  return parsed
}

// Pull the first JSON object out of arbitrary model output. Handles:
//   - bare JSON
//   - JSON wrapped in ```json ... ``` fences
//   - JSON preceded by reasoning narration like "Now I have... Here is the brief:"
// Done by string-walking with quote/escape awareness — JSON.parse already
// handles the rest, and a brace-balance walk avoids regex pathologies on
// objects that contain "}" inside string values.
function extractJsonObject(s: string): string | null {
  if (!s) return null
  // Prefer fenced content if present — gives the model an unambiguous wrapper.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : s
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }
  return null
}

// ── Validate model output before insert ───────────────────────
function validateBrief(b: any): { market_pulse: any[]; pipeline_lines: string[]; send_this: any } {
  // Source URL must be http(s) on a real-looking domain on our allow-list.
  // (The model is told to use the search tool; this is a belt-and-braces
  // backstop in case it ever invents a URL.)
  const allowSet = new Set(AU_NEWS_ALLOW_LIST)
  const isValidArticleUrl = (u: any): boolean => {
    if (typeof u !== 'string') return false
    try {
      const url = new URL(u.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      // Match either the bare domain or any subdomain of an allow-listed root.
      for (const root of allowSet) {
        if (host === root || host.endsWith('.' + root)) return true
      }
      return false
    } catch { return false }
  }
  // ISO-ish date (YYYY-MM-DD). Tolerate full timestamps by truncating.
  const normaliseDate = (d: any): string | null => {
    if (typeof d !== 'string') return null
    const m = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? m[0] : null
  }
  const trimTo = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
  // TPCH brand rule: never use em dashes (—). The model regularly ignores
  // this even when told. Strip on ingest with sensible whitespace handling.
  // " — " → ". "; "X—Y" → "X, Y"; standalone " — " at start/end → ", ".
  // Also strip any en dashes the model leans on when told no em dashes.
  const stripEmDashes = (s: string) => s
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/, ([.,;:!?])/g, '$1')   // tidy up if a sentence ended right before
    .replace(/, , /g, ', ')           // collapse accidental doubles
    .trim()

  const mp = Array.isArray(b?.market_pulse)
    ? b.market_pulse
        .filter((m: any) => m
          && typeof m.headline === 'string' && m.headline.trim()
          && typeof m.summary === 'string' && m.summary.trim().length >= 20)
        .map((m: any) => ({
          headline:       trimTo(stripEmDashes(String(m.headline).trim()), 200),
          summary:        trimTo(stripEmDashes(String(m.summary).trim()),  500),
          kind:           ['tailwind', 'headwind', 'neutral'].includes(m.kind) ? m.kind : 'neutral',
          source_name:    typeof m.source_name === 'string' ? m.source_name.trim() : null,
          source_url:     isValidArticleUrl(m.source_url) ? String(m.source_url).trim() : null,
          published_date: normaliseDate(m.published_date),
        }))
        // Hard rule: NO article without a usable source_url + source_name.
        // Allow-list mismatch silently drops the item rather than letting
        // an unsourced or off-domain link through.
        .filter((m: any) => m.source_url && m.source_name)
        .slice(0, 4)
    : []
  // pipeline_lines deprecated — kept on the table as [] so the column stays
  // happy until we run a migration to drop it. The frontend no longer renders it.
  const pl: string[] = []
  let st: any = null
  if (b?.send_this && typeof b.send_this === 'object'
      && typeof b.send_this.paragraph === 'string'
      && b.send_this.paragraph.trim().length >= 30) {
    st = { paragraph: stripEmDashes(b.send_this.paragraph.trim()) }
  }
  return { market_pulse: mp, pipeline_lines: pl, send_this: st }
}

// ── Today's date in AWST (matches partner_briefs.brief_date default) ─
function todayPerth(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

// ── Generate one brief ────────────────────────────────────────
async function generateForPartner(partnerId: string, force: boolean): Promise<{ status: string; reason?: string }> {
  const today = todayPerth()
  if (!force) {
    const { data: existing } = await sb
      .from('partner_briefs')
      .select('id')
      .eq('partner_id', partnerId)
      .eq('brief_date', today)
      .maybeSingle()
    if (existing) return { status: 'skipped', reason: 'brief already exists for today' }
  }

  const ctx = await gatherContext(partnerId)
  if (!ctx) return { status: 'skipped', reason: 'partner not found or inactive' }

  const userPrompt = buildUserPrompt(ctx)
  const raw = await callClaudeForBrief(BRIEF_SYSTEM_PROMPT, userPrompt, `partner:${partnerId}`)
  const brief = validateBrief(raw)

  const { error } = await sb
    .from('partner_briefs')
    .upsert({
      partner_id:     partnerId,
      brief_date:     today,
      market_pulse:   brief.market_pulse,
      pipeline_lines: brief.pipeline_lines,
      send_this:      brief.send_this,
      source_version: 'v2-news',
      generated_at:   new Date().toISOString(),
    }, { onConflict: 'partner_id,brief_date' })
  if (error) throw new Error(`Insert failed: ${error.message}`)
  return { status: 'generated' }
}

// ── Cron entry — generate for all active partners ─────────────
async function generateForAll(force: boolean): Promise<any> {
  const { data: partners } = await sb
    .from('channel_partners')
    .select('id, full_name, company_name')
    .eq('status', 'active')
  const results: any[] = []
  for (const p of partners || []) {
    try {
      const r = await generateForPartner(p.id, force)
      results.push({ partner_id: p.id, name: p.full_name, ...r })
    } catch (e) {
      results.push({ partner_id: p.id, name: p.full_name, status: 'error', reason: (e as Error).message })
    }
  }
  return {
    total: (partners || []).length,
    generated: results.filter(r => r.status === 'generated').length,
    skipped:   results.filter(r => r.status === 'skipped').length,
    errors:    results.filter(r => r.status === 'error').length,
    results,
  }
}

// ── HTTP entry ────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    if (!CLAUDE_API_KEY) {
      return new Response(JSON.stringify({ error: 'CLAUDE_API_KEY not set' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let body: any = {}
    if (req.method === 'POST') {
      const text = await req.text()
      if (text) try { body = JSON.parse(text) } catch { body = {} }
    }
    const force = !!body.force

    if (body.partner_id) {
      const result = await generateForPartner(String(body.partner_id), force)
      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const summary = await generateForAll(force)
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('morning-brief-agent error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
