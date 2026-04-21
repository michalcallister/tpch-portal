// ============================================================
// TPCH Portal — Upload Analysis (Option B handshake)
// Supabase Edge Function: upload-analysis
//
// Accepts an Investment Analyst JSON produced locally by the
// .claude/skills/investment-analyst skill (Opus 4.7 in a Claude
// Code session) and writes it to project_analysis as a draft for
// admin review. Same review gate as portal-produced runs.
//
// Secrets required:
//   CLAUDE_API_KEY                (inherited, not used here)
//   UPLOAD_SECRET                 shared secret, required in the
//                                 x-tpch-upload-secret header
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected)
//
// POST /upload-analysis
//   Headers:
//     apikey: <anon>
//     Authorization: Bearer <anon>
//     x-tpch-upload-secret: <UPLOAD_SECRET>
//     Content-Type: application/json
//   Body:
//     {
//       "project_id": "3355563132",
//       "model_used": "claude-opus-4-7",
//       "triggered_by": "mick@local-skill",
//       "analysis": { ...full JSON matching output-schema.json... }
//     }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

// ── Validation helpers ───────────────────────────────────
const EM_DASH = '\u2014'
const BANNED_JARGON = [
  'institutional-grade',
  'institutional specification',
  'institutional quality',
  'blue-chip',
  'investment-grade',
  'premium offering',
  'world-class',
  'once-in-a-generation',
  'unmissable',
]

function ratingForScore(score: number): string {
  if (score >= 80) return 'Strong Buy'
  if (score >= 60) return 'Good Buy'
  if (score >= 40) return 'Moderate'
  return 'Caution'
}

// Returns null if OK, or an error message string if validation fails.
function validateAnalysis(a: any): string | null {
  if (!a || typeof a !== 'object') return 'analysis must be an object'

  const requiredTop = [
    'overall_score', 'overall_rating', 'thesis_text',
    'population_score', 'population_score_reasoning', 'population_headline', 'population_stats', 'population_narrative',
    'economic_score', 'economic_score_reasoning', 'economic_headline', 'economic_stats', 'economic_narrative',
    'supply_score', 'supply_score_reasoning', 'supply_headline', 'supply_stats', 'supply_narrative',
    'affordability_score', 'affordability_score_reasoning', 'affordability_headline', 'affordability_stats', 'affordability_narrative',
    'scarcity_score', 'scarcity_score_reasoning', 'scarcity_headline', 'scarcity_stats', 'scarcity_narrative',
    'developer_name', 'track_record', 'project_stage', 'warranties', 'memberships', 'tpch_assessment',
  ]
  for (const k of requiredTop) {
    if (a[k] === undefined || a[k] === null) return `missing required field: ${k}`
  }

  // Pillar score ranges
  const pillars = ['population_score', 'economic_score', 'supply_score', 'affordability_score', 'scarcity_score']
  for (const p of pillars) {
    const v = a[p]
    if (!Number.isInteger(v) || v < 0 || v > 20) return `${p} must be an integer 0-20, got ${v}`
  }

  const sum =
    a.population_score + a.economic_score + a.supply_score +
    a.affordability_score + a.scarcity_score
  if (a.overall_score !== sum) {
    return `overall_score (${a.overall_score}) does not equal sum of five pillars (${sum})`
  }

  const expectedRating = ratingForScore(a.overall_score)
  if (a.overall_rating !== expectedRating) {
    return `overall_rating '${a.overall_rating}' does not match band for score ${a.overall_score} (expected '${expectedRating}')`
  }

  // Scan all string values for brand violations
  const stringKeys = Object.keys(a).filter(k => typeof a[k] === 'string')
  const jsonBlob = JSON.stringify(a)
  if (jsonBlob.includes(EM_DASH)) {
    return 'em-dash character detected in payload; remove all em-dashes before uploading'
  }
  if (/<\/?cite[^>]*>/i.test(jsonBlob)) {
    return 'XML <cite> tags detected in payload; use inline (Source: …) citations only'
  }
  for (const word of BANNED_JARGON) {
    if (jsonBlob.toLowerCase().includes(word.toLowerCase())) {
      return `banned jargon detected: '${word}'. Describe the feature in plain English instead.`
    }
  }

  // Scarcity narrative must name at least two comparables with individual $/sqm figures.
  // The stat (scarcity_stats.replacement_cost_sqm) is a short one-line verdict; the evidence
  // lives in the narrative so the stat box stays legible.
  const scarcityNarrative = String(a.scarcity_narrative || '')
  const sqmMatches = scarcityNarrative.match(/\$\s*[\d,]+\s*\/?\s*sqm/gi) || []
  if (sqmMatches.length < 2) {
    return 'scarcity_narrative must name at least two comparables with individual $/sqm figures'
  }

  // T&G non-null check (use 'Data unavailable' not empty)
  for (const k of ['warranties', 'memberships']) {
    if (typeof a[k] !== 'string' || a[k].trim().length === 0) {
      return `${k} must be a non-empty string (use 'Data unavailable' if unknown)`
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
    const { project_id, model_used, triggered_by, analysis } = body || {}

    if (!project_id || typeof project_id !== 'string') {
      return new Response(JSON.stringify({ error: 'project_id (string) is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!analysis || typeof analysis !== 'object') {
      return new Response(JSON.stringify({ error: 'analysis (object) is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3) Project must exist
    const { data: project, error: projErr } = await sb
      .from('projects')
      .select('id, name, suburb, state')
      .eq('id', project_id)
      .single()
    if (projErr || !project) {
      return new Response(JSON.stringify({ error: `Project not found: ${project_id}` }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 4) Validate the analysis payload
    const validationError = validateAnalysis(analysis)
    if (validationError) {
      return new Response(JSON.stringify({ error: `Validation failed: ${validationError}` }), {
        status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 5) Look up the investment-analysis agent (for agent_id FK on agent_runs)
    const { data: agent, error: agentErr } = await sb
      .from('agents')
      .select('id')
      .eq('slug', 'investment-analysis')
      .single()
    if (agentErr || !agent) {
      return new Response(JSON.stringify({ error: 'investment-analysis agent row not found in agents table' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 6) Create an agent_runs row marked as a local-skill upload
    const now = new Date().toISOString()
    const { data: run, error: runErr } = await sb.from('agent_runs').insert({
      agent_id: agent.id,
      project_id,
      status: 'completed',
      triggered_by: triggered_by || 'mick@local-skill',
      started_at: now,
      completed_at: now,
      duration_ms: 0,
      logs: [
        { ts: now, message: `Local-skill upload via upload-analysis (model: ${model_used || 'claude-opus-4-7'})` },
        { ts: now, message: `Project: ${project.name} | ${project.suburb}, ${project.state}` },
        { ts: now, message: `Score: ${analysis.overall_score}/100 — ${analysis.overall_rating}` },
      ],
    }).select().single()

    if (runErr || !run) {
      return new Response(JSON.stringify({ error: `Failed to create run row: ${runErr?.message}` }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 7) Insert the analysis as a draft
    const { data: inserted, error: insertErr } = await sb.from('project_analysis').insert({
      project_id,
      agent_run_id: run.id,
      overall_score: analysis.overall_score,
      overall_rating: analysis.overall_rating,
      thesis_text: analysis.thesis_text,
      population_score: analysis.population_score,
      population_score_reasoning: analysis.population_score_reasoning,
      population_headline: analysis.population_headline,
      population_stats: analysis.population_stats,
      population_narrative: analysis.population_narrative,
      economic_score: analysis.economic_score,
      economic_score_reasoning: analysis.economic_score_reasoning,
      economic_headline: analysis.economic_headline,
      economic_stats: analysis.economic_stats,
      economic_narrative: analysis.economic_narrative,
      supply_score: analysis.supply_score,
      supply_score_reasoning: analysis.supply_score_reasoning,
      supply_headline: analysis.supply_headline,
      supply_stats: analysis.supply_stats,
      supply_narrative: analysis.supply_narrative,
      affordability_score: analysis.affordability_score,
      affordability_score_reasoning: analysis.affordability_score_reasoning,
      affordability_headline: analysis.affordability_headline,
      affordability_stats: analysis.affordability_stats,
      affordability_narrative: analysis.affordability_narrative,
      scarcity_score: analysis.scarcity_score,
      scarcity_score_reasoning: analysis.scarcity_score_reasoning,
      scarcity_headline: analysis.scarcity_headline,
      scarcity_stats: analysis.scarcity_stats,
      scarcity_narrative: analysis.scarcity_narrative,
      developer_name: analysis.developer_name,
      developer_detail: analysis.developer_detail,
      track_record: analysis.track_record,
      track_record_detail: analysis.track_record_detail,
      project_stage: analysis.project_stage,
      project_stage_detail: analysis.project_stage_detail,
      warranties: analysis.warranties,
      memberships: analysis.memberships,
      tpch_assessment: analysis.tpch_assessment,
      status: 'draft',
    }).select('id').single()

    if (insertErr || !inserted) {
      return new Response(JSON.stringify({ error: `Failed to store analysis: ${insertErr?.message}`, run_id: run.id }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({
      success: true,
      run_id: run.id,
      analysis_id: inserted.id,
      project_id,
      project_name: project.name,
      score: analysis.overall_score,
      rating: analysis.overall_rating,
      status: 'draft',
      portal_url: `https://portal.tpch.com.au/?project=${project_id}&tab=analysis`,
    }), {
      status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
