// Altitudes : tuiles « Terrarium » publiques (AWS Open Data, SRTM/GMTED/ETOPO…).
// Une grille d'altitude couvre le cadre avec un pas carré `cell` (mètres) ;
// les points sont centrés : x_i = (i - (cols-1)/2)·cell, y_j = ((rows-1)/2 - j)·cell.
// La grille déborde d'une demi-maille de chaque côté du cadre.
import { makeProjection } from './project.js';

const TILE = 256;
const MAX_ZOOM = 15;
const MAX_TILES = 120;
const tileUrl = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const tileCache = new Map();

function newCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function loadTile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = (async () => {
      const res = await fetch(tileUrl(z, x, y), { signal });
      if (!res.ok) throw new Error(`Tuile ${key} : HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const ctx = newCanvas(TILE, TILE).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, TILE, TILE).data;
      const out = new Float32Array(TILE * TILE);
      for (let i = 0; i < out.length; i++) {
        out[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
      }
      return out;
    })();
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return tileCache.get(key);
}

const mercX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const mercY = (lat, z) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};

export function gridSize(frame, longSide) {
  const cell = Math.max(frame.widthM, frame.heightM) / longSide;
  const cols = Math.max(4, Math.round(frame.widthM / cell) + 2);
  const rows = Math.max(4, Math.round(frame.heightM / cell) + 2);
  return { cols, rows, cell };
}

export async function loadElevation(frame, longSide = 600, { signal, onProgress } = {}) {
  const { cols, rows, cell } = gridSize(frame, longSide);
  const proj = makeProjection(frame.center[0], frame.center[1]);
  const lat0 = frame.center[1];

  // Points d'échantillonnage en lon/lat.
  const lon = new Float64Array(cols * rows);
  const lat = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = ((rows - 1) / 2 - j) * cell;
    for (let i = 0; i < cols; i++) {
      const [lo, la] = proj.inverse((i - (cols - 1) / 2) * cell, y);
      lon[j * cols + i] = lo;
      lat[j * cols + i] = la;
    }
  }

  // Zoom : une tuile au moins aussi fine que la grille, dans la limite de MAX_TILES.
  const mpp0 = 156543.03 * Math.cos((lat0 * Math.PI) / 180);
  let z = Math.min(MAX_ZOOM, Math.max(0, Math.ceil(Math.log2(mpp0 / cell))));
  let tiles;
  for (; z >= 0; z--) {
    tiles = new Set();
    const n = 2 ** z;
    const step = Math.max(1, Math.floor(Math.min(cols, rows) / 40));
    for (let j = 0; j < rows; j += step) {
      for (let i = 0; i < cols; i += step) {
        const k = j * cols + i;
        const tx = Math.floor(mercX(lon[k], z) / TILE);
        const ty = Math.floor(mercY(lat[k], z) / TILE);
        for (let dy = 0; dy <= 1; dy++)
          for (let dx = 0; dx <= 1; dx++) {
            const yy = ty + dy;
            if (yy >= 0 && yy < n) tiles.add(`${(((tx + dx) % n) + n) % n},${yy}`);
          }
      }
    }
    if (tiles.size <= MAX_TILES) break;
  }
  const n = 2 ** z;
  const list = [...tiles].map((s) => s.split(',').map(Number));
  const data = new Map();
  let done = 0;
  const queue = list.slice();
  const worker = async () => {
    while (queue.length) {
      const [x, y] = queue.shift();
      try {
        data.set(`${x},${y}`, await loadTile(z, x, y, signal));
      } catch (e) {
        if (signal?.aborted) throw e;
        data.set(`${x},${y}`, null);
      }
      onProgress?.(++done / list.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const sample = (gx, gy) => {
    const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
    const t = data.get(`${((tx % n) + n) % n},${Math.min(n - 1, Math.max(0, ty))}`);
    if (!t) return 0;
    const lx = Math.min(TILE - 1, Math.max(0, gx - tx * TILE));
    const ly = Math.min(TILE - 1, Math.max(0, gy - ty * TILE));
    return t[ly * TILE + lx];
  };

  const out = new Float32Array(cols * rows);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < out.length; k++) {
    const fx = mercX(lon[k], z) - 0.5, fy = mercY(lat[k], z) - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const v =
      sample(x0, y0) * (1 - tx) * (1 - ty) +
      sample(x0 + 1, y0) * tx * (1 - ty) +
      sample(x0, y0 + 1) * (1 - tx) * ty +
      sample(x0 + 1, y0 + 1) * tx * ty;
    out[k] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { cols, rows, cell, data: out, min, max, zoom: z };
}

// Rééchantillonne une grille sur un pas plus grossier (même cadre).
export function resampleGrid(grid, longSide, frame) {
  const { cols, rows, cell } = gridSize(frame, longSide);
  const out = new Float32Array(cols * rows);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < rows; j++) {
    const y = ((rows - 1) / 2 - j) * cell;
    const sj = Math.min(grid.rows - 1.001, Math.max(0, (grid.rows - 1) / 2 - y / grid.cell));
    const j0 = Math.floor(sj), fj = sj - j0;
    for (let i = 0; i < cols; i++) {
      const x = (i - (cols - 1) / 2) * cell;
      const si = Math.min(grid.cols - 1.001, Math.max(0, x / grid.cell + (grid.cols - 1) / 2));
      const i0 = Math.floor(si), fi = si - i0;
      const d = grid.data, c = grid.cols;
      const v =
        d[j0 * c + i0] * (1 - fi) * (1 - fj) +
        d[j0 * c + i0 + 1] * fi * (1 - fj) +
        d[(j0 + 1) * c + i0] * (1 - fi) * fj +
        d[(j0 + 1) * c + i0 + 1] * fi * fj;
      out[j * cols + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { cols, rows, cell, data: out, min, max };
}
