import * as turf from '@turf/turf'
import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson'
import { clearRoads, footprint, frame, plotIssue, roadSurface, subdivide, unitsOf, type GeneratedPlot } from './geo'
import { connectEnds, measureFrontage } from './roads'
import { fillPlot, housingType, plotSizeFor, residentialPlotSize } from './infill'
import { COMPONENTS, FLOOR_HEIGHT, GENERIC_RULESET, ROAD_CLASSES, type PlanFeature, type Ruleset } from './model'
import type { Brief, Draft, Existing, Proposal, Variant } from './masterplan'

/**
 * "Build on the existing roads": the surveyed roads crossing the site are the street frame, the land between
 * them is cut into blocks, and each block is subdivided along the road it fronts (new local streets in deep
 * blocks). Preliminary, like every generated layout. masterplan.ts (`generatePlan`) is deliberately untouched.
 */
export interface Block {
  geometry: Polygon
  /** Street direction, degrees clockwise from east (the project convention). */
  angle: number
  /** Index into `existing.roads` of the road the block fronts, -1 none. */
  frontRoad: number
  frontWidth: number
  area: number
}

/** Clearance kept around existing buildings and from water (m), as in masterplan.ts. */
const CLEARANCE = 3, WATER_SETBACK = 10
/** A road serves a block (or the site) when its centreline is within half its width + REACH_M of it. */
const REACH_M = 2

const surface = (g: LineString, width: number) => roadSurface(turf.feature(g), width)
const pieces = (g: Polygon | MultiPolygon): Polygon[] => g.type === 'Polygon' ? [g] : g.coordinates.map((c) => ({ type: 'Polygon', coordinates: c }))

/** Length (m) of `line` inside `poly`. */
function lengthInside(line: LineString, poly: Feature<Polygon | MultiPolygon>): number {
  const parts = turf.lineSplit(turf.feature(line), poly as any).features
  return (parts.length ? parts : [turf.feature(line)]).reduce((s, p) => {
    const len = turf.length(p, { units: 'meters' })
    return turf.booleanPointInPolygon(turf.along(p, len / 2, { units: 'meters' }), poly as any) ? s + len : s
  }, 0)
}

/** Road surfaces (of the roads serving the site) and clearances, built once per generation. */
interface Cuts { used: number[]; surfaces: Feature<Polygon | MultiPolygon>[]; clear: Feature<Polygon | MultiPolygon>[] }
function cutsFor(site: Polygon, existing: Existing): Cuts {
  const roads = existing.roads, box = turf.bbox(turf.buffer(turf.feature(site), 50, { units: 'meters' })!)
  const near = (g: LineString | Polygon) => { const b = turf.bbox(g); return b[0] <= box[2] && box[0] <= b[2] && b[1] <= box[3] && box[1] <= b[3] }
  const used = roads.flatMap((r, i) => { if (!near(r.geometry)) return []; const s = surface(r.geometry, r.width + 2 * REACH_M); return s && turf.booleanIntersects(s, site) ? [i] : [] })
  return {
    used,
    surfaces: used.map((i) => surface(roads[i].geometry, roads[i].width)!).filter(Boolean),
    clear: [
      ...existing.obstacles.filter(near).map((o) => turf.buffer(turf.feature(o), CLEARANCE, { units: 'meters' })),
      ...existing.water.filter(near).map((w) => turf.buffer(turf.feature(w), WATER_SETBACK, { units: 'meters' })),
    ].filter((x) => !!x) as Feature<Polygon | MultiPolygon>[],
  }
}
const overlaps = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/**
 * What the existing roads leave: the roads serving the site, their length inside it and the blocks between them.
 * Pieces smaller than `minArea` or narrower than `minWidth` (a dual carriageway's median, a sliver at a corner)
 * stay open land.
 */
export function analyseRoads(site: Polygon, existing: Existing, minArea: number, minWidth = 0, cuts = cutsFor(site, existing)): { used: number[]; lengthM: number; blocks: Block[] } {
  const roads = existing.roads, { used } = cuts
  const all = [...cuts.surfaces, ...cuts.clear]
  const rest = all.length ? turf.difference(turf.featureCollection([turf.feature(site), ...all] as Feature<Polygon | MultiPolygon>[]))?.geometry : site
  const siteF = turf.feature(site)
  const lengthM = used.reduce((s, i) => s + lengthInside(roads[i].geometry, siteF), 0)
  const maxHalf = Math.max(0, ...used.map((i) => roads[i].width)) / 2 + REACH_M
  const boxes = used.map((i) => turf.bbox(roads[i].geometry))
  const blocks: Block[] = []
  for (const g of rest ? pieces(rest) : []) {
    const area = turf.area(g)
    // ponytail: slivers stay open land, not merged into a neighbour
    if (area < minArea || (minWidth > 0 && !turf.buffer(turf.feature(g), -minWidth / 2, { units: 'meters' }))) continue
    const c = turf.centroid(g).geometry.coordinates
    // the road the block fronts along the greatest length; else the nearest one
    // within half the road's own width + REACH_M of the block (one buffer per distinct width)
    const reaches = new Map<number, Feature<Polygon | MultiPolygon>>()
    const reachFor = (half: number) => reaches.get(half) ?? reaches.set(half, turf.buffer(turf.feature(g), half, { units: 'meters' })!).get(half)!
    const rb = turf.bbox(reachFor(maxHalf))
    let front = -1, best = 0
    used.forEach((i, k) => {
      if (!overlaps(rb, boxes[k])) return
      const len = lengthInside(roads[i].geometry, reachFor(roads[i].width / 2 + REACH_M))
      // near-equal frontage (a corner block): face the wider road
      if (len > best * 1.01 || (len > 0 && len >= best * 0.99 && roads[i].width > roads[front].width)) { best = Math.max(best, len); front = i }
    })
    if (front < 0) {
      const cands = used.length ? used : roads.map((_, i) => i)
      let d = Infinity
      for (const i of cands) { const x = turf.pointToLineDistance(c, turf.feature(roads[i].geometry), { units: 'meters' }); if (x < d) { d = x; front = i } }
    }
    let angle = 0
    if (front >= 0) {
      const line = roads[front].geometry, k = Math.min(turf.nearestPointOnLine(turf.feature(line), c).properties.index ?? 0, line.coordinates.length - 2)
      const fr = frame(c), [x0, y0] = fr.toLocal(line.coordinates[k]), [x1, y1] = fr.toLocal(line.coordinates[k + 1])
      angle = -(Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI
    }
    blocks.push({ geometry: g, angle, frontRoad: front, frontWidth: front >= 0 ? roads[front].width : 0, area })
  }
  return { used, lengthM, blocks }
}

const asRoad = (geometry: LineString, width: number) => ({ geometry, properties: { attrs: { width } } }) as unknown as PlanFeature

/**
 * Plots (and new local streets) for one block, the first row facing the road it fronts. The grid is laid on both
 * sides of that road, so a road ending inside the block (a dead end) gets plots on either side of it. Frontage is
 * measured later (`generateOnRoads`), once the new streets are joined to the network.
 * ponytail: a straight grid along the road's local direction; on a strongly curved edge some plots miss
 * frontage and are dropped. Streets are not checked against existing buildings (as in generatePlan).
 */
export function layoutBlock(block: Block, existing: Existing, b: Brief, w: number, d: number, cuts: Cuts): { plots: GeneratedPlot[]; streets: LineString[]; rules: { minPlotArea: number; minFrontage: number } } {
  const rw = b.localStreetWidth, roads = existing.roads
  const c = turf.centroid(block.geometry).geometry.coordinates
  const rules = { minArea: w * d * 0.5, minFrontage: w * 0.6 }
  const opts = { plotWidth: w, plotDepth: d, roadWidth: rw, plotsPerBlock: b.plotsPerBlock, ...rules }
  const subs = block.frontRoad < 0
    ? [subdivide(block.geometry, { ...opts, angle: block.angle })]
    : [0, 180].map((turn) => subdivide(block.geometry, { ...opts, angle: block.angle + turn, origin: turf.nearestPointOnLine(turf.feature(roads[block.frontRoad].geometry), c).geometry.coordinates, startY: block.frontWidth / 2 - rw }))
  // the far side's blocks are numbered on (B1, B2… then B1b, B2b…) so plot numbers stay unique
  const plots = subs.flatMap((s, k) => k ? s.plots.map((p) => ({ ...p, block: `${p.block}b`, number: p.number.replace(/^(B\d+)/, '$1b') })) : s.plots)
  const streetsAll = subs.flatMap((s) => s.roads)
  const bb = turf.bbox(turf.buffer(turf.feature(block.geometry), 30, { units: 'meters' })!)
  const near = <T extends Feature>(fs: T[]) => fs.filter((x) => overlaps(turf.bbox(x), bb))
  const surfaces = near(cuts.surfaces)
  return {
    plots: clearRoads(plots, near([...cuts.surfaces, ...cuts.clear]), rules.minArea),
    streets: streetsAll.filter((g) => !surfaces.some((s) => turf.booleanWithin(turf.feature(g), s as any))),
    rules: { minPlotArea: rules.minArea, minFrontage: rules.minFrontage },
  }
}

type Zone = 'residential' | 'commercial' | 'industrial' | 'institutional' | 'green'
const PLOT: Record<'commercial' | 'industrial' | 'institutional', [number, number]> = { commercial: [25, 40], industrial: [50, 60], institutional: [60, 60] }
const FACILITY_TYPE: Record<keyof Brief['facilities'], string> = { school: 'school', clinic: 'clinic', police: 'police', fire: 'fire', community: 'community', religious: 'religious' }

/**
 * One land use per block, by area share of the mix. Blocks on the widest roads go commercial (then
 * institutional), industry takes the blocks farthest from `centre`; green takes the least regular blocks (A)
 * or the largest ones as a central park (B); B also lets housing pick before institutional. The rest is housing.
 */
export function zoneBlocks(blocks: Block[], mix: Brief['mix'], order: 'A' | 'B', centre: Position): Zone[] {
  const total = Object.values(mix).reduce((a, x) => a + Math.max(0, x), 0) || 1
  const sum = blocks.reduce((s, x) => s + x.area, 0)
  const idx = blocks.map((_, i) => i)
  const ranked = [...idx].sort((i, j) => blocks[j].frontWidth - blocks[i].frontWidth || blocks[j].area - blocks[i].area)
  const dist = (i: number) => turf.distance(centre, turf.centroid(blocks[i].geometry), { units: 'meters' })
  const regular = (i: number) => blocks[i].area / turf.length(turf.polygonToLine(turf.feature(blocks[i].geometry)) as any, { units: 'meters' }) ** 2
  const zones: (Zone | undefined)[] = blocks.map(() => undefined)
  const take = (z: Zone, cands: number[]) => {
    const target = (Math.max(0, mix[z]) / total) * sum
    let got = 0
    for (const i of cands) {
      if (got >= target) break
      // whole blocks only, never past the share (housing takes what's left, so overshoots would add up against
      // it); a share of at least half a block still gets its first block
      if (zones[i] || (got + blocks[i].area > target && (got > 0 || blocks[i].area / 2 > target))) continue
      zones[i] = z; got += blocks[i].area
    }
  }
  take('commercial', ranked)
  take('industrial', [...idx].sort((i, j) => dist(j) - dist(i)))
  take('green', order === 'A' ? [...idx].sort((i, j) => regular(i) - regular(j)) : [...idx].sort((i, j) => blocks[j].area - blocks[i].area))
  if (order === 'B') take('residential', ranked)
  take('institutional', ranked)
  return zones.map((z) => z ?? 'residential')
}

export function generateOnRoads(site: Polygon, b: Brief, v: Variant, ruleset: Ruleset = GENERIC_RULESET, existing: Existing = { roads: [], obstacles: [], water: [] }): Proposal {
  const tag = { plan: `roads-${v.order}` }
  const housing = housingType(b.density)
  const res: [number, number] = b.fillBuildings ? residentialPlotSize(housing, b.density, ruleset.rules.residential?.setback) : plotSizeFor(b.density)
  const cuts = cutsFor(site, existing)
  const a = analyseRoads(site, existing, res[0] * res[1], res[1], cuts)
  const zones = zoneBlocks(a.blocks, b.mix, v.order, turf.centroid(site).geometry.coordinates)
  const drafts: Draft[] = []
  const rw = b.localStreetWidth
  let plots: (GeneratedPlot & { zone: Zone; blockNo: number; rules: { minPlotArea: number; minFrontage: number } })[] = []
  const streets: LineString[] = []
  const landUse: Record<string, number> = {}
  a.blocks.forEach((blk, i) => {
    const zone = zones[i]
    landUse[zone] = (landUse[zone] ?? 0) + blk.area
    drafts.push({ type: 'zone', geometry: blk.geometry, attrs: { ...tag, zoning: zone }, name: `${zone[0].toUpperCase()}${zone.slice(1)} area` })
    if (zone === 'green') { drafts.push({ type: 'park', geometry: blk.geometry, attrs: { ...tag, zoning: 'green' }, name: 'Park' }); return }
    const [w, d] = zone === 'residential' ? res : PLOT[zone]
    const out = layoutBlock(blk, existing, b, w, d, cuts)
    plots.push(...out.plots.map((p) => ({ ...p, zone, blockNo: i + 1, rules: out.rules })))
    streets.push(...out.streets)
  })
  // ponytail: new streets stop at water (no bridges, unlike generatePlan)
  const fixed = a.used.map((i) => existing.roads[i].geometry)
  const maxW = Math.max(rw, ...a.used.map((i) => existing.roads[i].width))
  const joined = connectEnds([...fixed, ...streets], maxW / 2 + 1, fixed.length).slice(fixed.length)
  for (const g of joined)
    drafts.push({ type: 'road-local', geometry: g, attrs: { ...tag, width: rw, lanes: 2, sidewalk: ROAD_CLASSES.local.sidewalk, roadClass: 'local' }, name: 'Local street' })
  // frontage measured on the final network (joining can tilt a street whose end was snapped sideways):
  // a plot that fronts no road or street is not a plot, its land stays in the zone
  const beside = [...a.used.map((i) => asRoad(existing.roads[i].geometry, existing.roads[i].width)), ...joined.map((g) => asRoad(g, rw))]
  const boxes = beside.map((r) => turf.bbox(r.geometry)), pad = 0.0005 // ≈ 50 m in degrees
  plots = plots.filter((p) => {
    const [x0, y0, x1, y1] = turf.bbox(p.geometry)
    const fr = Math.round(measureFrontage(p.geometry, beside.filter((_, k) => overlaps([x0 - pad, y0 - pad, x1 + pad, y1 + pad], boxes[k]))) * 10) / 10
    Object.assign(p, { frontage: fr, issue: plotIssue(p.area, fr, p.rules) })
    return fr > 0
  })

  // ponytail: copy of masterplan.ts steps 3–5, keep in sync (the user chose not to touch masterplan.ts).
  // Differences: buildings follow their plot's angle, road area/cost counts only new streets, no water/link checks.
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
      drafts.push({ type: def.type, geometry: footprint(pc, bw, bd, spot.angle), attrs: { ...tag, width: bw, depth: bd, rotation: spot.angle, floors: def.floors ?? 1, height: +((def.floors ?? 1) * FLOOR_HEIGHT).toFixed(1), zoning: 'institutional' } })
      spot.zone = 'institutional'
      facilities[k]++
    }
  }
  // 4. infill: a fitted building on every other buildable plot; dwellings follow the buildings
  let units = 0
  if (b.fillBuildings)
    for (const p of free) {
      if (used.has(p)) continue
      const bld = fillPlot(p, p.zone, ruleset.rules[p.zone], housing, p.angle, tag)
      if (!bld) continue
      drafts.push(bld)
      units += unitsOf(bld.type, turf.area(bld.geometry as Polygon) * Number(bld.attrs.floors))
    }
  for (const p of plots) {
    const no = `${p.zone[0].toUpperCase()}${p.blockNo}-${p.number}`
    drafts.push({ type: 'plot', geometry: p.geometry, name: `Plot ${no}`, attrs: { ...tag, plotNo: no, block: p.block, frontage: p.frontage, depth: p.depth, angle: p.angle, face: p.face, zoning: p.zone, status: used.has(p) ? 'reserved' : 'planned', ...(p.issue && { issue: p.issue }) } })
  }

  // 5. metrics and checks against the brief
  const roadArea = drafts.filter((x) => x.name === 'Local street').reduce((s, x) => s + turf.length(turf.feature(x.geometry as LineString), { units: 'meters' }) * rw, 0)
  const residentialPlots = plots.filter((p) => p.zone === 'residential' && !p.issue && !used.has(p)).length
  const dwellings = residentialPlots + units
  const population = dwellings * b.personsPerDwelling
  const gfa = drafts.filter((x) => Number(x.attrs.floors) > 0).reduce((s, x) => s + turf.area(x.geometry as Polygon) * Number(x.attrs.floors), 0)
  const siteArea = turf.area(site)
  const roadCost = roadArea * b.roadCostPerM2, buildingCost = gfa * b.buildingCostPerM2
  const total = Object.values(b.mix).reduce((s, x) => s + Math.max(0, x), 0) || 1
  const greenShare = (landUse.green ?? 0) / siteArea * 100
  const checks: Proposal['checks'] = [
    { label: 'Population capacity', ok: population >= b.targetPopulation * 0.95, detail: `${population.toLocaleString()} of ${b.targetPopulation.toLocaleString()} target (${dwellings} dwellings)` },
    { label: 'Green space', ok: greenShare >= b.mix.green / total * 100 - 1, detail: `${greenShare.toFixed(1)}% of site (target ${(b.mix.green / total * 100).toFixed(0)}%)` },
    { label: 'Facilities placed', ok: Object.entries(facilities).every(([k, n]) => n >= Math.ceil(b.targetPopulation / b.facilities[k as keyof Brief['facilities']])), detail: Object.entries(facilities).map(([k, n]) => `${n} ${k}`).join(', ') || 'none requested' },
    { label: 'Road share', ok: roadArea / siteArea <= 0.35, detail: `${(roadArea / siteArea * 100).toFixed(1)}% of site (guide ≤ 35%)` },
  ]
  if (a.used.length) checks.push({ label: 'Road analysis', ok: true, detail: `${a.used.length} existing roads, ${(a.lengthM / 1000).toFixed(1)} km, ${a.blocks.length} blocks, average ${(a.blocks.reduce((s, x) => s + x.area, 0) / Math.max(1, a.blocks.length) / 10000).toFixed(1)} ha` })
  if (!a.blocks.length) checks.push({ label: 'Buildable blocks', ok: false, detail: 'none found' })
  if (b.budget > 0) checks.push({ label: 'Budget (roads + buildings)', ok: roadCost + buildingCost <= b.budget, detail: `${Math.round(roadCost + buildingCost).toLocaleString()} of ${b.budget.toLocaleString()}` })
  return {
    label: `Road-based layout ${v.order}`, variant: v, drafts,
    metrics: { siteArea, roadArea, plots: plots.length, residentialPlots, dwellings, population, facilities, landUse, roadCost, buildingCost },
    checks, linkedTo: a.used,
  }
}
