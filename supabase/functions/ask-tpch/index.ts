// ============================================================
// TPCH Portal — Ask TPCH (concierge natural-language search)
// Supabase Edge Function: ask-tpch
//
// Translates a partner's free-text query into structured filters
// against the live stock + suburb_research tables, returns a
// curated shortlist + a 1-2 sentence framing summary.
//
// POST /ask-tpch
//   Body: { query: string }
//   Returns: { summary: string, results: [{ kind, id, ...display }] }
//
// Secrets:
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

const STATES = ['VIC','NSW','QLD','WA','SA','TAS','NT','ACT'] as const

// ── Intent extraction prompt ─────────────────────────────────
// Strict JSON output. Filters mirror columns on `stock` so the server
// can apply them directly without further translation.
const INTENT_SYSTEM_PROMPT = `You are TPCH's query interpreter. Convert the partner's free-text question into structured filters against the live stock catalogue.

${TPCH_TONE_RULES}

OUTPUT — strict JSON only, no preamble, no markdown fences:
{
  "filters": {
    "state":           string | null,        // one of VIC|NSW|QLD|WA|SA|TAS|NT|ACT
    "suburb_keywords": string[],              // suburb name fragments to match (case-insensitive contains)
    "price_min":       number | null,
    "price_max":       number | null,
    "bedrooms_min":    number | null,
    "bedrooms_max":    number | null,
    "smsf_only":       boolean,               // true if query mentions SMSF / super
    "available_only":  boolean,               // default true unless query explicitly asks for sold/all
    "development_type":string | null,         // e.g. "Apartment" | "House and Land" | null
    "wants_research":  boolean,               // true if the question is about market/suburb intelligence rather than stock
    "yield_min_pct":   number | null
  },
  "framing": string                           // 1-2 sentence framing of what you're looking for. Plain English. No marketing fluff.
}

Rules:
- "under $X" → price_max = X. "above $X" → price_min = X. "around $X" → both ±10%.
- "X bed" / "X-bedroom" → bedrooms_min = X, bedrooms_max = X.
- "X+ bed" → bedrooms_min = X.
- If state is ambiguous (e.g. "Sydney"), set state = "NSW" inferred from the city.
- If the query is asking about a suburb's outlook ("how is Southbank looking", "Brisbane SE Corridor research"), set wants_research = true.
- If you cannot extract any meaningful filter, return all-null filters with available_only = true and a framing that says you'll show the most recently-added available stock.
- "depreciation upside" → no specific filter (it's mostly a function of new builds, which are most of the catalogue anyway). Note in framing only.
- "good yield" / "high yield" → yield_min_pct = 5.0 unless a number was given.
- Keep framing under 200 characters.`

// ── Cost tracking ────────────────────────────────────────────
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001':  { in: 1,  out: 5  },
  'claude-haiku-4-5':           { in: 1,  out: 5  },
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-sonnet-4-6-20251015': { in: 3,  out: 15 },
  'claude-opus-4-7':            { in: 15, out: 75 },
}

const AGENT_SLUG = 'ask-tpch'

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
    const price  = MODEL_PRICING[opts.model] || { in: 1, out: 5 }
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

// ── Run Claude (Haiku — this is a hot, latency-sensitive path) ─
async function extractIntent(query: string): Promise<any> {
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
        max_tokens: 800,
        system: INTENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }],
      }),
    })
  } catch (e) {
    await logAgentRun({ model, startedAt, status: 'failed', errorMessage: (e as Error).message })
    throw e
  }
  if (!res.ok) {
    const errText = await res.text()
    await logAgentRun({ model, startedAt, status: 'failed', errorMessage: `Claude API ${res.status}: ${errText.slice(0, 200)}` })
    throw new Error(`Claude API ${res.status}: ${errText}`)
  }
  const data = await res.json()
  await logAgentRun({ model, startedAt, status: 'completed', usage: data.usage })

  const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`Intent JSON parse failed: ${(e as Error).message}. Raw: ${cleaned.slice(0, 300)}`)
  }
}

// ── Apply filters → stock catalogue ──────────────────────────
async function searchStock(filters: any): Promise<any[]> {
  let q = sb
    .from('stock')
    .select(`
      id, name, project_id, project_name,
      availability, suburb, state,
      bedrooms, bathrooms, car_parks,
      total_contract, rent_per_week, annual_rent,
      smsf_eligible, development_type, property_type,
      build_total_sqm, build_internal_sqm
    `)
    .limit(40)

  const av = filters?.available_only !== false
  if (av) q = q.eq('availability', 'Available')

  if (filters?.state && STATES.includes(String(filters.state).toUpperCase() as any)) {
    q = q.eq('state', String(filters.state).toUpperCase())
  }
  if (Array.isArray(filters?.suburb_keywords) && filters.suburb_keywords.length) {
    // Build OR over ilike against suburb + project_name + name.
    const ors: string[] = []
    for (const kw of filters.suburb_keywords.slice(0, 5)) {
      const k = String(kw).replace(/[(),]/g, '').trim()
      if (!k) continue
      ors.push(`suburb.ilike.%${k}%,project_name.ilike.%${k}%,name.ilike.%${k}%`)
    }
    if (ors.length) q = q.or(ors.join(','))
  }
  if (typeof filters?.price_min === 'number') q = q.gte('total_contract', filters.price_min)
  if (typeof filters?.price_max === 'number') q = q.lte('total_contract', filters.price_max)
  if (typeof filters?.bedrooms_min === 'number') q = q.gte('bedrooms', filters.bedrooms_min)
  if (typeof filters?.bedrooms_max === 'number') q = q.lte('bedrooms', filters.bedrooms_max)
  if (filters?.smsf_only === true) q = q.eq('smsf_eligible', true)
  if (filters?.development_type) q = q.ilike('development_type', `%${String(filters.development_type)}%`)

  const { data, error } = await q
  if (error) {
    console.warn('searchStock error:', error.message)
    return []
  }

  let rows = data || []
  // Yield filter applied client-side (annual_rent / total_contract)
  if (typeof filters?.yield_min_pct === 'number' && filters.yield_min_pct > 0) {
    rows = rows.filter((s: any) => {
      if (!s.total_contract || !s.annual_rent) return false
      const y = (s.annual_rent / s.total_contract) * 100
      return y >= filters.yield_min_pct
    })
  }

  // Rank: prefer SMSF if requested, then lowest price, then highest yield.
  rows.sort((a: any, b: any) => {
    const ay = a.annual_rent && a.total_contract ? a.annual_rent / a.total_contract : 0
    const by = b.annual_rent && b.total_contract ? b.annual_rent / b.total_contract : 0
    if (filters?.smsf_only && (a.smsf_eligible !== b.smsf_eligible)) return a.smsf_eligible ? -1 : 1
    if ((a.total_contract || 1e15) !== (b.total_contract || 1e15)) return (a.total_contract || 1e15) - (b.total_contract || 1e15)
    return by - ay
  })
  return rows.slice(0, 6)
}

async function searchResearch(filters: any): Promise<any[]> {
  let q = sb
    .from('suburb_research')
    .select('id, slug, suburb, state_code, thesis_short, rating, vacancy_rate, avg_yield, median_price')
    .eq('status', 'published')
    .limit(20)

  if (filters?.state) {
    q = q.eq('state_code', String(filters.state).toUpperCase())
  }
  if (Array.isArray(filters?.suburb_keywords) && filters.suburb_keywords.length) {
    const ors = filters.suburb_keywords.slice(0, 3)
      .map((kw: string) => String(kw).replace(/[(),]/g, '').trim())
      .filter(Boolean)
      .map((k: string) => `suburb.ilike.%${k}%`)
      .join(',')
    if (ors) q = q.or(ors)
  }

  const { data, error } = await q
  if (error) { console.warn('searchResearch error:', error.message); return [] }
  return (data || []).slice(0, 4)
}

// ── Format results for client ────────────────────────────────
function formatStock(s: any): any {
  return {
    kind: 'stock',
    id: s.id,
    project_id: s.project_id,
    name: s.name,
    project_name: s.project_name,
    location: [s.suburb, s.state].filter(Boolean).join(', '),
    bedrooms: s.bedrooms,
    bathrooms: s.bathrooms,
    car_parks: s.car_parks,
    sqm: s.build_total_sqm || s.build_internal_sqm,
    price: s.total_contract,
    yield_pct: s.annual_rent && s.total_contract
      ? Math.round((s.annual_rent / s.total_contract) * 1000) / 10
      : null,
    smsf_eligible: !!s.smsf_eligible,
    development_type: s.development_type,
    availability: s.availability,
  }
}

function formatResearch(r: any): any {
  return {
    kind: 'research',
    id: r.id,
    slug: r.slug,
    suburb: r.suburb,
    state: r.state_code,
    rating: r.rating,
    thesis_short: r.thesis_short,
    vacancy_rate: r.vacancy_rate,
    avg_yield: r.avg_yield,
    median_price: r.median_price,
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

    const body = await req.json().catch(() => ({}))
    const query = String(body?.query || '').trim()
    if (!query) {
      return new Response(JSON.stringify({ error: 'query is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (query.length > 500) {
      return new Response(JSON.stringify({ error: 'query too long (max 500 chars)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const intent = await extractIntent(query)
    const filters = intent?.filters || {}
    const framing = String(intent?.framing || '').slice(0, 280)

    // Run stock + (optional) research in parallel
    const [stockRows, researchRows] = await Promise.all([
      searchStock(filters),
      filters?.wants_research ? searchResearch(filters) : Promise.resolve([]),
    ])

    const results = [
      ...researchRows.map(formatResearch),
      ...stockRows.map(formatStock),
    ]

    let summary = framing
    if (!results.length) {
      summary = framing
        ? framing + ' No matching stock in the live catalogue right now.'
        : 'No matching stock in the live catalogue right now.'
    } else if (!framing) {
      summary = `${results.length} match${results.length === 1 ? '' : 'es'} for your query.`
    }

    return new Response(
      JSON.stringify({
        query,
        summary,
        filters_used: filters,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('ask-tpch error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
