-- ============================================================
-- TPCH Research Portal — Team Migration
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tpch_team (

  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text          NOT NULL,
  email       text          NOT NULL,
  role        text          NOT NULL DEFAULT 'admin',   -- 'admin' (all get full access for now)
  status      text          NOT NULL DEFAULT 'active',  -- 'active' | 'inactive'
  joined_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()

);

-- Add columns if table pre-existed with different schema
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tpch_team' AND column_name='full_name') THEN
    ALTER TABLE public.tpch_team ADD COLUMN full_name text NOT NULL DEFAULT ''; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tpch_team' AND column_name='role') THEN
    ALTER TABLE public.tpch_team ADD COLUMN role text NOT NULL DEFAULT 'admin'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tpch_team' AND column_name='status') THEN
    ALTER TABLE public.tpch_team ADD COLUMN status text NOT NULL DEFAULT 'active'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tpch_team' AND column_name='joined_at') THEN
    ALTER TABLE public.tpch_team ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now(); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tpch_team' AND column_name='updated_at') THEN
    ALTER TABLE public.tpch_team ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(); END IF;
END $$;

-- Unique on email
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tpch_team_email_key' AND table_name = 'tpch_team'
  ) THEN
    ALTER TABLE public.tpch_team ADD CONSTRAINT tpch_team_email_key UNIQUE (email);
  END IF;
END $$;

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_tpch_team_status
  ON public.tpch_team (status, joined_at DESC);

-- ── Seed existing admin accounts ─────────────────────────────
-- ON CONFLICT DO NOTHING so re-running is safe
INSERT INTO public.tpch_team (full_name, email, role, status) VALUES
  ('Michal Callister',  'michal@tpch.com.au',             'admin', 'active'),
  ('Michal Callister',  'michal_callister@hotmail.com',   'admin', 'active'),
  ('Chris',             'chris@ozproperty.com.au',         'admin', 'active'),
  ('Admin',             'admin@tpch.com.au',               'admin', 'active'),
  ('Mick',              'mick@tpch.com.au',                'admin', 'active')
ON CONFLICT (email) DO NOTHING;

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE public.tpch_team ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- Portal fetches active emails on load for login check
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tpch_team' AND policyname='Anon can read team') THEN
    CREATE POLICY "Anon can read team" ON public.tpch_team FOR SELECT USING (true);
  END IF;
  -- Admin panel adds new members
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tpch_team' AND policyname='Anon can insert team') THEN
    CREATE POLICY "Anon can insert team" ON public.tpch_team FOR INSERT WITH CHECK (true);
  END IF;
  -- Admin panel updates status/details
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tpch_team' AND policyname='Anon can update team') THEN
    CREATE POLICY "Anon can update team" ON public.tpch_team FOR UPDATE USING (true);
  END IF;
END $$;

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
