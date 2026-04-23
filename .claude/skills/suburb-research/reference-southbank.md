# Reference Output — Southbank, VIC

**Status:** PLACEHOLDER. To be replaced with the first Opus 4.7 Southbank suburb-research output once Mick has reviewed and approved it (mirroring the `reference-melbourne-square.md` workflow used for the Investment Analyst skill).

## Why this file exists

The Investment Analyst skill calibrates every new run against [reference-melbourne-square.md](../investment-analyst/reference-melbourne-square.md) — the gold-standard worked example. The Suburb Research skill follows the same pattern: re-read the reference output before producing any new suburb report so tone, structure, sourcing density, scoring discipline, and limitation-disclosure style stay consistent.

Until the first Southbank run is approved, calibrate against:

1. The canonical prompt at [supabase/functions/upload-research/prompt.ts](../../../supabase/functions/upload-research/prompt.ts) — the source of truth for tone, pillars, scoring, and JSON shape.
2. The validator rules in [supabase/functions/upload-research/index.ts](../../../supabase/functions/upload-research/index.ts) — the structural bar the output must clear.
3. The depth and sourcing density of [reference-melbourne-square.md](../investment-analyst/reference-melbourne-square.md) — even though that report covers a single project rather than a whole suburb, the citation density per claim is the bar to match or exceed.

## Workflow to populate this file

1. Mick runs the skill on Southbank, VIC.
2. Skill produces draft in Presentation mode, then JSON mode.
3. Mick reviews, asks for revisions until satisfied.
4. Skill uploads the approved JSON via `upload-research` (status: draft).
5. Mick approves the draft in the portal admin view (status: published).
6. The published JSON output is captured here, in Markdown form (with the same section structure used in the portal UI), as the canonical reference.
7. Subsequent suburb runs (Sydney CBD, Brisbane CBD, Perth CBD, etc.) calibrate against this file plus any later approved references.

## What "calibration" means in practice

Before producing a new suburb report, the skill should:

- Match or exceed the citation density of this reference (count `(Source: ...)` tags per pillar).
- Match the score-reasoning depth (2-3 substantive sentences per dimension, never one).
- Match the endorsement quality bar (named masthead, exact headline, dated within 12 months, full URL, supportive excerpt).
- Match the counter-view discipline (one named bear-case article + a 1-2 sentence response that contextualises rather than dismisses).
- Match the limitation-disclosure honesty (when data isn't available, say so explicitly with a reason — never fill the gap with a guess).

## Until the reference is filled

Treat this as a soft constraint: "produce output that, if shown to a Knight Frank or Urbis senior researcher, would not be dismissed as marketing copy." Every claim verifiable. Every figure dated. Every URL real.
