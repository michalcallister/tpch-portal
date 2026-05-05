-- ============================================================
-- TPCH Marketing Agreement Acceptance Migration
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
--
-- Architecture:
--   * agreement_acceptances  = append-only audit log (court-ready evidence)
--   * pending_enquiries / channel_partners hold denormalised summary fields
--     (version, accepted_at, acceptance_id) for fast UI lookups.
--   * All writes happen via the accept-agreement Edge Function using the
--     service role key. RLS blocks anon and authenticated users from writing.
-- ============================================================

-- 1. Append-only audit table — the legal source of truth.
CREATE TABLE IF NOT EXISTS public.agreement_acceptances (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id          uuid          REFERENCES public.channel_partners(id) ON DELETE SET NULL,
  enquiry_id          uuid          REFERENCES public.pending_enquiries(id) ON DELETE SET NULL,
  email               text          NOT NULL,
  agreement_version   text          NOT NULL,
  agreement_sha256    text          NOT NULL,
  accepted_at         timestamptz   NOT NULL DEFAULT now(),
  ip_address          inet,
  user_agent          text,
  method              text          NOT NULL,         -- 'enquiry' | 'blocker' | 'admin_invite'
  checkbox_text       text          NOT NULL,
  raw_headers         jsonb,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_email      ON public.agreement_acceptances (email);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_partner    ON public.agreement_acceptances (partner_id);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_enquiry    ON public.agreement_acceptances (enquiry_id);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_version    ON public.agreement_acceptances (agreement_version, accepted_at DESC);

ALTER TABLE public.agreement_acceptances ENABLE ROW LEVEL SECURITY;

-- Anon and authenticated roles get NO access. Only service_role (edge function)
-- writes. Admin reads will need a SECURITY DEFINER RPC or service-role client.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agreement_acceptances' AND policyname='deny_all_anon') THEN
    CREATE POLICY deny_all_anon ON public.agreement_acceptances
      FOR ALL TO anon USING (false) WITH CHECK (false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agreement_acceptances' AND policyname='deny_all_authenticated') THEN
    CREATE POLICY deny_all_authenticated ON public.agreement_acceptances
      FOR ALL TO authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;

-- 2. Denormalised summary fields on pending_enquiries (UI quick-lookups).
--    The audit row in agreement_acceptances is the legal source of truth.
ALTER TABLE public.pending_enquiries
  ADD COLUMN IF NOT EXISTS agreement_version       text,
  ADD COLUMN IF NOT EXISTS agreement_accepted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS agreement_acceptance_id uuid REFERENCES public.agreement_acceptances(id) ON DELETE SET NULL;

-- 3. Same on channel_partners (copied across on approval, or written when an
--    existing partner accepts via the blocker modal).
ALTER TABLE public.channel_partners
  ADD COLUMN IF NOT EXISTS agreement_version       text,
  ADD COLUMN IF NOT EXISTS agreement_accepted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS agreement_acceptance_id uuid REFERENCES public.agreement_acceptances(id) ON DELETE SET NULL;

-- 4. RPC for admins to read the acceptance log (SECURITY DEFINER bypasses RLS).
--    Call from admin panel; gated client-side by adminEmails check.
CREATE OR REPLACE FUNCTION public.get_agreement_acceptances(p_partner_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',                a.id,
        'partner_id',        a.partner_id,
        'enquiry_id',        a.enquiry_id,
        'email',             a.email,
        'agreement_version', a.agreement_version,
        'agreement_sha256',  a.agreement_sha256,
        'accepted_at',       a.accepted_at,
        'ip_address',        a.ip_address::text,
        'user_agent',        a.user_agent,
        'method',            a.method,
        'checkbox_text',     a.checkbox_text
      ) ORDER BY a.accepted_at DESC
    )
    FROM public.agreement_acceptances a
    WHERE p_partner_id IS NULL OR a.partner_id = p_partner_id
  ), '[]'::jsonb);
END;
$$;

-- 3. RPC: get_my_partner_record — include agreement fields in the returned jsonb
--    (Staff inherit their owner firm's acceptance state.)
CREATE OR REPLACE FUNCTION public.get_my_partner_record(p_email text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_partner  public.channel_partners%ROWTYPE;
  v_staff    public.partner_staff%ROWTYPE;
  v_owner    public.channel_partners%ROWTYPE;
BEGIN
  -- 1. Check if this is a partner owner
  SELECT * INTO v_partner FROM public.channel_partners
    WHERE email = p_email AND status = 'active'
    LIMIT 1;

  IF FOUND THEN
    IF v_partner.user_id IS NULL THEN
      UPDATE public.channel_partners SET user_id = p_user_id WHERE id = v_partner.id;
      v_partner.user_id := p_user_id;
    END IF;
    RETURN jsonb_build_object(
      'role',                  'partner',
      'partner_id',            v_partner.id,
      'full_name',             v_partner.full_name,
      'email',                 v_partner.email,
      'company_name',          v_partner.company_name,
      'state',                 v_partner.state,
      'logo_url',              v_partner.logo_url,
      'notification_prefs',    v_partner.notification_prefs,
      'status',                v_partner.status,
      'agreement_version',     v_partner.agreement_version,
      'agreement_accepted_at', v_partner.agreement_accepted_at
    );
  END IF;

  -- 2. Check if this is a staff member
  SELECT * INTO v_staff FROM public.partner_staff
    WHERE email = p_email AND status = 'active'
    LIMIT 1;

  IF FOUND THEN
    IF v_staff.user_id IS NULL THEN
      UPDATE public.partner_staff SET user_id = p_user_id WHERE id = v_staff.id;
      v_staff.user_id := p_user_id;
    END IF;
    SELECT * INTO v_owner FROM public.channel_partners WHERE id = v_staff.partner_id;
    RETURN jsonb_build_object(
      'role',                  'staff',
      'staff_id',              v_staff.id,
      'partner_id',            v_staff.partner_id,
      'full_name',             v_staff.full_name,
      'email',                 v_staff.email,
      'job_role',              v_staff.role,
      'comm_display_type',     v_staff.comm_display_type,
      'comm_custom_value',     v_staff.comm_custom_value,
      'company_name',          v_owner.company_name,
      'logo_url',              v_owner.logo_url,
      'notification_prefs',    v_owner.notification_prefs,
      'status',                v_staff.status,
      'agreement_version',     v_owner.agreement_version,
      'agreement_accepted_at', v_owner.agreement_accepted_at
    );
  END IF;

  RETURN NULL;
END;
$$;

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
