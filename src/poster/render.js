// Rendu d'un poster en SVG (unités = millimètres du papier).
import { contours } from 'd3-contour';
import { flowAccumulation, riverPolylines } from './hydro.js';
import { resampleGrid } from '../geo/terrain.js';
import { hexToRgb, rgbToHex, mix, makeRamp, resolveColors } from './palettes.js';

export const PAPERS = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  '30x40': [300, 400],
  '50x70': [500, 700],
  '61x91': [610, 914],
  '18x24in': [457.2, 609.6],
};

export const STYLES = ['ridges', 'contours', 'strata', 'shade', 'rivers'];

const f2 = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function paperSize(poster) {
  const [w, h] = PAPERS[poster.paper] || PAPERS.A3;
  return poster.orientation === 'landscape' ? [h, w] : [w, h];
}

// Zone du dessin et du texte sur la feuille.
export function layout(poster, frame) {
  const [W, H] = paperSize(poster);
  const u = Math.min(W, H);
  const m = u * 0.075;
  const textH = poster.title || poster.subtitle || poster.showCoords || poster.showStats ? H * (W > H ? 0.2 : 0.155) : 0;
  const box = { x: m, y: m, w: W - 2 * m, h: H - 2 * m - textH };
  const k = Math.min(box.w / frame.widthM, box.h / frame.heightM);
  const aw = frame.widthM * k, ah = frame.heightM * k;
  const art = { x: box.x + (box.w - aw) / 2, y: box.y + (box.h - ah) / 2, w: aw, h: ah, k };
  return { W, H, u, m, box, art, textY: H - m - textH, textH };
}

function gridCtx(grid, frame, art) {
  const { cols, rows, cell } = grid;
  // Index de grille (fractionnaire) → coordonnées papier.
  const gx = (i) => art.x + ((i - (cols - 1) / 2) * cell + frame.widthM / 2) * art.k;
  const gy = (j) => art.y + (frame.heightM / 2 - ((rows - 1) / 2 - j) * cell) * art.k;
  const mx = (x) => art.x + (x + frame.widthM / 2) * art.k;
  const my = (y) => art.y + (frame.heightM / 2 - y) * art.k;
  return { gx, gy, mx, my };
}

function bilinear(grid, fi, fj) {
  const { cols, rows, data } = grid;
  fi = Math.max(0, Math.min(cols - 1.0001, fi));
  fj = Math.max(0, Math.min(rows - 1.0001, fj));
  const i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
  const k = j * cols + i;
  return (
    data[k] * (1 - ti) * (1 - tj) + data[k + 1] * ti * (1 - tj) +
    data[k + cols] * (1 - ti) * tj + data[k + cols + 1] * ti * tj
  );
}

// Altitudes min/max dans la zone utile (masque de région le cas échéant), mer à 0.
function elevationRange(grid, mask) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < grid.data.length; k++) {
    if (mask && !mask[k]) continue;
    const v = grid.data[k];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) { lo = grid.min; hi = grid.max; }
  if (hi > 0 && lo < 0) lo = 0;
  if (hi - lo < 1) hi = lo + 1;
  return [lo, hi];
}

function ringsPath(rings, mx, my) {
  return rings
    .map((r) => 'M' + r.map(([x, y]) => `${f2(mx(x))},${f2(my(y))}`).join('L') + 'Z')
    .join('');
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= raw) return s * p;
  return 10 * p;
}

/* ---------- Styles ---------- */

function drawRidges(ctx) {
  const { grid, poster, art, colors, mask, range } = ctx;
  const { cols, rows } = grid;
  const n = Math.round(28 + poster.density * 112);
  const samples = Math.min(cols - 2, 420);
  const amp = (art.h / n) * (1.5 + poster.relief * 13);
  const [lo, hi] = range;
  const sw = f2(ctx.u * (0.0009 + 0.0011 * (1 - poster.density)));
  let out = '';
  for (let l = 0; l < n; l++) {
    const fj = 1 + (l * (rows - 3)) / (n - 1);
    const base = art.y + amp * 0.85 + ((art.h - amp * 0.85) * l) / (n - 1);
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        const line = seg.map(([x, y]) => `${f2(x)},${f2(y)}`).join('L');
        out += `<path d="M${f2(seg[0][0])},${f2(base + 0.2)}L${line}L${f2(seg[seg.length - 1][0])},${f2(base + 0.2)}Z" fill="${colors.bg}"/>`;
        out += `<path d="M${line}" fill="none" stroke="${colors.ink}" stroke-width="${sw}" stroke-linejoin="round"/>`;
      }
      seg = [];
    };
    for (let s = 0; s < samples; s++) {
      const fi = 1 + (s * (cols - 3)) / (samples - 1);
      if (mask && !mask[Math.round(fj) * cols + Math.round(fi)]) { flush(); continue; }
      const h = (Math.max(lo, bilinear(grid, fi, fj)) - lo) / (hi - lo);
      seg.push([art.x + (art.w * s) / (samples - 1), base - h * amp]);
    }
    flush();
  }
  return out;
}

function contourGeoms(grid, thresholds) {
  return contours().size([grid.cols, grid.rows]).thresholds(thresholds)(Float64Array.from(grid.data));
}
function geomPath(geom, gx, gy) {
  let d = '';
  for (const poly of geom.coordinates)
    for (const ring of poly) d += 'M' + ring.map(([x, y]) => `${f2(gx(x - 0.5))},${f2(gy(y - 0.5))}`).join('L') + 'Z';
  return d;
}

// Lissage gaussien séparable (bords répliqués) pour des courbes plus souples.
function gaussian(grid, sigma) {
  const { cols, rows, data } = grid;
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let d = -r; d <= r; d++) sum += k[d + r] = Math.exp(-(d * d) / (2 * sigma * sigma));
  for (let d = 0; d < k.length; d++) k[d] /= sum;
  const tmp = new Float32Array(data.length), out = new Float32Array(data.length);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let v = 0;
      for (let d = -r; d <= r; d++) v += data[j * cols + Math.min(cols - 1, Math.max(0, i + d))] * k[d + r];
      tmp[j * cols + i] = v;
    }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let v = 0;
      for (let d = -r; d <= r; d++) v += tmp[Math.min(rows - 1, Math.max(0, j + d)) * cols + i] * k[d + r];
      out[j * cols + i] = v;
    }
  return { ...grid, data: out };
}

function smoothed(ctx, sigma) {
  if (sigma < 0.3) return ctx.grid;
  const key = sigma.toFixed(2);
  if (ctx.cache.smooth?.key !== key) ctx.cache.smooth = { key, grid: gaussian(ctx.grid, sigma) };
  return ctx.cache.smooth.grid;
}

// Emplacements des cotes le long d'un anneau (coordonnées papier) : portions assez droites,
// espacées entre elles et des cotes déjà posées.
function labelSpots(pts, labelW, spacing, phase, placed, minGap) {
  const n = pts.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const total = cum[n - 1];
  if (total < labelW * 5) return [];
  const at = (s) => {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return [pts[lo][0] + t * (pts[hi][0] - pts[lo][0]), pts[lo][1] + t * (pts[hi][1] - pts[lo][1])];
  };
  const spots = [];
  for (let s = labelW + (phase % spacing); s < total - labelW; s += spacing) {
    const a = at(s - labelW * 0.7), b = at(s + labelW * 0.7), p = at(s);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < labelW * 1.3) continue; // trop courbé
    if (placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minGap)) continue;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    else if (ang < -90) ang += 180;
    placed.push(p);
    spots.push({ x: p[0], y: p[1], ang });
  }
  return spots;
}

function drawContours(ctx) {
  const { poster, colors, range, gx, gy, art } = ctx;
  const grid = smoothed(ctx, (poster.smoothing ?? 0.5) * 3);
  const uf = poster.units === 'imperial' ? 3.28084 : 1; // altitudes affichées en pieds ou en mètres
  const lo = range[0] * uf, hi = range[1] * uf;
  const step = poster.contourStep > 0 ? poster.contourStep : niceStep((hi - lo) / (12 + poster.density * 48));
  const levels = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) levels.push(v);
  if (grid.min < 0 && hi > 0 && !levels.includes(0)) levels.unshift(0);
  const geoms = contourGeoms(grid, levels.map((v) => v / uf));
  const lw = ctx.u * 0.0007 * (0.35 + (poster.lineWidth ?? 0.5) * 1.8);
  const ink = hexToRgb(colors.ink), light = hexToRgb(colors.hi);
  const fs = ctx.u * 0.0055;
  const spacing = art.w * 0.3, minGap = art.w * 0.085;
  const placed = [];
  let lines = '', labels = '', gaps = '';
  geoms.forEach((g, k) => {
    if (!g.coordinates.length) return;
    const v = levels[k];
    const major = Math.round(v / step) % 5 === 0;
    const tt = (v - lo) / (hi - lo);
    const color = major ? colors.hi : rgbToHex(mix(ink, light, 0.1 + 0.3 * tt));
    const op = major ? 0.95 : 0.45 + 0.4 * tt;
    lines += `<path d="${geomPath(g, gx, gy)}" fill="none" stroke="${color}" stroke-opacity="${f2(op)}" stroke-width="${f2(major ? lw * 2 : lw)}" stroke-linejoin="round"/>`;
    if (!major || !poster.labels) return;
    const text = String(Math.round(v));
    const labelW = text.length * fs * 0.62;
    for (const poly of g.coordinates)
      for (const ring of poly) {
        const pts = ring.map(([x, y]) => [gx(x - 0.5), gy(y - 0.5)]);
        for (const p of labelSpots(pts, labelW, spacing, (v * 37.7) % spacing, placed, minGap)) {
          const rot = `rotate(${f2(p.ang)} ${f2(p.x)} ${f2(p.y)})`;
          gaps += `<rect x="${f2(p.x - labelW / 2 - fs * 0.35)}" y="${f2(p.y - fs * 0.6)}" width="${f2(labelW + fs * 0.7)}" height="${f2(fs * 1.2)}" transform="${rot}" fill="#000"/>`;
          labels += `<text x="${f2(p.x)}" y="${f2(p.y)}" dy="${f2(fs * 0.36)}" transform="${rot}">${text}</text>`;
        }
      }
  });
  const r = `x="${f2(art.x)}" y="${f2(art.y)}" width="${f2(art.w)}" height="${f2(art.h)}"`;
  let out = `<defs><mask id="contour-gaps" maskUnits="userSpaceOnUse" ${r}><rect ${r} fill="#fff"/>${gaps}</mask></defs>`;
  out += `<g mask="url(#contour-gaps)">${lines}</g>`;
  if (labels) out += `<g fill="${colors.hi}" fill-opacity="0.9" font-family="${fontFamily(poster, 'body')}" font-size="${f2(fs)}" text-anchor="middle">${labels}</g>`;
  return out;
}

function rampFor(colors, custom) {
  if (!custom) return makeRamp(colors.ramp);
  const bg = hexToRgb(colors.bg), ink = hexToRgb(colors.ink);
  return makeRamp([0.1, 0.38, 0.68, 1].map((t) => rgbToHex(mix(bg, ink, t))));
}

function drawStrata(ctx) {
  const { grid, poster, colors, range, gx, gy, art } = ctx;
  const [lo, hi] = range;
  const n = Math.round(6 + poster.density * 22);
  const ramp = rampFor(colors, ctx.customColors);
  const t = Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / n);
  const geoms = contourGeoms(grid, t);
  const sh = f2(ctx.u * (0.0005 + poster.relief * 0.003));
  let out = `<defs><filter id="paper-shadow" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="${sh * 0.4}" dy="${sh}" stdDeviation="${sh}" flood-color="#000" flood-opacity="0.35"/></filter></defs>`;
  out += `<rect x="${f2(art.x)}" y="${f2(art.y)}" width="${f2(art.w)}" height="${f2(art.h)}" fill="${grid.min < 0 ? colors.water : rgbToHex(ramp(0))}"/>`;
  if (grid.min < 0) {
    const [sea] = contourGeoms(grid, [0.01]);
    out += `<path d="${geomPath(sea, gx, gy)}" fill="${rgbToHex(ramp(0))}"/>`;
  }
  geoms.forEach((g, k) => {
    if (!g.coordinates.length) return;
    out += `<path d="${geomPath(g, gx, gy)}" fill="${rgbToHex(ramp((k + 1) / n))}" filter="url(#paper-shadow)"/>`;
  });
  return out;
}

function shadeRaster(grid, poster, colors, range, customColors) {
  const { cols, rows, cell, data } = grid;
  const [lo, hi] = range;
  const ramp = rampFor(colors, customColors);
  const bg = hexToRgb(colors.bg), water = hexToRgb(colors.water);
  const zf = 1 + poster.relief * 5;
  const az = (315 * Math.PI) / 180, zen = (45 * Math.PI) / 180;
  const w = cols - 2, h = rows - 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const tint = 0.35 + poster.density * 0.5;
  for (let j = 1; j < rows - 1; j++)
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      const dzdx = ((data[k + 1] - data[k - 1]) / (2 * cell)) * zf;
      const dzdy = ((data[k - cols] - data[k + cols]) / (2 * cell)) * zf;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      let s = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - Math.PI / 2 + aspect);
      s = Math.max(0, Math.min(1, s));
      let c;
      if (data[k] <= 0 && grid.min < 0) c = water;
      else {
        const base = mix(bg, ramp((data[k] - lo) / (hi - lo)), tint);
        c = s < 0.707 ? mix(base, ramp(1), (0.707 - s) * 0.8) : mix(base, [255, 255, 255], (s - 0.707) * 0.6);
      }
      const p = ((j - 1) * w + (i - 1)) * 4;
      img.data[p] = c[0];
      img.data[p + 1] = c[1];
      img.data[p + 2] = c[2];
      img.data[p + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function drawShade(ctx) {
  const { grid, poster, colors, range, art } = ctx;
  const url = shadeRaster(grid, poster, colors, range, ctx.customColors);
  return `<image href="${url}" x="${f2(art.x)}" y="${f2(art.y)}" width="${f2(art.w)}" height="${f2(art.h)}" preserveAspectRatio="none"/>`;
}

function drawRivers(ctx) {
  const { poster, colors, frame, art, mask } = ctx;
  let grid = ctx.grid;
  if (Math.max(grid.cols, grid.rows) > 460) grid = resampleGrid(grid, 440, frame);
  const { cols, rows } = grid;
  const flow = ctx.cache.flow?.grid === grid.cols + 'x' + grid.rows + ctx.cache.key
    ? ctx.cache.flow.value
    : (ctx.cache.flow = { grid: grid.cols + 'x' + grid.rows + ctx.cache.key, value: flowAccumulation(grid.data, cols, rows) }).value;
  const n = cols * rows;
  const thr = Math.max(8, n * (0.006 - poster.density * 0.0055));
  const wMin = ctx.u * 0.0005, wMax = ctx.u * (0.003 + poster.relief * 0.004);
  const lmax = Math.log(n / thr);
  const widthOf = (a) => Math.round((Math.log(a / thr) / lmax) * 8) / 8;
  const sub = mask && grid !== ctx.grid ? null : mask;
  const keep = (k) => grid.data[k] > 0.5 && (!sub || sub[k]);
  const lines = riverPolylines(flow, cols, rows, thr, widthOf, keep);
  const { gx, gy } = gridCtx(grid, frame, art);
  const byW = new Map();
  for (const l of lines) {
    const d = 'M' + l.pts.map((k) => `${f2(gx(k % cols))},${f2(gy(Math.floor(k / cols)))}`).join('L');
    byW.set(l.w, (byW.get(l.w) || '') + d);
  }
  let out = '';
  [...byW.keys()].sort((a, b) => a - b).forEach((w) => {
    out += `<path d="${byW.get(w)}" fill="none" stroke="${colors.ink}" stroke-width="${f2(wMin + Math.max(0, w) * (wMax - wMin))}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  return out;
}

const DRAW = { ridges: drawRidges, contours: drawContours, strata: drawStrata, shade: drawShade, rivers: drawRivers };

/* ---------- Texte ---------- */

function fmtNum(v, lang, digits = 0) {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
}
function fmtCoord(lon, lat) {
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
}

function fontFamily(poster, role) {
  if (poster.font === 'geometric') return "Jost, Futura, 'Century Gothic', sans-serif";
  return role === 'title' ? 'Fraunces, Georgia, serif' : 'Inter, Helvetica, Arial, sans-serif';
}

// Morceaux de la ligne de détails : distance, dénivelé (ou point culminant), coordonnées.
export function detailParts(scene, poster, t, lang, range) {
  const imp = poster.units === 'imperial';
  const parts = [];
  if (poster.showStats) {
    const s = scene.stats;
    if (s?.distanceM) {
      parts.push(imp ? `${fmtNum(s.distanceM / 1609.344, lang, 1)} mi` : `${fmtNum(s.distanceM / 1000, lang, 1)} km`);
      parts.push(imp ? `+${fmtNum(s.gainM * 3.28084, lang)} ft` : `+${fmtNum(s.gainM, lang)} m`);
    } else if (range) {
      parts.push(`${t('stat.summit')} ${imp ? fmtNum(range[1] * 3.28084, lang) + ' ft' : fmtNum(range[1], lang) + ' m'}`);
    }
  }
  if (poster.showCoords) parts.push(fmtCoord(scene.frame.center[0], scene.frame.center[1]));
  return parts;
}

function drawText(L, poster, colors, parts) {
  const { W, m, textY, textH } = L;
  if (!textH) return '';
  const geo = poster.font === 'geometric';
  const avail = W - 2 * m;
  const align = poster.textAlign === 'left' ? 'start' : 'middle';
  const x = align === 'start' ? m : W / 2;
  // L'espacement des lettres ajoute un blanc après le dernier caractère : on recentre.
  const xs = (ls) => f2(align === 'middle' ? x + ls / 2 : x);
  const title = geo ? (poster.title || '').toUpperCase() : poster.title || '';
  const track = geo ? 0.22 : 0;
  let fs = L.u * (geo ? 0.07 : 0.085);
  if (title.length) fs = Math.min(fs, avail / (title.length * ((geo ? 0.66 : 0.56) + track)));
  const sub = (poster.subtitle || '').toUpperCase();
  const fsSub = L.u * 0.024;
  const fsDet = L.u * (geo ? 0.021 : 0.019);
  const sep = geo ? '  ·  ' : ' · ';
  const joined = parts.join(sep);
  const det = geo ? (s) => s.toUpperCase() : (s) => s;
  const lines = joined.length > 64 && parts.length > 1 ? [parts.slice(0, -1).join(sep), parts[parts.length - 1]] : joined ? [joined] : [];
  let y = textY + textH * 0.18 + fs * 0.8;
  let out = `<g fill="${colors.ink}" text-anchor="${align}">`;
  if (title) {
    const ls = fs * track;
    out += `<text x="${xs(ls)}" y="${f2(y)}" font-family="${fontFamily(poster, 'title')}" font-weight="${geo ? 400 : 600}" font-size="${f2(fs)}" letter-spacing="${f2(ls)}">${esc(title)}</text>`;
  }
  y += fsSub * 2.1;
  if (sub) {
    const ls = fsSub * 0.28;
    const subW = Math.min(avail, sub.length * (fsSub * 0.66 + ls));
    out += `<text x="${xs(ls)}" y="${f2(y)}" font-family="${fontFamily(poster, 'body')}" font-weight="500" font-size="${f2(fsSub)}" letter-spacing="${f2(ls)}" ${subW >= avail ? `textLength="${f2(avail)}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(sub)}</text>`;
  }
  for (const line of lines) {
    y += fsDet * (geo ? 1.9 : 1.75);
    const ls = geo ? fsDet * 0.2 : 0;
    out += `<text x="${xs(ls)}" y="${f2(y)}" font-family="${fontFamily(poster, 'body')}" font-size="${f2(fsDet)}" letter-spacing="${f2(ls)}" fill-opacity="${geo ? 0.9 : 0.72}" xml:space="preserve">${esc(det(line))}</text>`;
  }
  return out + '</g>';
}

// Fondu des bords : deux masques à dégradé (horizontal puis vertical).
function fadeDefs(art, amount) {
  const f = Math.min(0.49, amount * 0.35);
  const stops = `<stop offset="0" stop-color="#000"/><stop offset="${f2(f * 0.5)}" stop-color="#555"/><stop offset="${f2(f)}" stop-color="#fff"/><stop offset="${f2(1 - f)}" stop-color="#fff"/><stop offset="${f2(1 - f * 0.5)}" stop-color="#555"/><stop offset="1" stop-color="#000"/>`;
  const r = `x="${f2(art.x)}" y="${f2(art.y)}" width="${f2(art.w)}" height="${f2(art.h)}"`;
  return (
    `<linearGradient id="fade-gx" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient>` +
    `<linearGradient id="fade-gy" x1="0" x2="0" y1="0" y2="1">${stops}</linearGradient>` +
    `<mask id="fade-x" maskUnits="userSpaceOnUse" ${r}><rect ${r} fill="url(#fade-gx)"/></mask>` +
    `<mask id="fade-y" maskUnits="userSpaceOnUse" ${r}><rect ${r} fill="url(#fade-gy)"/></mask>`
  );
}

/* ---------- Composition ---------- */

// scene : { frame, grid, mask, regionRingsM, trackM, stats }
export function renderPoster(scene, poster, { t, lang, fontCss = '', cache = {} } = {}) {
  const L = layout(poster, scene.frame);
  const colors = resolveColors(poster);
  const customColors = !!(poster.colors?.bg || poster.colors?.ink);
  const { gx, gy, mx, my } = gridCtx(scene.grid, scene.frame, L.art);
  const clip = poster.clipRegion && scene.regionRingsM ? scene.regionRingsM : null;
  const mask = clip ? scene.mask : null;
  const range = elevationRange(scene.grid, mask);
  const ctx = { ...L, grid: scene.grid, frame: scene.frame, poster, colors, customColors, mask, range, gx, gy, mx, my, cache, art: L.art };

  const { W, H, art } = L;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(W)} ${f2(H)}" width="${f2(W)}mm" height="${f2(H)}mm">`;
  if (fontCss) svg += `<style>${fontCss}</style>`;
  svg += `<rect width="${f2(W)}" height="${f2(H)}" fill="${colors.bg}"/>`;
  svg += `<defs><clipPath id="art-clip"><rect x="${f2(art.x)}" y="${f2(art.y)}" width="${f2(art.w)}" height="${f2(art.h)}"/></clipPath>`;
  if (clip) svg += `<clipPath id="region-clip"><path clip-rule="evenodd" d="${ringsPath(clip, mx, my)}"/></clipPath>`;
  const fade = poster.edgeFade > 0.01;
  if (fade) svg += fadeDefs(art, poster.edgeFade);
  svg += `</defs>`;
  const style = DRAW[poster.style] ? poster.style : 'ridges';
  const regionClip = clip && style !== 'ridges' ? ' clip-path="url(#region-clip)"' : '';
  const body = `<g${regionClip}>${DRAW[style](ctx)}</g>`;
  svg += `<g clip-path="url(#art-clip)">${fade ? `<g mask="url(#fade-y)"><g mask="url(#fade-x)">${body}</g></g>` : body}`;
  if (clip && poster.outline && style !== 'ridges') {
    svg += `<path d="${ringsPath(clip, mx, my)}" fill="none" stroke="${colors.ink}" stroke-width="${f2(L.u * 0.0012)}" stroke-linejoin="round"/>`;
  }
  if (scene.trackM && poster.showTrack) {
    const d = 'M' + scene.trackM.map(([x, y]) => `${f2(mx(x))},${f2(my(y))}`).join('L');
    const tw = L.u * (0.0018 + 0.0022 * poster.trackWidth);
    if (poster.trackHalo !== false)
      svg += `<path d="${d}" fill="none" stroke="${colors.bg}" stroke-width="${f2(tw * 2.6)}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.85"/>`;
    svg += `<path d="${d}" fill="none" stroke="${colors.accent}" stroke-width="${f2(tw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const [sx, sy] = scene.trackM[0];
    svg += `<circle cx="${f2(mx(sx))}" cy="${f2(my(sy))}" r="${f2(tw * 1.6)}" fill="${colors.accent}" stroke="${colors.bg}" stroke-width="${f2(tw * 0.6)}"/>`;
  }
  svg += '</g>';
  if (poster.border) {
    const o = L.u * 0.012;
    svg += `<rect x="${f2(art.x - o)}" y="${f2(art.y - o)}" width="${f2(art.w + 2 * o)}" height="${f2(art.h + 2 * o)}" fill="none" stroke="${colors.ink}" stroke-width="${f2(L.u * 0.0012)}"/>`;
  }
  svg += drawText(L, poster, colors, detailParts(scene, poster, t, lang, range));
  return svg + '</svg>';
}
