import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/fraunces/600.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl from 'maplibre-gl';
import { t, getLang, setLang, applyI18n } from './i18n.js';
import { parseGPX, simplify } from './geo/gpx.js';
import { searchPlaces } from './geo/search.js';
import { loadCollection, mainlandRings } from './geo/regions.js';
import { makeProjection, lonLatBounds, frameCorners } from './geo/project.js';
import { loadElevation } from './geo/terrain.js';
import { rasterMask } from './model/mesh.js';
import { renderPoster, paperSize, PAPERS, STYLES } from './poster/render.js';
import { PALETTES, resolveColors } from './poster/palettes.js';
import { exportFontCss } from './poster/fonts.js';
import { buildModel, SHAPES } from './model/build.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

/* ---------- État ---------- */

const ASPECTS = { portrait: 0.8, landscape: 1.5, square: 1 };
const DEFAULT_POSTER = {
  style: 'ridges', palette: 'papier', colors: {},
  title: '', subtitle: '', showCoords: true, showStats: true, textAlign: 'center',
  paper: 'A3', orientation: 'portrait',
  density: 0.5, relief: 0.5, trackWidth: 0.5, showTrack: true, border: false, clipRegion: true, outline: false,
};
const DEFAULT_MODEL = {
  shape: 'rect', sizeMm: 150, baseMm: 4, reliefMm: 20, detail: 260, flattenSea: true,
  track: true, trackHeightMm: 1, trackWidthMm: 1.6, tiles: false, bedMm: 220, palette: 'papier',
};

const S = {
  step: 1,
  tab: 'gpx',
  place: null, // { kind, label, sublabel, track?, stats?, ringsLL? }
  frame: null, // { center: [lon, lat], widthM, heightM }
  aspect: 'portrait',
  mode: 'poster',
  poster: structuredClone(DEFAULT_POSTER),
  model: structuredClone(DEFAULT_MODEL),
};

let scene = null;
let renderCache = {};
let lastModel = null;
let preview3d = null;

const fmt = (v, d = 0) =>
  new Intl.NumberFormat(getLang() === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);

/* ---------- Historique (annuler / rétablir) ---------- */

const hist = { stack: [], i: -1 };
const snapshot = () => JSON.stringify({ mode: S.mode, poster: S.poster, model: S.model });
function commit() {
  const s = snapshot();
  if (hist.stack[hist.i] === s) return;
  hist.stack = hist.stack.slice(0, hist.i + 1);
  hist.stack.push(s);
  if (hist.stack.length > 150) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  updateUndo();
}
function restore(s) {
  const o = JSON.parse(s);
  S.mode = o.mode;
  S.poster = o.poster;
  S.model = o.model;
  renderControls();
  updateModeUI();
  schedule();
  updateUndo();
}
function undo() {
  if (hist.i > 0) restore(hist.stack[--hist.i]);
}
function redo() {
  if (hist.i < hist.stack.length - 1) restore(hist.stack[++hist.i]);
}
function updateUndo() {
  $('#undo').disabled = hist.i <= 0;
  $('#redo').disabled = hist.i >= hist.stack.length - 1;
}
function resetHistory() {
  hist.stack = [];
  hist.i = -1;
  commit();
}

/* ---------- Navigation ---------- */

function go(step) {
  if (step > 1 && !S.frame) return;
  S.step = step;
  for (const n of [1, 2, 3]) $(`#step-${n}`).hidden = n !== step;
  for (const b of $$('.stepper button')) {
    const n = +b.dataset.step;
    b.classList.toggle('active', n === step);
    b.classList.toggle('done', n < step);
    b.disabled = n > 1 && !S.frame;
  }
  history.replaceState(null, '', `?step=${step}`);
  if (step === 1) setTimeout(() => { map?.resize(); layoutFrame(); }, 0);
  if (step === 2) enterStudio();
  if (step === 3) enterExport();
}

/* ---------- Étape 1 : carte et cadre ---------- */

let map;
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [6.6, 45.6],
    zoom: 6,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => {
    map.addSource('region', { type: 'geojson', data: emptyFC() });
    map.addSource('track', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'region-fill', type: 'fill', source: 'region', paint: { 'fill-color': '#c4471d', 'fill-opacity': 0.07 } });
    map.addLayer({ id: 'region-line', type: 'line', source: 'region', paint: { 'line-color': '#c4471d', 'line-width': 1.5 } });
    map.addLayer({ id: 'track-casing', type: 'line', source: 'track', paint: { 'line-color': '#fff', 'line-width': 6 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    map.addLayer({ id: 'track-line', type: 'line', source: 'track', paint: { 'line-color': '#c4471d', 'line-width': 3 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    syncMapData();
  });
  map.on('moveend', updateFrameFromMap);
  map.on('resize', layoutFrame);
  window.addEventListener('resize', () => S.step === 1 && (syncMapSize(), layoutFrame()));
  setTimeout(() => { syncMapSize(); layoutFrame(); }, 0);
}
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

function syncMapData() {
  if (!map?.getSource('track')) return;
  const p = S.place;
  map.getSource('track').setData(
    p?.track ? { type: 'Feature', geometry: { type: 'LineString', coordinates: p.track.map((q) => [q[0], q[1]]) } } : emptyFC(),
  );
  map.getSource('region').setData(
    p?.ringsLL ? { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: p.ringsLL.map((r) => [r]) } } : emptyFC(),
  );
}

function frameRect() {
  const el = $('#map');
  const W = el.clientWidth, H = el.clientHeight;
  const padTop = 44, padBottom = W < 700 ? 120 : 84, padX = W < 700 ? 16 : 48;
  const aw = Math.max(40, W - 2 * padX), ah = Math.max(40, H - padTop - padBottom);
  const a = ASPECTS[S.aspect];
  const fw = Math.min(aw, ah * a), fh = fw / a;
  return { left: (W - fw) / 2, top: padTop + (ah - fh) / 2, fw, fh, W, H };
}

function layoutFrame() {
  const r = frameRect();
  Object.assign($('#frame').style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.fw}px`, height: `${r.fh}px` });
  for (const b of $$('#aspect-seg button')) b.classList.toggle('active', b.dataset.aspect === S.aspect);
  updateFrameFromMap();
}

function updateFrameFromMap() {
  if (!mapVisible()) return;
  const r = frameRect();
  if (r.fw < 10) return;
  const tl = map.unproject([r.left, r.top]);
  const br = map.unproject([r.left + r.fw, r.top + r.fh]);
  const c = map.unproject([r.left + r.fw / 2, r.top + r.fh / 2]);
  const lat0 = (tl.lat + br.lat) / 2;
  const p = makeProjection(c.lng, lat0);
  const widthM = p.forward(br.lng, lat0)[0] - p.forward(tl.lng, lat0)[0];
  const heightM = p.forward(c.lng, tl.lat)[1] - p.forward(c.lng, br.lat)[1];
  S.frame = { center: [((c.lng + 540) % 360) - 180, lat0], widthM: Math.abs(widthM), heightM: Math.abs(heightM) };
  const km = (m) => (m >= 10000 ? fmt(m / 1000) : fmt(m / 1000, 1));
  $('#frame-size').textContent = t('frame.size', { w: km(S.frame.widthM), h: km(S.frame.heightM) });
  for (const b of $$('.stepper button')) if (+b.dataset.step > 1) b.disabled = false;
}

// La carte peut avoir été créée avant que son conteneur ait sa taille définitive.
// Quand l'étape 1 est masquée, la carte a une taille nulle : on ne l'utilise pas.
const mapVisible = () => !!map && map.getContainer().clientWidth > 50 && map.getContainer().clientHeight > 50;
function syncMapSize() {
  if (mapVisible()) map.resize();
}

function fitBoundsInFrame(b, margin = 0.06) {
  syncMapSize();
  const r = frameRect();
  const dx = (b.east - b.west) * margin, dy = (b.north - b.south) * margin;
  map.fitBounds(
    [[b.west - dx, b.south - dy], [b.east + dx, b.north + dy]],
    { padding: { top: r.top, bottom: r.H - r.top - r.fh, left: r.left, right: r.W - r.left - r.fw }, animate: false, maxZoom: 15 },
  );
  updateFrameFromMap();
}

function choosePlace(place, bounds) {
  S.place = place;
  S.autoRelief = true;
  S.poster.title = place.label;
  S.poster.subtitle = place.sublabel || '';
  if (place.ringsLL) S.model.shape = 'region';
  else if (S.model.shape === 'region') S.model.shape = 'rect';
  scene = null;
  syncMapData();
  fitBoundsInFrame(bounds);
  renderSelected();
}

function renderSelected() {
  const el = $('#selected-place');
  el.replaceChildren();
  const p = S.place;
  if (!p) {
    el.append(h('span', { className: 'muted' }, t('place.none')));
    return;
  }
  el.append(h('span', { className: 'muted' }, t('place.selected')), h('strong', {}, p.label));
  if (p.sublabel) el.append(h('div', { className: 'stats' }, p.sublabel));
  if (p.stats?.distanceM)
    el.append(h('div', { className: 'stats' }, `${t('stat.distance')} ${fmt(p.stats.distanceM / 1000, 1)} km · ${t('stat.gain')} ${fmt(p.stats.gainM)} m`));
}

// Onglets
function setTab(tab) {
  S.tab = tab;
  for (const b of $$('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of $$('.tab')) p.hidden = p.dataset.pane !== tab;
  if (tab === 'region') loadRegions();
  if (tab === 'search') $('#search-input').focus();
}

// GPX
async function readGpxFile(file) {
  const err = $('#gpx-error');
  err.hidden = true;
  try {
    const gpx = parseGPX(await file.text());
    const label = gpx.name || file.name.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' ');
    const pts = simplify(gpx.points, 0.000004);
    choosePlace(
      { kind: 'gpx', label, sublabel: '', track: pts, stats: { distanceM: gpx.distanceM, gainM: gpx.gainM, maxEleM: gpx.maxEleM } },
      lonLatBounds(pts),
    );
  } catch {
    err.textContent = t('place.gpx.error');
    err.hidden = false;
  }
}

// Recherche
let searchCtl, searchTimer;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('#search-input').value.trim();
  if (q.length < 2) {
    $('#search-results').replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    searchCtl?.abort();
    searchCtl = new AbortController();
    const list = $('#search-results');
    try {
      const results = await searchPlaces(q, getLang(), searchCtl.signal);
      list.replaceChildren(
        ...(results.length
          ? results.map((r) => h('li', {}, h('button', { onclick: () => pickSearch(r) }, r.label, h('small', {}, r.sublabel))))
          : [h('li', { className: 'note' }, t('place.search.empty'))]),
      );
    } catch (e) {
      if (e.name !== 'AbortError') list.replaceChildren(h('li', { className: 'note' }, t('place.search.error')));
    }
  }, 320);
}
function pickSearch(r) {
  let b = r.bounds;
  const tooSmall = !b || Math.abs(b.east - b.west) * 111000 * Math.cos((r.lat * Math.PI) / 180) < 1500;
  if (tooSmall) {
    const dLat = r.defaultWidthM / 2 / 111000;
    const dLon = dLat / Math.cos((r.lat * Math.PI) / 180);
    b = { west: r.lon - dLon, east: r.lon + dLon, south: r.lat - dLat, north: r.lat + dLat };
  }
  choosePlace({ kind: 'search', label: r.label, sublabel: r.sublabel, point: [r.lon, r.lat] }, b);
}

// Pays et régions
let regionItems = [];
async function loadRegions() {
  const id = $('#region-collection').value;
  const list = $('#region-results');
  list.replaceChildren(h('li', { className: 'note' }, t('place.region.loading')));
  try {
    regionItems = await loadCollection(id);
    renderRegions();
  } catch {
    list.replaceChildren(h('li', { className: 'note' }, t('place.search.error')));
  }
}
function renderRegions() {
  const q = $('#region-filter').value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const items = regionItems
    .filter((r) => !q || r.name.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(q))
    .slice(0, 300);
  $('#region-results').replaceChildren(...items.map((r) => h('li', {}, h('button', { onclick: () => pickRegion(r) }, r.name))));
}
function pickRegion(r) {
  const rings = mainlandRings(r.geometry);
  const sel = $('#region-collection');
  choosePlace({ kind: 'region', label: r.name, sublabel: '', ringsLL: rings, collection: sel.value }, lonLatBounds(rings.flat()));
  S.poster.clipRegion = true;
}

/* ---------- Étape 2 : atelier ---------- */

let loadCtl;
async function ensureScene() {
  const key = JSON.stringify(S.frame) + '|' + (S.place?.label || '') + '|' + (S.place?.kind || '');
  if (scene?.key === key) return scene;
  loadCtl?.abort();
  loadCtl = new AbortController();
  const ctl = loadCtl;
  showLoading(0);
  const frame = structuredClone(S.frame);
  const grid = await loadElevation(frame, 600, { signal: ctl.signal, onProgress: (p) => showLoading(p) });
  if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
  const proj = makeProjection(frame.center[0], frame.center[1]);
  const regionRingsM = S.place?.ringsLL?.map((r) => r.map(([lo, la]) => proj.forward(lo, la))) || null;
  const trackM = S.place?.track?.map(([lo, la]) => proj.forward(lo, la)) || null;
  const mask = regionRingsM ? rasterMask(grid.cols, grid.rows, grid.cell, regionRingsM, null).inside : null;
  scene = { key, frame, grid, mask, regionRingsM, trackM, stats: S.place?.stats || null };
  // Nouveau lieu : hauteur de relief par défaut proche de l'échelle réelle (×1,2), bornée.
  if (S.autoRelief) {
    S.autoRelief = false;
    const span = grid.max - Math.max(0, grid.min);
    const real = (span * S.model.sizeMm) / Math.max(frame.widthM, frame.heightM);
    S.model.reliefMm = Math.round(Math.min(45, Math.max(8, real * 1.2)));
    if (hist.stack.length) { hist.stack[hist.i] = snapshot(); }
  }
  renderCache = { key };
  lastModel = null;
  $('#loading').hidden = true;
  return scene;
}

function showLoading(p) {
  $('#loading').hidden = false;
  $('#loading .spinner').hidden = false;
  $('#loading-retry').hidden = true;
  $('#loading-text').textContent = t('loading.terrain', { p: Math.round(p * 100) });
}

async function enterStudio() {
  if (!hist.stack.length) resetHistory();
  renderControls();
  updateModeUI();
  updateUndo();
  try {
    await ensureScene();
    renderControls();
    renderPreview();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    $('#loading .spinner').hidden = true;
    $('#loading-text').textContent = t('loading.error');
    $('#loading-retry').hidden = false;
  }
}

function updateModeUI() {
  for (const b of $$('#mode-seg button')) b.classList.toggle('active', b.dataset.mode === S.mode);
  $('#paper').hidden = S.mode !== 'poster';
  $('#three').hidden = S.mode !== 'model';
}

let renderTimer;
function schedule() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 30);
}

function renderPreview() {
  if (!scene || S.step !== 2) return;
  if (S.mode === 'poster') {
    const svg = renderPoster(scene, S.poster, { t, lang: getLang(), cache: renderCache });
    $('#paper').innerHTML = svg;
    fitPaper();
    const [W, H] = paperSize(S.poster);
    $('#infobar').textContent = `${S.poster.paper} · ${W} × ${H} mm`;
  } else {
    if (!preview3d) {
      return import('./model/preview.js').then(({ ModelPreview }) => {
        preview3d = new ModelPreview($('#three'));
        preview3d.setBackground('#ece7dd');
        renderPreview();
      });
    }
    const keep = lastModel?.shapeKey === S.model.shape + S.model.sizeMm;
    lastModel = buildModel(scene, S.model);
    lastModel.shapeKey = S.model.shape + S.model.sizeMm;
    const p = PALETTES[S.model.palette] || PALETTES.papier;
    preview3d.setModel(lastModel, { ramp: p.ramp, side: p.ramp[2] }, keep);
    const i = lastModel.info;
    const tris = lastModel.parts.reduce((n, q) => n + q.indices.length / 3, 0);
    const parts = [t('model.info', { w: fmt(i.widthMm), d: fmt(i.depthMm), h: fmt(i.heightMm, 1), x: fmt(i.exaggeration, 1) })];
    if (i.tiles[0] * i.tiles[1] > 1) parts.push(t('model.tilesInfo', { n: lastModel.parts.length, nx: i.tiles[0], ny: i.tiles[1] }));
    parts.push(t('model.tris', { n: fmt(tris) }));
    $('#infobar').textContent = parts.join(' · ');
  }
}

function fitPaper() {
  const el = $('#preview');
  const [W, H] = paperSize(S.poster);
  const pad = 40;
  const k = Math.min((el.clientWidth - pad) / W, (el.clientHeight - pad) / H);
  Object.assign($('#paper').style, { width: `${Math.max(50, W * k)}px`, height: `${Math.max(50, H * k)}px` });
}
new ResizeObserver(() => S.step === 2 && S.mode === 'poster' && fitPaper()).observe($('#preview'));

/* ---------- Panneau de réglages ---------- */

const STYLE_ICONS = {
  ridges: '<path d="M4 26 Q14 14 22 22 T40 18 T60 24" /><path d="M4 32 Q16 22 26 28 T44 24 T60 30" /><path d="M4 38 Q18 30 30 34 T60 36" />',
  contours: '<ellipse cx="32" cy="22" rx="24" ry="15" /><ellipse cx="34" cy="21" rx="15" ry="9" /><ellipse cx="36" cy="20" rx="6" ry="4" />',
  strata: '<path d="M4 38 L18 22 L28 30 L40 14 L60 38 Z" fill="currentColor" fill-opacity=".18"/><path d="M16 38 L28 26 L36 32 L42 22 L54 38 Z" fill="currentColor" fill-opacity=".35"/>',
  shade: '<path d="M4 38 L22 14 L32 26 L42 12 L60 38 Z" fill="currentColor" fill-opacity=".15"/><path d="M22 14 L28 38 M42 12 L46 38" stroke-opacity=".5"/>',
  rivers: '<path d="M10 6 Q16 16 22 20 T34 30 T38 40" /><path d="M48 6 Q44 16 38 22 T34 30" /><path d="M24 8 Q26 14 22 20" />',
};
const SHAPE_ICONS = {
  rect: '<rect x="14" y="8" width="36" height="28" rx="1"/>',
  circle: '<circle cx="32" cy="22" r="15"/>',
  hexagon: '<path d="M16 22 L24 8 H40 L48 22 L40 36 H24 Z"/>',
  region: '<path d="M18 10 L34 8 L46 14 L48 26 L40 36 L26 34 L16 26 Z"/>',
};

function ctlRange(target, key, label, min, max, step, format) {
  const out = h('output', {}, format(target[key]));
  const input = h('input', {
    type: 'range', min, max, step, value: target[key],
    oninput: () => { target[key] = +input.value; out.textContent = format(target[key]); schedule(); },
    onchange: commit,
  });
  return h('div', { className: 'ctl' }, h('label', {}, t(label), out), input);
}
function ctlToggle(target, key, label) {
  const input = h('input', { type: 'checkbox', checked: !!target[key], onchange: () => { target[key] = input.checked; schedule(); commit(); renderControls(); } });
  return h('div', { className: 'ctl toggle' }, h('label', {}, input, t(label)));
}
function ctlText(target, key, label) {
  const input = h('input', { type: 'text', className: 'field', value: target[key], oninput: () => { target[key] = input.value; schedule(); }, onchange: commit });
  return h('div', { className: 'ctl' }, h('div', { className: 'lbl' }, t(label)), input);
}
function ctlPills(target, key, label, options) {
  return h('div', { className: 'ctl' }, h('div', { className: 'lbl' }, t(label)),
    h('div', { className: 'pills' }, options.map(([v, l]) =>
      h('button', { className: target[key] === v ? 'active' : '', onclick: () => { target[key] = v; commit(); renderControls(); schedule(); } }, l))));
}
function ctlChoices(target, key, values, icons, prefix) {
  return h('div', { className: 'choices' }, values.map((v) =>
    h('button', {
      className: target[key] === v ? 'active' : '',
      onclick: () => { target[key] = v; commit(); renderControls(); schedule(); },
      html: `<svg viewBox="0 0 64 44" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${icons[v]}</svg><span>${t(prefix + v)}</span>`,
    })));
}
function ctlPalette(target) {
  return h('div', { className: 'swatches' }, Object.entries(PALETTES).map(([name, p]) =>
    h('button', {
      title: name,
      className: target.palette === name && !(target.colors && Object.keys(target.colors).length) ? 'active' : '',
      onclick: () => { target.palette = name; if (target.colors) target.colors = {}; commit(); renderControls(); schedule(); },
    }, h('span', { style: `background:${p.bg}` }), h('span', { style: `background:${p.ink}` }), h('span', { style: `background:${p.accent}` }))));
}
function ctlColors(target) {
  const c = resolveColors(target);
  const pick = (k, label) => {
    const input = h('input', { type: 'color', value: c[k], oninput: () => { target.colors = { ...target.colors, [k]: input.value }; schedule(); }, onchange: () => { commit(); renderControls(); } });
    return h('label', {}, input, t(label));
  };
  return h('div', { className: 'ctl colors' }, pick('bg', 'color.bg'), pick('ink', 'color.ink'), pick('accent', 'color.accent'),
    Object.keys(target.colors || {}).length ? h('button', { className: 'btn ghost', onclick: () => { target.colors = {}; commit(); renderControls(); schedule(); } }, t('action.reset')) : null);
}
const group = (title, ...items) => h('div', { className: 'group' }, h('h3', {}, t(title)), ...items);

function renderControls() {
  const box = $('#controls');
  const hasTrack = !!S.place?.track;
  const hasRegion = !!S.place?.ringsLL;
  const pct = (v) => `${Math.round(v * 100)} %`;
  const mm = (v) => `${fmt(v, v < 10 && v % 1 ? 1 : 0)} mm`;
  let groups;
  if (S.mode === 'poster') {
    const P = S.poster;
    groups = [
      group('sec.style', ctlChoices(P, 'style', STYLES, STYLE_ICONS, 'style.')),
      group('sec.colors', ctlPalette(P), ctlColors(P)),
      group('sec.text',
        ctlText(P, 'title', 'text.title'), ctlText(P, 'subtitle', 'text.subtitle'),
        ctlToggle(P, 'showCoords', 'text.coords'), ctlToggle(P, 'showStats', 'text.stats'),
        ctlPills(P, 'textAlign', 'text.align', [['center', t('align.center')], ['left', t('align.left')]])),
      group('sec.format',
        ctlPills(P, 'paper', 'format.paper', Object.keys(PAPERS).map((k) => [k, k.includes('x') ? k.replace('x', '×') + ' cm' : k])),
        ctlPills(P, 'orientation', 'format.orientation', [['portrait', t('frame.portrait')], ['landscape', t('frame.landscape')]])),
      group('sec.tuning',
        ctlRange(P, 'density', 'tune.density', 0, 1, 0.01, pct),
        ctlRange(P, 'relief', 'tune.relief', 0, 1, 0.01, pct),
        hasTrack && ctlToggle(P, 'showTrack', 'tune.showTrack'),
        hasTrack && P.showTrack && ctlRange(P, 'trackWidth', 'tune.trackWidth', 0, 1, 0.01, pct),
        hasRegion && ctlToggle(P, 'clipRegion', 'tune.clipRegion'),
        hasRegion && P.clipRegion && ctlToggle(P, 'outline', 'tune.outline'),
        ctlToggle(P, 'border', 'tune.border')),
    ];
  } else {
    const M = S.model;
    const shapes = SHAPES.filter((s) => s !== 'region' || hasRegion);
    groups = [
      group('sec.shape', ctlChoices(M, 'shape', shapes, SHAPE_ICONS, 'shape.')),
      group('sec.size',
        ctlRange(M, 'sizeMm', 'model.size', 50, 400, 5, mm),
        ctlRange(M, 'baseMm', 'model.base', 1, 15, 0.5, mm),
        ctlRange(M, 'reliefMm', 'model.relief', 2, 80, 1, mm),
        ctlRange(M, 'detail', 'model.detail', 120, 420, 20, (v) => `${v}`),
        ctlToggle(M, 'flattenSea', 'model.flattenSea')),
      hasTrack && group('sec.track',
        ctlToggle(M, 'track', 'model.track'),
        M.track && ctlRange(M, 'trackHeightMm', 'model.trackHeight', 0.4, 3, 0.1, mm),
        M.track && ctlRange(M, 'trackWidthMm', 'model.trackWidth', 0.8, 4, 0.1, mm)),
      group('sec.print',
        ctlToggle(M, 'tiles', 'model.tiles'),
        M.tiles && ctlRange(M, 'bedMm', 'model.bed', 120, 400, 5, mm)),
      group('sec.colors', ctlPalette(M)),
    ];
  }
  box.replaceChildren(...groups.filter(Boolean));
}

/* ---------- Étape 3 : téléchargement ---------- */

const slug = () =>
  (S.poster.title || S.place?.label || 'relief')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'relief';

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  $('#export-status').textContent = t('export.done', { f: name });
}

async function posterCanvas(dpi) {
  const fontCss = await exportFontCss();
  const [W, H] = paperSize(S.poster);
  let px = Math.round((W / 25.4) * dpi), py = Math.round((H / 25.4) * dpi);
  const cap = 14000 / Math.max(px, py);
  if (cap < 1) { px = Math.round(px * cap); py = Math.round(py * cap); }
  const svg = renderPoster(scene, S.poster, { t, lang: getLang(), fontCss, cache: renderCache })
    .replace(/width="[^"]+mm" height="[^"]+mm"/, `width="${px}" height="${py}"`);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = px;
    c.height = py;
    c.getContext('2d').drawImage(img, 0, 0, px, py);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const EXPORTS = {
  png: async (dpi) => {
    const c = await posterCanvas(dpi);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    download(`${slug()}-${S.poster.paper}.png`, blob);
  },
  pdf: async () => {
    const [W, H] = paperSize(S.poster);
    const c = await posterCanvas(200);
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: W > H ? 'landscape' : 'portrait', unit: 'mm', format: [Math.min(W, H), Math.max(W, H)] });
    doc.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, H);
    download(`${slug()}-${S.poster.paper}.pdf`, doc.output('blob'));
  },
  svg: async () => {
    const svg = renderPoster(scene, S.poster, { t, lang: getLang(), fontCss: await exportFontCss(), cache: renderCache });
    download(`${slug()}-${S.poster.paper}.svg`, svg, 'image/svg+xml');
  },
  stl: async () => {
    const { stlFiles } = await import('./model/export.js');
    const f = stlFiles(currentModel(), slug());
    download(f.name, f.data, f.type);
  },
  '3mf': async () => {
    const { threeMF } = await import('./model/export.js');
    const f = threeMF(currentModel(), slug());
    download(f.name, f.data, f.type);
  },
  glb: async () => {
    const { glb } = await import('./model/export.js');
    currentModel();
    const f = await glb(preview3d.exportObject(), slug());
    download(f.name, f.data, f.type);
  },
  project: async () => download(`${slug()}.relief.json`, JSON.stringify(projectData(S.poster.title || S.place?.label || 'relief')), 'application/json'),
};

function currentModel() {
  if (!lastModel) {
    lastModel = buildModel(scene, S.model);
    if (preview3d) {
      const p = PALETTES[S.model.palette] || PALETTES.papier;
      preview3d.setModel(lastModel, { ramp: p.ramp, side: p.ramp[2] });
    }
  }
  return lastModel;
}

async function enterExport() {
  $('#export-status').textContent = '';
  const box = $('#export-preview');
  const sum = $('#export-summary');
  const dls = $('#downloads');
  box.replaceChildren();
  sum.replaceChildren();
  dls.replaceChildren();
  try {
    await ensureScene();
  } catch {
    go(2);
    return;
  }
  const row = (k, v) => [h('dt', {}, t(k)), h('dd', {}, v)];
  sum.append(...row('export.summary.place', S.place?.label || t('place.custom')));
  const btn = (kind, label, ...extra) => {
    const b = h('button', {
      className: 'btn primary',
      onclick: async () => {
        b.disabled = true;
        const old = b.textContent;
        b.textContent = t('export.working');
        try {
          await EXPORTS[kind](...extra.map((e) => (typeof e === 'function' ? e() : e)));
        } catch (e) {
          console.error(e);
          $('#export-status').textContent = String(e.message || e);
        } finally {
          b.disabled = false;
          b.textContent = old;
        }
      },
    }, label);
    return b;
  };
  const item = (title, hint, ...right) => h('div', { className: 'dl' }, h('div', {}, h('strong', {}, title), h('small', {}, hint)), h('div', { className: 'right' }, ...right));

  if (S.mode === 'poster') {
    const [W, H] = paperSize(S.poster);
    sum.append(...row('export.summary.format', `${t('export.poster')} · ${t('style.' + S.poster.style)} · ${S.poster.paper} (${W} × ${H} mm)`));
    box.innerHTML = renderPoster(scene, S.poster, { t, lang: getLang(), cache: renderCache });
    const dpi = h('select', {}, [150, 200, 300].map((d) => h('option', { value: d, selected: d === 200 }, `${d} dpi`)));
    dls.append(
      item('PNG', t('export.pngHint'), dpi, btn('png', '↓ PNG', () => +dpi.value)),
      item('PDF', t('export.pdfHint'), btn('pdf', '↓ PDF')),
      item('SVG', t('export.svgHint'), btn('svg', '↓ SVG')),
    );
  } else {
    const m = currentModel();
    const i = m.info;
    sum.append(
      ...row('export.summary.format', `${t('export.model')} · ${t('shape.' + S.model.shape)}`),
      ...row('export.summary.dims', t('model.info', { w: fmt(i.widthMm), d: fmt(i.depthMm), h: fmt(i.heightMm, 1), x: fmt(i.exaggeration, 1) }) +
        (m.parts.length > 1 ? ' · ' + t('model.tilesInfo', { n: m.parts.length, nx: i.tiles[0], ny: i.tiles[1] }) : '')),
    );
    if (preview3d) box.append(h('img', { src: preview3d.snapshot(), alt: '' }));
    dls.append(
      item('3MF', t('export.3mfHint'), btn('3mf', '↓ 3MF')),
      item('STL', t('export.stlHint'), btn('stl', '↓ STL')),
      item('GLB', t('export.glbHint'), btn('glb', '↓ GLB')),
    );
  }
  dls.append(item(t('export.project'), t('export.projectHint'), h('button', { className: 'btn', onclick: () => EXPORTS.project() }, '↓ JSON')));
}

/* ---------- Projets enregistrés ---------- */

const LS_KEY = 'relief-studio:projects';
function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || [];
  } catch {
    return [];
  }
}
function saveProjects(list) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
function projectData(name) {
  const place = S.place ? { ...S.place, track: S.place.track ? simplify(S.place.track, 0.00001) : undefined } : null;
  return { app: 'relief-studio', v: 1, name, savedAt: new Date().toISOString(), place, frame: S.frame, aspect: S.aspect, mode: S.mode, poster: S.poster, model: S.model };
}
function openProject(d) {
  if (!d || d.app !== 'relief-studio' || !d.frame) throw new Error('invalid');
  S.place = d.place || null;
  S.aspect = ASPECTS[d.aspect] ? d.aspect : 'portrait';
  S.mode = d.mode === 'model' ? 'model' : 'poster';
  S.poster = { ...structuredClone(DEFAULT_POSTER), ...d.poster };
  S.model = { ...structuredClone(DEFAULT_MODEL), ...d.model };
  scene = null;
  syncMapData();
  layoutFrame();
  fitBoundsInFrame(lonLatBounds(frameCorners(d.frame)), 0);
  S.frame = d.frame;
  renderSelected();
  resetHistory();
  $('#layouts-dialog').close();
  go(2);
}
function renderProjects() {
  const list = loadProjects();
  const ul = $('#layouts-list');
  if (!list.length) {
    ul.replaceChildren(h('li', { className: 'note' }, t('layouts.empty')));
    return;
  }
  ul.replaceChildren(...list.map((p, k) => h('li', {},
    h('div', {}, h('strong', {}, p.name), h('small', {}, `${new Date(p.savedAt).toLocaleString(getLang())} · ${t(p.mode === 'model' ? 'mode.model' : 'mode.poster')}`)),
    h('button', { type: 'button', className: 'btn', onclick: () => openProject(p) }, t('layouts.open')),
    h('button', { type: 'button', className: 'btn ghost', onclick: () => { const l = loadProjects(); l.splice(k, 1); saveProjects(l); renderProjects(); } }, t('layouts.delete')),
  )));
}

/* ---------- Branchements ---------- */

function bind() {
  for (const b of $$('.stepper button')) b.addEventListener('click', () => go(+b.dataset.step));
  for (const b of $$('.lang button')) b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    applyLang();
  });
  for (const b of $$('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  for (const b of $$('#aspect-seg button')) b.addEventListener('click', () => { S.aspect = b.dataset.aspect; layoutFrame(); });
  $('#open-studio').addEventListener('click', () => go(2));
  $('#back-1').addEventListener('click', () => go(1));
  $('#back-2').addEventListener('click', () => go(2));
  $('#to-export').addEventListener('click', () => go(3));
  for (const b of $$('#mode-seg button')) b.addEventListener('click', () => {
    S.mode = b.dataset.mode;
    commit();
    updateModeUI();
    renderControls();
    renderPreview();
  });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#loading-retry').addEventListener('click', enterStudio);

  const input = $('#gpx-input'), drop = $('#gpx-drop');
  input.addEventListener('change', () => input.files[0] && readGpxFile(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) readGpxFile(f);
  });
  $('#search-input').addEventListener('input', onSearchInput);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#search-results button')?.click();
  });
  $('#region-collection').addEventListener('change', loadRegions);
  $('#region-filter').addEventListener('input', renderRegions);

  $('#open-layouts').addEventListener('click', () => {
    $('#layout-name').value = S.poster.title || S.place?.label || '';
    renderProjects();
    $('#layouts-dialog').showModal();
  });
  $('#layout-save').addEventListener('click', () => {
    const name = $('#layout-name').value.trim() || S.place?.label || t('place.custom');
    const list = loadProjects();
    list.unshift(projectData(name));
    if (saveProjects(list.slice(0, 40))) renderProjects();
  });
  $('#layout-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      openProject(JSON.parse(await f.text()));
    } catch {
      alert('JSON ?');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (S.step !== 2 || !(e.ctrlKey || e.metaKey)) return;
    if (e.target.matches('input[type=text], input[type=search]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });
}

function applyLang() {
  document.documentElement.lang = getLang();
  for (const b of $$('.lang button')) b.classList.toggle('active', b.dataset.lang === getLang());
  applyI18n();
  renderSelected();
  updateFrameFromMap();
  if (S.step === 2) { renderControls(); renderPreview(); }
  if (S.step === 3) enterExport();
}

if (import.meta.env.DEV) window.__relief = { S, get scene() { return scene; }, get model() { return lastModel; } };

bind();
applyLang();
setTab('gpx');
initMap();
go(1);
