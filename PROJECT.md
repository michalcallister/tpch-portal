# TPCH Partner Portal — Project Document

## What Is This Project?

A private web portal for **The Property Clearing House (TPCH)**, a property investment firm based in Australia. The portal serves two types of users:

- **Admin (TPCH team)** — manage research, channel partners, enquiries, stock listings, team
- **Channel Partners** — accredited brokers/advisers who refer clients to TPCH property deals
- **Partner Staff** — employees of a channel partner firm; access controlled by the firm owner

The portal is a **single HTML file** (`index.html`) with all CSS and JavaScript inline. There is no build step, no framework, no package.json. Backend is **Supabase** (Postgres + Edge Functions + Storage). Stock and deal workflow management is **Monday.com**, synced to Supabase every 15 minutes via a cron Edge Function.

---

## Infrastructure

| Service | Details |
|---|---|
| **Supabase project** | `oreklvbzwgbufbkvvzny.supabase.co` |
| **Supabase anon key** | In `index.html` at `const SUPABASE_ANON_KEY` |
| **Admin email** | `admin@tpch.com.au` |
| **Email service** | Resend (`noreply@tpch.com.au`) |
| **AI** | Claude API (Anthropic) — used in AI Research Agent + partner due diligence |
| **Monday.com** | Stock + project + deal management; board IDs in `sync-monday/index.ts` |
| **Hosting** | GitHub Pages — `index.html` in repo root, auto-deploys on push |
| **Domain** | `portal.tpch.com.au` → GitHub Pages via CNAME |

### Supabase Edge Function Secrets (Dashboard → Edge Functions → Secrets)
- `CLAUDE_API_KEY` — Anthropic API key
- `RESEND_API_KEY` — Resend API key
- `ADMIN_EMAIL` — admin@tpch.com.au
- `MONDAY_API_TOKEN` — Monday.com API token
- `MONDAY_PROJECTS_BOARD_ID` — 2949467206
- `MONDAY_STOCK_BOARD_ID` — 6070412774
- `MONDAY_DEALS_BOARD_ID` — 8393705891
- `PORTAL_URL` — https://portal.tpch.com.au
- `UPLOAD_SECRET` — shared secret for `upload-analysis` (local skill → portal draft handshake). Local copy at `.claude/.upload-secret` (gitignored).

---

## Project File Structure

```
tpch-portal/
├── index.html                              ← Main portal (single HTML file, all CSS+JS inline)
├── PROJECT.md                              ← This file
├── .gitignore                              ← Ignores .claude/.upload-secret, .env, build artefacts
│
├── .claude/
│   ├── .upload-secret                      ← Local copy of UPLOAD_SECRET (gitignored)
│   ├── settings.local.json                 ← Claude Code allowlist
│   └── skills/
│       └── investment-analyst/
│           ├── SKILL.md                    ← Local Opus equivalent of run-agent
│           ├── reference-melbourne-square.md ← Gold-standard approved output (20 Apr 2026)
│           └── output-schema.json          ← JSON Schema for upload-analysis payload
│
├── supabase-migration.sql                  ← research_reports + stock_listings tables
├── supabase-enquiry-migration.sql          ← pending_enquiries table
├── supabase-enquiry-rls-patch.sql          ← RLS policies for enquiries admin panel
├── supabase-partners-migration.sql         ← channel_partners table
├── supabase-partner-auth-migration.sql     ← partner_staff table, get_my_partner_record RPC,
│                                              get_partner_deals RPC, get_partner_staff RPC
├── supabase-team-migration.sql             ← tpch_team table + seed data
├── supabase-stock-migration.sql            ← projects + stock tables
├── supabase-deals-migration.sql            ← partner_deals table + get_partner_deals RPC
├── supabase-deal-assignments-migration.sql ← deal_assignments table + RLS
├── supabase-notifications-migration.sql    ← partner_notifications table
├── supabase-reservations-migration.sql     ← reservations table + RPCs
├── supabase-reservations-rls-patch.sql     ← grants for partner cancel from portal
├── supabase-lists-migration.sql            ← shortlists + shortlist_items + website column
│
├── process-enquiry/index.ts                ← Edge Function: AI due diligence + emails
├── sync-monday/index.ts                    ← Edge Function: Monday.com → Supabase sync (cron)
├── reserve-stock/index.ts                  ← Edge Function: create reservation
├── expire-reservations/index.ts            ← Edge Function: expire overdue reservations (cron)
├── cancel-reservation/index.ts             ← Edge Function: cancel reservation + revert Monday
├── invite-partner/index.ts                 ← Edge Function: send partner/staff invite email
│
└── supabase/functions/
    ├── run-agent/
    │   ├── index.ts                        ← Edge Function: Investment Analyst (portal path)
    │   └── prompt.ts                       ← Canonical system prompt (single source of truth)
    └── upload-analysis/
        └── index.ts                        ← Edge Function: Option B upload handshake
```

**Deploying edge functions** (from cmd, not PowerShell):
```
cd C:\Users\micha\.claude\tpch-portal
npx supabase login
npx supabase functions deploy <function-name> --project-ref oreklvbzwgbufbkvvzny --use-api
```
Note: Functions must be copied to `supabase/functions/<name>/index.ts` before deploying — the CLI requires that path structure.

All SQL files are **fully idempotent** — safe to re-run.

---

## Supabase Database Tables

| Table | Purpose |
|---|---|
| `research_reports` | Suburb research reports (AI-generated, admin-approved) |
| `pending_enquiries` | Channel partner applications; AI-analysed on INSERT |
| `channel_partners` | Approved partner firms; owner login via Supabase Auth |
| `partner_staff` | Staff members of a partner firm; invite flow via Supabase Auth |
| `tpch_team` | Admin users (TPCH staff); password in table, custom auth |
| `projects` | Property developments (synced from Monday.com) |
| `stock` | Individual lots/units (synced from Monday.com) |
| `partner_deals` | Deals pipeline (synced from Monday.com Deals board 8393705891) |
| `deal_assignments` | Maps deals to specific staff members (controls commission visibility) |
| `partner_notifications` | In-portal notifications for partners |
| `reservations` | 48-hour property holds by partners |
| `shortlists` | Partner saved property lists |
| `shortlist_items` | Individual items within a shortlist |
| `agents` | Registry of AI agents (e.g. `investment-analysis`); FK target for `agent_runs.agent_id` |
| `agent_runs` | Per-run log of agent executions (portal or local-skill); status, triggered_by, duration, logs |
| `project_analysis` | Investment analysis output (5-pillar scoring, TPCH assessment); `status='draft'` until admin publishes |

---

## Edge Functions

| Function | Trigger | Purpose |
|---|---|---|
| `process-enquiry` (slug: `quick-function`) | DB webhook on INSERT/UPDATE to `pending_enquiries` | AI due diligence, decline email, partner invite |
| `sync-monday` | Cron */15 min + manual "Sync Now" button | Sync Monday.com boards → Supabase |
| `reserve-stock` | HTTP POST from portal | Create reservation, update Monday.com |
| `expire-reservations` | Cron */15 min | Expire old reservations, revert Monday.com |
| `cancel-reservation` | HTTP POST from portal | Cancel reservation, revert Monday.com |
| `invite-partner` | HTTP POST from admin/settings panel | Send invite email to partner or staff (JWT verify OFF) |
| `run-agent` | HTTP POST from admin Research panel | Investment Analyst agent (Claude API + web_search). Writes to `agent_runs` + `project_analysis` as draft. Opus 4.7 prod / Sonnet 4.6 default / Haiku 4.5 test. System prompt lives in `prompt.ts` (do not inline-edit `index.ts`). |
| `upload-analysis` | HTTP POST from local Claude Code skill | Option B handshake: accepts a locally produced Investment Analyst JSON, validates against same rules as `run-agent` (em-dash ban, banned jargon, scarcity regex, score sum, rating band), inserts as `status='draft'`. Requires `x-tpch-upload-secret` header matching `UPLOAD_SECRET` env var. **Scarcity rule (updated Apr 2026):** the two-comparables `$X/sqm` regex now scans `scarcity_narrative`, not `scarcity_stats.replacement_cost_sqm`. The stat box is a short single-line verdict (≤60 chars, one data point); named comparables with sources live in the narrative. |

**Important:** `invite-partner` has JWT verification turned OFF in Supabase dashboard (Edge Functions → invite-partner → Settings → Verify JWT: OFF). Required because partner tokens can be expired when resending invites.

### Investment Analyst — two paths, one outcome

Both paths write identical `project_analysis` rows with `status='draft'`, so the admin review and publish gate is the same either way:

1. **Portal path (`run-agent`)** — admin clicks "Run Analyst" in the Research panel; the edge function calls Claude API directly. Good for Haiku test runs and quick Sonnet jobs. Bound by the 150s edge-function gateway timeout.
2. **Local skill path (`upload-analysis`)** — for heavy Opus 4.7 runs, the skill at `.claude/skills/investment-analyst/` produces the JSON locally in a Claude Code session, then (only after asking Mick) POSTs it to `upload-analysis`. Not bound by the 150s timeout and uses Mick's Claude subscription rather than API credit.

---

## Authentication

### Admin Login
- Email checked against `tpch_team` table
- Password stored in `tpch_team` table (hashed or plain depending on setup)
- Super admin role available for elevated access
- No Supabase Auth for admin users

### Partner Owner Login
- Real Supabase Auth (`/auth/v1/token` with email+password)
- Invite flow: admin invites partner → `invite-partner` edge function sends branded Resend email with `generateLink` (type: `recovery`) → partner clicks link → sets password → logs in
- `get_my_partner_record` RPC called after auth to get full partner record

### Partner Staff Login
- Real Supabase Auth — same flow as partner owner
- Staff invited by partner owner from Settings → Team page
- `invite-partner` edge function handles staff type: uses `generateLink` (type: `recovery` if user exists, `invite` if new)
- `get_my_partner_record` RPC returns staff record with `role: 'staff'`, `job_role`, `comm_display_type`, `comm_custom_value`, `staff_id`

### Session Persistence
- `sessionStorage` stores auth token + partner record on login
- `restoreSession()` called on page load — restores full session without re-login
- `localStorage` stores sort preferences — persists across logouts

---

## Partner Staff System

### Access Levels
Staff `job_role` field controls access:
- **`admin`** — full access including Settings, can assign deals, manage team commission
- **`standard`** (or anything else) — no Settings page, restricted commission visibility

### Commission Display Override
Per-staff setting controlled by firm owner in Settings → Team:
- `comm_display_type: 'portal'` — show real portal commission (default)
- `comm_display_type: 'custom'` — show flat custom value (e.g. `$10,000`) everywhere
- `comm_display_type: 'hidden'` — show `—` everywhere, hide commission tab in stock detail

Commission override applies in: all-stock table, project cards, project stock table, stock detail page, Team Deals table, dashboard commission tile.

### Deal Assignments
- Admin/owner assigns deals to staff from Team Deals → ✎ button on each row
- Staff only see commission on **assigned deals** — unassigned deals show `—`
- Dashboard pipeline tiles (Reserved, EOI, Contracts, Commission) scope to assigned deals only
- Stored in `deal_assignments` table (deal_id + staff_id + partner_id)
- Commission tile for staff respects their `comm_display_type` setting

---

## What's Built

### Admin Features
- **Dashboard** — stats, Leaflet map of research coverage, activity feed, latest research
- **Research portal** — suburb reports with demand/supply analysis, area profiles
- **AI Research Agent** — generates suburb research via Claude API, admin approves to push live
- **Investment Analyst agent** — 5-pillar scoring (Population, Economic, Supply & Demand, Affordability, Scarcity) with TPCH Assessment and Trust & Governance sections. Runs via `run-agent` edge function (portal) or locally via the Claude Code skill + `upload-analysis` handshake. Same validator + draft review gate in both paths.
- **Enquiries panel** — view applications, AI due diligence report, approve/decline
- **Partners panel** — manage channel partners (active/inactive/suspended), resend invites, notes
- **Team panel** — manage TPCH team members, set admin/super-admin access
- **Sync Now** button — manually trigger Monday.com → Supabase sync

### Partner Features
- **Dashboard** — pipeline tiles (Reserved, EOI, Contracts, Commission), map, welcome header
- **Stock Portal** — browse all available properties; filter by state/type/price/beds/availability/SMSF; sortable columns; toggle between table and project card views
- **Project detail** — hero image, all lots in project with availability, sortable stock table
- **Lot detail** — full specs, investment analysis, commission breakdown (respects staff override), floor plan, staged payment schedule
- **Reserve Property** — 48-hour hold with client details + acknowledgement
- **My Lists** — save properties to named lists, persistent in Supabase
- **Investor Kit** — generate branded PDF (via window.print()) with property details + area research
- **Team Deals** — full pipeline from Monday.com; columns: Stage, Property, Client, COS Executed, Exp. Approval, Exp. Settlement, Paid to Date, Outstanding (commission minus paid); all sortable; stage filters; deal assignment (admin only)
- **Partner Settings** — profile, logo upload, website URL, invite + manage staff, set staff commission display
- **Team view** — shows owner + all staff members, status (Active/Invited), commission setting per staff

### What's New / Changelog
- In-portal changelog modal (✦ button in top bar, partner users only)
- Gold dot badge appears when new updates are available
- Badge cleared once user opens the modal
- `localStorage` tracks last-seen version
- Updated automatically by developer on each deploy (CHANGELOG array in index.html)
- Current version: **v1.5**

### Pre-login
- **Become a Channel Partner** form — public enquiry form; triggers AI due diligence pipeline

---

## Monday.com Board IDs & Key Column IDs

| Board | ID |
|---|---|
| Projects | 2949467206 |
| Stock | 6070412774 |
| Deals | 8393705891 |

### Deals Board Columns (`DEALS_COLS` in sync-monday/index.ts)
| Field | Column ID | Title |
|---|---|---|
| `channelPartner` | `link_to_accounts_mkmvsxv5` | Channel Partner |
| `property` | `connect_boards_mkmv6n8r` | Property |
| `clientName` | `text_mm19y1bt` | Client Name |
| `stage` | `deal_stage` | Stage |
| `dealValue` | `deal_value` | Deal Value |
| `cosExecuted` | `date_mkp1dqf` | COS Executed Date |
| `expectedApproval` | `date_mkmv91np` | Expected Approval Date |
| `expectedSettlement` | `deal_expected_close_date` | Expected Settlement Date |
| `fullyPaid` | `deal_close_date` | TPCH Fully Paid Date |
| `paidToDate` | `numeric_mm2d43w` | Paid to Date |
| `daysToClose` | `numeric_mkq2evhg` | Days to Close |

Note: `deal_actual_value` = "TPCH Paid to Date" (different from "Paid to Date" = `numeric_mm2d43w`)

### Deal Stages (Monday.com status labels, used in `isDlpVisible` filter)
Stages shown in portal: EOI, Reserved, COS Issued/Sent, Contract, Exchange, Finance, Approval, Unconditional, Awaiting Title, Under Construction. Stages may have numeric prefixes (e.g. "1. EOI Submitted") — the filter uses `.includes()` for keyword matching.

---

## Key Architectural Decisions

| Decision | Rationale |
|---|---|
| Single HTML file | No build tooling, easy to deploy/update, entire portal is one file |
| Monday.com for stock/deals | Team already uses it; portal reads from Supabase (synced copy) |
| Real Supabase Auth for partners | JWT tokens required for RLS-protected tables |
| `generateLink` + Resend for invites | Full control over email branding; avoids Supabase default emails |
| JWT verify OFF on invite-partner | Partner tokens can be expired when admin resends invites |
| Session in sessionStorage | Persists across page refresh; cleared when browser tab closes |
| Sort prefs in localStorage | Survives logout; per-user preference tied to browser |
| Deal assignments table | Single control point for staff commission visibility and pipeline scope |
| Commission override at render time | Staff-specific `fmtCommForUser()` and `fmtProjCommForUser()` helpers wrap raw `fmtComm()` |
| Changelog in code | No external service needed; developer updates CHANGELOG array on each deploy |

---

## RLS Policies — Key Notes

- `channel_partners`: RLS enabled; partners read their own row via `user_id = auth.uid()`
- `partner_staff`: RLS enabled; staff read own row; partner owner reads their firm's staff; UPDATE policy required for commission edits
- `deal_assignments`: RLS enabled; all firm members can SELECT; only partner owner can INSERT/UPDATE/DELETE
- `partner_deals`: RLS enabled; service role only for sync writes; partners read via `get_partner_deals` RPC (SECURITY DEFINER)

---

## How to Deploy

### Portal (index.html)
```bash
git add index.html
git commit -m "description"
git push
```
GitHub Pages auto-deploys within ~1 minute. Browser cache-control meta tags prevent stale caching.

### Edge Functions (from cmd, not PowerShell)
```
cd C:\Users\micha\.claude\tpch-portal
cp sync-monday/index.ts supabase/functions/sync-monday/index.ts
npx supabase functions deploy sync-monday --project-ref oreklvbzwgbufbkvvzny --use-api
```
Replace `sync-monday` with the function name as needed.

### SQL Migrations
Run in Supabase Dashboard → SQL Editor → New Query. All migration files are idempotent.

---

## Pending / Still To Build

### Known Issues
- Monday.com API rate limits (429) when sync is triggered too frequently — avoid manual triggers back-to-back; the 15-minute cron handles it automatically
- `supabase/functions/` directory must be kept in sync with the source function files before deploying (copy manually before deploy)

### Future Features (not started)
- **EOI flow** — "Proceed to EOI" button in Team Deals (currently placeholder)
- **Push notifications** — email when deal stage changes in Monday.com
- **Real-time stock updates** — polling or WebSocket when availability changes
- **Partner commission statements** — downloadable PDF of commission history
- **Admin Investor Kit review** — admin preview before partner downloads
- **Reduce sync rate limiting** — add retry/backoff logic to sync-monday for 429 errors

---

## Contacts & Accounts

| Resource | Where |
|---|---|
| Supabase | supabase.com — project `oreklvbzwgbufbkvvzny` |
| Resend | resend.com — domain `tpch.com.au` |
| Monday.com | monday.com — boards listed above |
| GitHub | github.com/michalcallister/tpch-portal |
| GoDaddy | godaddy.com — `tpch.com.au` DNS |

## How to Continue on Another Device

1. Clone the GitHub repo
2. Open Claude Code in the project folder: `claude`
3. The AI loads `MEMORY.md` from the Claude memory folder for full context
4. For edge function deployment: use cmd (not PowerShell), run `npx supabase login` first
5. Supabase CLI note: functions must be in `supabase/functions/<name>/index.ts` and use `--use-api` flag
