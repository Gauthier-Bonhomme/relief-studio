import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, checkMesh } from '../src/model/mesh.js';

function field(cols, rows, f) {
  const z = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) z[j * cols + i] = f(i, j);
  return z;
}
const circle = (r, n = 96, cx = 0, cy = 0) =>
  Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);

function assertSolid(mesh, label) {
  const c = checkMesh(mesh);
  assert.equal(c.duplicated, 0, `${label} : arêtes dupliquées`);
  assert.equal(c.open, 0, `${label} : arêtes ouvertes`);
  assert.ok(c.volume > 0, `${label} : volume ${c.volume}`);
  return c;
}

test('rectangle plein : étanche, volume ≈ surface × hauteur', () => {
  const cols = 60, rows = 40, cell = 1;
  const m = buildMesh({ cols, rows, cell, z: field(cols, rows, () => 5) });
  const c = assertSolid(m, 'rectangle');
  // Rectangle utile = (cols-2)·cell × (rows-2)·cell.
  assert.ok(Math.abs(c.volume - 58 * 38 * 5) < 1e-3, `volume ${c.volume}`);
});

test('disque sur relief : étanche, volume proche de πr²h', () => {
  const cols = 121, rows = 121, cell = 1;
  const m = buildMesh({ cols, rows, cell, z: field(cols, rows, () => 4), polygons: [circle(50)] });
  const c = assertSolid(m, 'disque');
  const expected = Math.PI * 50 * 50 * 4;
  assert.ok(Math.abs(c.volume - expected) / expected < 0.01, `volume ${c.volume} vs ${expected}`);
  const m2 = buildMesh({ cols, rows, cell, z: field(cols, rows, (i, j) => 3 + Math.sin(i / 5) * Math.cos(j / 7) * 2 + 2), polygons: [circle(50)] });
  assertSolid(m2, 'disque relief');
});

test('formes difficiles : trou, îles, cols, damier diagonal', () => {
  const cols = 101, rows = 81, cell = 0.7;
  const z = field(cols, rows, (i, j) => 2 + ((i * 7 + j * 13) % 11) / 3);
  const rings = [circle(25, 64), circle(10, 40), circle(4, 20, 30, 10), circle(2.2, 12, -30, -15)];
  // Losanges qui se touchent presque par la pointe → cas « col » du marching squares.
  for (let k = 0; k < 6; k++) {
    const cx = -32 + k * 2.9, cy = 22;
    rings.push([[cx - 1.45, cy], [cx, cy + 1.45], [cx + 1.45, cy], [cx, cy - 1.45]]);
  }
  assertSolid(buildMesh({ cols, rows, cell, z, polygons: rings }), 'formes');
});

test('polygone qui déborde du domaine + découpe en tuiles', () => {
  const cols = 80, rows = 60, cell = 1;
  const z = field(cols, rows, (i, j) => 3 + (i % 5) * 0.3 + (j % 3) * 0.2);
  const big = [[[-100, -10], [100, -12], [90, 80], [-95, 70]]];
  assertSolid(buildMesh({ cols, rows, cell, z, polygons: big }), 'débordant');
  // Les découpes de tuiles passent entre deux points de grille (demi-maille).
  let total = 0;
  for (const clip of [[-1e9, -1e9, 0, 1e9], [0, -1e9, 1e9, 10], [0, 10, 1e9, 1e9]]) {
    total += assertSolid(buildMesh({ cols, rows, cell, z, polygons: [circle(25)], clip }), `tuile ${clip}`).volume;
  }
  const whole = checkMesh(buildMesh({ cols, rows, cell, z, polygons: [circle(25)] })).volume;
  assert.ok(Math.abs(total - whole) / whole < 2e-3, `tuiles ${total} vs entier ${whole}`);
});
