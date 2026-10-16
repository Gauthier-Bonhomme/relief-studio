import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFilaments } from '../src/model/bambu.js';

// Profil miniature reprenant les formes rencontrées dans de vrais projets Bambu Studio.
const profile = (m, variants = 1) => ({
  version: '02.05.00.66',
  printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
  filament_colour: Array(m).fill('#00AE42'),
  filament_settings_id: Array(m).fill('Bambu PLA Basic @BBL A1'),
  filament_flow_ratio: Array(m * variants).fill('0.98'),
  nozzle_temperature: Array(m * variants).fill('220'),
  default_filament_colour: Array(m).fill(''),
  machine_max_speed_x: ['500', '200'], // modes normal / silencieux : ne pas toucher
  nozzle_diameter: ['0.4'], // par extrudeur : ne pas toucher
  inherits_group: ['0.20mm Standard @BBL A1', ...Array(m).fill('Bambu PLA Basic @BBL A1'), 'Bambu Lab A1 0.4 nozzle'],
  flush_volumes_matrix: Array(m * m).fill('300'),
  flush_volumes_vector: Array(2 * m).fill('140'),
});

test('profil à 2 filaments → 5 filaments, réglages d\'imprimante intacts', () => {
  const colors = ['#f3f1ea', '#2e6b3a', '#8f8f8f', '#2f74c0', '#d62828'];
  const cfg = withFilaments(profile(2), colors);
  assert.deepEqual(cfg.filament_colour, colors.map((c) => c.toUpperCase()));
  assert.equal(cfg.filament_settings_id.length, 5);
  assert.equal(cfg.nozzle_temperature.length, 5);
  assert.deepEqual(cfg.machine_max_speed_x, ['500', '200']);
  assert.deepEqual(cfg.nozzle_diameter, ['0.4']);
  assert.equal(cfg.inherits_group.length, 7);
  assert.equal(cfg.inherits_group[0], '0.20mm Standard @BBL A1');
  assert.equal(cfg.inherits_group[6], 'Bambu Lab A1 0.4 nozzle');
  assert.equal(cfg.flush_volumes_matrix.length, 25);
  assert.equal(cfg.flush_volumes_matrix[0], '0'); // diagonale
  assert.equal(cfg.flush_volumes_matrix[1], '300');
  assert.equal(cfg.flush_volumes_vector.length, 10);
});

test('réglages à variantes (Bambu 2.x) : un bloc par filament', () => {
  const cfg = withFilaments(profile(4, 2), ['#111111', '#222222', '#333333']);
  assert.equal(cfg.filament_flow_ratio.length, 6);
  assert.equal(cfg.filament_colour.length, 3);
});

test('le profil d\'origine n\'est pas modifié', () => {
  const p = profile(1);
  withFilaments(p, ['#111111', '#222222']);
  assert.equal(p.filament_colour.length, 1);
});
