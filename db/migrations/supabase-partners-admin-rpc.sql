-- ============================================================
-- TPCH — Partners admin list RPC
-- Run in Supabase SQL Editor (idempotent)
--
-- Returns the channel_partners list enriched with last_sign_in_at
-- from auth.users (joined by lower(email)). SECURITY DEFINER bypasses
-- RLS on auth.users; gate access in the client (admin-only page).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_partners_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(row ORDER BY (row->>'joined_at') DESC NULLS LAST)
    FROM (
      SELECT jsonb_build_object(
        'id',                       p.id,
        'full_name',                p.full_name,
        'email',                    p.email,
        'phone',                    p.phone,
        'company_name',             p.company_name,
        'state',                    p.state,
        'role_type',                p.role_type,
        'status',                   p.status,
        'joined_at',                p.joined_at,
        'logo_url',                 p.logo_url,
        'agreement_version',        p.agreement_version,
        'agreement_accepted_at',    p.agreement_accepted_at,
        'agreement_acceptance_id',  p.agreement_acceptance_id,
        'last_sign_in_at',          u.last_sign_in_at
      ) AS row
      FROM public.channel_partners p
      LEFT JOIN auth.users u ON lower(u.email) = lower(p.email)
    ) s
  ), '[]'::jsonb);
END;
$$;

NOTIFY pgrst, 'reload schema';
