-- ============================================================
-- TPCH Research Portal — Three-Tier Research (Phase 1)
--
-- Adds state_research and suburb_research tables for the
-- investment-grade research rebuild. Old `research_reports`
-- table is left in place during transition; the portal
-- continues to read it until existing rows are ported into
-- suburb_research.
--
-- Region tier (region_research) deferred to Phase 2.
--
-- Run this in the Supabase SQL Editor (single execution).
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. STATE RESEARCH (top-tier macro overlay)
-- One row per state. Inherited by every suburb in that state.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.state_research (

  -- Identity
  state_code        text          PRIMARY KEY,        -- 'VIC', 'NSW', 'QLD', 'WA', 'SA', 'NT', 'TAS', 'ACT'
  title             text          NOT NULL,           -- 'Victoria — State Research'
  slug              text          NOT NULL UNIQUE,    -- 'victoria'

  -- Executive summary (rendered above suburb pages when collapsed)
  thesis_short      text,                              -- one-liner
  thesis_main       text,                              -- 1-paragraph summary

  -- Structured payloads
  macro_overlay     jsonb,                             -- RBA cash-rate path, AUD, commodity cycle, state economic outlook
  endorsements      jsonb,                             -- third-party citations supporting the state thesis
  counter_view      jsonb,                             -- one bear-case article + response
  sources           jsonb,                             -- master citation list

  -- Workflow (mirrors project_analysis status pattern)
  status            text          NOT NULL DEFAULT 'draft'
                    CHECK (status = ANY (ARRAY['draft','published','rejected'])),
  version           int           NOT NULL DEFAULT 1,
  ai_generated      boolean       DEFAULT false,
  model_used        text,                              -- 'claude-opus-4-7' etc.
  triggered_by      text,                              -- 'mick@local-skill' | edge function caller
  reviewed_by       text,
  reviewed_at       timestamptz,
  published_at      timestamptz,
  created_at        timestamptz   DEFAULT now(),
  updated_at        timestamptz   DEFAULT now()

);

CREATE INDEX IF NOT EXISTS idx_state_research_status
  ON public.state_research (status, state_code);


-- Seed placeholder rows for every state so suburb_research FK never fails.
-- Admins fill in real content via the agent + admin review flow.
INSERT INTO public.state_research (state_code, title, slug, status) VALUES
  ('VIC', 'Victoria — State Research',           'victoria',           'draft'),
  ('NSW', 'New South Wales — State Research',    'new-south-wales',    'draft'),
  ('QLD', 'Queensland — State Research',         'queensland',         'draft'),
  ('WA',  'Western Australia — State Research',  'western-australia',  'draft'),
  ('SA',  'South Australia — State Research',    'south-australia',    'draft'),
  ('NT',  'Northern Territory — State Research', 'northern-territory', 'draft'),
  ('TAS', 'Tasmania — State Research',           'tasmania',           'draft'),
  ('ACT', 'ACT — State Research',                'act',                'draft')
ON CONFLICT (state_code) DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- 2. SUBURB RESEARCH (the 24-pillar investment report)
-- One row per suburb. References state_research for inherited context.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.suburb_research (

  -- Identity
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text          NOT NULL UNIQUE,                    -- 'southbank-vic'
  suburb            text          NOT NULL,
  region            text,                                              -- free text until region_research exists (Phase 2)
  state_code        text          NOT NULL REFERENCES public.state_research(state_code),
  lga               text,                                              -- Local Government Area
  postcode          text,

  -- Map coordinates
  map_lat           float8,
  map_lng           float8,

  -- Cover / hero
  cover_image_url   text,
  hero_overline     text,                                              -- e.g. 'Inner Melbourne · Victoria'

  -- Hero metrics — denormalised from pillars for fast list rendering
  rating              text,                                            -- 'Strong Buy' | 'Good Buy' | 'Watch' | 'Caution'
  conviction_score    int,                                             -- 0-100, sum of pillar sub-scores
  is_exclusive        boolean       DEFAULT false,
  median_price        numeric,
  avg_yield           numeric,
  vacancy_rate        numeric,
  capital_growth_10yr numeric,
  weekly_rent         numeric,
  population          text,                                            -- e.g. '32,400'
  pop_growth_pct      numeric,

  -- Executive summary (top-of-report)
  thesis_short      text,                                              -- one-liner shown on cards
  thesis_main       text,                                              -- 1-paragraph executive summary
  narrative_thesis  text,                                              -- long-form "Story in Plain English" (six-part framework, mandatory in v2.1.0+)

  -- Structured payloads
  --
  -- pillars JSONB shape (master 24-pillar payload):
  --   {
  --     "macro_context":          { status, headline, narrative, stats[], chart_data, citations[] },
  --     "demographics":           { ... },
  --     "migration":              { ... },
  --     "employment":             { ... },
  --     "supply_pipeline":        { ... },
  --     "days_on_market":         { ... },
  --     "vacancy_trend":          { ... },
  --     "rent_trend":             { ... },
  --     "price_growth":           { ... },
  --     "affordability":          { ... },
  --     "comparable_sales":       { ... },
  --     "planning_zoning":        { ... },
  --     "schools":                { ... },
  --     "transport_amenity":      { ... },
  --     "climate_risk":           { ... },
  --     "crime_safety":           { ... },
  --     "tenure_mix":             { ... },
  --     "construction_cost":      { ... },
  --     "infrastructure":         { ... },
  --     "endorsements":           { ... },           -- references endorsements column
  --     "counter_view":           { ... },           -- references counter_view column
  --     "risk_register":          { ... },
  --     "tax":                    { ... }
  --   }
  -- Each pillar object has: status ('ok' | 'data_not_available'), reason (if not ok),
  -- headline, narrative (string), stats (object), chart_data (object|null), citations (string[]).
  pillars           jsonb,

  endorsements      jsonb,                                             -- ≥3 third-party citations (article cards on the page)
  counter_view      jsonb,                                             -- exactly 1 bear-case article + response
  comparable_sales  jsonb,                                             -- top 10 recent transactions
  sources           jsonb,                                              -- master citation list, every URL verified

  -- Workflow (mirrors project_analysis status pattern)
  status            text          NOT NULL DEFAULT 'draft'
                    CHECK (status = ANY (ARRAY['draft','published','rejected'])),
  version           int           NOT NULL DEFAULT 1,
  ai_generated      boolean       DEFAULT false,
  model_used        text,
  triggered_by      text,
  reviewed_by       text,
  reviewed_at       timestamptz,
  published_at      timestamptz,
  created_at        timestamptz   DEFAULT now(),
  updated_at        timestamptz   DEFAULT now()

);

-- A suburb has at most one current report per state
CREATE UNIQUE INDEX IF NOT EXISTS idx_suburb_research_suburb_state
  ON public.suburb_research (suburb, state_code);

-- Portal's primary read path
CREATE INDEX IF NOT EXISTS idx_suburb_research_status
  ON public.suburb_research (status, state_code, suburb);


-- ────────────────────────────────────────────────────────────
-- 3. AGENT REGISTRATION
-- The research-agent edge function looks up its agent_id by slug
-- when creating an agent_runs row. Mirror the pattern used by
-- the investment-analysis agent.
-- ────────────────────────────────────────────────────────────

INSERT INTO public.agents (slug, name, description)
SELECT 'suburb-research',
       'Suburb Research Agent',
       'Drafts investment-grade suburb research reports covering 24 pillars with mandatory third-party citations. Output lands as draft for admin review.'
WHERE NOT EXISTS (SELECT 1 FROM public.agents WHERE slug = 'suburb-research');


-- ────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
--
-- Tighter than research_reports: anon key can only READ published.
-- All writes go through edge functions with service_role key
-- (which bypasses RLS).
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.state_research  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suburb_research ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read published state research"
  ON public.state_research
  FOR SELECT
  USING (status = 'published');

CREATE POLICY "Public can read published suburb research"
  ON public.suburb_research
  FOR SELECT
  USING (status = 'published');


-- ────────────────────────────────────────────────────────────
-- 5. ADMIN HELPER VIEW
-- For the admin draft-review queue. Returns drafts plus a few
-- summary fields. Admins query this through a SECURITY DEFINER
-- RPC (matching the pattern used by get_partners_admin()).
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.suburb_research_admin AS
  SELECT
    id,
    slug,
    suburb,
    state_code,
    rating,
    conviction_score,
    status,
    version,
    ai_generated,
    model_used,
    triggered_by,
    published_at,
    updated_at,
    -- Quick-look counters from JSONB
    jsonb_array_length(COALESCE(endorsements, '[]'::jsonb))     AS endorsement_count,
    jsonb_array_length(COALESCE(comparable_sales, '[]'::jsonb)) AS comparable_count,
    jsonb_array_length(COALESCE(sources, '[]'::jsonb))          AS source_count
  FROM public.suburb_research;
