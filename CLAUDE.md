# tpch-portal — Claude Code instructions

## Versioning policy

**Tags are user-driven only.** Never create a new git tag on your own
initiative — even if a chunk of work feels significant. Wait for an
explicit "save this as vN" / "tag this version" / equivalent.

A prior session auto-tagged after every meaningful change and burned
through `v1…v8` in one sitting; a fresh session then had no idea what
the numbers meant. We avoid that by making tagging a deliberate, human
gesture and by keeping the tag registry in this file.

### How to tag (when asked)

```sh
git tag -a v3 <commit-sha> -m "v3 — short scope summary"
git push origin v3
```

- Format: simple `v<n>` for major milestones; `v<n>.<m>` for patches on
  top of an existing version (e.g. `v2.1`).
- Always annotated (`-a`) with a short message that reads as a milestone.
- Always pushed explicitly (a plain `git push` won't publish tags).
- Update the **Tag registry** below in the same commit so the file and
  the actual tags stay in sync.

### Authoritative current version

Run this — never guess from memory:

```sh
git tag --list --sort=-v:refname
```

Whatever's at the top is current.

### Tag registry

| Tag | Commit | Scope |
|---|---|---|
| `v1` | `d113a55` | Pre-redesign baseline. Stock portal still on left-rail filters and 3-column card grid; no map, no project lat/lng. |
| `v2` | `10f4e71` | Stock portal map-first redesign. Top-row filters, Leaflet map with clustered glass-gold pins, paginated right-pane list, brand-tinted Carto tiles, 401 self-healing fetch retry, sync-monday auto-geocoding, pct-first comm format. See [STOCK_PORTAL_DESIGN.md](STOCK_PORTAL_DESIGN.md) for full design reference. |

---

## Other repo notes

- Single-file SPA at [index.html](index.html) — no build step.
- Supabase project: `oreklvbzwgbufbkvvzny`. Edge functions live under
  `supabase/functions/`. Deploy individually via `supabase functions
  deploy <name>`.
- Static site is hosted on GitHub Pages; pushing to `main` auto-deploys.
- The page is gated by partner/admin login — `currentAuthToken` /
  `currentRefreshToken` drive every authenticated REST call. Use
  `fetchWithAuthRetry()` for new fetches that need to survive a 401.
- Stock-portal design conventions (colours, layout, components) are
  captured in [STOCK_PORTAL_DESIGN.md](STOCK_PORTAL_DESIGN.md) — apply
  the same patterns to other browse pages.
