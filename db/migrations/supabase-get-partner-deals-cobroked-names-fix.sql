-- get_partner_deals: match co-broked (comma-separated) channel_partner_name
-- ---------------------------------------------------------------------------
-- Applied 2026-06-05 (Saville Rowe active-deals fix).
--
-- Problem: the Team Deals dashboard calls get_partner_deals(p_partner_id),
-- which matched deals with `d.channel_partner_name ILIKE v_company_name`.
-- ILIKE with no wildcards is an exact (case-insensitive) match, so co-broked
-- deals — where Monday lists two firms in the channel-partner field, e.g.
-- "Saville Rowe Investment Property, Investors Choice Group" — never matched
-- and were invisible to the partner. Saville Rowe's four ACTIVE deals were all
-- co-broked, so his active pipeline looked empty.
--
-- Fix: match when the partner's company name is one of the comma-separated
-- firms on the deal. Only ever matches the REQUESTING partner's own name as a
-- token, so no deal leaks to an unrelated partner. Verified: of all partners,
-- only Saville Rowe's result set changed (4 -> 8); the four new rows are his
-- active co-broked deals.
--
-- Only the WHERE clause changed from the prior definition.

CREATE OR REPLACE FUNCTION public.get_partner_deals(p_partner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_company_name text;
BEGIN
  IF (is_admin() OR current_partner_id() = p_partner_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  SELECT company_name INTO v_company_name FROM public.channel_partners WHERE id = p_partner_id;
  IF v_company_name IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',                       d.id,
        'name',                     d.name,
        'property_id',              d.property_id,
        'project_id',               s.project_id,
        'property_name',            d.property_name,
        'client_name',              d.client_name,
        'stage',                    d.stage,
        'deal_value',               d.deal_value,
        'cos_executed_date',        d.cos_executed_date,
        'expected_approval_date',   d.expected_approval_date,
        'expected_settlement_date', d.expected_settlement_date,
        'fully_paid_date',          d.fully_paid_date,
        'paid_to_date',             d.paid_to_date,
        'deal_creation_date',       d.deal_creation_date,
        'developer',                d.developer,
        'entity',                   d.entity,
        'days_to_close',            d.days_to_close,
        'channel_commission',       COALESCE(
                                      s.channel_commission,
                                      s.channel_comm_flat,
                                      CASE
                                        WHEN s.channel_comm_pct IS NOT NULL AND s.total_contract IS NOT NULL
                                        THEN ROUND(s.total_contract * s.channel_comm_pct / 100)
                                        ELSE NULL
                                      END
                                    )
      ) ORDER BY
        CASE WHEN d.fully_paid_date IS NOT NULL THEN 1 ELSE 0 END,
        d.deal_creation_date DESC NULLS LAST
    ), '[]'::jsonb)
    FROM public.partner_deals d
    LEFT JOIN public.stock s ON s.id = d.property_id
    -- Match the partner's company name as one of the (possibly comma-separated,
    -- co-broked) firms listed on the deal, rather than requiring an exact
    -- whole-string match. Only ever matches the requesting partner's own name
    -- as a token, so no deal leaks to an unrelated partner.
    WHERE EXISTS (
      SELECT 1
      FROM unnest(string_to_array(d.channel_partner_name, ',')) AS firm
      WHERE btrim(firm) ILIKE v_company_name
    )
  );
END;
$function$;
