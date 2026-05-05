-- ============================================================
-- TPCH Deal Assignments Migration
-- Run in Supabase SQL Editor
-- Allows partner admins to assign deals to staff members
-- ============================================================

-- 1. Create deal_assignments table
CREATE TABLE IF NOT EXISTS public.deal_assignments (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  deal_id    text NOT NULL,  -- partner_deals.id (Monday.com item ID)
  staff_id   uuid NOT NULL REFERENCES public.partner_staff(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(deal_id, staff_id)
);

-- 2. RLS
ALTER TABLE public.deal_assignments ENABLE ROW LEVEL SECURITY;

-- All authenticated partner members can read their firm's assignments
CREATE POLICY "read deal assignments" ON public.deal_assignments
  FOR SELECT USING (
    partner_id IN (
      SELECT id   FROM public.channel_partners WHERE user_id = auth.uid()
      UNION ALL
      SELECT partner_id FROM public.partner_staff WHERE user_id = auth.uid() AND status = 'active'
    )
  );

-- Only partner owner can insert/update/delete
CREATE POLICY "manage deal assignments" ON public.deal_assignments
  FOR ALL USING (
    partner_id IN (
      SELECT id FROM public.channel_partners WHERE user_id = auth.uid()
    )
  );
