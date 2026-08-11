-- Flyer: annual outgoings (+ restore H&L payload keys)
-- ----------------------------------------------------------------------------
-- 1) Adds stock.rates_annual and stock.body_corporate_annual to the share-flyer
--    payload so the no-login flyer can show the annual outgoings a buyer
--    carries. Blank values render as "On Req." client-side.
--
-- 2) Restores three keys the flyer's own code has always read but the function
--    stopped returning: stock.development_type, stock.hl_inclusions and the
--    top-level suburb_research row. They were added by the v3.0 H&L release
--    (commit 8d16094, 1 May 2026) directly in the dashboard, then silently
--    dropped when the walkthrough-video / staff-contact / property-photos
--    migrations each rebuilt the function from the older repo copy. Net effect:
--    House & Land flyers have been rendering the Inclusions section hidden and
--    Location Highlights stuck on "Suburb research is in progress".
--
-- The suburb_research lookup mirrors the client: prefer the lot's own suburb
-- (multi-suburb portfolio projects carry it on the stock row), fall back to the
-- project's, and only ever match a published row. Only the handful of columns
-- the flyer renders are returned — drafts, thesis copy and internal review
-- fields stay out of a public payload.

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
  v_stock    jsonb;
  v_project  jsonb;
  v_partner  jsonb;
  v_staff    jsonb;
  v_research jsonb;
  v_suburb   text;
  v_state    text;
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
    'rates_annual',        s.rates_annual,
    'body_corporate_annual', s.body_corporate_annual,
    'floor_plan_url',      s.floor_plan_url,
    'walkthrough_video_url', s.walkthrough_video_url,
    'photo_urls',          s.photo_urls,
    'property_type',       s.property_type,
    'development_type',    s.development_type,
    'hl_inclusions',       s.hl_inclusions,
    'smsf_eligible',       s.smsf_eligible,
    'title_forecast',      s.title_forecast,
    'suburb',              s.suburb,
    'state',               s.state
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

  -- Published suburb research, for the H&L Location Highlights block.
  v_suburb := COALESCE(NULLIF(v_stock->>'suburb', ''), v_project->>'suburb');
  v_state  := COALESCE(NULLIF(v_stock->>'state',  ''), v_project->>'state');

  IF v_suburb IS NOT NULL THEN
    SELECT jsonb_build_object(
      'suburb',           sr.suburb,
      'state_code',       sr.state_code,
      'median_price',     sr.median_price,
      'weekly_rent',      sr.weekly_rent,
      'vacancy_rate',     sr.vacancy_rate,
      'avg_yield',        sr.avg_yield,
      'pillars',          sr.pillars,
      'comparable_sales', sr.comparable_sales,
      'sources',          sr.sources,
      'published_at',     sr.published_at,
      'updated_at',       sr.updated_at
    )
    INTO v_research
    FROM public.suburb_research sr
    WHERE sr.status = 'published'
      AND lower(sr.suburb) = lower(v_suburb)
      AND (v_state IS NULL OR upper(sr.state_code) = upper(v_state))
    ORDER BY sr.published_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'project',         v_project,
    'stock',           v_stock,
    'partner',         v_partner,
    'staff',           v_staff,
    'suburb_research', v_research
  );
END;
$function$;
