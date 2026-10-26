import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'
import { kml as kmlToGeoJSON } from '@tmcw/togeojson'
import { strFromU8, unzipSync } from 'fflate'
import { parseZip } from 'shpjs'
import { zip as shpZip } from '@mapbox/shp-write'
import DxfParser from 'dxf-parser'
import { frame } from './geo'
import { colorOf, componentDef, ZONING, type Attrs, type Layer, type PlanFeature } from './model'
import { importFeatureCollection, type Classifier, type LayerOf } from './persist'
import { GDAL_RASTER, GDAL_VECTOR, gdalImport } from './api'

export interface ImportResult { features: PlanFeature[]; rejected: string[]; notes: string[] }

// --- classifying foreign data -------------------------------------------------------------------
const HIGHWAY: Record<string, string> = {
  motorway: 'road-highway', trunk: 'road-highway', primary: 'road-arterial', secondary: 'road-arterial', tertiary: 'road-collector',
  residential: 'road-local', unclassified: 'road-local', living_street: 'road-local', service: 'road-local',
  cycleway: 'road-cycle', footway: 'walking-track', path: 'walking-track', pedestrian: 'walking-track', track: 'road-local',
}
const LANDUSE: Record<string, string> = { residential: 'residential', commercial: 'commercial', retail: 'commercial', industrial: 'industrial', farmland: 'agricultural', farmyard: 'agricultural', railway: 'transport' }
const s = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '')

/**
 * Recognises OpenStreetMap-style tags and CAD/GIS layer names. Unrecognised features fall back to a
 * neutral type by geometry (zone / road / node) in the importer.
 * ponytail: tag + regex heuristics; a per-import mapping table UI would replace this for messy data.
 */
export const classifyForeign: Classifier = (p, geom) => {
  const hw = s(p.highway)
  if (geom === 'LineString' && HIGHWAY[hw]) return { type: HIGHWAY[hw] }
  if (geom === 'LineString' && ['rail', 'light_rail', 'subway', 'tram'].includes(s(p.railway))) return { type: 'rail' }
  if (geom === 'Polygon' && p.building !== undefined && s(p.building) !== 'no') {
    const levels = Number(p['building:levels'] ?? p.levels)
    const attrs: Attrs = levels > 0 ? { floors: levels, height: +(levels * 3.2).toFixed(1) } : {}
    return { type: 'building', attrs }
  }
  if (geom === 'Polygon') {
    const leisure = s(p.leisure), landuse = s(p.landuse), natural = s(p.natural)
    if (leisure === 'park' || landuse === 'recreation_ground' || landuse === 'grass') return { type: 'park' }
    if (leisure === 'garden') return { type: 'garden' }
    if (leisure === 'playground') return { type: 'playground' }
    if (leisure === 'pitch' || leisure === 'stadium') return { type: 'football' }
    if (landuse === 'forest' || natural === 'wood') return { type: 'forest' }
    if (natural === 'water' || landuse === 'reservoir' || landuse === 'basin') return { type: 'lake' }
    if (LANDUSE[landuse]) return { type: 'zone', attrs: { zoning: LANDUSE[landuse] } }
    if (typeof p.zoning === 'string' && ZONING[p.zoning]) return { type: 'zone', attrs: { zoning: p.zoning } }
  }
  // CAD / GIS layer-name hints (e.g. DXF layer "PLOTS", shapefile "roads_cl")
  const hint = s(p.dxfLayer ?? p.layer ?? p.Layer ?? p.LAYER ?? p.folder)
  if (hint) {
    if (geom === 'Polygon' && /plot|parcel|\blot/.test(hint)) return { type: 'plot' }
    if (geom === 'Polygon' && /build|bldg|footprint/.test(hint)) return { type: 'building' }
    if (geom === 'Polygon' && /bound|site/.test(hint)) return { type: 'boundary' }
    if (geom === 'LineString' && /water/.test(hint)) return { type: 'water-main' }
    if (geom === 'LineString' && /sewer|foul/.test(hint)) return { type: 'sewer' }
    if (geom === 'LineString' && /storm|drain/.test(hint)) return { type: 'drain' }
    if (geom === 'LineString' && /power|elec|cable/.test(hint)) return { type: 'power-line' }
    if (geom === 'LineString' && /road|street|centre|center|\bcl\b/.test(hint)) return { type: 'road-local' }
  }
  return undefined
}

// --- CSV + WKT -------------------------------------------------------------------------------------
/** RFC 4180-ish CSV: quoted fields, doubled quotes, newlines inside quotes; comma or semicolon. */
export function parseCSV(text: string): string[][] {
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') q = false; else cell += c }
    else if (c === '"') q = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export function toWKT(g: Geometry): string {
  const pts = (cs: Position[]) => cs.map((p) => `${p[0]} ${p[1]}`).join(', ')
  if (g.type === 'Point') return `POINT (${g.coordinates[0]} ${g.coordinates[1]})`
  if (g.type === 'LineString') return `LINESTRING (${pts(g.coordinates)})`
  if (g.type === 'Polygon') return `POLYGON (${g.coordinates.map((r) => `(${pts(r)})`).join(', ')})`
  throw new Error(`WKT: unsupported ${g.type}`)
}

export function fromWKT(wkt: string): Geometry {
  const m = wkt.trim().match(/^(MULTI)?(POINT|LINESTRING|POLYGON)\s*Z?\s*(\(.*\))$/is)
  if (!m) throw new Error('unrecognised WKT')
  // turn the parenthesised text into nested JSON arrays
  const json = m[3].replace(/(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)(\s+-?[\d.eE+-]+)?/g, '[$1,$2]').replace(/\(/g, '[').replace(/\)/g, ']')
  const c = JSON.parse(json)
  const kind = m[2].toUpperCase(), multi = !!m[1]
  if (kind === 'POINT') return multi ? { type: 'MultiPoint', coordinates: c.map((p: any) => (Array.isArray(p[0]) ? p[0] : p)) } : { type: 'Point', coordinates: c[0] }
  if (kind === 'LINESTRING') return multi ? { type: 'MultiLineString', coordinates: c } : { type: 'LineString', coordinates: c }
  return multi ? { type: 'MultiPolygon', coordinates: c } : { type: 'Polygon', coordinates: c }
}

const LAT = /^(lat|latitude|y|lat_dd)$/i, LON = /^(lon|lng|long|longitude|x|lon_dd)$/i, WKT = /^(wkt|geometry|geom|the_geom)$/i

/** CSV with lat/lon columns (points) or a WKT geometry column (any geometry). Other columns become attributes. */
export function csvToGeoJSON(text: string): FeatureCollection {
  const [head, ...rows] = parseCSV(text)
  if (!head) throw new Error('empty CSV')
  const h = head.map((x) => x.trim())
  const wi = h.findIndex((x) => WKT.test(x)), la = h.findIndex((x) => LAT.test(x)), lo = h.findIndex((x) => LON.test(x))
  if (wi < 0 && (la < 0 || lo < 0)) throw new Error('needs lat/lon (or latitude/longitude, y/x) columns, or a WKT column')
  const features: Feature[] = []
  for (const r of rows) {
    const props = Object.fromEntries(h.map((k, i) => [k, r[i] ?? '']).filter((_, i) => i !== wi && i !== la && i !== lo))
    let geometry: Geometry | null = null
    try { geometry = wi >= 0 ? fromWKT(r[wi] ?? '') : { type: 'Point', coordinates: [Number(r[lo]), Number(r[la])] } } catch { geometry = null }
    features.push({ type: 'Feature', geometry: geometry as Geometry, properties: props })
  }
  return { type: 'FeatureCollection', features }
}

// --- DXF -------------------------------------------------------------------------------------------
/**
 * DXF entities → GeoJSON. Coordinates are taken as metres relative to the project centre (the same
 * convention `toDXF` writes). Drawings in absolute projected coordinates (e.g. UTM, far from 0,0) are
 * recentred on the project centre and reported in `notes` — georeferencing needs the GDAL backend.
 */
export function dxfToGeoJSON(text: string, center: Position): { fc: FeatureCollection; notes: string[] } {
  const dxf = new DxfParser().parseSync(text)
  if (!dxf) throw new Error('could not parse DXF')
  const notes: string[] = []
  const shapes: { layer: string; pts: number[][]; closed: boolean; text?: string }[] = []
  for (const e of dxf.entities as any[]) {
    const v = (e.vertices ?? []).map((p: any) => [p.x, p.y])
    if (e.type === 'LINE') shapes.push({ layer: e.layer, pts: v, closed: false })
    else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') shapes.push({ layer: e.layer, pts: v, closed: !!e.shape || (v.length > 3 && v[0][0] === v[v.length - 1][0] && v[0][1] === v[v.length - 1][1]) })
    else if (e.type === 'POINT') shapes.push({ layer: e.layer, pts: [[e.position.x, e.position.y]], closed: false })
    else if (e.type === 'CIRCLE') shapes.push({ layer: e.layer, closed: true, pts: Array.from({ length: 33 }, (_, i) => [e.center.x + e.radius * Math.cos((i / 32) * 2 * Math.PI), e.center.y + e.radius * Math.sin((i / 32) * 2 * Math.PI)]) })
  }
  const supported = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'POINT', 'CIRCLE'])
  const skipped = new Map<string, number>()
  for (const e of dxf.entities as any[]) if (!supported.has(e.type)) skipped.set(e.type, (skipped.get(e.type) ?? 0) + 1)
  if (skipped.size) notes.push(`Skipped unsupported DXF entities: ${[...skipped].map(([t, c]) => `${t} ×${c}`).join(', ')}`)
  const xs = shapes.flatMap((sh) => sh.pts.map((p) => p[0])), ys = shapes.flatMap((sh) => sh.pts.map((p) => p[1]))
  let off = [0, 0]
  if (xs.length) {
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
    if (Math.hypot(cx, cy) > 50000) { off = [cx, cy]; notes.push('DXF coordinates look absolute (not project-relative metres); the drawing was centred on the project centre. Check scale and position.') }
  }
  const f = frame(center)
  const geo = (p: number[]) => f.toGeo([p[0] - off[0], p[1] - off[1]])
  const features: Feature[] = shapes.map((sh) => {
    const pts = sh.pts.map(geo)
    const geometry: Geometry = sh.pts.length === 1 ? { type: 'Point', coordinates: pts[0] }
      : sh.closed && pts.length >= 3 ? { type: 'Polygon', coordinates: [[...pts, ...(pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? [] : [pts[0]])]] }
      : { type: 'LineString', coordinates: pts }
    return { type: 'Feature', geometry, properties: { dxfLayer: sh.layer } }
  })
  return { fc: { type: 'FeatureCollection', features }, notes }
}

const dxfName = (n: string) => n.toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 31) || '0'

/** AutoCAD R12 ASCII DXF (opens in practically every CAD package). Metres relative to `origin`. */
export function toDXF(features: PlanFeature[], layers: Layer[], origin: Position): string {
  const f = frame(origin)
  const names = new Map(layers.map((l) => [l.id, dxfName(l.name)]))
  const out: (string | number)[] = [
    999, `UrbanForge export. Units: metres. Origin (0,0) = lng ${origin[0]}, lat ${origin[1]} (WGS 84), x east, y north.`,
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, layers.length,
    ...layers.flatMap((l, i) => [0, 'LAYER', 2, names.get(l.id)!, 70, 0, 62, (i % 254) + 1, 6, 'CONTINUOUS']),
    0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  ]
  const xy = (p: Position) => { const [x, y] = f.toLocal(p); return [10, +x.toFixed(3), 20, +y.toFixed(3), 30, 0] }
  const poly = (layer: string, pts: Position[], closed: boolean) => out.push(0, 'POLYLINE', 8, layer, 66, 1, 70, closed ? 1 : 0, 10, 0, 20, 0, 30, 0,
    ...pts.flatMap((p) => [0, 'VERTEX', 8, layer, ...xy(p)]), 0, 'SEQEND', 8, layer)
  for (const x of features) {
    const layer = names.get(x.properties.layerId) ?? '0', g = x.geometry
    if (g.type === 'Point') out.push(0, 'POINT', 8, layer, ...xy(g.coordinates))
    else if (g.type === 'LineString') poly(layer, g.coordinates, false)
    else for (const r of g.coordinates) poly(layer, r.slice(0, -1), true)
    const label = x.properties.attrs.plotNo
    if (label && g.type === 'Polygon') out.push(0, 'TEXT', 8, layer, ...xy(turf.centroid(x).geometry.coordinates), 40, 1.5, 1, String(label))
  }
  out.push(0, 'ENDSEC', 0, 'EOF')
  return out.join('\r\n') + '\r\n'
}

// --- KML -----------------------------------------------------------------------------------------
const xml = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const kmlColor = (hex: string, alpha: string) => `${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}` // KML is aabbggrr

export function toKML(features: PlanFeature[], layers: Layer[], name: string): string {
  const coords = (cs: Position[]) => cs.map((p) => `${p[0]},${p[1]},0`).join(' ')
  const geom = (g: Geometry) => g.type === 'Point' ? `<Point><coordinates>${coords([g.coordinates])}</coordinates></Point>`
    : g.type === 'LineString' ? `<LineString><tessellate>1</tessellate><coordinates>${coords(g.coordinates)}</coordinates></LineString>`
    : g.type === 'Polygon' ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(g.coordinates[0])}</coordinates></LinearRing></outerBoundaryIs>${g.coordinates.slice(1).map((r) => `<innerBoundaryIs><LinearRing><coordinates>${coords(r)}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon>` : ''
  const folders = layers.map((l) => {
    const marks = features.filter((f) => f.properties.layerId === l.id).map((f) => {
      const c = colorOf(f)
      const data = { type: f.properties.type, ...f.properties.attrs }
      return `<Placemark><name>${xml(f.properties.name)}</name><Style><LineStyle><color>${kmlColor(c, 'ff')}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(c, '80')}</color></PolyStyle></Style>`
        + `<ExtendedData>${Object.entries(data).map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(v)}</value></Data>`).join('')}</ExtendedData>${geom(f.geometry)}</Placemark>`
    })
    return marks.length ? `<Folder><name>${xml(l.name)}</name>${marks.join('')}</Folder>` : ''
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(name)}</name>${folders.join('')}</Document></kml>\n`
}

export function kmlTextToGeoJSON(text: string): FeatureCollection {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid KML (XML parse error)')
  return kmlToGeoJSON(doc) as FeatureCollection
}

// --- Shapefile --------------------------------------------------------------------------------------
/** Zipped shapefile set (one .shp/.shx/.dbf/.prj per geometry type), WGS 84. DBF field names are cut to 10 chars. */
export async function toShapefileZip(features: PlanFeature[], layers: Layer[]): Promise<ArrayBuffer> {
  const names = new Map(layers.map((l) => [l.id, l.name]))
  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: features.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: { name: f.properties.name, type: f.properties.type, layer: names.get(f.properties.layerId) ?? '', ...f.properties.attrs } })),
  }
  return shpZip<'arraybuffer'>(fc, { outputType: 'arraybuffer', compression: 'DEFLATE', types: { point: 'points', line: 'lines', polygon: 'polygons' } })
}

export async function shapefileZipToGeoJSON(buf: ArrayBuffer): Promise<FeatureCollection> {
  const r = await parseZip(buf)
  const list = Array.isArray(r) ? r : [r]
  return { type: 'FeatureCollection', features: list.flatMap((fc: any) => fc.features.map((f: Feature) => ({ ...f, properties: { ...f.properties, layer: f.properties?.layer ?? fc.fileName } }))) }
}

// --- CSV export -------------------------------------------------------------------------------------
export function toCSV(features: PlanFeature[], layers: Layer[]): string {
  const names = new Map(layers.map((l) => [l.id, l.name]))
  const keys = [...new Set(features.flatMap((f) => Object.keys(f.properties.attrs)))].sort()
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [['id', 'name', 'type', 'layer', ...keys, 'wkt'].map(q).join(','),
    ...features.map((f) => [f.id, f.properties.name, f.properties.type, names.get(f.properties.layerId), ...keys.map((k) => f.properties.attrs[k]), toWKT(f.geometry)].map(q).join(','))].join('\n')
}

// --- OpenStreetMap (Overpass API) --------------------------------------------------------------------
/** Public Overpass API instances, tried in order (the main one is often overloaded). */
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']

export function overpassQuery([w, s, e, n]: [number, number, number, number]): string {
  const b = `${s},${w},${n},${e}`
  return `[out:json][timeout:25];(way["highway"](${b});way["building"](${b});way["railway"~"rail|light_rail|subway|tram"](${b});`
    + `way["leisure"~"park|garden|playground|pitch|stadium"](${b});way["landuse"](${b});way["natural"~"water|wood"](${b}););out geom tags;`
}

const AREA_KEYS = ['building', 'leisure', 'landuse', 'natural', 'area']
const same = (p: Position, q: Position) => p[0] === q[0] && p[1] === q[1]

/** Chains way segments that share end nodes into closed rings (multipolygon members). Open chains are dropped. */
export function joinRings(parts: Position[][]): Position[][] {
  const left = parts.filter((p) => p.length >= 2), rings: Position[][] = []
  while (left.length) {
    let ring = left.shift()!
    for (let grew = true; grew && !same(ring[0], ring.at(-1)!);) {
      grew = false
      const i = left.findIndex((p) => same(ring.at(-1)!, p[0]) || same(ring.at(-1)!, p.at(-1)!))
      if (i < 0) break
      const [p] = left.splice(i, 1)
      ring = [...ring, ...(same(ring.at(-1)!, p[0]) ? p : [...p].reverse()).slice(1)]
      grew = true
    }
    if (ring.length >= 4 && same(ring[0], ring.at(-1)!)) rings.push(ring)
  }
  return rings
}

/**
 * Overpass `out geom` → GeoJSON: ways (closed area-like ways → polygons) and multipolygon relations
 * (outer rings joined from member ways, inner rings cut as holes; one polygon per outer ring).
 */
export function overpassToGeoJSON(json: any): FeatureCollection {
  const features: Feature[] = []
  for (const el of json?.elements ?? []) {
    const tags = el.tags ?? {}
    if (el.type === 'relation' && (tags.type === 'multipolygon' || tags.type === undefined) && Array.isArray(el.members)) {
      const ways = (role: string) => el.members.filter((m: any) => m.type === 'way' && (m.role || 'outer') === role && Array.isArray(m.geometry)).map((m: any) => m.geometry.map((p: any) => [p.lon, p.lat]))
      const inners = joinRings(ways('inner'))
      for (const outer of joinRings(ways('outer'))) {
        const holes = inners.filter((r) => turf.booleanPointInPolygon(r[0], turf.polygon([outer])))
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [outer, ...holes] }, properties: { ...tags, name: tags.name, osm_id: `relation/${el.id}` } })
      }
      continue
    }
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue
    const pts: Position[] = el.geometry.map((p: any) => [p.lon, p.lat])
    const closed = pts.length >= 4 && same(pts[0], pts[pts.length - 1])
    const area = closed && !tags.highway && (AREA_KEYS.some((k) => k in tags) || tags.waterway === 'riverbank')
    features.push({ type: 'Feature', geometry: area ? { type: 'Polygon', coordinates: [pts] } : { type: 'LineString', coordinates: pts }, properties: { ...tags, name: tags.name, osm_id: `way/${el.id}` } })
  }
  return { type: 'FeatureCollection', features }
}

/** Runs an Overpass query against each public instance in turn; throws when none answers. */
export async function fetchOverpass(query: string): Promise<any> {
  const errors: string[] = []
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(45000) })
      if (res.ok) return await res.json()
      errors.push(`${new URL(url).host}: HTTP ${res.status}`)
      if (res.status === 400) break // a bad query won't succeed elsewhere; 403/406/429/5xx are per-server policy, try the next
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}`)
    }
  }
  throw new Error(`no Overpass server answered (${errors.join('; ')}). Try again in a minute.`)
}

export async function importOSM(bounds: [number, number, number, number], layerOf: LayerOf): Promise<ImportResult> {
  const fc = overpassToGeoJSON(await fetchOverpass(overpassQuery(bounds)))
  const r = importFeatureCollection(fc, layerOf, classifyForeign)
  return { ...r, notes: ['Data © OpenStreetMap contributors, ODbL 1.0. Multipolygon relations are not imported.'] }
}

// --- import by file type ------------------------------------------------------------------------------
/** Imports a GIS/CAD file into plan features. Throws with a readable message for unsupported/invalid input. */
export async function importFile(file: File, layerOf: LayerOf, center: Position): Promise<ImportResult> {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  const notes: string[] = []
  let fc: FeatureCollection
  if (ext === 'geojson' || ext === 'json') fc = JSON.parse(await file.text())
  else if (ext === 'kml') fc = kmlTextToGeoJSON(await file.text())
  else if (ext === 'kmz') {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const doc = Object.keys(files).find((k) => k.toLowerCase().endsWith('.kml'))
    if (!doc) throw new Error('KMZ contains no .kml document')
    fc = kmlTextToGeoJSON(strFromU8(files[doc]))
  } else if (ext === 'zip') fc = await shapefileZipToGeoJSON(await file.arrayBuffer())
  else if (ext === 'csv') fc = csvToGeoJSON(await file.text())
  else if (ext === 'dxf') { const r = dxfToGeoJSON(await file.text(), center); fc = r.fc; notes.push(...r.notes) }
  else if (GDAL_VECTOR.includes(ext) || GDAL_RASTER.includes(ext)) { const r = await gdalImport(file); fc = r.featureCollection; notes.push(...r.notes) }
  else throw new Error(`.${ext} is not supported${ext === 'dwg' ? ' (DWG needs the ODA File Converter — save as DXF from your CAD program)' : ''}`)
  const r = importFeatureCollection(fc, layerOf, classifyForeign)
  return { ...r, notes }
}

/** Helper for callers that only know the layer kind. */
export const layerOfKind = (layerFor: (kind: any) => string): LayerOf => (type) => layerFor(componentDef(type).layer)
