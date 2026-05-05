-- Allow decimal values in stock count columns.
--
-- sync-monday was rolling back full 100-row batches whenever Monday returned
-- a fractional value (e.g. bathrooms = 2.5) into an integer column, dropping
-- 55 stock items from the portal for 4+ days. numeric(4,1) lets the sync
-- accept fractional counts without rejecting the row.
--
-- Applied to oreklvbzwgbufbkvvzny on 2026-05-05.

ALTER TABLE public.stock
  ALTER COLUMN bathrooms TYPE numeric(4,1) USING bathrooms::numeric(4,1),
  ALTER COLUMN bedrooms  TYPE numeric(4,1) USING bedrooms::numeric(4,1),
  ALTER COLUMN car_parks TYPE numeric(4,1) USING car_parks::numeric(4,1),
  ALTER COLUMN study     TYPE numeric(4,1) USING study::numeric(4,1);
