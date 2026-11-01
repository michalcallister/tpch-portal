# TPCH Changelog

Shipped work, most recent first. Active priorities live in [CLAUDE.md](CLAUDE.md).

## 2026-04-27 — White-label property flyer with partner brand colours

Public flyer route `#flyer/<stockId>/<partnerId>` deployed to `portal.tpch.com.au`. Partners share a stock item via the Share button on the stock page; recipients see a flyer in the partner's logo, brand palette and contact details — no login, no commission, anon-readable via `get_flyer_payload` RPC with whitelisted columns. `extract-brand-colours` edge function v2 pulls primary/accent from the partner's site (theme-color → CSS custom props → frequency), now fetching up to three referenced stylesheets so Vite/Next/Tailwind compiled brand vars are visible. Two-token white-labelling (`--f-accent` dark surface + `--f-primary` brand pop, with `--f-on-accent` fallback) keeps the flyer readable when a partner's primary is unusable. Logo brightness auto-detected via canvas — light logos flip the header to the dark surface. "Prepared for [Client]" personalisation in the share modal renders an eyebrow in the flyer header. Photo gallery capped at 6 visible tiles with "+N more" overlay opening a navigable lightbox (prev/next, X-of-N counter, scrollable thumbnail strip, keyboard nav). Hero/grid/lightbox-strip served via Supabase image transformation — drops the cover from 13MB to ~150KB on photo-heavy projects. Description HTML sanitised through an allowlist (P/BR/H2/H3/H4/UL/OL/LI/STRONG/EM/B/I). Settings save round-trip fixed (`role_type` persisted, `saveSession()` rebroadcasts, `get_my_partner_record` RPC synced).

## 2026-04-22 — Marketing Agreement v1.0 .docx rebranded

Generated via `tpch-doc` skill: full TPCH branding (Palatino headings, navy cover, gold hairlines, Courier overlines), Parties table with 8 fillable rows, signature block. Canonical SHA-256: `eb6e9a4f145a6c011f1686a09063a6b82a1995ea7684008e4b1963d8d0fa307a`. `accept-agreement` edge function v2 deployed.

## 2026-04-22 — Marketing Agreement acceptance flow live

Append-only `agreement_acceptances` audit table with `parties_snapshot`, `registered_address` carried from enquiry through partner record. Three-context edge function (`enquiry` / `blocker` / `admin_invite`) with server-captured IP/UA/timestamp + canonical SHA-256 validation. Parties block auto-fills from form values or partner record. Partners admin page shows status, last sign-in, agreement version, downloadable .docx via `get_partners_admin()` SECURITY DEFINER RPC. Resend Certificate of Acceptance email on success.

## 2026-04-21 — Scarcity regex moved from stat to narrative

`upload-analysis` validator now scans `scarcity_narrative` for the two named `$X/sqm` comparables, not `scarcity_stats.replacement_cost_sqm`. Stat box is a short single-line verdict (≤60 chars, one data point, no inline citations); comparables and sources live in the narrative. SKILL.md, `prompt.ts`, edge function redeployed. Smoke tests: Queens Place 201; single-comparable 422.

## 2026-04-21 — Option B upload handshake live

Local Opus runs POST to `upload-analysis` with shared-secret header; lands in `project_analysis` as `status='draft'` for admin review. Same validator as portal path (jargon, em-dash, scarcity regex, rating band, score sum). Skill always asks before uploading.

## 2026-04-20 — Investment Analyst skill hardened

`tpch-portal/.claude/skills/investment-analyst/` — SKILL.md, canonical `reference-melbourne-square.md` (gold-standard Opus output), `output-schema.json` (JSON Schema draft 2020-12), pre-flight self-check, upload handshake instructions.

## 2026-04 — Investment Analyst agent prompt upgraded (run-agent v14)

TPCH tone rules, em-dash and jargon bans, ABS ERP data currency rule, direct-vs-indirect supply lens, like-for-like affordability, 2+ named scarcity comparables. Prompt lives in `supabase/functions/run-agent/prompt.ts` (single source of truth — do not inline-edit). Opus 4.7 prod / Sonnet 4.6 default / Haiku 4.5 test.
