// Contours administratifs ouverts (Natural Earth via world-atlas/us-atlas, france-geojson).
import { feature } from 'topojson-client';

export const COLLECTIONS = {
  countries: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
    topo: 'countries',
    name: (p) => p.name,
  },
  frRegions: {
    url: 'https://cdn.jsdelivr.net/gh/gregoiredavid/france-geojson@master/regions-version-simplifiee.geojson',
    name: (p) => p.nom,
  },
  frDepartements: {
    url: 'https://cdn.jsdelivr.net/gh/gregoiredavid/france-geojson@master/departements-version-simplifiee.geojson',
    name: (p) => `${p.nom} (${p.code})`,
  },
  usStates: {
    url: 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json',
    topo: 'states',
    name: (p) => p.name,
  },
};

const cache = new Map();

export function loadCollection(id) {
  if (!cache.has(id)) {
    const c = COLLECTIONS[id];
    const p = fetch(c.url)
      .then((r) => {
        if (!r.ok) throw new Error(`${id} ${r.status}`);
        return r.json();
      })
      .then((json) => {
        const fc = c.topo ? feature(json, json.objects[c.topo]) : json;
        return fc.features
          .filter((f) => f.geometry)
          .map((f) => ({ name: c.name(f.properties), geometry: f.geometry }))
          .sort((a, b) => a.name.localeCompare(b.name));
      });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return cache.get(id);
}

// Anneaux [lon, lat] d'une géométrie Polygon / MultiPolygon.
export function geometryRings(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

// Retire les petites îles lointaines qui étirent le cadre (DOM-TOM, Aléoutiennes…) :
// on garde les polygones d'au moins 20 % de la surface du plus grand, ou proches de lui.
export function mainlandRings(geometry) {
  if (geometry.type !== 'MultiPolygon') return geometryRings(geometry);
  const polys = geometry.coordinates.map((poly) => {
    const outer = poly[0];
    let a = 0, cx = 0, cy = 0;
    for (let k = 0; k < outer.length; k++) {
      const [x1, y1] = outer[k], [x2, y2] = outer[(k + 1) % outer.length];
      a += x1 * y2 - x2 * y1;
      cx += x1;
      cy += y1;
    }
    return { poly, area: Math.abs(a / 2), c: [cx / outer.length, cy / outer.length] };
  });
  const big = polys.reduce((m, p) => (p.area > m.area ? p : m));
  const keep = polys.filter((p) => {
    if (p.area >= big.area * 0.2) return true;
    let d = Math.abs(p.c[0] - big.c[0]);
    if (d > 180) d = 360 - d;
    return Math.hypot(d, p.c[1] - big.c[1]) < Math.sqrt(big.area) * 2;
  });
  return keep.flatMap((p) => p.poly);
}
