// Prépare le modèle 3D : forme, échelle, relief, trace en relief, tuiles.
import { buildMesh, rasterMask, gridX, gridY } from './mesh.js';
import { resampleGrid } from '../geo/terrain.js';
import { C } from '../geo/landcover.js';
import { CODE_TRACK, CODE_BAND, MAX_TRACKS } from './colors.js';
import { majorityFilter, removeSmallRegions, stampCells } from './zones.js';

// Largeur imprimée des cours d'eau OpenStreetMap (mm).
const RIVER_MM = { river: 1.4, canal: 1.0, stream: 0.7 };

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

  // ---------- Zones de couleur : une par maille (les deux triangles d'une maille ont la même) ----------
  const cc = cols - 1, cr = rows - 1;
  const cellH = (i, j) => {
    const k = j * cols + i, d = grid.data;
    const v = (d[k] + d[k + 1] + d[k + cols] + d[k + cols + 1]) / 4;
    return flatten ? Math.max(0, v) : v;
  };
  // Surface minimale d'une zone (mm²) → nombre de mailles ; les îlots plus petits sont fondus.
  const minCells = model.cleanMm2 > 0 ? Math.round(model.cleanMm2 / (cell * cell)) : 0;
  const bands = Math.max(2, model.bands);
  let zone = null;
  if (model.colorMode === 'landcover' && scene.landcover) {
    const sg = scene.grid, lc = scene.landcover;
    zone = new Uint8Array(cc * cr);
    for (let j = 0; j < cr; j++)
      for (let i = 0; i < cc; i++) {
        const si = Math.round(gridX(i + 0.5, cols, grid.cell) / sg.cell + (sg.cols - 1) / 2);
        const sj = Math.round((sg.rows - 1) / 2 - gridY(j + 0.5, rows, grid.cell) / sg.cell);
        let v = lc[Math.min(sg.rows - 1, Math.max(0, sj)) * sg.cols + Math.min(sg.cols - 1, Math.max(0, si))];
        if (model.snowAbove > 0 && v !== C.water && cellH(i, j) >= model.snowAbove) v = C.snow;
        zone[j * cc + i] = v;
      }
    if (minCells) {
      zone = majorityFilter(zone, cc, cr);
      removeSmallRegions(zone, cc, cr, minCells);
    }
    // Cours d'eau tracés après le nettoyage : un ruisseau fin ne doit pas être effacé.
    if (model.osmRivers && scene.rivers?.length)
      for (const r of scene.rivers)
        stampCells(r.pts.map(([x, y]) => [x * s, y * s]), (RIVER_MM[r.kind] || 0.8) / 2, cols, rows, cell, (c) => { zone[c] = C.water; });
  } else if (model.colorMode === 'elevation') {
    zone = new Uint8Array(cc * cr);
    for (let j = 0; j < cr; j++)
      for (let i = 0; i < cc; i++)
        zone[j * cc + i] = CODE_BAND + Math.min(bands - 1, Math.max(0, Math.floor(((cellH(i, j) - lo) / span) * bands)));
    if (minCells) removeSmallRegions(zone, cc, cr, minCells);
  }

  // Traces GPX par maille (numéro de trace + 1) : bande continue, sans dents de scie.
  let trackCell = null;
  if (scene.tracksM && (model.track || model.trackColored)) {
    trackCell = new Uint8Array(cc * cr);
    scene.tracksM.forEach((pts, ti) =>
      stampCells(pts.map(([x, y]) => [x * s, y * s]), model.trackWidthMm / 2, cols, rows, cell, (c) => { trackCell[c] = ti + 1; }));
  }

  // Relief : l'eau en creux et la trace en relief déplacent les 4 coins des mailles concernées,
  // si bien que la zone colorée reste plate et que la pente se fait dans la maille voisine.
  const cornersOf = (flags, test) => {
    const out = new Uint8Array(cols * rows);
    for (let c = 0; c < flags.length; c++) {
      if (!test(flags[c])) continue;
      const i = c % cc, j = (c - i) / cc, k = j * cols + i;
      out[k] = out[k + 1] = out[k + cols] = out[k + cols + 1] = 1;
    }
    return out;
  };
  if (zone && model.colorMode === 'landcover' && model.waterDepthMm > 0) {
    const wet = cornersOf(zone, (v) => v === C.water);
    for (let k = 0; k < z.length; k++) if (wet[k]) z[k] = Math.max(0.6, z[k] - model.waterDepthMm);
  }
  if (trackCell && model.track) {
    const up = cornersOf(trackCell, (v) => v > 0);
    for (let k = 0; k < z.length; k++) if (up[k]) z[k] += model.trackHeightMm;
  }

  // Code final par maille : la trace par-dessus les zones. Les rivières et les traces découpent
  // parfois de petits morceaux de terrain : seconde passe de nettoyage, traits fins protégés.
  const cellCodes = new Uint8Array(cc * cr);
  if (zone) cellCodes.set(zone);
  if (trackCell && model.trackColored)
    for (let c = 0; c < cellCodes.length; c++) if (trackCell[c]) cellCodes[c] = CODE_TRACK + Math.min(MAX_TRACKS, trackCell[c]) - 1;
  if (minCells && (zone || trackCell)) {
    const waterLines = model.colorMode === 'landcover';
    removeSmallRegions(cellCodes, cc, cr, minCells, (v) => (v >= CODE_TRACK && v < CODE_BAND) || (waterLines && v === C.water));
  }

  // Code de zone d'un triangle du dessus : celui de la maille qui contient son centre.
  const codeAt = (x, y) => {
    const i = Math.min(cc - 1, Math.max(0, Math.floor(x / cell + (cols - 1) / 2)));
    const j = Math.min(cr - 1, Math.max(0, Math.floor((rows - 1) / 2 - y / cell)));
    return cellCodes[j * cc + i];
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
