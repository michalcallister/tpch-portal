-- ============================================================================
-- TPCH — partner_staff.status default fix
-- Applied 2026-05-25
-- Idempotent — safe to re-run
-- ============================================================================
-- At some point post-2026-04-14 the live default for public.partner_staff.status
-- was changed from 'active' (per supabase-partner-auth-migration.sql) to
-- 'invited'. That silently broke every newly-invited staff member:
--
--   1. invite-partner edge function inserts the partner_staff row without
--      setting status, so the row lands as status='invited'.
--   2. The user receives the invite email, sets a password, signs in to
--      Supabase Auth successfully.
--   3. The portal calls get_my_session() (in supabase-security-hardening.sql).
--      That RPC and get_my_partner_record() both filter
--      `WHERE lower(email) = v_email AND status = 'active'`, so they return
--      NULL for the new staff row.
--   4. The portal shows "Your account is not authorised for this portal.
--      Contact admin@tpch.com.au".
--
-- The "hasn't logged in yet" signal is already expressed by user_id IS NULL
-- (the same RPCs self-heal user_id on first sign-in), so 'invited' as a
-- column default served no purpose and only locked people out.
--
-- This migration restores the original DEFAULT and is the single source of
-- truth for the partner_staff.status default going forward.
-- ============================================================================

ALTER TABLE public.partner_staff
  ALTER COLUMN status SET DEFAULT 'active';
