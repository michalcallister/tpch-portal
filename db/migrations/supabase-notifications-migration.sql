-- ============================================================
-- TPCH Partner Notifications Migration
-- Run in Supabase SQL Editor
-- Idempotent — safe to re-run
-- ============================================================

-- 1. Add notified_at to stock table (flags items that haven't had notifications sent yet)
ALTER TABLE public.stock
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- 2. Create partner_notifications table
CREATE TABLE IF NOT EXISTS public.partner_notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid        NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'general',   -- new_listing | deal_update | general
  title       text        NOT NULL,
  message     text,
  link_type   text,                                     -- 'stock' | 'project' | null
  link_id     text,                                     -- stock or project id for navigation
  read        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_notifications_partner_idx
  ON public.partner_notifications(partner_id, read, created_at DESC);

-- 3. RLS
ALTER TABLE public.partner_notifications ENABLE ROW LEVEL SECURITY;

-- Service role full access (sync function writes notifications)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'partner_notifications' AND policyname = 'notif_service_role'
  ) THEN
    CREATE POLICY notif_service_role ON public.partner_notifications
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 4. RPC: get_partner_notifications
CREATE OR REPLACE FUNCTION public.get_partner_notifications(p_partner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',         id,
        'type',       type,
        'title',      title,
        'message',    message,
        'link_type',  link_type,
        'link_id',    link_id,
        'read',       read,
        'created_at', created_at
      ) ORDER BY created_at DESC
    )
    FROM public.partner_notifications
    WHERE partner_id = p_partner_id
    LIMIT 50
  );
END;
$$;

-- 5. RPC: mark_all_notifications_read
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_partner_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.partner_notifications
    SET read = true
    WHERE partner_id = p_partner_id AND read = false;
END;
$$;

-- 6. RPC: mark_notification_read
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id uuid, p_partner_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.partner_notifications
    SET read = true
    WHERE id = p_notification_id AND partner_id = p_partner_id;
END;
$$;
