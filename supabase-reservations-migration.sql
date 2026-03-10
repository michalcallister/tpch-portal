-- ============================================================
-- TPCH Reservations Migration
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
-- ============================================================

-- 1. Create reservations table
CREATE TABLE IF NOT EXISTS public.reservations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id          text        NOT NULL REFERENCES public.stock(id),
  stock_name        text        NOT NULL,
  project_id        text,
  project_name      text,
  partner_id        uuid        NOT NULL REFERENCES public.channel_partners(id),
  partner_name      text        NOT NULL,
  partner_email     text        NOT NULL,
  client_name       text        NOT NULL,
  client_email      text        NOT NULL,
  client_phone      text,
  notes             text,
  status            text        NOT NULL DEFAULT 'active',  -- active | cancelled | expired | converted
  reserved_at       timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,                   -- reserved_at + 48 hours
  cancelled_at      timestamptz,
  cancelled_by      text,                                   -- 'partner' | 'system'
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reservations_partner_idx  ON public.reservations(partner_id);
CREATE INDEX IF NOT EXISTS reservations_stock_idx    ON public.reservations(stock_id);
CREATE INDEX IF NOT EXISTS reservations_status_idx   ON public.reservations(status);
CREATE INDEX IF NOT EXISTS reservations_expires_idx  ON public.reservations(expires_at) WHERE status = 'active';

-- 2. RLS
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'reservations' AND policyname = 'reservations_service_role'
  ) THEN
    CREATE POLICY reservations_service_role ON public.reservations
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 3. RPC: get_my_reservations
-- Returns active reservations for a partner with countdown info
CREATE OR REPLACE FUNCTION public.get_my_reservations(p_partner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',             r.id,
        'stock_id',       r.stock_id,
        'stock_name',     r.stock_name,
        'project_name',   r.project_name,
        'client_name',    r.client_name,
        'client_email',   r.client_email,
        'client_phone',   r.client_phone,
        'notes',          r.notes,
        'status',         r.status,
        'reserved_at',    r.reserved_at,
        'expires_at',     r.expires_at,
        'hours_remaining',GREATEST(0, EXTRACT(EPOCH FROM (r.expires_at - now())) / 3600),
        -- stock details for display
        'total_contract', s.total_contract,
        'bedrooms',       s.bedrooms,
        'bathrooms',      s.bathrooms,
        'availability',   s.availability
      ) ORDER BY r.reserved_at DESC
    ), '[]'::jsonb)
    FROM public.reservations r
    LEFT JOIN public.stock s ON s.id = r.stock_id
    WHERE r.partner_id = p_partner_id
      AND r.status = 'active'
  );
END;
$$;

-- 4. RPC: expire_reservations (called by cron edge function)
-- Marks expired reservations and reverts stock availability in Supabase
-- Returns list of expired reservation details for Monday.com write-back
CREATE OR REPLACE FUNCTION public.expire_reservations()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_expired jsonb;
BEGIN
  -- Get expiring reservations before updating
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           r.id,
      'stock_id',     r.stock_id,
      'stock_name',   r.stock_name,
      'project_name', r.project_name,
      'partner_email',r.partner_email,
      'partner_name', r.partner_name,
      'client_name',  r.client_name,
      'expires_at',   r.expires_at
    )
  ), '[]'::jsonb)
  INTO v_expired
  FROM public.reservations r
  WHERE r.status = 'active'
    AND r.expires_at < now();

  -- Mark as expired
  UPDATE public.reservations
  SET status = 'expired', cancelled_at = now(), cancelled_by = 'system'
  WHERE status = 'active'
    AND expires_at < now();

  -- Revert stock availability to Available for expired reservations
  UPDATE public.stock
  SET availability = 'Available'
  WHERE id IN (
    SELECT (value->>'stock_id')
    FROM jsonb_array_elements(v_expired)
  );

  RETURN v_expired;
END;
$$;
