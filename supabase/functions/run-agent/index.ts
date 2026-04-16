// ============================================================
// TPCH Portal — AI Agent Runner
// Supabase Edge Function: run-agent
//
// Secrets required:
//   CLAUDE_API_KEY           = Anthropic API key
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected)
//
// POST /run-agent
//   Body: { agent_slug: "investment-analysis", project_id: "...", triggered_by: "admin@..." }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLAUDE_API_KEY = Deno.env.get('CLAUDE_API_KEY')!
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// ── CORS ─────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Claude API call with web search ─────────────────────
async function callClaude(systemPrompt: string, userPrompt: string, model = 'claude-sonnet-4-20250514') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2025-03-26',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Claude API ${res.status}: ${err}`)
  }
  const data = await res.json()
  // Extract text blocks from the response (web search responses have mixed content types)
  const textBlocks = (data.content || []).filter((b: any) => b.type === 'text')
  return textBlocks.map((b: any) => b.text).join('\n') || ''
}

// ── Investment Analysis Agent ────────────────────────────
async function runInvestmentAnalysis(projectId: string, runId: string) {
  // Fetch project details
  const { data: project, error: projErr } = await sb
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()
  if (projErr || !project) throw new Error(`Project not found: ${projectId}`)

  // Fetch stock summary for context
  const { data: stock } = await sb
    .from('stock')
    .select('total_contract, rent_per_week, lot_size_sqm, build_total_sqm, availability, development_type')
    .eq('project_id', projectId)

  const availableStock = stock?.filter((s: any) => s.availability === 'Available') || []
  const prices = availableStock.map((s: any) => s.total_contract).filter(Boolean)
  const rents = availableStock.map((s: any) => s.rent_per_week).filter(Boolean)
  const avgPrice = prices.length ? Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length) : null
  const avgRent = rents.length ? Math.round(rents.reduce((a: number, b: number) => a + b, 0) / rents.length) : null

  await addLog(runId, `Project: ${project.name} | ${project.suburb}, ${project.state}`)
  await addLog(runId, `Stock: ${stock?.length || 0} total, ${availableStock.length} available`)
  if (avgPrice) await addLog(runId, `Avg price: $${avgPrice.toLocaleString()} | Avg rent: $${avgRent}/wk`)

  const systemPrompt = `You are an expert Australian property investment analyst working for The Property Clearing House (TPCH), a channel partner distribution platform for residential property developers.

Your job is to research and score a specific property development project on 5 investment fundamentals. You have access to web search — USE IT to find current, real data. Do not rely on memory or training data alone.

RESEARCH REQUIREMENTS:
- Search for current vacancy rates from SQM Research or Domain for the specific suburb
- Search for recent ABS census/population data for the area
- Search for median property prices from CoreLogic, Domain or REA
- Search for the developer by name to verify their track record
- Search for infrastructure projects and economic developments in the region
- Every statistic you cite MUST come from a web search result. If you cannot find a current figure, say "Data unavailable" rather than guessing.

SOURCING: In each narrative paragraph, cite your sources inline, e.g. "(Source: SQM Research, Jan 2026)" or "(Source: ABS Census 2021)". This is critical — the admin reviewing this needs to verify the data.

After completing your research, return your response as a single valid JSON object with NO markdown formatting, NO code fences, and NO explanation text outside the JSON. The response must start with { and end with }.

The JSON schema:
{
  "overall_score": <int 0-100>,
  "overall_rating": "<Strong Buy|Good Buy|Moderate|Caution>",
  "thesis_text": "<2-3 sentence investment thesis>",

  "population_score": <int 0-20>,
  "population_headline": "<one line summary>",
  "population_stats": {"5yr_growth": "<value>", "forecast_10yr": "<value>", "migration_trend": "<value>"},
  "population_narrative": "<2-3 paragraph analysis with inline source citations>",

  "economic_score": <int 0-20>,
  "economic_headline": "<one line summary>",
  "economic_stats": {"employment_growth": "<value>", "major_employers": "<value>", "infrastructure_spend": "<value>"},
  "economic_narrative": "<2-3 paragraph analysis with inline source citations>",

  "supply_score": <int 0-20>,
  "supply_headline": "<one line summary>",
  "supply_stats": {"vacancy_rate": "<value>", "days_on_market": "<value>", "new_supply_12mo": "<value>"},
  "supply_narrative": "<2-3 paragraph analysis with inline source citations>",

  "affordability_score": <int 0-20>,
  "affordability_headline": "<one line summary>",
  "affordability_stats": {"price_to_income": "<value>", "median_suburb_price": "<value>", "vs_metro_median": "<value>"},
  "affordability_narrative": "<2-3 paragraph analysis with inline source citations>",

  "scarcity_score": <int 0-20>,
  "scarcity_headline": "<one line summary>",
  "scarcity_stats": {"land_availability": "<value>", "zoning_constraints": "<value>", "competing_supply": "<value>"},
  "scarcity_narrative": "<2-3 paragraph analysis with inline source citations>",

  "developer_name": "<developer name>",
  "developer_detail": "<brief background with source>",
  "track_record": "<summary of completed projects>",
  "track_record_detail": "<detail with source>",
  "project_stage": "<current stage>",
  "project_stage_detail": "<timeline detail>",
  "warranties": "<known warranties or Data unavailable>",
  "memberships": "<industry memberships or Data unavailable>",
  "tpch_assessment": "<TPCH assessment summary based on the research>"
}

Scoring guide:
- 80-100 overall (16-20 per pillar): Strong Buy — exceptional fundamentals
- 60-79 overall (12-15 per pillar): Good Buy — strong with minor risks
- 40-59 overall (8-11 per pillar): Moderate — mixed fundamentals
- 0-39 overall (0-7 per pillar): Caution — significant headwinds

The overall_score should equal the sum of the 5 pillar scores.
Be honest and rigorous. Channel partners make investment decisions based on this analysis.`

  const userPrompt = `Research and score this Australian property development project:

PROJECT: ${project.name}
DEVELOPER: ${project.developer || 'Unknown'}
SUBURB: ${project.suburb || 'Unknown'}
STATE: ${project.state || 'Unknown'}
TYPE: ${project.development_type || 'Unknown'}
STATUS: ${project.status || 'Unknown'}
DESCRIPTION: ${project.description || 'N/A'}

STOCK DATA:
- Total lots/units: ${stock?.length || 'Unknown'}
- Available: ${availableStock.length}
- Average price: ${avgPrice ? '$' + avgPrice.toLocaleString() : 'Unknown'}
- Average rent: ${avgRent ? '$' + avgRent + '/wk' : 'Unknown'}
- Development type: ${[...new Set(stock?.map((s: any) => s.development_type).filter(Boolean))].join(', ') || 'Mixed'}

Please research this location and project thoroughly. Consider:
1. ABS census data for population growth in ${project.suburb || 'the area'}, ${project.state || 'Australia'}
2. Local employment and economic drivers
3. Current rental vacancy rates and days on market
4. Price positioning relative to the broader ${project.state || 'state'} market
5. Land supply constraints and zoning in the area
6. The developer's track record and reputation

Return ONLY the JSON object, no other text.`

  await addLog(runId, 'Calling Claude API with web search enabled (up to 10 searches)...')

  const raw = await callClaude(systemPrompt, userPrompt)

  await addLog(runId, `Claude response received (${raw.length} chars)`)

  // Parse — extract JSON from response (web search may add text around it)
  let result: any
  try {
    // Try direct parse first
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
    try {
      result = JSON.parse(cleaned)
    } catch {
      // Extract the JSON object from surrounding text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON object found in response')
      result = JSON.parse(jsonMatch[0])
    }
  } catch (e) {
    await addLog(runId, `JSON parse error: ${(e as Error).message}`)
    await addLog(runId, `Raw response (first 500 chars): ${raw.slice(0, 500)}`)
    throw new Error('Failed to parse Claude response as JSON')
  }

  await addLog(runId, `Score: ${result.overall_score}/100 — ${result.overall_rating}`)

  // Store the analysis
  const { error: insertErr } = await sb.from('project_analysis').insert({
    project_id: projectId,
    agent_run_id: runId,
    overall_score: result.overall_score,
    overall_rating: result.overall_rating,
    thesis_text: result.thesis_text,
    population_score: result.population_score,
    population_headline: result.population_headline,
    population_stats: result.population_stats,
    population_narrative: result.population_narrative,
    economic_score: result.economic_score,
    economic_headline: result.economic_headline,
    economic_stats: result.economic_stats,
    economic_narrative: result.economic_narrative,
    supply_score: result.supply_score,
    supply_headline: result.supply_headline,
    supply_stats: result.supply_stats,
    supply_narrative: result.supply_narrative,
    affordability_score: result.affordability_score,
    affordability_headline: result.affordability_headline,
    affordability_stats: result.affordability_stats,
    affordability_narrative: result.affordability_narrative,
    scarcity_score: result.scarcity_score,
    scarcity_headline: result.scarcity_headline,
    scarcity_stats: result.scarcity_stats,
    scarcity_narrative: result.scarcity_narrative,
    developer_name: result.developer_name,
    developer_detail: result.developer_detail,
    track_record: result.track_record,
    track_record_detail: result.track_record_detail,
    project_stage: result.project_stage,
    project_stage_detail: result.project_stage_detail,
    warranties: result.warranties,
    memberships: result.memberships,
    tpch_assessment: result.tpch_assessment,
    status: 'draft',
  })

  if (insertErr) throw new Error(`Failed to store analysis: ${insertErr.message}`)
  await addLog(runId, 'Analysis stored as draft — awaiting admin review')

  return result
}

// ── Helpers ──────────────────────────────────────────────
async function addLog(runId: string, message: string) {
  const { data } = await sb.from('agent_runs').select('logs').eq('id', runId).single()
  const logs = data?.logs || []
  logs.push({ ts: new Date().toISOString(), message })
  await sb.from('agent_runs').update({ logs }).eq('id', runId)
}

// ── Main handler ─────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { agent_slug, project_id, triggered_by } = await req.json()

    if (!agent_slug || !project_id) {
      return new Response(JSON.stringify({ error: 'agent_slug and project_id are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Look up the agent
    const { data: agent, error: agentErr } = await sb
      .from('agents')
      .select('*')
      .eq('slug', agent_slug)
      .eq('status', 'active')
      .single()

    if (agentErr || !agent) {
      return new Response(JSON.stringify({ error: `Agent not found or disabled: ${agent_slug}` }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Create a run record
    const { data: run, error: runErr } = await sb.from('agent_runs').insert({
      agent_id: agent.id,
      project_id,
      status: 'running',
      triggered_by: triggered_by || 'admin',
      started_at: new Date().toISOString(),
    }).select().single()

    if (runErr || !run) throw new Error(`Failed to create run: ${runErr?.message}`)

    const startTime = Date.now()

    try {
      // Route to the correct agent
      let result: any
      switch (agent_slug) {
        case 'investment-analysis':
          result = await runInvestmentAnalysis(project_id, run.id)
          break
        default:
          throw new Error(`Agent '${agent_slug}' is not yet implemented`)
      }

      // Mark run as completed
      const duration = Date.now() - startTime
      await sb.from('agent_runs').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: duration,
      }).eq('id', run.id)

      await addLog(run.id, `Completed in ${(duration / 1000).toFixed(1)}s`)

      return new Response(JSON.stringify({ success: true, run_id: run.id, result }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })

    } catch (agentError) {
      // Mark run as failed
      await sb.from('agent_runs').update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        error: (agentError as Error).message,
      }).eq('id', run.id)

      await addLog(run.id, `FAILED: ${(agentError as Error).message}`)

      return new Response(JSON.stringify({ error: (agentError as Error).message, run_id: run.id }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
