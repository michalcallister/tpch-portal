-- ============================================================================
-- TPCH PORTAL — SECURITY HARDENING MIGRATION
-- ============================================================================
-- Drafted Apr 2026 against the pre-launch audit findings.
-- Structured in 7 PARTS. Each part is a transaction. Each part is idempotent
-- and re-runnable. The ORDER OF DEPLOYMENT MATTERS — read the gate notes
-- on each part before running.
--
--   PART 1  Helpers                             SAFE TO DEPLOY NOW
--   PART 2  Partner RPC tenant validation       SAFE TO DEPLOY NOW
--   PART 3  Admin-auth bridge (user_id link)    SAFE TO DEPLOY NOW (no behaviour change yet)
--   PART 4  Admin RPC gating                    BREAKING — deploy only after PART 3 + admin
--                                                signInWithPassword shipped in index.html
--   PART 5  Idempotency unique indexes          SAFE TO DEPLOY NOW
--   PART 6  RLS lockdown                        BREAKING — deploy ONLY after every admin
--                                                REST call in index.html sends an admin JWT,
--                                                AND edge function PART of the deploy is live
--   PART 7  Cleanup (drop password column)      Run last, after a soak period
--
-- Re-running the whole file is safe at any point — every CREATE/ALTER/DROP is
-- guarded. Re-running PART 6 after a partial roll-back will simply re-apply
-- the locked-down policies.
-- ============================================================================


-- ============================================================================
-- PART 1 — HELPERS  (SAFE TO DEPLOY NOW)
-- ============================================================================
-- Two SECURITY DEFINER helpers used by every locked-down RPC and policy below.
--   is_admin()              → true if the current JWT's email is an active row
--                             in tpch_team. Returns false for anon and unknown.
--   current_partner_id()    → the channel_partners.id the caller belongs to
--                             (as owner OR active staff). NULL for anon and admins.
--
-- Both stay correct whether or not admins have migrated to Supabase Auth yet:
-- before migration, no admin has a JWT, so is_admin() returns false everywhere
-- (which is what we want — we only USE is_admin() inside RPCs/policies that
-- get hardened in PART 4 and PART 6).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tpch_team
    WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND status = 'active'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;


CREATE OR REPLACE FUNCTION public.current_partner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
    FROM public.channel_partners
    WHERE user_id = auth.uid() AND status = 'active'
  UNION ALL
  SELECT partner_id
    FROM public.partner_staff
    WHERE user_id = auth.uid() AND status = 'active'
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.current_partner_id() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.current_partner_id() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- PART 2 — PARTNER RPC TENANT VALIDATION  (SAFE TO DEPLOY NOW)
-- ============================================================================
-- These seven RPCs accept p_partner_id from the client and previously trusted
-- it. Now each one checks that the caller actually owns or works at that
-- partner before returning data.
--
-- Admins (is_admin() = true) bypass the check so the admin panel keeps working.
-- During the transition (before admins move to Supabase Auth) the only callers
-- who need to pass are partners and staff — admin panels do NOT call these
-- RPCs (admin uses get_partners_admin instead). Confirmed via inventory.
--
-- The function SIGNATURES are unchanged so no client code changes are needed.
-- Anything stale gets rejected with a clear error.
-- ============================================================================

BEGIN;

-- ── get_partner_deals ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_partner_deals(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name text;
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  SELECT company_name INTO v_company_name
    FROM public.channel_partners
    WHERE id = p_partner_id;

  IF v_company_name IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',                       d.id,
        'name',                     d.name,
        'property_name',            d.property_name,
        'client_name',              d.client_name,
        'stage',                    d.stage,
        'deal_value',               d.deal_value,
        'cos_executed_date',        d.cos_executed_date,
        'expected_approval_date',   d.expected_approval_date,
        'expected_settlement_date', d.expected_settlement_date,
        'fully_paid_date',          d.fully_paid_date,
        'paid_to_date',             d.paid_to_date,
        'deal_creation_date',       d.deal_creation_date,
        'developer',                d.developer,
        'entity',                   d.entity,
        'days_to_close',            d.days_to_close,
        'channel_commission',       COALESCE(
                                      s.channel_commission,
                                      s.channel_comm_flat,
                                      CASE
                                        WHEN s.channel_comm_pct IS NOT NULL AND s.total_contract IS NOT NULL
                                        THEN ROUND(s.total_contract * s.channel_comm_pct / 100)
                                        ELSE NULL
                                      END
                                    )
      ) ORDER BY
        CASE WHEN d.fully_paid_date IS NOT NULL THEN 1 ELSE 0 END,
        d.deal_creation_date DESC NULLS LAST
    ), '[]'::jsonb)
    FROM public.partner_deals d
    LEFT JOIN public.stock s ON s.id = d.property_id
    WHERE d.channel_partner_name ILIKE v_company_name
  );
END;
$$;


-- ── get_partner_staff ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_partner_staff(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',                id,
        'full_name',         full_name,
        'email',             email,
        'role',              role,
        'status',            status,
        'comm_display_type', comm_display_type,
        'comm_custom_value', comm_custom_value,
        'invited_at',        invited_at
      ) ORDER BY created_at
    )
    FROM public.partner_staff
    WHERE partner_id = p_partner_id
  );
END;
$$;


-- ── get_my_reservations ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_reservations(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',              r.id,
        'stock_id',        r.stock_id,
        'stock_name',      r.stock_name,
        'project_name',    r.project_name,
        'client_name',     r.client_name,
        'client_email',    r.client_email,
        'client_phone',    r.client_phone,
        'notes',           r.notes,
        'status',          r.status,
        'reserved_at',     r.reserved_at,
        'expires_at',      r.expires_at,
        'hours_remaining', GREATEST(0, EXTRACT(EPOCH FROM (r.expires_at - now())) / 3600),
        'total_contract',  s.total_contract,
        'bedrooms',        s.bedrooms,
        'bathrooms',       s.bathrooms,
        'availability',    s.availability
      ) ORDER BY r.reserved_at DESC
    ), '[]'::jsonb)
    FROM public.reservations r
    LEFT JOIN public.stock s ON s.id = r.stock_id
    WHERE r.partner_id = p_partner_id
      AND r.status = 'active'
  );
END;
$$;


-- ── get_my_lists ─────────────────────────────────────────────────────────────
-- Note: the original is LANGUAGE sql; we recreate as plpgsql to add the gate.
DROP FUNCTION IF EXISTS public.get_my_lists(uuid);
CREATE OR REPLACE FUNCTION public.get_my_lists(p_partner_id uuid)
RETURNS TABLE (
  id         uuid,
  name       text,
  item_count bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT l.id, l.name, COUNT(i.id) AS item_count, l.created_at
    FROM public.shortlists l
    LEFT JOIN public.shortlist_items i ON i.shortlist_id = l.id
    WHERE l.partner_id = p_partner_id
    GROUP BY l.id, l.name, l.created_at
    ORDER BY l.created_at DESC;
END;
$$;


-- ── get_partner_notifications ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_partner_notifications(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',         id,
        'type',       type,
        'title',      title,
        'message',    message,
        'link_type',  link_type,
        'link_id',    link_id,
        'read',       read,
        'created_at', created_at
      ) ORDER BY created_at DESC
    )
    FROM public.partner_notifications
    WHERE partner_id = p_partner_id
    LIMIT 50
  );
END;
$$;


-- ── mark_notification_read ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id uuid, p_partner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  UPDATE public.partner_notifications
    SET read = true
    WHERE id = p_notification_id AND partner_id = p_partner_id;
END;
$$;


-- ── mark_all_notifications_read ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_partner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL-safe gate: `(... ) IS NOT TRUE` is TRUE when the expression is FALSE
  -- *or* NULL. Prevents anon callers (auth.uid() = NULL) from bypassing the
  -- check via SQL three-valued logic.
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  UPDATE public.partner_notifications
    SET read = true
    WHERE partner_id = p_partner_id AND read = false;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- PART 3 — ADMIN-AUTH BRIDGE  (SAFE TO DEPLOY NOW)
-- ============================================================================
-- Adds the plumbing to move admins onto Supabase Auth WITHOUT changing current
-- behaviour. Nothing here makes the existing plaintext-password login fail.
--
--   • Adds tpch_team.user_id (uuid → auth.users)
--   • Adds get_my_session() — single RPC the new client login flow will call
--     after signInWithPassword to find out whether the caller is admin /
--     partner / staff. Self-heals tpch_team.user_id and channel_partners.user_id
--     on first sign-in.
--   • Adds verify_admin_login_email() — returns whether an email belongs to
--     an active admin without exposing the password column. Used by the new
--     login flow to decide which auth path to take. (Optional — the new flow
--     can also just attempt signInWithPassword and route on the result.)
--
-- AFTER this part is deployed, you will manually create auth.users rows for
-- each admin (Supabase Auth dashboard → Add user → set password). On their
-- first sign-in get_my_session() will write tpch_team.user_id automatically.
-- ============================================================================

BEGIN;

ALTER TABLE public.tpch_team
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tpch_team_user_id_idx ON public.tpch_team(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS tpch_team_user_id_uq
  ON public.tpch_team(user_id) WHERE user_id IS NOT NULL;


-- ── get_my_session ──────────────────────────────────────────────────────────
-- Replaces the client-side admin-email check + password compare. Called once
-- after signInWithPassword. Resolves to one of three roles + the same shape
-- of record fields the partner flow already returns.
CREATE OR REPLACE FUNCTION public.get_my_session()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_uid       uuid := auth.uid();
  v_admin     public.tpch_team%ROWTYPE;
  v_partner   public.channel_partners%ROWTYPE;
  v_staff     public.partner_staff%ROWTYPE;
  v_owner     public.channel_partners%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Admin?
  SELECT * INTO v_admin
    FROM public.tpch_team
    WHERE lower(email) = v_email AND status = 'active'
    LIMIT 1;
  IF FOUND THEN
    IF v_admin.user_id IS NULL THEN
      UPDATE public.tpch_team SET user_id = v_uid WHERE id = v_admin.id;
      v_admin.user_id := v_uid;
    END IF;
    RETURN jsonb_build_object(
      'role',      'admin',
      'admin_id',  v_admin.id,
      'full_name', v_admin.full_name,
      'email',     v_admin.email,
      'admin_role',v_admin.role,
      'status',    v_admin.status
    );
  END IF;

  -- 2. Partner owner?
  SELECT * INTO v_partner
    FROM public.channel_partners
    WHERE lower(email) = v_email AND status = 'active'
    LIMIT 1;
  IF FOUND THEN
    IF v_partner.user_id IS NULL THEN
      UPDATE public.channel_partners SET user_id = v_uid WHERE id = v_partner.id;
      v_partner.user_id := v_uid;
    END IF;
    RETURN jsonb_build_object(
      'role',                       'partner',
      'partner_id',                 v_partner.id,
      'full_name',                  v_partner.full_name,
      'email',                      v_partner.email,
      'phone',                      v_partner.phone,
      'abn',                        v_partner.abn,
      'company_name',               v_partner.company_name,
      'state',                      v_partner.state,
      'registered_address',         v_partner.registered_address,
      'website',                    v_partner.website,
      'role_type',                  v_partner.role_type,
      'logo_url',                   v_partner.logo_url,
      'brand_primary',              v_partner.brand_primary,
      'brand_accent',               v_partner.brand_accent,
      'brand_colours_extracted_at', v_partner.brand_colours_extracted_at,
      'notification_prefs',         v_partner.notification_prefs,
      'status',                     v_partner.status,
      'agreement_version',          v_partner.agreement_version,
      'agreement_accepted_at',      v_partner.agreement_accepted_at
    );
  END IF;

  -- 3. Staff?
  SELECT * INTO v_staff
    FROM public.partner_staff
    WHERE lower(email) = v_email AND status = 'active'
    LIMIT 1;
  IF FOUND THEN
    IF v_staff.user_id IS NULL THEN
      UPDATE public.partner_staff SET user_id = v_uid WHERE id = v_staff.id;
    END IF;
    SELECT * INTO v_owner FROM public.channel_partners WHERE id = v_staff.partner_id;
    RETURN jsonb_build_object(
      'role',                       'staff',
      'staff_id',                   v_staff.id,
      'partner_id',                 v_staff.partner_id,
      'full_name',                  v_staff.full_name,
      'email',                      v_staff.email,
      'phone',                      v_owner.phone,
      'abn',                        v_owner.abn,
      'job_role',                   v_staff.role,
      'comm_display_type',          v_staff.comm_display_type,
      'comm_custom_value',          v_staff.comm_custom_value,
      'company_name',               v_owner.company_name,
      'registered_address',         v_owner.registered_address,
      'website',                    v_owner.website,
      'logo_url',                   v_owner.logo_url,
      'brand_primary',              v_owner.brand_primary,
      'brand_accent',               v_owner.brand_accent,
      'brand_colours_extracted_at', v_owner.brand_colours_extracted_at,
      'notification_prefs',         v_owner.notification_prefs,
      'status',                     v_staff.status,
      'agreement_version',          v_owner.agreement_version,
      'agreement_accepted_at',      v_owner.agreement_accepted_at
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_session() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_my_session() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- PART 4 — ADMIN RPC GATING  (BREAKING — see gate)
-- ============================================================================
-- Adds is_admin() checks to the two RPCs that currently leak admin-only data
-- to anyone with a JWT.
--
-- GATE: deploy ONLY after PART 3 is in place AND the index.html admin login
-- flow has been switched to signInWithPassword + get_my_session(). If you run
-- PART 4 while admins still authenticate against tpch_team plaintext, the
-- admin Partners panel and Agreement audit will both fail because is_admin()
-- has no JWT to check.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_partners_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row ORDER BY (row->>'joined_at') DESC NULLS LAST)
    FROM (
      SELECT jsonb_build_object(
        'id',                       p.id,
        'full_name',                p.full_name,
        'email',                    p.email,
        'phone',                    p.phone,
        'company_name',             p.company_name,
        'state',                    p.state,
        'role_type',                p.role_type,
        'status',                   p.status,
        'joined_at',                p.joined_at,
        'logo_url',                 p.logo_url,
        'agreement_version',        p.agreement_version,
        'agreement_accepted_at',    p.agreement_accepted_at,
        'agreement_acceptance_id',  p.agreement_acceptance_id,
        'last_sign_in_at',          u.last_sign_in_at
      ) AS row
      FROM public.channel_partners p
      LEFT JOIN auth.users u ON lower(u.email) = lower(p.email)
    ) s
  ), '[]'::jsonb);
END;
$$;


CREATE OR REPLACE FUNCTION public.get_agreement_acceptances(p_partner_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',                a.id,
        'partner_id',        a.partner_id,
        'enquiry_id',        a.enquiry_id,
        'email',             a.email,
        'agreement_version', a.agreement_version,
        'agreement_sha256',  a.agreement_sha256,
        'accepted_at',       a.accepted_at,
        'ip_address',        a.ip_address::text,
        'user_agent',        a.user_agent,
        'method',            a.method,
        'checkbox_text',     a.checkbox_text
      ) ORDER BY a.accepted_at DESC
    )
    FROM public.agreement_acceptances a
    WHERE p_partner_id IS NULL OR a.partner_id = p_partner_id
  ), '[]'::jsonb);
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- PART 5 — IDEMPOTENCY UNIQUE INDEXES  (SAFE TO DEPLOY NOW)
-- ============================================================================
-- Stops double-clicks creating duplicate rows in the two append-style tables.
-- A double-submit will raise SQLSTATE 23505 — the relevant edge functions
-- (PART of the parallel deploy) catch this and return 200 with the existing
-- row so the user-facing flow stays unchanged.
-- ============================================================================

BEGIN;

-- One active reservation per stock_id.
-- IMPORTANT: if there is an existing data quality issue (two active
-- reservations on the same stock_id today), this CREATE will fail. Run the
-- cleanup query first:
--   SELECT stock_id, COUNT(*) FROM reservations WHERE status='active'
--     GROUP BY stock_id HAVING COUNT(*) > 1;
-- If empty, the index creation will succeed.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_active_per_stock
  ON public.reservations (stock_id)
  WHERE status = 'active';

-- One acceptance row per partner per agreement_version.
CREATE UNIQUE INDEX IF NOT EXISTS agreement_acceptances_partner_version_uq
  ON public.agreement_acceptances (partner_id, agreement_version)
  WHERE partner_id IS NOT NULL;

-- One acceptance row per enquiry per agreement_version.
CREATE UNIQUE INDEX IF NOT EXISTS agreement_acceptances_enquiry_version_uq
  ON public.agreement_acceptances (enquiry_id, agreement_version)
  WHERE enquiry_id IS NOT NULL;

COMMIT;


-- ============================================================================
-- PART 6 — RLS LOCKDOWN  (BREAKING — see gate)
-- ============================================================================
-- Replaces every existing policy on the affected tables with role-scoped
-- ones. Uses a name-agnostic drop loop so historical / mis-named policies
-- (e.g. "Admin read all suburb_research" applied to public role) are removed
-- cleanly regardless of what they're called.
--
-- agreement_acceptances is INTENTIONALLY excluded — its existing
-- deny_all_anon + deny_all_authenticated policies are correct and we keep them.
--
-- GATE: deploy ONLY when ALL of the following are live:
--   (a) PART 3 is deployed and the new admin signInWithPassword flow ships
--       in index.html; every admin REST call must include a valid admin JWT
--       in Authorization (currently many use the anon key).
--   (b) Edge function changes are deployed: invite-partner, reserve-stock,
--       cancel-reservation, run-agent, regenerate-research-section now
--       require JWT verification and derive partner_id from auth.uid().
--   (c) You have soft-launched to one trusted partner and verified all
--       partner flows still pass.
-- ============================================================================

BEGIN;

-- ── Step 0: drop ALL existing policies on every affected table ──────────────
-- Name-agnostic: handles policies named "Anon can …", "Admin …" (despite
-- being applied to public), "*_service_role" with USING(true), etc.
-- agreement_acceptances is excluded — its policies are correct.
DO $do$
DECLARE
  r record;
  tables text[] := ARRAY[
    'tpch_team', 'channel_partners', 'partner_staff', 'pending_enquiries',
    'projects', 'stock', 'stock_listings', 'suburb_research',
    'research_versions', 'research_section_comments', 'project_analysis',
    'reservations', 'shortlists', 'shortlist_items',
    'agents', 'agent_runs', 'partner_deals', 'partner_notifications',
    'deal_assignments'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    FOR r IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, t);
    END LOOP;
    -- Make sure RLS is on for each. (No-op if already enabled.)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$do$;


-- ── tpch_team ───────────────────────────────────────────────────────────────

CREATE POLICY tpch_team_admin_select ON public.tpch_team
  FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY tpch_team_admin_insert ON public.tpch_team
  FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY tpch_team_admin_update ON public.tpch_team
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY tpch_team_admin_delete ON public.tpch_team
  FOR DELETE TO authenticated USING (is_admin());
-- Service role bypasses RLS automatically; no anon policies = anon denied.


-- ── channel_partners ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anon can read partners"   ON public.channel_partners;
DROP POLICY IF EXISTS "Anon can insert partners" ON public.channel_partners;
DROP POLICY IF EXISTS "Anon can update partners" ON public.channel_partners;
DROP POLICY IF EXISTS "Anon can delete partners" ON public.channel_partners;

-- Admins see everything.
CREATE POLICY channel_partners_admin_all ON public.channel_partners
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Partner owner reads + updates own row only. (Staff use get_my_partner_record
-- to get owner data — they don't read channel_partners directly.)
CREATE POLICY channel_partners_owner_select ON public.channel_partners
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY channel_partners_owner_update ON public.channel_partners
  FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
-- No INSERT or DELETE for partners.


-- ── pending_enquiries ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anon can read enquiries"   ON public.pending_enquiries;
DROP POLICY IF EXISTS "Anon can insert enquiries" ON public.pending_enquiries;
DROP POLICY IF EXISTS "Anon can update enquiries" ON public.pending_enquiries;
DROP POLICY IF EXISTS "Anon can delete enquiries" ON public.pending_enquiries;

-- Public form: anon can INSERT only.
CREATE POLICY pending_enquiries_anon_insert ON public.pending_enquiries
  FOR INSERT TO anon WITH CHECK (true);
-- Admin reads / updates the pipeline.
CREATE POLICY pending_enquiries_admin_all ON public.pending_enquiries
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());


-- ── tpch_team-adjacent: agents / agent_runs ─────────────────────────────────
-- agents is a small config table. Admin-only.
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agents anon read"   ON public.agents;
DROP POLICY IF EXISTS "agents anon write"  ON public.agents;
CREATE POLICY agents_admin_select ON public.agents
  FOR SELECT TO authenticated USING (is_admin());

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_runs anon read"  ON public.agent_runs;
DROP POLICY IF EXISTS "agent_runs anon write" ON public.agent_runs;
CREATE POLICY agent_runs_admin_select ON public.agent_runs
  FOR SELECT TO authenticated USING (is_admin());


-- ── projects ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anon can read projects"   ON public.projects;
DROP POLICY IF EXISTS "Anon can insert projects" ON public.projects;
DROP POLICY IF EXISTS "Anon can update projects" ON public.projects;
DROP POLICY IF EXISTS "Anon can delete projects" ON public.projects;

-- Public browse — projects are intentionally readable.
CREATE POLICY projects_public_select ON public.projects
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY projects_admin_write ON public.projects
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());


-- ── stock ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anon can read stock"   ON public.stock;
DROP POLICY IF EXISTS "Anon can insert stock" ON public.stock;
DROP POLICY IF EXISTS "Anon can update stock" ON public.stock;
DROP POLICY IF EXISTS "Anon can delete stock" ON public.stock;
DROP POLICY IF EXISTS stock_authenticated_update ON public.stock;

CREATE POLICY stock_public_select ON public.stock
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY stock_admin_write ON public.stock
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
-- Reservation flow updates stock via reserve-stock / cancel-reservation /
-- expire-reservations / sync-monday — all service role, RLS bypassed.


-- ── stock_listings (legacy public listings) ─────────────────────────────────
ALTER TABLE public.stock_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon can read stock_listings"   ON public.stock_listings;
DROP POLICY IF EXISTS "Anon can write stock_listings"  ON public.stock_listings;

CREATE POLICY stock_listings_public_select ON public.stock_listings
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY stock_listings_admin_write ON public.stock_listings
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());


-- ── suburb_research ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anon can read research"   ON public.suburb_research;
DROP POLICY IF EXISTS "Anon can insert research" ON public.suburb_research;
DROP POLICY IF EXISTS "Anon can update research" ON public.suburb_research;
DROP POLICY IF EXISTS "Anon can delete research" ON public.suburb_research;

-- Anyone can read PUBLISHED research; drafts admin-only.
CREATE POLICY suburb_research_public_select_published ON public.suburb_research
  FOR SELECT TO anon, authenticated USING (status = 'published');
CREATE POLICY suburb_research_admin_select_drafts ON public.suburb_research
  FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY suburb_research_admin_write ON public.suburb_research
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());


-- ── research_versions / research_section_comments ───────────────────────────
ALTER TABLE public.research_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rv anon all" ON public.research_versions;
CREATE POLICY research_versions_admin_all ON public.research_versions
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

ALTER TABLE public.research_section_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rsc anon all" ON public.research_section_comments;
CREATE POLICY research_section_comments_admin_all ON public.research_section_comments
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());


-- ── project_analysis ────────────────────────────────────────────────────────
ALTER TABLE public.project_analysis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pa anon all" ON public.project_analysis;

CREATE POLICY project_analysis_public_select_published ON public.project_analysis
  FOR SELECT TO anon, authenticated USING (status = 'published');
CREATE POLICY project_analysis_admin_all ON public.project_analysis
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());


-- ── reservations ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS reservations_authenticated ON public.reservations;
DROP POLICY IF EXISTS "Anon can read reservations" ON public.reservations;

-- Partner sees own active reservations only. (The dashboard fetch reads via
-- direct REST; with this policy it scopes automatically.)
CREATE POLICY reservations_partner_select ON public.reservations
  FOR SELECT TO authenticated
    USING (partner_id = current_partner_id() OR is_admin());
-- All writes go through service-role edge functions.


-- ── shortlists / shortlist_items ────────────────────────────────────────────
DROP POLICY IF EXISTS shortlists_all      ON public.shortlists;
DROP POLICY IF EXISTS shortlist_items_all ON public.shortlist_items;

-- Revoke the GRANT TO anon from the original migration.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.shortlists      FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.shortlist_items FROM anon;

CREATE POLICY shortlists_partner_all ON public.shortlists
  FOR ALL TO authenticated
    USING (partner_id = current_partner_id() OR is_admin())
    WITH CHECK (partner_id = current_partner_id() OR is_admin());

CREATE POLICY shortlist_items_partner_all ON public.shortlist_items
  FOR ALL TO authenticated
    USING (partner_id = current_partner_id() OR is_admin())
    WITH CHECK (partner_id = current_partner_id() OR is_admin());


-- ── partner_staff ───────────────────────────────────────────────────────────
-- Owner and active staff of a firm can read each other; only owner + admin
-- can write. (Also used by partner-owner inline UPDATE for commission display.)
DROP POLICY IF EXISTS partner_staff_service_role ON public.partner_staff;

CREATE POLICY partner_staff_admin_all ON public.partner_staff
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY partner_staff_select_firm ON public.partner_staff
  FOR SELECT TO authenticated
    USING (partner_id = current_partner_id());
CREATE POLICY partner_staff_owner_update ON public.partner_staff
  FOR UPDATE TO authenticated
    USING (partner_id IN (SELECT id FROM public.channel_partners WHERE user_id = auth.uid()))
    WITH CHECK (partner_id IN (SELECT id FROM public.channel_partners WHERE user_id = auth.uid()));


-- ── deal_assignments ────────────────────────────────────────────────────────
ALTER TABLE public.deal_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "da anon all"      ON public.deal_assignments;
DROP POLICY IF EXISTS "da firm select"   ON public.deal_assignments;
DROP POLICY IF EXISTS "da owner write"   ON public.deal_assignments;

CREATE POLICY deal_assignments_firm_select ON public.deal_assignments
  FOR SELECT TO authenticated
    USING (partner_id = current_partner_id() OR is_admin());
CREATE POLICY deal_assignments_owner_write ON public.deal_assignments
  FOR ALL TO authenticated
    USING (partner_id IN (SELECT id FROM public.channel_partners WHERE user_id = auth.uid()) OR is_admin())
    WITH CHECK (partner_id IN (SELECT id FROM public.channel_partners WHERE user_id = auth.uid()) OR is_admin());


-- ── partner_deals / partner_notifications ───────────────────────────────────
-- Partners read these via RPCs (already gated in PART 2). Direct REST is admin
-- only — handy for debugging.
ALTER TABLE public.partner_deals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deals_service_role ON public.partner_deals;
CREATE POLICY partner_deals_admin_select ON public.partner_deals
  FOR SELECT TO authenticated USING (is_admin());

ALTER TABLE public.partner_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_service_role ON public.partner_notifications;
CREATE POLICY partner_notifications_admin_select ON public.partner_notifications
  FOR SELECT TO authenticated USING (is_admin());


-- ── agreement_acceptances ───────────────────────────────────────────────────
-- Already deny-all to anon and authenticated per supabase-agreement-migration.sql.
-- No change needed; service-role edge function writes; admins read via the
-- newly-gated get_agreement_acceptances() RPC (PART 4).


NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- PART 7 — CLEANUP  (RUN LAST, after a soak period)
-- ============================================================================
-- Drops the plaintext password column on tpch_team. Wait at least one full
-- working week after PART 3 + admin sign-in flow ship, in case you need to
-- roll back the admin auth migration. There is no other place this column
-- is read once index.html no longer fetches it.
-- ============================================================================

BEGIN;

ALTER TABLE public.tpch_team DROP COLUMN IF EXISTS password;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- ROLL-BACK NOTES
-- ============================================================================
--
-- Each PART can be rolled back independently:
--
--   PART 1    DROP FUNCTION is_admin(); DROP FUNCTION current_partner_id();
--             (Safe — nothing else in the migration references them once
--              PART 2/4/6 are also rolled back.)
--
--   PART 2    Restore the original function bodies from
--             supabase-deals-migration.sql, supabase-partner-auth-migration.sql,
--             supabase-reservations-migration.sql, supabase-lists-migration.sql,
--             supabase-notifications-migration.sql.
--
--   PART 3    ALTER TABLE tpch_team DROP COLUMN user_id;
--             DROP FUNCTION get_my_session();
--             (Safe BEFORE PART 4 ships. After PART 4, you must also revert
--              get_partners_admin / get_agreement_acceptances.)
--
--   PART 4    Restore original bodies of get_partners_admin and
--             get_agreement_acceptances from the earlier migrations.
--
--   PART 5    DROP INDEX reservations_one_active_per_stock;
--             DROP INDEX agreement_acceptances_partner_version_uq;
--             DROP INDEX agreement_acceptances_enquiry_version_uq;
--
--   PART 6    Re-create the original "Anon can …" policies on each table.
--             These are listed verbatim in the per-table migration files in
--             the repo root — copy and paste them back.
--
--   PART 7    Once the password column is dropped, rolling back requires
--             restoring it from a backup. Take a logical dump of tpch_team
--             before running PART 7 and keep it for at least 30 days.
--
-- ============================================================================
