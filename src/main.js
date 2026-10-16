import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/jost/400.css';
import '@fontsource/jost/500.css';
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
import { PALETTES, resolveColors, hexToRgb, rgbToHex, mix } from './poster/palettes.js';
import { exportFontCss } from './poster/fonts.js';
import { buildModel, SHAPES } from './model/build.js';
import { loadWorldCover, reliefClasses, loadRivers } from './geo/landcover.js';
import { colorOfCode, resolveFilaments, DEFAULT_PRINT_COLORS, DEFAULT_CLASS_ON, LAND } from './model/colors.js';

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
  font: 'serif', units: 'metric', edgeFade: 0, trackHalo: true,
  contourStep: 0, smoothing: 0.5, lineWidth: 0.5, labels: true,
};
const DEFAULT_MODEL = {
  shape: 'rect', sizeMm: 150, baseMm: 4, reliefMm: 20, detail: 260, flattenSea: true,
  track: true, trackHeightMm: 1, trackWidthMm: 1.6, tiles: false, bedMm: 220, palette: 'papier',
  colorMode: 'landcover', printColors: {}, classOn: {}, bands: 5, snowAbove: 0, waterDepthMm: 0.6,
  osmRivers: true, trackColored: true,
};

const S = {
  step: 1,
  tab: 'gpx',
  place: null, // { kind, label, sublabel, tracks?: [{ id, name, points, stats }], stats?, ringsLL? }
  frame: null, // { center: [lon, lat], widthM, heightM }
  aspect: 'portrait',
  mode: 'poster',
  poster: structuredClone(DEFAULT_POSTER),
  model: structuredClone(DEFAULT_MODEL),
  trackColors: [], // couleur de chaque trace (null = automatique)
};

// Couleurs proposées pour les traces ajoutées après la première.
const TRACK_COLORS = ['#2f74c0', '#2e9e5b', '#8e44ad', '#e8a33d', '#d63f8c', '#16a3b8', '#7a5c3e', '#4b4b4b'];
const defaultTrackColor = (i) => (i === 0 ? null : TRACK_COLORS[(i - 1) % TRACK_COLORS.length]);
// Couleur effective d'une trace : la sienne, sinon l'accent du poster ou la couleur de trace 3D.
function trackColor(i, mode = S.mode) {
  if (S.trackColors[i]) return S.trackColors[i];
  return mode === 'poster' ? resolveColors(S.poster).accent : { ...DEFAULT_PRINT_COLORS, ...S.model.printColors }.track;
}

let scene = null;
let renderCache = {};
let lastModel = null;
let preview3d = null;

const fmt = (v, d = 0) =>
  new Intl.NumberFormat(getLang() === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);

/* ---------- Historique (annuler / rétablir) ---------- */

const hist = { stack: [], i: -1 };
const snapshot = () => JSON.stringify({ mode: S.mode, poster: S.poster, model: S.model, trackColors: S.trackColors });
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
  S.trackColors = o.trackColors || [];
  syncMapData();
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
    map.addLayer({ id: 'track-line', type: 'line', source: 'track', paint: { 'line-color': ['get', 'color'], 'line-width': 3 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
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
    p?.tracks?.length
      ? {
          type: 'FeatureCollection',
          features: p.tracks.map((tr, i) => ({
            type: 'Feature',
            properties: { color: trackColor(i, 'poster') },
            geometry: { type: 'LineString', coordinates: tr.points.map((q) => [q[0], q[1]]) },
          })),
        }
      : emptyFC(),
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
  if (!place.tracks) S.trackColors = [];
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
  if (p.tracks?.length > 1) el.append(h('div', { className: 'stats' }, t('place.tracks', { n: p.tracks.length })));
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

// GPX : une ou plusieurs traces, ajoutées à la liste si un lieu GPX est déjà choisi.
const combinedStats = (tracks) => ({
  distanceM: tracks.reduce((a, tr) => a + tr.stats.distanceM, 0),
  gainM: tracks.reduce((a, tr) => a + tr.stats.gainM, 0),
  maxEleM: Math.max(...tracks.map((tr) => tr.stats.maxEleM ?? -Infinity)),
});
const tracksBounds = (tracks) => lonLatBounds(tracks.flatMap((tr) => tr.points));

async function readGpxFiles(files) {
  const err = $('#gpx-error');
  err.hidden = true;
  const added = [], bad = [];
  for (const file of files) {
    try {
      const gpx = parseGPX(await file.text());
      added.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: gpx.name || file.name.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' '),
        points: simplify(gpx.points, 0.000004),
        stats: { distanceM: gpx.distanceM, gainM: gpx.gainM, maxEleM: gpx.maxEleM },
      });
    } catch {
      bad.push(file.name);
    }
  }
  if (bad.length) {
    err.textContent = t('place.gpx.error') + (files.length > 1 ? ` (${bad.join(', ')})` : '');
    err.hidden = false;
  }
  if (!added.length) return;
  if (S.place?.kind === 'gpx') {
    for (const tr of added) {
      S.trackColors[S.place.tracks.length] = defaultTrackColor(S.place.tracks.length);
      S.place.tracks.push(tr);
    }
    S.place.stats = combinedStats(S.place.tracks);
    syncMapData();
    fitBoundsInFrame(tracksBounds(S.place.tracks));
    renderSelected();
  } else {
    S.trackColors = added.map((_, i) => defaultTrackColor(i));
    choosePlace({ kind: 'gpx', label: added[0].name, sublabel: '', tracks: added, stats: combinedStats(added) }, tracksBounds(added));
  }
  renderTrackList();
}

function removeTrack(i) {
  S.place.tracks.splice(i, 1);
  S.trackColors.splice(i, 1);
  if (!S.place.tracks.length) {
    S.place = null;
    S.trackColors = [];
    scene = null;
  } else {
    S.place.stats = combinedStats(S.place.tracks);
  }
  syncMapData();
  renderSelected();
  renderTrackList();
}

// Ligne de trace : pastille de couleur, nom, distance ; ✕ pour retirer (étape Lieu)
// ou ↺ pour revenir à la couleur automatique (atelier).
function trackRow(tk, i, mode, removable) {
  const input = h('input', {
    type: 'color', value: trackColor(i, mode), title: t('track.color'),
    oninput: () => { S.trackColors[i] = input.value; syncMapData(); schedule(); },
    onchange: () => { commit(); if (S.step === 2) { renderControls(); updateFilamentList(); } },
  });
  const action = removable
    ? h('button', { type: 'button', className: 'icon small', title: t('track.remove'), onclick: () => removeTrack(i) }, '×')
    : S.trackColors[i]
      ? h('button', { type: 'button', className: 'icon small', title: t('track.auto'), onclick: () => { S.trackColors[i] = null; commit(); syncMapData(); renderControls(); schedule(); } }, '↺')
      : null;
  return h('li', { className: 'track-row' }, input,
    h('div', {}, h('strong', {}, tk.name), h('small', {}, `${fmt(tk.stats.distanceM / 1000, 1)} km · +${fmt(tk.stats.gainM)} m`)),
    action);
}
function renderTrackList() {
  const ul = $('#track-list');
  const tracks = S.place?.kind === 'gpx' ? S.place.tracks : [];
  ul.replaceChildren(...tracks.map((tk, i) => trackRow(tk, i, 'poster', true)));
  ul.hidden = !tracks.length;
}
const ctlTrackColors = (mode) => h('ul', { className: 'ctl tracks' }, S.place.tracks.map((tk, i) => trackRow(tk, i, mode, false)));

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

// Traces projetées dans le repère de la scène ; recalculées quand on en ajoute ou retire.
const tracksSig = () => (S.place?.tracks || []).map((tr) => tr.id).join(',');
function syncSceneTracks() {
  if (!scene) return;
  const sig = tracksSig();
  if (scene.tracksSig === sig) return;
  const proj = makeProjection(scene.frame.center[0], scene.frame.center[1]);
  scene.tracksM = S.place?.tracks?.length ? S.place.tracks.map((tr) => tr.points.map(([lo, la]) => proj.forward(lo, la))) : null;
  scene.stats = S.place?.stats || null;
  scene.tracksSig = sig;
  lastModel = null;
}

let loadCtl;
async function ensureScene() {
  const key = JSON.stringify(S.frame) + '|' + (S.place?.label || '') + '|' + (S.place?.kind || '');
  if (scene?.key === key) {
    syncSceneTracks();
    return scene;
  }
  loadCtl?.abort();
  loadCtl = new AbortController();
  const ctl = loadCtl;
  showLoading(0);
  const frame = structuredClone(S.frame);
  const grid = await loadElevation(frame, 600, { signal: ctl.signal, onProgress: (p) => showLoading(p) });
  if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
  const proj = makeProjection(frame.center[0], frame.center[1]);
  const regionRingsM = S.place?.ringsLL?.map((r) => r.map(([lo, la]) => proj.forward(lo, la))) || null;
  const mask = regionRingsM ? rasterMask(grid.cols, grid.rows, grid.cell, regionRingsM, null).inside : null;
  scene = { key, frame, grid, mask, regionRingsM, stats: S.place?.stats || null };
  syncSceneTracks();
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

// Occupation du sol et rivières : chargées à la demande pour l'objet 3D, sans bloquer l'aperçu.
let lcCtl;
function ensureLandcover() {
  if (!scene || scene.landcoverState) return;
  const sc = scene;
  sc.landcoverState = 'loading';
  lcCtl?.abort();
  lcCtl = new AbortController();
  loadWorldCover(sc.frame, sc.grid, { signal: lcCtl.signal })
    .then((cls) => {
      sc.landcover = reliefClasses(sc.grid, cls); // les trous éventuels sont estimés depuis le relief
      sc.landcoverState = 'worldcover';
    })
    .catch((e) => {
      if (e.name === 'AbortError') { sc.landcoverState = null; return; }
      console.warn('Occupation du sol indisponible :', e.message);
      sc.landcover = reliefClasses(sc.grid);
      sc.landcoverState = 'relief';
    })
    .finally(() => { if (sc === scene) { lastModel = null; schedule(); } });
}
function ensureRivers() {
  if (!scene || scene.riversState) return;
  const sc = scene;
  sc.riversState = 'loading';
  loadRivers(sc.frame)
    .then((r) => { sc.rivers = r; sc.riversState = 'ok'; })
    .catch((e) => { console.warn('Rivières OSM indisponibles :', e.message); sc.rivers = []; sc.riversState = 'error'; })
    .finally(() => { if (sc === scene) { lastModel = null; schedule(); } });
}

const previewColors = () => ({
  base: { ...DEFAULT_PRINT_COLORS, ...S.model.printColors }.base,
  colorOf: (code) => colorOfCode(S.model, code, S.trackColors),
});

function updateFilamentList() {
  const el = document.getElementById('filament-list');
  if (!el || !lastModel) return;
  const { filaments } = resolveFilaments(S.model, lastModel.codes, S.trackColors);
  el.replaceChildren(
    h('div', { className: 'lbl' }, t('pc.filaments', { n: filaments.length })),
    h('div', { className: 'chips' }, filaments.map((hex, i) => h('span', { className: 'chip', title: hex }, h('i', { style: `background:${hex}` }), String(i + 1)))),
    filaments.length > 4 ? h('p', { className: 'hint' }, t('pc.tooMany')) : null,
    S.model.colorMode === 'landcover' ? h('p', { className: 'hint' }, t('pc.source.' + (scene?.landcoverState || 'loading'))) : null,
  );
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
  syncSceneTracks();
  if (S.mode === 'poster') {
    const svg = renderPoster(scene, S.poster, { t, lang: getLang(), cache: renderCache, trackColors: S.trackColors });
    $('#paper').innerHTML = svg;
    fitPaper();
    const [W, H] = paperSize(S.poster);
    $('#infobar').textContent = `${paperLabel(S.poster.paper)} · ${fmt(W)} × ${fmt(H)} mm`;
  } else {
    if (!preview3d) {
      return import('./model/preview.js').then(({ ModelPreview }) => {
        preview3d = new ModelPreview($('#three'));
        preview3d.setBackground('#ece7dd');
        renderPreview();
      });
    }
    const keep = lastModel?.shapeKey === S.model.shape + S.model.sizeMm;
    if (S.model.colorMode === 'landcover') {
      ensureLandcover();
      if (S.model.osmRivers) ensureRivers();
    }
    lastModel = buildModel(scene, S.model);
    lastModel.shapeKey = S.model.shape + S.model.sizeMm;
    preview3d.setModel(lastModel, previewColors(), keep);
    updateFilamentList();
    const i = lastModel.info;
    const tris = lastModel.parts.reduce((n, q) => n + q.indices.length / 3, 0);
    const parts = [t('model.info', { w: fmt(i.widthMm), d: fmt(i.depthMm), h: fmt(i.heightMm, 1), x: fmt(i.exaggeration, 1) })];
    if (i.tiles[0] * i.tiles[1] > 1) parts.push(t('model.tilesInfo', { n: lastModel.parts.length, nx: i.tiles[0], ny: i.tiles[1] }));
    parts.push(t('model.tris', { n: fmt(tris) }));
    parts.push(t('model.filaments', { n: resolveFilaments(S.model, lastModel.codes, S.trackColors).filaments.length }));
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
function ctlPills(target, key, label, options, after) {
  return h('div', { className: 'ctl' }, h('div', { className: 'lbl' }, t(label)),
    h('div', { className: 'pills' }, options.map(([v, l]) =>
      h('button', { className: target[key] === v ? 'active' : '', onclick: () => { target[key] = v; after?.(); commit(); renderControls(); schedule(); } }, l))));
}
function ctlSelect(target, key, label, options) {
  const sel = h('select', {
    className: 'field',
    onchange: () => { const v = options[sel.selectedIndex][0]; target[key] = v; commit(); renderControls(); schedule(); },
  }, options.map(([v, l]) => h('option', { selected: target[key] === v }, l)));
  return h('div', { className: 'ctl' }, h('div', { className: 'lbl' }, t(label)), sel);
}
const paperLabel = (k) => (k.endsWith('in') ? k.slice(0, -2).replace('x', '×') + ' in' : k.includes('x') ? k.replace('x', '×') + ' cm' : k);
function ctlChoices(target, key, values, icons, prefix) {
  return h('div', { className: 'choices' }, values.map((v) =>
    h('button', {
      className: target[key] === v ? 'active' : '',
      onclick: () => { target[key] = v; commit(); renderControls(); schedule(); },
      html: `<svg viewBox="0 0 64 44" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${icons[v]}</svg><span>${t(prefix + v)}</span>`,
    })));
}
// Pastille = mini-aperçu : fond, deux courbes, une maîtresse et un bout de trace.
const swatchSvg = (p) =>
  `<svg viewBox="0 0 48 30" aria-hidden="true"><rect width="48" height="30" fill="${p.bg}"/>` +
  `<path d="M-2 22 Q10 14 20 19 T50 15" fill="none" stroke="${p.ink}" stroke-width="1.2" opacity=".8"/>` +
  `<path d="M-2 27 Q12 20 24 24 T50 21" fill="none" stroke="${p.ink}" stroke-width="1.2" opacity=".8"/>` +
  `<path d="M-2 16 Q9 7 21 12 T50 8" fill="none" stroke="${p.hi}" stroke-width="2"/>` +
  `<path d="M6 6 L18 10 L28 5 L40 9" fill="none" stroke="${p.accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function ctlPalette(target) {
  const custom = target.colors && Object.keys(target.colors).length;
  return h('div', { className: 'swatches' }, Object.entries(PALETTES).map(([name, p]) =>
    h('button', {
      title: t('palette.' + name),
      className: target.palette === name && !custom ? 'active' : '',
      onclick: () => { target.palette = name; if (target.colors) target.colors = {}; commit(); renderControls(); schedule(); },
      html: `${swatchSvg(p)}<span>${t('palette.' + name)}</span>`,
    })));
}

// Variante inverse : le fond prend la couleur des maîtresses et inversement.
// Si l'encre se confondait avec les maîtresses, elle passe à mi-chemin pour rester visible.
function invertColors(target) {
  const c = resolveColors(target);
  const ink = c.ink.toLowerCase() === c.hi.toLowerCase() ? rgbToHex(mix(hexToRgb(c.hi), hexToRgb(c.bg), 0.62)) : c.ink;
  target.colors = { bg: c.hi, ink, hi: c.bg, accent: c.accent };
  commit();
  renderControls();
  schedule();
}
function ctlColors(target, withHi = false) {
  const c = resolveColors(target);
  const pick = (k, label) => {
    const input = h('input', { type: 'color', value: c[k], oninput: () => { target.colors = { ...target.colors, [k]: input.value }; schedule(); }, onchange: () => { commit(); renderControls(); } });
    return h('label', {}, input, t(label));
  };
  return h('div', { className: 'ctl' },
    h('div', { className: 'colors' }, pick('bg', 'color.bg'), pick('ink', 'color.ink'), withHi && pick('hi', 'color.hi'), pick('accent', 'color.accent')),
    h('div', { className: 'row color-actions' },
      h('button', { className: 'btn ghost', onclick: () => invertColors(target) }, '◐ ' + t('action.invert')),
      Object.keys(target.colors || {}).length ? h('button', { className: 'btn ghost', onclick: () => { target.colors = {}; commit(); renderControls(); schedule(); } }, t('action.reset')) : null));
}
// Une ligne par zone : case à cocher (sinon la zone prend la couleur du reste du terrain),
// couleur modifiable, nom.
function ctlClassColors(M) {
  const col = { ...DEFAULT_PRINT_COLORS, ...M.printColors };
  return h('div', { className: 'ctl classes' }, LAND.map((name) => {
    const on = M.classOn?.[name] ?? DEFAULT_CLASS_ON[name];
    const cb = h('input', { type: 'checkbox', checked: on, onchange: () => { M.classOn = { ...M.classOn, [name]: cb.checked }; commit(); renderControls(); schedule(); } });
    const color = h('input', {
      type: 'color', value: col[name], disabled: !on,
      oninput: () => { M.printColors = { ...M.printColors, [name]: color.value }; schedule(); },
      onchange: commit,
    });
    return h('label', { className: 'class-row' + (on ? '' : ' off') }, cb, color, h('span', {}, t('lc.' + name)));
  }));
}
function ctlPrintColors(M, list) {
  const col = { ...DEFAULT_PRINT_COLORS, ...M.printColors };
  return h('div', { className: 'ctl colors' }, list.filter(Boolean).map(([k, label]) => {
    const input = h('input', { type: 'color', value: col[k], oninput: () => { M.printColors = { ...M.printColors, [k]: input.value }; schedule(); }, onchange: commit });
    return h('label', {}, input, t(label));
  }));
}
const group = (title, ...items) => h('div', { className: 'group' }, h('h3', {}, t(title)), ...items);

function renderControls() {
  const box = $('#controls');
  const hasTrack = !!S.place?.tracks?.length;
  const hasRegion = !!S.place?.ringsLL;
  const pct = (v) => `${Math.round(v * 100)} %`;
  const mm = (v) => `${fmt(v, v < 10 && v % 1 ? 1 : 0)} mm`;
  let groups;
  if (S.mode === 'poster') {
    const P = S.poster;
    const isContours = P.style === 'contours';
    const imp = P.units === 'imperial';
    const unit = imp ? 'ft' : 'm';
    const steps = imp ? [10, 20, 25, 50, 100, 200, 500, 1000] : [5, 10, 20, 25, 50, 100, 200, 500];
    groups = [
      group('sec.style', ctlChoices(P, 'style', STYLES, STYLE_ICONS, 'style.')),
      group('sec.colors', ctlPalette(P), ctlColors(P, isContours)),
      group('sec.text',
        ctlText(P, 'title', 'text.title'), ctlText(P, 'subtitle', 'text.subtitle'),
        ctlPills(P, 'font', 'text.font', [['serif', t('font.serif')], ['geometric', t('font.geometric')]]),
        ctlToggle(P, 'showCoords', 'text.coords'), ctlToggle(P, 'showStats', 'text.stats'),
        // Les équidistances proposées dépendent de l'unité : on repasse en automatique.
        ctlPills(P, 'units', 'text.units', [['metric', t('units.metric')], ['imperial', t('units.imperial')]], () => { P.contourStep = 0; }),
        ctlPills(P, 'textAlign', 'text.align', [['center', t('align.center')], ['left', t('align.left')]])),
      group('sec.format',
        ctlPills(P, 'paper', 'format.paper', Object.keys(PAPERS).map((k) => [k, paperLabel(k)])),
        ctlPills(P, 'orientation', 'format.orientation', [['portrait', t('frame.portrait')], ['landscape', t('frame.landscape')]])),
      group('sec.tuning',
        isContours && ctlSelect(P, 'contourStep', 'tune.step', [[0, t('tune.auto')], ...steps.map((v) => [v, `${fmt(v)} ${unit}`])]),
        (!isContours || !P.contourStep) && ctlRange(P, 'density', 'tune.density', 0, 1, 0.01, pct),
        isContours && ctlRange(P, 'smoothing', 'tune.smoothing', 0, 1, 0.01, pct),
        isContours && ctlRange(P, 'lineWidth', 'tune.lineWidth', 0, 1, 0.01, pct),
        isContours && ctlToggle(P, 'labels', 'tune.labels'),
        !isContours && ctlRange(P, 'relief', 'tune.relief', 0, 1, 0.01, pct),
        ctlRange(P, 'edgeFade', 'tune.edgeFade', 0, 1, 0.01, pct),
        hasRegion && ctlToggle(P, 'clipRegion', 'tune.clipRegion'),
        hasRegion && P.clipRegion && ctlToggle(P, 'outline', 'tune.outline'),
        ctlToggle(P, 'border', 'tune.border')),
      hasTrack && group('sec.track',
        ctlToggle(P, 'showTrack', 'tune.showTrack'),
        P.showTrack && ctlTrackColors('poster'),
        P.showTrack && ctlRange(P, 'trackWidth', 'tune.trackWidth', 0, 1, 0.01, pct),
        P.showTrack && ctlToggle(P, 'trackHalo', 'tune.trackHalo')),
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
      group('sec.printColors',
        ctlPills(M, 'colorMode', 'pc.mode', [['landcover', t('pc.landcover')], ['elevation', t('pc.elevation')], ['single', t('pc.single')]]),
        M.colorMode === 'landcover' && ctlClassColors(M),
        M.colorMode === 'elevation' && ctlRange(M, 'bands', 'pc.bands', 2, 8, 1, (v) => `${v}`),
        ctlPrintColors(M, [
          M.colorMode === 'elevation' ? ['low', 'pc.low'] : ['terrain', M.colorMode === 'landcover' ? 'pc.terrainRest' : 'pc.terrain'],
          M.colorMode === 'elevation' && ['high', 'pc.high'],
          ['base', 'pc.base'],
        ]),
        hasTrack && ctlToggle(M, 'trackColored', 'pc.trackColored'),
        hasTrack && M.trackColored && ctlTrackColors('model'),
        M.colorMode === 'landcover' && ctlRange(M, 'snowAbove', 'pc.snowAbove', 0, 5000, 100, (v) => (v ? `${fmt(v)} m` : t('pc.off'))),
        M.colorMode === 'landcover' && ctlRange(M, 'waterDepthMm', 'pc.waterDepth', 0, 2, 0.1, (v) => (v ? mm(v) : t('pc.off'))),
        M.colorMode === 'landcover' && ctlToggle(M, 'osmRivers', 'pc.osmRivers'),
        h('div', { id: 'filament-list', className: 'ctl filaments' })),
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
  const svg = renderPoster(scene, S.poster, { t, lang: getLang(), fontCss, cache: renderCache, trackColors: S.trackColors })
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
    const svg = renderPoster(scene, S.poster, { t, lang: getLang(), fontCss: await exportFontCss(), cache: renderCache, trackColors: S.trackColors });
    download(`${slug()}-${S.poster.paper}.svg`, svg, 'image/svg+xml');
  },
  stl: async () => {
    const { stlFiles } = await import('./model/export.js');
    const f = stlFiles(currentModel(), slug());
    download(f.name, f.data, f.type);
  },
  '3mf': async () => {
    const { threeMF } = await import('./model/export.js');
    const m = currentModel();
    const paint = resolveFilaments(S.model, m.codes, S.trackColors);
    const f = threeMF(m, slug(), paint.filaments.length > 1 ? paint : null);
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
    if (preview3d) preview3d.setModel(lastModel, previewColors());
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
    sum.append(...row('export.summary.format', `${t('export.poster')} · ${t('style.' + S.poster.style)} · ${paperLabel(S.poster.paper)} (${fmt(W)} × ${fmt(H)} mm)`));
    box.innerHTML = renderPoster(scene, S.poster, { t, lang: getLang(), cache: renderCache, trackColors: S.trackColors });
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
      h('dt', {}, t('export.summary.filaments')),
      h('dd', { className: 'chips' }, resolveFilaments(S.model, m.codes, S.trackColors).filaments.map((hex, k) =>
        h('span', { className: 'chip', title: hex }, h('i', { style: `background:${hex}` }), String(k + 1)))),
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
  const place = S.place ? { ...S.place, tracks: S.place.tracks?.map((tr) => ({ ...tr, points: simplify(tr.points, 0.00001) })) } : null;
  return { app: 'relief-studio', v: 2, name, savedAt: new Date().toISOString(), place, frame: S.frame, aspect: S.aspect, mode: S.mode, poster: S.poster, model: S.model, trackColors: S.trackColors };
}
function openProject(d) {
  if (!d || d.app !== 'relief-studio' || !d.frame) throw new Error('invalid');
  let place = d.place || null;
  // Projets de la première version : une seule trace dans place.track.
  if (place?.track && !place.tracks) {
    place = { ...place, tracks: [{ id: 't0', name: place.label, points: place.track, stats: place.stats }] };
    delete place.track;
  }
  S.place = place;
  S.trackColors = Array.isArray(d.trackColors) ? d.trackColors : [];
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
  renderTrackList();
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
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = ''; // pour pouvoir re-sélectionner les mêmes fichiers
    if (files.length) readGpxFiles(files);
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...e.dataTransfer.files];
    if (files.length) readGpxFiles(files);
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
  renderTrackList();
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
