---
name: investment-analyst
description: Produce a TPCH channel-partner Investment Analysis for a specific residential development project. Use when the user says "run investment analyst on [project]", "generate investment analysis for [project]", "analyse [project] for TPCH", or anything equivalent. Mirrors the logic of the portal's run-agent edge function so output is consistent whether the analysis is produced from the portal (Opus 4.7 via Supabase) or generated locally in a conversation.
---

# Investment Analyst — TPCH Channel Partner Methodology

## Purpose

Produce a project-level investment analysis for a specific Australian residential development, written FOR TPCH's channel partners (property marketers and buyers' agents) to arm them with the fundamentals and selling angles to present that project to their investor clients.

This is **not** a suburb report and **not** an investor-facing research pack. It is the marketer's briefing document.

## When to invoke this skill

- User asks to "run investment analysis on [project name]"
- User asks to "analyse [project] for TPCH" or "what would the Investment Analyst produce for [project]"
- User is iterating on the edge-function prompt and wants to dry-run the output locally before deploying
- User wants a second-opinion or offline run without consuming the Anthropic API budget

## Inputs required

Before producing output, confirm (or fetch from the portal DB) at minimum:

1. **Project metadata**: name, developer, suburb, state, development type, project status, sales status, levels, year constructed, total volume.
2. **Available stock breakdown** (from `stock` table WHERE `project_id = '<id>'`):
   - Price range, average total contract (broken out by bedroom count)
   - Average rent per week (broken out by bedroom count)
   - Average build total sqm and rate per sqm (broken out by bedroom count)
   - SMSF-eligible count
   - Bedroom/bathroom/car-park mix
3. **Availability status split**: Available vs In Contract vs Reserved vs Settled vs EOI Submitted.

If pulling from Supabase, the project is `oreklvbzwgbufbkvvzny` and both `id` (projects) and `project_id` (stock) are text — cast or quote the id in SQL.

## Output structure

Produce a single cohesive analysis with these sections in order. Two output modes:

- **JSON mode** (for the portal / edge function): return the JSON schema defined in `supabase/functions/run-agent/index.ts`. No code fences, no prose outside the JSON.
- **Presentation mode** (for live conversations with Mick): render the portal layout as Markdown — overall score, five pillar sections each with a 3-box stat strip + narrative + score reasoning, trust & governance, TPCH assessment, sources.

The five pillars are fixed: **Population · Economic · Supply & Demand · Affordability · Scarcity & Intrinsic Value**. Each scored 0–20, summing to an overall score /100.

## Tone & voice — hard rules

1. **Australian English throughout.** `-ise` endings, "centre", "metre", "programme", "labour", "favour". Never American spellings.
2. **Confident, institutional, precise.** The voice of an established investment research house.
3. **No exclamation marks. No hype language.** No "incredible", "amazing", "unmissable", "world-class", "once-in-a-generation".
4. **Never use em dashes (—) anywhere.** Not in narrative, stats, headlines, score reasoning, or TPCH assessment. Use full stops, commas, semicolons, or round brackets. This is a non-negotiable TPCH brand rule.
5. **Avoid jargon unless defined.** Banned unless you also describe what specifically makes the product that: *institutional-grade*, *institutional specification*, *institutional quality*, *prime*, *blue-chip*, *investment-grade*, *premium offering*, *boutique*, *exclusive*. Prefer plain-English descriptors that name the actual feature ("designed by [architect], built by [builder], with onsite [amenities]").
6. **State findings as sourced facts, not opinions.** Avoid "it seems" / "probably". Either you have data, or you say the data is unavailable.

## Constructive framing

TPCH only lists projects it has already assessed as worth selling. The analyst's role is **not** to decide whether the project should be sold — it is to give channel partners the strongest honest case for doing so.

- **Lead each narrative with genuine strengths** before addressing risks.
- **Contextualise weaknesses** rather than amplify them ("vacancy of 2.1% sits marginally above the 2.0% healthy benchmark, but remains well below the 3.0% oversupply threshold that typically pressures rents").
- **Always surface a legitimate selling angle** in the TPCH assessment.
- **Scores stay data-driven.** Never inflate a score to cross a band boundary. An 11/20 is 11/20. Channel partners calibrate against scores; an inflated score that later proves wrong destroys trust in every future analysis. The narrative is where you lead constructively, not the numbers.

## Pillar guidance — the rules the edge function enforces

### 1. Population (0–20)

How does population growth in this area translate to demand for THIS project's stock, given its bedroom mix, price point, and target buyer/renter profile?

**Data currency rule (mandatory):** Prefer ABS Estimated Resident Population (ERP) over 2021 Census. The latest ERP release (cat. 3218.0 Regional Population) is typically within 12–18 months of current date and published at SA2 level. Use Census only for breakdowns ERP doesn't publish (age, income, household composition, country of birth). **Always state the ERP vintage explicitly**, e.g. "ERP at 30 June 2024 (Source: ABS cat. 3218.0, released March 2025)".

For forecasts, use matching-vintage state projections (VIF, WA Tomorrow, NSW Dept of Planning, QGSO) and .id forecast data rebased to the latest ERP.

### 2. Economic (0–20)

Local economic drivers supporting demand at THIS project's price point: employment hubs, infrastructure, income levels, major project pipeline.

### 3. Supply & Demand (0–20)

**Scoring lens (mandatory):** Score the project's supply exposure relative to its DIRECT competitive set and target buyer, NOT headline pipeline volume. Distinguish:

- **DIRECT competition:** stock competing for the same buyer at the same time — completed vs completed, OTP vs OTP in the same settlement window, same bedroom config, same price bracket, same SMSF/non-SMSF eligibility.
- **INDIRECT pipeline:** future supply targeting a different buyer cohort or settlement window. OTP 2027–28 does not compete with a buyer wanting a tenanted asset today. House-and-land in an outer corridor does not compete with inner-city apartments.

Weight current market metrics (vacancy, DOM, absorption of comparable completed stock) more heavily than gross pipeline — pipeline is frequently delayed, cancelled, or repositioned.

A completed, differentiated project in a market with a headline-large pipeline can legitimately score 13–15 if that pipeline doesn't target its buyer. It should only score 8–10 if its own DIRECT competitors are also oversupplied now.

### 4. Affordability (0–20)

**Comparative pricing rule (mandatory):** All price and yield comparisons MUST be like-for-like. Match by bedroom count, property type, and build-size bracket. **Never** compare a mixed-bedroom project average against a mixed-suburb median — larger bedroom counts inflate the project average and distort the comparison.

Produce separate comparisons for each bedroom configuration present in the available stock:

> Project 2-bed stock averages $A at B sqm ($C/sqm); comparable new-build 2-beds in [suburb] average $D at E sqm ($F/sqm). Project 3-bed stock averages $G at H sqm ($I/sqm); comparable new-build 3-beds average $J at K sqm ($L/sqm).

### 5. Scarcity & Intrinsic Value (0–20)

**Two parts:**

**(a) Scarcity.** What makes THIS project scarce or differentiated? Specific features, location advantages, views, development type, lot sizes, how many comparable competing projects exist nearby.

**(b) Intrinsic value (replacement cost analysis).** "What would it cost to build this EXACT product today from scratch?" If the buyer is paying LESS than replacement cost, strong intrinsic value. If MORE, premium pricing.

**Method:**

1. Research total replacement cost per sqm for NEW, COMPARABLE product. Search "new [apartment/house] price per sqm [suburb] [city] [year]", "new development [suburb] price per square metre", "off-the-plan [apartment/house] [city] sqm rate".
2. This is REPLACEMENT COST — what a buyer would pay for an equivalent NEW product today (includes land, construction, developer margin).
3. Sources: Domain, REA, CoreLogic, Urban Developer, property development listings.
4. **Match the property type.** Apartment replacement costs are completely different from house & land. High-rise inner-city apartments have very different $/sqm to suburban townhouses.
5. **Sanity check:** the replacement cost figure should be the same order of magnitude as the project's $/sqm. If project is $12,000/sqm and your replacement figure is $3,000/sqm, you have wrong property type or data — re-search.

**Replacement cost sourcing rule (mandatory):** The new-build $/sqm benchmark MUST be anchored by **at least TWO specific currently-selling comparable new developments named individually**, with each one's actual $/sqm drawn from current sale listings or published price lists. A market-summary or aggregate figure alone is INSUFFICIENT.

Format example:

> Development A ([Name], [Developer], [Suburb]) selling at $X/sqm; Development B ([Name], [Developer], [Suburb]) at $Y/sqm (Sources: apartments.com.au listing accessed [date], Urban Developer pricing [date], REA new apartments [date]).

If only one genuinely comparable development is currently selling in the area, extend the search to nearest comparable suburbs and name those. State each comparable development and source explicitly in `scarcity_narrative`.

## Required sources (prefer primary over aggregators)

- **Population:** ABS ERP cat. 3218.0 (PRIMARY, SA2 level, latest annual), ABS cat. 3101.0 (state-level current ERP), .id (profile.id.com.au, forecast.id.com.au, rebased to latest ERP), state projections (VIF, WA Tomorrow, NSW Dept of Planning, QGSO), local council demographic profiles. 2021 Census only for breakdowns not in ERP.
- **Economic:** ABS Labour Force, ABS Regional Statistics, RDA reports, state infrastructure pipelines, Infrastructure Australia priority lists, major project announcements, local council economic development strategies.
- **Supply & Demand:** SQM Research (vacancy, stock on market, DOM, asking rents), CoreLogic market indices, Domain suburb reports, REA market data, Urban Developer pipelines.
- **Affordability:** CoreLogic median values, Domain House Price Report, REA suburb medians, ABS household income and housing data, ANZ/CoreLogic Housing Affordability Report.
- **Scarcity & Intrinsic Value:** Urban Developer, Domain new developments, REA off-the-plan listings, Rawlinsons Construction Cost Guide, CoreLogic Cordell Construction Cost Index, comparable new-build sale listings with $/sqm.

If a source is paywalled or unreachable, say so and use the most authoritative accessible alternative. An aggregator is acceptable only if it cites a primary source you can name.

## Sourcing rules

- **Every** statistic, data point, or factual claim in the narrative MUST have an inline source citation.
- Format: `(Source: [Publisher], [Date/Period])` e.g. `(Source: SQM Research, March 2026)` or `(Source: ABS Census 2021)`.
- Search for CURRENT data. Use web search for every factual claim.
- If a current figure can't be found via search, explicitly state "Data unavailable" rather than using training data or guessing.
- An unsourced statistic is worse than no statistic — the admin reviewing MUST be able to verify every number.

## Score reasoning (mandatory, every pillar)

Every pillar's `score_reasoning` field must explain in 2–3 sentences:

1. WHY this specific score number (not just restate the headline).
2. What data points or project characteristics pushed the score up or down.
3. What would need to change for the score to be higher or lower.

Example:

> Scored 14/20 because population growth of 3.2% pa is well above the national average, and the project's 2-bed mix aligns with the young professional demographic driving migration. Would score higher if growth were forecast to accelerate, but recent infrastructure approvals suggest sustained rather than accelerating demand.

## Scoring bands

- **16–20 per pillar (80–100 overall):** Strong Buy — exceptional fundamentals, project well-positioned.
- **12–15 per pillar (60–79 overall):** Good Buy — strong with minor risks or average positioning.
- **8–11 per pillar (40–59 overall):** Moderate — mixed fundamentals or some concerns about project fit.
- **0–7 per pillar (0–39 overall):** Caution — significant headwinds or poor project positioning.

The overall score MUST equal the sum of the 5 pillar scores.

## Stats boxes — 3 boxes per pillar, no more, no less

Each pillar renders a 3-stat strip. Locked keys:

| Pillar | Key 1 | Key 2 | Key 3 |
|---|---|---|---|
| Population | 5yr_growth | forecast_10yr | migration_trend |
| Economic | employment_growth | major_employers | infrastructure_spend |
| Supply & Demand | vacancy_rate | days_on_market | new_supply_12mo |
| Affordability | price_to_income | gross_yield | price_per_sqm |
| Scarcity & Intrinsic Value | differentiation | replacement_cost_sqm | intrinsic_value |

`replacement_cost_sqm` must carry named comparables, e.g. `"Dev A (Name, Suburb) $X/sqm; Dev B (Name, Suburb) $Y/sqm. Avg $avg/sqm (Sources: listing/report, accessed [date])"`.

`intrinsic_value` is one of `Below replacement cost` / `At replacement cost` / `Above replacement cost`.

## Trust & Governance (non-scored, always included)

- `developer_name` + `developer_detail` (with source)
- `track_record` + `track_record_detail` (with source)
- `project_stage` + `project_stage_detail`
- `warranties` (or "Data unavailable")
- `memberships` (or "Data unavailable")
- `tpch_assessment` — synthesis across all pillars, plain-English, with the specific reason a marketer would present this project to a client

## Workflow the skill should follow

1. Confirm project identity and pull project + stock data (or ask the user for it if not already loaded).
2. Compute the derived fields locally: price range, avg price by bedroom, avg rent by bedroom, avg $/sqm by bedroom, gross yield, bedroom mix, SMSF count, availability split.
3. Run 6–10 targeted web searches covering: ERP at SA2, suburb forecast, economic drivers and infrastructure, SQM/REA/Domain vacancy and rents, named new-build comparables with per-sqm figures, developer track record.
4. For the replacement cost comparable set, try to surface at least TWO named developments with both published price AND floor area. If floor areas aren't public, say so in the narrative and fall back to aggregate benchmarks with the limitation flagged. Do not make up per-sqm figures against assumed sqm.
5. Assemble the output in the requested mode (JSON or Presentation).
6. Show the user the draft in Presentation mode first and flag any research limitations honestly at the bottom (e.g. "ABS ERP SA2 figure 2024 vintage not surfaced via public search; relied on id.com.au 2023 figure as nearest available").
7. Run the ten-item pre-flight self-check (above). If anything fails, fix before offering to upload.
8. **Ask the user explicitly whether to upload the analysis to the portal.** Never upload silently. Exact wording to use: *"Would you like me to upload this analysis to the portal as a draft for admin review?"* If yes, proceed to the upload step. If no, stop.

## Uploading to the portal (Option B handshake)

The portal's `upload-analysis` edge function accepts a validated JSON payload and writes it to `project_analysis` with `status: 'draft'`. The draft appears in the admin view alongside any portal-produced runs and waits for review before it goes live.

**Endpoint:** `POST https://oreklvbzwgbufbkvvzny.supabase.co/functions/v1/upload-analysis`

**Required headers:**
- `apikey: <SUPABASE_ANON_KEY>` — the publishable key from the portal.
- `Authorization: Bearer <SUPABASE_ANON_KEY>` — same key.
- `x-tpch-upload-secret: <UPLOAD_SECRET>` — shared secret stored at `C:\Users\micha\Claude\tpch\tpch-portal\.claude\.upload-secret` (gitignored).
- `Content-Type: application/json`.

**Body:**

```json
{
  "project_id": "<project.id as string>",
  "model_used": "claude-opus-4-7",
  "triggered_by": "mick@local-skill",
  "analysis": { ...full JSON matching output-schema.json... }
}
```

**Server-side validation (the function will reject with 422 if any fails):**
- Five pillar scores integer 0–20.
- `overall_score` equals sum of five pillar scores.
- `overall_rating` matches the band.
- No em-dash character anywhere in the payload.
- No `<cite>` or similar XML tags.
- No banned jargon uncontextualised.
- `scarcity_stats.replacement_cost_sqm` names at least two comparables with `$X/sqm` figures each.
- `warranties` and `memberships` are non-empty strings (use `"Data unavailable"` if unknown).

**Successful response (201):**

```json
{
  "success": true,
  "run_id": "uuid",
  "analysis_id": "uuid",
  "project_id": "...",
  "project_name": "...",
  "score": 70,
  "rating": "Good Buy",
  "status": "draft",
  "portal_url": "https://portal.tpch.com.au/?project=...&tab=analysis"
}
```

**One-liner the skill can run to upload** (PowerShell on Mick's Windows box):

```powershell
$secret = Get-Content "C:\Users\micha\Claude\tpch\tpch-portal\.claude\.upload-secret" -Raw
$secret = $secret.Trim()
$anon = "<SUPABASE_ANON_KEY>"
$body = @{ project_id = "<id>"; model_used = "claude-opus-4-7"; triggered_by = "mick@local-skill"; analysis = $analysisObject } | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Post -Uri "https://oreklvbzwgbufbkvvzny.supabase.co/functions/v1/upload-analysis" -Headers @{ "apikey" = $anon; "Authorization" = "Bearer $anon"; "x-tpch-upload-secret" = $secret; "Content-Type" = "application/json" } -Body $body
```

The anon key is embedded in `index.html` as `SUPABASE_ANON_KEY`; read that constant rather than hardcoding.

**After upload, always:**
- Show the user the response (score, rating, portal_url).
- Remind the user the analysis is a draft and needs admin review before going live.

## Canonical files — do not duplicate, reference

To stop drift between the portal edge function and this local skill, the following files are the single source of truth:

| File | Role |
|---|---|
| `supabase/functions/run-agent/prompt.ts` | Canonical `SYSTEM_PROMPT` string. The edge function imports it directly. When producing output inside this skill, treat that file as the authoritative voice and rules. If it changes, update this SKILL.md in the same commit. |
| `.claude/skills/investment-analyst/reference-melbourne-square.md` | Gold-standard worked example. Opus 4.7 output on Melbourne Square, approved by Mick 20 April 2026. Re-read before producing any new analysis to calibrate tone, structure, stat-strip format, score-reasoning depth, sourcing density, and limitation-disclosure style. |
| `.claude/skills/investment-analyst/output-schema.json` | Strict JSON Schema for the portal payload. JSON-mode output MUST validate against this. Structural rules (score sum, rating band match, five-pillar presence, required T&G fields) are encoded here. |

## Pre-flight self-check (mandatory, before emitting output)

Work through this ten-item check against your draft. If any item fails, fix the draft before submitting — do not paper over it in the narrative.

1. **All five pillars present and keyed:** population, economic, supply_demand, affordability, scarcity.
2. **Score arithmetic:** `overall_score == population.score + economic.score + supply_demand.score + affordability.score + scarcity.score`.
3. **Rating matches band:** 80–100 Strong Buy · 60–79 Good Buy · 40–59 Moderate · 0–39 Caution.
4. **No em-dash character (U+2014) anywhere.** Not in narrative, headline, summary, score_reasoning, scarcity_narrative, or tpch_assessment. Search the draft for the exact character before submitting.
5. **No banned jargon undescribed:** `institutional-grade`, `institutional specification`, `institutional quality`, `prime`, `blue-chip`, `investment-grade`, `premium offering`, `boutique`, `exclusive`. If the word appears, the sentence must also say what specific feature makes the product that.
6. **No XML citation tags.** Never wrap citations in `<cite>…</cite>` or similar. Citations are inline in plain prose: `(Source: Publisher, Date)`.
7. **Scarcity names at least two specific currently-selling comparable developments** with individual $/sqm figures, or honestly flags the floor-area limitation where the figure is indicative. Aggregate benchmark alone is insufficient.
8. **Affordability produces per-bedroom like-for-like comparisons.** 2-bed project stock compared against 2-bed comparables; 3-bed against 3-bed. Never a mixed-bedroom project average against a mixed-suburb median.
9. **Trust & Governance has no null fields.** `warranties` and `memberships` must be genuine strings; use the literal `"Data unavailable"` (or `"To be reconfirmed"`) when the figure is genuinely unknown rather than emitting null.
10. **Population quotes ABS ERP cat. 3218.0 at SA2 level with vintage stated,** or flags the limitation if the current-vintage figure could not be retrieved via public search.

## Tie-back to the portal

This skill is the local/offline equivalent of the `investment-analysis` agent in `supabase/functions/run-agent/index.ts`. The edge function runs on Claude Opus 4.7 (production) or Haiku 4.5 (test mode) via the Anthropic API with `web_search_20250305` enabled, loading its system prompt from `supabase/functions/run-agent/prompt.ts`. The same rules, sourcing requirements, and scoring bands apply in both places: this skill is the human-readable reference; the edge function is the automated execution path.

When `prompt.ts` is updated, update this SKILL.md and the `output-schema.json` in the same commit. Drift between the three breaks trust.
