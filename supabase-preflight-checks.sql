-- ============================================================================
-- TPCH PORTAL — SECURITY HARDENING PRE-FLIGHT CHECKS
-- ============================================================================
-- Run this BEFORE applying supabase-security-hardening.sql.
-- Paste the whole file into Supabase Dashboard → SQL Editor → New Query.
-- The result panel shows one section per check. Read the OK/ACTION line in
-- each section.
-- ============================================================================


-- ── CHECK 1 — Duplicate active reservations on the same stock ──────────────
-- If this returns rows, the Part 5 unique index `reservations_one_active_per_stock`
-- will FAIL to create. Resolve by cancelling the older duplicate before
-- running the migration.
--
--   ACTION if rows returned:
--     UPDATE reservations SET status='cancelled', cancelled_at=now(),
--            cancelled_by='system'
--      WHERE id IN (<older duplicate ids>);
SELECT
  '1. Duplicate active reservations' AS check_name,
  stock_id,
  COUNT(*) AS active_count,
  array_agg(id ORDER BY reserved_at) AS reservation_ids,
  array_agg(reserved_at ORDER BY reserved_at) AS reserved_at_list
FROM public.reservations
WHERE status = 'active'
GROUP BY stock_id
HAVING COUNT(*) > 1;
-- OK if 0 rows.


-- ── CHECK 2 — Users who are both partner owner AND staff ───────────────────
-- If this returns rows, current_partner_id() will pick whichever the planner
-- returns first (could be wrong). Should be 0 rows in clean data.
--
--   ACTION if rows returned: investigate manually. Either deactivate the
--   stale row (set status='inactive') or null out the user_id on the wrong row.
SELECT
  '2. Dual-role users (owner AND staff)' AS check_name,
  cp.user_id,
  cp.email AS owner_email,
  cp.id AS owner_partner_id,
  ps.partner_id AS staff_partner_id,
  ps.email AS staff_email
FROM public.channel_partners cp
JOIN public.partner_staff ps ON ps.user_id = cp.user_id
WHERE cp.user_id IS NOT NULL
  AND cp.status = 'active'
  AND ps.status = 'active';
-- OK if 0 rows.


-- ── CHECK 3 — Public flyer RPC must be SECURITY DEFINER ────────────────────
-- After Part 6 RLS lockdown, anon can no longer SELECT from channel_partners.
-- If get_flyer_payload reads channel_partners and is NOT SECURITY DEFINER,
-- the public flyer page will break for anon visitors.
--
--   ACTION if `prosecdef = false`:
--     Read the function body. If it touches channel_partners, projects, or
--     stock, alter it to SECURITY DEFINER:
--       ALTER FUNCTION public.get_flyer_payload(...) SECURITY DEFINER;
--     Same check for set_project_geocode (less critical — it only writes
--     project geocode coordinates).
SELECT
  '3. Flyer RPC security definer flag' AS check_name,
  proname,
  prosecdef AS is_security_definer,
  CASE WHEN prosecdef THEN 'OK' ELSE 'ACTION REQUIRED' END AS verdict
FROM pg_proc
WHERE proname IN ('get_flyer_payload', 'set_project_geocode')
  AND pronamespace = 'public'::regnamespace;
-- OK if both rows show is_security_definer = true.


-- ── CHECK 4 — Partner email vs auth.users.email divergence ─────────────────
-- After Phase 1 the new reserve-stock derives partner_email from
-- channel_partners.email (not the body). If the row is stale, confirmation
-- emails go to the wrong address.
--
--   ACTION if rows returned: update channel_partners.email for each row to
--   match auth.users.email — partners can only sign in with the auth.users
--   email, so that one is the source of truth.
SELECT
  '4. Partner email divergence' AS check_name,
  p.id AS partner_id,
  p.email AS partner_email,
  u.email AS auth_email,
  p.full_name,
  p.status
FROM public.channel_partners p
LEFT JOIN auth.users u ON u.id = p.user_id
WHERE p.status = 'active'
  AND p.user_id IS NOT NULL
  AND lower(coalesce(p.email,'')) <> lower(coalesce(u.email,''));
-- OK if 0 rows.


-- ── CHECK 5 — Existing duplicate agreement acceptances ─────────────────────
-- If a partner has accepted the same version twice already (audit item H4),
-- the Part 5 unique indexes on agreement_acceptances will fail to create.
--
--   ACTION if rows returned: keep the earliest acceptance, delete the
--   duplicates AFTER updating channel_partners.agreement_acceptance_id to
--   point to the surviving row.
SELECT
  '5a. Duplicate acceptances per partner+version' AS check_name,
  partner_id,
  agreement_version,
  COUNT(*) AS dup_count,
  array_agg(id ORDER BY accepted_at) AS acceptance_ids
FROM public.agreement_acceptances
WHERE partner_id IS NOT NULL
GROUP BY partner_id, agreement_version
HAVING COUNT(*) > 1;

SELECT
  '5b. Duplicate acceptances per enquiry+version' AS check_name,
  enquiry_id,
  agreement_version,
  COUNT(*) AS dup_count,
  array_agg(id ORDER BY accepted_at) AS acceptance_ids
FROM public.agreement_acceptances
WHERE enquiry_id IS NOT NULL
GROUP BY enquiry_id, agreement_version
HAVING COUNT(*) > 1;
-- OK if both queries return 0 rows.


-- ── CHECK 6 — Reservation status mismatch ──────────────────────────────────
-- The audit found the dashboard "Reserved" tile filters status='reserved'
-- but the edge function writes status='active'. Confirm the actual
-- distribution so we know what to fix client-side later.
SELECT
  '6. Reservation status distribution' AS check_name,
  status,
  COUNT(*) AS count
FROM public.reservations
GROUP BY status
ORDER BY count DESC;
-- INFORMATIONAL — confirms 'active' is the live status used.


-- ── CHECK 7 — channel_partners rows with no user_id ────────────────────────
-- Approved partners who have never logged in. After Part 6 they cannot read
-- their own row until they log in once and trigger the user_id self-heal.
-- Pre-launch they should all be invited; if the count is high, send the
-- invites BEFORE Phase 5.
SELECT
  '7. Active partners with no user_id (never logged in)' AS check_name,
  COUNT(*) AS count
FROM public.channel_partners
WHERE status = 'active' AND user_id IS NULL;


-- ── CHECK 8 — tpch_team rows missing the password column ───────────────────
-- The team migration file does not declare a password column, but the
-- audit found the client login reads one. Confirm whether it actually
-- exists, so Phase 7 cleanup knows whether the DROP COLUMN is needed.
SELECT
  '8. tpch_team password column exists?' AS check_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'tpch_team'
  AND column_name  = 'password';
-- INFORMATIONAL — 1 row = column exists (will be dropped in Part 7).
--                0 rows = column doesn't exist (Part 7 is a no-op).


-- ── CHECK 9 — Existing pg_policies that Part 6 will replace ────────────────
-- Cross-check that the policy names Part 6 drops actually match what's in
-- the database. If a policy was renamed manually in the dashboard, my DROP
-- IF EXISTS misses it and the old broad policy survives alongside the new
-- tight one.
SELECT
  '9. Current public-schema policies' AS check_name,
  tablename,
  policyname,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'tpch_team','channel_partners','partner_staff','pending_enquiries',
    'projects','stock','stock_listings','suburb_research','research_versions',
    'research_section_comments','project_analysis','reservations',
    'shortlists','shortlist_items','agents','agent_runs',
    'partner_deals','partner_notifications','deal_assignments',
    'agreement_acceptances'
  )
ORDER BY tablename, policyname;
-- INFORMATIONAL — review the list. Anything not named "Anon can ..." or one
-- of the *_service_role / *_authenticated patterns the existing migrations
-- use means Part 6's DROP IF EXISTS will miss it; add a manual DROP for it
-- before running Part 6.
