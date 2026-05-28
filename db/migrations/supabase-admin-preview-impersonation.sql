-- ============================================================
-- TPCH Portal — Admin → Channel Partner Preview Mode
-- Run in Supabase SQL Editor
--
-- Why this migration is small: 5 of the 6 partner-facing RPCs already
-- take `p_partner_id` and gate via `(is_admin() OR current_partner_id() =
-- p_partner_id)`. An admin token already passes that gate for any
-- partner_id, so the frontend just needs to swap the partner_id it
-- sends. Only `get_my_brief()` has no arg today — it derives the
-- partner from `current_partner_id()`, which is NULL for admin
-- callers. We extend it with an optional `p_partner_id` so an admin
-- can request a specific partner's brief.
--
-- We also add `tpch_admin_preview_log` to record enter/exit of preview
-- sessions for future compliance.
-- ============================================================

-- ── 1. get_my_brief: add optional p_partner_id override ──────
-- Admins can pass any partner_id. Non-admins ignore the param and use
-- their own partner via current_partner_id().
--
-- Postgres treats a CREATE OR REPLACE with a different signature as an
-- overload, not a replacement. Drop the old no-arg version explicitly
-- so we end with exactly one function (and PostgREST doesn't get
-- confused about which to dispatch to for `{}` bodies).
DROP FUNCTION IF EXISTS public.get_my_brief();

CREATE OR REPLACE FUNCTION public.get_my_brief(p_partner_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_partner UUID;
  v_brief   public.daily_briefs%ROWTYPE;
  v_today   DATE;
BEGIN
  -- Resolve effective partner: admin override wins if supplied, else
  -- fall back to the caller's own partner.
  IF p_partner_id IS NOT NULL AND is_admin() THEN
    v_partner := p_partner_id;
  ELSE
    v_partner := current_partner_id();
  END IF;

  IF v_partner IS NULL THEN RETURN NULL; END IF;

  v_today := (current_date AT TIME ZONE 'Australia/Perth');

  SELECT * INTO v_brief FROM public.daily_briefs
   WHERE brief_date = v_today
   LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'id',             v_brief.brief_date,
    'brief_date',     v_brief.brief_date,
    'market_pulse',   v_brief.market_pulse,
    'pipeline_lines', '[]'::jsonb,
    'send_this',      v_brief.send_this,
    'generated_at',   v_brief.generated_at
  );
END;
$function$;

-- ── 2. tpch_admin_preview_log: audit table ──────────────────
-- One row per preview session: insert on enter, update exited_at on exit.
CREATE TABLE IF NOT EXISTS public.tpch_admin_preview_log (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_email   text         NOT NULL,
  partner_id    uuid         NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  entered_at    timestamptz  NOT NULL DEFAULT now(),
  exited_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_admin_preview_log_entered
  ON public.tpch_admin_preview_log (entered_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_preview_log_admin
  ON public.tpch_admin_preview_log (admin_email, entered_at DESC);

ALTER TABLE public.tpch_admin_preview_log ENABLE ROW LEVEL SECURITY;

-- Explicit GRANTs (per the 30 Oct 2026 cutover note in CLAUDE.md).
GRANT SELECT, INSERT, UPDATE ON public.tpch_admin_preview_log TO authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'tpch_admin_preview_log'
                    AND policyname = 'Admins read preview log') THEN
    CREATE POLICY "Admins read preview log"
      ON public.tpch_admin_preview_log
      FOR SELECT
      USING (public.is_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'tpch_admin_preview_log'
                    AND policyname = 'Admins insert preview log') THEN
    CREATE POLICY "Admins insert preview log"
      ON public.tpch_admin_preview_log
      FOR INSERT
      WITH CHECK (public.is_admin());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'tpch_admin_preview_log'
                    AND policyname = 'Admins update preview log') THEN
    CREATE POLICY "Admins update preview log"
      ON public.tpch_admin_preview_log
      FOR UPDATE
      USING (public.is_admin());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
