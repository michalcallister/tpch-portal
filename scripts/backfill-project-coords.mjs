// ============================================================
// TPCH — backfill projects.latitude / projects.longitude
//
// Geocodes any project missing coordinates by hitting OpenStreetMap
// Nominatim with the project's `address` (preferred) or `suburb, state`
// fallback. Honours Nominatim's 1 req/sec rate-limit. Idempotent —
// rows that already have lat/lng are skipped.
//
// Required env vars:
//   SUPABASE_URL                — e.g. https://oreklvbzwgbufbkvvzny.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   — service-role key
//
// Optional:
//   --apply   actually PATCH the database (without it, the script
//             prints the geocoded plan and exits without writing).
//   --force   re-geocode even rows that already have lat/lng.
//
// Usage (from repo root):
//   node scripts/backfill-project-coords.mjs           # dry-run
//   node scripts/backfill-project-coords.mjs --apply   # writes
// ============================================================

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadProjects() {
  const url = SUPABASE_URL + '/rest/v1/projects?select=id,name,suburb,state,address,latitude,longitude&order=name';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('Failed to load projects: ' + res.status);
  return res.json();
}

async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tpch-portal/1.0 (admin@tpch.com.au)' }
  });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
}

async function patchCoords(id, lat, lng) {
  const url = SUPABASE_URL + '/rest/v1/projects?id=eq.' + encodeURIComponent(id);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ latitude: lat, longitude: lng }),
  });
  if (!res.ok) throw new Error('PATCH ' + id + ' failed: ' + res.status + ' ' + await res.text());
}

(async function main() {
  const projects = await loadProjects();
  console.log(`Loaded ${projects.length} projects.`);

  let geocoded = 0, skipped = 0, missing = 0, failed = 0;

  for (const p of projects) {
    const hasCoords = p.latitude != null && p.longitude != null;
    if (hasCoords && !FORCE) { skipped++; continue; }

    const query = p.address
      || ([p.suburb, p.state].filter(Boolean).join(', ') + (p.suburb || p.state ? ', Australia' : ''));
    if (!query.trim() || (!p.address && !p.suburb && !p.state)) {
      console.log(`  ⚠  ${p.name} — no address or suburb/state to geocode`);
      missing++;
      continue;
    }

    process.stdout.write(`  ${p.name.padEnd(28)} → ${query.slice(0, 60)} ... `);
    try {
      const result = await geocode(query);
      if (!result) {
        console.log('NOT FOUND');
        failed++;
      } else {
        console.log(`(${result.lat.toFixed(5)}, ${result.lng.toFixed(5)})`);
        if (APPLY) await patchCoords(p.id, result.lat, result.lng);
        geocoded++;
      }
    } catch (e) {
      console.log('ERROR: ' + e.message);
      failed++;
    }
    // Nominatim usage policy: max 1 req/sec
    await sleep(1100);
  }

  console.log('');
  console.log(`Summary: geocoded=${geocoded}, skipped=${skipped}, missing-address=${missing}, failed=${failed}`);
  if (!APPLY) console.log('(dry run — pass --apply to write to Supabase)');
})();
