// Réseau hydrographique déduit du relief : comblement des cuvettes (priority-flood,
// Barnes 2014), écoulement D8, puis accumulation amont → aval.

class MinHeap {
  constructor(n) {
    this.idx = new Int32Array(n);
    this.key = new Float64Array(n);
    this.size = 0;
  }
  push(i, k) {
    let p = this.size++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q];
      this.key[p] = this.key[q];
      p = q;
    }
    this.idx[p] = i;
    this.key[p] = k;
  }
  pop() {
    const top = this.idx[0];
    const i = this.idx[--this.size], k = this.key[this.size];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= k) break;
      this.idx[p] = this.idx[c];
      this.key[p] = this.key[c];
      p = c;
    }
    this.idx[p] = i;
    this.key[p] = k;
    return top;
  }
}

const DI = [-1, 0, 1, -1, 1, -1, 0, 1];
const DJ = [-1, -1, -1, 0, 0, 1, 1, 1];

export function flowAccumulation(data, cols, rows) {
  const n = cols * rows;
  const filled = Float64Array.from(data);
  const closed = new Uint8Array(n);
  const order = new Int32Array(n);
  const heap = new MinHeap(n);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) {
        const k = j * cols + i;
        closed[k] = 1;
        heap.push(k, filled[k]);
      }
  let o = 0;
  while (heap.size) {
    const k = heap.pop();
    order[o++] = k;
    const i = k % cols, j = (k - i) / cols;
    for (let d = 0; d < 8; d++) {
      const ii = i + DI[d], jj = j + DJ[d];
      if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
      const kk = jj * cols + ii;
      if (closed[kk]) continue;
      closed[kk] = 1;
      if (filled[kk] <= filled[k]) filled[kk] = filled[k] + 1e-4;
      heap.push(kk, filled[kk]);
    }
  }
  // Récepteur = voisin de plus forte pente descendante.
  const rec = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const i = k % cols, j = (k - i) / cols;
    let best = 0;
    for (let d = 0; d < 8; d++) {
      const ii = i + DI[d], jj = j + DJ[d];
      if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
      const kk = jj * cols + ii;
      const s = (filled[k] - filled[kk]) / (d === 1 || d === 3 || d === 4 || d === 6 ? 1 : Math.SQRT2);
      if (s > best) { best = s; rec[k] = kk; }
    }
  }
  const acc = new Float32Array(n).fill(1);
  for (let t = n - 1; t >= 0; t--) {
    const k = order[t];
    if (rec[k] >= 0) acc[rec[k]] += acc[k];
  }
  return { acc, rec };
}

// Polylignes de rivières : on suit chaque cours d'eau depuis sa source jusqu'à la
// confluence, en coupant quand la classe d'épaisseur change.
export function riverPolylines({ acc, rec }, cols, rows, threshold, widthOf, keep) {
  const n = cols * rows;
  const hasDonor = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (acc[k] >= threshold && rec[k] >= 0 && keep(k)) hasDonor[rec[k]] = 1;
  const visited = new Uint8Array(n);
  const lines = [];
  for (let k = 0; k < n; k++) {
    if (acc[k] < threshold || hasDonor[k] || !keep(k)) continue;
    let cur = k;
    let line = { w: widthOf(acc[cur]), pts: [cur] };
    visited[cur] = 1;
    for (;;) {
      const nx = rec[cur];
      if (nx < 0 || !keep(nx)) break;
      const w = widthOf(acc[nx]);
      if (w !== line.w) {
        line.pts.push(nx);
        lines.push(line);
        line = { w, pts: [nx] };
      } else line.pts.push(nx);
      if (visited[nx]) break;
      visited[nx] = 1;
      cur = nx;
    }
    if (line.pts.length > 1) lines.push(line);
  }
  return lines;
}
