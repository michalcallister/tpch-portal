-- ============================================================
-- TPCH Security Advisor Fixes
-- Resolves four ERROR-level lints flagged by the Supabase security
-- advisor on 2026-05-03 (email "Issues as of 03 May 2026"):
--
--   1. rls_disabled_in_public on public.report_downloads
--   2. security_definer_view on public.partner_reservation_stats
--   3. security_definer_view on public.suburb_research_admin
--   4. security_definer_view on public.research_open_comment_counts
-- ============================================================

-- ── 1. report_downloads — enable RLS ─────────────────────────
-- Audit trail for partners downloading reports / flyers. Currently
-- empty and not yet wired to a click handler; will be populated when
-- utilisation reporting is built. Enabling RLS with no policies denies
-- all access from anon and authenticated roles; only the service-role
-- key (inside edge functions) can read or write rows. Matches the
-- pattern used by reservations / project_analysis.
ALTER TABLE public.report_downloads ENABLE ROW LEVEL SECURITY;

-- ── 2. Views — switch SECURITY DEFINER → security_invoker ────
-- Postgres 15+ exposes the security_invoker view option. Setting it
-- true makes each view run with the querying user's permissions
-- instead of the view owner's, which is what the linter expects.
-- None of these views are called by partner-facing code; admin reads
-- happen via SECURITY DEFINER RPCs (get_partners_admin et al.) so
-- behaviour is unchanged.
ALTER VIEW public.partner_reservation_stats     SET (security_invoker = true);
ALTER VIEW public.suburb_research_admin         SET (security_invoker = true);
ALTER VIEW public.research_open_comment_counts  SET (security_invoker = true);
