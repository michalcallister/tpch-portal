-- ============================================================
-- Allow TPCH admins to read per-staff per-project commission overrides
-- Applied: 2026-06-16
--
-- Problem: get_staff_commission_overrides_for_owner() was owner-only
-- (current_partner_id() + owner_uid = auth.uid()). In admin preview the
-- caller is a TPCH admin whose auth.uid() is not the partner owner, so the
-- function raised and the Edit-commission modal's per-project section came
-- back empty — making it look like the partner had set nothing, when the
-- overrides existed.
--
-- Fix: add an is_admin() allowance (mirrors get_partner_staff /
-- get_partner_deals, and the admin-preview design where admins read partner
-- data read-only). Owner path is unchanged: a non-admin caller must still be
-- the firm OWNER, not a regular team member.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_staff_commission_overrides_for_owner(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_partner_id uuid;
  v_owner_uid        uuid;
BEGIN
  SELECT partner_id INTO v_staff_partner_id FROM public.partner_staff WHERE id = p_staff_id;
  IF v_staff_partner_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- TPCH admins may read any firm's config (admin preview). Otherwise the
  -- caller must be the firm OWNER (its channel_partners.user_id = auth.uid()),
  -- not a regular team member.
  IF NOT public.is_admin() THEN
    SELECT user_id INTO v_owner_uid FROM public.channel_partners WHERE id = v_staff_partner_id;
    IF v_owner_uid IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'forbidden — owner or admin only' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN COALESCE(
    (SELECT jsonb_object_agg(
              project_id,
              jsonb_build_object('d', deduction_amount, 'v', visible))
       FROM public.staff_project_commission_overrides
      WHERE staff_id = p_staff_id),
    '{}'::jsonb);
END $function$;
