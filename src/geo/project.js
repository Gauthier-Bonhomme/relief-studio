// Projection locale équirectangulaire centrée sur le cadre : x/y en mètres.
// Suffisante pour une carte artistique, y compris à l'échelle d'un pays.
const R = 6371008.8;
const D2R = Math.PI / 180;

export function wrapLon(d) {
  return ((d + 540) % 360) - 180;
}

export function makeProjection(lon0, lat0) {
  const k = Math.cos(lat0 * D2R);
  return {
    lon0,
    lat0,
    forward(lon, lat) {
      return [wrapLon(lon - lon0) * D2R * R * k, (lat - lat0) * D2R * R];
    },
    inverse(x, y) {
      return [wrapLon(lon0 + x / (D2R * R * k)), lat0 + y / (D2R * R)];
    },
  };
}

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Boîte englobante en lon/lat, robuste à l'antiméridien (Russie, Fidji…).
export function lonLatBounds(points) {
  let minLat = Infinity, maxLat = -Infinity;
  const lons = [];
  for (const [lon, lat] of points) {
    lons.push(lon);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  let minLon = Math.min(...lons), maxLon = Math.max(...lons);
  if (maxLon - minLon > 180) {
    const shifted = lons.map((l) => (l < 0 ? l + 360 : l));
    const a = Math.min(...shifted), b = Math.max(...shifted);
    if (b - a < maxLon - minLon) {
      minLon = a;
      maxLon = b;
    }
  }
  return { west: minLon, east: maxLon, south: minLat, north: maxLat };
}

// Cadre = centre + dimensions en mètres dans la projection locale du centre.
export function frameFromBounds(b, margin = 1.1) {
  const lon0 = wrapLon((b.west + b.east) / 2);
  const lat0 = (b.south + b.north) / 2;
  const p = makeProjection(lon0, lat0);
  const [x0] = p.forward(b.west, lat0);
  const [x1] = p.forward(b.east, lat0);
  const [, y0] = p.forward(lon0, b.south);
  const [, y1] = p.forward(lon0, b.north);
  return {
    center: [lon0, lat0],
    widthM: Math.max(200, Math.abs(x1 - x0) * margin),
    heightM: Math.max(200, Math.abs(y1 - y0) * margin),
  };
}

// Agrandit un cadre pour qu'il respecte un rapport largeur/hauteur donné.
export function fitAspect(frame, aspect) {
  let { widthM, heightM } = frame;
  if (widthM / heightM > aspect) heightM = widthM / aspect;
  else widthM = heightM * aspect;
  return { ...frame, widthM, heightM };
}

export function frameCorners(frame) {
  const p = makeProjection(frame.center[0], frame.center[1]);
  const w = frame.widthM / 2, h = frame.heightM / 2;
  return [p.inverse(-w, h), p.inverse(w, h), p.inverse(w, -h), p.inverse(-w, -h)];
}
