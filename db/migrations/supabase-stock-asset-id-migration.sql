-- ============================================================
-- Stock asset-id tracking migration
--
-- Adds columns that record which Monday.com asset was last
-- uploaded for each per-stock file (floor plan, H&L facade).
-- The sync-monday edge function compares the Monday asset_id
-- against the stored value and only re-uploads when it differs,
-- so swapping a floor plan in Monday now propagates to the
-- portal instead of being silently skipped.
-- ============================================================

ALTER TABLE stock
  ADD COLUMN IF NOT EXISTS floor_plan_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS hl_facade_asset_id  TEXT;
