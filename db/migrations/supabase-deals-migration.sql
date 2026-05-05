-- ============================================================
-- TPCH Partner Deals Migration
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
-- Synced from Monday.com "Deals in Progress" board (8393705891)
-- ============================================================

-- 1. Create partner_deals table
CREATE TABLE IF NOT EXISTS public.partner_deals (
  id                        text        PRIMARY KEY,  -- Monday.com item ID
  name                      text        NOT NULL,     -- Deal name
  channel_partner_name      text,                     -- Matched to channel_partners.company_name (ILIKE)
  property_id               text,                     -- Monday.com stock item ID (for commission join)
  property_name             text,                     -- From Property connect_boards column
  client_name               text,                     -- Client Name text column
  stage                     text,                     -- Status column (deal_stage)
  deal_value                numeric,
  cos_executed_date         date,
  expected_approval_date    date,
  expected_settlement_date  date,
  fully_paid_date           date,
  paid_to_date              numeric,
  deal_creation_date        date,
  developer                 text,
  entity                    text,
  days_to_close             numeric,
  last_synced_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_deals_partner_name_idx
  ON public.partner_deals(channel_partner_name);

CREATE INDEX IF NOT EXISTS partner_deals_stage_idx
  ON public.partner_deals(stage);

-- 2. RLS
ALTER TABLE public.partner_deals ENABLE ROW LEVEL SECURITY;

-- Service role full access (sync function writes)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'partner_deals' AND policyname = 'deals_service_role'
  ) THEN
    CREATE POLICY deals_service_role ON public.partner_deals
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 3. RPC: get_partner_deals
--    Looks up company_name from channel_partners, returns matching deals.
--    Works for both partner owners and staff (both pass their partner_id).
CREATE OR REPLACE FUNCTION public.get_partner_deals(p_partner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_company_name text;
BEGIN
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
        -- channel_comm_flat is the explicit channel-only $ amount;
        -- fall back to computing from channel_comm_pct × total_contract
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
        -- Active deals first, then by creation date
        CASE WHEN d.fully_paid_date IS NOT NULL THEN 1 ELSE 0 END,
        d.deal_creation_date DESC NULLS LAST
    ), '[]'::jsonb)
    FROM public.partner_deals d
    LEFT JOIN public.stock s ON s.id = d.property_id
    WHERE d.channel_partner_name ILIKE v_company_name
  );
END;
$$;
