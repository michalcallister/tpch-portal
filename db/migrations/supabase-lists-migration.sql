-- ============================================================
-- TPCH — My Lists Migration
-- Creates shortlists + shortlist_items tables for partner
-- property shortlisting. Fully idempotent.
-- ============================================================

-- 1. shortlists table
CREATE TABLE IF NOT EXISTS public.shortlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. shortlist_items table
CREATE TABLE IF NOT EXISTS public.shortlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id uuid NOT NULL REFERENCES public.shortlists(id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL,
  stock_id     text NOT NULL,
  stock_name   text,
  project_id   text,
  project_name text,
  added_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shortlist_id, stock_id)
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS shortlists_partner_id_idx       ON public.shortlists(partner_id);
CREATE INDEX IF NOT EXISTS shortlist_items_shortlist_id_idx ON public.shortlist_items(shortlist_id);
CREATE INDEX IF NOT EXISTS shortlist_items_partner_id_idx   ON public.shortlist_items(partner_id);

-- 4. RLS
ALTER TABLE public.shortlists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shortlist_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'shortlists' AND policyname = 'shortlists_all') THEN
    CREATE POLICY shortlists_all ON public.shortlists USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'shortlist_items' AND policyname = 'shortlist_items_all') THEN
    CREATE POLICY shortlist_items_all ON public.shortlist_items USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 5. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shortlists      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shortlist_items TO anon, authenticated;

-- 6. Add website column to channel_partners if not already present
ALTER TABLE public.channel_partners ADD COLUMN IF NOT EXISTS website text;

-- 7. RPC: get_my_lists — returns lists with item count for a partner
CREATE OR REPLACE FUNCTION public.get_my_lists(p_partner_id uuid)
RETURNS TABLE (
  id         uuid,
  name       text,
  item_count bigint,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    l.id,
    l.name,
    COUNT(i.id) AS item_count,
    l.created_at
  FROM public.shortlists l
  LEFT JOIN public.shortlist_items i ON i.shortlist_id = l.id
  WHERE l.partner_id = p_partner_id
  GROUP BY l.id, l.name, l.created_at
  ORDER BY l.created_at DESC;
$$;
