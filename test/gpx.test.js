import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplify, trackStats } from '../src/geo/gpx.js';
import { lonLatBounds } from '../src/geo/project.js';

const loop = Array.from({ length: 301 }, (_, k) => {
  const a = (k / 300) * 2 * Math.PI;
  return [6.87 + 0.05 * Math.cos(a), 45.92 + 0.03 * Math.sin(a), 1500 + 500 * Math.sin(2 * a)];
});

test('une boucle (départ = arrivée) garde sa forme après simplification', () => {
  const s = simplify(loop, 0.00002);
  assert.ok(s.length > 20, `${s.length} points`);
  const b = lonLatBounds(s);
  assert.ok(b.east - b.west > 0.099 && b.north - b.south > 0.059);
});

test('distance et dénivelé d\'une boucle', () => {
  const { distanceM, gainM } = trackStats(loop);
  assert.ok(distanceM > 22000 && distanceM < 23500, `${distanceM}`);
  assert.ok(gainM > 1900 && gainM < 2100, `${gainM}`);
});

test('boîte englobante à cheval sur l\'antiméridien', () => {
  const b = lonLatBounds([[179, 60], [-179, 61]]);
  assert.equal(b.west, 179);
  assert.equal(b.east, 181);
});
