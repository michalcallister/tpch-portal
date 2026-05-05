# `_archive/` — preserved for reference, not deployed

Anything in here is intentionally kept around as a record but is **not**
the canonical source. The portal does not read from this folder, and
nothing in CI / Supabase deploys references it.

If you need disk space back, this folder is safe to delete.

## Contents

### `sync-monday-stale-2026-04-29/`

The old root-level copy of `sync-monday/index.ts` (887 lines, last
touched in commit `4cbfee9` on 2026-04-29). It was kept at the repo
root for historical reasons; the canonical, deployed version
(1205 lines, matches Supabase production) lives at
[../supabase/functions/sync-monday/](../supabase/functions/sync-monday/).

Kept in case anyone needs to diff the two later, but otherwise dead.

### `ctempcols.json`

A 46-byte stray file with a Unicode-glyph filename (looks like
`c:tempcols.json`). Contents are a captured shell error
(`/usr/bin/bash: line 9: -d: command not found`) — created by accident
during an old terminal session. Kept rather than deleted purely so the
git history shows where it went.

### `Michal_Digital_concept_art_*.png`

A 2 MB Midjourney-style concept image that was committed to the repo
root but is not referenced by `index.html`, `landing.html`, or any
edge function. Likely a leftover from an early hero-image experiment;
the actual hero is `hero-bg.jpg` at the repo root.
