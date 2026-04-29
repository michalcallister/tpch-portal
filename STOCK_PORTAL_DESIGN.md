# Stock Portal — design + implementation reference

This document captures every layout, styling, and behavioural decision baked
into the Stock Portal redesign so the same patterns can be applied to other
pages (e.g. the Research page) in a fresh session.

Everything below lives in the single SPA file [tpch-portal/index.html](tpch-portal/index.html) — there's no build step or component framework.

---

## 1. Page concept

The page is a **map-first browse experience**:

- Top header row: page tabs (Projects / Stock) + count + view toggle (grid / pin)
- Top filter row: search + 5 inline filter dropdowns + "More filters" popover + "Clear all"
- Body (Projects → Map view): interactive Leaflet map on the left + paginated list of project rows on the right
- Body (Projects → List view): existing 3-column card grid (full width)
- Body (Stock tab): per-lot table (full width)
- Pager + "Show N per page" footer pinned to the bottom of the right pane / grid

The whole page must fit inside the viewport with **no document scroll**.

---

## 2. Brand tokens (already in `:root`)

```
--gold:        #C8A951    /* primary brand gold              */
--gold-light:  #E8D48B    /* gold sheen highlight            */
--gold-pale:   #F5E8C0
--gold-dim:    rgba(200,169,81,0.10)   /* hover / active fill */
--gold-border: rgba(200,169,81,0.22)

--black:       #080F1A    /* darkest — header strip          */
--black-soft:  #0F1B2D    /* recessed input surfaces         */
--black-card:  #152238    /* nav + main centre tone          */
--black-hover: #1A2D47    /* hover / row hover               */
--grey:        #2A3A50
--grey-mid:    #5A6878
--grey-light:  #98A5B3
--grey-pale:   #C8D8E8
--text-muted:  #B8C2CC
--white:       #F5F3EE
```

The centre of any redesigned page should use `--black-card` so it flows
into the sidebar tone. Inputs/selects use `--black-soft`. The single
darker strip across the top (header row with tabs / view toggle) uses
`--black`. Floating popovers use `--black` for elevation.

---

## 3. Page shell sizing — no document scroll

The naive `height: calc(100vh - 61px)` approach breaks because the topbar
height varies. Use this pattern instead:

```css
.<page>-browse-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--black-card);
}

#page-<name>.page-view { display: none; }
#page-<name>.page-view.active {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.main-content:has(#page-<name>.page-view.active) {
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
}
```

The `:has()` rule pins `.main-content` to exactly 100vh **only when this
page is active**, so other pages keep their min-height: 100vh behaviour
and don't clip.

---

## 4. Header row (Projects / Stock tabs + view toggle)

```html
<div class="<x>-header-row">
  <div class="<x>-browse-tabs">
    <button class="<x>-browse-tab active">Projects</button>
    <button class="<x>-browse-tab">Stock</button>
  </div>
  <div class="<x>-header-right">
    <div class="<x>-count">8 projects with available stock</div>
    <button class="<x>-sync-btn">⟳ Sync Now</button>
    <div class="<x>-view-btns">
      <button class="<x>-view-btn">[grid icon SVG]</button>
      <button class="<x>-view-btn active">[pin icon SVG]</button>
    </div>
  </div>
</div>
```

```css
.<x>-header-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 24px;
  border-bottom: 1px solid var(--gold-border);
  flex-shrink: 0; gap: 12px;
  background: var(--black);                /* the only dark strip */
}
.<x>-header-right { display: flex; align-items: center; gap: 12px; }
.<x>-browse-tab {
  padding: 8px 20px; font-size: 13px; letter-spacing: 0.8px;
  text-transform: uppercase; font-family: 'DM Mono', monospace;
  background: transparent; border: 1px solid var(--gold-border);
  color: var(--text-muted); cursor: pointer;
}
.<x>-browse-tab.active { background: var(--gold-dim); border-color: var(--gold); color: var(--gold); }
.<x>-view-btn {
  padding: 7px 12px; border: 1px solid var(--gold-border);
  background: none; cursor: pointer; color: var(--text-muted);
}
.<x>-view-btn.active, .<x>-view-btn:hover {
  border-color: var(--gold); color: var(--gold); background: var(--gold-dim);
}
```

Tab → `switchXBrowse(mode, el)` toggles between two body modes (e.g. map/list vs table).
View toggle → `switchXView('map' | 'list')` switches inside the Projects mode only.
View toggle is hidden when Stock tab is active.

---

## 5. Top filter row (5 dropdowns + More filters + Clear all)

```html
<div class="<x>-filter-row" id="<x>-filter-row">
  <div class="<x>-search-wrap">
    <input type="text" id="<x>-search" class="<x>-search-input" placeholder="Search projects" oninput="onXSearchInput()">
    <span class="<x>-search-icon">🔍</span>
  </div>

  <!-- one .<x>-fdrop per filter -->
  <div class="<x>-fdrop" data-fdrop="avail">
    <button class="<x>-fdrop-btn" onclick="toggleXFdrop('avail',this)">
      <span class="<x>-fdrop-label">Availability</span>
      <span class="<x>-fdrop-value" id="<x>-fdrop-avail-val">All</span>
      <span class="<x>-fdrop-caret">▾</span>
    </button>
    <div class="<x>-fdrop-pop"> <!-- pill rows live here --> </div>
  </div>

  <!-- More filters at the rightmost dropdown spot, popover anchored right -->
  <div class="<x>-fdrop <x>-fdrop-more" data-fdrop="more">
    <button class="<x>-fdrop-btn" onclick="toggleXFdrop('more',this)">
      <span class="<x>-fdrop-caret-icon">⚙</span>
      <span class="<x>-fdrop-value">More filters</span>
      <span class="<x>-fdrop-badge" id="<x>-fdrop-more-badge" style="display:none">0</span>
    </button>
    <div class="<x>-fdrop-pop <x>-fdrop-pop-wide <x>-fdrop-pop-right">
      <!-- secondary filter groups -->
    </div>
  </div>

  <button class="<x>-clearall" onclick="resetXFilters()">↺ Clear all</button>
</div>
```

Key CSS:

```css
.<x>-filter-row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--gold-border);
  flex-shrink: 0; flex-wrap: wrap;
}
.<x>-search-input {
  width: 100%; padding: 10px 36px 10px 14px;
  background: var(--black-soft);
  border: 1px solid var(--gold-border);
  color: var(--white); font-size: 13px;
}
.<x>-fdrop { position: relative; }
.<x>-fdrop-btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px;
  background: var(--black-soft);
  border: 1px solid var(--gold-border);
  color: var(--grey-pale); font-size: 13px;
}
.<x>-fdrop.has-value .<x>-fdrop-btn { border-color: var(--gold); color: var(--gold); }
.<x>-fdrop-label {
  font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text-muted); display: block; line-height: 1.2;
}
.<x>-fdrop-value {
  font-size: 13px; color: var(--white); display: block; line-height: 1.2;
  white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
}
.<x>-fdrop-pop {
  position: absolute; top: calc(100% + 6px); left: 0;
  z-index: 1100;                  /* must beat Leaflet's 800 z-index */
  background: var(--black);
  border: 1px solid var(--gold-border);
  padding: 14px 16px; min-width: 240px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  display: none;
}
.<x>-fdrop-pop-right { left: auto; right: 0; } /* anchor to right edge so it doesn't overflow viewport */
.<x>-fdrop.open .<x>-fdrop-pop { display: block; }
.<x>-clearall { margin-left: auto; }       /* push to far right */
```

JS contract:

```js
function toggleXFdrop(key, btn) {
  const drop = btn.closest('.<x>-fdrop');
  const wasOpen = drop.classList.contains('open');
  document.querySelectorAll('.<x>-fdrop').forEach(d => d.classList.remove('open'));
  if (!wasOpen) drop.classList.add('open');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.<x>-fdrop'))
    document.querySelectorAll('.<x>-fdrop').forEach(d => d.classList.remove('open'));
});

// Sync the "value" text + has-value border + More-filters badge after every filter change
function updateXFdropSummaries() { /* per-dropdown text + badge count for popover extras */ }
```

Each filter input still uses the existing pill UI; the popover just
relocates the existing pill rows. Dropdown buttons reset `page = 1` and call
`updateXFdropSummaries()` after every change.

---

## 6. Body modes

```html
<div class="<x>-body">
  <!-- map mode (Projects + map view) -->
  <div class="<x>-projects-map" id="<x>-projects-map">
    <div class="<x>-mapwrap">
      <div id="<x>-map" class="<x>-map"></div>
      <div class="<x>-mapkey">…cluster legend…</div>
    </div>
    <div class="<x>-rightpane">
      <div class="<x>-rightpane-head">…count + sort…</div>
      <div class="<x>-rightpane-list" id="<x>-rightpane-list"></div>
      <div class="<x>-rightpane-footer">…pager + per-page…</div>
    </div>
  </div>

  <!-- list mode (Projects + list view) -->
  <div class="<x>-projects-grid-wrap" id="<x>-projects-grid-wrap" style="display:none">
    <div class="<x>-cards" id="<x>-cards"></div>
    <div class="<x>-rightpane-footer <x>-rightpane-footer-grid">…pager + per-page…</div>
  </div>

  <!-- stock mode -->
  <div id="<x>-stock-table-wrap" style="display:none">…table…</div>
</div>
```

```css
.<x>-body { flex: 1; overflow: hidden; display: flex; min-height: 0; }
.<x>-body > * { flex: 1; min-width: 0; min-height: 0; }
.<x>-projects-map { display: grid; grid-template-columns: minmax(0, 1fr) minmax(720px, 58%); height: 100%; }
.<x>-mapwrap { position: relative; background: var(--black-card); border-right: 1px solid var(--gold-border); }
.<x>-map { position: absolute; inset: 0; }
```

---

## 7. Leaflet map setup

CDN imports added to `<head>`:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css">

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js"></script>
```

```js
xLeafletMap = L.map(mapEl, {
  center: [-27, 134], zoom: 4,
  zoomControl: false,                  // re-add at bottomleft below
  attributionControl: false,
  minZoom: 3, maxZoom: 18,
});
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 19,
}).addTo(xLeafletMap);
L.control.zoom({ position: 'bottomleft' }).addTo(xLeafletMap);
L.control.attribution({ prefix: false, position: 'bottomright' })
  .addAttribution('<span style="font-size:9px;color:#555">© CARTO © OSM</span>')
  .addTo(xLeafletMap);

xMarkerCluster = L.markerClusterGroup({
  maxClusterRadius: 50,
  showCoverageOnHover: false,
  iconCreateFunction: function(cluster) {
    const n = cluster.getChildCount();
    const size = n >= 10 ? 44 : n >= 3 ? 36 : 30;
    return L.divIcon({
      html: `<div class="<x>-cluster" style="width:${size}px;height:${size}px;">${n}</div>`,
      className: '', iconSize: [size, size]
    });
  }
});
xLeafletMap.addLayer(xMarkerCluster);
```

### 7a. Navy tile tint (so the map flows into the panel)

```css
.<x>-mapwrap { background: var(--black-card); border-right: 1px solid var(--gold-border); }
.leaflet-container { background: var(--black-card); }

/* Tint the Carto Dark Matter tiles toward the brand navy. */
.<x>-mapwrap .leaflet-tile {
  filter: sepia(1) saturate(2.6) hue-rotate(180deg) brightness(1.15);
}
.<x>-mapwrap .leaflet-tile-pane::after {
  content: '';
  position: absolute; inset: 0;
  background: rgba(21, 34, 56, 0.45);
  mix-blend-mode: multiply;
  pointer-events: none;
  z-index: 1;
}
```

### 7b. Zoom buttons (bottom-left, navy)

```css
.<x>-mapwrap .leaflet-control-zoom {
  border: none;
  margin-left: 16px !important;
  margin-bottom: 24px !important;
  box-shadow: 0 4px 10px rgba(0,0,0,0.4);
}
.<x>-mapwrap .leaflet-control-zoom a {
  /* !important needed to beat any earlier dashboard rule on .leaflet-control-zoom a */
  width: 40px !important; height: 40px !important; line-height: 40px !important;
  background: #1E3A5F !important;
  color: var(--gold) !important;
  border: 1px solid var(--gold-border) !important;
  font-size: 22px !important;
}
.<x>-mapwrap .leaflet-control-zoom a:hover {
  background: var(--gold-dim) !important;
  border-color: var(--gold) !important;
}
.<x>-mapwrap .leaflet-control-zoom-in { border-bottom: none !important; }
```

### 7c. Map key (top-left)

```html
<div class="<x>-mapkey">
  <label class="<x>-mapkey-row"><input type="checkbox" id="<x>-mapkey-cluster" checked onchange="toggleMapClustering()"><span>Cluster projects</span></label>
  <label class="<x>-mapkey-row"><input type="checkbox" id="<x>-mapkey-pins" checked onchange="toggleMapPins()"><span>Show project pins</span></label>
  <div class="<x>-mapkey-divider"></div>
  <div class="<x>-mapkey-legend"><span class="<x>-mapkey-cluster3">3</span> 3+ projects</div>
  <div class="<x>-mapkey-legend"><span class="<x>-mapkey-cluster2">2</span> 2 projects</div>
  <div class="<x>-mapkey-legend"><span class="<x>-mapkey-cluster1">1</span> 1 project</div>
  <div class="<x>-mapkey-legend"><span class="<x>-mapkey-pin">●</span> Project</div>
</div>
```

```css
.<x>-mapkey {
  position: absolute; top: 16px; left: 16px; z-index: 500;
  background: var(--black-card); border: 1px solid var(--gold-border);
  padding: 12px 14px; min-width: 170px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.<x>-mapkey-row { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 0; font-size: 12px; color: var(--grey-pale); }
.<x>-mapkey-row input { accent-color: var(--gold); }
.<x>-mapkey-divider { height: 1px; background: var(--gold-border); margin: 8px 0; }
.<x>-mapkey-legend { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--grey-pale); padding: 3px 0; }

/* All three cluster sizes use the same outlined-gold style as the on-map clusters */
.<x>-mapkey-cluster3, .<x>-mapkey-cluster2, .<x>-mapkey-cluster1 {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  background: rgba(200, 169, 81, 0.12);
  color: var(--gold);
  font-family: 'DM Mono', monospace; font-weight: 700;
  font-size: 11px;
  border: 1.5px solid var(--gold);
  border-radius: 50%;
}
.<x>-mapkey-pin { color: var(--gold); font-size: 16px; line-height: 1; }
```

### 7d. Pins — solid gold with glass sheen

```css
.<x>-pin {
  position: relative;
  width: 28px; height: 28px;
  background: linear-gradient(135deg, var(--gold-light) 0%, var(--gold) 55%, #A88A36 100%);
  border: 2px solid var(--gold);
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  box-shadow:
    0 0 0 1px rgba(200,169,81,0.35),
    0 0 14px rgba(200,169,81,0.55),
    inset 1px 1px 4px rgba(255,240,200,0.45),
    inset -1px -2px 4px rgba(0,0,0,0.25);
  cursor: pointer;
}
/* Inner "lens" — counter-rotated so it stays a circle */
.<x>-pin::after {
  content: '';
  position: absolute; top: 50%; left: 50%;
  width: 10px; height: 10px;
  background: var(--black-card);
  border: 1.5px solid rgba(0,0,0,0.35);
  border-radius: 50%;
  transform: translate(-50%, -50%) rotate(45deg);
  box-shadow: inset 0 0 3px rgba(0,0,0,0.5);
}
.leaflet-marker-icon.<x>-pin-wrap { background: transparent !important; border: none !important; }
```

### 7e. Cluster bubble — outlined gold, transparent fill

```css
.<x>-cluster {
  display: flex; align-items: center; justify-content: center;
  background: rgba(200,169,81,0.12);
  color: var(--gold);
  font-family: 'DM Mono', monospace; font-weight: 700;
  font-size: 14px;
  border: 2px solid var(--gold);
  border-radius: 50%;
  box-shadow:
    0 0 0 4px rgba(200,169,81,0.10),
    0 0 14px rgba(200,169,81,0.45),
    inset 0 0 10px rgba(200,169,81,0.18);
  text-shadow: 0 0 4px rgba(200,169,81,0.6);
  backdrop-filter: blur(2px);
}
```

### 7f. Marker creation

```js
const icon = L.divIcon({
  html: '<div class="<x>-pin"></div>',
  className: '<x>-pin-wrap',
  iconSize: [28, 28],
  iconAnchor: [14, 26]
});
const m = L.marker([lat, lng], { icon, title: p.name || '' });
m.bindTooltip(`<strong>${p.name}</strong><br><span style="color:#C8A951">${[p.suburb, p.state].filter(Boolean).join(' · ')}</span>`, { direction: 'top' });
m.on('click', () => highlightXRow(p.id, true));
xMarkerCluster.addLayer(m);
```

### 7g. Bounds calc — keep the natural fit a step looser

```js
const lats = bounds.map(b => b[0]);
const lngs = bounds.map(b => b[1]);
const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
let z = 12;
if (span > 0.3) z = 10;
if (span > 1)   z = 8;
if (span > 3)   z = 7;
if (span > 7)   z = 6;
if (span > 15)  z = 5;
xLeafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: z });

// Run twice to handle the case where the pane was display:none on init
const applyBounds = () => { try { xLeafletMap.invalidateSize(); } catch(e){} /* …fitBounds…*/ };
applyBounds();
setTimeout(applyBounds, 60);
```

---

## 8. Right pane (paginated rows)

### 8a. Head

```html
<div class="<x>-rightpane-head">
  <div class="<x>-rightpane-count" id="<x>-rightpane-count">8 projects</div>
  <div class="<x>-rightpane-sort">
    <span class="<x>-rightpane-sort-label">Sort by:</span>
    <select class="<x>-rightpane-sort-select" id="<x>-proj-sort" onchange="onXProjSort(this.value)">
      <option value="avail-desc">Availability (High)</option>
      …
    </select>
  </div>
</div>
```

```css
.<x>-rightpane { display: flex; flex-direction: column; background: var(--black-card); overflow: hidden; min-width: 0; }
.<x>-rightpane-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--gold-border); flex-shrink: 0; }
.<x>-rightpane-count { font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: var(--white); }
.<x>-rightpane-sort { display: flex; align-items: center; gap: 10px; }
.<x>-rightpane-sort-label { font-size: 13px; color: var(--text-muted); font-family: 'DM Mono', monospace; letter-spacing: 0.4px; }
.<x>-rightpane-sort-select {
  background: var(--black-soft); border: 1px solid var(--gold-border);
  color: var(--gold); padding: 8px 28px 8px 12px;
  font-family: 'Outfit', system-ui, sans-serif; font-size: 14px; cursor: pointer; outline: none;
  appearance: none; -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--gold) 50%), linear-gradient(135deg, var(--gold) 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 7px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.<x>-rightpane-list { flex: 1; overflow-y: auto; padding: 6px 0; }
```

### 8b. Row — uniform height, image flush left, badges anchored to row bottom

Every row is **exactly 116px tall**. Image is a fixed 240×96 wide rectangle.
Body uses `justify-content: space-between` so name+location sit at the
top and badges hug the bottom.

```html
<div class="<x>-row" data-proj-id="${p.id}" onclick="showXDetail('${p.id}')">
  <div class="<x>-row-thumb">
    ${heroHtml /* <img …> */}
    <div class="<x>-row-thumb-placeholder">${initial}</div>
    ${p.smsf_eligible ? '<span class="<x>-row-thumb-smsf">SMSF</span>' : ''}
  </div>
  <div class="<x>-row-body">
    <div class="<x>-row-body-top">
      <div class="<x>-row-name">${p.name}</div>
      <div class="<x>-row-loc">${suburb} · ${state}</div>
    </div>
    <div class="<x>-row-badges">
      <span class="stk-badge ${typeClass}">${type}</span>
      <span class="stk-badge ${projStatusClass}">${status}</span>
    </div>
  </div>
  <div class="<x>-row-stats">
    <div class="<x>-row-stat"><span class="<x>-row-stat-label">From</span><span class="<x>-row-stat-val">${minPrice}</span></div>
    <div class="<x>-row-stat <x>-row-stat-comm"><span class="<x>-row-stat-label">Comm</span><span class="<x>-row-stat-val">${comm}</span></div>
    <div class="<x>-row-stat"><span class="<x>-row-stat-label">Lots</span><span class="<x>-row-stat-val">${count} ${count===1 ? 'lot' : 'lots'}</span></div>
  </div>
  <div class="<x>-row-side">
    ${availLabel}
    <span class="<x>-row-cta">View →</span>
  </div>
</div>
```

```css
.<x>-row {
  display: grid;
  grid-template-columns: 240px 1fr auto auto;
  gap: 0;
  align-items: center;
  height: 116px;                                /* fixed — every row identical */
  padding: 0 22px 0 0;
  border-bottom: 1px solid rgba(201,168,76,0.10);
  cursor: pointer;
  transition: background 0.15s;
}
.<x>-row:hover { background: var(--black-hover); }
.<x>-row.flash { background: var(--gold-dim); border-color: var(--gold); }

.<x>-row-thumb {
  width: 240px; height: 96px;            /* flush — wide rectangle */
  background: linear-gradient(135deg, var(--black-hover) 0%, #1E1E18 100%);
  position: relative; overflow: hidden;
}
.<x>-row-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.<x>-row-thumb-placeholder {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 32px; color: rgba(201,168,76,0.25);
}
.<x>-row-thumb-smsf {
  position: absolute; top: 7px; left: 7px;
  font-size: 10px; padding: 3px 7px;
  background: rgba(201,168,76,0.92); color: var(--black);
  font-family: 'DM Mono', monospace; font-weight: 700;
}

.<x>-row-body {
  display: flex; flex-direction: column; justify-content: space-between;
  min-width: 0; padding: 14px 14px 14px 22px;
  height: 96px;
}
.<x>-row-name {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 21px; font-weight: 600;
  color: var(--white); line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-bottom: 4px;
}
.<x>-row-loc { font-size: 14px; color: var(--grey-pale); }
.<x>-row-badges { display: flex; gap: 6px; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
.<x>-row-badges .stk-badge { font-size: 12px !important; padding: 3px 9px !important; flex-shrink: 0; }

/* Fixed column widths so FROM / COMM / LOTS line up across every row */
.<x>-row-stats {
  display: grid;
  grid-template-columns: 80px 124px 80px;
  align-items: center;
  padding: 12px 8px 12px 0;
}
.<x>-row-stat { display: flex; flex-direction: column; gap: 5px; }
.<x>-row-stat-label {
  font-size: 11px; letter-spacing: 1.3px; text-transform: uppercase;
  color: var(--text-muted); font-family: 'DM Mono', monospace;
}
.<x>-row-stat-val { font-size: 17px; color: var(--white); font-family: 'DM Mono', monospace; font-weight: 500; white-space: nowrap; }
.<x>-row-stat-comm .<x>-row-stat-val { color: var(--gold); }

.<x>-row-side {
  display: flex; flex-direction: column;
  align-items: flex-end; justify-content: space-between;
  padding: 12px 0 12px 22px;
  min-width: 80px; height: 96px;
}
.<x>-row-side .stk-avail-chip,
.<x>-row-side .stk-badge { font-size: 12px !important; padding: 4px 11px !important; }
.<x>-row-cta { font-size: 14px; color: var(--gold); font-family: 'DM Mono', monospace; font-weight: 500; }
```

---

## 9. Pager + per-page selector

```html
<div class="<x>-rightpane-footer">
  <div class="<x>-pager" id="<x>-projects-pager"></div>
  <div class="<x>-pagesize">
    Show <select id="<x>-pagesize-select" onchange="onXPageSize(this.value)">
      <option value="5">5</option>
      <option value="10" selected>10</option>
      <option value="25">25</option>
      <option value="50">50</option>
    </select> per page
  </div>
</div>
```

```css
.<x>-rightpane-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px 22px;                   /* extra bottom padding so it lifts off the page edge */
  border-top: 1px solid var(--gold-border);
  flex-shrink: 0;
  font-size: 12px; color: var(--text-muted);
  background: var(--black-card);
}

.<x>-pager { display: flex; align-items: center; gap: 6px; }
.<x>-pager-btn {
  min-width: 36px; height: 36px;
  padding: 0 10px;
  background: transparent; border: 1px solid var(--gold-border);
  color: var(--grey-pale);
  font-size: 14px; font-family: 'DM Mono', monospace;
  cursor: pointer;
}
.<x>-pager-btn:hover:not(:disabled) { border-color: var(--gold); color: var(--gold); }
.<x>-pager-btn.active {
  background: var(--black-soft);
  border-color: var(--gold);
  color: var(--gold);
  font-weight: 700;
}
.<x>-pager-btn:disabled { opacity: 0.35; cursor: default; }
.<x>-pager-btn.active:disabled { opacity: 1; cursor: default; }   /* keep gold even when only 1 page */

.<x>-pagesize { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--grey-pale); }
.<x>-pagesize select {
  background: var(--black-soft); border: 1px solid var(--gold-border);
  color: var(--gold); padding: 6px 26px 6px 10px; font-size: 14px;
  appearance: none; -webkit-appearance: none; cursor: pointer;
}
```

```js
function renderXPager(elId, total) {
  const pageSize = xFilter.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(xFilter.page, totalPages);
  const el = document.getElementById(elId);
  if (totalPages <= 1) {
    el.innerHTML = '<button class="<x>-pager-btn active" disabled>1</button>';   // active even with 1 page
    return;
  }
  const buttons = [];
  buttons.push(`<button class="<x>-pager-btn" ${cur===1?'disabled':''} onclick="gotoXPage(${cur-1})">‹</button>`);
  // window of 5 numbered buttons centred around cur, clamped to [1, totalPages]
  let start = Math.max(1, cur - 2), end = Math.min(totalPages, start + 4);
  start = Math.max(1, end - 4);
  for (let i = start; i <= end; i++) {
    buttons.push(`<button class="<x>-pager-btn ${i===cur?'active':''}" onclick="gotoXPage(${i})">${i}</button>`);
  }
  buttons.push(`<button class="<x>-pager-btn" ${cur===totalPages?'disabled':''} onclick="gotoXPage(${cur+1})">›</button>`);
  el.innerHTML = buttons.join('');
}
```

---

## 10. State + render pipeline

```js
let xFilter = {
  // your filter inputs
  avail: 'all', states: [], types: [], …,
  search: '',
  // shared layout state
  page: 1,
  pageSize: 10,
  viewMode: 'map',      // 'map' | 'list'
  projSort: 'avail-desc',
};

function filteredXProjects() { /* filter allProjects on every xFilter field + search */ }
function sortXProjects(arr)  { /* honour xFilter.projSort */ }

function renderXBrowse() {
  const mapPane  = document.getElementById('<x>-projects-map');
  const gridPane = document.getElementById('<x>-projects-grid-wrap');
  const tablePane = document.getElementById('<x>-stock-table-wrap');
  if (xBrowseMode === 'stock') {
    mapPane.style.display = 'none'; gridPane.style.display = 'none'; tablePane.style.display = '';
    renderAllStockTable();
  } else if (xFilter.viewMode === 'map') {
    mapPane.style.display = '';      gridPane.style.display = 'none'; tablePane.style.display = 'none';
    renderXMapMode();
  } else {
    mapPane.style.display = 'none';  gridPane.style.display = '';     tablePane.style.display = 'none';
    renderXListMode();
  }
}

function renderXMapMode() {
  const all = sortXProjects(filteredXProjects());
  document.getElementById('<x>-rightpane-count').textContent = `${all.length} project${all.length===1?'':'s'}`;
  renderXMap(all);                                      // map gets ALL projects (not paginated)
  const slice = paginate(all, xFilter.page, xFilter.pageSize);
  document.getElementById('<x>-rightpane-list').innerHTML = renderProjectRows(slice);
  renderXPager('<x>-projects-pager', all.length);
}
```

Every filter input handler does:

```js
xFilter.<key> = newValue;
xFilter.page = 1;                  // reset paging when filters change
updateXFdropSummaries();           // refresh dropdown values + has-value highlight + More-filters badge
renderXBrowse();
```

---

## 11. Database / data backfill (only if your page also needs lat/lng)

```sql
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS latitude  numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
```

Backfill script lives at [tpch-portal/scripts/backfill-project-coords.mjs](tpch-portal/scripts/backfill-project-coords.mjs):
geocodes any row missing coords via Nominatim (1 req/sec), idempotent,
skips rows that already have lat/lng.

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backfill-project-coords.mjs --apply
```

---

## 12. Things that bit me — keep these in mind

1. **`!important` arms race.** Older dashboard CSS (`.leaflet-control-zoom a`)
   and (`.leaflet-control` etc.) uses `!important`. New rules must
   either match specificity + `!important` or scope under `.<x>-mapwrap` and
   `!important`.

2. **Document scroll.** `.main-content` is `min-height: 100vh; display: flex;
   flex-direction: column`. If your page's content pushes past the viewport,
   the body will scroll. Use the `:has()` lock pattern in section 3.

3. **Filter dropdown z-index.** Leaflet panes go up to z-index 800. Filter
   popovers must be at least 1000+ to float above the map.

4. **Map sized while hidden.** If you init Leaflet while its container is
   `display: none`, `fitBounds` reads zero dimensions. Always call
   `invalidateSize()` then `fitBounds()` once on first paint and again on a
   60ms timeout.

5. **Image stretch.** If you use `align-items: stretch` (the grid default)
   on the row, the thumb image will stretch to match the tallest row's
   height. Lock the image with explicit `width` + `height` and switch the
   row to `align-items: center` for guaranteed-uniform rows.

6. **Badge wrap pushes rows taller.** `.<x>-row-badges` must be
   `flex-wrap: nowrap; overflow: hidden` so a long badge like "HOUSE & LAND"
   can't wrap and force the row to grow.

7. **Stats column alignment.** Use fixed pixel widths in
   `grid-template-columns` for the stats grid (e.g. `80px 124px 80px`) —
   `repeat(3, auto)` lets each row size its own columns and breaks
   alignment between rows.

8. **Single-page pager.** Don't skip the active class when `totalPages
   === 1` — users still want to see the highlighted current page.

9. **Active pager-btn + disabled.** When the only page is also disabled,
   add `.<x>-pager-btn.active:disabled { opacity: 1; }` so it stays gold
   instead of fading.

10. **Header is the only dark strip.** Centre, right pane, footer, grid
    wrap, and filter popovers all use `--black-card` (or `--black-soft`
    for inputs / `--black` for floating elements). Keeping any other panel
    `--black` will create a "two-tone" look that breaks the brand flow.

---

## 13. Files touched

| File | Purpose |
|---|---|
| [tpch-portal/index.html](tpch-portal/index.html) | All markup, CSS, JS for the page (single-file SPA) |
| [tpch-portal/scripts/backfill-project-coords.mjs](tpch-portal/scripts/backfill-project-coords.mjs) | One-off geocode script (Nominatim + service-role PATCH) |
| Supabase migration `add_project_lat_lng` | `latitude`/`longitude` columns on `projects` |

---

## 14. How to apply this to the Research page

1. Pick a namespace prefix (e.g. `rsc-` or `res-` instead of `stk-`).
2. Identify your data shape: list of items, each with name, location,
   lat/lng (geocode if needed), maybe a hero image, plus 2–3 stat fields
   you want in the right rail.
3. Re-create the markup skeleton from sections 4–9 with your prefix.
4. Wire up the filter row from section 5; pick which 5 filters fit
   inline and which go behind "More filters".
5. Copy the Leaflet setup from section 7 verbatim, swapping IDs.
6. Build a `xFilter` state object and the `renderXBrowse` /
   `renderXMapMode` / `renderXListMode` functions in section 10.
7. Apply the page-shell sizing pattern from section 3.
8. Sanity-check the bite list in section 12 once it's running.
