// Palettes : fond, encre, accent (trace), eau, couleur claire des courbes maîtresses (hi)
// et rampe d'altitude (bas → haut).
export const PALETTES = {
  papier: { bg: '#f2ede3', ink: '#23211e', hi: '#23211e', accent: '#c4471d', water: '#d3dcd9', ramp: ['#ebe3d3', '#c9b893', '#8b7b5c', '#3c352b'] },
  marine: { bg: '#0b1729', ink: '#6f9cc2', hi: '#cfe0f0', accent: '#ff6a33', water: '#13253d', ramp: ['#102037', '#24405f', '#5f88ad', '#cfe0f0'] },
  nuit: { bg: '#10161f', ink: '#ebe5d6', hi: '#ffffff', accent: '#f0b23e', water: '#0a0f16', ramp: ['#18212d', '#2f4053', '#71828f', '#ebe5d6'] },
  sauge: { bg: '#e6ebe1', ink: '#2c392d', hi: '#2c392d', accent: '#b5562b', water: '#cdd9d6', ramp: ['#dde4d4', '#a8b898', '#5e7155', '#2c392d'] },
  glacier: { bg: '#eef3f6', ink: '#1c3550', hi: '#1c3550', accent: '#d24b4b', water: '#d4e2ec', ramp: ['#e3edf3', '#a3bfd2', '#557d9b', '#1c3550'] },
  desert: { bg: '#f4e6d4', ink: '#5a2e1b', hi: '#5a2e1b', accent: '#2f6f73', water: '#c9dcd8', ramp: ['#f1dcc1', '#dba67b', '#ad613b', '#5a2e1b'] },
  encre: { bg: '#ffffff', ink: '#121212', hi: '#121212', accent: '#e03c31', water: '#e6e6e6', ramp: ['#f3f3f3', '#c2c2c2', '#6d6d6d', '#121212'] },
};

export function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Rampe continue t ∈ [0, 1] → [r, g, b].
export function makeRamp(stops) {
  const rgb = stops.map(hexToRgb);
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(x));
    return mix(rgb[k], rgb[k + 1], x - k);
  };
}

// Couleurs effectives : palette + surcharges de l'utilisateur.
export function resolveColors(poster) {
  const p = PALETTES[poster.palette] || PALETTES.papier;
  const c = poster.colors || {};
  return {
    bg: c.bg || p.bg,
    ink: c.ink || p.ink,
    // Si l'encre est personnalisée sans couleur claire dédiée, les maîtresses suivent l'encre.
    hi: c.hi || (c.ink ? c.ink : p.hi),
    accent: c.accent || p.accent,
    water: p.water,
    ramp: p.ramp,
  };
}
