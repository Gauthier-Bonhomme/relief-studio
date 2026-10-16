// Polices embarquées dans les SVG exportés (sinon le PNG/PDF retomberait sur une police système).
import fraunces600 from '@fontsource/fraunces/files/fraunces-latin-600-normal.woff2?url';
import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2?url';

const FACES = [
  ['Fraunces', 600, fraunces600],
  ['Inter', 400, inter400],
  ['Inter', 500, inter500],
];

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

let css;
export function exportFontCss() {
  css ??= Promise.all(
    FACES.map(async ([family, weight, url]) => {
      const buf = await (await fetch(url)).arrayBuffer();
      return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${toBase64(buf)}) format('woff2');}`;
    }),
  ).then((faces) => faces.join(''));
  return css;
}
