// Couleurs d'impression : chaque triangle du dessus reçoit un code de zone, chaque zone
// une couleur, et les couleurs identiques partagent le même filament.
import { CLASSES, C } from '../geo/landcover.js';
import { hexToRgb, rgbToHex, mix } from '../poster/palettes.js';
import { CODE_PLATE, CODE_TEXT } from './plaque.js';

export const LAND = CLASSES.slice(1); // forest … water
export const CODE_TRACK = 8; // traces : 8 + numéro de trace
export const MAX_TRACKS = 24;
export const CODE_BAND = CODE_TRACK + MAX_TRACKS; // paliers d'altitude : CODE_BAND + n

export const DEFAULT_PRINT_COLORS = {
  base: '#f3f1ea', terrain: '#a9c47f',
  forest: '#2e6b3a', meadow: '#a9c47f', crop: '#d9c27c', built: '#7c7c7c',
  rock: '#8f8f8f', snow: '#ffffff', water: '#2f74c0', track: '#d62828',
  low: '#2e6b3a', high: '#f3f1ea', text: '#2b2b2b',
};
export const DEFAULT_CLASS_ON = { forest: true, meadow: true, crop: false, built: false, rock: true, snow: true, water: true };

// Couleur d'un code de zone selon les réglages du modèle. trackColors : couleur choisie
// pour chaque trace (null = couleur de trace par défaut).
export function colorOfCode(model, code, trackColors = []) {
  const col = { ...DEFAULT_PRINT_COLORS, ...model.printColors };
  if (code === CODE_PLATE) return col.base;
  if (code === CODE_TEXT) return col.text;
  if (code >= CODE_TRACK && code < CODE_BAND) return trackColors[code - CODE_TRACK] || col.track;
  if (code >= CODE_BAND) {
    const n = Math.max(2, model.bands);
    return rgbToHex(mix(hexToRgb(col.low), hexToRgb(col.high), (code - CODE_BAND) / (n - 1)));
  }
  const name = CLASSES[code];
  if (model.colorMode === 'landcover' && name !== 'none' && (model.classOn?.[name] ?? DEFAULT_CLASS_ON[name])) return col[name];
  return col.terrain;
}

// Filaments : le socle d'abord (filament 1, appliqué aux flancs et au dessous),
// puis chaque couleur distincte des zones présentes.
export function resolveFilaments(model, codes, trackColors = []) {
  const base = ({ ...DEFAULT_PRINT_COLORS, ...model.printColors }).base.toLowerCase();
  const filaments = [base];
  const byCode = new Map();
  for (const code of [...codes].sort((a, b) => a - b)) {
    const hex = colorOfCode(model, code, trackColors).toLowerCase();
    let f = filaments.indexOf(hex);
    if (f < 0) f = filaments.push(hex) - 1;
    byCode.set(code, f + 1); // numéros de filament à partir de 1
  }
  return { filaments, filamentOf: (code) => byCode.get(code) ?? 1 };
}

// Codage « peinture multi-matériaux » des trancheurs (TriangleSelector de PrusaSlicer,
// repris par Bambu Studio / OrcaSlicer) pour un triangle non subdivisé.
export function paintCode(extruder) {
  if (extruder <= 0) return '';
  if (extruder === 1) return '4';
  if (extruder === 2) return '8';
  return `${(extruder - 3).toString(16).toUpperCase()}C`;
}

export { C };
