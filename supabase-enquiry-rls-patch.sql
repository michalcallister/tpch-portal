-- ============================================================
-- TPCH — Enquiries admin read/update policies
-- Run in Supabase SQL Editor
-- NOTE: These use the anon key for now. Once real Supabase Auth
-- is added, restrict these to authenticated admin users only.
-- ============================================================

-- Allow portal to read all enquiries (needed for admin panel)
CREATE POLICY "Anon can read enquiries"
  ON public.pending_enquiries
  FOR SELECT
  USING (true);

-- Allow admin panel to update status (approve/decline)
CREATE POLICY "Anon can update enquiry status"
  ON public.pending_enquiries
  FOR UPDATE
  USING (true);

NOTIFY pgrst, 'reload schema';
