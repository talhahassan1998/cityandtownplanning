export type Place = { name: string; lat: number; lng: number }

/** "24.86, 67.00" / "24.86 67.00" → lat/lng (lat first, like Google Maps copies it); null if not a coordinate pair. */
export function parseLatLng(q: string): Place | null {
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/)
  if (!m) return null
  const lat = +m[1], lng = +m[2]
  return Math.abs(lat) <= 85 && Math.abs(lng) <= 180 ? { name: `${lat}, ${lng}`, lat, lng } : null
}

/** Place-name search via OSM Nominatim. ponytail: public instance (1 req/s policy) — search on submit only, self-host or a keyed geocoder if usage grows. */
export async function searchPlace(q: string): Promise<Place[]> {
  const coord = parseLatLng(q)
  if (coord) return [coord]
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Place search failed (${res.status})`)
  const rows: { display_name: string; lat: string; lon: string }[] = await res.json()
  return rows.map((r) => ({ name: r.display_name, lat: +r.lat, lng: +r.lon }))
}
