-- ============================================================
-- TPCH — Channel Partners "Portal" status sync
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
--
-- Adds a single column to channel_partners that records when the
-- partner's Monday card status was set to "Portal" (i.e. when we
-- detected they had logged in for the first time and pushed the
-- status update to monday.com).
--
-- NULL  → never pushed yet (the mark-partner-portal-active edge
--         function will pick it up on the partner's next login).
-- NOT NULL → already pushed; edge function no-ops on subsequent calls.
-- ============================================================

ALTER TABLE public.channel_partners
  ADD COLUMN IF NOT EXISTS monday_status_pushed_at timestamptz;

CREATE INDEX IF NOT EXISTS channel_partners_pending_monday_status_idx
  ON public.channel_partners (id)
  WHERE user_id IS NOT NULL
    AND monday_item_id IS NOT NULL
    AND monday_status_pushed_at IS NULL;

NOTIFY pgrst, 'reload schema';
