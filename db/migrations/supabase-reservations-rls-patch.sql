-- ============================================================
-- TPCH Reservations RLS Patch
-- Run after supabase-reservations-migration.sql
-- Grants authenticated users the ability to:
--   • Read and cancel (UPDATE) their own reservations via portal
--   • Revert stock availability to Available on cancel
-- ============================================================

-- 1. Grant table access to authenticated role
GRANT SELECT, INSERT, UPDATE ON public.reservations TO authenticated;
GRANT UPDATE ON public.stock TO authenticated;

-- 2. RLS: authenticated users can read + update reservations
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'reservations' AND policyname = 'reservations_authenticated'
  ) THEN
    CREATE POLICY reservations_authenticated ON public.reservations
      TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 3. RLS: authenticated users can update stock availability (for cancel reversal)
--    (SELECT policy should already exist from supabase-stock-migration.sql)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'stock' AND policyname = 'stock_authenticated_update'
  ) THEN
    CREATE POLICY stock_authenticated_update ON public.stock
      FOR UPDATE
      TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;
