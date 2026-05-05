-- ============================================================
-- TPCH Research Portal — Supabase Migration
-- Run this in the Supabase SQL Editor (single execution)
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. RESEARCH REPORTS
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.research_reports (

  -- Identity
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  suburb        text          NOT NULL,
  region        text,
  state         text          NOT NULL,

  -- Map coordinates (used by Leaflet marker layer)
  map_lat       float8,
  map_lng       float8,

  -- Core metrics (hero stats bar on research page)
  avg_yield         numeric,
  capital_growth    numeric,
  vacancy_rate      numeric,
  median_price      numeric,
  weekly_rent       numeric,
  rental_growth     numeric,

  -- Demographics (sidebar)
  population        text,         -- stored as text e.g. "5.4M metro", "470K city"
  pop_growth_pct    numeric,
  unemployment      numeric,

  -- Conviction & flags
  rating            text,         -- "Strong Buy" | "Watch"
  smsf_eligible     boolean       DEFAULT false,
  is_exclusive      boolean       DEFAULT false,  -- manually set, not written by AI agent

  -- Investment thesis (written analysis sections)
  thesis_short      text,         -- one-liner shown on research list cards
  thesis_main       text,         -- main body paragraph
  thesis_detail     text,         -- second detail paragraph
  tpch_headline     text,         -- bold headline in TPCH Perspective block
  tpch_view         text,         -- extended TPCH editorial view

  -- JSONB arrays (rendered as charts and lists on research page)
  demand_drivers          jsonb,  -- string[]
  comparable_rents        jsonb,  -- {label: string, weekly: number}[]
  supply_pipeline         jsonb,  -- {year: string, pipeline: number, demand: number}[]
  infrastructure_pipeline jsonb,  -- {year: string, project: string, detail: string, status: string}[]
  economic_environment    jsonb,  -- {label: string, value: string, context: string}[]
  risk_factors            jsonb,  -- string[]
  data_sources            jsonb,  -- {tag: string, description: string}[]

  -- Supply shortfall (headline metric at bottom of research page)
  -- Numeric: projected population demand minus pipeline supply
  supply_shortfall        numeric,
  supply_shortfall_label  text,   -- e.g. "projected apartments deficit by 2029"

  -- Intrinsic value cards (three cards on research page)
  yield_vs_comparison         text,   -- e.g. "5.1% vs Sydney 2.9%"
  construction_cost_rise      text,   -- e.g. "25.5%"
  construction_cost_context   text,   -- e.g. "Victorian construction costs 2019–24. Source: Cordell CCCI"
  growth_forecast             text,   -- e.g. "28–30%"
  growth_forecast_context     text,   -- e.g. "Projected by 2030 — major analyst consensus"

  -- Metadata
  ai_generated  boolean       DEFAULT false,
  updated_by    text,
  is_visible    boolean       DEFAULT false,  -- false = draft, true = live on portal
  source_notes  text,
  updated_at    timestamptz   DEFAULT now()

);

-- Unique constraint on suburb + state so the AI agent upsert
-- (Prefer: resolution=merge-duplicates) works correctly
ALTER TABLE public.research_reports
  ADD CONSTRAINT research_reports_suburb_state_key UNIQUE (suburb, state);

-- Index for the portal's primary query (is_visible + ordering)
CREATE INDEX IF NOT EXISTS idx_research_reports_visible
  ON public.research_reports (is_visible, state, suburb);


-- ────────────────────────────────────────────────────────────
-- 2. STOCK LISTINGS
-- Minimal schema for now — will be extended when the
-- Monday.com sync layer is built
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.stock_listings (

  id      uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  suburb  text,
  state   text,
  status  text  DEFAULT 'available'  -- 'available' | 'under_offer' | 'exchanged' | 'sold'

);

-- Index for the portal's query (status != 'sold', ordered by suburb)
CREATE INDEX IF NOT EXISTS idx_stock_listings_status
  ON public.stock_listings (status, suburb);


-- ────────────────────────────────────────────────────────────
-- 3. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.research_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_listings   ENABLE ROW LEVEL SECURITY;

-- research_reports: portal (anon key) can read published reports
CREATE POLICY "Public can read visible reports"
  ON public.research_reports
  FOR SELECT
  USING (is_visible = true);

-- research_reports: AI agent writes with anon key, so allow anon insert
CREATE POLICY "Anon can insert reports"
  ON public.research_reports
  FOR INSERT
  WITH CHECK (true);

-- research_reports: AI agent upsert needs update permission too
CREATE POLICY "Anon can update reports"
  ON public.research_reports
  FOR UPDATE
  USING (true);

-- stock_listings: portal (anon key) can read non-sold listings
CREATE POLICY "Public can read active stock"
  ON public.stock_listings
  FOR SELECT
  USING (status <> 'sold');
