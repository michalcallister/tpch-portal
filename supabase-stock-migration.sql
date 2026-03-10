-- ============================================================
-- TPCH Stock Portal — Projects & Stock Migration
-- Run in Supabase SQL Editor
-- Fully idempotent — safe to re-run
-- ============================================================

-- ── Projects table (Monday.com Projects board cache) ─────────

CREATE TABLE IF NOT EXISTS public.projects (
  id                        text          PRIMARY KEY,  -- Monday.com item ID
  name                      text          NOT NULL,
  sales_status              text,                       -- Available | Sold Out | Coming Soon
  project_status            text,                       -- Completed | Development | Off-Plan
  developer                 text,
  address                   text,
  state                     text,
  region                    text,
  suburb                    text,
  development_type          text,                       -- Apartment | Townhouse | House & Land
  property_type             text,                       -- Established | Construction | Off-Plan
  levels                    integer,
  total_volume              integer,
  stock_to_sell             integer,
  year_constructed          text,
  est_construction_start    date,
  est_construction_finish   date,
  commission_payment_terms  text,
  commission_notes          text,
  description               text,
  photo_urls                text[],
  video_urls                text[],
  document_urls             text[],
  last_synced_at            timestamptz   NOT NULL DEFAULT now()
);

-- Add any columns that may be missing if the table pre-existed
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='sales_status') THEN
    ALTER TABLE public.projects ADD COLUMN sales_status text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='project_status') THEN
    ALTER TABLE public.projects ADD COLUMN project_status text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='developer') THEN
    ALTER TABLE public.projects ADD COLUMN developer text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='address') THEN
    ALTER TABLE public.projects ADD COLUMN address text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='state') THEN
    ALTER TABLE public.projects ADD COLUMN state text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='region') THEN
    ALTER TABLE public.projects ADD COLUMN region text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='suburb') THEN
    ALTER TABLE public.projects ADD COLUMN suburb text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='development_type') THEN
    ALTER TABLE public.projects ADD COLUMN development_type text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='property_type') THEN
    ALTER TABLE public.projects ADD COLUMN property_type text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='levels') THEN
    ALTER TABLE public.projects ADD COLUMN levels integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='total_volume') THEN
    ALTER TABLE public.projects ADD COLUMN total_volume integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='stock_to_sell') THEN
    ALTER TABLE public.projects ADD COLUMN stock_to_sell integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='year_constructed') THEN
    ALTER TABLE public.projects ADD COLUMN year_constructed text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='est_construction_start') THEN
    ALTER TABLE public.projects ADD COLUMN est_construction_start date; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='est_construction_finish') THEN
    ALTER TABLE public.projects ADD COLUMN est_construction_finish date; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='commission_payment_terms') THEN
    ALTER TABLE public.projects ADD COLUMN commission_payment_terms text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='commission_notes') THEN
    ALTER TABLE public.projects ADD COLUMN commission_notes text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='description') THEN
    ALTER TABLE public.projects ADD COLUMN description text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='photo_urls') THEN
    ALTER TABLE public.projects ADD COLUMN photo_urls text[]; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='video_urls') THEN
    ALTER TABLE public.projects ADD COLUMN video_urls text[]; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='document_urls') THEN
    ALTER TABLE public.projects ADD COLUMN document_urls text[]; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='last_synced_at') THEN
    ALTER TABLE public.projects ADD COLUMN last_synced_at timestamptz NOT NULL DEFAULT now(); END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_state        ON public.projects (state);
CREATE INDEX IF NOT EXISTS idx_projects_suburb       ON public.projects (suburb);
CREATE INDEX IF NOT EXISTS idx_projects_sales_status ON public.projects (sales_status);

-- ── Stock table (Monday.com Stock board cache) ────────────────

CREATE TABLE IF NOT EXISTS public.stock (
  id                        text          PRIMARY KEY,  -- Monday.com item ID
  name                      text          NOT NULL,
  project_id                text          REFERENCES public.projects(id),
  project_name              text,
  availability              text,                       -- Available | Reserved | Under Offer | Settled | Developer
  address                   text,
  developer                 text,
  development_type          text,
  property_type             text,
  lot_number                text,
  level                     integer,

  -- Specs
  bedrooms                  integer,
  bathrooms                 integer,
  study                     integer,
  car_parks                 integer,
  build_internal_sqm        numeric,
  build_external_sqm        numeric,
  build_total_sqm           numeric,
  lot_size_sqm              numeric,

  -- Financials
  land_price                numeric,
  build_price               numeric,
  total_contract            numeric,
  stamp_duty_estimate       numeric,
  rent_per_week             numeric,
  annual_rent               numeric,
  occupancy_weeks           integer,

  -- Annual costs
  rates_annual              numeric,
  body_corporate_annual     numeric,
  insurance_annual          numeric,
  letting_fees_annual       numeric,
  maintenance_annual        numeric,

  -- Commission (shown to channel partners in portal, never in Investor Kit)
  comm_payment_terms        text,
  channel_comm_terms        text,
  comm_percentage           numeric,
  bonus_comm                numeric,
  total_comm_pool           numeric,
  channel_commission        numeric,
  tpch_commission           numeric,
  unconditional_comm        numeric,
  settlement_comm           numeric,
  base_stage_comm           numeric,
  frame_stage_comm          numeric,
  enclosed_stage_comm       numeric,
  pc_stage_comm             numeric,

  -- Flags
  smsf_eligible             boolean       NOT NULL DEFAULT false,
  floor_plan_url            text,

  last_synced_at            timestamptz   NOT NULL DEFAULT now()
);

-- Add any columns that may be missing if the table pre-existed
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='project_id') THEN
    ALTER TABLE public.stock ADD COLUMN project_id text REFERENCES public.projects(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='project_name') THEN
    ALTER TABLE public.stock ADD COLUMN project_name text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='availability') THEN
    ALTER TABLE public.stock ADD COLUMN availability text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='address') THEN
    ALTER TABLE public.stock ADD COLUMN address text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='developer') THEN
    ALTER TABLE public.stock ADD COLUMN developer text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='development_type') THEN
    ALTER TABLE public.stock ADD COLUMN development_type text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='property_type') THEN
    ALTER TABLE public.stock ADD COLUMN property_type text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='lot_number') THEN
    ALTER TABLE public.stock ADD COLUMN lot_number text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='level') THEN
    ALTER TABLE public.stock ADD COLUMN level integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='bedrooms') THEN
    ALTER TABLE public.stock ADD COLUMN bedrooms integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='bathrooms') THEN
    ALTER TABLE public.stock ADD COLUMN bathrooms integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='study') THEN
    ALTER TABLE public.stock ADD COLUMN study integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='car_parks') THEN
    ALTER TABLE public.stock ADD COLUMN car_parks integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='build_internal_sqm') THEN
    ALTER TABLE public.stock ADD COLUMN build_internal_sqm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='build_external_sqm') THEN
    ALTER TABLE public.stock ADD COLUMN build_external_sqm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='build_total_sqm') THEN
    ALTER TABLE public.stock ADD COLUMN build_total_sqm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='lot_size_sqm') THEN
    ALTER TABLE public.stock ADD COLUMN lot_size_sqm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='land_price') THEN
    ALTER TABLE public.stock ADD COLUMN land_price numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='build_price') THEN
    ALTER TABLE public.stock ADD COLUMN build_price numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='total_contract') THEN
    ALTER TABLE public.stock ADD COLUMN total_contract numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='stamp_duty_estimate') THEN
    ALTER TABLE public.stock ADD COLUMN stamp_duty_estimate numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='rent_per_week') THEN
    ALTER TABLE public.stock ADD COLUMN rent_per_week numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='annual_rent') THEN
    ALTER TABLE public.stock ADD COLUMN annual_rent numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='occupancy_weeks') THEN
    ALTER TABLE public.stock ADD COLUMN occupancy_weeks integer; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='rates_annual') THEN
    ALTER TABLE public.stock ADD COLUMN rates_annual numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='body_corporate_annual') THEN
    ALTER TABLE public.stock ADD COLUMN body_corporate_annual numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='insurance_annual') THEN
    ALTER TABLE public.stock ADD COLUMN insurance_annual numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='letting_fees_annual') THEN
    ALTER TABLE public.stock ADD COLUMN letting_fees_annual numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='maintenance_annual') THEN
    ALTER TABLE public.stock ADD COLUMN maintenance_annual numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='comm_payment_terms') THEN
    ALTER TABLE public.stock ADD COLUMN comm_payment_terms text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='channel_comm_terms') THEN
    ALTER TABLE public.stock ADD COLUMN channel_comm_terms text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='comm_percentage') THEN
    ALTER TABLE public.stock ADD COLUMN comm_percentage numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='bonus_comm') THEN
    ALTER TABLE public.stock ADD COLUMN bonus_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='total_comm_pool') THEN
    ALTER TABLE public.stock ADD COLUMN total_comm_pool numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='channel_commission') THEN
    ALTER TABLE public.stock ADD COLUMN channel_commission numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='tpch_commission') THEN
    ALTER TABLE public.stock ADD COLUMN tpch_commission numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='unconditional_comm') THEN
    ALTER TABLE public.stock ADD COLUMN unconditional_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='settlement_comm') THEN
    ALTER TABLE public.stock ADD COLUMN settlement_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='base_stage_comm') THEN
    ALTER TABLE public.stock ADD COLUMN base_stage_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='frame_stage_comm') THEN
    ALTER TABLE public.stock ADD COLUMN frame_stage_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='enclosed_stage_comm') THEN
    ALTER TABLE public.stock ADD COLUMN enclosed_stage_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='pc_stage_comm') THEN
    ALTER TABLE public.stock ADD COLUMN pc_stage_comm numeric; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='smsf_eligible') THEN
    ALTER TABLE public.stock ADD COLUMN smsf_eligible boolean NOT NULL DEFAULT false; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='floor_plan_url') THEN
    ALTER TABLE public.stock ADD COLUMN floor_plan_url text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock' AND column_name='last_synced_at') THEN
    ALTER TABLE public.stock ADD COLUMN last_synced_at timestamptz NOT NULL DEFAULT now(); END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stock_project_id   ON public.stock (project_id);
CREATE INDEX IF NOT EXISTS idx_stock_availability ON public.stock (availability);
CREATE INDEX IF NOT EXISTS idx_stock_bedrooms     ON public.stock (bedrooms);
CREATE INDEX IF NOT EXISTS idx_stock_total_price  ON public.stock (total_contract);

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock    ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='projects' AND policyname='Anon can read projects') THEN
    CREATE POLICY "Anon can read projects" ON public.projects FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='projects' AND policyname='Anon can insert projects') THEN
    CREATE POLICY "Anon can insert projects" ON public.projects FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='projects' AND policyname='Anon can update projects') THEN
    CREATE POLICY "Anon can update projects" ON public.projects FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock' AND policyname='Anon can read stock') THEN
    CREATE POLICY "Anon can read stock" ON public.stock FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock' AND policyname='Anon can insert stock') THEN
    CREATE POLICY "Anon can insert stock" ON public.stock FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock' AND policyname='Anon can update stock') THEN
    CREATE POLICY "Anon can update stock" ON public.stock FOR UPDATE USING (true);
  END IF;
END $$;

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
