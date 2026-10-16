// Cartes de zones par maille (cc × cr mailles) : nettoyage et tracé de lignes.
// Ne touche jamais à la géométrie : seulement à la couleur des triangles.

// Filtre majoritaire 3×3 : une maille prend la classe majoritaire (stricte) de son voisinage.
// Efface le « bruit » d'une maille ou deux sans déplacer les grandes limites.
export function majorityFilter(src, w, h) {
  const out = new Uint8Array(src);
  const counts = new Uint16Array(256);
  const seen = [];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let n = 0;
      seen.length = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= h) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= w) continue;
          const v = src[jj * w + ii];
          if (!counts[v]) seen.push(v);
          counts[v]++;
          n++;
        }
      }
      let best = src[j * w + i], bc = 0;
      for (const v of seen) {
        if (counts[v] > bc) { bc = counts[v]; best = v; }
        counts[v] = 0;
      }
      if (bc * 2 > n) out[j * w + i] = best;
    }
  return out;
}

// Fusionne chaque îlot (zone connexe en 4-voisinage) de moins de minCells mailles dans la
// classe la plus présente sur son pourtour. Modifie arr sur place.
// keep(v) : classes jamais fondues (traits fins : traces, rivières) et jamais choisies comme
// destination, pour qu'un trait ne s'élargisse pas en avalant ses voisins.
export function removeSmallRegions(arr, w, h, minCells, keep = () => false) {
  if (minCells <= 1) return arr;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const cls = arr[start];
    let top = 0, size = 0;
    stack[top++] = start;
    seen[start] = 1;
    const around = new Map();
    while (top) {
      const c = stack[--top];
      members[size++] = c;
      const i = c % w, j = (c - i) / w;
      const nb = [i > 0 ? c - 1 : -1, i < w - 1 ? c + 1 : -1, j > 0 ? c - w : -1, j < h - 1 ? c + w : -1];
      for (const d of nb) {
        if (d < 0) continue;
        if (arr[d] === cls) {
          if (!seen[d]) { seen[d] = 1; stack[top++] = d; }
        } else if (!keep(arr[d])) around.set(arr[d], (around.get(arr[d]) || 0) + 1);
      }
    }
    if (size >= minCells || !around.size || keep(cls)) continue;
    let best = cls, bc = 0;
    for (const [v, k] of around) if (k > bc) { bc = k; best = v; }
    for (let m = 0; m < size; m++) arr[members[m]] = best;
  }
  return arr;
}

// Marque les mailles dont le centre est à moins de `half` (mm) d'une polyligne (en mm).
// La demi-largeur est portée à 0,71 maille au minimum : toute maille traversée par la ligne
// est alors marquée, et le tracé reste continu même en diagonale.
export function stampCells(pts, half, cols, rows, cell, mark) {
  const cc = cols - 1, cr = rows - 1;
  const r = Math.max(half, cell * 0.71);
  const ox = (cols - 1) / 2, oy = (rows - 1) / 2;
  for (let p = 1; p < pts.length; p++) {
    const [ax, ay] = pts[p - 1], [bx, by] = pts[p];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cell + ox - 0.5));
    const i1 = Math.min(cc - 1, Math.ceil((Math.max(ax, bx) + r) / cell + ox - 0.5));
    const j0 = Math.max(0, Math.floor(oy - (Math.max(ay, by) + r) / cell - 0.5));
    const j1 = Math.min(cr - 1, Math.ceil(oy - (Math.min(ay, by) - r) / cell - 0.5));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const py = (oy - j - 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5 - ox) * cell;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        if (Math.hypot(px - ax - t * dx, py - ay - t * dy) <= r) mark(j * cc + i);
      }
    }
  }
}
