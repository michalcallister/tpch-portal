-- ============================================================
-- Dashboard wow-redesign — Week 1 foundation
-- Applied to project oreklvbzwgbufbkvvzny on 2026-04-30
-- via Supabase MCP migration `dashboard_wow_foundation_week1`.
--
-- Mirrored here for repo history. Do not re-apply blindly — the
-- live database already has these objects.
--
-- Powers:
--   * Deal Cockpit (stage_changed_at + stalled_days in get_partner_deals)
--   * Stock Radar feed (stock_events written by sync-monday)
--   * Personalisation (partner_recent_views written by client on
--     lot/project detail open via record_partner_view RPC)
-- ============================================================

-- 1. partner_deals: track when stage last changed.
ALTER TABLE public.partner_deals
  ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMPTZ;

UPDATE public.partner_deals
   SET stage_changed_at = COALESCE(stage_changed_at, last_synced_at, now())
 WHERE stage_changed_at IS NULL;

ALTER TABLE public.partner_deals
  ALTER COLUMN stage_changed_at SET DEFAULT now(),
  ALTER COLUMN stage_changed_at SET NOT NULL;


-- 2. stock_events — append-only delta log written by sync-monday.
CREATE TABLE IF NOT EXISTS public.stock_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL,
  stock_id      TEXT REFERENCES public.stock(id)    ON DELETE SET NULL,
  project_id    TEXT REFERENCES public.projects(id) ON DELETE SET NULL,
  severity      TEXT NOT NULL DEFAULT 'med' CHECK (severity IN ('low','med','high')),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_events_occurred
  ON public.stock_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_events_stock
  ON public.stock_events (stock_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_events_project
  ON public.stock_events (project_id, occurred_at DESC);

ALTER TABLE public.stock_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_events_read_all
  ON public.stock_events FOR SELECT
  TO authenticated
  USING (true);


-- 3. partner_recent_views — per-partner view log.
CREATE TABLE IF NOT EXISTS public.partner_recent_views (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  UUID NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('stock','project')),
  entity_id   TEXT NOT NULL,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_recent_views_partner
  ON public.partner_recent_views (partner_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_recent_views_entity
  ON public.partner_recent_views (entity_type, entity_id);

ALTER TABLE public.partner_recent_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY partner_recent_views_select_own
  ON public.partner_recent_views FOR SELECT
  TO authenticated
  USING (partner_id = current_partner_id() OR is_admin());


-- 4. RPC: record_partner_view
--    Client calls this on lot/project detail open. Dedupes the same
--    (partner, entity) pair if viewed within the last 5 minutes.
CREATE OR REPLACE FUNCTION public.record_partner_view(
  p_entity_type TEXT,
  p_entity_id   TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_partner UUID;
  v_recent  TIMESTAMPTZ;
BEGIN
  v_partner := current_partner_id();
  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'no active partner for caller' USING ERRCODE = '42501';
  END IF;

  IF p_entity_type NOT IN ('stock','project') THEN
    RAISE EXCEPTION 'invalid entity_type' USING ERRCODE = '22023';
  END IF;

  SELECT MAX(viewed_at) INTO v_recent
    FROM public.partner_recent_views
   WHERE partner_id = v_partner
     AND entity_type = p_entity_type
     AND entity_id   = p_entity_id;

  IF v_recent IS NULL OR v_recent < now() - INTERVAL '5 minutes' THEN
    INSERT INTO public.partner_recent_views (partner_id, entity_type, entity_id)
    VALUES (v_partner, p_entity_type, p_entity_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_partner_view(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_partner_view(TEXT, TEXT) TO authenticated;


-- 5. get_partner_deals: extend return shape with stage_changed_at and stalled_days
CREATE OR REPLACE FUNCTION public.get_partner_deals(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_company_name text;
BEGIN
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
        'stage_changed_at',         d.stage_changed_at,
        'stalled_days',             GREATEST(0, EXTRACT(DAY FROM now() - d.stage_changed_at)::int),
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
