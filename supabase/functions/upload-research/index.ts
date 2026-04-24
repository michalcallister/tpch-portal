// ============================================================
// TPCH Portal — Upload Suburb Research (Option B handshake)
// Supabase Edge Function: upload-research
//
// Accepts a Suburb Research JSON produced locally by the
// .claude/skills/suburb-research skill (Opus 4.7 in a Claude
// Code session) and writes it to suburb_research as a draft for
// admin review. Same review gate as the Investment Analyst flow.
//
// Secrets required:
//   UPLOAD_SECRET                 shared secret, required in the
//                                 x-tpch-upload-secret header
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected)
//
// POST /upload-research
//   Headers:
//     apikey: <anon>
//     Authorization: Bearer <anon>
//     x-tpch-upload-secret: <UPLOAD_SECRET>
//     Content-Type: application/json
//   Body:
//     {
//       "model_used": "claude-opus-4-7",
//       "triggered_by": "mick@local-skill",
//       "research": { ...full JSON matching the prompt.ts schema... }
//     }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Mirror of SCHEMA_VERSION in ./prompt.ts. Kept inline so this function
// can deploy as a single file; keep in sync with prompt.ts on any bump.
const SCHEMA_VERSION = '2.2.0'

const UPLOAD_SECRET = Deno.env.get('UPLOAD_SECRET') || ''
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// ── CORS ─────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-tpch-upload-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Constants ────────────────────────────────────────────
const EM_DASH = '—'
const BANNED_JARGON = [
  'institutional-grade',
  'institutional grade',
  'institutional-quality',
  'institutional quality',
  'blue-chip',
  'investment-grade',
  'premium offering',
  'world-class',
  'once-in-a-generation',
  'unmissable',
]

const VALID_STATES = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'NT', 'TAS', 'ACT']

const PILLARS = [
  'demographics', 'migration', 'employment', 'supply_pipeline',
  'vacancy_trend', 'price_growth', 'rent_trend', 'affordability',
  'infrastructure', 'risk_register', 'endorsements', 'counter_view',
]

const DIMENSIONS = [
  'demographic_tailwind', 'supply_pressure', 'capital_growth_outlook',
  'income_yield_quality', 'infra_liveability',
]

// ── Helpers ──────────────────────────────────────────────
function ratingForScore(score: number): string {
  if (score >= 80) return 'Strong Buy'
  if (score >= 60) return 'Good Buy'
  if (score >= 40) return 'Watch'
  return 'Caution'
}

function slugify(s: string): string {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isHttpsUrl(s: any): boolean {
  if (typeof s !== 'string') return false
  try {
    const u = new URL(s)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

function isIsoDate(s: any): boolean {
  if (typeof s !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(s)
  return !isNaN(t)
}

function withinTwelveMonths(s: string): boolean {
  const t = Date.parse(s)
  if (isNaN(t)) return false
  const now = Date.now()
  const twelveMonthsMs = 365 * 24 * 60 * 60 * 1000
  return (now - t) <= twelveMonthsMs && t <= now + 24 * 60 * 60 * 1000
}

// Returns null if OK, or an error message string if validation fails.
function validateResearch(r: any): string | null {
  if (!r || typeof r !== 'object') return 'research must be an object'

  // Schema version
  if (r.schema_version !== SCHEMA_VERSION) {
    return `schema_version mismatch: got '${r.schema_version}', expected '${SCHEMA_VERSION}'`
  }

  // Identity
  if (typeof r.suburb !== 'string' || r.suburb.trim().length === 0) {
    return 'suburb (string) is required'
  }
  if (!VALID_STATES.includes(r.state_code)) {
    return `state_code must be one of ${VALID_STATES.join(', ')}`
  }
  if (typeof r.thesis_short !== 'string' || r.thesis_short.trim().length === 0) {
    return 'thesis_short is required'
  }
  if (r.thesis_short.length > 140) {
    return `thesis_short must be 140 chars or less, got ${r.thesis_short.length}`
  }
  if (typeof r.thesis_main !== 'string' || r.thesis_main.trim().length < 1200) {
    return `thesis_main is required (rich Executive Summary, 3-4 paragraphs, min 1200 chars). Got ${typeof r.thesis_main === 'string' ? r.thesis_main.trim().length + ' chars' : 'non-string'}.`
  }
  if (typeof r.narrative_thesis !== 'string' || r.narrative_thesis.trim().length < 1500) {
    return `narrative_thesis is required (long-form Plain English Story, six-part framework, min 1500 chars). Got ${typeof r.narrative_thesis === 'string' ? r.narrative_thesis.trim().length + ' chars' : 'non-string'}.`
  }

  // Dimensions
  if (!r.dimensions || typeof r.dimensions !== 'object') {
    return 'dimensions object is required'
  }
  let dimSum = 0
  for (const d of DIMENSIONS) {
    const dim = r.dimensions[d]
    if (!dim || typeof dim !== 'object') return `dimensions.${d} is required`
    if (!Number.isInteger(dim.score) || dim.score < 0 || dim.score > 20) {
      return `dimensions.${d}.score must be an integer 0-20, got ${dim.score}`
    }
    if (typeof dim.score_reasoning !== 'string' || dim.score_reasoning.trim().length < 30) {
      return `dimensions.${d}.score_reasoning must be a substantive string (2-3 sentences)`
    }
    dimSum += dim.score
  }

  // Conviction score = sum of dimensions
  if (!Number.isInteger(r.conviction_score) || r.conviction_score < 0 || r.conviction_score > 100) {
    return `conviction_score must be an integer 0-100, got ${r.conviction_score}`
  }
  if (r.conviction_score !== dimSum) {
    return `conviction_score (${r.conviction_score}) does not equal sum of 5 dimensions (${dimSum})`
  }

  // Rating band
  const expectedRating = ratingForScore(r.conviction_score)
  if (r.rating !== expectedRating) {
    return `rating '${r.rating}' does not match band for score ${r.conviction_score} (expected '${expectedRating}')`
  }

  // Pillars
  if (!r.pillars || typeof r.pillars !== 'object') {
    return 'pillars object is required'
  }
  for (const key of PILLARS) {
    const p = r.pillars[key]
    if (!p || typeof p !== 'object') {
      return `pillars.${key} is required`
    }
    if (p.status !== 'ok') {
      return `pillars.${key}.status must be 'ok' (all 12 pillars are mandatory)`
    }
    if (typeof p.headline !== 'string' || p.headline.trim().length === 0) {
      return `pillars.${key}.headline is required`
    }
    if (typeof p.narrative !== 'string' || p.narrative.trim().length < 50) {
      return `pillars.${key}.narrative must be a substantive string`
    }
  }

  // Endorsements: ≥3, valid URLs, within 12 months
  if (!Array.isArray(r.endorsements) || r.endorsements.length < 3) {
    return `endorsements must be an array with at least 3 items, got ${Array.isArray(r.endorsements) ? r.endorsements.length : 'non-array'}`
  }
  for (let i = 0; i < r.endorsements.length; i++) {
    const e = r.endorsements[i]
    const required = ['source', 'headline', 'date', 'url', 'excerpt', 'supports_pillar']
    for (const k of required) {
      if (typeof e?.[k] !== 'string' || e[k].trim().length === 0) {
        return `endorsements[${i}].${k} is required (string)`
      }
    }
    if (!isIsoDate(e.date)) {
      return `endorsements[${i}].date must be ISO YYYY-MM-DD, got '${e.date}'`
    }
    if (!withinTwelveMonths(e.date)) {
      return `endorsements[${i}].date must be within 12 months of today, got '${e.date}'`
    }
    if (!isHttpsUrl(e.url)) {
      return `endorsements[${i}].url must be a full https:// URL, got '${e.url}'`
    }
  }

  // Counter view: exactly 1, with response
  const cv = r.counter_view
  if (!cv || typeof cv !== 'object') {
    return 'counter_view object is required (exactly 1 bear-case article + response)'
  }
  for (const k of ['source', 'headline', 'date', 'url', 'excerpt', 'response']) {
    if (typeof cv[k] !== 'string' || cv[k].trim().length === 0) {
      return `counter_view.${k} is required (string)`
    }
  }
  if (!isIsoDate(cv.date)) {
    return `counter_view.date must be ISO YYYY-MM-DD, got '${cv.date}'`
  }
  if (!isHttpsUrl(cv.url)) {
    return `counter_view.url must be a full https:// URL`
  }
  if (cv.response.trim().length < 30) {
    return 'counter_view.response must be a substantive 1-2 sentence response (not a dismissal)'
  }

  // Sources: master citation list
  if (!Array.isArray(r.sources) || r.sources.length === 0) {
    return 'sources must be a non-empty array (master citation list)'
  }
  const sourceTags = new Set<string>()
  for (let i = 0; i < r.sources.length; i++) {
    const s = r.sources[i]
    for (const k of ['tag', 'publisher', 'title', 'url']) {
      if (typeof s?.[k] !== 'string' || s[k].trim().length === 0) {
        return `sources[${i}].${k} is required`
      }
    }
    if (!isHttpsUrl(s.url)) {
      return `sources[${i}].url must be a full https:// URL`
    }
    sourceTags.add(s.tag)
  }

  // Brand-violation scan over the entire payload
  const jsonBlob = JSON.stringify(r)
  if (jsonBlob.includes(EM_DASH)) {
    return 'em-dash character (—) detected in payload; remove all em-dashes before uploading'
  }
  if (/<\/?cite[^>]*>/i.test(jsonBlob)) {
    return 'XML <cite> tags detected in payload; use inline (Source: ...) citations only'
  }
  const lowerBlob = jsonBlob.toLowerCase()
  for (const word of BANNED_JARGON) {
    if (lowerBlob.includes(word.toLowerCase())) {
      return `banned jargon detected: '${word}'. Describe the feature in plain English instead.`
    }
  }

  return null
}

// ── Main handler ─────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Only POST is supported' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    // 1) Shared-secret check
    const providedSecret = req.headers.get('x-tpch-upload-secret') || ''
    if (!UPLOAD_SECRET) {
      return new Response(JSON.stringify({ error: 'UPLOAD_SECRET not configured on server' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (providedSecret !== UPLOAD_SECRET) {
      return new Response(JSON.stringify({ error: 'Invalid or missing x-tpch-upload-secret header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 2) Parse body
    const body = await req.json()
    const { model_used, triggered_by, research } = body || {}

    if (!research || typeof research !== 'object') {
      return new Response(JSON.stringify({ error: 'research (object) is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3) Validate the research payload
    const validationError = validateResearch(research)
    if (validationError) {
      return new Response(JSON.stringify({ error: `Validation failed: ${validationError}` }), {
        status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 4) Confirm parent state_research row exists (FK)
    const { data: stateRow, error: stateErr } = await sb
      .from('state_research')
      .select('state_code')
      .eq('state_code', research.state_code)
      .single()
    if (stateErr || !stateRow) {
      return new Response(JSON.stringify({
        error: `state_research row missing for '${research.state_code}'. Seed it before uploading suburb research.`,
      }), {
        status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 5) Look up the suburb-research agent (for agent_id FK on agent_runs)
    const { data: agent, error: agentErr } = await sb
      .from('agents')
      .select('id')
      .eq('slug', 'suburb-research')
      .single()
    if (agentErr || !agent) {
      return new Response(JSON.stringify({ error: 'suburb-research agent row not found in agents table' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 6) Compute slug = '<suburb>-<state>' (lowercased, hyphenated)
    const slug = `${slugify(research.suburb)}-${research.state_code.toLowerCase()}`

    // 7) Create an agent_runs row marked as a local-skill upload
    const now = new Date().toISOString()
    const { data: run, error: runErr } = await sb.from('agent_runs').insert({
      agent_id: agent.id,
      project_id: null,
      status: 'completed',
      triggered_by: triggered_by || 'mick@local-skill',
      started_at: now,
      completed_at: now,
      duration_ms: 0,
      logs: [
        { ts: now, message: `Local-skill upload via upload-research (model: ${model_used || 'claude-opus-4-7'})` },
        { ts: now, message: `Suburb: ${research.suburb}, ${research.state_code} (slug: ${slug})` },
        { ts: now, message: `Conviction: ${research.conviction_score}/100 — ${research.rating}` },
      ],
    }).select().single()

    if (runErr || !run) {
      return new Response(JSON.stringify({ error: `Failed to create run row: ${runErr?.message}` }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 8) Build hero metrics row from the research payload
    const hero = research.hero_metrics || {}

    // 9) Upsert into suburb_research as a draft (slug is unique key)
    const insertPayload: Record<string, any> = {
      slug,
      suburb: research.suburb,
      region: research.region ?? null,
      state_code: research.state_code,
      lga: research.lga ?? null,
      postcode: research.postcode ?? null,
      map_lat: research.map_lat ?? null,
      map_lng: research.map_lng ?? null,

      // Hero metrics
      rating: research.rating,
      conviction_score: research.conviction_score,
      median_price: hero.median_price ?? null,
      avg_yield: hero.avg_yield ?? null,
      vacancy_rate: hero.vacancy_rate ?? null,
      capital_growth_10yr: hero.capital_growth_10yr ?? null,
      weekly_rent: hero.weekly_rent ?? null,
      population: hero.population ?? null,
      pop_growth_pct: hero.pop_growth_pct ?? null,

      // Executive summary
      thesis_short: research.thesis_short,
      thesis_main: research.thesis_main,
      narrative_thesis: research.narrative_thesis,

      // Structured payloads
      pillars: research.pillars,
      dimensions: research.dimensions,
      endorsements: research.endorsements,
      counter_view: research.counter_view,
      comparable_sales: research.comparable_sales ?? [],
      sources: research.sources,

      // Workflow
      status: 'draft',
      ai_generated: true,
      model_used: model_used || 'claude-opus-4-7',
      triggered_by: triggered_by || 'mick@local-skill',
    }

    const { data: inserted, error: insertErr } = await sb
      .from('suburb_research')
      .upsert(insertPayload, { onConflict: 'slug' })
      .select('*')
      .single()

    if (insertErr || !inserted) {
      return new Response(JSON.stringify({
        error: `Failed to store research: ${insertErr?.message}`,
        run_id: run.id,
      }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 10) Append to research_versions so the admin can diff/revert.
    //     Uses max(version_number)+1 for this research_id to avoid race-worry.
    const { data: lastVersion } = await sb
      .from('research_versions')
      .select('id, version_number')
      .eq('research_id', inserted.id)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nextVersionNumber = (lastVersion?.version_number ?? 0) + 1
    const changeSummary = lastVersion
      ? `upload-research upsert (v${nextVersionNumber}) · ${triggered_by || 'mick@local-skill'}`
      : `upload-research initial draft (v1) · ${triggered_by || 'mick@local-skill'}`

    await sb.from('research_versions').insert({
      research_id: inserted.id,
      version_number: nextVersionNumber,
      snapshot: inserted,
      section_key: null,
      parent_version_id: lastVersion?.id ?? null,
      change_summary: changeSummary,
      created_by: triggered_by || 'upload-research',
    })

    return new Response(JSON.stringify({
      success: true,
      run_id: run.id,
      research_id: inserted.id,
      version_number: nextVersionNumber,
      slug: inserted.slug,
      suburb: research.suburb,
      state_code: research.state_code,
      conviction_score: research.conviction_score,
      rating: research.rating,
      status: 'draft',
      portal_url: `https://portal.tpch.com.au/?research=${inserted.slug}`,
    }), {
      status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
