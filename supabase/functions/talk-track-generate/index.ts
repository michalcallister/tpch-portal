// ============================================================
// TPCH Portal — Talk Track Generator
// Supabase Edge Function: talk-track-generate
//
// Given a project_id (or stock_id), composes a client-ready
// paragraph the partner can paste into WhatsApp / email / SMS.
// Caches results in `talk_tracks` (lazy) keyed by (project_id, kind).
//
// POST /talk-track-generate
//   Body: { project_id?: string, stock_id?: string, kind?: "send_this" }
//   Returns: { paragraph, project_id, project_name, source: "cache"|"fresh" }
//
// Secrets:
//   CLAUDE_API_KEY            (Anthropic API key)
//   SUPABASE_URL              (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//
// NOTE: no `talk_tracks` table created in the Week-2 migration —
// we generate per-request and skip cache if the table is missing.
// Add `talk_tracks (id, project_id, kind, paragraph, generated_at)`
// when ready to enable caching.
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

const TALK_TRACK_SYSTEM_PROMPT = `You write client-ready paragraphs for TPCH's channel partners. The partner will paste your output verbatim into WhatsApp, email, or SMS to a retail investor client.

${TPCH_TONE_RULES}

ADDITIONAL RULES:
- Open with "Hi [Client]," — square-bracket placeholder so the partner replaces it.
- 50-100 words. One paragraph. No bullet points, no headings.
- Sounds like a busy-but-thoughtful adviser texting a quick update. Plain English.
- Ground every claim in supplied facts. Never invent a yield, vacancy rate, or price.
- If you have a number (e.g. lots remaining, price band), use it specifically. "Three lots remain at $850k+" beats "limited stock available".
- Close with a soft call-to-action: "happy to walk you through it" or "want me to put a hold on one?"
- No marketing slogans, no exclamation marks, no emoji.

OUTPUT — strict JSON:
{
  "paragraph": "Hi [Client], ..."
}`

// ── Cost tracking ────────────────────────────────────────────
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001':  { in: 1,  out: 5  },
  'claude-haiku-4-5':           { in: 1,  out: 5  },
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-sonnet-4-6-20251015': { in: 3,  out: 15 },
  'claude-opus-4-7':            { in: 15, out: 75 },
}

const AGENT_SLUG = 'talk-track-generate'

async function logAgentRun(opts: {
  model: string
  usage?: { input_tokens?: number; output_tokens?: number } | null
  status?: 'completed' | 'failed'
  startedAt: number
  triggeredBy?: string
  projectId?: string | null
  errorMessage?: string | null
}) {
  try {
    if (!opts.usage) return
    const inTok  = opts.usage.input_tokens  || 0
    const outTok = opts.usage.output_tokens || 0
    const price  = MODEL_PRICING[opts.model] || { in: 1, out: 5 }
    const cost   = Math.round(inTok * price.in + outTok * price.out)
    const { data: agent } = await sb.from('agents').select('id').eq('slug', AGENT_SLUG).single()
    if (!agent) return
    await sb.from('agent_runs').insert({
      agent_id:        agent.id,
      project_id:      opts.projectId || null,
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

async function callClaude(systemPrompt: string, userPrompt: string, projectId?: string | null): Promise<string> {
  const startedAt = Date.now()
  const model = 'claude-haiku-4-5-20251001'
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
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })
  } catch (e) {
    await logAgentRun({ model, startedAt, status: 'failed', projectId, errorMessage: (e as Error).message })
    throw e
  }
  if (!res.ok) {
    const errText = await res.text()
    await logAgentRun({ model, startedAt, status: 'failed', projectId, errorMessage: `Claude API ${res.status}: ${errText.slice(0, 200)}` })
    throw new Error(`Claude API ${res.status}: ${errText}`)
  }
  const data = await res.json()
  await logAgentRun({ model, startedAt, status: 'completed', projectId, usage: data.usage })

  const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed: any
  try { parsed = JSON.parse(cleaned) }
  catch { throw new Error(`Talk-track JSON parse failed. Raw: ${cleaned.slice(0, 200)}`) }
  if (!parsed?.paragraph || typeof parsed.paragraph !== 'string') {
    throw new Error('Talk-track output missing paragraph string')
  }
  return parsed.paragraph.trim()
}

async function gatherProjectContext(projectId: string) {
  const { data: project } = await sb
    .from('projects')
    .select('id, name, suburb, state, region, developer, development_type, property_type, total_volume, stock_to_sell, est_construction_finish, description')
    .eq('id', projectId)
    .single()
  if (!project) return null

  // Available stock for the project — for "X lots remain at $Y+"
  const { data: stock } = await sb
    .from('stock')
    .select('id, total_contract, bedrooms, annual_rent, smsf_eligible, availability')
    .eq('project_id', projectId)
    .eq('availability', 'Available')

  const available = stock || []
  const prices = available.map((s: any) => s.total_contract).filter(Boolean)
  const yields = available
    .filter((s: any) => s.annual_rent && s.total_contract)
    .map((s: any) => (s.annual_rent / s.total_contract) * 100)
  const minPrice = prices.length ? Math.min(...prices) : null
  const maxPrice = prices.length ? Math.max(...prices) : null
  const avgYield = yields.length ? yields.reduce((a: number, b: number) => a + b, 0) / yields.length : null
  const smsfCount = available.filter((s: any) => s.smsf_eligible).length

  // Latest published research for the suburb (if any) — for grounded market context
  let suburbResearch = null
  if (project.suburb) {
    const { data: sr } = await sb
      .from('suburb_research')
      .select('thesis_short, vacancy_rate, avg_yield, median_price, capital_growth_10yr')
      .eq('suburb', project.suburb)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
    suburbResearch = sr && sr[0] ? sr[0] : null
  }

  return {
    project,
    available_count: available.length,
    min_price: minPrice,
    max_price: maxPrice,
    avg_yield_pct: avgYield != null ? Math.round(avgYield * 10) / 10 : null,
    smsf_count: smsfCount,
    suburb_research: suburbResearch,
  }
}

function buildUserPrompt(ctx: any): string {
  const p = ctx.project
  const lines: string[] = []
  lines.push(`PROJECT: ${p.name}`)
  if (p.suburb || p.state) lines.push(`Location: ${[p.suburb, p.state].filter(Boolean).join(', ')}`)
  if (p.developer) lines.push(`Developer: ${p.developer}`)
  if (p.development_type) lines.push(`Type: ${p.development_type}`)
  if (p.est_construction_finish) lines.push(`Estimated completion: ${p.est_construction_finish}`)
  if (ctx.available_count != null) lines.push(`Available lots: ${ctx.available_count}`)
  if (ctx.min_price != null && ctx.max_price != null) {
    lines.push(`Price range: $${Math.round(ctx.min_price).toLocaleString('en-AU')} - $${Math.round(ctx.max_price).toLocaleString('en-AU')}`)
  } else if (ctx.min_price != null) {
    lines.push(`From $${Math.round(ctx.min_price).toLocaleString('en-AU')}`)
  }
  if (ctx.avg_yield_pct != null) lines.push(`Average gross yield: ${ctx.avg_yield_pct}%`)
  if (ctx.smsf_count > 0) lines.push(`SMSF-eligible lots: ${ctx.smsf_count}`)

  if (ctx.suburb_research) {
    const sr = ctx.suburb_research
    lines.push('')
    lines.push('SUBURB RESEARCH (published TPCH report):')
    if (sr.vacancy_rate != null)        lines.push(`- Vacancy: ${sr.vacancy_rate}%`)
    if (sr.median_price != null)        lines.push(`- Median price: $${Math.round(sr.median_price).toLocaleString('en-AU')}`)
    if (sr.avg_yield != null)           lines.push(`- Average yield: ${sr.avg_yield}%`)
    if (sr.capital_growth_10yr != null) lines.push(`- 10-year growth: ${sr.capital_growth_10yr}% p.a.`)
    if (sr.thesis_short)                lines.push(`- Thesis: ${sr.thesis_short}`)
  }

  lines.push('')
  lines.push('Write the client-ready paragraph now per the JSON schema.')
  return lines.join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    if (!CLAUDE_API_KEY) {
      return new Response(JSON.stringify({ error: 'CLAUDE_API_KEY not set' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const body = await req.json().catch(() => ({}))
    let projectId: string | null = body?.project_id ? String(body.project_id) : null

    // If only a stock_id was given, derive project_id from the stock row.
    if (!projectId && body?.stock_id) {
      const { data: s } = await sb
        .from('stock')
        .select('project_id')
        .eq('id', String(body.stock_id))
        .single()
      projectId = s?.project_id || null
    }
    if (!projectId) {
      return new Response(JSON.stringify({ error: 'project_id (or stock_id with a project) required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const ctx = await gatherProjectContext(projectId)
    if (!ctx) {
      return new Response(JSON.stringify({ error: 'project not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const paragraph = await callClaude(TALK_TRACK_SYSTEM_PROMPT, buildUserPrompt(ctx), projectId)

    return new Response(
      JSON.stringify({
        project_id: projectId,
        project_name: ctx.project.name,
        paragraph,
        source: 'fresh',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('talk-track-generate error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
