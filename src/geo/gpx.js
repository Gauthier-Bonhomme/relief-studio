import { haversine } from './project.js';

// Lit une trace GPX (Strava, Garmin, AllTrails, Komoot…) : points [lon, lat, alt].
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('gpx-invalid');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('wpt')];
  const points = [];
  for (const n of nodes) {
    const lon = parseFloat(n.getAttribute('lon'));
    const lat = parseFloat(n.getAttribute('lat'));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const e = n.getElementsByTagName('ele')[0];
    const ele = e ? parseFloat(e.textContent) : NaN;
    points.push([lon, lat, Number.isFinite(ele) ? ele : null]);
  }
  if (points.length < 2) throw new Error('gpx-empty');
  const nameNode =
    doc.querySelector('trk > name') || doc.querySelector('rte > name') || doc.querySelector('metadata > name');
  return { name: nameNode?.textContent.trim() || '', points, ...trackStats(points) };
}

export function trackStats(points) {
  let distance = 0, gain = 0, maxEle = -Infinity;
  let ref = null;
  for (let k = 0; k < points.length; k++) {
    if (k) distance += haversine(points[k - 1], points[k]);
    const e = points[k][2];
    if (e == null) continue;
    if (e > maxEle) maxEle = e;
    // Hystérésis de 4 m pour ne pas compter le bruit GPS dans le dénivelé.
    if (ref == null) ref = e;
    else if (e > ref + 4) { gain += e - ref; ref = e; }
    else if (e < ref - 4) ref = e;
  }
  return { distanceM: distance, gainM: gain, maxEleM: Number.isFinite(maxEle) ? maxEle : null };
}

// Allège une trace (Douglas-Peucker en degrés, suffisant pour l'affichage et la sauvegarde).
export function simplify(points, tol = 0.00002) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = points[a], [x2, y2] = points[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    let best = -1, dmax = 0;
    for (let k = a + 1; k < b; k++) {
      // Boucle (départ = arrivée) : distance au point de départ.
      const d = len > 1e-12
        ? Math.abs(dy * points[k][0] - dx * points[k][1] + x2 * y1 - y2 * x1) / len
        : Math.hypot(points[k][0] - x1, points[k][1] - y1);
      if (d > dmax) { dmax = d; best = k; }
    }
    if (dmax > tol && best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, k) => keep[k]);
}
