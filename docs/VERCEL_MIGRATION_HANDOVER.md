# Vercel migration handover

**Prepared:** 2026-05-21
**For:** A new Claude Code session picking up this task standalone.
**Owner:** Mick Callister (michalcallister@hotmail.com).
**Scope:** Move `tpch-portal` hosting from GitHub Pages to Vercel, then make the GitHub repo private. Keep `portal.tpch.com.au` working throughout, with a documented rollback.

This is a self-contained brief. You (the new agent) have not seen this codebase before. Everything you need is below. Do **not** treat this as a green light to refactor portal code, change auth flows, or rewrite anything beyond what the migration strictly requires.

---

## Why we're doing this

1. **The portal repo is currently public on GitHub.** It contains partner-facing admin UI, embedded Supabase publishable keys (which is fine — they're meant to be public), and code that drives the channel-partner experience. Mick is fine with the *code* being readable, but the broader posture across TPCH (including a new `tpch-research-wiki` repo that will hold draft suburb research) is that all working state should be private by default.
2. **GitHub Pages on a private repo requires GitHub Pro/Team/Enterprise** — Mick is on a free plan. Moving off GitHub Pages onto Vercel removes that constraint and gives us better deploy ergonomics (preview deployments per branch, build logs, instant rollback).
3. **The portal is a single static `index.html`** — no build step, no framework. Vercel serves it as-is. The migration should be a clean drop-in with zero code changes.

---

## Current state (verify before acting)

- **Repo:** `tpch-portal` on GitHub. Check `git remote -v` from `c:\Users\micha\Claude\tpch\projects\tpch-portal\` to confirm the GitHub owner and exact remote URL. Mick logs in via GitHub Desktop, not the CLI.
- **Hosting:** GitHub Pages on the `main` branch. Confirm by checking the repo's Pages settings on GitHub.
- **Custom domain:** `portal.tpch.com.au`, set via the `CNAME` file at the repo root.
- **DNS:** managed at VentraIP. The current CNAME record for `portal.tpch.com.au` resolves to GitHub Pages (target is one of `185.199.108.153 / .109.153 / .110.153 / .111.153` A records, or a CNAME to `<owner>.github.io`).
- **Tech stack:**
  - Single-file SPA at `index.html` (~8500 lines, plain HTML/CSS/JS, no build)
  - Auth via Supabase JWT in JS (`currentAuthToken` / `currentRefreshToken`)
  - 16 edge functions under `supabase/functions/`
  - Supabase project ref: `oreklvbzwgbufbkvvzny`
- **No CI/CD currently.** GitHub Desktop pushes to `main` and GitHub Pages auto-deploys. No GitHub Actions workflows exist (verify by checking `.github/workflows/`).
- **Other files served:** `landing.html`, `hero-bg.jpg`, `TPCH_Marketing_Agreement_v1.docx` (per the `CLAUDE.md` "Folder layout" section).

---

## Goal

After this migration:

- `portal.tpch.com.au` is served by Vercel, not GitHub Pages.
- Every push to `main` triggers a Vercel deploy automatically (Vercel watches the GitHub repo).
- The `tpch-portal` GitHub repo is **private**.
- GitHub Pages is disabled on the repo.
- The portal looks and behaves identically to before the migration. Partners and admins should not notice the change.

---

## Pre-flight (do these before touching DNS)

Run each of these checks and report findings before moving to the actual cutover. Most should be no-ops, but verify, don't assume.

### 1. Grep for GitHub-Pages-specific assumptions

```
grep -rn "github.io" c:\Users\micha\Claude\tpch\projects\tpch-portal\ --include="*.html" --include="*.js" --include="*.ts" --include="*.json"
grep -rn "githubusercontent" c:\Users\micha\Claude\tpch\projects\tpch-portal\ --include="*.html" --include="*.js" --include="*.ts" --include="*.json"
grep -rn "portal.tpch.com.au" c:\Users\micha\Claude\tpch\projects\tpch-portal\ --include="*.html" --include="*.js" --include="*.ts"
```

Expected: zero hits on `github.io` / `githubusercontent`. Possibly hits on `portal.tpch.com.au` in edge functions or share-link generators — those keep working because the domain isn't changing. If anything hardcodes a `.github.io` URL, flag it before continuing.

### 2. Check edge-function CORS allowlists

For each function in `supabase/functions/`, look at the CORS headers. Most projects use a permissive `Access-Control-Allow-Origin: *` for portal calls, but if any function pins to a specific origin, it must include `portal.tpch.com.au` (still works) and optionally `localhost` for local testing.

```
grep -rn "Access-Control-Allow-Origin" c:\Users\micha\Claude\tpch\projects\tpch-portal\supabase\functions\
```

If any function has `Access-Control-Allow-Origin` set to a value that contains `github.io` or `*.github.io`, that's a problem — update it to allow `portal.tpch.com.au` and any Vercel preview URLs (e.g. `tpch-portal-*.vercel.app`). The Supabase edge-function deploy notes are in `tpch-portal/CLAUDE.md` under "Supabase edge functions — deploy gotchas".

### 3. Check the `CNAME` file

```
type c:\Users\micha\Claude\tpch\projects\tpch-portal\CNAME
```

It should contain a single line: `portal.tpch.com.au`. Confirm. This file stays in the repo even on Vercel — Vercel ignores it, but GitHub Pages reads it. Leaving it in place means the rollback path (re-enable GitHub Pages) is still trivial.

### 4. Confirm no `.github/workflows/` exist

```
dir c:\Users\micha\Claude\tpch\projects\tpch-portal\.github
```

If there is no `.github` folder, good — no GitHub Actions to migrate or break. If one exists, audit it before the cutover.

### 5. Sanity check the `landing.html` and other root files

The portal serves multiple HTML files (`index.html`, `landing.html`). Vercel will serve all of them — confirm none reference `<repo>.github.io` or similar.

### 6. Reverse-DNS check

```
nslookup portal.tpch.com.au
```

Capture current resolution as a baseline so you can compare after the cutover.

---

## Migration sequence

The order matters. Each step is reversible until the GitHub-Pages-disable step.

### Step 1 — Lower DNS TTL at VentraIP (do this first, then wait 24h)

Log in to VentraIP DNS for `tpch.com.au`. Find the `portal` record (CNAME or A — depends on how it was set up originally for GitHub Pages). **Lower the TTL to 300 seconds (5 minutes).** Save.

This propagates over the next ~24h. After that, any DNS change you make will propagate globally in ~5 min instead of ~1 hour. **This step alone reduces the worst-case partner-visible outage at cutover from 60 min to 5 min.**

Do this step 24h before the actual cutover. If Mick wants to cut over tonight, this step needed to happen yesterday — in which case, do it now and accept the slower propagation tonight.

### Step 2 — Set up Vercel (anytime; no impact on live traffic)

1. Mick logs in to **vercel.com** (sign in with GitHub if no account yet).
2. **Add New → Project → Import Git Repository** → select `tpch-portal`.
3. Vercel auto-detects framework as **Other** (or "Static"). Leave build settings empty:
   - Build Command: leave blank
   - Output Directory: leave blank (Vercel serves repo root)
   - Install Command: leave blank
4. Click **Deploy**. First build takes 30–60 seconds.
5. Vercel assigns a throwaway URL: `tpch-portal-<hash>.vercel.app` and possibly `tpch-portal-<owner>.vercel.app`.
6. Open the Vercel URL in a browser. Verify:
   - Landing page loads (`/landing.html`)
   - Portal loads (`/index.html` or `/`)
   - You can sign in as a partner (use a known test account)
   - Stock map loads with project pins
   - Suburb research page loads
   - Admin view loads (if you have admin creds)
   - Browser DevTools shows zero failed network requests other than expected 401s for unauthenticated calls

If anything is broken on the Vercel URL, **stop here**. Do not proceed to DNS. Fix the issue first. The Vercel URL doesn't affect any live partner traffic.

### Step 3 — Add the custom domain in Vercel

1. In the Vercel project: **Settings → Domains → Add**.
2. Enter `portal.tpch.com.au`.
3. Vercel will show one of two configurations needed at VentraIP:
   - Most common: a CNAME record pointing `portal` to `cname.vercel-dns.com`.
   - Alternative (apex): A record to `76.76.21.21`. We're not on the apex — we're on a subdomain — so it'll be the CNAME option.
4. **Do not change DNS yet.** Just note the value Vercel wants.
5. Vercel will show the domain as "Invalid Configuration" until DNS points to it. That's expected and harmless.

### Step 4 — Cutover (the only live-traffic-sensitive step)

Do this when partner traffic is low. Typically 10pm AWST onwards.

1. **At VentraIP**, update the `portal.tpch.com.au` DNS record:
   - Change from current GitHub Pages target → `cname.vercel-dns.com` (or whatever Vercel showed in Step 3).
   - Save.
2. **Watch propagation** — run `nslookup portal.tpch.com.au` every 30 seconds from a terminal. When it resolves to a Vercel-controlled IP (typically `76.76.*.*` or `66.33.*.*` range), DNS has flipped.
3. **Wait for Vercel to provision TLS** — once Vercel detects DNS pointing at it, it issues a Let's Encrypt cert. This takes 1–10 minutes. The Vercel domains panel will show "Valid Configuration" with a green tick.
4. **Verify the portal works on the real domain** — open `https://portal.tpch.com.au` in a fresh browser (incognito helps to bypass cached DNS). Confirm:
   - Page loads without TLS errors
   - Login works
   - One or two key flows work end-to-end (stock map, suburb research, admin)

If anything is broken at this stage, **go to Rollback (below)**. Do not proceed.

### Step 5 — Disable GitHub Pages

Only do this once Step 4 verification is green and Vercel has been serving the real domain for at least 15 minutes without issue.

1. GitHub → tpch-portal repo → **Settings → Pages**.
2. Under "Source", change to **None** (or "Disable" — UI wording varies).
3. Save.

The CNAME file in the repo can stay (it's harmless on Vercel). Leaving it makes rollback trivial.

### Step 6 — Make the repo private

1. GitHub → tpch-portal repo → **Settings → General**.
2. Scroll to the bottom: **Danger Zone → Change visibility → Make private**.
3. Confirm. GitHub will ask you to type the repo name.

**Note:** GitHub will warn you that "private repos lose features like GitHub Pages on the free plan". That's fine — we've already moved off Pages. The warning isn't blocking the action.

After this step, only Mick (and any explicit collaborators) can see the repo. Vercel keeps deploying because Vercel has its own GitHub OAuth connection scoped to this repo.

---

## Verification checklist (after cutover)

Run this end-to-end:

- [ ] `https://portal.tpch.com.au` loads with valid TLS (green padlock)
- [ ] `https://portal.tpch.com.au/landing.html` loads
- [ ] Partner login flow works (test with a known account)
- [ ] Stock portal map renders with pins
- [ ] Research v2 page loads suburb cards
- [ ] Admin view accessible (if admin creds available)
- [ ] At least one Supabase edge function call succeeds (visible in DevTools network tab — should be 200 or 401, not CORS error)
- [ ] `nslookup portal.tpch.com.au` returns a Vercel IP
- [ ] Vercel dashboard shows the latest commit deploying successfully on every push to `main` (push a tiny no-op commit if you want to test — e.g. update a comment date in CLAUDE.md)
- [ ] The GitHub repo's Pages settings show "Source: None" or "Pages is disabled"
- [ ] The GitHub repo shows a lock icon (private)
- [ ] No partner-facing errors reported in the next 24h

---

## Rollback plan

**If anything breaks at or after Step 4 (DNS cutover):**

1. **At VentraIP:** revert the `portal.tpch.com.au` DNS record to whatever it was before the cutover. Note the original value in Step 1 of the pre-flight — if you didn't capture it, GitHub Pages records are typically:
   - CNAME `portal` → `<owner>.github.io`, OR
   - A records to `185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153`
2. With TTL lowered to 300s, the rollback propagates in ~5 minutes.
3. GitHub Pages will continue serving the same `index.html` because the `CNAME` file is still in the repo and Pages was not yet disabled.
4. **Do not proceed to Step 5 (disable Pages) or Step 6 (make repo private) until the issue is diagnosed.**

**If you've already done Step 5 (disabled GitHub Pages) and need to roll back:**

1. Re-enable GitHub Pages: Settings → Pages → Source: `main` branch, root folder. Save.
2. Then revert DNS as above.
3. Pages takes ~1 minute to re-deploy.

**If you've done Step 6 (made repo private) and need to roll back AND re-enable Pages:**

GitHub Pages on a private repo requires GitHub Pro. If Mick is on free, he'll need to either (a) upgrade temporarily, or (b) revert the repo to public before re-enabling Pages. Order of operations: public first, then re-enable Pages, then DNS revert.

---

## Things NOT to do during this migration

- **Do not** touch `index.html`, `landing.html`, or any portal logic. The migration is hosting-only.
- **Do not** modify edge functions unless the CORS audit (Pre-flight Step 2) flags a hardcoded origin that won't work.
- **Do not** change Supabase project, anon key, or any DB settings.
- **Do not** delete the `CNAME` file from the repo. It's harmless on Vercel and keeps rollback simple.
- **Do not** create a `vercel.json` config file unless Vercel's default static serving genuinely doesn't work for the portal. The portal is the simplest possible static deployment; default settings should serve it.
- **Do not** push DNS changes during partner business hours (typical AWST work hours: 8am–6pm). The cutover step is the only one with live-traffic risk; do it late evening.
- **Do not** make the repo private *before* GitHub Pages is disabled. Free-plan repos can't serve Pages while private — disabling Pages first avoids a window where the portal is dead because Pages refuses to serve.

---

## What Mick needs to give you (the new agent) at session start

When Mick starts a new session pointing at this brief, he'll need to provide or confirm:

- **Access to the GitHub repo** (he'll be the one clicking through GitHub UI; you guide him step by step)
- **Vercel account credentials or confirmation he has signed in**
- **VentraIP login confirmation** (again, he clicks; you guide)
- **Time window** for the cutover (so you don't push him to do Step 4 in the middle of business hours)
- **A known-good test partner account** for verifying login after cutover

You do not need credentials yourself. You drive the runbook; Mick executes UI actions.

---

## Context: how this connects to other in-flight TPCH work

The reason this migration is happening *now* is that Mick is building a separate `tpch-research-wiki` repo (private from the start) as the persistent knowledge layer behind suburb research. While setting that up, he noticed the portal repo itself should also be private. Same posture, applied consistently.

The wiki migration is **out of scope** for this handover — it's a separate, independent piece of work. Don't conflate them. If Mick asks about the wiki during this session, point him to the main project's plan file at `C:\Users\micha\.claude\plans\hi-good-morning-so-whimsical-hennessy.md` and steer him back to the migration.

The portal repo also contains a Claude Code skill (`.claude/skills/suburb-research/`) and three agent prompts (`.claude/skills/suburb-research/agents/`) that orchestrate the research pipeline. Those are local files — they don't deploy to Vercel and they're not partner-facing. The migration does not affect them.

---

## Acceptance criteria

The migration is done when all six items below are true:

1. `nslookup portal.tpch.com.au` resolves to a Vercel IP (not `185.199.*`).
2. `https://portal.tpch.com.au` loads with valid TLS and the portal works end-to-end.
3. GitHub repo Settings → Pages shows "Source: None".
4. GitHub repo shows a lock icon (private).
5. A test commit to `main` triggers a Vercel build that deploys within 2 minutes and the new content is live at `portal.tpch.com.au`.
6. Mick has been on the portal for 24h post-migration with no broken-partner reports.

Once items 1–5 are green, report back to Mick. Item 6 is a soak check, not a blocker.
