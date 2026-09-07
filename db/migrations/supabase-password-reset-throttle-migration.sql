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

-- ── Added 2026-09-07 ────────────────────────────────────────────────────────
-- Record the OUTCOME of every attempt, not just successful sends.
--
-- Originally a row only appeared once a link had been generated AND the email
-- attempted. An address matching no auth user returned early and wrote nothing,
-- so when a new admin reported "the reset doesn't work" there was no evidence
-- of what they'd typed or how far it got: the table was simply empty for them,
-- which is indistinguishable from never having tried. That cost us three days.
--
-- The caller still gets one identical generic response either way. This is
-- internal visibility only (service-role table, no grants, RLS on).
ALTER TABLE public.password_reset_requests
  ADD COLUMN IF NOT EXISTS last_outcome    text,
  ADD COLUMN IF NOT EXISTS last_error      text,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

COMMENT ON COLUMN public.password_reset_requests.last_outcome IS
  'sent | email_failed | no_such_user | throttled — what happened on the most recent attempt.';
COMMENT ON COLUMN public.password_reset_requests.last_attempt_at IS
  'Every attempt, including ones that sent nothing. last_sent_at only moves on an actual send.';
