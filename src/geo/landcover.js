// Occupation du sol : ESA WorldCover 2021 (10 m), découpé à la demande par l'API de
// Microsoft Planetary Computer (PNG en niveaux de gris = code de classe, CORS ouvert).
// Rivières fines : OpenStreetMap via Overpass. Repli : estimation depuis le relief.
import { makeProjection, frameCorners, lonLatBounds } from './project.js';

export const CLASSES = ['none', 'forest', 'meadow', 'crop', 'built', 'rock', 'snow', 'water'];
export const C = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

// Codes WorldCover → classes internes.
const WORLDCOVER = { 10: C.forest, 20: C.meadow, 30: C.meadow, 40: C.crop, 50: C.built, 60: C.rock, 70: C.snow, 80: C.water, 90: C.meadow, 95: C.forest, 100: C.meadow };
const MAX_TILES = 16;
const CROP_URL = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';

const tileName = (la, lo) =>
  `ESA_WorldCover_10m_2021_v200_${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`;

// Coordonnées lon/lat de chaque point de la grille d'altitude.
function gridLonLat(frame, grid) {
  const { cols, rows, cell } = grid;
  const proj = makeProjection(frame.center[0], frame.center[1]);
  const lon = new Float64Array(cols * rows), lat = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const [lo, la] = proj.inverse((i - (cols - 1) / 2) * cell, ((rows - 1) / 2 - j) * cell);
      lon[j * cols + i] = lo;
      lat[j * cols + i] = la;
    }
  return { lon, lat };
}

async function fetchCrop(id, w, s, e, n, W, H, signal) {
  const url = `${CROP_URL}/${w.toFixed(6)},${s.toFixed(6)},${e.toFixed(6)},${n.toFixed(6)}/${W}x${H}.png?collection=esa-worldcover&item=${id}&assets=map&resampling=nearest`;
  const res = await fetch(url, { signal });
  if (res.status === 404) return null; // pas de tuile : pleine mer
  if (!res.ok) throw new Error(`worldcover ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

// Classes WorldCover aux points de la grille (0 = inconnu).
export async function loadWorldCover(frame, grid, { signal, onProgress } = {}) {
  const b = lonLatBounds(frameCorners(frame));
  if (b.east > 180 || b.west < -180 || b.north > 84 || b.south < -60) throw new Error('landcover-out-of-range');
  const tiles = [];
  for (let la = Math.floor(b.south / 3) * 3; la < b.north; la += 3)
    for (let lo = Math.floor(b.west / 3) * 3; lo < b.east; lo += 3) tiles.push([la, lo]);
  if (tiles.length > MAX_TILES) throw new Error('landcover-too-large');

  const degPerCell = grid.cell / 111320;
  const cosLat = Math.cos((frame.center[1] * Math.PI) / 180);
  const crops = new Map();
  let done = 0;
  const queue = tiles.slice();
  const worker = async () => {
    while (queue.length) {
      const [la, lo] = queue.shift();
      const w = Math.max(b.west, lo), e = Math.min(b.east, lo + 3);
      const s = Math.max(b.south, la), n = Math.min(b.north, la + 3);
      // 1,5 pixel par maille de grille, borné pour rester léger.
      const W = Math.max(8, Math.min(1400, Math.ceil(((e - w) * cosLat) / degPerCell * 1.5)));
      const H = Math.max(8, Math.min(1400, Math.ceil((n - s) / degPerCell * 1.5)));
      crops.set(`${la},${lo}`, { w, s, e, n, W, H, data: await fetchCrop(tileName(la, lo), w, s, e, n, W, H, signal) });
      onProgress?.(++done / tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const { lon, lat } = gridLonLat(frame, grid);
  const out = new Uint8Array(lon.length);
  for (let k = 0; k < out.length; k++) {
    const la = Math.floor(lat[k] / 3) * 3, lo = Math.floor(lon[k] / 3) * 3;
    const t = crops.get(`${la},${lo}`);
    if (!t) continue;
    if (!t.data) { if (grid.data[k] <= 0.5) out[k] = C.water; continue; }
    const px = Math.min(t.W - 1, Math.max(0, Math.floor(((lon[k] - t.w) / (t.e - t.w)) * t.W)));
    const py = Math.min(t.H - 1, Math.max(0, Math.floor(((t.n - lat[k]) / (t.n - t.s)) * t.H)));
    const p = (py * t.W + px) * 4;
    if (t.data[p + 3] === 0) { if (grid.data[k] <= 0.5) out[k] = C.water; continue; }
    out[k] = WORLDCOVER[t.data[p]] || 0;
  }
  return out;
}

// Estimation grossière depuis le relief (pente, altitude) pour les points sans donnée.
export function reliefClasses(grid, out = new Uint8Array(grid.cols * grid.rows)) {
  const { cols, rows, cell, data } = grid;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (out[k]) continue;
      const h = data[k];
      const dx = (data[j * cols + Math.min(cols - 1, i + 1)] - data[j * cols + Math.max(0, i - 1)]) / (2 * cell);
      const dy = (data[Math.min(rows - 1, j + 1) * cols + i] - data[Math.max(0, j - 1) * cols + i]) / (2 * cell);
      const slope = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
      if (h <= 0.5 && grid.min < 0) out[k] = C.water;
      else if (h > 3300) out[k] = C.snow;
      else if (h > 2800 || slope > 42) out[k] = C.rock;
      else if (h > 1900) out[k] = C.meadow;
      else out[k] = slope > 14 ? C.forest : C.meadow;
    }
  return out;
}

// Cours d'eau OpenStreetMap (lignes) : seulement pour des cadres de taille raisonnable.
export async function loadRivers(frame, signal) {
  if (Math.max(frame.widthM, frame.heightM) > 60000) return [];
  const b = lonLatBounds(frameCorners(frame));
  const q = `[out:json][timeout:25];way["waterway"~"^(river|stream|canal)$"](${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)});out geom;`;
  const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const json = await res.json();
  const proj = makeProjection(frame.center[0], frame.center[1]);
  return json.elements
    .filter((e) => e.type === 'way' && e.geometry?.length > 1)
    .map((e) => ({ kind: e.tags.waterway, pts: e.geometry.map((g) => proj.forward(g.lon, g.lat)) }));
}
