// Plaque de texte à l'avant du modèle : le texte est dessiné avec la vraie police dans un
// canevas, puis devient un champ de hauteurs maillé comme le terrain (étanche, peint).
import { buildMesh } from './mesh.js';

export const CODE_PLATE = 254; // dessus de la plaque : couleur du socle
export const CODE_TEXT = 255; // lettres

const FONTS = {
  serif: { l1: (px) => `600 ${px}px Fraunces, Georgia, serif`, l2: (px) => `500 ${px}px Inter, Arial, sans-serif`, upper: false, track: 0 },
  geometric: { l1: (px) => `500 ${px}px Jost, Futura, sans-serif`, l2: (px) => `400 ${px}px Jost, Futura, sans-serif`, upper: true, track: 0.14 },
};

function newCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Masque du texte (1 = lettre) sur une grille cols × rows, un pixel par point de grille.
function textMask(cols, rows, lines, fontName) {
  const f = FONTS[fontName] || FONTS.serif;
  const ctx = newCanvas(cols, rows).getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const [t1, t2] = lines.map((s) => (f.upper ? s.toUpperCase() : s));
  const availW = (cols - 2) * 0.9;
  const two = !!(t1 && t2);
  // Hauteurs relatives des deux lignes, puis réduction si le texte est trop large.
  let px1 = rows * (two ? 0.42 : 0.56), px2 = rows * (two ? 0.22 : 0.4);
  const fit = (text, px, font) => {
    if (!text) return px;
    ctx.font = font(px);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(f.track * px).toFixed(2)}px`;
    const w = ctx.measureText(text).width;
    return w > availW ? (px * availW) / w : px;
  };
  px1 = fit(t1, px1, f.l1);
  px2 = fit(t2, px2, f.l2);
  const h1 = t1 ? px1 * 0.72 : 0, h2 = t2 ? px2 * 0.72 : 0, gap = two ? rows * 0.1 : 0;
  let y = (rows - (h1 + gap + h2)) / 2;
  const draw = (text, px, font, h) => {
    if (!text) return;
    ctx.font = font(px);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(f.track * px).toFixed(2)}px`;
    // Le blanc ajouté après la dernière lettre décale le centrage : on le compense.
    ctx.fillText(text, cols / 2 + (f.track * px) / 2, y + h);
    y += h + gap;
  };
  draw(t1, px1, f.l1, h1);
  draw(t2, px2, f.l2, h2);
  const px = ctx.getImageData(0, 0, cols, rows).data;
  const mask = new Uint8Array(cols * rows);
  for (let k = 0; k < mask.length; k++) mask[k] = px[4 * k + 3] > 110 ? 1 : 0;
  return mask;
}

// widthMm × depthMm, dos de la plaque en y = backY, centrée en x = cx.
export function buildPlaque({ widthMm, depthMm, baseMm, lines, font, textMm, engrave, cx, backY }) {
  // 0,25 mm : assez fin pour des lettres nettes avec une buse de 0,4 mm, sans alourdir le fichier.
  const cell = Math.max(0.25, widthMm / 600);
  const cols = Math.round(widthMm / cell) + 2;
  const rows = Math.round(depthMm / cell) + 2;
  const mask = textMask(cols, rows, lines, font);
  const plate = Math.max(baseMm, engrave ? textMm + 0.8 : 0.8);
  const z = new Float32Array(cols * rows);
  for (let k = 0; k < z.length; k++) z[k] = mask[k] ? (engrave ? plate - textMm : plate + textMm) : plate;
  const mesh = buildMesh({ cols, rows, cell, z });
  const P = mesh.positions;
  // Les coordonnées du mailleur sont centrées sur la plaque : on la place devant le modèle.
  const dy = backY - ((rows - 2) * cell) / 2;
  for (let v = 0; v < P.length; v += 3) {
    P[v] += cx;
    P[v + 1] += dy;
  }
  const I = mesh.indices;
  const triCodes = new Uint8Array(mesh.topCount);
  let hasText = false;
  for (let t = 0; t < mesh.topCount; t++) {
    const v0 = I[3 * t] * 3, v1 = I[3 * t + 1] * 3, v2 = I[3 * t + 2] * 3;
    const x = (P[v0] + P[v1] + P[v2]) / 3 - cx, y = (P[v0 + 1] + P[v1 + 1] + P[v2 + 1]) / 3 - dy;
    const i = Math.min(cols - 1, Math.max(0, Math.round(x / cell + (cols - 1) / 2)));
    const j = Math.min(rows - 1, Math.max(0, Math.round((rows - 1) / 2 - y / cell)));
    const isText = mask[j * cols + i] === 1;
    triCodes[t] = isText ? CODE_TEXT : CODE_PLATE;
    hasText ||= isText;
  }
  return { ...mesh, triCodes, hasText, depthMm: (rows - 2) * cell, heightMm: engrave ? plate : plate + textMm };
}
