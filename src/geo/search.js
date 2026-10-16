// Recherche de lieux : Photon (Komoot), géocodeur ouvert basé sur OpenStreetMap.
const KIND_WIDTH_M = {
  peak: 7000, volcano: 9000, mountain_range: 40000, ridge: 8000, glacier: 9000,
  lake: 0, island: 0, city: 0, town: 0, village: 5000, hamlet: 3000,
  national_park: 0, protected_area: 0, valley: 12000, bay: 0,
};

export async function searchPlaces(query, lang, signal) {
  const l = ['fr', 'en', 'de'].includes(lang) ? `&lang=${lang}` : '';
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8${l}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const json = await res.json();
  const seen = new Set();
  return json.features
    .map((f) => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const ext = p.extent; // [ouest, nord, est, sud]
      return {
        label: p.name || p.city || p.state || p.country || '?',
        sublabel: [p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', '),
        kind: p.osm_value,
        lon,
        lat,
        bounds: ext ? { west: ext[0], north: ext[1], east: ext[2], south: ext[3] } : null,
        defaultWidthM: KIND_WIDTH_M[p.osm_value] || 8000,
        osmId: `${p.osm_type}${p.osm_id}`,
      };
    })
    .filter((r) => !seen.has(r.osmId) && seen.add(r.osmId));
}
