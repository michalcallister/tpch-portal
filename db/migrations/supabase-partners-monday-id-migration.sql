-- ============================================================
-- TPCH Research Portal — channel_partners.monday_item_id Migration
-- Run in Supabase SQL Editor
--
-- Purpose: Store each channel partner's Monday.com Channel Partners
-- board (8393705888) item id so reserve/cancel/expire flows can write
-- to the property item's Channel Partner board-relation column without
-- a per-request lookup.
-- ============================================================

ALTER TABLE public.channel_partners
  ADD COLUMN IF NOT EXISTS monday_item_id text;

CREATE INDEX IF NOT EXISTS channel_partners_monday_item_id_idx
  ON public.channel_partners (monday_item_id)
  WHERE monday_item_id IS NOT NULL;

COMMENT ON COLUMN public.channel_partners.monday_item_id IS
  'Monday.com item id on the Channel Partners board (8393705888). Populated on partner invite; used by reserve/cancel/expire to update the property item''s Channel Partner column.';
