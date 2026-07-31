-- Flyer: property photos
-- ----------------------------------------------------------------------------
-- Adds stock.photo_urls to the share-flyer payload so the no-login flyer can
-- lead its Gallery with the property's own images (synced from the Monday
-- "Photos" column by sync-monday) before the development's photos.
--
-- Only change from the previous definition is the 'photo_urls' key on the
-- stock object. Everything else is reproduced verbatim.

CREATE OR REPLACE FUNCTION public.get_flyer_payload(
  p_stock_id   text,
  p_partner_id uuid,
  p_staff_id   uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stock   jsonb;
  v_project jsonb;
  v_partner jsonb;
  v_staff   jsonb;
BEGIN
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
    'walkthrough_video_url', s.walkthrough_video_url,
    'photo_urls',          s.photo_urls,
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

  -- Only expose name + email, and only for an active staff member of THIS
  -- firm: a staff id from another firm (or a guessed uuid) resolves to null
  -- and the card falls back to the owner.
  IF p_staff_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'full_name', ps.full_name,
      'email',     ps.email
    )
    INTO v_staff
    FROM public.partner_staff ps
    WHERE ps.id = p_staff_id
      AND ps.partner_id = p_partner_id
      AND ps.status = 'active';
  END IF;

  RETURN jsonb_build_object(
    'project', v_project,
    'stock',   v_stock,
    'partner', v_partner,
    'staff',   v_staff
  );
END;
$function$;
