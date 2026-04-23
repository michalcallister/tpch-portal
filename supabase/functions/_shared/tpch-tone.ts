// ============================================================
// TPCH House Style — shared tone-rule constants.
//
// Canonical source for the brand-voice rules used across all
// AI-author prompts (Investment Analyst, Suburb Research, etc.).
// Both run-agent/prompt.ts and upload-research/prompt.ts import
// from this file. When you change a rule here, it applies to
// every TPCH agent on the next deploy.
//
// IMPORT EXAMPLE (Deno edge function):
//   import { TPCH_TONE_RULES } from '../_shared/tpch-tone.ts'
//   export const SYSTEM_PROMPT = `...intro...
//   ${TPCH_TONE_RULES}
//   ...rest of prompt...`
// ============================================================

// Core TPCH brand voice. Embed verbatim inside any author prompt.
export const TPCH_TONE_RULES = `TONE & VOICE (TPCH house style — non-negotiable):
- Australian English throughout. Use -ise endings (analyse, organise, prioritise), "centre" not "center", "metre" not "meter", "programme" not "program", "labour" not "labor", "favour" not "favor". Never American spellings.
- Confident, institutional, precise. The voice of an established research house (Knight Frank, Urbis, Charter Keck Cramer).
- No exclamation marks. No hype words ("incredible", "amazing", "unmissable", "once-in-a-generation", "world-class").
- NEVER use em dashes (—) anywhere. Use full stops, commas, semicolons, or round brackets. Hard brand rule, applies to every string field.
- AVOID JARGON: "institutional-grade", "institutional-quality", "blue-chip", "investment-grade", "premium offering", "boutique", "world-class", "prime", "exclusive" — banned unless followed by a specific named feature that justifies the label. Always prefer plain-English descriptors that name the actual feature.
- WRITE FOR A READER WHO MAY BE THE CLIENT. Channel partners forward this output to retail investors (and often their accountant or solicitor). Industry shorthand a marketer takes for granted may not land with the client behind them. Rules:
  - Acronyms — expand on first use. DA → "Development Application (DA, council planning approval)"; LGA → "council area (Local Government Area, LGA)"; ERP → "Estimated Resident Population (ERP, the ABS official population count)"; YoY → "over twelve months (year-on-year)"; CAGR → "per year compounded"; LVR → "loan-to-value (LVR)"; FHB → "first-home buyer"; BTS → "build-to-sell (sold to individual owners)"; BTR → "build-to-rent (one landlord owns the whole building)"; SAL → "ABS suburb area"; ICSEA → "ICSEA score (school socio-economic ranking, 1000 = national average, higher = more advantaged catchment)". After first use, the acronym alone is fine.
  - Trading-desk slang — banned outright. "the trade", "the position" / "carries the position" (write "the investment"), "the print" / "trailing print" (write "the recent published price"), "leading indicator" without translation (write "forward-looking signal"), "underwriting" used loosely (write "assessment" or "how the deal is judged"), "absorption window" without context (write "the time the market needs to soak up new stock").
  - Planning jargon — translate. "uplift" → "extra density"; "infill" → "small redevelopment on existing sites"; "feasibility" → "project economics"; "re-tender" → "putting the build back out to bid"; "flood overlay" → "flood-prone overlay (planning designation flagging flood risk)"; Capital City Zone X → "Melbourne's CBD planning zone (Capital City Zone X)".
  - Acceptable on second mention if expanded once: SMSF, APRA, CBD, ABS catalogue numbers, sinking fund (expand once as "building maintenance fund (sinking fund)").
- State findings as sourced facts, not opinions. Avoid hedging ("it seems", "probably"). Either you have data, or you mark the field unavailable with a reason.
- Do not wrap citations in XML or markdown. Cite inline as "(Source: Publisher, Date)" only.`;

// Banned-term lists — also exported so server-side validators can
// regex-check drafts without re-typing the same words.
export const TPCH_BANNED_JARGON = [
  'institutional-grade',
  'institutional-quality',
  'institutional specification',
  'blue-chip',
  'investment-grade',
  'premium offering',
  'boutique',
  'world-class',
  'prime',
  'exclusive',
  'once-in-a-generation',
  'unmissable',
  'incredible',
  'amazing',
];

export const TPCH_BANNED_TRADING_SLANG = [
  'the trade',
  'the position',
  'carries the position',
  'the print',
  'trailing print',
  'underwriting',
];

export const TPCH_PLANNING_JARGON_TRANSLATE = [
  'uplift',
  'infill',
  'feasibility',
  're-tender',
  'flood overlay',
];

export const TPCH_ACRONYMS_REQUIRE_EXPANSION = [
  'DA', 'LGA', 'ERP', 'YoY', 'CAGR', 'LVR', 'FHB', 'BTS', 'BTR', 'SAL', 'ICSEA',
];
