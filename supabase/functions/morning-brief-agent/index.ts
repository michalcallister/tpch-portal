// ============================================================
// TPCH Portal — Morning Brief Agent
// Supabase Edge Function: morning-brief-agent
//
// Generates ONE shared "house brief" per day. Every active channel
// partner reads the same row from `daily_briefs`. Two sections:
//   1. market_pulse — 4 real Australian property news articles. Source
//                     pipeline (in priority order):
//                       (a) RSS pre-fetch across ~13 AU property +
//                           business feeds (see _shared/rss-fetch.ts)
//                       (b) Claude's server-side web_search tool as
//                           a silent fallback when the RSS pack is
//                           empty or thin
//                     Each item carries headline, summary, source_name,
//                     source_url, and published_date.
//   2. send_this    — one general market-read paragraph the partner can
//                     broadcast to their client list. NOT project-specific.
//
// Why one shared row, not one per partner:
//   The previous design called Claude once per partner (~30k input
//   tokens each) but the prompt explicitly forbade project- or
//   suburb-specific content, so every partner got the same article
//   pool and a general paragraph. It was redundant work that tripped
//   Anthropic's 30k input tokens/min rate limit at 5 partners and
//   structurally couldn't scale past Supabase's 150s per-invocation
//   cap. The shared brief is one call/day, ~$0.05, regardless of
//   partner count.
//
// Triggers:
//   - Cron (set via Supabase Dashboard → Edge Functions → cron):
//     `0 20 * * *` UTC ≈ 04:00 AWST. Body empty → generate today's
//     brief. Skipped if today's row already exists unless force=true.
//   - HTTP POST { force? } from admin/dev preview.
//
// Secrets required:
//   CLAUDE_API_KEY            (Anthropic API key)
//   SUPABASE_URL              (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { TPCH_TONE_RULES } from '../_shared/tpch-tone.ts'
import { fetchFeedPack, DEFAULT_AU_PROPERTY_FEEDS, type FeedPack } from '../_shared/rss-fetch.ts'

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

// ── web_search fallback allow-list ────────────────────────────
// Used ONLY for the web_search tool's allowed_domains parameter, which
// fires as a fallback if the RSS pack is empty. The big mainstream
// mastheads (AFR, The Australian, SMH, The Age, ABC, news.com.au,
// Domain, realestate.com.au) all block Anthropic's web-search crawler
// in robots.txt — including them here would 400 the call. We reach
// those publishers via RSS pre-fetch instead.
//
// Excluded after probing on 2026-05-07: apimagazine.com.au and
// eliteagent.com — Cloudflare-walled at the article level for many
// non-Australian-residential IPs, so links land partners on a 403.
const WEB_SEARCH_ALLOW_LIST = [
  // Property portals with editorial (commercial + new-build)
  'commercialrealestate.com.au',
  'view.com.au',
  // Specialist property / investment press
  'propertyupdate.com.au',
  'yourinvestmentpropertymag.com.au',
  'urban.com.au',
  'macrobusiness.com.au',
  // Data houses (often publish their own news / commentary)
  'corelogic.com.au',
  'sqmresearch.com.au',
  'rba.gov.au',
  'abs.gov.au',
]

// Module-level cache so the cron run (which iterates partners) only fetches
// the feed pack once. Edge worker recycling makes this best-effort, but
// when it lands it saves ~5s and N RSS roundtrips per extra partner.
let cachedFeedPack: { pack: FeedPack; fetchedAt: number } | null = null
const FEED_PACK_TTL_MS = 10 * 60_000

async function getFeedPackCached(): Promise<FeedPack> {
  if (cachedFeedPack && Date.now() - cachedFeedPack.fetchedAt < FEED_PACK_TTL_MS) {
    return cachedFeedPack.pack
  }
  const pack = await fetchFeedPack({ feeds: DEFAULT_AU_PROPERTY_FEEDS })
  cachedFeedPack = { pack, fetchedAt: Date.now() }
  // Per-feed health line — visible in Supabase Function Logs.
  const healthLine = pack.stats
    .map(s => `${s.feed}=${s.status}${s.itemsKept ? '/' + s.itemsKept : ''}`)
    .join(', ')
  console.log(`[morning-brief] feed pack: ${pack.items.length} items | ${healthLine}`)
  return pack
}

// ── Brand-faithful brief author prompt ────────────────────────
const BRIEF_SYSTEM_PROMPT = `You are the TPCH Morning Brief author. Each morning you write a brief for one channel partner. Your audience is a busy buyer's agent or financial adviser who logs in once a day and wants two things in 30 seconds:

1. Four current Australian property news articles they could send to a client or quote in a meeting today.
2. One short paragraph they can copy-paste straight to their entire client base right now, a general market read, NOT about any specific project.

${TPCH_TONE_RULES}

YOUR SOURCE MATERIAL:
The user message contains a "TODAY'S HEADLINES" pack: a curated set of recent articles (last 48 hours) pre-fetched from Australian property and business RSS feeds. This is your primary source. Pick your 4 articles from this pack. You may NOT invent articles or URLs.

If, and only if, the pack is empty or has fewer than 4 articles you would call useful, you may use the web_search tool (max 3 searches) to find additional Australian property news. Bias web_search queries to current dates and Australian sources.

ARTICLE SELECTION:
- Pick exactly 4 articles. Each from a different angle, don't pick 4 articles all about the same single story.
- NEVER cite the same URL twice in a single brief.
- If the pack contains articles from multiple publications, spread your 4 picks across different publications. Avoid citing the same publication more than twice in one brief unless the pack genuinely offers nothing else.
- Cover the Australian market as a whole. Don't over-weight one state — partners read this across every state and territory.
- Skip thin listicles, sponsored content, agent self-promotion, "10 hottest suburbs" filler. Pick the substantive ones.

FORMAT RULES (per article):
- headline: copy the title from the pack verbatim (or paraphrase to ≤120 chars only if the original is genuinely too long or sensational).
- summary: 1-2 sentences in TPCH voice. Lead with the substantive fact (number, decision, trend), not the journalist's framing. Plain English. Use the pack's summary as a starting point, but rewrite in TPCH voice.
- kind: "tailwind" if the article suggests support for property values/demand; "headwind" if it suggests pressure; "neutral" otherwise.
- source_name: the publication (use the "source" field from the pack, e.g. "Urban Developer", "ABC News", "RBA Media Releases").
- source_url: the URL from the pack, exact, do not modify or shorten.
- published_date: ISO-8601 (YYYY-MM-DD). Use the article's published date from the pack.

SEND_THIS paragraph:
- 60-90 words. Addressed to "[Client first name]" as a placeholder.
- Synthesise what the day's coverage collectively says about the market. Don't restate every article, give the partner the one useful read they'd text every client this morning.
- Plain English. No marketing fluff. NEVER mention a specific project, suburb-of-the-week, lot, or property, this is general market commentary.
- If the day's coverage is genuinely thin and you cannot synthesise a defensible market read, return null for send_this. Do not fabricate.

OUTPUT, strict JSON only, no preamble, no markdown fences. Return EXACTLY this schema:
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

// Compose the user prompt — just today's date and the RSS headline
// pack. No partner-specific context: the brief is market commentary
// shared across every partner.
function buildUserPrompt(pack: FeedPack): string {
  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const lines: string[] = []
  lines.push(`Today: ${today}`)
  lines.push('')

  if (pack.items.length) {
    lines.push(`TODAY'S HEADLINES (${pack.items.length} articles, last 48h, from curated AU property + business RSS feeds):`)
    pack.items.forEach((it, i) => {
      const date = it.publishedAt.toISOString().slice(0, 10)
      lines.push(`[${i + 1}] ${it.source} (${date}): "${it.title}"`)
      lines.push(`    URL: ${it.url}`)
      if (it.summary) lines.push(`    Summary: ${it.summary.slice(0, 300)}`)
    })
    lines.push('')
  } else {
    lines.push("TODAY'S HEADLINES: (RSS pack returned empty, fall back to web_search)")
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
  // Always persist a row — including failure paths where usage is absent.
  // Previously this early-returned on `!opts.usage`, which meant every
  // Claude API failure was silently swallowed and never surfaced in
  // agent_runs, leaving us blind on broken cron mornings.
  const inTok  = opts.usage?.input_tokens  || 0
  const outTok = opts.usage?.output_tokens || 0
  const price  = MODEL_PRICING[opts.model] || { in: 3, out: 15 }
  const cost   = Math.round(inTok * price.in + outTok * price.out)
  if (opts.status === 'failed' || opts.errorMessage) {
    console.error(`[morning-brief] run failed (${opts.triggeredBy || AGENT_SLUG}): ${opts.errorMessage || 'unknown'}`)
  }
  try {
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
        // Web_search is now a *fallback* — RSS pre-fetch is the primary source.
        // The model is told in the system prompt to prefer the headline pack
        // and only reach for search if the pack is thin. max_uses caps the
        // worst case (~$0.01/search) and bounds latency.
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: WEB_SEARCH_ALLOW_LIST,
          max_uses: 3,
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
function validateBrief(b: any, pack: FeedPack): { market_pulse: any[]; pipeline_lines: string[]; send_this: any } {
  // Two-tier URL acceptance:
  //   (a) URL is exactly in the RSS pack we sent the model — guaranteed real.
  //   (b) URL is on a WEB_SEARCH_ALLOW_LIST domain — could legitimately have
  //       come from the web_search fallback path (article body unavailable
  //       to us, but the domain is one we trust the model not to fabricate
  //       wholesale, since web_search returns real result URLs).
  // Anything else (e.g. an abc.net.au URL not in today's pack) is treated
  // as model invention and dropped. This stops the previous failure mode
  // where the model produced plausible-looking URLs for publishers it knew
  // by name but couldn't actually reach.
  const packUrls = new Set(pack.items.map(it => it.url))
  const searchAllowSet = new Set(WEB_SEARCH_ALLOW_LIST)
  const isAcceptableUrl = (u: any): boolean => {
    if (typeof u !== 'string') return false
    const trimmed = u.trim()
    if (packUrls.has(trimmed)) return true
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      for (const root of searchAllowSet) {
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
    ? dedupeBy(
        b.market_pulse
          .filter((m: any) => m
            && typeof m.headline === 'string' && m.headline.trim()
            && typeof m.summary === 'string' && m.summary.trim().length >= 20)
          .map((m: any) => ({
            headline:       trimTo(stripEmDashes(String(m.headline).trim()), 200),
            summary:        trimTo(stripEmDashes(String(m.summary).trim()),  500),
            kind:           ['tailwind', 'headwind', 'neutral'].includes(m.kind) ? m.kind : 'neutral',
            source_name:    typeof m.source_name === 'string' ? m.source_name.trim() : null,
            source_url:     isAcceptableUrl(m.source_url) ? String(m.source_url).trim() : null,
            published_date: normaliseDate(m.published_date),
          }))
          // Hard rule: NO article without a usable source_url + source_name.
          // Allow-list mismatch silently drops the item rather than letting
          // an unsourced or off-domain link through.
          .filter((m: any) => m.source_url && m.source_name),
        // Belt-and-braces: model occasionally cites the same article twice.
        // Drop dupes by URL before slicing to 4 — partners shouldn't see the
        // same headline twice in one brief.
        (m: any) => m.source_url
      ).slice(0, 4)
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

// Today's date in AWST (matches daily_briefs.brief_date default).
function todayPerth(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

// ── Generate today's shared brief ─────────────────────────────
async function generateDailyBrief(force: boolean, triggeredBy: string): Promise<{ status: string; reason?: string }> {
  const today = todayPerth()
  if (!force) {
    const { data: existing } = await sb
      .from('daily_briefs')
      .select('brief_date')
      .eq('brief_date', today)
      .maybeSingle()
    if (existing) return { status: 'skipped', reason: 'brief already exists for today' }
  }

  const pack = await getFeedPackCached()
  const userPrompt = buildUserPrompt(pack)
  const raw = await callClaudeForBrief(BRIEF_SYSTEM_PROMPT, userPrompt, triggeredBy)
  const brief = validateBrief(raw, pack)

  const { error } = await sb
    .from('daily_briefs')
    .upsert({
      brief_date:     today,
      market_pulse:   brief.market_pulse,
      send_this:      brief.send_this,
      source_version: 'v4-shared',
      generated_at:   new Date().toISOString(),
    }, { onConflict: 'brief_date' })
  if (error) throw new Error(`Insert failed: ${error.message}`)
  return { status: 'generated' }
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
    let rawBody = ''
    if (req.method === 'POST') {
      rawBody = await req.text()
      if (rawBody) try { body = JSON.parse(rawBody) } catch { body = {} }
    }
    const force = !!body.force
    // `triggered_by` distinguishes cron vs manual replays in agent_runs.
    // Cron sends an empty body; manual POSTs always carry one (even `{}`).
    const triggeredBy = rawBody.trim().length > 0 ? 'manual' : 'cron'

    const result = await generateDailyBrief(force, triggeredBy)
    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('morning-brief-agent error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
