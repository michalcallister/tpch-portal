-- ============================================================
-- TPCH Research Portal — Partner Reservation Stats Migration
-- Run in Supabase SQL Editor (idempotent)
--
-- Purpose: Phase 2 abuse-watch view. Aggregates each channel
-- partner's reservation history into rolling-window stats so the
-- admin can spot partners that reserve a lot but rarely convert
-- (locking other partners out of stock).
--
-- Source data: public.reservations (no new tracking required).
--
-- Provides:
--   1. View public.partner_reservation_stats — one row per partner
--      with 30d/90d aggregates and an is_flagged boolean.
--   2. Extends public.get_partners_admin() to include the stats
--      fields inline so the existing admin partner-list call gets
--      everything in one round-trip.
--   3. RPC public.get_partner_recent_reservations_admin(partner_id,
--      limit) — recent reservation rows for the detail-card list.
--
-- Flag rule (looser tier, agreed Phase 2 plan):
--   partner_cancelled_30d >= 8
--   OR (lapse_rate_pct_90d >= 70 AND reserved_90d >= 8)
-- ============================================================

-- ── 1. Stats view ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.partner_reservation_stats AS
WITH r30 AS (
  SELECT partner_id,
         COUNT(*)                                                          AS reserved_30d,
         COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'partner') AS partner_cancelled_30d,
         COUNT(*) FILTER (WHERE status = 'expired'   AND cancelled_by = 'system')  AS system_expired_30d,
         COUNT(*) FILTER (WHERE status = 'converted')                              AS converted_30d
  FROM public.reservations
  WHERE reserved_at >= now() - interval '30 days'
  GROUP BY partner_id
),
r90 AS (
  SELECT partner_id,
         COUNT(*)                                                          AS reserved_90d,
         COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'partner') AS partner_cancelled_90d,
         COUNT(*) FILTER (WHERE status = 'expired'   AND cancelled_by = 'system')  AS system_expired_90d,
         COUNT(*) FILTER (WHERE status = 'converted')                              AS converted_90d,
         MAX(reserved_at)                                                          AS last_reserved_at
  FROM public.reservations
  WHERE reserved_at >= now() - interval '90 days'
  GROUP BY partner_id
)
SELECT
  cp.id                                                  AS partner_id,
  cp.company_name,
  cp.full_name                                           AS owner_name,
  COALESCE(r30.reserved_30d,            0)               AS reserved_30d,
  COALESCE(r30.partner_cancelled_30d,   0)               AS partner_cancelled_30d,
  COALESCE(r30.system_expired_30d,      0)               AS system_expired_30d,
  COALESCE(r30.converted_30d,           0)               AS converted_30d,
  COALESCE(r90.reserved_90d,            0)               AS reserved_90d,
  COALESCE(r90.partner_cancelled_90d,   0)               AS partner_cancelled_90d,
  COALESCE(r90.system_expired_90d,      0)               AS system_expired_90d,
  COALESCE(r90.converted_90d,           0)               AS converted_90d,
  CASE
    WHEN COALESCE(r90.reserved_90d, 0) > 0
      THEN ROUND(
        100.0 * (COALESCE(r90.partner_cancelled_90d, 0) + COALESCE(r90.system_expired_90d, 0))
              / r90.reserved_90d,
        1
      )
    ELSE NULL
  END                                                    AS lapse_rate_pct_90d,
  (
    COALESCE(r30.partner_cancelled_30d, 0) >= 8
    OR (
      COALESCE(r90.reserved_90d, 0) >= 8
      AND (COALESCE(r90.partner_cancelled_90d, 0) + COALESCE(r90.system_expired_90d, 0))::numeric
            / NULLIF(r90.reserved_90d, 0) >= 0.70
    )
  )                                                      AS is_flagged,
  r90.last_reserved_at
FROM public.channel_partners cp
LEFT JOIN r30 ON r30.partner_id = cp.id
LEFT JOIN r90 ON r90.partner_id = cp.id;

COMMENT ON VIEW public.partner_reservation_stats IS
  'Per-partner reservation aggregates (30d/90d) plus is_flagged abuse indicator. Used by admin partner-list and partner-detail card.';

-- ── 2. Extend get_partners_admin() to include stats ──────────
CREATE OR REPLACE FUNCTION public.get_partners_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
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
        'last_sign_in_at',          u.last_sign_in_at,
        -- Phase 2 stats fields ----------------------------------
        'reserved_30d',             COALESCE(s.reserved_30d, 0),
        'partner_cancelled_30d',    COALESCE(s.partner_cancelled_30d, 0),
        'system_expired_30d',       COALESCE(s.system_expired_30d, 0),
        'converted_30d',            COALESCE(s.converted_30d, 0),
        'reserved_90d',             COALESCE(s.reserved_90d, 0),
        'partner_cancelled_90d',    COALESCE(s.partner_cancelled_90d, 0),
        'system_expired_90d',       COALESCE(s.system_expired_90d, 0),
        'converted_90d',            COALESCE(s.converted_90d, 0),
        'lapse_rate_pct_90d',       s.lapse_rate_pct_90d,
        'is_flagged',               COALESCE(s.is_flagged, false),
        'last_reserved_at',         s.last_reserved_at
      ) AS row
      FROM public.channel_partners p
      LEFT JOIN auth.users u                       ON lower(u.email) = lower(p.email)
      LEFT JOIN public.partner_reservation_stats s ON s.partner_id    = p.id
    ) sub
  ), '[]'::jsonb);
END;
$$;

-- ── 3. Recent reservations RPC (for the detail card) ─────────
-- Admin-only: caller must have an active row in tpch_team.
CREATE OR REPLACE FUNCTION public.get_partner_recent_reservations_admin(
  p_partner_id uuid,
  p_limit      int  DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_admin  boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tpch_team
    WHERE user_id = v_caller AND status = 'active'
  ) INTO v_admin;

  IF NOT v_admin THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row ORDER BY (row->>'reserved_at') DESC)
    FROM (
      SELECT jsonb_build_object(
        'id',           r.id,
        'stock_id',     r.stock_id,
        'stock_name',   r.stock_name,
        'project_name', r.project_name,
        'status',       r.status,
        'reserved_at',  r.reserved_at,
        'expires_at',   r.expires_at,
        'cancelled_at', r.cancelled_at,
        'cancelled_by', r.cancelled_by,
        'client_name',  r.client_name
      ) AS row
      FROM public.reservations r
      WHERE r.partner_id = p_partner_id
      ORDER BY r.reserved_at DESC
      LIMIT GREATEST(1, LEAST(p_limit, 200))
    ) s
  ), '[]'::jsonb);
END;
$$;

NOTIFY pgrst, 'reload schema';
