-- Property photo gallery
-- ----------------------------------------------------------------------------
-- Adds a per-property photo gallery, mirroring the project gallery
-- (projects.photo_urls) but sourced from the "Photos" file column
-- (file_mm38fp8r) on the Monday Property board. sync-monday downloads each
-- image into the property-photos storage bucket and writes the public URLs
-- back here.
--
-- photo_urls        — ordered array of public storage URLs; NULL/empty means
--                     the portal shows no Gallery tab for that property.
-- photos_asset_sig  — signature of the Monday asset_ids last synced (ids joined
--                     with ','). Change detection: when the signature matches,
--                     the property is skipped entirely, so a sync cycle only
--                     re-downloads properties whose photos actually changed.
--
-- stock is an existing (grandfathered) table, so no new GRANTs are required for
-- the 30 Oct 2026 cutover — the partner client reads these columns via the
-- existing SELECT grant on public.stock.

ALTER TABLE public.stock
  ADD COLUMN IF NOT EXISTS photo_urls       text[],
  ADD COLUMN IF NOT EXISTS photos_asset_sig text;

-- ----------------------------------------------------------------------------
-- Storage bucket: property-photos (public, 15MB/file, image mime types only).
-- Public so the no-login share flyer can render the same images.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-photos',
  'property-photos',
  true,
  15728640, -- 15 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
