-- ============================================================================
-- TPCH PORTAL — ENGAGEMENT ANALYTICS (Phase 1)
-- ============================================================================
-- Powers the admin "Partner Engagement" dashboard. Captures every meaningful
-- channel-partner action in a single unified log.
--
-- Applied to project oreklvbzwgbufbkvvzny on 2026-05-09 via Supabase MCP as
-- two migrations:
--   * engagement_analytics_phase1                 (table + 6 RPCs)
--   * engagement_analytics_phase1_revoke_anon     (defense-in-depth)
--
-- Phase 1 ships:
--   * partner_activity_log  — unified event log (login, page_view, …)
--   * log_partner_event()   — single client-side write path (SECURITY DEFINER)
--   * compute_engagement_score(partner, window)  — 0..100 weighted blend
--   * get_engagement_overview(window)            — KPI hero strip
--   * get_engagement_leaderboard(window)         — per-partner ranked table
--   * get_engagement_trend(window)               — daily time-series
--   * get_event_breakdown(window)                — counts per event_type
--
-- Phase 2 will add:
--   * report_downloads typed columns (existing table has download_type/report_id
--     uuid; needs report_kind + report_slug + ip_address + user_agent reconciled)
--   * get_engagement_funnel, get_at_risk_partners, get_top_content
--   * Backfill of historic logins from auth.users.last_sign_in_at
--
-- Re-running the whole file is safe — every CREATE/ALTER is guarded.
-- ============================================================================


-- ============================================================================
-- PART 1 — TABLES
-- ============================================================================

BEGIN;

-- ── partner_activity_log ────────────────────────────────────────────────────
-- One row per tracked event. event_type is enum-checked. payload is a free-form
-- jsonb so adding a new tracked action is a one-line client change with no
-- migration. session_id is generated client-side per browser tab and lets us
-- group page views into sessions for "session depth" metrics later.
CREATE TABLE IF NOT EXISTS public.partner_activity_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid        NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  user_id      uuid,                                                          -- auth.uid() at write time
  staff_id     uuid        REFERENCES public.partner_staff(id) ON DELETE SET NULL,
  session_id   text,
  event_type   text        NOT NULL,
  entity_type  text,                                                          -- 'stock' | 'project' | 'research' | 'flyer' | 'page' | NULL
  entity_id    text,                                                          -- id / slug
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_activity_log_event_type_chk CHECK (event_type IN (
    'login','page_view','stock_view','project_view','research_view',
    'flyer_open','flyer_share','flyer_download','floor_plan_pdf_open',
    'filter_applied','search','ask_tpch','reservation_created',
    'agreement_accepted','logout'
  ))
);

CREATE INDEX IF NOT EXISTS idx_pal_partner_created
  ON public.partner_activity_log (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pal_event_created
  ON public.partner_activity_log (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pal_entity
  ON public.partner_activity_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pal_created
  ON public.partner_activity_log (created_at DESC);

ALTER TABLE public.partner_activity_log ENABLE ROW LEVEL SECURITY;

-- Partner can read own log; admin can read all. No INSERT/UPDATE/DELETE policy
-- for authenticated → all writes go through log_partner_event (SECURITY DEFINER)
-- or via service role inside edge functions. Prevents partner-on-partner spoofing.
DROP POLICY IF EXISTS pal_select_own ON public.partner_activity_log;
CREATE POLICY pal_select_own
  ON public.partner_activity_log
  FOR SELECT TO authenticated
  USING (partner_id = current_partner_id() OR is_admin());


-- NOTE: report_downloads is not touched here. The existing table already
-- has columns id / partner_id / report_id (uuid) / download_type (text) /
-- downloaded_at, with RLS on and no policies. Reconciling the schema to
-- support our richer audit shape (report_kind text, report_slug text,
-- file_url, ip_address, user_agent) is deferred to Phase 2 when we wire
-- the actual download/share click handlers.

COMMIT;


-- ============================================================================
-- PART 2 — RPCs
-- ============================================================================

BEGIN;

-- ── log_partner_event ───────────────────────────────────────────────────────
-- Single client-side write path. Silently no-ops for admins / unknown callers
-- (current_partner_id() returns NULL for them). Never raises — UI must not
-- block on event tracking.
CREATE OR REPLACE FUNCTION public.log_partner_event(
  p_event_type   text,
  p_entity_type  text  DEFAULT NULL,
  p_entity_id    text  DEFAULT NULL,
  p_session_id   text  DEFAULT NULL,
  p_payload      jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner uuid;
  v_staff   uuid;
BEGIN
  v_partner := current_partner_id();
  IF v_partner IS NULL THEN
    RETURN;                                                                   -- admins / unknown: silent no-op
  END IF;

  SELECT id INTO v_staff
    FROM public.partner_staff
    WHERE user_id = auth.uid()
    LIMIT 1;

  INSERT INTO public.partner_activity_log
    (partner_id, user_id, staff_id, session_id, event_type, entity_type, entity_id, payload)
  VALUES
    (v_partner, auth.uid(), v_staff, p_session_id, p_event_type, p_entity_type, p_entity_id,
     COALESCE(p_payload, '{}'::jsonb));
END;
$$;

REVOKE ALL    ON FUNCTION public.log_partner_event(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_partner_event(text, text, text, text, jsonb) TO authenticated;


-- ── compute_engagement_score ────────────────────────────────────────────────
-- 0..100 weighted blend used by leaderboard rows + per-partner drill-downs.
-- Inputs aggregated from partner_activity_log + reservations + partner_deals.
-- Safe to call for any partner (no RLS check) — caller wraps in is_admin gate
-- or current_partner_id check.
CREATE OR REPLACE FUNCTION public.compute_engagement_score(
  p_partner_id   uuid,
  p_window_days  int DEFAULT 30
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window         interval := make_interval(days => p_window_days);
  v_company_name   text;
  v_last_login     timestamptz;
  v_logins         int := 0;
  v_stock_views    int := 0;
  v_research_views int := 0;
  v_flyers         int := 0;
  v_breadth        int := 0;
  v_reservations   int := 0;
  v_active_deals   int := 0;
  v_days_since     numeric;
  v_recency        numeric;
  v_login_freq     numeric;
  v_stock_score    numeric;
  v_research_score numeric;
  v_flyer_score    numeric;
  v_rsv_score      numeric;
  v_deal_score     numeric;
  v_breadth_score  numeric;
  v_raw            numeric;
BEGIN
  SELECT company_name INTO v_company_name
    FROM public.channel_partners
    WHERE id = p_partner_id;

  -- Activity-log aggregates over window.
  SELECT
    MAX(created_at) FILTER (WHERE event_type = 'login'),
    COUNT(*)        FILTER (WHERE event_type = 'login'),
    COUNT(*)        FILTER (WHERE event_type IN ('stock_view','project_view')),
    COUNT(*)        FILTER (WHERE event_type = 'research_view'),
    COUNT(*)        FILTER (WHERE event_type IN ('flyer_share','flyer_download')),
    COUNT(DISTINCT event_type)
  INTO v_last_login, v_logins, v_stock_views, v_research_views, v_flyers, v_breadth
  FROM public.partner_activity_log
  WHERE partner_id = p_partner_id
    AND created_at > now() - v_window;

  -- Reservations created in window (any status).
  SELECT COUNT(*) INTO v_reservations
    FROM public.reservations
    WHERE partner_id = p_partner_id
      AND reserved_at > now() - v_window;

  -- Active deals = pipeline not yet fully paid (no time-window filter; current state).
  IF v_company_name IS NOT NULL THEN
    SELECT COUNT(*) INTO v_active_deals
      FROM public.partner_deals
      WHERE channel_partner_name ILIKE v_company_name
        AND fully_paid_date IS NULL;
  END IF;

  -- Recency: 100 * exp(-days/14). Saturates near 100 today, ~37 at 14d, ~14 at 30d.
  IF v_last_login IS NULL THEN
    v_recency := 0;
  ELSE
    v_days_since := EXTRACT(EPOCH FROM (now() - v_last_login)) / 86400.0;
    v_recency := 100.0 * exp(- GREATEST(v_days_since, 0) / 14.0);
  END IF;

  v_login_freq    := LEAST(100, v_logins         * 10);
  v_stock_score   := LEAST(100, v_stock_views    * 4);
  v_research_score:= LEAST(100, v_research_views * 12);
  v_flyer_score   := LEAST(100, v_flyers         * 20);
  v_rsv_score     := LEAST(100, v_reservations   * 33);
  v_deal_score    := LEAST(100, v_active_deals   * 25);
  v_breadth_score := LEAST(100, v_breadth        * 14);

  v_raw :=  0.20 * v_recency
          + 0.15 * v_login_freq
          + 0.10 * v_stock_score
          + 0.10 * v_research_score
          + 0.10 * v_flyer_score
          + 0.10 * v_rsv_score
          + 0.15 * v_deal_score
          + 0.10 * v_breadth_score;

  RETURN ROUND(v_raw);
END;
$$;

REVOKE ALL    ON FUNCTION public.compute_engagement_score(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_engagement_score(uuid, int) TO authenticated;


-- ── get_engagement_overview ─────────────────────────────────────────────────
-- KPI hero strip. Single jsonb object, one query each.
CREATE OR REPLACE FUNCTION public.get_engagement_overview(
  p_window_days int DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window      interval := make_interval(days => p_window_days);
  v_active      int;
  v_dau         int;
  v_wau         int;
  v_mau         int;
  v_new_partners int;
  v_total_login int;
  v_total_event int;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(DISTINCT partner_id) INTO v_active
    FROM public.partner_activity_log
    WHERE created_at > now() - v_window;

  SELECT COUNT(DISTINCT partner_id) INTO v_dau
    FROM public.partner_activity_log
    WHERE created_at > now() - interval '24 hours';

  SELECT COUNT(DISTINCT partner_id) INTO v_wau
    FROM public.partner_activity_log
    WHERE created_at > now() - interval '7 days';

  SELECT COUNT(DISTINCT partner_id) INTO v_mau
    FROM public.partner_activity_log
    WHERE created_at > now() - interval '30 days';

  SELECT COUNT(*) INTO v_new_partners
    FROM public.channel_partners
    WHERE joined_at > now() - v_window;

  SELECT COUNT(*) INTO v_total_login
    FROM public.partner_activity_log
    WHERE event_type = 'login'
      AND created_at > now() - v_window;

  SELECT COUNT(*) INTO v_total_event
    FROM public.partner_activity_log
    WHERE created_at > now() - v_window;

  RETURN jsonb_build_object(
    'window_days',          p_window_days,
    'active_partners',      v_active,
    'dau',                  v_dau,
    'wau',                  v_wau,
    'mau',                  v_mau,
    'stickiness',           CASE WHEN v_mau > 0 THEN ROUND((v_dau::numeric / v_mau::numeric) * 100, 1) ELSE 0 END,
    'new_partners',         v_new_partners,
    'total_logins_window',  v_total_login,
    'total_events_window',  v_total_event,
    'generated_at',         now()
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.get_engagement_overview(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_engagement_overview(int) TO authenticated;


-- ── get_engagement_leaderboard ──────────────────────────────────────────────
-- One row per active channel partner. All counts aggregated inline (single
-- query, no per-row function calls). last_login_at falls back to
-- auth.users.last_sign_in_at when no 'login' event has been logged yet
-- (covers historic partners predating Phase 1 instrumentation).
CREATE OR REPLACE FUNCTION public.get_engagement_leaderboard(
  p_window_days int DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_window interval := make_interval(days => p_window_days);
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    WITH partner_metrics AS (
      SELECT
        cp.id                                                            AS partner_id,
        cp.company_name,
        cp.full_name,
        cp.email,
        cp.logo_url,
        cp.status,
        cp.joined_at,
        COALESCE(agg.last_login_pal, u.last_sign_in_at)                  AS last_login_at,
        COALESCE(agg.logins_n,    0)                                     AS logins_n,
        COALESCE(agg.stock_n,     0)                                     AS stock_views_n,
        COALESCE(agg.research_n,  0)                                     AS research_views_n,
        COALESCE(agg.flyers_n,    0)                                     AS flyers_n,
        COALESCE(rsv.rsv_n,       0)                                     AS reservations_n,
        COALESCE(dl.deal_n,       0)                                     AS active_deals_n,
        COALESCE(agg.breadth_n,   0)                                     AS breadth_n
      FROM public.channel_partners cp
      LEFT JOIN auth.users u ON lower(u.email) = lower(cp.email)
      LEFT JOIN LATERAL (
        SELECT
          MAX(created_at) FILTER (WHERE event_type = 'login')                           AS last_login_pal,
          COUNT(*)        FILTER (WHERE event_type = 'login')                           AS logins_n,
          COUNT(*)        FILTER (WHERE event_type IN ('stock_view','project_view'))    AS stock_n,
          COUNT(*)        FILTER (WHERE event_type = 'research_view')                   AS research_n,
          COUNT(*)        FILTER (WHERE event_type IN ('flyer_share','flyer_download')) AS flyers_n,
          COUNT(DISTINCT event_type)                                                    AS breadth_n
        FROM public.partner_activity_log
        WHERE partner_id = cp.id
          AND created_at > now() - v_window
      ) agg ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS rsv_n
        FROM public.reservations
        WHERE partner_id = cp.id
          AND reserved_at > now() - v_window
      ) rsv ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS deal_n
        FROM public.partner_deals
        WHERE channel_partner_name ILIKE cp.company_name
          AND fully_paid_date IS NULL
      ) dl ON true
      WHERE cp.status = 'active'
    ),
    partner_scored AS (
      SELECT
        pm.*,
        ROUND(
            0.20 * (CASE
                      WHEN pm.last_login_at IS NULL THEN 0
                      ELSE 100.0 * exp(- GREATEST(0, EXTRACT(EPOCH FROM (now() - pm.last_login_at)) / 86400.0) / 14.0)
                    END)
          + 0.15 * LEAST(100, pm.logins_n         * 10)
          + 0.10 * LEAST(100, pm.stock_views_n    * 4)
          + 0.10 * LEAST(100, pm.research_views_n * 12)
          + 0.10 * LEAST(100, pm.flyers_n         * 20)
          + 0.10 * LEAST(100, pm.reservations_n   * 33)
          + 0.15 * LEAST(100, pm.active_deals_n   * 25)
          + 0.10 * LEAST(100, pm.breadth_n        * 14)
        )                                                                AS engagement_score
      FROM partner_metrics pm
    ),
    partner_tiered AS (
      SELECT
        ps.*,
        CASE
          -- Onboarded > 14 days ago and never logged in → Dormant + flag.
          WHEN ps.last_login_at IS NULL AND ps.joined_at < now() - interval '14 days' THEN 'Dormant'
          -- Recently joined and not yet logged in → New (gets a chance, not penalised).
          WHEN ps.last_login_at IS NULL                                                THEN 'New'
          WHEN ps.engagement_score >= 80                                               THEN 'Power'
          WHEN ps.engagement_score >= 55                                               THEN 'Active'
          WHEN ps.engagement_score >= 30                                               THEN 'Warming'
          WHEN ps.engagement_score >= 10                                               THEN 'Cold'
          ELSE                                                                              'Dormant'
        END                                                              AS tier
      FROM partner_scored ps
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'partner_id',        partner_id,
        'company_name',      company_name,
        'full_name',         full_name,
        'email',             email,
        'logo_url',          logo_url,
        'status',            status,
        'joined_at',         joined_at,
        'last_login_at',     last_login_at,
        'logins_n',          logins_n,
        'stock_views_n',     stock_views_n,
        'research_views_n',  research_views_n,
        'flyers_n',          flyers_n,
        'reservations_n',    reservations_n,
        'active_deals_n',    active_deals_n,
        'breadth_n',         breadth_n,
        'engagement_score',  engagement_score,
        'tier',              tier
      )
      ORDER BY engagement_score DESC NULLS LAST, last_login_at DESC NULLS LAST
    )
    FROM partner_tiered
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL    ON FUNCTION public.get_engagement_leaderboard(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_engagement_leaderboard(int) TO authenticated;


-- ── get_engagement_trend ────────────────────────────────────────────────────
-- Daily time-series for the trend line chart. Always returns one row per day
-- across the window (zero-padded for days with no activity).
CREATE OR REPLACE FUNCTION public.get_engagement_trend(
  p_window_days int DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now() - make_interval(days => p_window_days - 1)),
        date_trunc('day', now()),
        '1 day'::interval
      )::date AS day
    ),
    daily AS (
      SELECT
        date_trunc('day', created_at)::date           AS day,
        COUNT(DISTINCT partner_id)                    AS active_partners,
        COUNT(*) FILTER (WHERE event_type = 'login')  AS logins,
        COUNT(*)                                       AS total_events
      FROM public.partner_activity_log
      WHERE created_at >= now() - make_interval(days => p_window_days)
      GROUP BY 1
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'day',             d.day,
        'active_partners', COALESCE(daily.active_partners, 0),
        'logins',          COALESCE(daily.logins, 0),
        'total_events',    COALESCE(daily.total_events, 0)
      ) ORDER BY d.day
    )
    FROM days d
    LEFT JOIN daily ON daily.day = d.day
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL    ON FUNCTION public.get_engagement_trend(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_engagement_trend(int) TO authenticated;


-- ── get_event_breakdown ─────────────────────────────────────────────────────
-- Counts per event_type over the window. Powers the top-events horizontal bar
-- chart and feeds the insights panel.
CREATE OR REPLACE FUNCTION public.get_event_breakdown(
  p_window_days int DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
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
        'event_type',        event_type,
        'event_count',       event_count,
        'distinct_partners', distinct_partners
      ) ORDER BY event_count DESC
    )
    FROM (
      SELECT
        event_type,
        COUNT(*)                    AS event_count,
        COUNT(DISTINCT partner_id)  AS distinct_partners
      FROM public.partner_activity_log
      WHERE created_at >= now() - make_interval(days => p_window_days)
      GROUP BY event_type
    ) sub
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL    ON FUNCTION public.get_event_breakdown(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_event_breakdown(int) TO authenticated;


-- ── Defense-in-depth: revoke EXECUTE from anon ──────────────────────────────
-- REVOKE FROM PUBLIC above removes default access, but Supabase grants EXECUTE
-- to the anon role explicitly. The is_admin() / current_partner_id() gates
-- inside each function would already deny anon callers, but flagged by
-- security advisor; revoking explicitly silences the warning.
REVOKE EXECUTE ON FUNCTION public.log_partner_event(text, text, text, text, jsonb)   FROM anon;
REVOKE EXECUTE ON FUNCTION public.compute_engagement_score(uuid, int)                FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_engagement_overview(int)                       FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_engagement_leaderboard(int)                    FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_engagement_trend(int)                          FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_event_breakdown(int)                           FROM anon;


NOTIFY pgrst, 'reload schema';

COMMIT;
