-- ============================================================================
-- TPCH — password reset throttle
--
-- The portal used to call Supabase's /auth/v1/recover endpoint directly, which
-- meant password-reset emails came from Supabase's own mailer with its default
-- template, unlike every other email we send (all branded, via Resend). The
-- request-password-reset edge function replaces that path so resets look like
-- the rest of TPCH.
--
-- That endpoint has to be callable by a logged-out person, so it runs without
-- JWT verification and uses the service role to mint the recovery link. GoTrue's
-- own per-IP rate limiting no longer sits in front of it, so this table gives us
-- a per-email cooldown: someone who knows a partner's address can't use the form
-- to bomb their inbox.
--
-- Service-role only. The edge function hits it with the service key, which
-- bypasses RLS, so it needs no GRANTs to anon/authenticated (see the 30 Oct 2026
-- grants note in CLAUDE.md). RLS on with zero policies = nothing else can read
-- it, which matters because the row set is a list of email addresses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.password_reset_requests (
  email        text        PRIMARY KEY,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  send_count   integer     NOT NULL DEFAULT 1
);

ALTER TABLE public.password_reset_requests ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies and no grants: service role only.

COMMENT ON TABLE public.password_reset_requests IS
  'Per-email cooldown for request-password-reset. Service-role only; never exposed to the Data API.';
