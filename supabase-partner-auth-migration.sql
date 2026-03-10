-- ============================================================
-- TPCH Partner Auth Migration
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
-- ============================================================

-- 1. Add logo + notification prefs to channel_partners
ALTER TABLE public.channel_partners
  ADD COLUMN IF NOT EXISTS logo_url            text,
  ADD COLUMN IF NOT EXISTS notification_prefs  jsonb NOT NULL DEFAULT '{"new_listings":true,"deal_updates":true,"weekly_digest":false}';

-- 2. Create partner_staff table
CREATE TABLE IF NOT EXISTS public.partner_staff (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id          uuid        NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  full_name           text        NOT NULL,
  email               text        NOT NULL,
  role                text,                               -- e.g. "Adviser", "Associate"
  status              text        NOT NULL DEFAULT 'active',  -- active | inactive
  user_id             uuid,                               -- Supabase Auth user_id (set on first login)
  comm_display_type   text        NOT NULL DEFAULT 'portal',  -- portal | custom | hidden
  comm_custom_value   text,                               -- e.g. "$10,000" — only when type = 'custom'
  invited_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(email)
);

-- 3. RLS on partner_staff
ALTER TABLE public.partner_staff ENABLE ROW LEVEL SECURITY;

-- Service role bypass (Edge Functions)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'partner_staff' AND policyname = 'partner_staff_service_role'
  ) THEN
    CREATE POLICY partner_staff_service_role ON public.partner_staff
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Anon can do nothing (all access via Edge Functions or authenticated calls)
-- Partners can read their own firm's staff via RPC or Edge Function

-- 4. updated_at trigger for partner_staff
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS partner_staff_updated_at ON public.partner_staff;
CREATE TRIGGER partner_staff_updated_at
  BEFORE UPDATE ON public.partner_staff
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. RPC: get_my_partner_record
-- Called after Supabase Auth login — looks up partner or staff by email,
-- self-heals user_id if not yet set.
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
    -- Self-heal user_id
    IF v_partner.user_id IS NULL THEN
      UPDATE public.channel_partners SET user_id = p_user_id WHERE id = v_partner.id;
      v_partner.user_id := p_user_id;
    END IF;
    RETURN jsonb_build_object(
      'role',        'partner',
      'partner_id',  v_partner.id,
      'full_name',   v_partner.full_name,
      'email',       v_partner.email,
      'company_name',v_partner.company_name,
      'state',       v_partner.state,
      'logo_url',    v_partner.logo_url,
      'notification_prefs', v_partner.notification_prefs,
      'status',      v_partner.status
    );
  END IF;

  -- 2. Check if this is a staff member
  SELECT * INTO v_staff FROM public.partner_staff
    WHERE email = p_email AND status = 'active'
    LIMIT 1;

  IF FOUND THEN
    -- Self-heal user_id
    IF v_staff.user_id IS NULL THEN
      UPDATE public.partner_staff SET user_id = p_user_id WHERE id = v_staff.id;
      v_staff.user_id := p_user_id;
    END IF;
    -- Get owner firm details
    SELECT * INTO v_owner FROM public.channel_partners WHERE id = v_staff.partner_id;
    RETURN jsonb_build_object(
      'role',              'staff',
      'staff_id',          v_staff.id,
      'partner_id',        v_staff.partner_id,
      'full_name',         v_staff.full_name,
      'email',             v_staff.email,
      'job_role',          v_staff.role,
      'comm_display_type', v_staff.comm_display_type,
      'comm_custom_value', v_staff.comm_custom_value,
      'company_name',      v_owner.company_name,
      'logo_url',          v_owner.logo_url,
      'notification_prefs',v_owner.notification_prefs,
      'status',            v_staff.status
    );
  END IF;

  RETURN NULL;
END;
$$;

-- 6. RPC: get_partner_staff (called by partner owner to manage their team)
CREATE OR REPLACE FUNCTION public.get_partner_staff(p_partner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',               id,
        'full_name',        full_name,
        'email',            email,
        'role',             role,
        'status',           status,
        'comm_display_type',comm_display_type,
        'comm_custom_value',comm_custom_value,
        'invited_at',       invited_at
      ) ORDER BY created_at
    )
    FROM public.partner_staff
    WHERE partner_id = p_partner_id
  );
END;
$$;
