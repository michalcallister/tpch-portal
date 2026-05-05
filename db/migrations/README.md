# `db/migrations/` — SQL applied to the Supabase project

These are reference scripts of every schema change applied to the
`oreklvbzwgbufbkvvzny` Supabase project. They are **not** run by any
CLI tool — historically each one is pasted into the Supabase Dashboard
SQL Editor and executed there. Kept in the repo so we have an
auditable record of the schema evolution.

## How to apply a new migration

1. Add a new `supabase-<feature>-migration.sql` (or `*-rls-patch.sql`,
   `*-rpc.sql`, etc.) to this folder.
2. Open the Supabase Dashboard → SQL Editor → paste the script.
3. Run it. Verify in the Table Editor / Auth / Functions panel as
   relevant.
4. Commit the file.

## Filename conventions

- `supabase-<thing>-migration.sql` — adds tables, columns, indexes
- `supabase-<thing>-rls-patch.sql` — RLS policy changes only
- `supabase-<thing>-rpc.sql` — RPC / SECURITY DEFINER function changes
- `supabase-preflight-checks.sql` — read-only verification queries
- `supabase-security-hardening.sql` — broad security pass (Apr 2026)

If you ever switch to the Supabase CLI's `supabase migration new`
flow, point it at this folder and rename to the timestamp format the
CLI expects.
