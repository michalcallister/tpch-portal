---
name: suburb-research
description: Produce an investment-grade TPCH Suburb Research report covering 24 pillars with mandatory third-party citations, ≥3 endorsement articles, and exactly 1 counter-view. Use when the user says "run suburb research on [suburb]", "generate research for [suburb]", "draft a TPCH suburb report on [suburb]", or anything equivalent. Output mirrors the schema enforced by the portal's upload-research edge function so a single piece of work is consumed by the portal, the TPCH-branded PDF, and any partner white-label.
---

# Suburb Research — TPCH Investment-Grade Methodology

## Purpose

Produce a SUBURB-level investment research report for an Australian residential market, written for TWO readers in sequence:

1. TPCH's channel partners (property marketers and buyers' agents) who use the report as the foundation for client conversations.
2. Their CLIENTS — semi-sophisticated retail property investors deploying $500k to $2M into a single property purchase. The client may forward the report to their accountant or solicitor.

The bar is therefore higher than the project-level Investment Analyst output. Every claim must withstand outside scrutiny. Every number must be traceable to a source the reader can independently verify.

This is **not** a project review. It is the suburb-market case that sits underneath every project TPCH lists in that suburb.

## When to invoke this skill

- User asks to "run suburb research on [suburb name]"
- User asks to "draft a TPCH suburb report on [suburb]" or "what would the Suburb Research Agent produce for [suburb]"
- User wants to refresh a published suburb report
- User is iterating on the prompt and wants to dry-run output locally before deploying any future research-agent edge function

## Inputs required

Before producing output, confirm with the user:

1. **Suburb** (e.g. "Southbank")
2. **State** (one of VIC, NSW, QLD, WA, SA, NT, TAS, ACT)
3. **Postcode** (4-digit) and **LGA** if known — agent will look up if not supplied
4. **Region** (free text, e.g. "Inner Melbourne") — optional in Phase 1, region tier deferred to Phase 2

For the Phase 1 pilot the suburb is **Southbank, VIC**.

## Output structure

The report has two output modes:

- **JSON mode** (for upload to the portal): emit the JSON schema defined in [output-schema.json](output-schema.json). No code fences, no prose outside the JSON. Must validate against the schema and against the server-side validator in [supabase/functions/upload-research/index.ts](../../../supabase/functions/upload-research/index.ts).
- **Presentation mode** (for live conversations with Mick): render as Markdown — hero strip, executive summary, 5 dimension scores with reasoning, each pillar with headline + narrative + stats, endorsement panel, counter-view, comparable sales, sources.

## The 12-pillar framework

The report has 12 mandatory pillars. Validator rejects drafts where any are missing or marked `data_not_available`. The **canonical definitions live in [supabase/functions/upload-research/prompt.ts](../../../supabase/functions/upload-research/prompt.ts)** — refer there as the source of truth. Summary:

| # | Pillar key          | Covers |
|---|---------------------|--------|
| 1 | `demographics`      | Population, age, household composition, income deciles, tenure mix |
| 2 | `migration`         | Net overseas, net interstate, net intrastate flows |
| 3 | `employment`        | Top employers, jobs-to-resident ratio, wage growth, unemployment |
| 4 | `supply_pipeline`   | Approvals, DA pipeline, completions, planning controls. Carries the full Supply & Demand thesis. |
| 5 | `vacancy_trend`     | Vacancy rate (current + 12-month trend), tightness, days-on-market |
| 6 | `price_growth`      | 1/3/5/10-year median growth, quartile position, cycle stage, cross-city comparable pricing, recent named comparables |
| 7 | `rent_trend`        | Median rent (current + trend), rental growth, gross yield |
| 8 | `affordability`     | Price-to-income, FHB share, serviceability, stamp duty |
| 9 | `infrastructure`    | Confirmed and planned projects ($ committed, timelines), transport, amenity, climate/flood overlays, school catchments |
| 10 | `risk_register`    | Quantified risks (severity 1-5, likelihood 1-5, mitigation) |
| 11 | `endorsements`     | At least 3 named third-party articles supporting the suburb thesis |
| 12 | `counter_view`     | Exactly 1 named third-party bear-case article + a 1-2 sentence calibrated response |

One top-level field complements the pillars (rendered as its own report section, not as a pillar):

- `comparable_sales` — array of up to 10 named recent transactions (address, date, price, sqm, $/sqm)

**Methodology v2.0.0 note:** the original 24-pillar (12 CORE + 12 EXTENDED) framework was retired in April 2026. The EXTENDED pillars (macro_context, days_on_market, comparable_sales, planning_zoning, schools, transport_amenity, climate_risk, crime_safety, tenure_mix, construction_cost, cashflow, tax) were not adding investor value as standalone pillars; their relevant content is now folded into the broader CORE pillars listed above. The cashflow_model top-level field was retired in April 2026 — typical investor cash-flow modelling belongs at the project level (where actual prices, rents, and depreciation schedules apply), not at the suburb level.

## Scoring (5 dimensions × 20 = `conviction_score` 0-100)

The numerical conviction score is built from FIVE dimensions, each scored 0-20. Each dimension synthesises multiple pillars from above.

| Dimension                  | Score range | Pillars feeding it |
|----------------------------|:-----------:|--------------------|
| `demographic_tailwind`     |    0-20     | demographics + migration + employment |
| `supply_pressure`          |    0-20     | supply_pipeline + vacancy_trend (higher = LESS supply pressure) |
| `capital_growth_outlook`   |    0-20     | price_growth + supply_pipeline (cycle, comparables, macro folded into price_growth narrative) |
| `income_yield_quality`     |    0-20     | rent_trend + affordability |
| `infra_liveability`        |    0-20     | infrastructure (transport, amenity, climate, schools folded into infrastructure narrative) |

`conviction_score` = exact sum of the five dimension scores.

**Rating bands (mandatory mapping):**

- 80-100 → "Strong Buy"
- 60-79  → "Good Buy"
- 40-59  → "Watch"
- 0-39   → "Caution"

Per-dimension `score_reasoning` is mandatory: 2-3 sentences explaining why this number, what data points pushed it up or down, what would need to change to move it.

**Score discipline:** scores are strictly data-driven. A dimension that genuinely scores 11/20 is 11/20. Bias the narrative, not the number. A trust-destroying inflated score in one report eliminates the credibility of every future report.

## Tone & voice — hard rules

1. **Australian English throughout.** `-ise` endings, "centre", "metre", "labour", "favour". Never American spellings.
2. **Confident, institutional, precise.** The voice of an established research house (Knight Frank, Urbis, Charter Keck Cramer).
3. **No exclamation marks. No hype language.** No "incredible", "amazing", "unmissable", "world-class", "once-in-a-generation".
4. **NEVER use em dashes (—) anywhere.** Use full stops, commas, semicolons, or round brackets. Hard brand rule.
5. **Avoid jargon unless defined.** Banned unless the sentence also describes what specific feature makes the suburb that: `institutional-grade`, `institutional-quality`, `blue-chip`, `investment-grade`, `premium offering`, `world-class`. Prefer plain English that names the actual feature.
6. **Write for the client, not the fund manager.** The report is forwarded by the channel partner to a retail investor (and often their accountant or solicitor). Industry shorthand that fund managers say to each other is NOT acceptable. Hard translation rules:
   - **Acronyms — translate or expand on first use.** DA → "approved by council" or "Development Application (DA)"; LGA → "council area"; ERP → "Estimated Resident Population (ERP, the ABS official population count)"; YoY → "over twelve months"; CAGR → "per year compounded"; LVR → "loan-to-value"; FHB → "first-home buyer"; BTS → "for-sale apartments (build-to-sell)"; BTR → "build-to-rent (one landlord owns the whole building)"; SAL → "ABS suburb area"; ICSEA → "ICSEA score (school socio-economic ranking, 1000 = national average, higher = more advantaged)".
   - **Trading-desk slang — banned outright.** "the trade" (write "the opportunity" or "the buy case"); "the position" / "carries the position" (write "the investment" / "carries the investment"); "the print" / "trailing print" (write "the recent published price" or "the headline price"); "leading indicator" without translation (write "forward-looking signal"); "underwriting" (write "assessment"); "absorption window" without context (write "the time the market needs to soak up new stock").
   - **Planning jargon — translate.** "uplift" → "extra density"; "infill" → "small redevelopment on existing sites"; "feasibility" → "project economics"; "re-tender" → "putting the build back out to bid"; "flood overlay" → "flood-prone overlay (planning designation flagging flood risk)"; "Capital City Zone X" → "Melbourne's CBD planning zone (Capital City Zone X)".
   - **Acceptable on second mention if expanded once.** SMSF, APRA, CBD, ABS catalogue numbers, sinking fund ("building maintenance fund (sinking fund)").
7. **State findings as sourced facts, not opinions.** Avoid "it seems" / "probably". Either you have data, or you mark the pillar `"data_not_available"` with a reason.
8. **Citations are inline in plain prose:** `(Source: Publisher, Date)`. No `<cite>` tags, no markdown footnotes, no bracketed numbers.

## Constructive framing — the bias mechanic

TPCH only profiles suburbs it believes are buyable today. The skill's role is to give partners and their clients the strongest **honest** case for the suburb.

Bias appears in:

1. **What you search for** — actively seek named recent comparables that support the buy case, supportive bank/research-house calls, infrastructure wins, demographic tailwinds.
2. **How you frame** — lead each pillar narrative with the genuine strength before addressing the risk. Contextualise weaknesses ("vacancy of 2.1% sits marginally above the 2.0% healthy benchmark, but well below the 3.0% oversupply threshold").
3. **Selection of evidence** — when multiple data points exist, choose the one with the longest credible time horizon, the most reputable source, and the most relevant geographic granularity.

Bias must NEVER appear in:

1. **Fabricated or inflated numbers** — every figure must trace to a real source. The validator rejects fabrication.
2. **Omitted material risks** — if a real headwind exists, surface it in `risk_register` and respond to it. The mandatory `counter_view` enforces this.
3. **Score inflation** — see the discipline note above.

## Executive Summary (`thesis_main`) — mandatory rich summary

`thesis_main` is the data-anchored Executive Summary that opens the report. It is what a client's accountant or solicitor reads first to decide whether the rest of the report is credible. Lean one-paragraph summaries do not pass that bar. **Required shape: 3-4 paragraphs, approximately 2,500 to 3,000 characters (validator floor 1,200), every numerical claim cited inline.**

Required structure (use this order):

1. **Cycle position + cross-city comparables** — where the median sits, the trailing record, the comparable cycle-bottom analogue with its recovery profile.
2. **Leading indicators that contradict the trailing print** — vacancy, rent growth, gross yield, named against peer-city benchmarks.
3. **Supply math** — demand-per-year (forecast resident change ÷ household size), units underway or approved, absorption window, statewide shortfall direction, land-constraint summary.
4. **Catalysts already live + closing rating sentence** — named projects with $ figures and dates, affordability vs peer cities, then the single sentence locking the rating to the conviction score.

Tone is institutional and concise. No forecasted percentages. No scarcity language. Every figure carries `(Source: Publisher, Date)`. The Executive Summary is distinct from `narrative_thesis`: thesis_main is the data-led summary; narrative_thesis is the voice-led story version. Same buy case, different shapes. Both are mandatory.

## Narrative thesis (`narrative_thesis`) — mandatory storytelling section

Pillar-by-pillar data is how the report earns credibility with a client's accountant or solicitor. Storytelling is how the channel partner wins the client in the first place. Every suburb report must carry a connected narrative thesis, titled **"The [suburb] story, in plain English"**, placed immediately after the Executive Summary.

The partner reads this section (verbatim or paraphrased) in a client conversation. It must carry the entire buy case in under 90 seconds of spoken speech, backed by the data but not drowning in it.

### The six-part framework (mandatory structure)

Every narrative thesis follows this shape. The framework is constant; the specific content changes per suburb.

1. **Cycle context** — where is this market in its cycle relative to peers? (What has the trailing record been, and what does it mean in cycle terms, not as a forward forecast.)
2. **Comparable set** — how does this suburb price against the peer universe that matters (other capital-city inner markets, comparable middle-ring markets, comparable regional markets)?
3. **The signal** — what specific inflection says buy now rather than later? (Yield-above-mortgage-cost, demographic inflection, catalytic infrastructure, supply-discipline event, etc.)
4. **Tenant pool** — who rents here, why is demand deep and durable? Reframe renter-heavy markets as a feature (deep tenant competition, yield durability), not a weakness.
5. **Catalysts** — what's already live on the ground, with specific dates and dollar figures? (Not theoretical, not "planned". Live or under construction.)
6. **Shape of the opportunity** — what does buying this specific story look like for an investor with a 7-10 year hold? Close on the thesis, not on urgency or scarcity.

### What varies per suburb — the story type

The framework is universal. The story type is suburb-specific. Identify which fits before drafting:

- **Mean-reversion cycle-bottom** (e.g. Melbourne inner apartments 2026) — negative or flat trailing, peer set already re-rated, yield inflection just hit, catalysts live.
- **Momentum-continuation** (e.g. Perth CBD 2026) — market running, yield still strong, sector demand structural (resources, tourism, etc.).
- **Demographic inflection** (gentrifying middle-ring) — changing buyer pool, catalytic infrastructure opening, demographic flows shifting.
- **Event-driven** (e.g. Brisbane inner 2026-32) — dated catalyst (Olympics, rail opening, precinct delivery) with countdown already public.
- **Income-first, capital-stability** (regional high-yield markets) — yield is the return, capital growth is the bonus, tenant pool explicit.
- **Decentralisation / lifestyle** (regional coastal, tree-change markets) — structural shift in where buyers choose to live, backed by migration and remote-work data.

If the suburb doesn't fit one of these cleanly, the story isn't there yet. Do not force a narrative — flag in the handover note that the buy case is inconclusive.

### Hard rules for the narrative thesis

1. **No forecasted numbers.** Never "Southbank will grow X% over Y years". Describe cycle position and conditions; let the reader infer.
2. **No scarcity/FOMO language.** No "don't miss out", "before it's gone", "last chance". Retail-marketing tone is banned.
3. **Every factual claim in the narrative still carries `(Source: Publisher, Date)`.** The narrative is storytelling in voice, not in sourcing discipline.
4. **Historical analogies must be dated and named.** "Sydney inner-city units re-rated from 2012 after eight years of flat trailing" is acceptable. "The last time this happened, prices doubled" is not.
5. **Close on the thesis, not the close.** The final sentence frames what the opportunity is; the partner does the close.
6. **Australian English, no em dashes, no banned jargon** (all the tone rules apply here too).

### Required output format

In Presentation mode: a full prose section titled "The [suburb] story, in plain English" of 4-6 short paragraphs, placed directly after the Executive Summary.

In JSON mode: populated as the top-level `narrative_thesis` field (mandatory in v2.1.0+, min 1500 chars). Distinct from `thesis_main`, which carries the data-led Executive Summary; both fields are mandatory and must contain different prose covering the same buy case.

## Supply & Demand thesis — mandatory standalone analysis

Of all the pillars, supply/demand balance is the one most often misread when looked at in isolation. A pipeline of 1,000 apartments is meaningless without knowing what demand absorbs in a year. This section codifies the methodology so every suburb report quantifies BOTH sides and ends on the BALANCE, not just the count.

The output appears in TWO places: (a) as the depth of the `supply_pipeline` pillar's narrative, AND (b) as a dedicated subsection inside the narrative thesis titled **"Supply versus demand"**, placed between the "Catalysts" and "Shape of the opportunity" paragraphs.

In future portal layout work, supply versus demand will get its own visual section in the rendered report. For now the content lives in those two written places.

### Required quantification (mandatory in every report)

Both the pillar narrative and the narrative-thesis subsection must work through all six items below. None of them can be skipped or hand-waved.

1. **Demand math** — convert the suburb's population forecast into a dwellings-per-year demand figure.
   - Take the forecast change in resident population for the suburb's SA2 to a published horizon (.id forecast, VIF, NSW Department of Planning, QGSO, WA Tomorrow).
   - Divide by suburb-specific average household size from ABS Census 2021. High-rise inner-city SA2s typically 1.6 to 1.9 people/household; middle-ring 2.4 to 2.8; family suburbs 2.8 to 3.4.
   - State the resulting net new dwellings per year required just to keep pace, with the source.

2. **Supply math** — quantify approved and under-construction supply in the suburb.
   - Name every approved or in-construction project: developer, address, apartment count, expected completion, source URL.
   - Sum unit counts. Divide by the completion window (in years) to get a supply-per-year figure across the visible pipeline.
   - Distinguish BTS (build-to-sell, competes directly with investor strata-titled stock) from BTR (build-to-rent, absorbs tenant demand without adding investor competition). For an investor report, BTR in the local pipeline is helpful, not a headwind.
   - Flag and exclude projects in administration, financing trouble, or visibly stalled. Note them by name with status, but do not count them as confirmed supply.

3. **Absorption math** — calculate years to clear.
   - Confirmed units (under construction or approved) ÷ annual demand = the time the market needs to absorb the visible pipeline.
   - Less than 2 years of demand is a tight market. 2 to 4 years is balanced. More than 4 years signals genuine oversupply.

4. **Statewide context** — relate the local picture to the state housing target.
   - State the relevant government housing target (Victoria 80,000/year via the 2024-2034 Housing Statement; NSW 75,000/year under the National Housing Accord allocation; QLD 50,000/year; WA 30,000/year). Always source the target.
   - State the most recent actual annual approvals or completions number for the state.
   - Quote the shortfall and the direction it is moving (widening or narrowing). A widening structural shortfall is the strongest macro tailwind a suburb-level supply pillar can have.

5. **Land-constraint assessment** — explain forward supply mechanics for THIS suburb.
   - Physical boundaries (rivers, freeways, ocean, ranges, rail corridors) that cap geographic expansion.
   - Zoning controls and design overlays (Melbourne DDO1, NSW LEP envelopes, height limits, FSR/floor-area ratios) that cap density uplift.
   - Recent regulatory tightening (planning amendments, heritage overlays, character controls) that reduce forward approvals momentum.
   - Remaining developable site count and condition vs typical absorption rate. A suburb running out of developable dirt is a different investment than one with greenfield headroom.

6. **Conclusion on the BALANCE** — one sentence that names the position bluntly.
   Examples that match the actual math:
   - "Tight, with structural undersupply, falling forward approvals, and a land-locked geography that limits new pipeline beyond 2028."
   - "Balanced, with concentrated near-term delivery clearing into healthy demand."
   - "Loose, with more than four years of visible supply against forecast demand."

### Why this is its own section

Supply considered alone is what scared a generation of investors out of Melbourne apartments after 2017. Supply considered against demand, with land-constraint context and a forward read on approvals momentum, is what tells you whether yesterday's "oversupply suburb" is today's "structurally tight market". The partner needs all six pieces above to defend the supply/demand call in a client conversation. A cited demand figure beats a hand-wave every time.

### Where the supply/demand result feeds the score

The `supply_pressure` dimension (higher score = LESS pressure, tighter market) is where the conclusion lands. Use the absorption-math result and the statewide-shortfall direction as the primary score drivers. A widening statewide shortfall plus land-locking plus thin forward pipeline supports a high score even if a near-term concentrated delivery exists. Do NOT discount the score twice for the same near-term concentration when capital_growth_outlook already reflects timing-related caution.

## Endorsement panel ("In the press") — strict rules

The `endorsements` array is the credibility heart of the report. Each entry must be a real, recent (within 12 months of today's date) third-party item that supports the suburb thesis.

Each endorsement MUST include:

- `source` — masthead/publisher (e.g. "Australian Financial Review", "CoreLogic Research", "ANZ Property Insights")
- `headline` — actual headline
- `date` — ISO `YYYY-MM-DD`, within 12 months of today
- `url` — full `https://` URL, must resolve
- `excerpt` — 1 to 3 sentences quoting or paraphrasing the supportive claim
- `supports_pillar` — which pillar key this endorsement reinforces

Search the live web to find these. **Do not invent. Do not approximate URLs. Do not use placeholder URLs.** The validator refuses a draft with fewer than 3 endorsements or with any endorsement missing a required field.

If you cannot find 3 supportive recent items, that is a signal the suburb thesis is weaker than assumed. Say so transparently in `thesis_main` and tell the admin reviewer in your hand-off message. Do not pad with stale or off-topic links.

## Counter-view — strict rules

Exactly ONE `counter_view` item, surfacing the strongest credible bear case. Same shape as an endorsement (source, headline, date, url, excerpt) plus a `response` field of 1-2 sentences that addresses the bear case using your own data — not by dismissing it, but by contextualising why the buy case still holds.

A draft with no `counter_view` is rejected. A `counter_view` that simply repeats the bull case is rejected. The point is to demonstrate the buy thesis was tested against the strongest available critique and survived.

## Disclaimer — mandatory bottom-of-report text

Every report (Presentation mode AND any portal/PDF render) must close with the standardised TPCH research disclaimer. The wording is fixed. Do not vary it report-to-report.

**Canonical text (use verbatim):**

> *Disclaimer.* This research is prepared by The Property Clearing House from publicly available sources believed to be reliable at the time of publication. We take care to ensure the information is accurate; however, the report is only as current and complete as the sources it draws on, and conditions can change after publication. TPCH does not deal directly with investors. Any financial or non-financial advice arising from this research is the responsibility of the channel partner who shares it with the end client, not TPCH.

The disclaimer is intentionally about research quality and the partner-led distribution model, not about financial-advice licensing. It does **not** mention AFSL, Corporations Act, "general advice", "personal circumstances", or anything that would imply TPCH is providing financial product advice. We are a research and intelligence provider; advice is the partner's role.

The disclaimer is rendered by the portal as a static element below the sources block. The agent does NOT need to emit it as a JSON field. In Presentation mode the agent must include the canonical text verbatim as the last section.

## Sourcing rules

- **Every** statistic, factual claim, or named comparable in any narrative MUST carry an inline source citation in the format `(Source: Publisher, Date)`.
- The top-level `sources` array is the master citation list — every URL referenced anywhere in the report appears here with: `tag` (short label), `publisher`, `title`, `date`, `url`. Each pillar's `citation_tags` array references tags from this list.
- Search for CURRENT data. Use web search for every factual claim. Do not rely on training data.
- If a current figure can't be found via search, set the pillar's status to `"data_not_available"` with a `reason` rather than guessing.

### Acceptable primary sources by pillar

- **Demographics, migration:** ABS (cat. 3218.0 ERP, 3101.0 quarterly state, Census 2021), .id forecasting
- **Employment:** ABS Labour Force, ABS Regional Statistics, RDA reports
- **Supply:** ABS cat. 8731 (Building Approvals), state planning portals, council DA registers, SQM Research, Urban Developer
- **Vacancy/rent:** SQM Research, CoreLogic, Domain, REA
- **Price:** CoreLogic, Domain House Price Report, REA, ABS RPPI
- **Affordability:** ANZ/CoreLogic Housing Affordability Report, ABS household income
- **Infrastructure:** state infrastructure portals (Infrastructure NSW, Building Victoria, Infrastructure WA, Infrastructure QLD), Infrastructure Australia
- **Planning/zoning:** state planning portals, council strategic plans
- **Schools:** ACARA My School (ICSEA scores)
- **Transport:** state transport authority planning, OpenStreetMap (amenities)
- **Climate:** state hazard overlays, BoM climate data
- **Crime:** state police statistical reports
- **Construction cost:** Rawlinsons Construction Cost Guide, CoreLogic Cordell CCCI
- **Tax:** ATO publications

If a primary source is paywalled, use the most authoritative accessible alternative AND note the limitation in the pillar's narrative.

## Data currency rules

- ABS Estimated Resident Population (cat. 3218.0 Regional Population) is the gold standard for current population. Prefer over 2021 Census. State the ERP vintage explicitly: "ERP at 30 June 2024 (Source: ABS cat. 3218.0, released March 2025)".
- Use 2021 Census only for breakdowns ERP does not publish (age distribution, income decile, household composition, country of birth).
- Forecasts: prefer state forecasts rebased to latest ERP (VIF, WA Tomorrow, NSW Dept of Planning, QGSO, .id forecasting).
- Vacancy and rent: prefer SQM Research, then CoreLogic, then Domain/REA. Always state the period.
- Building approvals: ABS cat. 8731.
- Mark data older than 18 months as "older data — verify before publishing".

## Workflow the skill should follow

1. Confirm the suburb identity (suburb, state, LGA, postcode) with the user.
2. Plan the search agenda — list the 15-20 web searches you need. Group by pillar.
3. Run searches sequentially. For every fact extracted, immediately attach `(Source: Publisher, Date)`.
4. Build the 5 dimension scores from the underlying pillar data — show your reasoning to the user before locking in.
5. Find ≥3 endorsement articles within the last 12 months. Verify each URL resolves. Capture the masthead, exact headline, date, URL, excerpt, and which pillar it supports.
6. Find exactly 1 counter-view article. Draft the 1-2 sentence response.
7. Populate the top-level `comparable_sales` array (up to 10 named recent transactions). If real data is not available, leave the array empty.
8. Assemble the output in Presentation mode first. Show the user the draft and flag any research limitations honestly at the bottom. Close the report with the canonical disclaimer text verbatim.
9. Run the 15-item pre-flight self-check. If anything fails, fix the draft before offering to upload.
10. **Ask the user explicitly whether to upload the draft to the portal.** Never upload silently. Exact wording: *"Would you like me to upload this research to the portal as a draft for admin review?"*. If yes, switch to JSON mode and proceed to upload. If no, stop.

## Pre-flight self-check (mandatory, before emitting output)

Work through this 16-item check against your draft. If any item fails, fix the draft before submitting.

1. All 12 pillars present. None has `"status": "data_not_available"`. (CORE-only methodology — EXTENDED pillars retired in v2.0.0.)
2. All 5 dimension scores are integers 0-20.
3. `conviction_score` equals the EXACT sum of the 5 dimension scores.
4. `rating` matches the band: 80+ Strong Buy, 60-79 Good Buy, 40-59 Watch, 0-39 Caution.
5. `endorsements` array has 3 or more items, every URL is a full `https://` URL, every date is within 12 months of today, every entry has all 6 required fields.
6. Exactly 1 `counter_view` with a populated `response` field (≥30 chars, not a dismissal).
7. Every reference tag inside any narrative appears in the top-level `sources` list.
8. No em dash (—) appears anywhere in any string value.
9. No banned jargon appears unqualified.
10. No XML or markdown citation tags (`<cite>`, `[^1]`, etc.).
11. Every dimension has `score_reasoning` of 2-3 substantive sentences.
12. Australian English throughout (spot-check: -ise endings, "centre", "metre", "labour").
13. `thesis_main` is a rich Executive Summary of 3-4 paragraphs (≥1200 chars) following the structure: cycle position + cross-city comparables → leading indicators contradicting the trailing print → supply math (demand-per-year, units underway or approved, absorption window, statewide shortfall, land-constraint) → catalysts already live + closing rating sentence. Every numerical claim cited inline.
14. `narrative_thesis` field populated (≥1500 chars), titled "The [suburb] story, in plain English" inside the prose, follows the six-part framework (cycle · comparables · signal · tenant pool · catalysts · shape of opportunity), contains no forecasted numbers, no scarcity language, every factual claim cited inline. Distinct prose from `thesis_main`.
15. Supply & Demand thesis fully populated in BOTH the `supply_pipeline` pillar narrative AND a dedicated "Supply versus demand" subsection inside the narrative thesis. Includes all six required pieces: demand math (forecast resident change ÷ household size), supply math (named projects underway or approved with unit counts, completion dates, BTS/BTR distinction), absorption math (years to clear), statewide context (housing target vs actual approvals/completions, with shortfall direction), land-constraint assessment (physical boundaries + zoning controls + remaining sites), and a single-sentence conclusion on the balance. Every numerical claim carries an inline `(Source: Publisher, Date)` citation.
16. Disclaimer present at the bottom of Presentation mode using the canonical TPCH research disclaimer text verbatim. The disclaimer mentions data-quality limitations and the partner-led distribution model only. It does NOT mention financial advice, AFSL, "general advice", or "personal circumstances".

## Uploading to the portal (Option B handshake)

The portal's `upload-research` edge function accepts a validated JSON payload and writes it to `suburb_research` with `status: 'draft'`. The draft appears in the admin view and waits for review before going live.

**Endpoint:** `POST https://oreklvbzwgbufbkvvzny.supabase.co/functions/v1/upload-research`

**Required headers:**

- `apikey: <SUPABASE_ANON_KEY>` — the publishable key from the portal
- `Authorization: Bearer <SUPABASE_ANON_KEY>` — same key
- `x-tpch-upload-secret: <UPLOAD_SECRET>` — shared secret stored at `C:\Users\micha\Claude\tpch\tpch-portal\.claude\.upload-secret` (gitignored)
- `Content-Type: application/json`

**Body:**

```json
{
  "model_used": "claude-opus-4-7",
  "triggered_by": "mick@local-skill",
  "research": { ...full JSON matching output-schema.json... }
}
```

The `slug` is derived server-side as `<suburb-lowercased-hyphenated>-<state-lowercased>` (e.g. `southbank-vic`). Re-uploading the same suburb upserts onto that slug.

**Server-side validation (the function will reject with 422 if any fails):**

- `schema_version` matches the deployed prompt's `SCHEMA_VERSION` (currently `2.2.0`)
- All 12 pillars populated with `status: "ok"`, none `data_not_available`
- 5 dimension scores integer 0-20
- `conviction_score` equals sum of dimensions
- `rating` matches band
- `thesis_main` is a rich Executive Summary, ≥1200 chars, 3-4 paragraphs (validator hard-fails below 1200)
- `narrative_thesis` is a long-form Plain English Story, ≥1500 chars, six-part framework (validator hard-fails below 1500)
- `endorsements` ≥3, every URL valid `https://`, every date within 12 months, all 6 required fields
- `counter_view` present with valid URL and substantive `response`
- `sources` non-empty with valid `https://` URLs
- No em dash, no banned jargon, no XML cite tags
- `state_research` row exists for the supplied `state_code`

**Successful response (201):**

```json
{
  "success": true,
  "run_id": "uuid",
  "research_id": "uuid",
  "slug": "southbank-vic",
  "suburb": "Southbank",
  "state_code": "VIC",
  "conviction_score": 78,
  "rating": "Good Buy",
  "status": "draft",
  "portal_url": "https://portal.tpch.com.au/?research=southbank-vic"
}
```

**One-liner the skill can run to upload** (PowerShell on Mick's Windows box):

```powershell
$secret = Get-Content "C:\Users\micha\Claude\tpch\tpch-portal\.claude\.upload-secret" -Raw
$secret = $secret.Trim()
$anon = "<SUPABASE_ANON_KEY>"
$body = @{ model_used = "claude-opus-4-7"; triggered_by = "mick@local-skill"; research = $researchObject } | ConvertTo-Json -Depth 30
Invoke-RestMethod -Method Post -Uri "https://oreklvbzwgbufbkvvzny.supabase.co/functions/v1/upload-research" -Headers @{ "apikey" = $anon; "Authorization" = "Bearer $anon"; "x-tpch-upload-secret" = $secret; "Content-Type" = "application/json" } -Body $body
```

The anon key is embedded in `index.html` as `SUPABASE_ANON_KEY`; read that constant rather than hardcoding.

**After upload, always:**

- Show the user the response (conviction score, rating, portal URL).
- Remind the user the research is a draft and needs admin review before going live.

## Canonical files — do not duplicate, reference

To stop drift between the prompt, schema, and skill:

| File | Role |
|---|---|
| [supabase/functions/upload-research/prompt.ts](../../../supabase/functions/upload-research/prompt.ts) | Canonical `SYSTEM_PROMPT` and `SCHEMA_VERSION`. The single source of truth for tone, pillars, scoring, and JSON shape. When this changes, update SKILL.md and `output-schema.json` in the same commit. |
| [.claude/skills/suburb-research/output-schema.json](output-schema.json) | Strict JSON Schema for the upload payload. JSON-mode output MUST validate against this. Encodes structural rules (score sum, rating band match, 12 CORE pillars, ≥3 endorsements, exactly 1 counter_view). |
| `.claude/skills/suburb-research/reference-southbank.md` | (Pending) Gold-standard worked example. Will be filled with the first Opus 4.7 Southbank output once Mick approves it. Re-read before producing any new research. |

## Tie-back to the portal

This skill is the local equivalent of the future `research-agent` edge function (Phase 1.5). The same prompt, schema, and validator apply in both places: this skill is the human-readable execution path Mick uses today; the edge function will become the one-click portal trigger when timing data justifies adding it.

When `prompt.ts` is updated, update this SKILL.md and `output-schema.json` in the same commit. Drift between the three breaks trust.
