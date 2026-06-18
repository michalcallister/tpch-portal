-- ============================================================
-- TPCH Staff Invite-Status Migration
-- Run in Supabase SQL Editor (idempotent — safe to re-run)
-- ============================================================
-- Gives the team list real per-member status instead of a blanket "Active":
--   * invite_email_status / _last_sent_at / _error  — written by invite-partner
--     each time an invite is sent (did the email actually go out?).
--   * invite_delivery_status / _at                  — written by the resend-webhook
--     edge function from Resend delivery events (delivered / bounced / complained).
--   * last_sign_in_at is read live from auth.users in get_partner_staff.
-- ============================================================

BEGIN;

-- 1. Status columns on partner_staff
ALTER TABLE public.partner_staff
  ADD COLUMN IF NOT EXISTS invite_email_status     text,         -- 'sent' | 'failed' | NULL (never attempted)
  ADD COLUMN IF NOT EXISTS invite_last_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS invite_email_error      text,
  ADD COLUMN IF NOT EXISTS invite_delivery_status  text,         -- 'delivered' | 'bounced' | 'complained' | NULL (Layer 2)
  ADD COLUMN IF NOT EXISTS invite_delivery_at      timestamptz;

-- 2. Extend get_partner_staff to surface login + invite status.
--    Keeps the existing access gate (admin OR the firm's own owner).
--    last_sign_in_at is matched by email so it resolves even before
--    partner_staff.user_id is back-filled on first login.
CREATE OR REPLACE FUNCTION public.get_partner_staff(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',                     ps.id,
        'full_name',              ps.full_name,
        'email',                  ps.email,
        'role',                   ps.role,
        'status',                 ps.status,
        'comm_display_type',      ps.comm_display_type,
        'comm_custom_value',      ps.comm_custom_value,
        'invited_at',             ps.invited_at,
        'last_sign_in_at',        u.last_sign_in_at,
        'invite_email_status',    ps.invite_email_status,
        'invite_last_sent_at',    ps.invite_last_sent_at,
        'invite_email_error',     ps.invite_email_error,
        'invite_delivery_status', ps.invite_delivery_status,
        'invite_delivery_at',     ps.invite_delivery_at
      ) ORDER BY ps.created_at
    )
    FROM public.partner_staff ps
    LEFT JOIN auth.users u ON lower(u.email) = lower(ps.email)
    WHERE ps.partner_id = p_partner_id
  );
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
