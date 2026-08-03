-- ============================================================
-- TPCH — Flat-fee staff see new projects automatically
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
-- ============================================================
-- BACKGROUND
--
-- supabase-team-commission-overrides-migration.sql made project visibility
-- row-presence based for staff under a flagged partner: no row in
-- staff_project_commission_overrides = hidden. That is correct for staff who
-- see real commission figures ('portal') — the owner should decide the team
-- rate before the stock appears — but it traps staff on a fixed dollar
-- display ('custom' with a value). They see the same flat fee on every
-- listing regardless, so there is nothing for the owner to approve, yet every
-- newly added project stayed invisible to them until someone re-ticked it by
-- hand. In practice that meant a project could sit live for weeks unseen.
--
-- NEW RULE (owner-facing behaviour):
--   * comm_display_type = 'custom' with a value (flat fee)
--       → absent row means VISIBLE. New projects show the moment they go live.
--         The owner hides one by explicitly unticking it.
--   * comm_display_type = 'portal' (real commission) or 'hidden'
--       → unchanged. Absent row still means hidden: approval basis.
--
-- The default itself is applied client-side in index.html (staffProjectsDefaultVisible /
-- isProjectVisibleToStaff), because the client already holds the staff
-- member's comm_display_type. What this migration fixes is the write path:
-- an explicit untick used to DELETE the row when there was no deduction on
-- it, and under the new rule a deleted row reads as visible again — so the
-- hide would silently undo itself. Visibility is now always persisted.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Single-project visibility setter.
--    Untick now writes visible=false instead of deleting the row, so an
--    explicit hide survives for flat-fee staff. For 'portal' / 'hidden'
--    staff a visible=false row and an absent row mean the same thing, so
--    this is behaviour-neutral for them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_staff_project_visibility(
  p_staff_id   uuid,
  p_project_id text,
  p_visible    boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_pid              uuid := public.current_partner_id();
  v_owner_uid        uuid;
  v_flag             boolean;
  v_staff_partner_id uuid;
  v_row              public.staff_project_commission_overrides%ROWTYPE;
BEGIN
  IF v_pid IS NULL THEN RAISE EXCEPTION 'no partner context' USING ERRCODE = '42501'; END IF;
  SELECT user_id, team_commission_override_enabled INTO v_owner_uid, v_flag
    FROM public.channel_partners WHERE id = v_pid;
  IF v_owner_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden — owner only' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(v_flag, false) THEN
    RAISE EXCEPTION 'team commission overrides not enabled for this partner' USING ERRCODE = '42501';
  END IF;
  IF p_staff_id IS NULL OR p_project_id IS NULL OR p_project_id = '' THEN
    RAISE EXCEPTION 'p_staff_id and p_project_id required' USING ERRCODE = '22023';
  END IF;
  SELECT partner_id INTO v_staff_partner_id FROM public.partner_staff WHERE id = p_staff_id;
  IF v_staff_partner_id IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'staff member not in your firm' USING ERRCODE = '42501';
  END IF;

  -- Upsert either way. Creating a row keeps deduction at 0; an existing
  -- deduction is preserved so hiding then re-showing doesn't lose the rate.
  INSERT INTO public.staff_project_commission_overrides
        (staff_id, project_id, deduction_amount, visible, updated_at, updated_by)
  VALUES (p_staff_id, p_project_id, 0, COALESCE(p_visible, false), now(), auth.uid())
  ON CONFLICT (staff_id, project_id) DO UPDATE
     SET visible    = COALESCE(p_visible, false),
         updated_at = now(),
         updated_by = auth.uid()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('project_id', v_row.project_id, 'd', v_row.deduction_amount, 'v', v_row.visible);
END $$;

REVOKE EXECUTE ON FUNCTION public.set_staff_project_visibility(uuid, text, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_staff_project_visibility(uuid, text, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 2. Bulk setter (Show All / Hide All).
--    Hide All now writes an explicit visible=false row for every live
--    project rather than deleting the zero-deduction ones, for the same
--    reason. Deductions are preserved on both paths.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_staff_all_projects_visible(
  p_staff_id uuid,
  p_visible  boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_pid              uuid := public.current_partner_id();
  v_owner_uid        uuid;
  v_flag             boolean;
  v_staff_partner_id uuid;
  v_target           boolean := COALESCE(p_visible, false);
  v_count            integer;
BEGIN
  IF v_pid IS NULL THEN RAISE EXCEPTION 'no partner context' USING ERRCODE = '42501'; END IF;
  SELECT user_id, team_commission_override_enabled INTO v_owner_uid, v_flag
    FROM public.channel_partners WHERE id = v_pid;
  IF v_owner_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden — owner only' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(v_flag, false) THEN
    RAISE EXCEPTION 'team commission overrides not enabled for this partner' USING ERRCODE = '42501';
  END IF;
  IF p_staff_id IS NULL THEN
    RAISE EXCEPTION 'p_staff_id required' USING ERRCODE = '22023';
  END IF;
  SELECT partner_id INTO v_staff_partner_id FROM public.partner_staff WHERE id = p_staff_id;
  IF v_staff_partner_id IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'staff member not in your firm' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.staff_project_commission_overrides
        (staff_id, project_id, deduction_amount, visible, updated_at, updated_by)
  SELECT p_staff_id, vp.project_id, 0, v_target, now(), auth.uid()
    FROM (SELECT DISTINCT project_id FROM public.stock
           WHERE availability IN ('Available','Reserved') AND project_id IS NOT NULL) vp
  ON CONFLICT (staff_id, project_id) DO UPDATE
     SET visible = v_target, updated_at = now(), updated_by = auth.uid();

  -- Hide All must also cover rows for projects that no longer carry live
  -- stock, otherwise they'd re-appear if that stock comes back.
  IF v_target = false THEN
    UPDATE public.staff_project_commission_overrides
       SET visible = false, updated_at = now(), updated_by = auth.uid()
     WHERE staff_id = p_staff_id AND visible = true;
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.staff_project_commission_overrides
   WHERE staff_id = p_staff_id AND visible = true;
  RETURN jsonb_build_object('rows', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION public.set_staff_all_projects_visible(uuid, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_staff_all_projects_visible(uuid, boolean) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- No backfill required. Flat-fee staff pick up every project that has no
-- row for them as soon as the client change ships; their existing rows are
-- all visible=true and stay exactly as they are.
-- ============================================================
