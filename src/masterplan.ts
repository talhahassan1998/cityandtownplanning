import * as turf from '@turf/turf'
import type { LineString, Polygon, Position } from 'geojson'
import { clearRoads, clip, footprint, frame, orientedBox, plotIssue, rect, roadSurface, splitPolygonShares, subdivide, unitsOf, type GeneratedPlot } from './geo'
import { connectEnds, measureFrontage } from './roads'
import { fillPlot, housingType, plotSizeFor, residentialPlotSize } from './infill'
import { COMPONENTS, componentDef, FLOOR_HEIGHT, GENERIC_RULESET, ROAD_CLASSES, type Attrs, type PlanFeature, type PlanGeometry, type Ruleset } from './model'

/**
 * Procedural master-plan generator. It is a rule-based starting point for discussion, not an
 * optimiser and not an approved design: every proposal is labelled preliminary and is fully editable
 * once accepted.
 */
export interface Brief {
  targetPopulation: number
  personsPerDwelling: number
  /** Gross dwellings per hectare of residential land (incl. its local streets). */
  density: number
  /** Land-use mix, % of the site (normalised). */
  mix: { residential: number; commercial: number; industrial: number; institutional: number; green: number }
  arterialWidth: number
  localStreetWidth: number
  plotsPerBlock: number
  /** Persons served per facility (0 = none). */
  facilities: { school: number; clinic: number; police: number; fire: number; community: number; religious: number }
  /** Construction budget (same currency as the cost rates); 0 = not set. */
  budget: number
  roadCostPerM2: number
  buildingCostPerM2: number
  /** Place a rule-compliant building on every free residential/commercial/industrial plot. */
  fillBuildings: boolean
  /** Lay a water main and a sewer under every street on accept (utilities.ts). */
  layPipes: boolean
}

export const DEFAULT_BRIEF: Brief = {
  targetPopulation: 5000, personsPerDwelling: 5, density: 35,
  mix: { residential: 55, commercial: 10, industrial: 10, institutional: 8, green: 17 },
  arterialWidth: 24, localStreetWidth: 12, plotsPerBlock: 8,
  facilities: { school: 5000, clinic: 10000, police: 25000, fire: 30000, community: 10000, religious: 5000 },
  budget: 0, roadCostPerM2: 45, buildingCostPerM2: 600, fillBuildings: true, layPipes: true,
}

export { plotSizeFor }

export interface Draft { type: string; geometry: PlanGeometry; attrs: Attrs; name?: string }

export interface Variant { angleOffset: 0 | 90; order: 'A' | 'B' }
export const VARIANTS: Variant[] = [{ angleOffset: 0, order: 'A' }, { angleOffset: 0, order: 'B' }, { angleOffset: 90, order: 'A' }, { angleOffset: 90, order: 'B' }]

export interface Proposal {
  label: string
  variant: Variant
  drafts: Draft[]
  metrics: {
    siteArea: number; roadArea: number; plots: number; residentialPlots: number
    dwellings: number; population: number; facilities: Record<string, number>
    landUse: Record<string, number> // m² per zoning band
    roadCost: number; buildingCost: number
  }
  checks: { label: string; ok: boolean; detail: string }[]
  /** Indices into `Existing.roads` the new network joins (crossed by the spine or linked to it). */
  linkedTo: number[]
}

/**
 * Development and water already on or near the site (sitecheck.ts `surveySite`): roads are kept and
 * joined to, obstacles (buildings, rail) are planned around, water (lakes, river corridors) stays undeveloped.
 */
export interface Existing { roads: { geometry: LineString; width: number }[]; obstacles: Polygon[]; water: Polygon[] }
const NO_EXISTING: Existing = { roads: [], obstacles: [], water: [] }
/** Clearance kept around existing buildings and from water (m), how far a spine end may reach for a road and the longest bridge (m). */
const CLEARANCE = 3, WATER_SETBACK = 10, LINK_REACH = 500, MAX_SPAN = 300

type Zone = 'residential' | 'commercial' | 'industrial' | 'institutional' | 'green'
// band order along the spine; residential is split in two around the civic/commercial core
const ORDERS: Record<Variant['order'], (Zone | 'residential-2')[]> = {
  A: ['industrial', 'residential', 'institutional', 'commercial', 'green', 'residential-2'],
  B: ['green', 'residential', 'commercial', 'institutional', 'residential-2', 'industrial'],
}
const PLOT: Record<Exclude<Zone, 'residential' | 'green'>, [number, number]> = { commercial: [25, 40], industrial: [50, 60], institutional: [60, 60] }
const FACILITY_TYPE: Record<keyof Brief['facilities'], string> = { school: 'school', clinic: 'clinic', police: 'police', fire: 'fire', community: 'community', religious: 'religious' }

export function generatePlan(site: Polygon, b: Brief, v: Variant, ruleset: Ruleset = GENERIC_RULESET, existing: Existing = NO_EXISTING): Proposal {
  const c = turf.centroid(site).geometry.coordinates
  const f = frame(c)
  const ring = site.coordinates[0].map((p) => f.toLocal(p) as [number, number])
  const axis = -((orientedBox(ring).angle * 180) / Math.PI) + v.angleOffset // clockwise-from-east, long axis (+90 for the variant)
  const drafts: Draft[] = []
  const tag = { plan: `${v.order}${v.angleOffset ? '-90' : ''}` }
  const housing = housingType(b.density)

  // 1. arterial spine along the axis, through the centroid, clipped to the site
  const fa = frame(c, -axis)
  const loc: Polygon = { type: 'Polygon', coordinates: site.coordinates.map((r) => r.map(fa.toLocal)) }
  const [x0, , x1] = turf.bbox(loc)
  const spine: LineString[] = clip(loc, rect(x0 - 1, -b.arterialWidth / 2, x1 + 1, b.arterialWidth / 2)).map((piece) => {
    const [px0, , px1] = turf.bbox(piece)
    return { type: 'LineString', coordinates: [[px0, 0], [px1, 0]].map(fa.toGeo) }
  })
  for (const g of spine) drafts.push({ type: 'road-arterial', geometry: g, attrs: { ...tag, width: b.arterialWidth, lanes: 4, sidewalk: ROAD_CLASSES.arterial.sidewalk, roadClass: 'arterial' }, name: 'Arterial spine' })
  const spineSurfaces = spine.map((g) => roadSurface(turf.feature(g), b.arterialWidth)!).filter(Boolean)

  // existing roads stay (no plots on them) and existing buildings keep a clearance
  // ponytail: only plots avoid them; a generated street may still cross an existing building
  const keptRoads = existing.roads.map((r) => roadSurface(turf.feature(r.geometry), r.width)).filter((x) => !!x)
  const keep = [...keptRoads, ...[...existing.obstacles.map((o) => [o, CLEARANCE] as const), ...existing.water.map((w) => [w, WATER_SETBACK] as const)]
    .map(([o, m]) => turf.buffer(turf.feature(o), m, { units: 'meters' })).filter((x) => !!x)]
  // water is never developed: land-use areas leave it out (largest dry parts kept)
  const dry = (g: Polygon): Polygon[] => {
    if (!existing.water.length) return [g]
    const d = turf.difference(turf.featureCollection([turf.feature(g), ...existing.water.map((w) => turf.feature(w))]))?.geometry
    return !d ? [] : (d.type === 'Polygon' ? [d.coordinates] : d.coordinates).map((c) => ({ type: 'Polygon', coordinates: c }) as Polygon).filter((p) => turf.area(p) > 100)
  }
  // join the spine's two ends to the nearest existing road (inside or just outside the site)
  const linkedTo = new Set(existing.roads.flatMap((r, i) => spine.some((s) => turf.booleanIntersects(s, r.geometry)) ? [i] : []))
  const links: LineString[] = []
  const ends = spine.flatMap((g) => [g.coordinates[0], g.coordinates.at(-1)!]).sort((p, q) => fa.toLocal(p)[0] - fa.toLocal(q)[0])
  for (const p of ends.length ? [ends[0], ends.at(-1)!] : []) {
    let best: { d: number; q: Position; i: number } | undefined
    existing.roads.forEach((r, i) => {
      const q = turf.nearestPointOnLine(turf.feature(r.geometry), p, { units: 'meters' })
      const d = q.properties.dist ?? Infinity
      if (d <= LINK_REACH && (!best || d < best.d)) best = { d, q: q.geometry.coordinates, i }
    })
    if (!best) continue
    linkedTo.add(best.i)
    if (best.d > 1) links.push({ type: 'LineString', coordinates: [p, best.q] })
  }
  for (const g of links) drafts.push({ type: 'road-arterial', geometry: g, attrs: { ...tag, width: b.arterialWidth, lanes: 4, sidewalk: ROAD_CLASSES.arterial.sidewalk, roadClass: 'arterial' }, name: 'Link to existing road' })

  // 2. land-use bands across the spine, equal-area by share
  const total = Object.values(b.mix).reduce((a, x) => a + Math.max(0, x), 0) || 1
  const share = (z: Zone | 'residential-2') => (z === 'residential' || z === 'residential-2' ? b.mix.residential / 2 : b.mix[z]) / total
  const order = ORDERS[v.order].filter((z) => share(z) > 0)
  const bands = splitPolygonShares(site, order.map(share), axis, 'frontage') // cut in the same frame as `fa`
  const plots: (GeneratedPlot & { zone: Zone; band: number })[] = []
  const landUse: Record<string, number> = {}
  const aw = b.arterialWidth, rw = b.localStreetWidth
  const street = (g: LineString, name: string): Draft => ({ type: 'road-local', geometry: g, attrs: { ...tag, width: rw, lanes: 2, sidewalk: ROAD_CLASSES.local.sidewalk, roadClass: 'local' }, name })
  const toLoc = (g: Polygon): Polygon => ({ type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(fa.toLocal)) })
  const toGeo = (g: Polygon): Polygon => ({ type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(fa.toGeo)) })
  const [, sy0, , sy1] = turf.bbox(loc)

  // a cross street along every cut between bands, right through the spine, so each band's streets
  // join the network at both ends (instead of stopping as stubs short of the arterial)
  const xr = bands.map((band) => turf.bbox(toLoc(band.geometry)))
  const inner = (x: number) => x > x0 + 1 && x < x1 - 1
  const cuts = [...new Set(xr.flatMap(([bx0, , bx1]) => [bx0, bx1]).filter(inner).map((x) => Math.round(x * 10) / 10))]
  const locals: LineString[] = []
  for (const x of cuts)
    for (const piece of clip(loc, rect(x - rw / 2, sy0 - 1, x + rw / 2, sy1 + 1))) {
      const [, py0, , py1] = turf.bbox(piece)
      locals.push({ type: 'LineString', coordinates: [[x, py0], [x, py1]].map(fa.toGeo) })
    }
  const crossCount = locals.length
  const crossSurfaces = locals.map((g) => roadSurface(turf.feature(g), rw)!).filter(Boolean)
  const crossRoads = locals.map((g) => ({ geometry: g, properties: { attrs: { width: rw } } })) as unknown as PlanFeature[]

  for (const band of bands) {
    const zone: Zone = order[band.index] === 'residential-2' ? 'residential' : (order[band.index] as Zone)
    const land = dry(band.geometry)
    landUse[zone] = (landUse[zone] ?? 0) + land.reduce((a, g) => a + turf.area(g), 0)
    for (const g of land) drafts.push({ type: 'zone', geometry: g, attrs: { ...tag, zoning: zone }, name: `${zone[0].toUpperCase()}${zone.slice(1)} area` })
    if (zone === 'green') { for (const g of land) drafts.push({ type: 'park', geometry: g, attrs: { ...tag, zoning: 'green' }, name: 'Central park' }); continue }
    const [w, d] = zone === 'residential' ? (b.fillBuildings ? residentialPlotSize(housing, b.density, ruleset.rules.residential?.setback) : plotSizeFor(b.density)) : PLOT[zone]
    const [bx0, , bx1] = xr[band.index]
    const left = inner(bx0) ? rw / 2 : 0, right = inner(bx1) ? rw / 2 : 0
    let blocks = 0
    // each side of the spine on its own grid, anchored to the spine edge: the first row of plots fronts
    // the arterial and the street grid steps away from it (the far side is the same grid turned 180°)
    // ponytail: assumes the spine runs the band's full length; a concave site that cuts the spine leaves
    // that first row without a real street (flagged nowhere yet).
    for (const [side, ylo, yhi] of [[1, aw / 2, sy1 + 1], [-1, sy0 - 1, -aw / 2]] as const) {
      for (const half of clip(toLoc(band.geometry), rect(bx0 + left, ylo, bx1 - right, yhi))) {
        const sub = subdivide(toGeo(half), { plotWidth: w, plotDepth: d, roadWidth: rw, plotsPerBlock: b.plotsPerBlock, angle: side > 0 ? axis : axis + 180, origin: c, startY: aw / 2 - rw, minArea: w * d * 0.5, minFrontage: w * 0.6 })
        const kept = clearRoads(sub.plots, [...spineSurfaces, ...crossSurfaces, ...keep] as any, w * d * 0.5)
        // back-row plots at a band end, and the leftover column at the site edge, may have no street behind
        // them but front the cross street or local street beside them
        const beside = [...crossRoads, ...sub.roads.map((g) => ({ geometry: g, properties: { attrs: { width: rw } } }))] as unknown as PlanFeature[]
        for (const p of kept) if (p.frontage === 0) {
          const fr = Math.round(measureFrontage(p.geometry, beside) * 10) / 10
          if (fr > 0) Object.assign(p, { frontage: fr, issue: plotIssue(p.area, fr, { minPlotArea: w * d * 0.5, minFrontage: w * 0.6 }) })
        }
        // still no street: a sliver the site edge cut off behind a full plot. Not a plot; the land stays in the zone.
        // ponytail: dropped, not merged into the plot in front (merge if that land should be sold)
        for (const p of kept.filter((p) => p.frontage > 0)) {
          const block = `B${Number(p.block.slice(1)) + blocks}`
          plots.push({ ...p, block, number: p.number.replace(/^B\d+/, block), zone, band: band.index + 1 })
        }
        blocks += Math.max(0, ...kept.map((p) => Number(p.block.slice(1)))) // number blocks on across both halves
        // local streets stop at the arterial: drop the parts that run inside its corridor (or an existing road's)
        for (const g of sub.roads) if (![...spineSurfaces, ...keptRoads].some((s) => turf.booleanWithin(turf.feature(g), s as any))) locals.push(g)
      }
    }
  }
  // join street ends to the street, arterial or existing road they stop short of (half a right-of-way away)
  const fixed = [...spine, ...links, ...existing.roads.map((r) => r.geometry)]
  const joined = connectEnds([...fixed, ...locals], Math.max(aw, rw) / 2 + 1, fixed.length)
  joined.slice(fixed.length).forEach((g, i) => drafts.push(street(g, i < crossCount ? 'Cross street' : 'Local street')))

  // where roads meet water: the spine, links and cross streets bridge it (up to MAX_SPAN), other streets stop at the bank
  // ponytail: bridges are costed as ordinary road; plot frontage isn't re-measured where a street was cut back
  const bridges: number[] = []
  if (existing.water.length) {
    const wet = existing.water.length === 1 ? turf.feature(existing.water[0]) : turf.union(turf.featureCollection(existing.water.map((w) => turf.feature(w))))!
    const roads = drafts.flatMap((d): Draft[] => {
      if (componentDef(d.type).layer !== 'roads' || d.geometry.type !== 'LineString') return [d]
      const major = d.type === 'road-arterial' || d.name === 'Cross street'
      const pieces = turf.lineSplit(turf.feature(d.geometry), wet as any).features
      return (pieces.length ? pieces : [turf.feature(d.geometry)]).flatMap((piece): Draft[] => {
        const len = turf.length(piece, { units: 'meters' })
        if (!turf.booleanPointInPolygon(turf.along(piece, len / 2, { units: 'meters' }), wet as any)) return [{ ...d, geometry: piece.geometry }]
        if (!major || len > MAX_SPAN) return []
        bridges.push(len)
        return [{ ...d, geometry: piece.geometry, attrs: { ...d.attrs, structure: 'bridge' }, name: `Bridge (${d.name})` }]
      })
    })
    drafts.splice(0, drafts.length, ...roads)
  }

  // 3. facilities: one per N residents, on the largest valid institutional plots first, then spread through housing
  const facilities: Record<string, number> = {}
  const free = plots.filter((p) => !p.issue)
  const civic = free.filter((p) => p.zone === 'institutional').sort((p, q) => q.area - p.area)
  const homes = free.filter((p) => p.zone === 'residential')
  const used = new Set<GeneratedPlot>()
  for (const [k, per] of Object.entries(b.facilities) as [keyof Brief['facilities'], number][]) {
    if (!per) continue
    const n = Math.max(1, Math.ceil(b.targetPopulation / per))
    facilities[k] = 0
    for (let i = 0; i < n; i++) {
      const spot = civic.find((p) => !used.has(p)) ?? homes.filter((p) => !used.has(p))[Math.floor(((i + 0.5) / n) * Math.max(1, homes.length - used.size))]
      if (!spot) break
      used.add(spot)
      const def = COMPONENTS.find((x) => x.type === FACILITY_TYPE[k])!
      const pc = turf.centroid(spot.geometry).geometry.coordinates
      const sb = 2 * (ruleset.rules.institutional?.setback ?? 3) // both sides
      let bw = Math.max(8, Math.min(def.w ?? 20, spot.frontage - sb || def.w || 20)), bd = Math.max(8, Math.min(def.d ?? 20, spot.depth - sb))
      // keep ground coverage ≤ 45% so the generic institutional controls (≤ 50%) are met
      const cov = Math.min(1, Math.sqrt((0.45 * spot.area) / (bw * bd)))
      bw = Math.round(bw * cov * 10) / 10; bd = Math.round(bd * cov * 10) / 10
      drafts.push({ type: def.type, geometry: footprint(pc, bw, bd, axis), attrs: { ...tag, width: bw, depth: bd, rotation: axis, floors: def.floors ?? 1, height: +((def.floors ?? 1) * FLOOR_HEIGHT).toFixed(1), zoning: 'institutional' } })
      spot.zone = 'institutional' as Zone
      facilities[k]++
    }
  }
  // 4. infill: a fitted building on every other buildable plot; dwellings follow the buildings (zoning.ts rules)
  let units = 0
  if (b.fillBuildings)
    for (const p of free) {
      if (used.has(p)) continue
      const bld = fillPlot(p, p.zone, ruleset.rules[p.zone], housing, axis, tag)
      if (!bld) continue
      drafts.push(bld)
      units += unitsOf(bld.type, turf.area(bld.geometry as Polygon) * Number(bld.attrs.floors))
    }
  for (const p of plots)
    drafts.push({ type: 'plot', geometry: p.geometry, name: `Plot ${p.zone[0].toUpperCase()}${p.band}-${p.number}`, attrs: { ...tag, plotNo: `${p.zone[0].toUpperCase()}${p.band}-${p.number}`, block: p.block, frontage: p.frontage, depth: p.depth, angle: p.angle, face: p.face, zoning: p.zone, status: used.has(p) ? 'reserved' : 'planned', ...(p.issue && { issue: p.issue }) } })

  // 5. metrics and checks against the brief
  const roadDrafts = drafts.filter((d) => componentDef(d.type).layer === 'roads' && d.geometry.type === 'LineString')
  const roadArea = roadDrafts.reduce((s, d) => s + turf.length(turf.feature(d.geometry), { units: 'meters' }) * Number(d.attrs.width), 0)
  const residentialPlots = plots.filter((p) => p.zone === 'residential' && !p.issue && !used.has(p)).length
  const dwellings = residentialPlots + units // one per residential plot + flats in multi-unit buildings, as stats() counts
  const population = dwellings * b.personsPerDwelling
  const gfa = drafts.filter((d) => Number(d.attrs.floors) > 0).reduce((s, d) => s + turf.area(d.geometry as Polygon) * Number(d.attrs.floors), 0)
  const siteArea = turf.area(site)
  const roadCost = roadArea * b.roadCostPerM2, buildingCost = gfa * b.buildingCostPerM2
  const greenShare = (landUse.green ?? 0) / siteArea * 100
  const checks: Proposal['checks'] = [
    { label: 'Population capacity', ok: population >= b.targetPopulation * 0.95, detail: `${population.toLocaleString()} of ${b.targetPopulation.toLocaleString()} target (${dwellings} dwellings)` },
    { label: 'Green space', ok: greenShare >= b.mix.green / total * 100 - 1, detail: `${greenShare.toFixed(1)}% of site (target ${(b.mix.green / total * 100).toFixed(0)}%)` },
    { label: 'Facilities placed', ok: Object.entries(facilities).every(([k, n]) => n >= Math.ceil(b.targetPopulation / b.facilities[k as keyof Brief['facilities']])), detail: Object.entries(facilities).map(([k, n]) => `${n} ${k}`).join(', ') || 'none requested' },
    { label: 'Road share', ok: roadArea / siteArea <= 0.35, detail: `${(roadArea / siteArea * 100).toFixed(1)}% of site (guide ≤ 35%)` },
  ]
  if (existing.water.length) checks.push({ label: 'Water left undeveloped', ok: !plots.some((p) => existing.water.some((w) => turf.booleanIntersects(p.geometry, w))), detail: `${bridges.length} bridge(s)${bridges.length ? `, ${Math.round(bridges.reduce((a, x) => a + x, 0))} m` : ''}` })
  if (existing.roads.length) checks.push({ label: 'Joins existing roads', ok: linkedTo.size > 0, detail: linkedTo.size ? `${linkedTo.size} existing road(s), ${links.length} new link(s)` : `none within ${LINK_REACH} m` })
  if (b.budget > 0) checks.push({ label: 'Budget (roads + buildings)', ok: roadCost + buildingCost <= b.budget, detail: `${Math.round(roadCost + buildingCost).toLocaleString()} of ${b.budget.toLocaleString()}` })
  return {
    label: `Layout ${v.order}${v.angleOffset ? ' (rotated 90°)' : ''}`, variant: v, drafts,
    metrics: { siteArea, roadArea, plots: plots.length, residentialPlots, dwellings, population, facilities, landUse, roadCost, buildingCost },
    checks, linkedTo: [...linkedTo],
  }
}

/**
 * The first `hectares` of a boundary, cut across its long axis from one end (`fromEnd` = the other end).
 * Returns the whole boundary when the request covers it.
 * ponytail: one straight cut from an end; pick-a-spot / free-shape portions need a drawn sub-boundary.
 */
export function portionOf(site: Polygon, hectares: number, fromEnd = false): Polygon {
  const total = turf.area(site) / 10000
  if (hectares >= total * 0.999) return site
  const f = frame(turf.centroid(site).geometry.coordinates)
  const axis = -((orientedBox(site.coordinates[0].map((p) => f.toLocal(p) as [number, number])).angle * 180) / Math.PI)
  const want = Math.max(0.01, hectares), shares = fromEnd ? [total - want, want] : [want, total - want]
  const parts = splitPolygonShares(site, shares, axis, 'frontage').filter((p) => p.index === (fromEnd ? 1 : 0))
  return parts.sort((a, b) => turf.area(b.geometry) - turf.area(a.geometry))[0]?.geometry ?? site
}

/** Square site of `hectares` centred on `center` (when no boundary is drawn). */
export const squareSite = (center: Position, hectares: number): Polygon => {
  const side = Math.sqrt(hectares * 10000)
  return footprint(center, side, side)
}
