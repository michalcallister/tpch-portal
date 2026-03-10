-- ============================================================
-- TPCH Research Portal — Channel Partners Migration
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.channel_partners (

  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to original enquiry (audit trail)
  enquiry_id        uuid,

  -- Reserved for future Supabase Auth login
  user_id           uuid,

  -- Contact details
  full_name         text          NOT NULL,
  email             text          NOT NULL,
  phone             text,

  -- Business details
  company_name      text          NOT NULL,
  abn               text,
  afsl_acl          text,
  website           text,
  linkedin_url      text,

  -- Practice profile
  role_type         text,
  state             text,
  years_in_business text,
  num_clients       text,

  -- Partner status
  status            text          NOT NULL DEFAULT 'active',  -- 'active' | 'inactive' | 'suspended'

  -- Internal admin notes
  notes             text,

  -- Timestamps
  joined_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()

);

-- Add any columns that may be missing if the table pre-existed
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='enquiry_id') THEN
    ALTER TABLE public.channel_partners ADD COLUMN enquiry_id uuid; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='user_id') THEN
    ALTER TABLE public.channel_partners ADD COLUMN user_id uuid; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='company_name') THEN
    ALTER TABLE public.channel_partners ADD COLUMN company_name text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='phone') THEN
    ALTER TABLE public.channel_partners ADD COLUMN phone text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='abn') THEN
    ALTER TABLE public.channel_partners ADD COLUMN abn text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='afsl_acl') THEN
    ALTER TABLE public.channel_partners ADD COLUMN afsl_acl text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='website') THEN
    ALTER TABLE public.channel_partners ADD COLUMN website text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='linkedin_url') THEN
    ALTER TABLE public.channel_partners ADD COLUMN linkedin_url text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='role_type') THEN
    ALTER TABLE public.channel_partners ADD COLUMN role_type text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='state') THEN
    ALTER TABLE public.channel_partners ADD COLUMN state text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='years_in_business') THEN
    ALTER TABLE public.channel_partners ADD COLUMN years_in_business text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='num_clients') THEN
    ALTER TABLE public.channel_partners ADD COLUMN num_clients text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='notes') THEN
    ALTER TABLE public.channel_partners ADD COLUMN notes text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='joined_at') THEN
    ALTER TABLE public.channel_partners ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now(); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channel_partners' AND column_name='updated_at') THEN
    ALTER TABLE public.channel_partners ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(); END IF;
END $$;

-- Unique on email so duplicate approvals don't create duplicate partners
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'channel_partners_email_key'
    AND table_name = 'channel_partners'
  ) THEN
    ALTER TABLE public.channel_partners ADD CONSTRAINT channel_partners_email_key UNIQUE (email);
  END IF;
END $$;

-- Index for admin panel queries
CREATE INDEX IF NOT EXISTS idx_channel_partners_status
  ON public.channel_partners (status, joined_at DESC);

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE public.channel_partners ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='channel_partners' AND policyname='Anon can read partners') THEN
    CREATE POLICY "Anon can read partners" ON public.channel_partners FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='channel_partners' AND policyname='Anon can insert partners') THEN
    CREATE POLICY "Anon can insert partners" ON public.channel_partners FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='channel_partners' AND policyname='Anon can update partners') THEN
    CREATE POLICY "Anon can update partners" ON public.channel_partners FOR UPDATE USING (true);
  END IF;
END $$;

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
