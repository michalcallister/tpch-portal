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
| `v2` | `10f4e71` | Stock portal map-first redesign. Top-row filters, Leaflet map with clustered glass-gold pins, paginated right-pane list, brand-tinted Carto tiles, 401 self-healing fetch retry, sync-monday auto-geocoding, pct-first comm format. See [STOCK_PORTAL_DESIGN.md](docs/STOCK_PORTAL_DESIGN.md) for full design reference. |

---

## Partner-facing changelog

The "Version" link in the bottom-left of the sidebar opens a modal driven
by the `CHANGELOG` array in [index.html](index.html) (search for
`const CHANGELOG = [`). Every entry is visible to every partner, so the
bar is **only changes that make the portal better for them**.

### When to add an entry

Add (or update) an entry whenever you ship a change a partner would
notice and care about. **Examples that qualify:**

- A new feature or page partners can use (e.g. "Request a feature",
  "Team Deals", a new column in the deal pipeline).
- A redesign, layout shift, or material visual change to a surface
  partners spend time in.
- A new piece of intelligence (e.g. "Suburb Research now shows pillar
  X", "Stock map clusters above 8 pins").
- Behaviour changes that affect their workflow (e.g. "Reservations
  now expire after 14 days, not 7").

**Skip the entry for:**

- Internal refactors with no visible effect.
- Admin-only / TPCH-team-only features (admin password reset,
  enquiries dashboard tweaks, sync-monday changes).
- Bug fixes that restore expected behaviour without altering it.
- Edge-function or infrastructure changes invisible to partners.
- Doc, comment, or code-style work.

If you're unsure whether something qualifies, default to **not** adding
an entry. The log loses value if it's noisy.

### Format

Prepend (newest first) to the `CHANGELOG` array:

```js
{
  version: '2.1',
  date:    '30 Apr 2026',     // human-readable, no leading zeros
  title:   'Short headline',  // one line, sentence case, no marketing fluff
  items: [
    'One CP-facing change per bullet.',
    'Second-person friendly ("you can now…"), not technical.',
    'No internal IDs, file paths, or function names.',
  ],
},
```

### Version bump rule

- Bump the **minor** (1.5 → 1.6) for incremental ships: a new feature,
  a polish pass, a workflow tweak.
- Bump the **major** (1.x → 2.0) for redesigns or pages that change how
  partners use the portal.
- Don't reuse a version. If you've already shipped 1.5 and need to
  amend it, bump to 1.6.
- **Don't auto-tag in git** — that's still user-driven (see Versioning
  policy above). The changelog and the git tags are independent: the
  changelog ships as soon as the entry hits `main`; tags only happen
  when Mick says so.

### Commit-time workflow (this is the operating procedure)

The changelog reflects **shipped** state, so a new entry only ever
lands in the same commit that ships the change to `main`. No entry
during local iteration; no entry "in advance".

When Mick asks for a commit (or commit + push), follow this loop
**before** running `git commit`:

1. `git diff --staged` (or `git diff HEAD` if files aren't staged
   yet) — read the actual changes, don't guess from memory.
2. Classify each change against the qualifies/skip lists above.
   Default to **skip** if borderline.
3. **Outcomes:**
   - **No qualifying changes** → no changelog touch, no version
     bump, commit as-is.
   - **One or more qualifying changes** → prepend ONE new entry to
     the `CHANGELOG` array in [index.html](index.html), bump per
     the rule above, list each qualifying change as its own bullet
     under the same entry. Stage the `index.html` change so it
     goes in the same commit.
4. **One commit = at most one version entry.** Don't add two
   entries in one commit. If a commit bundles a CP-facing change
   plus refactors, the refactors don't get bullets — they're
   absorbed silently.
5. Use today's date for the entry. Get it via the `currentDate` in
   the system context, not from memory.

If Mick asks to amend or rewrite a recent commit, update the
matching CHANGELOG entry rather than adding a new one. If he asks
to revert a CP-facing change, remove the relevant bullet (and the
whole entry if that was the only bullet).

**Don't ask permission to add the entry** — just do it as part of
the commit prep and mention it briefly in the commit summary
("bump to v2.1 with changelog entry"). If Mick disagrees with the
classification, he'll say so and you can amend.

---

## Other repo notes

- Single-file SPA at [index.html](index.html) — no build step.
- Static site is hosted on GitHub Pages; pushing to `main` auto-deploys.
- The page is gated by partner/admin login — `currentAuthToken` /
  `currentRefreshToken` drive every authenticated REST call. Use
  `fetchWithAuthRetry()` for new fetches that need to survive a 401.
- Stock-portal design conventions (colours, layout, components) are
  captured in [STOCK_PORTAL_DESIGN.md](docs/STOCK_PORTAL_DESIGN.md) — apply
  the same patterns to other browse pages.

## Adaptive layout primitives (added 2026-05-13)

The portal is designed for desktop (100–200% browser zoom) and tablet
(down to ~768px). Phones (<480px) are explicitly out of scope. When
building new surfaces, reach for these primitives instead of fixed px:

- **Type scale tokens** at `:root`: `--type-xs / sm / md / lg / xl / 2xl`
  are `clamp()`-based fluid sizes. Use them on new headings, body, and
  stat values so type breathes at zoom.
- **Spacing tokens**: `--space-xs / sm / md / lg / xl` (4/8/14/22/32px).
- **Shell tokens**: `--sidebar-w` (240px expanded), `--sidebar-w-rail`
  (64px collapsed). The shell respects whichever via `var()`; toggling
  `#screen-portal.sidebar-collapsed` flips both sidebar width and
  `.main-content` `margin-left`.
- **Container queries** on map-split right panes: `.stk-rightpane` and
  `.rsc-rightpane` declare `container-type: inline-size`. Card rows
  reflow based on **pane width**, not viewport — use
  `@container stk-pane (max-width: ...)` for new card surfaces inside
  that pane.
- **Fluid map split**: prefer `minmax(min(420px, 100%), 58%)` over a
  hard pixel minimum so the pane can shrink at zoom.
- **Modal max-height**: any new modal should set
  `max-height: calc(100vh - 32px)` and put `overflow-y: auto` on the
  scrollable body so it can't run off-screen at zoom.
- **Tables**: wrap wide tables in a container with `overflow-x: auto`;
  give the `<table>` a `min-width` so columns don't collapse, and rely
  on the scroll for narrow widths.

## Folder layout

Tidy as of 2026-05-05. Anything not in this list at the repo root is
either site-critical (`index.html`, `landing.html`, `hero-bg.jpg`,
`TPCH_Marketing_Agreement_v1.docx`, `CNAME`) or a config/dotfile.

| Folder | What lives there |
|---|---|
| [supabase/functions/](supabase/functions/) | All 16 edge functions. Deploy via `supabase functions deploy <name>`. |
| [db/migrations/](db/migrations/) | All 22 SQL scripts applied to the Supabase project. Pasted into the dashboard SQL Editor — no CLI runner. |
| [docs/](docs/) | `PROJECT.md`, `SECURITY_HARDENING_DEPLOY.md`, `STOCK_PORTAL_DESIGN.md`. |
| [scripts/](scripts/) | One-off Node backfill scripts. |
| [_archive/](_archive/) | Dead code preserved for reference; safe to delete. |

## Supabase edge functions — deploy gotchas

- Project: `oreklvbzwgbufbkvvzny`.
- The folder name under `supabase/functions/` MUST match the Supabase
  function **slug** for `supabase functions deploy <name>` to update
  the existing function rather than create a new one.
- **`process-enquiry` is special**: its slug on Supabase is
  `quick-function` (display name `process-enquiry`). To redeploy the
  existing function, run **`supabase functions deploy quick-function
  --project-ref oreklvbzwgbufbkvvzny`** with the source temporarily
  copied/symlinked into `supabase/functions/quick-function/`. Or use
  the dashboard. Do not run `supabase functions deploy process-enquiry`
  blindly — it will create a duplicate function with no webhook.
- **`fetch-suburb-boundary` has no local source** — it's deployed
  (version 1, created 2026-05-01) but was authored in the dashboard.
  Pull it down with `supabase functions download fetch-suburb-boundary`
  before editing.
