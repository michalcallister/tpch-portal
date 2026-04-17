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
      'anthropic-version': '2023-06-01',
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
async function runInvestmentAnalysis(projectId: string, runId: string, testMode?: boolean) {
  // Fetch project details
  const { data: project, error: projErr } = await sb
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()
  if (projErr || !project) throw new Error(`Project not found: ${projectId}`)

  // Fetch stock with rich detail for project-level analysis
  const { data: stock } = await sb
    .from('stock')
    .select('total_contract, rent_per_week, lot_size_sqm, build_total_sqm, build_internal_sqm, availability, development_type, property_type, bedrooms, bathrooms, car_parks, land_price, build_price, rate_per_sqm, level, annual_rent, smsf_eligible')
    .eq('project_id', projectId)

  const availableStock = stock?.filter((s: any) => s.availability === 'Available') || []
  const allStock = stock || []

  // Price analysis
  const prices = availableStock.map((s: any) => s.total_contract).filter(Boolean)
  const rents = availableStock.map((s: any) => s.rent_per_week).filter(Boolean)
  const avgPrice = prices.length ? Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length) : null
  const minPrice = prices.length ? Math.min(...prices) : null
  const maxPrice = prices.length ? Math.max(...prices) : null
  const avgRent = rents.length ? Math.round(rents.reduce((a: number, b: number) => a + b, 0) / rents.length) : null
  const minRent = rents.length ? Math.min(...rents) : null
  const maxRent = rents.length ? Math.max(...rents) : null

  // Size analysis
  const buildSizes = availableStock.map((s: any) => s.build_total_sqm).filter(Boolean)
  const lotSizes = availableStock.map((s: any) => s.lot_size_sqm).filter(Boolean)
  const avgBuildSqm = buildSizes.length ? Math.round(buildSizes.reduce((a: number, b: number) => a + b, 0) / buildSizes.length) : null
  const avgLotSqm = lotSizes.length ? Math.round(lotSizes.reduce((a: number, b: number) => a + b, 0) / lotSizes.length) : null
  const ratesPerSqm = availableStock.map((s: any) => s.rate_per_sqm).filter(Boolean)
  const avgRatePerSqm = ratesPerSqm.length ? Math.round(ratesPerSqm.reduce((a: number, b: number) => a + b, 0) / ratesPerSqm.length) : null

  // Yield calculation
  const grossYield = avgPrice && avgRent ? ((avgRent * 52) / avgPrice * 100).toFixed(2) : null

  // Bedroom mix
  const bedroomCounts: Record<string, number> = {}
  availableStock.forEach((s: any) => {
    const key = s.bedrooms ? `${s.bedrooms}bed` : 'unknown'
    bedroomCounts[key] = (bedroomCounts[key] || 0) + 1
  })
  const bedroomMix = Object.entries(bedroomCounts).map(([k, v]) => `${v}x ${k}`).join(', ')

  // Property types
  const propertyTypes = [...new Set(availableStock.map((s: any) => s.property_type).filter(Boolean))].join(', ')
  const devTypes = [...new Set(allStock.map((s: any) => s.development_type).filter(Boolean))].join(', ')

  // Land vs build split
  const landPrices = availableStock.map((s: any) => s.land_price).filter(Boolean)
  const buildPrices = availableStock.map((s: any) => s.build_price).filter(Boolean)
  const avgLandPrice = landPrices.length ? Math.round(landPrices.reduce((a: number, b: number) => a + b, 0) / landPrices.length) : null
  const avgBuildPrice = buildPrices.length ? Math.round(buildPrices.reduce((a: number, b: number) => a + b, 0) / buildPrices.length) : null

  // SMSF
  const smsfCount = availableStock.filter((s: any) => s.smsf_eligible).length

  await addLog(runId, `Project: ${project.name} | ${project.suburb}, ${project.state}`)
  await addLog(runId, `Stock: ${allStock.length} total, ${availableStock.length} available`)
  if (avgPrice) await addLog(runId, `Avg price: $${avgPrice.toLocaleString()} | Avg rent: $${avgRent}/wk | Yield: ${grossYield}%`)

  const systemPrompt = `You are an expert Australian property investment analyst working for The Property Clearing House (TPCH), a channel partner distribution platform for residential property developers.

Your job is to analyse a SPECIFIC PROPERTY DEVELOPMENT PROJECT and score it on 5 investment fundamentals. This is NOT a suburb report — it is a project investment assessment. Use suburb/market data as CONTEXT, but every insight must relate back to THIS project, its stock, its pricing, and its competitive position.

You have access to web search — USE IT to find current, real data for context. Do not rely on training data alone.

CRITICAL APPROACH — PROJECT-CENTRIC ANALYSIS:
For each pillar, you must:
1. Research the suburb/market data (via web search) for context
2. Analyse how THIS PROJECT specifically benefits or is exposed, using the actual stock data provided
3. Explain your reasoning for the score — what specific factors pushed it up or down

PILLAR GUIDANCE:
- POPULATION: How does population growth in this area translate to demand for THIS project's stock? Consider the project's target buyer/renter profile based on bedroom mix, pricing, and property type.
- ECONOMIC: What local economic drivers support demand for THIS project? How do employment hubs, infrastructure, and income levels align with the project's price point?
- SUPPLY & DEMAND: Analyse THIS project's competitive position — how does its pricing, size, and features compare to other available stock in the area? What is the vacancy rate context, and what does that mean for rental demand at THIS project's rent levels?
- AFFORDABILITY: Use the ACTUAL stock prices provided to assess value. Compare this project's $/sqm, gross yield, and price point against suburb medians and comparable new developments. Is this project priced competitively or at a premium?
- SCARCITY & INTRINSIC VALUE: Two parts to this pillar:
  (a) SCARCITY: What makes THIS project scarce or differentiated? Consider: its specific features, location advantages, views, the development type, lot sizes, and how many comparable competing projects exist nearby.
  (b) INTRINSIC VALUE (Replacement Cost Analysis): This answers: "What would it cost to build this EXACT product today from scratch?" If the buyer is paying LESS than replacement cost, that's strong intrinsic value. If MORE, they're paying a premium.

  STEP 1 — Research the TOTAL replacement cost per sqm for a NEW, COMPARABLE product:
  - Search for what NEW apartments/houses/townhouses (matching THIS project's type) are currently SELLING for per sqm in this suburb or comparable nearby suburbs. Search terms: "new [apartment/house] price per sqm [suburb] [city] [year]", "new development [suburb] price per square metre", "off-the-plan [apartment/house] [city] sqm rate".
  - This is the REPLACEMENT COST — what a buyer would pay for an equivalent NEW product today. It includes land, construction, developer margin, everything.
  - Sources to search: Domain, REA, CoreLogic, Urban Developer, property development listings.
  - You MUST match the property type: apartment replacement costs are completely different from house & land. High-rise inner-city apartments have very different $/sqm to suburban townhouses.

  STEP 2 — Compare:
  - THIS project's $/sqm (provided in stock data) vs the new comparable $/sqm you found
  - If project $/sqm < new comparable $/sqm: BELOW replacement cost = strong intrinsic value (buying cheaper than building new today)
  - If project $/sqm > new comparable $/sqm: ABOVE replacement cost = premium pricing
  - SANITY CHECK: Your replacement cost figure should be in a similar order of magnitude to the project's $/sqm. If the project is $12,000/sqm and your replacement figure is $3,000/sqm, you have the WRONG property type or data — re-search.

  Cite the specific source, date, and comparable development for your replacement cost figure.

SCORE REASONING: For each pillar, the "score_reasoning" field is MANDATORY. It must explain in 2-3 sentences:
- WHY you gave that specific score number (not just restate the headline)
- What specific data points or project characteristics pushed the score up or down
- What would need to change for the score to be higher or lower
Example: "Scored 14/20 because population growth of 3.2% pa is well above the national average, and the project's 2-bed mix aligns with the young professional demographic driving migration. Would score higher if growth were forecast to accelerate, but recent infrastructure approvals suggest sustained rather than accelerating demand."

SOURCING — THIS IS CRITICAL:
- Every statistic, data point, or factual claim in the narrative MUST have an inline source citation
- Format: "(Source: [Publisher], [Date/Period])" e.g. "(Source: SQM Research, March 2026)" or "(Source: ABS Census 2021)" or "(Source: Domain, Q1 2026)"
- Search for CURRENT data — use web search for every factual claim
- If you cannot find a current figure via search, explicitly state "Data unavailable" rather than using training data or guessing
- An unsourced statistic is worse than no statistic — the admin reviewing this MUST be able to verify every number

Return your response as a single valid JSON object with NO markdown formatting, NO code fences, and NO text outside the JSON. The response must start with { and end with }.

JSON schema:
{
  "overall_score": <int 0-100>,
  "overall_rating": "<Strong Buy|Good Buy|Moderate|Caution>",
  "thesis_text": "<2-3 sentence investment thesis focused on THIS project's merits and risks>",

  "population_score": <int 0-20>,
  "population_score_reasoning": "<2-3 sentences: why this score? what would make it higher/lower?>",
  "population_headline": "<one line about what population trends mean for THIS project>",
  "population_stats": {"5yr_growth": "<value>", "forecast_10yr": "<value>", "migration_trend": "<value>"},
  "population_narrative": "<2-3 paragraphs: suburb population data as context, then how it specifically impacts demand for this project's stock>",

  "economic_score": <int 0-20>,
  "economic_score_reasoning": "<2-3 sentences: why this score?>",
  "economic_headline": "<one line about economic drivers relevant to THIS project>",
  "economic_stats": {"employment_growth": "<value>", "major_employers": "<value>", "infrastructure_spend": "<value>"},
  "economic_narrative": "<2-3 paragraphs: local economy context, then how it supports demand at this project's price point and location>",

  "supply_score": <int 0-20>,
  "supply_score_reasoning": "<2-3 sentences: why this score?>",
  "supply_headline": "<one line about supply/demand dynamics for THIS project>",
  "supply_stats": {"vacancy_rate": "<value>", "days_on_market": "<value>", "new_supply_12mo": "<value>"},
  "supply_narrative": "<2-3 paragraphs: market supply context, then THIS project's competitive position — pricing vs comparable stock, absorption risk, rental demand at these rent levels>",

  "affordability_score": <int 0-20>,
  "affordability_score_reasoning": "<2-3 sentences: why this score?>",
  "affordability_headline": "<one line about THIS project's value proposition>",
  "affordability_stats": {"price_to_income": "<value>", "median_suburb_price": "<value>", "project_avg_price": "<value>", "gross_yield": "<value>", "price_per_sqm": "<value>"},
  "affordability_narrative": "<2-3 paragraphs: USE the actual stock prices to compare against suburb medians and comparable developments. Discuss gross yield, $/sqm value, and price positioning>",

  "scarcity_score": <int 0-20>,
  "scarcity_score_reasoning": "<2-3 sentences: why this score?>",
  "scarcity_headline": "<one line about scarcity and intrinsic value for THIS project>",
  "scarcity_stats": {"competing_projects": "<value>", "differentiation": "<value>", "replacement_cost_sqm": "<current build cost $/sqm from search>", "project_rate_sqm": "<this project's $/sqm>", "intrinsic_value": "<Below/At/Above replacement cost>"},
  "scarcity_narrative": "<2-3 paragraphs: (1) Competing projects and differentiation — what makes this project unique or generic? (2) INTRINSIC VALUE — research current construction costs per sqm for this property type in this area, compare to this project's $/sqm, and explain whether buyers are getting below-replacement-cost value or paying a premium. Cite the source of construction cost data.>",

  "developer_name": "<developer name>",
  "developer_detail": "<brief background with source>",
  "track_record": "<summary of completed projects>",
  "track_record_detail": "<detail with source>",
  "project_stage": "<current stage>",
  "project_stage_detail": "<timeline detail>",
  "warranties": "<known warranties or Data unavailable>",
  "memberships": "<industry memberships or Data unavailable>",
  "tpch_assessment": "<TPCH assessment: synthesise all pillars into a clear recommendation for channel partners, referencing this project's specific strengths and risks>"
}

Scoring guide:
- 16-20 per pillar (80-100 overall): Strong Buy — exceptional fundamentals, project is well-positioned
- 12-15 per pillar (60-79 overall): Good Buy — strong with minor risks or average positioning
- 8-11 per pillar (40-59 overall): Moderate — mixed fundamentals or some concerns about project fit
- 0-7 per pillar (0-39 overall): Caution — significant headwinds or poor project positioning

The overall_score MUST equal the sum of the 5 pillar scores.
Be honest and rigorous. Channel partners make real investment decisions based on this analysis.`

  const userPrompt = `Analyse and score this specific Australian property development project:

PROJECT: ${project.name}
DEVELOPER: ${project.developer || 'Unknown'}
SUBURB: ${project.suburb || 'Unknown'}
STATE: ${project.state || 'Unknown'}
TYPE: ${project.development_type || 'Unknown'}
PROJECT STATUS: ${project.project_status || 'Unknown'}
SALES STATUS: ${project.sales_status || 'Unknown'}
LEVELS: ${project.levels || 'Unknown'}
YEAR CONSTRUCTED: ${project.year_constructed || 'Unknown'}

PROJECT SCALE:
- Total units/lots in the development: ${project.total_volume || 'Unknown'}

TPCH AVAILABLE STOCK (units we have available to sell through our channel — NOT the total building inventory):
- Listed with TPCH: ${allStock.length}
- Currently available to sell: ${availableStock.length}
- Development type: ${devTypes || 'Mixed'}
- Property types: ${propertyTypes || 'Mixed'}
- Bedroom mix of available stock: ${bedroomMix || 'Unknown'}

PRICING:
- Price range: ${minPrice && maxPrice ? '$' + minPrice.toLocaleString() + ' – $' + maxPrice.toLocaleString() : 'Unknown'}
- Average total contract: ${avgPrice ? '$' + avgPrice.toLocaleString() : 'Unknown'}
- Average land price: ${avgLandPrice ? '$' + avgLandPrice.toLocaleString() : 'N/A'}
- Average build price: ${avgBuildPrice ? '$' + avgBuildPrice.toLocaleString() : 'N/A'}
- Average rate per sqm: ${avgRatePerSqm ? '$' + avgRatePerSqm.toLocaleString() + '/sqm' : 'Unknown'}

SIZES:
- Average build size: ${avgBuildSqm ? avgBuildSqm + ' sqm' : 'Unknown'}
- Average lot size: ${avgLotSqm ? avgLotSqm + ' sqm' : 'Unknown'}

RENTAL & YIELD:
- Rent range: ${minRent && maxRent ? '$' + minRent + ' – $' + maxRent + '/wk' : 'Unknown'}
- Average rent: ${avgRent ? '$' + avgRent + '/wk' : 'Unknown'}
- Estimated gross yield: ${grossYield ? grossYield + '%' : 'Unknown'}

OTHER:
- SMSF eligible stock: ${smsfCount} of ${availableStock.length} available

IMPORTANT: Use the stock data above as the foundation of your analysis. When assessing affordability, use these actual prices and yields — don't just talk about the suburb in general. When assessing scarcity, consider what makes this specific project and its stock unique compared to other developments in the area. Every pillar score must include reasoning that references this project specifically.

Return ONLY the JSON object, no other text.`

  const model = testMode ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-20250514'
  await addLog(runId, `Calling Claude API (${testMode ? 'TEST — Haiku' : 'Sonnet'}) with web search enabled...`)

  const raw = await callClaude(systemPrompt, userPrompt, model)

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
    population_score_reasoning: result.population_score_reasoning,
    population_headline: result.population_headline,
    population_stats: result.population_stats,
    population_narrative: result.population_narrative,
    economic_score: result.economic_score,
    economic_score_reasoning: result.economic_score_reasoning,
    economic_headline: result.economic_headline,
    economic_stats: result.economic_stats,
    economic_narrative: result.economic_narrative,
    supply_score: result.supply_score,
    supply_score_reasoning: result.supply_score_reasoning,
    supply_headline: result.supply_headline,
    supply_stats: result.supply_stats,
    supply_narrative: result.supply_narrative,
    affordability_score: result.affordability_score,
    affordability_score_reasoning: result.affordability_score_reasoning,
    affordability_headline: result.affordability_headline,
    affordability_stats: result.affordability_stats,
    affordability_narrative: result.affordability_narrative,
    scarcity_score: result.scarcity_score,
    scarcity_score_reasoning: result.scarcity_score_reasoning,
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
    const { agent_slug, project_id, triggered_by, test_mode } = await req.json()

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
          result = await runInvestmentAnalysis(project_id, run.id, test_mode)
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
