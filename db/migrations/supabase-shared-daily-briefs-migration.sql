-- ============================================================
-- Shared "house brief" — one brief per day, all partners read it.
-- Applied to project oreklvbzwgbufbkvvzny on 2026-05-13
-- via Supabase MCP migration `shared_daily_briefs_migration`.
--
-- Mirrored here for repo history. Do not re-apply blindly.
--
-- Why:
--   Previously morning-brief-agent generated one brief per active
--   channel partner per day (one Claude call each, ~30k input
--   tokens each). That design was a personalisation-first stub
--   the prompt later walked back to "general market commentary,
--   never project-specific" — i.e. ~95% of the work was redundant.
--   At 5 partners it hit Anthropic's 30k input tokens/min limit
--   intermittently; at 50-100 partners it was structurally
--   infeasible on Supabase Edge Functions (150s invocation cap).
--
-- After:
--   - One Claude call per day → one row in `daily_briefs`.
--   - Every partner's `get_my_brief()` reads the same row.
--   - `partner_briefs` kept read-only for archival; no new writes.
--   - Cost: ~$0.05/day flat regardless of partner count.
--
-- Applied in two steps for zero-downtime:
--   STEP 1: create the table (this section runs first).
--   STEP 2: swap `get_my_brief()` to read from `daily_briefs`
--           (run AFTER the edge function has populated today's
--           row, so partners never see an empty brief between
--           the RPC swap and the next cron).
-- ============================================================

-- ── STEP 1: table ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.daily_briefs (
  brief_date      DATE PRIMARY KEY DEFAULT (current_date AT TIME ZONE 'Australia/Perth'),
  market_pulse    JSONB NOT NULL DEFAULT '[]'::jsonb,
  send_this       JSONB,
  source_version  TEXT NOT NULL DEFAULT 'v4-shared',
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_briefs ENABLE ROW LEVEL SECURITY;

-- No direct row access — partners read via the SECURITY DEFINER RPC below.
-- Service role writes happen out of band through the edge function.


-- ── STEP 2: RPC swap ────────────────────────────────────────
-- Same return shape as before (id, brief_date, market_pulse,
-- pipeline_lines, send_this, generated_at) so the frontend
-- renderBrief() needs no change. `pipeline_lines` is emitted
-- as an empty array for backwards-compat — it was already
-- deprecated to [] inside the agent's validateBrief.

CREATE OR REPLACE FUNCTION public.get_my_brief()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_partner UUID;
  v_brief   public.daily_briefs%ROWTYPE;
  v_today   DATE;
BEGIN
  v_partner := current_partner_id();
  IF v_partner IS NULL THEN RETURN NULL; END IF;

  v_today := (current_date AT TIME ZONE 'Australia/Perth');

  SELECT * INTO v_brief FROM public.daily_briefs
   WHERE brief_date = v_today
   LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'id',             v_brief.brief_date,    -- date doubles as id; frontend only uses it as a key
    'brief_date',     v_brief.brief_date,
    'market_pulse',   v_brief.market_pulse,
    'pipeline_lines', '[]'::jsonb,           -- kept for shape compatibility, always empty
    'send_this',      v_brief.send_this,
    'generated_at',   v_brief.generated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_brief() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_brief() TO authenticated;
