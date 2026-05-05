-- ============================================================
-- TPCH Property Marketing Flyer Migration
-- Run in Supabase SQL Editor
-- ============================================================
--
-- Adds:
--   1. projects.map_lat / map_lng        — geocode-on-first-view cache
--   2. RPC get_flyer_payload(...)        — public (anon) read, no commission
--   3. RPC set_project_geocode(...)      — public (anon), idempotent write
--
-- The flyer URL is `#flyer/<stockId>/<partnerId>`. Both UUIDs come from the
-- URL — neither is privileged. The RPC enforces the field whitelist so the
-- response cannot leak commission, internal notes, or any other partner-only
-- column even if a malicious viewer crafts a request.
-- ============================================================

-- 1. Geocode cache columns on projects ────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS map_lat double precision,
  ADD COLUMN IF NOT EXISTS map_lng double precision;

-- 2. RPC: get_flyer_payload ───────────────────────────────────
-- Returns { project, stock, partner } as JSONB.
-- Whitelisted columns only — never selects comm_*, commission_*, or
-- partner-internal fields.
-- Note: stock.id and projects.id are text (Monday.com item IDs), not uuid.
-- channel_partners.id is uuid.
CREATE OR REPLACE FUNCTION public.get_flyer_payload(
  p_stock_id   text,
  p_partner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock   jsonb;
  v_project jsonb;
  v_partner jsonb;
BEGIN
  -- Stock (no commission, no internal flags)
  SELECT jsonb_build_object(
    'id',                  s.id,
    'project_id',          s.project_id,
    'name',                s.name,
    'lot_number',          s.lot_number,
    'level',               s.level,
    'bedrooms',            s.bedrooms,
    'bathrooms',           s.bathrooms,
    'car_parks',           s.car_parks,
    'build_internal_sqm',  s.build_internal_sqm,
    'build_external_sqm',  s.build_external_sqm,
    'build_total_sqm',     s.build_total_sqm,
    'lot_size_sqm',        s.lot_size_sqm,
    'land_price',          s.land_price,
    'build_price',         s.build_price,
    'total_contract',      s.total_contract,
    'rent_per_week',       s.rent_per_week,
    'annual_rent',         s.annual_rent,
    'floor_plan_url',      s.floor_plan_url,
    'property_type',       s.property_type,
    'smsf_eligible',       s.smsf_eligible,
    'title_forecast',      s.title_forecast
  )
  INTO v_stock
  FROM public.stock s
  WHERE s.id = p_stock_id;

  IF v_stock IS NULL THEN
    RETURN jsonb_build_object('error', 'stock_not_found');
  END IF;

  -- Project (no commission_*, no internal notes)
  -- hero_image_url: curated cover image used by the project tile in the
  -- portal. The flyer prefers this over photo_urls[0] so the cover stays
  -- consistent across surfaces.
  SELECT jsonb_build_object(
    'id',                       p.id,
    'name',                     p.name,
    'description',              p.description,
    'address',                  p.address,
    'suburb',                   p.suburb,
    'state',                    p.state,
    'region',                   p.region,
    'hero_image_url',           p.hero_image_url,
    'photo_urls',               p.photo_urls,
    'video_urls',               p.video_urls,
    'development_type',         p.development_type,
    'property_type',            p.property_type,
    'levels',                   p.levels,
    'total_volume',             p.total_volume,
    'year_constructed',         p.year_constructed,
    'est_construction_start',   p.est_construction_start,
    'est_construction_finish',  p.est_construction_finish,
    'map_lat',                  p.map_lat,
    'map_lng',                  p.map_lng
  )
  INTO v_project
  FROM public.projects p
  WHERE p.id = (v_stock->>'project_id');

  -- Partner (white-label branding + sharing team-member contact)
  -- brand_primary / brand_accent drive the flyer's --f-accent CSS token so the
  -- public page renders in the partner's colour scheme. Cached on
  -- channel_partners by the extract-brand-colours edge function.
  SELECT jsonb_build_object(
    'id',             cp.id,
    'full_name',      cp.full_name,
    'email',          cp.email,
    'phone',          cp.phone,
    'company_name',   cp.company_name,
    'logo_url',       cp.logo_url,
    'website',        cp.website,
    'brand_primary',  cp.brand_primary,
    'brand_accent',   cp.brand_accent
  )
  INTO v_partner
  FROM public.channel_partners cp
  WHERE cp.id = p_partner_id
    AND cp.status = 'active';

  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('error', 'partner_not_found');
  END IF;

  RETURN jsonb_build_object(
    'project', v_project,
    'stock',   v_stock,
    'partner', v_partner
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_flyer_payload(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_flyer_payload(text, uuid) TO anon, authenticated;

-- 3. RPC: set_project_geocode ─────────────────────────────────
-- Anon-callable, idempotent: writes lat/lng only when both columns are NULL.
-- Prevents a hostile actor from clobbering valid coords once cached.
CREATE OR REPLACE FUNCTION public.set_project_geocode(
  p_project_id text,
  p_lat        double precision,
  p_lng        double precision
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN false;
  END IF;
  IF p_lat < -90  OR p_lat > 90  THEN RETURN false; END IF;
  IF p_lng < -180 OR p_lng > 180 THEN RETURN false; END IF;

  UPDATE public.projects
     SET map_lat = p_lat,
         map_lng = p_lng
   WHERE id = p_project_id
     AND map_lat IS NULL
     AND map_lng IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.set_project_geocode(text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_project_geocode(text, double precision, double precision) TO anon, authenticated;

-- Reload PostgREST schema cache so the RPCs become callable immediately
NOTIFY pgrst, 'reload schema';
