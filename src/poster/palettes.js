// Palettes : fond, encre, accent (trace), eau, couleur claire des courbes maîtresses (hi)
// et rampe d'altitude (bas → haut).
// Fonds sombres d'abord, puis fonds clairs. Sur fond clair, `hi` (maîtresses) est plus
// foncé que l'encre ; sur fond sombre, plus clair.
export const PALETTES = {
  // Fonds sombres
  marine: { bg: '#0b1729', ink: '#6f9cc2', hi: '#cfe0f0', accent: '#ff6a33', water: '#13253d', ramp: ['#102037', '#24405f', '#5f88ad', '#cfe0f0'] },
  nuit: { bg: '#10161f', ink: '#ebe5d6', hi: '#ffffff', accent: '#f0b23e', water: '#0a0f16', ramp: ['#18212d', '#2f4053', '#71828f', '#ebe5d6'] },
  foret: { bg: '#0f231a', ink: '#6fa48a', hi: '#d5ecdc', accent: '#f2a541', water: '#0b1b14', ramp: ['#14301f', '#2c5a42', '#6fa48a', '#d5ecdc'] },
  ocean: { bg: '#062a33', ink: '#4fa3a8', hi: '#cbefee', accent: '#ffb347', water: '#04202a', ramp: ['#0a3540', '#1d6168', '#4fa3a8', '#cbefee'] },
  minuit: { bg: '#161229', ink: '#8c84c9', hi: '#e0dcf7', accent: '#ff7a9a', water: '#100d1f', ramp: ['#1e1838', '#3d3570', '#8c84c9', '#e0dcf7'] },
  bordeaux: { bg: '#2a0f17', ink: '#c4848f', hi: '#f5dade', accent: '#f6c453', water: '#200a11', ramp: ['#37141e', '#6e3341', '#c4848f', '#f5dade'] },
  ardoise: { bg: '#1f2428', ink: '#9aa7b0', hi: '#eef2f4', accent: '#4fc3f7', water: '#181c1f', ramp: ['#272d32', '#4b555c', '#9aa7b0', '#eef2f4'] },
  olive: { bg: '#2b2e1c', ink: '#a8ad78', hi: '#eceed3', accent: '#e07a3f', water: '#212315', ramp: ['#353923', '#5c6140', '#a8ad78', '#eceed3'] },
  cuivre: { bg: '#141414', ink: '#b87333', hi: '#f3c891', accent: '#e9e9e9', water: '#0d0d0d', ramp: ['#1e1a17', '#5a3a1e', '#b87333', '#f3c891'] },
  // Fonds clairs
  papier: { bg: '#f2ede3', ink: '#23211e', hi: '#23211e', accent: '#c4471d', water: '#d3dcd9', ramp: ['#ebe3d3', '#c9b893', '#8b7b5c', '#3c352b'] },
  encre: { bg: '#ffffff', ink: '#121212', hi: '#121212', accent: '#e03c31', water: '#e6e6e6', ramp: ['#f3f3f3', '#c2c2c2', '#6d6d6d', '#121212'] },
  craie: { bg: '#fbfbf7', ink: '#4a76a0', hi: '#12304d', accent: '#e4572e', water: '#e3ecf2', ramp: ['#eef2f4', '#b4c9db', '#4a76a0', '#12304d'] },
  glacier: { bg: '#eef3f6', ink: '#1c3550', hi: '#1c3550', accent: '#d24b4b', water: '#d4e2ec', ramp: ['#e3edf3', '#a3bfd2', '#557d9b', '#1c3550'] },
  sauge: { bg: '#e6ebe1', ink: '#2c392d', hi: '#2c392d', accent: '#b5562b', water: '#cdd9d6', ramp: ['#dde4d4', '#a8b898', '#5e7155', '#2c392d'] },
  lin: { bg: '#efe9dc', ink: '#7c8c6c', hi: '#33402b', accent: '#c4471d', water: '#dbe2dc', ramp: ['#e6e0cf', '#b9bf9e', '#7c8c6c', '#33402b'] },
  desert: { bg: '#f4e6d4', ink: '#5a2e1b', hi: '#5a2e1b', accent: '#2f6f73', water: '#c9dcd8', ramp: ['#f1dcc1', '#dba67b', '#ad613b', '#5a2e1b'] },
  terracotta: { bg: '#f3e7da', ink: '#bf6a4b', hi: '#6e2a17', accent: '#1f5f74', water: '#dce4e2', ramp: ['#efdccb', '#dda283', '#bf6a4b', '#6e2a17'] },
  rose: { bg: '#f7e8e6', ink: '#b07080', hi: '#5a2433', accent: '#2f6f73', water: '#e3e3e6', ramp: ['#f0dad8', '#d9a6b0', '#b07080', '#5a2433'] },
  sable: { bg: '#e9dfcc', ink: '#5b5650', hi: '#141414', accent: '#b23a48', water: '#d6d8d2', ramp: ['#e0d4bd', '#a9a08f', '#5b5650', '#141414'] },
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
