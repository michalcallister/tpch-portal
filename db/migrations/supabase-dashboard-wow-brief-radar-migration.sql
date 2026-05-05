-- ============================================================
-- Dashboard wow-redesign — Week 2 (Brief + Radar)
-- Applied to project oreklvbzwgbufbkvvzny on 2026-04-30
-- via Supabase MCP migration `dashboard_wow_brief_radar_week2`.
--
-- Mirrored here for repo history. Do not re-apply blindly.
--
-- Powers:
--   * Morning Brief (partner_briefs + get_my_brief RPC)
--   * Stock Radar feed (get_partner_stock_events RPC, server-joined
--     to shortlist_items + partner_recent_views + partner_deals)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.partner_briefs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      UUID NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  brief_date      DATE NOT NULL DEFAULT (current_date AT TIME ZONE 'Australia/Perth'),
  market_pulse    JSONB NOT NULL DEFAULT '[]'::jsonb,
  pipeline_lines  JSONB NOT NULL DEFAULT '[]'::jsonb,
  send_this       JSONB,
  source_version  TEXT NOT NULL DEFAULT 'v1',
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_partner_briefs_partner_date
  ON public.partner_briefs (partner_id, brief_date DESC);

ALTER TABLE public.partner_briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY partner_briefs_select_own
  ON public.partner_briefs FOR SELECT
  TO authenticated
  USING (partner_id = current_partner_id() OR is_admin());


CREATE OR REPLACE FUNCTION public.get_my_brief()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_partner UUID;
  v_brief   public.partner_briefs%ROWTYPE;
  v_today   DATE;
BEGIN
  v_partner := current_partner_id();
  IF v_partner IS NULL THEN RETURN NULL; END IF;

  v_today := (current_date AT TIME ZONE 'Australia/Perth');

  SELECT * INTO v_brief FROM public.partner_briefs
   WHERE partner_id = v_partner AND brief_date = v_today
   LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'id',             v_brief.id,
    'brief_date',     v_brief.brief_date,
    'market_pulse',   v_brief.market_pulse,
    'pipeline_lines', v_brief.pipeline_lines,
    'send_this',      v_brief.send_this,
    'generated_at',   v_brief.generated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_brief() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_brief() TO authenticated;


CREATE OR REPLACE FUNCTION public.get_partner_stock_events(p_limit INT DEFAULT 25)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_partner       UUID;
  v_company_name  TEXT;
BEGIN
  v_partner := current_partner_id();
  IF v_partner IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 25; END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;

  SELECT company_name INTO v_company_name
    FROM public.channel_partners WHERE id = v_partner;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_jsonb(t) ORDER BY t.occurred_at DESC)
    FROM (
      SELECT
        e.id,
        e.event_type,
        e.severity,
        e.occurred_at,
        e.payload,
        e.stock_id,
        e.project_id,
        s.name        AS stock_name,
        p.name        AS project_name,
        p.suburb      AS project_suburb,
        p.state       AS project_state
      FROM public.stock_events e
      LEFT JOIN public.stock    s ON s.id = e.stock_id
      LEFT JOIN public.projects p ON p.id = e.project_id
      WHERE e.occurred_at >= now() - INTERVAL '14 days'
        AND (
          EXISTS (
            SELECT 1 FROM public.shortlist_items si
             WHERE si.partner_id = v_partner
               AND (
                 (e.stock_id   IS NOT NULL AND si.stock_id   = e.stock_id) OR
                 (e.project_id IS NOT NULL AND si.project_id = e.project_id)
               )
          )
          OR EXISTS (
            SELECT 1 FROM public.partner_recent_views v
             WHERE v.partner_id = v_partner
               AND v.viewed_at >= now() - INTERVAL '60 days'
               AND (
                 (v.entity_type = 'stock'   AND e.stock_id   = v.entity_id) OR
                 (v.entity_type = 'project' AND e.project_id = v.entity_id)
               )
          )
          OR (v_company_name IS NOT NULL AND e.stock_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.partner_deals d
             WHERE d.channel_partner_name ILIKE v_company_name
               AND d.property_id = e.stock_id
               AND d.fully_paid_date IS NULL
          ))
        )
      ORDER BY e.occurred_at DESC
      LIMIT p_limit
    ) t
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_partner_stock_events(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_stock_events(INT) TO authenticated;
