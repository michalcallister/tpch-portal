-- ============================================================
-- TPCH — Admin Recent Reservations
-- Run in Supabase SQL Editor (idempotent — safe to re-run)
--
-- Powers the admin-only "Recent reservations" dashboard panel and its
-- searchable history. Read-only: introduces no new table, touches no
-- existing data, changes no partner-facing behaviour.
--
-- get_recent_reservations(p_limit, p_search):
--   * Admin-gated via is_admin() (same gate as every other admin read).
--   * Returns ACTIVE reservations only, newest first.
--   * Joins channel_partners → company_name so the admin sees the firm
--     AND the individual who reserved (reservations.partner_name) in one row,
--     removing the Monday → portal dig.
--   * p_limit caps the rows (dashboard passes 5; history passes a high cap).
--   * p_search (optional) case-insensitively matches company, person,
--     property, or client name.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_recent_reservations(
  p_limit  int  DEFAULT 5,
  p_search text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search text := NULLIF(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t)::jsonb)
    FROM (
      SELECT
        r.id,
        r.stock_id,
        r.stock_name,
        r.project_name,
        cp.company_name,
        r.partner_id,
        r.partner_name        AS reserved_by_name,
        r.partner_email       AS reserved_by_email,
        r.client_name,
        r.client_email,
        r.client_phone,
        r.reserved_at,
        r.expires_at,
        GREATEST(0, EXTRACT(EPOCH FROM (r.expires_at - now())) / 3600) AS hours_remaining
      FROM public.reservations r
      LEFT JOIN public.channel_partners cp ON cp.id = r.partner_id
      WHERE r.status = 'active'
        AND (
          v_search IS NULL
          OR cp.company_name ILIKE '%' || v_search || '%'
          OR r.partner_name  ILIKE '%' || v_search || '%'
          OR r.stock_name    ILIKE '%' || v_search || '%'
          OR r.client_name   ILIKE '%' || v_search || '%'
        )
      ORDER BY r.reserved_at DESC
      LIMIT GREATEST(1, LEAST(coalesce(p_limit, 5), 500))
    ) t
  ), '[]'::jsonb);
END;
$$;

-- Lock execution to signed-in users only. anon is revoked explicitly because
-- Supabase's default privileges re-grant EXECUTE to anon on new functions, and
-- an admin-only RPC should never be reachable by the anonymous role (clears
-- security lint 0028; the internal is_admin() gate is the real control).
REVOKE ALL    ON FUNCTION public.get_recent_reservations(int, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_recent_reservations(int, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_recent_reservations(int, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
