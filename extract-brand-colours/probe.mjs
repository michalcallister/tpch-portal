// ============================================================
// TPCH brand-colour extraction — local pressure-test harness
//
// Mirrors the edge function logic so we can iterate on heuristics
// without redeploying. Run with:
//   node tmp-brand-test/probe.mjs <url> [<url> ...]
//   node tmp-brand-test/probe.mjs --suite     # built-in partner sites
//
// Flags:
//   --no-css     Disable external stylesheet fetching (matches v1 edge fn)
//   --verbose    Print top 15 colours per source + chosen path
// ============================================================

const args = process.argv.slice(2);
const fetchExternalCss = !args.includes('--no-css');
const verbose          = args.includes('--verbose');
const useSuite         = args.includes('--suite');

const SUITE = [
  // Add real partner / candidate sites here as we collect them.
  'https://www.forgelegacy.com.au/',
  'https://www.tpch.com.au/',
  'https://www.ftruckswa.com.au/',
];

const urls = useSuite
  ? SUITE
  : args.filter(a => !a.startsWith('--'));

if (urls.length === 0) {
  console.error('Usage: node tmp-brand-test/probe.mjs <url> [<url> ...] [--no-css] [--verbose]');
  console.error('   or: node tmp-brand-test/probe.mjs --suite [--no-css] [--verbose]');
  process.exit(1);
}

const UA = 'Mozilla/5.0 TPCH-BrandColour-Bot';
const TIMEOUT_MS = 12_000;
const MAX_CSS_FILES = 3;
const MAX_CSS_BYTES = 1_500_000;
const MAX_HTML_BYTES = 2_000_000;

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,text/css,*/*' },
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status, body: '' };
    const body = await r.text();
    return { ok: true, status: r.status, body, finalUrl: r.url };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, body: '', err: String(e?.message || e) };
  }
}

function normaliseUrl(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).toString(); } catch { return null; }
}

// Resolve a stylesheet href relative to the page URL, skipping
// font CDNs and obvious analytics — we want CSS that defines the
// brand, not Google Fonts.
function resolveStylesheets(html, pageUrl) {
  const re = /<link[^>]+rel\s*=\s*["']?stylesheet["']?[^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    let href = hrefMatch[1];
    try {
      href = new URL(href, pageUrl).toString();
    } catch { continue; }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net/i.test(href)) continue;
    out.push(href);
    if (out.length >= MAX_CSS_FILES) break;
  }
  return out;
}

// ── Colour extraction (mirror of edge function) ────────────

function toHex(input) {
  const s = (input || '').trim().toLowerCase();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (/^[0-9a-f]{3}$/.test(h)) return '#' + h.split('').map(c => c + c).join('');
    if (/^[0-9a-f]{6}$/.test(h)) return '#' + h;
    if (/^[0-9a-f]{8}$/.test(h)) return '#' + h.slice(0, 6);
    return null;
  }
  if (s.startsWith('rgb')) {
    // Accept both legacy "rgb(0, 81, 242)" and modern "rgb(0 81 242 / .5)"
    const m = s.match(/(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
    if (!m) return null;
    return rgbToHex(+m[1], +m[2], +m[3]);
  }
  return null;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('');
}
function isGrey(hex) {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min <= 8;
}
function isExtreme(hex) {
  const [r, g, b] = hexToRgb(hex);
  if (r >= 245 && g >= 245 && b >= 245) return true;
  if (r <= 12  && g <= 12  && b <= 12)  return true;
  return false;
}
function deriveAccent(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * 0.75, g * 0.75, b * 0.75);
}

function mostFrequent(items) {
  const c = new Map();
  for (const it of items) c.set(it, (c.get(it) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function extractColours(text) {
  // 1. theme-color meta
  const meta = text.match(/<meta[^>]+name\s*=\s*["']?theme-color["']?[^>]*>/i);
  if (meta) {
    const c = meta[0].match(/content\s*=\s*["']?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))["']?/i);
    if (c) {
      const hex = toHex(c[1]);
      if (hex && !isGrey(hex)) {
        return { primary: hex, accent: deriveAccent(hex), source: 'theme-color-meta', all: [hex] };
      }
    }
  }

  // 2. CSS custom properties
  const cssVarRe = /--(?:primary|brand|brand-primary|brand-color|brand-colour|accent|theme|main-color|main-colour)[a-z0-9-]*\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/gi;
  const varColours = [];
  let m;
  while ((m = cssVarRe.exec(text)) !== null) {
    const hex = toHex(m[1]);
    if (hex && !isGrey(hex)) varColours.push(hex);
  }
  if (varColours.length > 0) {
    const ranked = mostFrequent(varColours);
    return {
      primary: ranked[0]?.[0] || null,
      accent:  ranked[1]?.[0] || (ranked[0] ? deriveAccent(ranked[0][0]) : null),
      source:  'css-variable',
      all:     ranked,
    };
  }

  // 3. Frequency: most common non-grey hex/rgb in the document
  const all = [];
  const hexRe = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
  let h;
  while ((h = hexRe.exec(text)) !== null) {
    const hex = toHex('#' + h[1]);
    if (hex && !isGrey(hex) && !isExtreme(hex)) all.push(hex);
  }
  const rgbRe = /rgba?\(\s*\d+\s*[,\s]\s*\d+\s*[,\s]\s*\d+(?:\s*[,/]\s*[\d.]+)?\s*\)/gi;
  let r;
  while ((r = rgbRe.exec(text)) !== null) {
    const hex = toHex(r[0]);
    if (hex && !isGrey(hex) && !isExtreme(hex)) all.push(hex);
  }
  if (all.length > 0) {
    const ranked = mostFrequent(all);
    return {
      primary: ranked[0]?.[0] || null,
      accent:  ranked[1]?.[0] || (ranked[0] ? deriveAccent(ranked[0][0]) : null),
      source:  'frequency',
      all:     ranked,
    };
  }
  return { primary: null, accent: null, source: 'none', all: [] };
}

// ── Per-URL probe ───────────────────────────────────────────

async function probe(rawUrl) {
  const url = normaliseUrl(rawUrl);
  if (!url) {
    console.log(`\n${rawUrl}\n  ✗ invalid URL`);
    return;
  }
  console.log(`\n=== ${url} ===`);

  const page = await fetchText(url);
  if (!page.ok) {
    console.log(`  ✗ fetch failed (${page.status} ${page.err || ''})`);
    return;
  }
  let html = page.body;
  if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
  console.log(`  HTML: ${html.length.toLocaleString()} bytes`);

  const sheets = fetchExternalCss ? resolveStylesheets(html, page.finalUrl || url) : [];
  let cssBytes = 0;
  let combinedCss = '';
  for (const sheet of sheets) {
    const r = await fetchText(sheet);
    if (!r.ok) {
      console.log(`  · stylesheet skipped (${r.status}): ${sheet}`);
      continue;
    }
    if (cssBytes + r.body.length > MAX_CSS_BYTES) {
      console.log(`  · stylesheet truncated (size cap): ${sheet}`);
      combinedCss += r.body.slice(0, MAX_CSS_BYTES - cssBytes);
      cssBytes = MAX_CSS_BYTES;
      break;
    }
    combinedCss += '\n' + r.body;
    cssBytes += r.body.length;
    console.log(`  · stylesheet ${r.body.length.toLocaleString()} bytes: ${sheet}`);
  }

  const corpusHtmlOnly = html;
  const corpusFull     = html + '\n' + combinedCss;

  const noCss = extractColours(corpusHtmlOnly);
  const full  = extractColours(corpusFull);

  console.log(`  → HTML only:     primary=${noCss.primary} accent=${noCss.accent}  via ${noCss.source}`);
  console.log(`  → HTML + CSS:    primary=${full.primary}  accent=${full.accent}   via ${full.source}`);

  if (verbose) {
    console.log('  -- top frequencies (HTML+CSS):');
    const top = Array.isArray(full.all) ? full.all.slice(0, 12) : [];
    for (const [hex, n] of top) console.log(`     ${String(n).padStart(4)}  ${hex}`);
  }
}

for (const u of urls) {
  await probe(u);
}
