-- ============================================================
-- TPCH Research Portal — Channel Partner Enquiry Migration
-- Run this in the Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pending_enquiries (

  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Personal details
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
  role_type         text,         -- 'mortgage_broker' | 'financial_planner' | 'buyers_agent' | etc.
  state             text,
  years_in_business text,
  num_clients       text,

  -- Discovery
  referral_source   text,
  message           text,

  -- AI due diligence output (populated by Edge Function)
  ai_report         text,         -- full Claude assessment in markdown
  ai_recommendation text,         -- 'approve' | 'review_further' | 'decline'

  -- Workflow status
  status            text          NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'declined'
  reviewed_by       text,
  reviewed_at       timestamptz,

  created_at        timestamptz   NOT NULL DEFAULT now()

);

-- Index for admin panel queries (newest first, filtered by status)
CREATE INDEX IF NOT EXISTS idx_pending_enquiries_status
  ON public.pending_enquiries (status, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE public.pending_enquiries ENABLE ROW LEVEL SECURITY;

-- Anon (portal visitor) can submit enquiries but not read them back
CREATE POLICY "Anon can insert enquiries"
  ON public.pending_enquiries
  FOR INSERT
  WITH CHECK (true);

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
