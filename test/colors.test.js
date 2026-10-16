import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paintCode, resolveFilaments, colorOfCode, CODE_TRACK, CODE_BAND } from '../src/model/colors.js';
import { C } from '../src/geo/landcover.js';

test('codes de peinture des trancheurs (triangle non subdivisé)', () => {
  assert.equal(paintCode(1), '4');
  assert.equal(paintCode(2), '8');
  assert.equal(paintCode(3), '0C');
  assert.equal(paintCode(4), '1C');
  assert.equal(paintCode(8), '5C');
});

test('le socle est le filament 1 et les couleurs identiques sont regroupées', () => {
  const model = { colorMode: 'landcover', printColors: {}, classOn: {} };
  // Par défaut : prairie = reste du terrain (même vert clair), neige = socle (même blanc).
  const { filaments, filamentOf } = resolveFilaments(model, new Set([0, C.forest, C.meadow, C.rock, C.snow, C.water, CODE_TRACK]));
  assert.equal(filaments[0], '#f3f1ea');
  assert.equal(filamentOf(C.meadow), filamentOf(0));
  assert.equal(new Set(filaments).size, filaments.length);
  assert.equal(filaments.length, 7);
  const sameSnow = resolveFilaments({ ...model, printColors: { snow: '#f3f1ea' } }, new Set([C.snow]));
  assert.equal(sameSnow.filamentOf(C.snow), 1);
});

test('une zone décochée prend la couleur du reste du terrain', () => {
  const model = { colorMode: 'landcover', printColors: { terrain: '#123456' }, classOn: { forest: false } };
  assert.equal(colorOfCode(model, C.forest), '#123456');
  assert.equal(colorOfCode({ ...model, colorMode: 'single' }, C.rock), '#123456');
});

test('paliers d\'altitude : dégradé du bas vers le haut', () => {
  const model = { colorMode: 'elevation', bands: 3, printColors: { low: '#000000', high: '#ffffff' } };
  assert.equal(colorOfCode(model, CODE_BAND), '#000000');
  assert.equal(colorOfCode(model, CODE_BAND + 2), '#ffffff');
  assert.equal(colorOfCode(model, CODE_BAND + 1), '#808080');
});
