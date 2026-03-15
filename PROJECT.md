# TPCH Partner Portal — Project Handoff Document

## What Is This Project?

A private web portal for **The Property Clearing House (TPCH)**, a property investment firm based in Australia. The portal serves two types of users:

- **Admin (TPCH team)** — manage research, channel partners, enquiries, stock listings
- **Channel Partners** — accredited brokers/advisers who refer clients to TPCH property deals

The portal is a **single HTML file** (`tpch-research-portal.html`) with all CSS and JavaScript inline. There is no build step, no framework, no package.json. Backend is **Supabase** (Postgres + Edge Functions + Storage). Stock workflow management is **Monday.com**, synced to Supabase every 15 minutes via a cron Edge Function.

---

## Infrastructure

| Service | Details |
|---|---|
| **Supabase project** | `oreklvbzwgbufbkvvzny.supabase.co` |
| **Supabase anon key** | In `tpch-research-portal.html` at `const SUPABASE_ANON_KEY` |
| **Admin email** | `admin@tpch.com.au` |
| **Email service** | Resend (`noreply@tpch.com.au`) |
| **AI** | Claude API (Anthropic) — used in AI Research Agent + partner due diligence |
| **Monday.com** | Stock + project management; board IDs in `sync-monday/index.ts` |
| **Hosting** | GitHub Pages — `index.html` in the repo root |
| **Domain** | `tpch.com.au` on GoDaddy; `portal.tpch.com.au` subdomain to be pointed at GitHub Pages |

### Supabase Edge Function Secrets (set in Dashboard → Edge Functions → Secrets)
- `CLAUDE_API_KEY` — Anthropic API key
- `RESEND_API_KEY` — Resend API key
- `ADMIN_EMAIL` — admin@tpch.com.au
- `MONDAY_API_TOKEN` — Monday.com API token
- `MONDAY_PROJECTS_BOARD_ID` — 2949467206
- `MONDAY_STOCK_BOARD_ID` — 6070412774
- `MONDAY_DEALS_BOARD_ID` — 8393705891
- `PORTAL_URL` — live portal URL (e.g. `https://portal.tpch.com.au`) — **must be set before invite links work**

---

## Project File Structure

```
tpch-portal/
├── tpch-research-portal.html          ← Main portal (rename to index.html for deployment)
├── PROJECT.md                         ← This file
│
├── supabase-migration.sql             ← research_reports + stock_listings tables
├── supabase-enquiry-migration.sql     ← pending_enquiries table
├── supabase-enquiry-rls-patch.sql     ← RLS policies for enquiries admin panel
├── supabase-partners-migration.sql    ← channel_partners table
├── supabase-team-migration.sql        ← tpch_team table + seed data
├── supabase-stock-migration.sql       ← projects + stock tables
├── supabase-deals-migration.sql       ← partner_deals table + get_partner_deals RPC
├── supabase-reservations-migration.sql← reservations table + RPCs
├── supabase-reservations-rls-patch.sql← grants for partner cancel from portal
├── supabase-lists-migration.sql       ← shortlists + shortlist_items + website column
│
├── process-enquiry/index.ts           ← Edge Function: AI due diligence + emails
├── sync-monday/index.ts               ← Edge Function: Monday.com → Supabase sync (cron)
├── reserve-stock/index.ts             ← Edge Function: create reservation
├── expire-reservations/index.ts       ← Edge Function: expire overdue reservations (cron)
├── cancel-reservation/index.ts        ← Edge Function: cancel reservation + revert Monday
└── invite-partner/index.ts            ← Edge Function: send partner invite email
```

All SQL files are **fully idempotent** — safe to re-run.

---

## Supabase Database Tables

| Table | Purpose |
|---|---|
| `research_reports` | Suburb research reports (AI-generated, admin-approved) |
| `stock_listings` | Legacy — superseded by `stock` table |
| `pending_enquiries` | Channel partner applications; AI-analysed on INSERT |
| `channel_partners` | Approved partners; created on enquiry approval |
| `tpch_team` | Admin users; portal loads admin email list from here |
| `projects` | Property developments (synced from Monday.com) |
| `stock` | Individual lots/units (synced from Monday.com) |
| `partner_deals` | Deals pipeline (synced from Monday.com Deals board) |
| `reservations` | 48-hour property holds by partners |
| `shortlists` | Partner saved property lists |
| `shortlist_items` | Individual items within a shortlist |

---

## Edge Functions

| Function | Slug/Name | Trigger | Purpose |
|---|---|---|---|
| `process-enquiry` | `quick-function` | DB webhook on INSERT + UPDATE to `pending_enquiries` | AI due diligence, decline email, partner invite |
| `sync-monday` | `sync-monday` | Cron */15 min + manual | Sync Monday.com → Supabase |
| `reserve-stock` | `reserve-stock` | HTTP POST from portal | Create reservation, update Monday.com |
| `expire-reservations` | `expire-reservations` | Cron */15 min | Expire old reservations, revert Monday.com |
| `cancel-reservation` | `cancel-reservation` | HTTP POST from portal | Cancel reservation, revert Monday.com |
| `invite-partner` | `invite-partner` | HTTP POST from admin panel | Send invite email to partner |

**Note:** `process-enquiry` has slug `quick-function` in Supabase dashboard (couldn't rename) but the display name is `process-enquiry`. The DB webhook URL uses the slug `quick-function`.

### Cron Jobs (set via SQL in Supabase SQL Editor)
```sql
-- Sync Monday.com every 15 minutes
select cron.schedule('sync-monday-every-15-min', '*/15 * * * *', ...);

-- Expire reservations every 15 minutes
select cron.schedule('expire-reservations-every-15-min', '*/15 * * * *', ...);
```

### DB Webhooks (Supabase Dashboard → Database → Webhooks)
- `on-enquiry-submitted` — INSERT on `pending_enquiries` → calls `quick-function`
- `on-enquiry-approved` (or similar) — UPDATE on `pending_enquiries` → calls `quick-function`

---

## What's Built

### Admin Features
- **Dashboard** — stats, Leaflet map of research coverage, activity feed, latest research
- **Research portal** — suburb reports with demand/supply analysis, area profiles
- **AI Research Agent** — generates suburb research via Claude API, admin approves to push live
- **Enquiries panel** — view applications, AI due diligence report, approve/decline
- **Partners panel** — manage channel partners (active/inactive/suspended), notes, deal history
- **Team panel** — manage TPCH team members, set admin access

### Partner Features
- **Stock Portal** — browse available properties, filter by state/type/price/availability
- **Project detail** — hero image, all lots in project with availability
- **Lot detail** — full specs, investment analysis, commission breakdown, floor plan
- **Reserve Property** — 48-hour hold with client details + acknowledgement
- **My Lists** — save properties to named lists, persistent in Supabase
- **Investor Kit** — generate branded PDF (via window.print()) with property details + area research
- **My Deals** — pipeline view with active reservations (countdown timers) + deals from Monday.com
- **Partner Settings** — profile, logo upload, website URL (for white-label Investor Kit)

### Pre-login
- **Become a Channel Partner** form — public enquiry form; triggers AI due diligence pipeline

---

## Authentication (Current State)

### Admin Login
- Email checked against `tpch_team` table in Supabase
- Password: hardcoded per team member in `tpch_team` table (temporary)
- No real Supabase Auth yet for admin

### Partner Login
- Currently uses **fake auth** — email/password checked against `channel_partners` table
- `currentAuthToken` is set from Supabase Auth JWT on login via `/auth/v1/token`
- Real Supabase Auth invite flow is built but **requires the portal to be hosted** at a live URL before it can be fully tested (invite link redirects to `PORTAL_URL`)

### Pending: Real Auth Go-Live
Once portal is hosted at `portal.tpch.com.au`:
1. Set `PORTAL_URL` = `https://portal.tpch.com.au` in Supabase secrets
2. Add URL to Supabase Auth → URL Configuration → Redirect URLs
3. Configure Supabase Auth SMTP to use Resend (Auth → Settings → SMTP)
4. Swap partner login to use `supabase.auth.signInWithPassword`
5. Re-invite existing partners so they go through the real auth flow
6. Tighten Storage RLS policies from `anon, authenticated` back to `authenticated` only

---

## Key Architectural Decisions

| Decision | Rationale |
|---|---|
| Single HTML file | No build tooling, easy to deploy/update, entire portal is one file |
| Monday.com for stock | Team already uses it; portal reads from Supabase (synced copy) |
| Research in Supabase only | Too complex/relational for Monday.com's data model |
| Enquiry approval is manual | Admin reviews AI report before approving; Option A chosen over auto-approve |
| Edge Functions for emails | Keeps API keys server-side; Resend for branded HTML emails |
| window.print() for Investor Kit | No PDF library needed; browser handles pagination and download |
| Fake auth while unhosted | Real Supabase Auth invite links need a live URL to redirect to |

---

## Monday.com Board IDs & Key Column IDs

| Board | ID |
|---|---|
| Projects | 2949467206 |
| Stock | 6070412774 |
| Deals | 8393705891 |

Key Stock board columns (in `sync-monday/index.ts → STOCK_COLS`):
- `availability` → `color` (status column; labels: Available / Reserved)
- `projectLink` → `connect_boards35`
- `floorPlan` → `files`

---

## Pending / Still To Build

### Immediate (when portal is hosted)
- [ ] Set `PORTAL_URL` Supabase secret
- [ ] Configure Supabase Auth redirect URLs
- [ ] Configure Supabase Auth SMTP (use Resend)
- [ ] Swap partner login to real `supabase.auth.signInWithPassword`
- [ ] Test full invite → set password → login flow
- [ ] Tighten Storage RLS to `authenticated` only (currently `anon, authenticated`)
- [ ] Point `portal.tpch.com.au` subdomain (GoDaddy CNAME) to GitHub Pages URL

### Phase 4 — My Lists + Investor Kit (built, not yet tested on hosted portal)
- Run `supabase-lists-migration.sql`
- Test Save to List flow
- Test Investor Kit PDF generation + white-label branding
- Review print CSS layout on real devices

### Future Phases (not started)
- **EOI flow** — "Proceed to EOI" button in My Deals (currently placeholder)
- **Admin Investor Kit review** — admin preview before partner downloads
- **Push notifications** — browser or email when deal stage changes
- **Real-time stock updates** — WebSocket or polling when availability changes
- **Partner commission statements** — downloadable PDF of commission history

---

## How to Continue on Another Device

### Prerequisites
- **Claude Code** (Anthropic CLI) installed
- The project repo cloned from GitHub
- Access to Supabase dashboard (`oreklvbzwgbufbkvvzny.supabase.co`)
- Access to Monday.com workspace
- Resend account (`noreply@tpch.com.au`)

### Setup Steps
1. Clone the GitHub repo to your machine
2. Open Claude Code in the project folder: `claude` (in the `tpch-portal` directory)
3. The AI will automatically load `MEMORY.md` from the memory folder — this gives it full context of everything built so far
4. For Edge Function deployment, install Supabase CLI: `npm install -g supabase`
5. Login: `supabase login` then link project: `supabase link --project-ref oreklvbzwgbufbkvvzny`
6. Deploy a function: `supabase functions deploy <function-name> --no-verify-jwt`

### Deploying Portal Updates
1. Edit `tpch-research-portal.html` locally
2. Copy it as `index.html`
3. Push to GitHub → GitHub Pages auto-deploys within ~1 minute

### Where Everything Lives in the HTML File
The portal HTML is ~9000+ lines. Key sections:
- Lines ~1–3600: HTML structure (nav, pages, modals)
- Lines ~3620–6860: Main JavaScript (auth, nav, admin panels, partner logic)
- Lines ~6860–8260: Stock portal JavaScript (sync, listing, reservation, lists, investor kit)
- Lines ~8260+: CSS styles

---

## Contacts & Accounts

| Resource | Where |
|---|---|
| Supabase | supabase.com — project `oreklvbzwgbufbkvvzny` |
| Resend | resend.com — domain `tpch.com.au` |
| Monday.com | monday.com — boards listed above |
| GitHub repo | github.com — contains this project |
| GoDaddy | godaddy.com — `tpch.com.au` DNS |
| Cloudflare | cloudflare.com — `tpch-portal.pages.dev` (backup/old) |
