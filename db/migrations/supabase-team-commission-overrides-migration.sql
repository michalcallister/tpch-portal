-- ============================================================
-- TPCH Team Commission Override Migration
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
-- ============================================================
-- Per-(staff, project) dollar deduction. Owner configures, per team member,
-- a dollar amount to subtract from what that staff sees per project. Gated by
-- a per-partner feature flag (team_commission_override_enabled on
-- channel_partners) so the capability is only available to enabled firms.
--
-- DEPLOYMENT — run BOTH of these in the SQL Editor, in order:
--   1. This file (creates flag column, table, RPCs, trigger guard).
--   2. supabase-partner-auth-migration.sql (re-runs get_my_partner_record so
--      the flag flows to the SPA session payload). Already a CREATE OR REPLACE.
-- ============================================================

BEGIN;

-- 1. Feature flag on channel_partners (per-partner gate for the capability)
ALTER TABLE public.channel_partners
  ADD COLUMN IF NOT EXISTS team_commission_override_enabled boolean NOT NULL DEFAULT false;

-- 2. Per-(staff, project) deduction table
CREATE TABLE IF NOT EXISTS public.staff_project_commission_overrides (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         uuid        NOT NULL REFERENCES public.partner_staff(id) ON DELETE CASCADE,
  project_id       text        NOT NULL REFERENCES public.projects(id)      ON DELETE CASCADE,
  deduction_amount numeric     NOT NULL CHECK (deduction_amount >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        REFERENCES auth.users(id),
  UNIQUE (staff_id, project_id)
);

CREATE INDEX IF NOT EXISTS spco_staff_idx   ON public.staff_project_commission_overrides (staff_id);
CREATE INDEX IF NOT EXISTS spco_project_idx ON public.staff_project_commission_overrides (project_id);

-- SELECT grant (RLS still filters rows); writes are RPC-only.
GRANT SELECT ON public.staff_project_commission_overrides TO authenticated;

ALTER TABLE public.staff_project_commission_overrides ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'staff_project_commission_overrides'
       AND policyname = 'spco_select_self_or_owner'
  ) THEN
    -- Staff read their own rows; partner owners read all rows for any of their staff.
    CREATE POLICY spco_select_self_or_owner
      ON public.staff_project_commission_overrides FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.partner_staff ps
           WHERE ps.id = staff_id
             AND (ps.user_id = auth.uid()
                  OR ps.partner_id = public.current_partner_id())
        )
      );
  END IF;
END $$;

-- 3. Read RPC for the logged-in staff member.
--    Returns {project_id: deduction_amount} map. Empty when caller isn't staff
--    or partner's flag is off. Both gates here keep the SPA loader cheap.
CREATE OR REPLACE FUNCTION public.get_my_staff_commission_overrides()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id   uuid;
  v_partner_id uuid;
  v_flag       boolean;
BEGIN
  SELECT id, partner_id INTO v_staff_id, v_partner_id
    FROM public.partner_staff
   WHERE user_id = auth.uid() AND status = 'active'
   LIMIT 1;
  IF v_staff_id IS NULL THEN RETURN '{}'::jsonb; END IF;

  SELECT team_commission_override_enabled INTO v_flag
    FROM public.channel_partners WHERE id = v_partner_id;
  IF NOT COALESCE(v_flag, false) THEN RETURN '{}'::jsonb; END IF;

  RETURN COALESCE(
    (SELECT jsonb_object_agg(project_id, deduction_amount)
       FROM public.staff_project_commission_overrides
      WHERE staff_id = v_staff_id),
    '{}'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_staff_commission_overrides() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_my_staff_commission_overrides() TO authenticated;

-- 4. Owner-only read RPC — populate the per-staff edit modal.
CREATE OR REPLACE FUNCTION public.get_staff_commission_overrides_for_owner(p_staff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid              uuid := public.current_partner_id();
  v_owner_uid        uuid;
  v_staff_partner_id uuid;
BEGIN
  IF v_pid IS NULL THEN
    RAISE EXCEPTION 'no partner context' USING ERRCODE = '42501';
  END IF;
  SELECT user_id INTO v_owner_uid FROM public.channel_partners WHERE id = v_pid;
  IF v_owner_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden — owner only' USING ERRCODE = '42501';
  END IF;
  SELECT partner_id INTO v_staff_partner_id FROM public.partner_staff WHERE id = p_staff_id;
  IF v_staff_partner_id IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'staff member not in your firm' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(
    (SELECT jsonb_object_agg(project_id, deduction_amount)
       FROM public.staff_project_commission_overrides
      WHERE staff_id = p_staff_id),
    '{}'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_staff_commission_overrides_for_owner(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_staff_commission_overrides_for_owner(uuid) TO authenticated;

-- 5. Owner-only write RPC: upsert/delete per (staff, project). p_deduction<=0 deletes.
CREATE OR REPLACE FUNCTION public.set_staff_commission_override(
  p_staff_id   uuid,
  p_project_id text,
  p_deduction  numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid              uuid := public.current_partner_id();
  v_owner_uid        uuid;
  v_flag             boolean;
  v_staff_partner_id uuid;
  v_row              public.staff_project_commission_overrides%ROWTYPE;
BEGIN
  IF v_pid IS NULL THEN
    RAISE EXCEPTION 'no partner context' USING ERRCODE = '42501';
  END IF;
  SELECT user_id, team_commission_override_enabled INTO v_owner_uid, v_flag
    FROM public.channel_partners WHERE id = v_pid;
  IF v_owner_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden — owner only' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(v_flag, false) THEN
    RAISE EXCEPTION 'team commission overrides not enabled for this partner'
      USING ERRCODE = '42501';
  END IF;
  IF p_staff_id IS NULL OR p_project_id IS NULL OR p_project_id = '' THEN
    RAISE EXCEPTION 'p_staff_id and p_project_id required' USING ERRCODE = '22023';
  END IF;
  SELECT partner_id INTO v_staff_partner_id FROM public.partner_staff WHERE id = p_staff_id;
  IF v_staff_partner_id IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'staff member not in your firm' USING ERRCODE = '42501';
  END IF;

  IF p_deduction IS NULL OR p_deduction <= 0 THEN
    DELETE FROM public.staff_project_commission_overrides
     WHERE staff_id = p_staff_id AND project_id = p_project_id;
    RETURN NULL;
  END IF;

  INSERT INTO public.staff_project_commission_overrides
        (staff_id, project_id, deduction_amount, updated_at, updated_by)
  VALUES (p_staff_id, p_project_id, p_deduction, now(), auth.uid())
  ON CONFLICT (staff_id, project_id) DO UPDATE
     SET deduction_amount = EXCLUDED.deduction_amount,
         updated_at       = now(),
         updated_by       = auth.uid()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id',               v_row.id,
    'staff_id',         v_row.staff_id,
    'project_id',       v_row.project_id,
    'deduction_amount', v_row.deduction_amount,
    'updated_at',       v_row.updated_at
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_staff_commission_override(uuid, text, numeric) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_staff_commission_override(uuid, text, numeric) TO authenticated;

-- 6. Admin-only RPC — flip the per-partner feature flag (used by the
--    super-admin toggle in the Partners admin page).
CREATE OR REPLACE FUNCTION public.admin_set_team_commission_override_enabled(
  p_partner_id uuid,
  p_enabled    boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.channel_partners
     SET team_commission_override_enabled = COALESCE(p_enabled, false),
         updated_at = now()
   WHERE id = p_partner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner not found' USING ERRCODE = '02000';
  END IF;
  RETURN COALESCE(p_enabled, false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_set_team_commission_override_enabled(uuid, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_set_team_commission_override_enabled(uuid, boolean) TO authenticated;

-- 7. BEFORE-UPDATE trigger so a partner owner can't flip their own flag via
--    raw REST. NOT SECURITY DEFINER (so current_user reflects the actual
--    executing role, not the function owner). Trusted Postgres roles bypass;
--    authenticated callers must have an admin JWT.
CREATE OR REPLACE FUNCTION public.guard_team_commission_override_enabled_flag()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.team_commission_override_enabled IS NOT DISTINCT FROM OLD.team_commission_override_enabled THEN
    RETURN NEW;
  END IF;
  IF current_user IN ('postgres','service_role','supabase_admin','supabase_auth_admin') THEN
    RETURN NEW;
  END IF;
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'team_commission_override_enabled can only be changed by an admin'
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS guard_tco_flag ON public.channel_partners;
CREATE TRIGGER guard_tco_flag
  BEFORE UPDATE OF team_commission_override_enabled
  ON public.channel_partners
  FOR EACH ROW EXECUTE FUNCTION public.guard_team_commission_override_enabled_flag();

-- 8. Extend get_partner_deals to surface project_id (commOf looks up the
--    deduction by project, so deals need to carry the project id).
CREATE OR REPLACE FUNCTION public.get_partner_deals(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name text;
BEGIN
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  SELECT company_name INTO v_company_name FROM public.channel_partners WHERE id = p_partner_id;
  IF v_company_name IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',                       d.id,
        'name',                     d.name,
        'property_id',              d.property_id,
        'project_id',               s.project_id,
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

REVOKE EXECUTE ON FUNCTION public.get_partner_deals(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_partner_deals(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Enabling for a specific partner is done via the super-admin toggle in
-- the Partners admin page, or directly:
--   UPDATE public.channel_partners
--      SET team_commission_override_enabled = true
--    WHERE id = '<partner_uuid>';
-- ============================================================
