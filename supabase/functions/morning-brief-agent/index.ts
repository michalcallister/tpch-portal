// ============================================================
// TPCH Portal — Morning Brief Agent
// Supabase Edge Function: morning-brief-agent
//
// Generates the daily Morning Brief shown on the partner dashboard.
// Two sections per brief:
//   1. market_pulse — 2-4 bullets of defensible market reads
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

// ── Brand-faithful brief author prompt ────────────────────────
const BRIEF_SYSTEM_PROMPT = `You are the TPCH Morning Brief author. Each morning you write a short, opinionated brief for one channel partner. Your audience is a busy buyer's agent or financial adviser who logs in once a day and wants two things in 30 seconds:

1. A read on the residential property market — short bullets they could quote to a client.
2. One short paragraph they can copy-paste straight to their entire client base right now — a general market read, NOT about any specific project.

${TPCH_TONE_RULES}

ADDITIONAL RULES FOR THIS BRIEF FORMAT:
- Personalise market_pulse to the partner's actual book where useful. If most of their book is QLD, lean into QLD data. But the bullets should still be defensible market reads, not partner-specific deal commentary.
- Every bullet in market_pulse must contain at least one concrete number, percentage, or named source. No platitudes.
- send_this paragraph: 50–90 words, a general market update the partner can broadcast to their whole client list. Addressed to "[Client first name]" as a placeholder. Plain English. No marketing fluff. NEVER mention a specific project, suburb-of-the-week, lot, or property — this is a market commentary, not a sales push. Think: "what's the one useful thing you'd text every client this morning?"
- If you have no defensible market signal at all (no suburb research, no events of substance), return null for send_this. Do not fabricate.

OUTPUT — strict JSON only, no preamble, no markdown fences. Schema:
{
  "market_pulse": [{ "stat": string, "kind": "tailwind" | "headwind" | "neutral" }],
  "send_this": null | { "paragraph": string }
}

Return between 2 and 4 market_pulse items.`

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
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
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
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`Brief JSON parse failed: ${(e as Error).message}. Raw: ${cleaned.slice(0, 400)}`)
  }
  return parsed
}

// ── Validate model output before insert ───────────────────────
function validateBrief(b: any): { market_pulse: any[]; pipeline_lines: string[]; send_this: any } {
  const mp = Array.isArray(b?.market_pulse)
    ? b.market_pulse
        .filter((m: any) => m && typeof m.stat === 'string' && m.stat.trim())
        .map((m: any) => ({
          stat: String(m.stat).trim(),
          kind: ['tailwind', 'headwind', 'neutral'].includes(m.kind) ? m.kind : 'neutral',
        }))
        .slice(0, 4)
    : []
  // pipeline_lines deprecated — kept on the table as [] so the column stays
  // happy until we run a migration to drop it. The frontend no longer renders it.
  const pl: string[] = []
  let st: any = null
  if (b?.send_this && typeof b.send_this === 'object'
      && typeof b.send_this.paragraph === 'string'
      && b.send_this.paragraph.trim().length >= 30) {
    st = { paragraph: b.send_this.paragraph.trim() }
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
      source_version: 'v1',
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
