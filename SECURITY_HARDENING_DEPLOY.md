# TPCH Portal — Security Hardening Deploy Guide

Companion document to [`supabase-security-hardening.sql`](supabase-security-hardening.sql).

**Audience.** Mick + any developer running the deploy.
**Goal.** Apply the audit fixes without breaking the portal.
**Timeline.** Phased over 5–7 days with a soft-launch in the middle.

---

## TL;DR

| Phase | What | When | Breaking? |
|---|---|---|---|
| **0** | Pre-flight (backups, hygiene) | Day 1 morning | No |
| **1** | SQL Parts 1, 2, 5 + harden 3 edge functions | Day 1 afternoon | No |
| **2** | Admin auth migration: SQL Part 3, edge function JWT-on, soft-launch one trusted partner | Day 2 | No (additive) |
| **3** | Update `index.html` admin login flow, deploy, smoke test | Day 3 | No (still allows anon fallback) |
| **4** | SQL Part 4 (admin RPC gating) | Day 4 | Breaking — admin must be on new login |
| **5** | SQL Part 6 (RLS lockdown) | Day 5–6 after soak | Breaking — anon writes denied |
| **6** | SQL Part 7 (drop password column) | Day 7+ | Cleanup |

> Stop-ship items 8 (fake landing form), 9 (backup HTML files), and 10 (dead Privacy/Disclaimer links) are addressed in Phase 0 — they aren't in the SQL migration.

---

## Phase 0 — Pre-flight (Day 1, morning)

These three are unrelated to the SQL migration but must happen before any partner sees the portal.

### 0.1 Take a logical backup of the database

In Supabase Dashboard → Settings → Database → Backups → Download or trigger a manual backup. Note the timestamp; this is your roll-back point.

### 0.2 Remove backup HTML from the public site

```bash
git rm index.html.bak tpch-research-portal.backup-20260303.html
git commit -m "Remove old backup HTML from public site"
git push
```

Then check the URLs return 404 after GitHub Pages redeploys (~1 min):
- `https://portal.tpch.com.au/index.html.bak`
- `https://portal.tpch.com.au/tpch-research-portal.backup-20260303.html`

### 0.3 Wire the public landing form to a real backend

[landing.html:934](landing.html#L934) — `submitForm()` only fakes a success panel. Either:

- **Quick fix:** POST to the existing `/functions/v1/<TBD>` enquiry endpoint, or
- **Quicker fix:** insert directly into `pending_enquiries` (anon INSERT remains allowed — see Part 6 of the migration).

The path of least resistance is a direct insert mirroring the in-portal "Become a Channel Partner" form. Open `index.html` and find the in-portal enquiry submit handler, then port the same fetch to `landing.html`.

### 0.4 Stub Privacy + Disclaimer pages

Two empty pages at `/privacy/` and `/disclaimer/` (or update the dead `href="#"` links to real anchors). Even a one-paragraph holding page is acceptable for launch.

### 0.5 Confirm crons exist in the Supabase dashboard

Supabase Dashboard → Database → Cron Jobs. Confirm both schedules are present:

- `sync-monday` — every 15 min
- `expire-reservations` — every 15 min

If either is missing, recreate it from the dashboard, then commit a `supabase/migrations/<ts>_crons.sql` containing the `cron.schedule(...)` calls so it survives a project rebuild.

---

## Phase 1 — SQL Parts 1, 2, 5 + 3 edge function patches (Day 1, afternoon)

These changes are **non-breaking**. They close the worst privacy hole (cross-tenant RPC leakage) and harden the edge functions partners hit directly.

### 1.1 Apply SQL Parts 1, 2, 5

In Supabase Dashboard → SQL Editor → New Query, paste **only** the section of [`supabase-security-hardening.sql`](supabase-security-hardening.sql) from the start of `PART 1` through the end of `PART 5`. Run.

Verify:

```sql
SELECT proname FROM pg_proc WHERE proname IN ('is_admin','current_partner_id');
-- expect 2 rows

SELECT indexname FROM pg_indexes
  WHERE tablename IN ('reservations','agreement_acceptances')
  AND indexname LIKE '%_uq' OR indexname LIKE '%_one_active%';
-- expect 3 rows
```

If `reservations_one_active_per_stock` fails to create, run the cleanup query in the part-5 comment first.

### 1.2 Harden `reserve-stock`

Replace [reserve-stock/index.ts](reserve-stock/index.ts) with the version below. Key changes: requires JWT, derives `partner_id` and `partner_name` / `partner_email` from `channel_partners` (not the body), catches `23505` conflict from Part 5's unique index and returns 200 with the existing reservation.

After saving the file:

```bash
cp reserve-stock/index.ts supabase/functions/reserve-stock/index.ts
mkdir -p supabase/functions/reserve-stock
npx supabase functions deploy reserve-stock --project-ref oreklvbzwgbufbkvvzny --use-api
```

Then in Supabase Dashboard → Edge Functions → `reserve-stock` → Settings, set **Verify JWT: ON**.

```ts
// ===== reserve-stock/index.ts (replacement) =====
// Changes vs prior:
//   • JWT verify ON (set in dashboard)
//   • Derive partner_id from caller's JWT, not body
//   • Look up partner_name and partner_email from channel_partners
//   • Catch 23505 (duplicate active reservation) and return existing one
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY      = Deno.env.get('RESEND_API_KEY')          ?? ''
const MONDAY_API      = 'https://api.monday.com/v2'
const MONDAY_TOKEN    = Deno.env.get('MONDAY_API_TOKEN')        ?? ''
const STOCK_BOARD_ID  = Deno.env.get('MONDAY_STOCK_BOARD_ID')  || '6070412774'
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')           ?? ''
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const AVAIL_COL = 'color'

const ALLOWED_ORIGINS = new Set([
  'https://portal.tpch.com.au',
  'https://tpch.com.au',
])

function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://portal.tpch.com.au'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'Vary': 'Origin',
  }
}

// (... fmt / fmtDate / setMondayAvailability / sendConfirmationEmail unchanged ...)

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const cors = corsFor(origin)
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  const corsHeaders = { ...cors, 'Content-Type': 'application/json' }

  try {
    // ── Auth: derive caller from JWT ──────────────────────────
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) {
      return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: corsHeaders })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userRes.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: corsHeaders })
    }
    const callerUid   = userRes.user.id
    const callerEmail = (userRes.user.email || '').toLowerCase()

    // Resolve caller → partner_id (owner OR active staff). Trust DB, not the body.
    const { data: ownerRow } = await supabase
      .from('channel_partners')
      .select('id, full_name, email')
      .eq('user_id', callerUid)
      .eq('status', 'active')
      .maybeSingle()

    let partner_id: string | null = ownerRow?.id ?? null
    let partner_name  = ownerRow?.full_name ?? ''
    let partner_email = ownerRow?.email ?? callerEmail

    if (!partner_id) {
      const { data: staffRow } = await supabase
        .from('partner_staff')
        .select('partner_id, full_name, email')
        .eq('user_id', callerUid)
        .eq('status', 'active')
        .maybeSingle()
      if (staffRow) {
        partner_id    = staffRow.partner_id
        partner_name  = staffRow.full_name
        partner_email = staffRow.email
      }
    }

    if (!partner_id) {
      return new Response(JSON.stringify({ error: 'No active partner record for caller' }), { status: 403, headers: corsHeaders })
    }

    // ── Body: only stock + client fields are trusted from client ──
    const body = await req.json()
    const required = ['stock_id','stock_name','client_name','client_email']
    for (const f of required) {
      if (!body[f]) return new Response(JSON.stringify({ error: `Missing field: ${f}` }), { status: 400, headers: corsHeaders })
    }

    // 1. Stock available?
    const { data: stockRow } = await supabase
      .from('stock').select('id, availability').eq('id', body.stock_id).single()
    if (!stockRow) return new Response(JSON.stringify({ error: 'Stock item not found' }), { status: 404, headers: corsHeaders })
    if (stockRow.availability !== 'Available') {
      return new Response(JSON.stringify({ error: `This property is no longer available (status: ${stockRow.availability})` }), { status: 409, headers: corsHeaders })
    }

    // 2. Insert reservation. Catch 23505 → already an active reservation; return that one.
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const { data: reservation, error: resErr } = await supabase
      .from('reservations')
      .insert({
        stock_id:      body.stock_id,
        stock_name:    body.stock_name,
        project_id:    body.project_id   || null,
        project_name:  body.project_name || null,
        partner_id,
        partner_name,
        partner_email,
        client_name:   body.client_name,
        client_email:  body.client_email,
        client_phone:  body.client_phone || null,
        notes:         body.notes        || null,
        expires_at:    expiresAt,
        status:        'active',
      })
      .select('id, expires_at')
      .single()

    if (resErr) {
      // 23505 = unique_violation — another active reservation exists for this stock_id
      if ((resErr as any).code === '23505') {
        const { data: existing } = await supabase
          .from('reservations').select('id, expires_at').eq('stock_id', body.stock_id).eq('status','active').single()
        if (existing) {
          return new Response(JSON.stringify({ reservation_id: existing.id, expires_at: existing.expires_at, idempotent: true }), { status: 200, headers: corsHeaders })
        }
      }
      console.error('Insert reservation error:', resErr)
      return new Response(JSON.stringify({ error: 'Failed to create reservation' }), { status: 500, headers: corsHeaders })
    }

    // 3. Update Supabase stock + Monday + email (Monday and email non-blocking)
    await supabase.from('stock').update({ availability: 'Reserved' }).eq('id', body.stock_id)
    setMondayAvailability(body.stock_id, 'Reserved').catch(e => console.error('Monday.com update failed:', e))
    sendConfirmationEmail({ ...body, partner_name, partner_email }, reservation.id, reservation.expires_at)
      .catch(e => console.error('Confirmation email failed:', e))

    return new Response(
      JSON.stringify({ reservation_id: reservation.id, expires_at: reservation.expires_at }),
      { status: 200, headers: corsHeaders }
    )
  } catch (err) {
    console.error('reserve-stock error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
```

### 1.3 Harden `cancel-reservation`

Same pattern. JWT verify ON, derive `partner_id` from JWT.

```ts
// ===== cancel-reservation/index.ts (replacement) =====

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MONDAY_API     = 'https://api.monday.com/v2'
const MONDAY_TOKEN   = Deno.env.get('MONDAY_API_TOKEN')          ?? ''
const STOCK_BOARD_ID = Deno.env.get('MONDAY_STOCK_BOARD_ID')    || '6070412774'
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')             ?? ''
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const AVAIL_COL = 'color'

const ALLOWED_ORIGINS = new Set(['https://portal.tpch.com.au','https://tpch.com.au'])
function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://portal.tpch.com.au'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'Vary': 'Origin',
  }
}

// (... setMondayAvailability unchanged ...)

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  const corsHeaders = { ...cors, 'Content-Type': 'application/json' }

  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: corsHeaders })

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userRes.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: corsHeaders })
    }
    const callerUid = userRes.user.id

    // Resolve caller → partner_id
    const { data: owner } = await supabase
      .from('channel_partners').select('id').eq('user_id', callerUid).eq('status','active').maybeSingle()
    let partner_id = owner?.id ?? null
    if (!partner_id) {
      const { data: staff } = await supabase
        .from('partner_staff').select('partner_id').eq('user_id', callerUid).eq('status','active').maybeSingle()
      partner_id = staff?.partner_id ?? null
    }
    if (!partner_id) return new Response(JSON.stringify({ error: 'No active partner record' }), { status: 403, headers: corsHeaders })

    const { reservation_id } = await req.json()
    if (!reservation_id) return new Response(JSON.stringify({ error: 'Missing reservation_id' }), { status: 400, headers: corsHeaders })

    const { data: rsv } = await supabase
      .from('reservations').select('id, stock_id, status, partner_id').eq('id', reservation_id).single()
    if (!rsv) return new Response(JSON.stringify({ error: 'Reservation not found' }), { status: 404, headers: corsHeaders })
    if (rsv.partner_id !== partner_id) return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 403, headers: corsHeaders })
    if (rsv.status !== 'active')        return new Response(JSON.stringify({ error: 'Reservation is not active' }), { status: 409, headers: corsHeaders })

    await supabase.from('reservations')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'partner' })
      .eq('id', reservation_id)
    await supabase.from('stock').update({ availability: 'Available' }).eq('id', rsv.stock_id)
    setMondayAvailability(rsv.stock_id, 'Available').catch(e => console.error('Monday revert failed:', e))

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders })
  } catch (err) {
    console.error('cancel-reservation error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: corsHeaders })
  }
})
```

### 1.4 Client tweak — drop `partner_id` from reserve-stock body

[index.html:10315](index.html#L10315) and [10479](index.html#L10479) currently send `partner_id` in the body. The new edge function ignores it (deriving from JWT) but you can clean up the client too. Non-blocking.

### 1.5 Smoke test

Log in as a partner. Verify:
- Stock browse loads.
- Reserve a property → email arrives, reservation appears in dashboard.
- Cancel the reservation → stock returns to Available.
- Try double-reserving the same stock as the same partner from two tabs — the second click should return idempotently (200 with `idempotent: true`).

Then log in as a different partner and confirm:
- Their dashboard does **not** show the first partner's reservation.
- Their `My Lists` does not show the first partner's lists.
- Calling `get_partner_deals` with the wrong `partner_id` (open devtools, paste the call) returns `{ code: '42501', message: 'access denied' }`.

If anything fails, roll back this phase via the Part 1, 2, 5 rollback notes in the SQL file. Edge functions roll back via redeploy of the previous source.

---

## Phase 2 — Admin auth migration (Day 2)

Goal: get admins onto Supabase Auth so they have real JWTs. Until they do, the rest of the migration cannot proceed.

### 2.1 Apply SQL Part 3

In SQL Editor, paste only `PART 3` from the migration file. Run. Verify:

```sql
\d tpch_team
-- expect a user_id uuid column
SELECT proname FROM pg_proc WHERE proname = 'get_my_session';
-- expect 1 row
```

### 2.2 Create `auth.users` rows for each admin

Supabase Dashboard → Authentication → Users → Add user → Send invite, for each row in `tpch_team`. Use a **fresh password** that you give the admin out-of-band; do not reuse the plaintext column. The five seed admins:

- `michal@tpch.com.au`
- `michal_callister@hotmail.com`
- `chris@ozproperty.com.au`
- `admin@tpch.com.au`
- `mick@tpch.com.au`

### 2.3 Soft-launch verification

You — Mick — log in as one admin via the **new** flow. Phase 3 is the client change that wires the new flow. Do not progress to Phase 4 until Phase 3 ships and you've verified all admin panels work for at least one full day.

---

## Phase 3 — Update `index.html` admin login (Day 3)

The current admin login does this (around [index.html:4651](index.html#L4651)):

```js
// OLD — reads plaintext password
const r = await fetch(`${SUPABASE_URL}/rest/v1/tpch_team?select=password,full_name,role&email=eq.${email}`, { headers: anonHeaders });
const member = (await r.json())[0];
if (!member || member.password !== pass) { showError('Invalid email or password'); return; }
currentMember = member;
enterAdmin();
```

Replace with the new flow:

```js
// NEW — Supabase Auth + get_my_session
const { data, error } = await supabaseAuth.signInWithPassword({ email, password: pass });
if (error || !data?.session) {
  showError('Invalid email or password');
  return;
}
currentAuthToken = data.session.access_token;
currentRefreshToken = data.session.refresh_token;
sessionStorage.setItem('tpch_access_token',  currentAuthToken);
sessionStorage.setItem('tpch_refresh_token', currentRefreshToken);

const sessionRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_my_session`, {
  method: 'POST',
  headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${currentAuthToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const session = await sessionRes.json();
if (!session || session.role !== 'admin') {
  showError('This account does not have admin access');
  await supabaseAuth.signOut();
  return;
}
currentMember = session;          // admin's tpch_team-shaped record
sessionStorage.setItem('tpch_member', JSON.stringify(currentMember));
enterAdmin();
```

### 3.1 Make every admin REST call attach the JWT

The audit found 25+ admin-context calls that hardcode `Bearer ${SUPABASE_ANON_KEY}`. Wrap them in a single helper so they pick up the admin JWT automatically:

```js
function authHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${currentAuthToken || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  }, extra || {});
}
```

Then grep `index.html` for `Bearer \${SUPABASE_ANON_KEY}` and replace with `authHeaders()` (or `Bearer \${currentAuthToken || SUPABASE_ANON_KEY}` for one-off cases). The exact line numbers from the audit:

| Line | What |
|---|---|
| 4435 | tpch_team SELECT (admin allow-list) — **delete this entire fetch**; the new flow doesn't need it |
| 4537 | tpch_team SELECT (restore admin session) — replace with `get_my_session` RPC |
| 4651 | tpch_team SELECT for login — replace with `signInWithPassword` (above) |
| 4786 | pending_enquiries SELECT |
| 4921 | pending_enquiries PATCH |
| 4945 | channel_partners INSERT |
| 4987 | get_partners_admin RPC |
| 5060 | invite-partner POST |
| 5230 | invite-partner POST (resend) |
| 5330, 5347, 5366 | channel_partners PATCH |
| 5388 | tpch_team SELECT |
| 5544, 5560 | tpch_team PATCH |
| 5629 | tpch_team INSERT |
| 5669, 5711 | tpch_team PATCH (password) — see 3.2 below |
| 5690 | tpch_team DELETE |
| 6841 | run-agent POST |
| 6878 | project_analysis SELECT |
| 6960 | agent_runs SELECT |
| 6996, 7008 | project_analysis PATCH |
| 7079 | suburb_research SELECT (drafts) |
| 7095, 7098, 7406, 7459, 7525, 7534 | research_section_comments / research_versions SELECT |
| 7414, 7427, 7545 | suburb_research PATCH |
| 7468, 7494, 7578 | research_section_comments INSERT/PATCH/DELETE |
| 7554 | research_versions INSERT |
| 7602 | regenerate-research-section POST |
| 9955 | project_analysis PATCH |
| 10229 | projects PATCH |
| 10522 | sync-monday POST |

### 3.2 Replace admin password change with Supabase Auth

Lines 5669 and 5711 currently `PATCH tpch_team` to set a new plaintext password. Replace with `supabaseAuth.updateUser({ password })` (self) or, for super-admin resetting a colleague's password, a small new edge function `admin-reset-password` that takes `{ email }` and calls `supabase.auth.admin.generateLink({ type: 'recovery', email })`.

### 3.3 Restore-session also changes

[index.html:4537](index.html#L4537) currently restores admin from `tpch_team` by email. New flow: at restore, if `currentAuthToken` exists call `get_my_session` and route on `role`.

### 3.4 Smoke test

- Log in as admin via new flow.
- Open every admin panel (Dashboard, Research, Investment Analyst, Enquiries, Partners, Team).
- Approve / decline an enquiry.
- Edit a partner row.
- Add and remove a team member.
- Trigger Sync Now.
- Sign out and sign back in.

If anything fails, the rollback is to revert the index.html change. The SQL Part 3 is non-breaking on its own — admins just keep using the old plaintext flow.

---

## Phase 4 — Admin RPC gating (Day 4)

Apply `PART 4` from [`supabase-security-hardening.sql`](supabase-security-hardening.sql).

After this lands, `get_partners_admin()` and `get_agreement_acceptances()` raise 42501 unless `is_admin()` returns true. Verify by:

- Logged-in admin → Partners panel still loads.
- Logged-in partner → opens devtools, manually calls the RPC → gets `access denied`.

Rollback: re-apply the original RPC bodies from [`supabase-partners-admin-rpc.sql`](supabase-partners-admin-rpc.sql) and [`supabase-agreement-migration.sql`](supabase-agreement-migration.sql).

### 4.1 Harden `invite-partner`

JWT verify ON. Inside the function, validate the caller:

- `type === 'partner'` or `'resend'` → caller must be admin (`is_admin()` via service-role lookup against `tpch_team.user_id = caller.uid`).
- `type === 'staff'` → caller must own the supplied `partner_id` (`channel_partners.user_id = caller.uid AND id = body.partner_id`).

Pattern is the same JWT-verify block as `reserve-stock`. Add at the top of the handler:

```ts
const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
if (!jwt) return json({ error: 'Sign in required' }, 401)
const { data: userRes } = await supabase.auth.getUser(jwt)
if (!userRes?.user) return json({ error: 'Invalid session' }, 401)
const callerUid = userRes.user.id

const isAdmin = !!(await supabase.from('tpch_team').select('id').eq('user_id', callerUid).eq('status','active').maybeSingle()).data

if (type === 'partner' || type === 'resend') {
  if (!isAdmin) return json({ error: 'Admin only' }, 403)
}
if (type === 'staff') {
  const ownership = await supabase
    .from('channel_partners').select('id').eq('user_id', callerUid).eq('id', body.partner_id).maybeSingle()
  if (!ownership.data && !isAdmin) return json({ error: 'Not authorised for this partner' }, 403)
}
```

Deploy with the standard `cp ... && npx supabase functions deploy ...` cycle. Then in the dashboard set **Verify JWT: ON** for `invite-partner` (it was OFF — see PROJECT.md).

### 4.2 Harden `run-agent` and `regenerate-research-section`

Both are admin-only. Add the same `isAdmin` check at the top, return 403 if false. Verify JWT ON in the dashboard.

### 4.3 Optional — accept-agreement

Currently JWT-OFF because the public enquiry flow needs anon access. The function already cross-validates email vs partner record (line 91–114). Acceptable to defer.

---

## Phase 5 — RLS lockdown (Day 5–6)

Apply `PART 6` of the migration. **Do not** run this until:

- Every admin REST call from index.html uses an admin JWT (Phase 3 shipped + smoke-tested).
- Every edge function has been redeployed with JWT verification (Phase 1 + Phase 4).
- You have completed at least 24 hours of soft-launch with one trusted partner with no errors in the Supabase function logs.

Run the `PART 6` block. Verify with:

```sql
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

Confirm there are no `roles = '{anon}'` rows on `tpch_team`, `channel_partners`, `partner_staff`, `pending_enquiries` (except the INSERT for public form), `agent_runs`, `agents`, `project_analysis` (except SELECT WHERE published), `suburb_research` (except SELECT WHERE published), `research_versions`, `research_section_comments`, `reservations`, `shortlists`, `shortlist_items`.

### 5.1 Smoke test (same checklist as Phase 1.5 plus admin)

If anything 401/403's that shouldn't, the cause is almost always a REST call still hardcoded to `Bearer ${SUPABASE_ANON_KEY}`. Find it (grep), wrap with `authHeaders()`, redeploy `index.html`. Don't roll back the SQL.

If you absolutely must roll back: re-apply the original "Anon can …" policies from each per-table migration file. The exact policy SQL is in:
- [supabase-team-migration.sql:62](supabase-team-migration.sql#L62)
- [supabase-partners-migration.sql:99](supabase-partners-migration.sql#L99)
- [supabase-enquiry-rls-patch.sql:9](supabase-enquiry-rls-patch.sql#L9)
- [supabase-stock-migration.sql:257](supabase-stock-migration.sql#L257)
- [supabase-migration.sql:122](supabase-migration.sql#L122)
- [supabase-lists-migration.sql:37](supabase-lists-migration.sql#L37)
- [supabase-reservations-rls-patch.sql:14](supabase-reservations-rls-patch.sql#L14)

---

## Phase 6 — Cleanup (Day 7+)

After at least one working week with no Phase 5 fallout, run `PART 7` to drop the `password` column on `tpch_team`. Take a fresh logical backup before doing so.

---

## Risk register for the deploy itself

| Risk | Mitigation |
|---|---|
| Phase 5 breaks an admin flow you forgot to wrap | Soft-launch first; keep `index.html.bak` *locally* (not in repo) for 7 days |
| An admin loses access mid-deploy | Run Phase 2 with two admins available to cross-recover |
| A partner's session becomes invalid mid-Phase 5 | New `current_partner_id()` returns NULL for an expired JWT — they'll just see empty data, not data leak. They can sign back in. |
| `reservations_one_active_per_stock` index creation fails | Run the cleanup query first; resolve any duplicates by setting older rows to `cancelled` |
| You realise mid-deploy that admin auth migration is too risky | Stop after Phase 1. You will have closed the cross-tenant leak (the worst risk) and added idempotency. The anon-write hole remains, but no partner can read another partner's data. |

---

## What this does NOT cover

The audit also flagged these. They are not security-critical but should land before broad rollout:

- Mobile responsive layout (or a "best on desktop" banner under 768px)
- `restoreSession` token validation before `enterPortal`
- Replace `window.confirm()` for Investor Kit branding choice
- Refresh stock cache on 409 race in reserve flow
- "You're all caught up!" exclamation mark in notification empty state
- Hardcoded mock activity feed on partner dashboard
- "Reserved" tile permanently 0 (status mismatch — `'active'` vs `'reserved'`)
- "West Australia" → "Western Australia" typo on landing
- Lock CORS on remaining edge functions
- Move all edge function sources into `supabase/functions/<name>/` (eliminate dual-location)

These are tracked in the original audit. Schedule them for the soft-launch week.
