// Maillage imprimable (fermé, orienté) d'un champ de hauteurs découpé selon une forme.
//
// Grille : point (i, j) en x = (i - (cols-1)/2)·cell, y = ((rows-1)/2 - j)·cell (mm).
// Forme  : anneaux de polygones (règle pair-impair) ∩ rectangle de découpe.
// Le contour est calculé exactement sur chaque arête de maille (lignes de balayage),
// puis chaque maille est triangulée façon « marching squares ». Les sommets de
// contour sont partagés entre mailles voisines : le résultat est étanche.

export function gridX(i, cols, cell) {
  return (i - (cols - 1) / 2) * cell;
}
export function gridY(j, rows, cell) {
  return ((rows - 1) / 2 - j) * cell;
}

// Intersections des anneaux avec chaque ligne et chaque colonne de la grille.
function scanlines(cols, rows, cell, polygons) {
  const rowX = Array.from({ length: rows }, () => []);
  const colY = Array.from({ length: cols }, () => []);
  const cj = (rows - 1) / 2, ci = (cols - 1) / 2;
  for (const ring of polygons) {
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const a = ring[k], b = ring[(k + 1) % n];
      if (a[1] !== b[1]) {
        const jA = Math.ceil(cj - Math.max(a[1], b[1]) / cell);
        const jB = Math.floor(cj - Math.min(a[1], b[1]) / cell);
        for (let j = Math.max(0, jA); j <= Math.min(rows - 1, jB); j++) {
          const y = (cj - j) * cell;
          if (a[1] > y !== b[1] > y) rowX[j].push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
      if (a[0] !== b[0]) {
        const iA = Math.ceil(ci + Math.min(a[0], b[0]) / cell);
        const iB = Math.floor(ci + Math.max(a[0], b[0]) / cell);
        for (let i = Math.max(0, iA); i <= Math.min(cols - 1, iB); i++) {
          const x = (i - ci) * cell;
          if (a[0] > x !== b[0] > x) colY[i].push(a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
        }
      }
    }
  }
  const sort = (arr) => Float64Array.from(arr).sort();
  return { rowX: rowX.map(sort), colY: colY.map(sort) };
}

// Premier index tel que arr[k] > v.
function upper(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] > v) hi = m;
    else lo = m + 1;
  }
  return lo;
}

// Masque intérieur/extérieur aux points de grille (utilisé aussi par les posters).
export function rasterMask(cols, rows, cell, polygons, rect) {
  const inside = new Uint8Array(cols * rows);
  const scan = polygons ? scanlines(cols, rows, cell, polygons) : null;
  for (let j = 0; j < rows; j++) {
    const y = gridY(j, rows, cell);
    const xs = scan?.rowX[j];
    let p = 0, parity = 0;
    for (let i = 0; i < cols; i++) {
      const x = gridX(i, cols, cell);
      if (xs) while (p < xs.length && xs[p] < x) { parity ^= 1; p++; }
      const inPoly = xs ? parity : 1;
      const inRect = !rect || (x > rect[0] && x < rect[2] && y > rect[1] && y < rect[3]);
      inside[j * cols + i] = inPoly && inRect ? 1 : 0;
    }
  }
  return { inside, scan };
}

export function buildMesh({ cols, rows, cell, z, polygons = null, clip = null }) {
  const X = (i) => gridX(i, cols, cell);
  const Y = (j) => gridY(j, rows, cell);
  // Rectangle utile : la grille moins une demi-maille, pour que le bord soit toujours fermé.
  let rect = [X(0) + cell / 2, Y(rows - 1) + cell / 2, X(cols - 1) - cell / 2, Y(0) - cell / 2];
  if (clip) rect = [Math.max(rect[0], clip[0]), Math.max(rect[1], clip[1]), Math.min(rect[2], clip[2]), Math.min(rect[3], clip[3])];
  const { inside, scan } = rasterMask(cols, rows, cell, polygons, rect);
  const [rx0, ry0, rx1, ry1] = rect;

  const pos = [];
  const idx = [];
  const top = new Int32Array(cols * rows).fill(-1);
  const bot = new Int32Array(cols * rows).fill(-1);
  const hEdge = new Int32Array(cols * rows).fill(-1); // (i,j)→(i+1,j)
  const vEdge = new Int32Array(cols * rows).fill(-1); // (i,j)→(i,j+1)

  const kind = []; // pour un sommet de contour : 1 = sur x = cste du rectangle, 2 = sur y = cste
  const vert = (x, y, zz) => {
    pos.push(x, y, zz);
    return pos.length / 3 - 1;
  };
  const corner = (i, j, bottom) => {
    const k = j * cols + i;
    const m = bottom ? bot : top;
    if (m[k] < 0) m[k] = vert(X(i), Y(j), bottom ? 0 : z[k]);
    return m[k];
  };

  // Arête horizontale (i,j)–(i+1,j) : position du contour, en partant de l'extrémité intérieure.
  const hCross = (i, j) => {
    const k = j * cols + i;
    if (hEdge[k] >= 0) return hEdge[k];
    const xa = X(i), xb = X(i + 1), y = Y(j);
    const aIn = inside[k] === 1;
    let x = aIn ? xb : xa, onRect = 0;
    const xs = scan?.rowX[j];
    if (aIn) {
      if (rx1 >= xa && rx1 < x) { x = rx1; onRect = 1; }
      if (xs) { const p = upper(xs, xa); if (p < xs.length && xs[p] < x) { x = xs[p]; onRect = 0; } }
    } else {
      if (rx0 <= xb && rx0 > x) { x = rx0; onRect = 1; }
      if (xs) { const p = upper(xs, xb) - 1; if (p >= 0 && xs[p] > x) { x = xs[p]; onRect = 0; } }
    }
    const t = (x - xa) / (xb - xa);
    const zz = z[k] + t * (z[k + 1] - z[k]);
    hEdge[k] = vert(x, y, zz);
    vert(x, y, 0);
    kind[hEdge[k]] = onRect;
    return hEdge[k];
  };
  // Arête verticale (i,j)–(i,j+1), y décroissant.
  const vCross = (i, j) => {
    const k = j * cols + i;
    if (vEdge[k] >= 0) return vEdge[k];
    const ya = Y(j), yb = Y(j + 1), x = X(i);
    const aIn = inside[k] === 1;
    let y = aIn ? yb : ya, onRect = 0;
    const ys = scan?.colY[i];
    if (aIn) {
      if (ry0 <= ya && ry0 > y) { y = ry0; onRect = 2; }
      if (ys) { const p = upper(ys, ya) - 1; if (p >= 0 && ys[p] > y) { y = ys[p]; onRect = 0; } }
    } else {
      if (ry1 >= yb && ry1 < y) { y = ry1; onRect = 2; }
      if (ys) { const p = upper(ys, yb); if (p < ys.length && ys[p] < y) { y = ys[p]; onRect = 0; } }
    }
    const t = (ya - y) / (ya - yb);
    const zz = z[k] + t * (z[k + cols] - z[k]);
    vEdge[k] = vert(x, y, zz);
    vert(x, y, 0);
    kind[vEdge[k]] = onRect;
    return vEdge[k];
  };

  const topTris = [];
  const restTris = [];
  const items = new Array(8);
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const kA = j * cols + i;
      const inA = inside[kA], inB = inside[kA + cols], inC = inside[kA + cols + 1], inD = inside[kA + 1];
      const count = inA + inB + inC + inD;
      if (count === 0) continue;
      if (count === 4) {
        const a = corner(i, j), b = corner(i, j + 1), c = corner(i + 1, j + 1), d = corner(i + 1, j);
        topTris.push(a, b, c, a, c, d);
        const a2 = corner(i, j, 1), b2 = corner(i, j + 1, 1), c2 = corner(i + 1, j + 1, 1), d2 = corner(i + 1, j, 1);
        restTris.push(a2, c2, b2, a2, d2, c2);
        continue;
      }
      // Parcours anti-horaire (vu de dessus) : A haut-gauche, B bas-gauche, C bas-droite, D haut-droite.
      let n = 0;
      const push = (type, inFlag, ci, cj) => { items[n++] = { type, inFlag, ci, cj }; };
      push('c', inA, i, j);
      if (inA !== inB) push('x', 0, 'v', [i, j]);
      push('c', inB, i, j + 1);
      if (inB !== inC) push('x', 0, 'h', [i, j + 1]);
      push('c', inC, i + 1, j + 1);
      if (inC !== inD) push('x', 0, 'v', [i + 1, j]);
      push('c', inD, i + 1, j);
      if (inD !== inA) push('x', 0, 'h', [i, j]);
      const crossIdx = (it) => (it.ci === 'v' ? vCross(it.cj[0], it.cj[1]) : hCross(it.cj[0], it.cj[1]));

      // Morceaux : entrée (croisement suivi d'un coin intérieur) → coins → sortie.
      for (let s = 0; s < n; s++) {
        const it = items[s];
        const next = items[(s + 1) % n];
        if (it.type !== 'x' || next.type !== 'c' || !next.inFlag) continue;
        const piece = [crossIdx(it)];
        let t = (s + 1) % n;
        while (items[t].type === 'c') {
          piece.push(corner(items[t].ci, items[t].cj));
          t = (t + 1) % n;
        }
        const out = crossIdx(items[t]);
        piece.push(out);
        // Coin du rectangle de découpe dans la maille : on le rajoute pour garder un angle vif.
        let cornerV = -1;
        const kIn = kind[piece[0]], kOut = kind[out];
        if (kIn && kOut && kIn !== kOut) {
          const cx = pos[3 * (kOut === 1 ? out : piece[0])];
          const cy = pos[3 * (kOut === 2 ? out : piece[0]) + 1];
          const fx = (cx - X(i)) / cell, fy = (Y(j) - cy) / cell;
          const zz =
            z[kA] * (1 - fx) * (1 - fy) + z[kA + 1] * fx * (1 - fy) +
            z[kA + cols] * (1 - fx) * fy + z[kA + cols + 1] * fx * fy;
          cornerV = vert(cx, cy, zz);
          vert(cx, cy, 0);
          piece.push(cornerV);
        }
        for (let q = 1; q < piece.length - 1; q++) topTris.push(piece[0], piece[q], piece[q + 1]);
        const bottom = piece.map((v) => v + 1);
        let qi = 1;
        for (let t2 = (s + 1) % n; items[t2].type === 'c'; t2 = (t2 + 1) % n) bottom[qi++] = corner(items[t2].ci, items[t2].cj, 1);
        for (let q = 1; q < bottom.length - 1; q++) restTris.push(bottom[0], bottom[q + 1], bottom[q]);
        // Paroi : du point de sortie vers le point d'entrée (intérieur à gauche).
        const wall = cornerV >= 0 ? [out, cornerV, piece[0]] : [out, piece[0]];
        for (let w = 0; w < wall.length - 1; w++) {
          const aT = wall[w], bT = wall[w + 1];
          restTris.push(aT, aT + 1, bT + 1, aT, bT + 1, bT);
        }
      }
    }
  }
  return {
    positions: Float32Array.from(pos),
    indices: Uint32Array.from(topTris.concat(restTris)),
    topCount: topTris.length / 3,
  };
}

// Contrôle d'étanchéité : chaque arête orientée doit apparaître exactement une fois
// et son opposée aussi. Renvoie aussi le volume (mm³), positif si bien orienté.
export function checkMesh({ positions, indices }) {
  const edges = new Map();
  let bad = 0;
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e], b = indices[t + ((e + 1) % 3)];
      const key = a * 4294967296 + b;
      if (edges.has(key)) bad++;
      edges.set(key, 1);
    }
  }
  let open = 0;
  for (const key of edges.keys()) {
    const a = Math.floor(key / 4294967296), b = key % 4294967296;
    if (!edges.has(b * 4294967296 + a)) open++;
  }
  let vol = 0;
  const P = positions;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    vol +=
      (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
        P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
        P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return { duplicated: bad, open, volume: vol, triangles: indices.length / 3 };
}
