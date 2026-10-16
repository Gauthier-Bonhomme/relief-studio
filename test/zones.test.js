import { test } from 'node:test';
import assert from 'node:assert/strict';
import { majorityFilter, removeSmallRegions, stampCells } from '../src/model/zones.js';

test('le filtre majoritaire efface une maille isolée', () => {
  const w = 5, h = 5;
  const a = new Uint8Array(w * h).fill(1);
  a[12] = 3;
  assert.equal(majorityFilter(a, w, h)[12], 1);
});

test('les îlots trop petits rejoignent la zone qui les entoure, les grands restent', () => {
  const w = 20, h = 20;
  const a = new Uint8Array(w * h).fill(1);
  for (const c of [44, 45, 64]) a[c] = 5; // îlot de 3 mailles
  for (let j = 10; j < 18; j++) for (let i = 10; i < 18; i++) a[j * w + i] = 7; // zone de 64 mailles
  removeSmallRegions(a, w, h, 10);
  assert.equal(a[44], 1);
  assert.equal(a[64], 1);
  assert.equal(a[12 * w + 12], 7);
});

test('une ligne en diagonale reste continue, même plus fine qu\'une maille', () => {
  const cols = 41, rows = 41, cell = 1, cc = cols - 1;
  const marked = new Set();
  stampCells([[-15, -15], [15, 15]], 0.1, cols, rows, cell, (c) => marked.add(c));
  // Chaque maille marquée a une voisine marquée (8-connexité), sauf aux extrémités.
  let isolated = 0;
  for (const c of marked) {
    const i = c % cc, j = (c - i) / cc;
    let nb = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && marked.has((j + dj) * cc + i + di)) nb++;
    if (!nb) isolated++;
  }
  assert.equal(isolated, 0);
  assert.ok(marked.size >= 30);
});
