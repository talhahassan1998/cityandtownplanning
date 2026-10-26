import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson'
import { roadSurface } from './geo'
import type { Draft, Existing } from './masterplan'
import { componentDef, defaultAttrs, type PlanFeature } from './model'
import type { Classifier } from './persist'

/**
 * Site clearance: a new town may only be planned on undeveloped ground. A site is blocked when it
 * overlaps plan objects already in the project (plots, roads, buildings, facilities, parks) or
 * real-world development mapped in OpenStreetMap (buildings, roads, railways, built-up land use, grounds).
 */
const BLOCKING_LAYERS = new Set(['parcels', 'roads', 'buildings', 'facilities', 'green'])

const OSM_DEVELOPED: Record<string, RegExp> = {
  building: /./,
  highway: /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|pedestrian|busway)(_link)?$/,
  railway: /^(rail|light_rail|subway|tram|narrow_gauge)$/,
  aeroway: /^(runway|taxiway|apron|terminal)$/,
  landuse: /^(residential|commercial|industrial|retail|construction|railway|cemetery|military|garages|religious|education)$/,
  leisure: /^(pitch|stadium|park|playground|sports_centre|golf_course|track|garden)$/,
}

/** Site shrunk by 1 m so objects that only touch the site edge (e.g. a bordering road) don't block it. */
const inner = (site: Polygon): Feature<Polygon> => {
  const b = turf.buffer(turf.feature(site), -1, { units: 'meters' })
  return (b?.geometry.type === 'Polygon' ? b : turf.feature(site)) as Feature<Polygon>
}

export interface Conflict { source: 'plan' | 'osm'; label: string }

/** Plan objects already occupying the site. `ignoreId`: the boundary/zone being planned inside. */
export function planConflicts(site: Polygon, features: Iterable<PlanFeature>, ignoreId?: string): Conflict[] {
  const s = inner(site)
  const out: Conflict[] = []
  for (const f of features) {
    if (f.id === ignoreId || f.properties.type === 'lake' || !BLOCKING_LAYERS.has(componentDef(f.properties.type).layer)) continue // water isn't development
    if (turf.booleanIntersects(f as Feature, s)) out.push({ source: 'plan', label: f.properties.name || componentDef(f.properties.type).label })
  }
  return out
}

export const isDeveloped = (tags: Record<string, unknown>) =>
  Object.entries(OSM_DEVELOPED).some(([k, re]) => typeof tags[k] === 'string' && re.test(tags[k] as string))

/** OpenStreetMap features (from `overpassToGeoJSON`) that are development inside the site. */
export function osmConflicts(site: Polygon, fc: FeatureCollection): Conflict[] {
  const s = inner(site)
  return fc.features
    .filter((f) => isDeveloped(f.properties ?? {}) && turf.booleanIntersects(f, s))
    .map((f) => {
      const p = f.properties ?? {}
      const kind = Object.keys(OSM_DEVELOPED).find((k) => typeof p[k] === 'string' && OSM_DEVELOPED[k].test(p[k]))!
      return { source: 'osm' as const, label: `${kind === 'building' ? 'building' : `${kind}=${p[kind]}`}${p.name ? ` "${p.name}"` : ''}` }
    })
}

/** Development keys and water inside the site bbox, plus roads in `near` (the wider area new roads may join). */
export const siteQuery = ([w, s, e, n]: number[], near?: number[]) => {
  const b = `${s},${w},${n},${e}`
  const roads = near ? `way["highway"](${near[1]},${near[0]},${near[3]},${near[2]});` : ''
  const water = `way["natural"="water"](${b});way["waterway"~"^(${Object.keys(WATERWAY).join('|')}|riverbank)$"](${b});way["landuse"~"^(reservoir|basin)$"](${b});`
    + `relation["natural"="water"](${b});relation["waterway"="riverbank"](${b});`
  return `[out:json][timeout:25];(${Object.keys(OSM_DEVELOPED).map((k) => `way["${k}"](${b});`).join('')}${roads}${water});out geom tags;`
}

/** Waterway centrelines kept undeveloped, with their default width (m) when untagged. ponytail: drains/ditches are ignored. */
const WATERWAY: Record<string, number> = { river: 20, canal: 12, stream: 4 }
const isWaterArea = (p: Record<string, unknown>) => p.natural === 'water' || p.waterway === 'riverbank' || p.landuse === 'reservoir' || p.landuse === 'basin'

/** How far around the site existing roads are looked for, to join the new network to (m). */
export const REACH = 500

/** What is already on (and, for roads, near) the site: conflicts to report, development and water to keep and plan around. */
export interface Survey extends Existing {
  conflicts: Conflict[]
  /** OpenStreetMap roads and buildings to add to the project as existing objects; `road` = its index in `roads`. */
  adds: { draft: Draft; road?: number }[]
}

/** Pure part of `surveySite`: `fc` is the Overpass result, `classify` maps OSM tags to a component type. */
export function surveyOf(site: Polygon, features: Iterable<PlanFeature>, fc: FeatureCollection, classify: Classifier, ignoreId?: string): Survey {
  const list = [...features]
  const s = inner(site)
  const reach = turf.buffer(turf.feature(site), REACH, { units: 'meters' })!
  // Overpass returns whole ways (a road or river can run tens of km): keep only the part within reach
  const box = turf.bbox(reach)
  const parts = <G extends LineString | Polygon>(g: G): G[] => {
    const c = turf.bboxClip(g, box).geometry as LineString | Polygon | { type: 'MultiLineString' | 'MultiPolygon'; coordinates: any[] }
    const pieces = c.type === 'MultiLineString' || c.type === 'MultiPolygon' ? c.coordinates.map((coordinates) => ({ type: g.type, coordinates }) as G) : [c as G]
    return pieces.filter((p) => p.coordinates.length && (p.type === 'Polygon' ? p.coordinates[0].length >= 4 : p.coordinates.length >= 2))
  }
  const out: Survey = { conflicts: [...planConflicts(site, list, ignoreId), ...osmConflicts(site, fc)], roads: [], obstacles: [], water: [], adds: [] }
  for (const f of list) {
    if (f.properties.type === 'lake' && f.geometry.type === 'Polygon' && turf.booleanIntersects(f as Feature, s)) { out.water.push(f.geometry); continue }
    if (f.id === ignoreId || !BLOCKING_LAYERS.has(componentDef(f.properties.type).layer)) continue
    if (f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads' && turf.booleanIntersects(f as Feature, reach))
      out.roads.push({ geometry: f.geometry, width: Number(f.properties.attrs.width) || 8 })
    else if (f.geometry.type === 'Polygon' && turf.booleanIntersects(f as Feature, s)) out.obstacles.push(f.geometry)
  }
  for (const f of fc.features) {
    const p = f.properties ?? {}
    const tag = { status: 'existing', source: 'OpenStreetMap', ...(p.osm_id && { osm_id: String(p.osm_id) }) }
    if (f.geometry.type === 'LineString' && OSM_DEVELOPED.highway.test(String(p.highway ?? '')) && turf.booleanIntersects(f, reach)) {
      const type = classify(p, 'LineString')?.type ?? 'road-local'
      const attrs = { ...defaultAttrs(componentDef(type)), ...tag, ...(p.bridge && p.bridge !== 'no' && { structure: 'bridge' }) }
      for (const geometry of parts(f.geometry)) {
        out.adds.push({ draft: { type, geometry, attrs, name: String(p.name ?? `Existing ${p.highway} road`) }, road: out.roads.length })
        out.roads.push({ geometry, width: Number(attrs.width) || 8 })
      }
    } else if (f.geometry.type === 'LineString' && OSM_DEVELOPED.railway.test(String(p.railway ?? '')) && turf.booleanIntersects(f, s)) {
      out.obstacles.push(roadSurface(f as Feature<LineString>, 10)!.geometry as Polygon) // corridor kept clear, not added
    } else if (f.geometry.type === 'Polygon' && p.building !== undefined && p.building !== 'no' && turf.booleanIntersects(f, s)) {
      const g = classify(p, 'Polygon')
      out.adds.push({ draft: { type: 'building', geometry: f.geometry, attrs: { ...defaultAttrs(componentDef('building')), ...g?.attrs, ...tag }, name: String(p.name ?? 'Existing building') } })
      out.obstacles.push(f.geometry)
    } else if (turf.booleanIntersects(f, s) && ((f.geometry.type === 'Polygon' && isWaterArea(p)) || (f.geometry.type === 'LineString' && WATERWAY[String(p.waterway)]))) {
      // lakes as drawn; rivers/canals/streams as a corridor of their tagged (or typical) width
      const g = f.geometry.type === 'Polygon' ? f.geometry : roadSurface(f as Feature<LineString>, Number(p.width) || WATERWAY[String(p.waterway)])!.geometry as Polygon
      for (const geometry of parts(g)) {
        out.water.push(geometry)
        out.adds.push({ draft: { type: 'lake', geometry, attrs: tag, name: String(p.name ?? (p.waterway ? `Existing ${p.waterway}` : 'Existing water')) } })
      }
    }
  }
  return out
}

/**
 * Surveys the site: plan objects and OpenStreetMap development on it, and roads within `REACH` to join.
 * Throws when OpenStreetMap can't be reached: an unchecked site is never reported as clear.
 * `checkOsm: false` (the user's explicit choice after a failed check) surveys the project only.
 */
export async function surveySite(site: Polygon, features: Iterable<PlanFeature>, ignoreId?: string, checkOsm = true): Promise<Survey> {
  const { fetchOverpass, overpassToGeoJSON, classifyForeign } = await import('./formats')
  const near = turf.bbox(turf.buffer(turf.feature(site), REACH, { units: 'meters' })!)
  const osm = checkOsm ? overpassToGeoJSON(await fetchOverpass(siteQuery(turf.bbox(site), near))) : { type: 'FeatureCollection' as const, features: [] }
  return surveyOf(site, features, osm, classifyForeign, ignoreId)
}
