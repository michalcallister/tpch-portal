// ============================================================
// TPCH — one-off backfill: channel_partners.monday_item_id
//
// Matches each Supabase channel_partners row to its Monday.com
// Channel Partners board item by email (case-insensitive). Logs
// any partner with no email match for manual review.
//
// Run after applying supabase-partners-monday-id-migration.sql.
//
// Required env vars:
//   SUPABASE_URL                — e.g. https://oreklvbzwgbufbkvvzny.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   — service-role key from Supabase Dashboard → API
//   MONDAY_API_TOKEN            — Monday.com personal API token
//
// Usage (from repo root):
//   node scripts/backfill-partner-monday-ids.mjs           # dry-run, prints plan
//   node scripts/backfill-partner-monday-ids.mjs --apply   # writes monday_item_id
// ============================================================

const APPLY = process.argv.includes('--apply');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN;
const PARTNERS_BOARD_ID = 8393705888;
const EMAIL_COL = 'email_mkmvh4p6';

if (!SUPABASE_URL || !SUPABASE_KEY || !MONDAY_TOKEN) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MONDAY_API_TOKEN');
  process.exit(1);
}

// ── Pull every Channel Partner item from Monday (paginated) ──
async function fetchAllPartnerItems() {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: ${JSON.stringify(cursor)}) { cursor items { id name column_values(ids: ["${EMAIL_COL}"]) { id text value } } } }`
      : `query { boards(ids: [${PARTNERS_BOARD_ID}]) { items_page(limit: 100) { cursor items { id name column_values(ids: ["${EMAIL_COL}"]) { id text value } } } } }`;
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2023-10' },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    if (json.errors) {
      console.error('Monday GraphQL error:', JSON.stringify(json.errors));
      process.exit(1);
    }
    const pageData = cursor ? json.data.next_items_page : json.data.boards[0].items_page;
    items.push(...pageData.items);
    cursor = pageData.cursor;
    if (!cursor) break;
  }
  return items;
}

// Email column reads as text "user@example.com" or value JSON {"email":"...","text":"..."}
function extractEmail(item) {
  const col = item.column_values?.[0];
  if (!col) return null;
  if (col.text) return col.text.trim().toLowerCase();
  if (col.value) {
    try {
      const v = JSON.parse(col.value);
      return (v.email || v.text || '').trim().toLowerCase() || null;
    } catch { /* fall through */ }
  }
  return null;
}

// ── Pull every Supabase partner row needing a monday_item_id ──
async function fetchPartnersNeedingId() {
  const url = `${SUPABASE_URL}/rest/v1/channel_partners?select=id,full_name,email,company_name,monday_item_id&monday_item_id=is.null`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    console.error('Supabase select failed:', res.status, await res.text());
    process.exit(1);
  }
  return res.json();
}

async function updatePartner(partnerId, mondayItemId) {
  const url = `${SUPABASE_URL}/rest/v1/channel_partners?id=eq.${partnerId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ monday_item_id: String(mondayItemId) }),
  });
  if (!res.ok) {
    console.error(`  ✗ update failed for ${partnerId}:`, res.status, await res.text());
    return false;
  }
  return true;
}

// ── Main ────────────────────────────────────────────────────
(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (preview only — pass --apply to commit)'}`);
  console.log(`Pulling Channel Partners board (${PARTNERS_BOARD_ID})…`);
  const mondayItems = await fetchAllPartnerItems();
  console.log(`  → ${mondayItems.length} items on board`);

  const byEmail = new Map();
  for (const item of mondayItems) {
    const email = extractEmail(item);
    if (email) byEmail.set(email, item);
  }
  console.log(`  → ${byEmail.size} items have an email`);

  console.log('Pulling channel_partners with monday_item_id IS NULL…');
  const partners = await fetchPartnersNeedingId();
  console.log(`  → ${partners.length} partners need backfill`);

  const matched = [];
  const unmatched = [];
  for (const p of partners) {
    const key = (p.email || '').trim().toLowerCase();
    const item = byEmail.get(key);
    if (item) matched.push({ partner: p, item });
    else unmatched.push(p);
  }

  console.log(`\n=== Matched: ${matched.length} ===`);
  for (const { partner, item } of matched) {
    console.log(`  ${partner.email.padEnd(40)} → Monday item ${item.id} (${item.name})`);
  }

  console.log(`\n=== Unmatched: ${unmatched.length} ===`);
  for (const p of unmatched) {
    console.log(`  ${p.email.padEnd(40)} (${p.company_name})`);
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to write monday_item_id.');
    return;
  }

  console.log('\nApplying updates…');
  let ok = 0, fail = 0;
  for (const { partner, item } of matched) {
    const success = await updatePartner(partner.id, item.id);
    if (success) ok++; else fail++;
  }
  console.log(`\nDone. Updated ${ok}, failed ${fail}, unmatched ${unmatched.length}.`);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
