-- Property walkthrough videos
-- ----------------------------------------------------------------------------
-- Adds self-hosted walkthrough video support to the stock (property) table,
-- mirroring the floor-plan / HL-facade file pipeline. Videos are uploaded as a
-- file column ("Walkthrough Video", file_mm4ba51d) on the Monday Property board
-- and pulled into the property-videos storage bucket by sync-monday.
--
-- walkthrough_video_url       — public storage URL the portal/flyer plays from.
-- walkthrough_video_asset_id  — Monday asset_id of the last-synced file, used
--                               for change detection (re-upload only on swap)
--                               and to version the storage path so a new upload
--                               never serves a cached old video.
--
-- stock is an existing (grandfathered) table, so no new GRANTs are required for
-- the 30 Oct 2026 cutover — the partner client reads these columns via the
-- existing SELECT grant on public.stock.

ALTER TABLE public.stock
  ADD COLUMN IF NOT EXISTS walkthrough_video_url      text,
  ADD COLUMN IF NOT EXISTS walkthrough_video_asset_id text;

-- ----------------------------------------------------------------------------
-- Storage bucket: property-videos (public, 500MB/file, video mime types only).
-- Public so the no-login share flyer can stream the walkthrough.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-videos',
  'property-videos',
  true,
  524288000, -- 500 MB
  ARRAY['video/mp4','video/quicktime','video/webm','video/x-m4v','video/3gpp']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
