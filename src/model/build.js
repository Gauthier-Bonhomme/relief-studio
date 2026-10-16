// Prépare le modèle 3D : forme, échelle, relief, trace en relief, tuiles.
import { buildMesh, rasterMask, gridX, gridY } from './mesh.js';
import { resampleGrid } from '../geo/terrain.js';
import { C } from '../geo/landcover.js';
import { CODE_TRACK, CODE_BAND, MAX_TRACKS } from './colors.js';

// Largeur imprimée des cours d'eau OpenStreetMap (mm).
const RIVER_MM = { river: 1.4, canal: 1.0, stream: 0.7 };

// Marque les points de grille à moins de width/2 (mm) d'une polyligne (coordonnées en mm).
function stampLine(pts, half, cols, rows, cell, mark) {
  for (let p = 1; p < pts.length; p++) {
    const [ax, ay] = pts[p - 1], [bx, by] = pts[p];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half) / cell + (cols - 1) / 2));
    const i1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + half) / cell + (cols - 1) / 2));
    const j0 = Math.max(0, Math.floor((rows - 1) / 2 - (Math.max(ay, by) + half) / cell));
    const j1 = Math.min(rows - 1, Math.ceil((rows - 1) / 2 - (Math.min(ay, by) - half) / cell));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = gridX(i, cols, cell), py = gridY(j, rows, cell);
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        if (Math.hypot(px - ax - t * dx, py - ay - t * dy) <= half) mark(j * cols + i);
      }
  }
}

export const SHAPES = ['rect', 'circle', 'hexagon', 'region'];

export function footprintRingsM(shape, frame, regionRingsM) {
  const W = frame.widthM, H = frame.heightM;
  if (shape === 'circle') {
    const r = (Math.min(W, H) / 2) * 0.985;
    return [Array.from({ length: 180 }, (_, k) => [r * Math.cos((k * Math.PI) / 90), r * Math.sin((k * Math.PI) / 90)])];
  }
  if (shape === 'hexagon') {
    const r = Math.min(W / 2, H / Math.sqrt(3)) * 0.985;
    return [Array.from({ length: 6 }, (_, k) => [r * Math.cos((k * Math.PI) / 3), r * Math.sin((k * Math.PI) / 3)])];
  }
  if (shape === 'region' && regionRingsM) return regionRingsM;
  return null;
}

function ringsBounds(rings, frame) {
  if (!rings) return [-frame.widthM / 2, -frame.heightM / 2, frame.widthM / 2, frame.heightM / 2];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  return [
    Math.max(x0, -frame.widthM / 2), Math.max(y0, -frame.heightM / 2),
    Math.min(x1, frame.widthM / 2), Math.min(y1, frame.heightM / 2),
  ];
}

export function buildModel(scene, model) {
  const { frame } = scene;
  const shape = model.shape === 'region' && !scene.regionRingsM ? 'rect' : model.shape;
  const grid = resampleGrid(scene.grid, model.detail, frame);
  const { cols, rows } = grid;
  const ringsM = footprintRingsM(shape, frame, scene.regionRingsM);
  const [bx0, by0, bx1, by1] = ringsBounds(ringsM, frame);
  const s = model.sizeMm / Math.max(bx1 - bx0, by1 - by0); // mm par mètre
  const cell = grid.cell * s;

  // Altitudes extrêmes dans la forme.
  const frameRect = [-frame.widthM / 2, -frame.heightM / 2, frame.widthM / 2, frame.heightM / 2];
  const { inside } = rasterMask(cols, rows, grid.cell, ringsM, frameRect);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < inside.length; k++) {
    if (!inside[k]) continue;
    lo = Math.min(lo, grid.data[k]);
    hi = Math.max(hi, grid.data[k]);
  }
  if (!Number.isFinite(lo)) { lo = grid.min; hi = grid.max; }
  const flatten = model.flattenSea && hi > 0;
  if (flatten) lo = Math.max(lo, 0);
  const span = Math.max(1, hi - lo);
  const kz = model.reliefMm / span; // mm par mètre d'altitude
  const z = new Float32Array(cols * rows);
  for (let k = 0; k < z.length; k++) {
    const h = flatten ? Math.max(0, grid.data[k]) : grid.data[k];
    z[k] = model.baseMm + Math.max(0, h - lo) * kz;
  }

  // Occupation du sol rééchantillonnée sur la grille du modèle (point le plus proche).
  let cls = null;
  if (model.colorMode === 'landcover' && scene.landcover) {
    const sg = scene.grid, lc = scene.landcover;
    cls = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const si = Math.round(gridX(i, cols, grid.cell) / sg.cell + (sg.cols - 1) / 2);
        const sj = Math.round((sg.rows - 1) / 2 - gridY(j, rows, grid.cell) / sg.cell);
        cls[j * cols + i] = lc[Math.min(sg.rows - 1, Math.max(0, sj)) * sg.cols + Math.min(sg.cols - 1, Math.max(0, si))];
      }
    if (model.snowAbove > 0)
      for (let k = 0; k < cls.length; k++) if (grid.data[k] >= model.snowAbove && cls[k] !== C.water) cls[k] = C.snow;
    if (model.osmRivers && scene.rivers?.length)
      for (const r of scene.rivers)
        stampLine(r.pts.map(([x, y]) => [x * s, y * s]), (RIVER_MM[r.kind] || 0.8) / 2, cols, rows, cell, (k) => { cls[k] = C.water; });
    // Eau légèrement en creux : les rives se lisent mieux, au toucher comme à l'œil.
    if (model.waterDepthMm > 0)
      for (let k = 0; k < cls.length; k++) if (cls[k] === C.water) z[k] = Math.max(0.6, z[k] - model.waterDepthMm);
  }

  // Traces GPX : en relief et/ou en couleur sur le dessus (trackHit = numéro de trace + 1).
  let trackHit = null;
  if (scene.tracksM && (model.track || model.trackColored)) {
    trackHit = new Uint8Array(cols * rows);
    scene.tracksM.forEach((pts, ti) =>
      stampLine(pts.map(([x, y]) => [x * s, y * s]), model.trackWidthMm / 2, cols, rows, cell, (k) => { trackHit[k] = ti + 1; }));
    if (model.track) for (let k = 0; k < z.length; k++) if (trackHit[k]) z[k] += model.trackHeightMm;
  }

  // Code de zone d'un triangle du dessus, d'après le point de grille le plus proche de son centre.
  const bands = Math.max(2, model.bands);
  const codeAt = (x, y) => {
    const i = Math.min(cols - 1, Math.max(0, Math.round(x / cell + (cols - 1) / 2)));
    const j = Math.min(rows - 1, Math.max(0, Math.round((rows - 1) / 2 - y / cell)));
    const k = j * cols + i;
    if (trackHit && model.trackColored && trackHit[k]) return CODE_TRACK + Math.min(MAX_TRACKS, trackHit[k]) - 1;
    if (model.colorMode === 'elevation') {
      const h = flatten ? Math.max(0, grid.data[k]) : grid.data[k];
      return CODE_BAND + Math.min(bands - 1, Math.max(0, Math.floor(((h - lo) / span) * bands)));
    }
    return cls ? cls[k] : 0;
  };

  const ringsMm = ringsM ? ringsM.map((r) => r.map(([x, y]) => [x * s, y * s])) : null;
  const widthMm = (bx1 - bx0) * s, depthMm = (by1 - by0) * s;

  // Tuiles : coupes placées à mi-chemin entre deux points de grille.
  const usable = Math.max(40, model.bedMm - 10);
  const nx = model.tiles ? Math.ceil(widthMm / usable) : 1;
  const ny = model.tiles ? Math.ceil(depthMm / usable) : 1;
  const snapX = (x) => gridX(Math.round(x / cell + (cols - 1) / 2 - 0.5), cols, cell) + cell / 2;
  const snapY = (y) => gridY(Math.round((rows - 1) / 2 - y / cell - 0.5), rows, cell) - cell / 2;
  const xs = [-1e9], ys = [-1e9];
  for (let a = 1; a < nx; a++) xs.push(snapX(bx0 * s + (widthMm * a) / nx));
  for (let b = 1; b < ny; b++) ys.push(snapY(by0 * s + (depthMm * b) / ny));
  xs.push(1e9);
  ys.push(1e9);

  const parts = [];
  const codes = new Set();
  for (let b = 0; b < ny; b++)
    for (let a = 0; a < nx; a++) {
      const mesh = buildMesh({ cols, rows, cell, z, polygons: ringsMm, clip: [xs[a], ys[b], xs[a + 1], ys[b + 1]] });
      if (!mesh.indices.length) continue;
      const P = mesh.positions, I = mesh.indices;
      const triCodes = new Uint8Array(mesh.topCount);
      for (let t = 0; t < mesh.topCount; t++) {
        const v0 = I[3 * t] * 3, v1 = I[3 * t + 1] * 3, v2 = I[3 * t + 2] * 3;
        triCodes[t] = codeAt((P[v0] + P[v1] + P[v2]) / 3, (P[v0 + 1] + P[v1 + 1] + P[v2 + 1]) / 3);
        codes.add(triCodes[t]);
      }
      parts.push({ ...mesh, triCodes, tile: [a, ny - 1 - b], name: nx * ny > 1 ? `${String.fromCharCode(65 + (ny - 1 - b))}${a + 1}` : '' });
    }
  return {
    parts,
    codes,
    center: [((bx0 + bx1) / 2) * s, ((by0 + by1) / 2) * s],
    info: {
      widthMm, depthMm,
      heightMm: model.baseMm + model.reliefMm + (scene.tracksM && model.track ? model.trackHeightMm : 0),
      reliefMm: model.reliefMm,
      trackMm: scene.tracksM && model.track ? model.trackHeightMm : 0,
      exaggeration: kz / s,
      tiles: [nx, ny],
      lo, hi,
    },
  };
}
