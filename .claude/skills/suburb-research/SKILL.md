---
name: suburb-research
description: Produce an investment-grade TPCH Suburb Research report covering 12 pillars with mandatory third-party citations, ≥3 endorsement articles, and exactly 1 counter-view. Use when the user says "run suburb research on [suburb]", "generate research for [suburb]", "draft a TPCH suburb report on [suburb]", or anything equivalent. Output mirrors the schema enforced by the portal's upload-research edge function so a single piece of work is consumed by the portal, the TPCH-branded PDF, and any partner white-label.
---

# Suburb Research — orchestrator

This skill orchestrates three sub-agents that produce a TPCH Suburb Research report against the persistent knowledge layer in [tpch-research-wiki](../../../../tpch-research-wiki/).

This file is the **orchestrator only**. Pillar definitions, voice rules, bias rules, the pre-flight checklist, and the upload schema all live in the agent files and the wiki, not here. Edit the agent files when those rules change.

| Agent | Model | File | Role |
|---|---|---|---|
| Source-Finder | Haiku 4.5 | [agents/source-finder.md](agents/source-finder.md) | Fetch raw research from allow-list domains; write to `tpch-research-wiki/raw/` |
| Wiki-Curator | Sonnet 4.6 | [agents/wiki-curator.md](agents/wiki-curator.md) | Fold raw sources into entity/concept/source pages; maintain `index.md` and `log.md` |
| Copywriter | Opus 4.7 | [agents/copywriter.md](agents/copywriter.md) | Read the wiki; produce schema-compliant JSON; carry all voice and bias rules |

## When to invoke this skill

- User asks to "run suburb research on [suburb name]"
- User asks to "draft a TPCH suburb report on [suburb]" or "what would the Suburb Research Agent produce for [suburb]"
- User wants to refresh a published suburb report
- User is iterating and wants to dry-run output locally before the `research-agent` edge function ships in Phase B

## Inputs required

Before producing output, confirm with the user:

1. **Suburb** (e.g. "Southbank")
2. **State** (VIC | NSW | QLD | WA | SA | TAS | ACT | NT)
3. **Postcode** (4-digit) and **LGA** if known — agent will look up if not supplied
4. **Region** (free text, e.g. "Inner Melbourne") — optional

For the Phase A pilot the suburbs are **Southbank VIC → Box Hill VIC → Geelong VIC**, in that order.

## Output modes

- **JSON mode** (for upload to the portal): Copywriter emits JSON matching [output-schema.json](output-schema.json), validated against the server-side validator in [supabase/functions/upload-research/index.ts](../../../supabase/functions/upload-research/index.ts).
- **Presentation mode** (for live conversations with the user): the orchestrator renders the same content as Markdown for human review before upload — hero strip, executive summary, narrative thesis, 5 dimension scores with reasoning, each pillar, endorsement panel, counter-view, comparable sales, sources, disclaimer.

## Workflow

### 1. Confirm inputs

Confirm `suburb`, `state`, `postcode`, `lga`, `region` with the user. Don't proceed with missing fields.

### 2. Run Source-Finder (Haiku 4.5)

Spawn a sub-agent with `subagent_type: "general-purpose"` and `model: "haiku"`. Prompt it with the contents of [agents/source-finder.md](agents/source-finder.md) plus the inputs above plus the paths:

- `wiki_root`: `C:\Users\micha\Claude\tpch\projects\tpch-research-wiki`
- `allowlist_path`: `C:\Users\micha\Claude\tpch\projects\tpch-portal\.claude\skills\suburb-research\source-allowlist.json`
- `pillar_scope`: all 12 pillars on first pass

Expect: structured output listing `new_raw_files`, `skipped_pillars`, `allowlist_misses`, `gaps`.

### 3. Run Wiki-Curator (Sonnet 4.6)

Spawn a sub-agent with `subagent_type: "general-purpose"` and `model: "sonnet"`. Prompt it with the contents of [agents/wiki-curator.md](agents/wiki-curator.md) plus:

- `wiki_root`: `C:\Users\micha\Claude\tpch\projects\tpch-research-wiki`
- `new_raw_files`: from Source-Finder output
- `target_suburb`, `target_state`, `target_region`, `target_lga`: the inputs

Expect: structured output listing `sources_created`, `pages_created`, `pages_updated`, `pages_archived`, `contradictions_surfaced`, `gaps_remaining`.

### 4. Run Copywriter (Opus 4.7)

Spawn a sub-agent with `subagent_type: "general-purpose"` and `model: "opus"`. Prompt it with the contents of [agents/copywriter.md](agents/copywriter.md) plus:

- `wiki_root`: `C:\Users\micha\Claude\tpch\projects\tpch-research-wiki`
- `schema_path`: `C:\Users\micha\Claude\tpch\projects\tpch-portal\.claude\skills\suburb-research\output-schema.json`
- `suburb`, `state`, `postcode`, `lga`, `region`: the inputs
- `gaps_remaining`: from Wiki-Curator output
- `contradictions_surfaced`: from Wiki-Curator output

Expect: a JSON object matching the schema.

### 5. Gap-fill loop (optional, max one iteration)

If the Copywriter reports `gaps` it cannot work around, run Source-Finder again with `pillar_scope` limited to the gap list, then Wiki-Curator again on the new raw files, then Copywriter again. One iteration only — if the gap survives a second pass, the suburb thesis is weaker than assumed; the Copywriter says so transparently in `thesis_main` and the admin reviewer decides whether to publish.

### 6. Render Presentation mode

The orchestrator (not Copywriter) renders the JSON as a Markdown report for the user. Layout:

1. Hero strip — suburb, state, rating, conviction_score
2. Executive Summary (`thesis_main`)
3. Narrative thesis (`narrative_thesis`)
4. 5 dimension scores + score_reasoning
5. 12 pillars (headline + narrative + stats)
6. Endorsement panel (≥3)
7. Counter-view + response
8. Comparable sales table (if non-empty)
9. Sources
10. Canonical TPCH research disclaimer (verbatim — see Copywriter agent file)

Show the rendered report. Flag any research limitations the Copywriter surfaced.

### 7. Ask explicit upload approval

**Never upload silently.** Exact wording:

> *"Would you like me to upload this research to the portal as a draft for admin review?"*

If yes, proceed to step 8. If no, stop.

### 8. Upload to `upload-research`

**Endpoint:** `POST https://oreklvbzwgbufbkvvzny.supabase.co/functions/v1/upload-research`

**Required headers:**

- `apikey: <SUPABASE_ANON_KEY>` — read from `index.html` constant `SUPABASE_ANON_KEY`
- `Authorization: Bearer <SUPABASE_ANON_KEY>` — same key
- `x-tpch-upload-secret: <UPLOAD_SECRET>` — read from `C:\Users\micha\Claude\tpch\projects\tpch-portal\.claude\.upload-secret` (gitignored)
- `Content-Type: application/json`

**Body:**

```json
{
  "model_used": "claude-opus-4-7",
  "triggered_by": "mick@local-skill",
  "research": { ...full JSON from Copywriter... }
}
```

The `slug` is derived server-side as `<suburb-lowercased-hyphenated>-<state-lowercased>` (e.g. `southbank-vic`). Re-uploading the same suburb upserts onto that slug.

**One-liner (PowerShell):**

```powershell
$secret = Get-Content "C:\Users\micha\Claude\tpch\projects\tpch-portal\.claude\.upload-secret" -Raw
$secret = $secret.Trim()
$anon = "<SUPABASE_ANON_KEY>"
$body = @{ model_used = "claude-opus-4-7"; triggered_by = "mick@local-skill"; research = $researchObject } | ConvertTo-Json -Depth 30
Invoke-RestMethod -Method Post -Uri "https://oreklvbzwgbufbkvvzny.supabase.co/functions/v1/upload-research" -Headers @{ "apikey" = $anon; "Authorization" = "Bearer $anon"; "x-tpch-upload-secret" = $secret; "Content-Type" = "application/json" } -Body $body
```

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

### 9. Show the result

Display the response to the user. Remind them the research is a draft and needs admin review before going live.

## Canonical files — do not duplicate, reference

| File | Role |
|---|---|
| [agents/source-finder.md](agents/source-finder.md) | Source-Finder system prompt. Haiku 4.5. |
| [agents/wiki-curator.md](agents/wiki-curator.md) | Wiki-Curator system prompt. Sonnet 4.6. |
| [agents/copywriter.md](agents/copywriter.md) | Copywriter system prompt. Opus 4.7. Carries all voice, bias, and pre-flight rules. |
| [source-allowlist.json](source-allowlist.json) | Strict Tier 1 / Tier 2 domain allow-list. Source-Finder reads at runtime. |
| [output-schema.json](output-schema.json) | Strict JSON Schema for the upload payload. Copywriter validates against this before emitting. |
| [reference-southbank.md](reference-southbank.md) | Gold-standard worked example for the Copywriter to read before drafting. |
| [supabase/functions/upload-research/index.ts](../../../supabase/functions/upload-research/index.ts) | Server-side validator. Final gate. |
| [supabase/functions/upload-research/prompt.ts](../../../supabase/functions/upload-research/prompt.ts) | `SCHEMA_VERSION` source of truth (currently `2.2.0`). |
| [tpch-research-wiki/CLAUDE.md](../../../../tpch-research-wiki/CLAUDE.md) | Wiki schema, frontmatter spec, linking conventions, currency rules, lint pass, archive rule. |

## Tie-back to the portal

This three-agent local pipeline is the **Phase A** implementation. It runs in a Claude Code session on Mick's machine, with the wiki maintained as markdown in `tpch-research-wiki`.

**Phase B** (later) ports the same three agents to Supabase edge functions:

- `research-sources` (Source-Finder, Haiku 4.5 via Anthropic API)
- `research-curate` (Wiki-Curator, Sonnet 4.6 via Anthropic API; commits wiki updates via GitHub API)
- `research-write` (Copywriter, Opus 4.7 via Anthropic API; POSTs draft to `upload-research`)

A GitHub Actions sync flattens the wiki into a Supabase `research_wiki_pages` table on every commit so portal-side reads stay fast.

When the agent prompt files in `agents/` are updated, the Phase B edge functions read the same files at deploy time. The local skill and the edge functions share one set of prompts.
