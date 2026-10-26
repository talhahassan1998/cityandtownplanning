import * as turf from '@turf/turf'
import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson'
import { componentDef, ROAD_CLASSES, uid, type Attrs, type Layer, type PlanFeature, type Settings } from './model'

// --- local planar frame -----------------------------------------------------
// Equirectangular metres around an origin. Error < 0.1% over a few km, which is
// what subdivision/footprints need. ponytail: swap for proj4 + per-project UTM
// when projects span tens of km.
const M_PER_DEG_LAT = 110574
const mPerDegLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180)

export function frame(origin: Position, angleDeg = 0) {
  const kx = mPerDegLng(origin[1])
  const a = (angleDeg * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  return {
    toLocal: ([lng, lat]: Position): Position => {
      const x = (lng - origin[0]) * kx, y = (lat - origin[1]) * M_PER_DEG_LAT
      return [x * cos + y * sin, -x * sin + y * cos] // rotate by -angle
    },
    toGeo: ([x, y]: Position): Position => {
      const gx = x * cos - y * sin, gy = x * sin + y * cos
      return [round(origin[0] + gx / kx), round(origin[1] + gy / M_PER_DEG_LAT)]
    },
  }
}
const round = (v: number) => Math.round(v * 1e9) / 1e9

// --- rotate by dragging (3D ring, 2D knob) -----------------------------------------
type XZ = { x: number; z: number }
/** Rotation (degrees, clockwise seen from above) dragging from `from` to `to` around `center`, in (−180, 180]; 15° steps unless `free`. */
export function ringAngle(center: XZ, from: XZ, to: XZ, free: boolean): number {
  // scene z / screen y point south, so atan2(z, x) grows clockwise when seen from above
  const a = (p: XZ) => (Math.atan2(p.z - center.z, p.x - center.x) * 180) / Math.PI
  let d = a(to) - a(from)
  d = ((d % 360) + 540) % 360 - 180
  if (d === -180) d = 180
  return free ? d : Math.round(d / 15) * 15
}


/** Screen position of the 2D rotate knob: centred over the shape's screen box, `gap` px above its top (default beyond Terra Draw's 40 px grab distance, so dragging the knob never also drags an edge handle). */
export function knobPoint(screen: [number, number][], gap = 48): [number, number] {
  const xs = screen.map((p) => p[0]), ys = screen.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...ys) - gap]
}

/** Copy with every coordinate rounded to 9 decimals (≈0.1 mm): the map editor (Terra Draw) refuses finer coordinates. */
export function roundGeometry<G extends { coordinates: unknown }>(g: G): G {
  const r = (c: unknown): unknown => (typeof c === 'number' ? round(c) : (c as unknown[]).map(r))
  return { ...g, coordinates: r(g.coordinates) }
}

/**
 * Linear map from frame(origin) metres (east, north) to web-mercator units (0..1, y south): built from the frame's
 * own degree scales, so it undoes toLocal exactly (to first order). MapLibre's "metres" are a sphere's, ≈0.6% off
 * the frame's north scale — using them put the 3D layer ~30 m off at 5 km from the origin.
 * ponytail: one linearisation at the origin; the curvature residual is ≈1.5 m at 5 km, ≈25 m at 20 km.
 */
export function frameToMercator(origin: Position) {
  const lat = (origin[1] * Math.PI) / 180
  return {
    x0: (180 + origin[0]) / 360,
    y0: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat / 2))) / 360,
    sx: 1 / (360 * mPerDegLng(origin[1])),
    sy: 1 / (360 * Math.cos(lat) * M_PER_DEG_LAT),
  }
}

// --- footprints & transforms --------------------------------------------------
/** Rectangle of width×depth metres centred on `center`, rotated clockwise by `rotation` degrees. */
export function footprint(center: Position, width: number, depth: number, rotation = 0): Polygon {
  const f = frame(center, -rotation)
  const w = width / 2, d = depth / 2
  const ring = [[-w, -d], [w, -d], [w, d], [-w, d], [-w, -d]].map(f.toGeo)
  return { type: 'Polygon', coordinates: [ring] }
}

/** Short horizontal line of `length` metres centred on `center` (for dropped roads/pipes). */
export function lineAt(center: Position, length = 120): LineString {
  const f = frame(center)
  return { type: 'LineString', coordinates: [[-length / 2, 0], [length / 2, 0]].map(f.toGeo) }
}

export const center = (f: Feature): Position => turf.centroid(f).geometry.coordinates

export function translate<T extends Feature>(f: T, dxMeters: number, dyMeters: number): T {
  const c = center(f)
  const dx = dxMeters / mPerDegLng(c[1]), dy = dyMeters / M_PER_DEG_LAT
  return { ...f, geometry: mapCoords(f.geometry, (p) => [round(p[0] + dx), round(p[1] + dy)]) }
}

function mapCoords<G extends Feature['geometry']>(g: G, fn: (p: Position) => Position): G {
  const walk = (c: unknown): unknown => (typeof (c as number[])[0] === 'number' ? fn(c as Position) : (c as unknown[]).map(walk))
  return { ...g, coordinates: walk((g as Polygon).coordinates) } as G
}

export const rotate = <T extends Feature>(f: T, deg: number): T =>
  ({ ...f, geometry: turf.transformRotate(f, deg, { pivot: center(f) }).geometry })

export const scale = <T extends Feature>(f: T, factor: number): T =>
  ({ ...f, geometry: turf.transformScale(f, factor, { origin: center(f) }).geometry })

// --- measurement -----------------------------------------------------------------
export interface Measure { area: number; perimeter: number; length: number }

export function measure(f: Feature): Measure {
  const g = f.geometry
  if (g.type === 'Polygon' || g.type === 'MultiPolygon')
    return { area: turf.area(f), perimeter: turf.length(turf.polygonToLine(f as Feature<Polygon>) as Feature, { units: 'meters' }), length: 0 }
  if (g.type === 'LineString') return { area: 0, perimeter: 0, length: turf.length(f, { units: 'meters' }) }
  return { area: 0, perimeter: 0, length: 0 }
}

/** Road/pipe surface polygon: centreline buffered by half its width. */
export function roadSurface(f: Feature<LineString>, width: number): Feature<Polygon | MultiPolygon> | undefined {
  if (width <= 0 || f.geometry.coordinates.length < 2) return undefined
  return turf.buffer(f, width / 2, { units: 'meters', steps: 4 })
}

// --- subdivision ----------------------------------------------------------------
export interface SubdivideOptions {
  plotWidth: number    // frontage along the street (m)
  plotDepth: number    // m
  roadWidth: number    // local street right-of-way (m)
  plotsPerBlock: number // plots along a street before a cross street
  angle: number        // street orientation, degrees clockwise from east-west
  minArea: number      // m²
  minFrontage: number  // m
  /** Frame origin shared by several calls so their street grids line up (default: the boundary centroid). */
  origin?: Position
  /** Local y of the first street (in the `origin` frame). That street is taken to exist already
   * (e.g. an arterial alongside): the first row of plots fronts it and no line is emitted for it. */
  startY?: number
}

export interface GeneratedPlot { geometry: Polygon; block: string; number: string; area: number; frontage: number; depth: number; angle: number; face: 'min' | 'max'; issue?: string }

export interface PlotRules { minPlotArea?: number; minFrontage?: number }

/** Planning check for a plot. `frontage` undefined = unknown (hand-drawn plot), so access isn't checked. */
export function plotIssue(area: number, frontage: number | undefined, r: PlotRules): string | undefined {
  if (frontage === 0) return 'No street access'
  if (r.minPlotArea && area < r.minPlotArea) return `Area below ${r.minPlotArea} m²`
  if (frontage !== undefined && r.minFrontage && frontage < r.minFrontage) return `Frontage below ${r.minFrontage} m`
  return undefined
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Polygon =>
  ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] })

export function clip(a: Polygon, b: Polygon): Polygon[] {
  const r = turf.intersect(turf.featureCollection([turf.polygon(a.coordinates), turf.polygon(b.coordinates)]))
  if (!r) return []
  return r.geometry.type === 'Polygon' ? [r.geometry] : r.geometry.coordinates.map((c) => ({ type: 'Polygon', coordinates: c }))
}

const ringArea = (r: Position[]) => Math.abs(r.reduce((s, p, i) => (i ? s + (r[i - 1][0] * p[1] - p[0] * r[i - 1][1]) : 0), 0) / 2)
export const planarArea = (p: Polygon) => ringArea(p.coordinates[0]) - p.coordinates.slice(1).reduce((s, h) => s + ringArea(h), 0)
const round1 = (v: number) => Math.round(v * 10) / 10
const bbox = (p: Polygon) => turf.bbox(p) as [number, number, number, number]

/** Extent along x of the plot edge lying on the street line y = yFace. */
function frontageOn(p: Polygon, yFace: number) {
  const xs = p.coordinates[0].filter((q) => Math.abs(q[1] - yFace) < 0.01).map((q) => q[0])
  return xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0
}

/**
 * Splits a boundary into street-fronting plots arranged back-to-back between parallel
 * local streets, with a cross street every `plotsPerBlock` plots. Plots that fail
 * minimum area / frontage / access are returned with `issue` set, never dropped silently;
 * only remnant slivers (< 25% of a nominal plot) are left as unallocated land.
 */
export function subdivide(boundary: Polygon, o: SubdivideOptions): { plots: GeneratedPlot[]; roads: LineString[] } {
  const f = frame(o.origin ?? turf.centroid(boundary).geometry.coordinates, -o.angle)
  // mm-rounded so edges shared with the street grid coincide exactly (near-coincident edges break polygon clipping)
  const mm = (v: number) => Math.round(v * 1000) / 1000
  const poly: Polygon = { type: 'Polygon', coordinates: boundary.coordinates.map((r) => r.map((p) => f.toLocal(p).map(mm))) }
  const [minX, minY, maxX, maxY] = bbox(poly)
  const { plotWidth: w, plotDepth: d, roadWidth: rw } = o
  const period = rw + 2 * d
  const blockLen = Math.max(1, o.plotsPerBlock) * w
  const plots: GeneratedPlot[] = []
  const roads: LineString[] = []
  const toLine = (pts: Position[]): LineString => ({ type: 'LineString', coordinates: pts.map(f.toGeo) })

  const hRoad = (y0: number) => clip(poly, rect(minX - 1, y0, maxX + 1, y0 + rw))
  let block = 0
  const given = o.startY !== undefined
  for (let s = 0, y0 = o.startY ?? minY; y0 < maxY; s++, y0 += period) {
    const below = s === 0 && given ? [] : hRoad(y0), above = hRoad(y0 + period)
    const belowExists = below.length > 0 || (s === 0 && given)
    for (const piece of below) { const [x0, , x1] = bbox(piece); roads.push(toLine([[x0, y0 + rw / 2], [x1, y0 + rw / 2]])) }
    for (let x = minX; x < maxX; x += blockLen + rw) {
      // cross street to the right of this block, between the two horizontal streets
      for (const piece of clip(poly, rect(x + blockLen, y0 + rw, x + blockLen + rw, y0 + period))) {
        const [, by0, , by1] = bbox(piece)
        roads.push(toLine([[x + blockLen + rw / 2, by0], [x + blockLen + rw / 2, by1]]))
      }
      let n = 0
      const blockId = `B${block + 1}`
      for (const [yA, yB, yFace, hasRoad, face] of [
        [y0 + rw, y0 + rw + d, y0 + rw, belowExists, 'min'],
        [y0 + rw + d, y0 + period, y0 + period, above.length > 0, 'max'],
      ] as const) {
        // even plot widths along the block: the leftover is shared out, never a sliver or a narrower plot
        const len = Math.min(x + blockLen, maxX) - x, step = len / Math.max(1, Math.floor(len / w + 1e-6))
        for (let px = x; px < x + len - 1e-6; px += step) {
          for (const part of clip(poly, rect(px, yA, Math.min(px + step, x + len), yB))) {
            const area = planarArea(part)
            if (area < 0.25 * step * d) continue
            const frontage = hasRoad ? frontageOn(part, yFace) : 0
            plots.push({
              geometry: { type: 'Polygon', coordinates: part.coordinates.map((r) => r.map(f.toGeo)) },
              block: blockId, number: `${blockId}-${++n}`, angle: o.angle, face,
              area: round1(area), frontage: round1(frontage), depth: d,
              issue: plotIssue(area, frontage, { minPlotArea: o.minArea, minFrontage: o.minFrontage }),
            })
          }
        }
      }
      if (n) block++
    }
  }
  return { plots, roads }
}

/**
 * Cuts existing road corridors out of generated plots. A plot split in two keeps its largest
 * piece; plots left below `minArea` are flagged. ponytail: bbox prefilter only, add an R-tree
 * (rbush) if projects hold thousands of existing roads.
 */
export function clearRoads(plots: GeneratedPlot[], surfaces: Feature<Polygon | MultiPolygon>[], minArea: number): GeneratedPlot[] {
  const boxes = surfaces.map((s) => turf.bbox(s))
  const hit = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
  return plots.flatMap((p) => {
    const pb = turf.bbox(p.geometry)
    let geom: Feature<Polygon | MultiPolygon> | null = turf.feature(p.geometry)
    let cut = false
    for (let i = 0; i < surfaces.length && geom; i++) {
      if (!hit(pb, boxes[i]) || !turf.booleanIntersects(geom, surfaces[i])) continue
      geom = turf.difference(turf.featureCollection([geom, surfaces[i]]))
      cut = true
    }
    if (!cut) return [p]
    if (!geom) return []
    const g: Polygon | MultiPolygon = geom.geometry
    const parts: Polygon[] = g.type === 'Polygon' ? [g] : g.coordinates.map((c) => ({ type: 'Polygon', coordinates: c }))
    const best = parts.map((q) => ({ q, a: turf.area(q) })).sort((x, y) => y.a - x.a)[0]
    if (!best || best.a < 0.25 * minArea) return []
    const area = Math.round(best.a * 10) / 10
    return [{ ...p, geometry: best.q, area, issue: p.issue ?? (area < minArea ? `Area below ${minArea} m² (cut by existing road)` : undefined) }]
  })
}

/** Minimum-area oriented rectangle around a ring: centre, half-extents (hx ≥ hy) and long-axis angle. */
export function orientedBox(ring: [number, number][]): { cx: number; cy: number; hx: number; hy: number; angle: number } {
  let best = { area: Infinity, cx: 0, cy: 0, hx: 0, hy: 0, angle: 0 }
  for (let i = 1; i < ring.length; i++) {
    const a = Math.atan2(ring[i][1] - ring[i - 1][1], ring[i][0] - ring[i - 1][0])
    const c = Math.cos(a), s = Math.sin(a)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (const [x, y] of ring) { const u = x * c + y * s, v = -x * s + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v) }
    const area = (u1 - u0) * (v1 - v0)
    if (area < best.area - 1e-9) {
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2
      const long = u1 - u0 >= v1 - v0
      best = { area, cx: uc * c - vc * s, cy: uc * s + vc * c, hx: (long ? u1 - u0 : v1 - v0) / 2, hy: (long ? v1 - v0 : u1 - u0) / 2, angle: long ? a : a + Math.PI / 2 }
    }
  }
  return best
}


// --- plot split & merge -------------------------------------------------------------
/** Street orientation of a plot in degrees clockwise; local +x runs along the frontage. */
export function plotAxis(g: Polygon, attrs: Attrs): number {
  if (attrs.angle !== undefined && attrs.angle !== '') return Number(attrs.angle)
  // Hand-drawn plot: assume the longest edge runs along the depth, so the street faces the shorter side.
  const f = frame(g.coordinates[0][0])
  const pts = g.coordinates[0].map(f.toLocal)
  let best = -1, theta = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]
    if (Math.hypot(dx, dy) > best) { best = Math.hypot(dx, dy); theta = Math.atan2(dy, dx) }
  }
  return -((theta * 180) / Math.PI + 90)
}

export type SplitDirection = 'frontage' | 'depth'

/**
 * Cuts a polygon into `n` equal-AREA strips across its frontage or depth (cut positions found by
 * bisection, so irregular plots split fairly). `share` is each piece's fraction of the cut axis.
 * Depth strips are ordered street side first.
 */
export function splitPolygon(g: Polygon, n: number, axis: number, dir: SplitDirection, face: 'min' | 'max' = 'min'): { geometry: Polygon; share: number }[] {
  return splitPolygonShares(g, Array(n).fill(1), axis, dir, face)
}

/** Like `splitPolygon`, but piece i gets `shares[i] / Σshares` of the area (pieces in order along the axis). */
export function splitPolygonShares(g: Polygon, shares: number[], axis: number, dir: SplitDirection, face: 'min' | 'max' = 'min'): { geometry: Polygon; share: number; index: number }[] {
  const n = shares.length, sum = shares.reduce((a, b) => a + b, 0)
  const f = frame(turf.centroid(g).geometry.coordinates, -axis)
  const loc: Polygon = { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(f.toLocal)) }
  const [x0, y0, x1, y1] = bbox(loc)
  const along = dir === 'frontage'
  // strip [a, b] along the cut axis; outer edges overshoot by 1 m so floats never trim the boundary
  const strip = (a: number, b: number) => (along ? rect(a, y0 - 1, b, y1 + 1) : rect(x0 - 1, a, x1 + 1, b))
  const lo = along ? x0 : y0, hi = along ? x1 : y1
  const areaUpTo = (t: number) => clip(loc, strip(lo - 1, t)).reduce((s, p) => s + planarArea(p), 0)
  const total = planarArea(loc)
  const cuts = [lo - 1]
  let acc = 0
  for (let k = 1; k < n; k++) {
    acc += shares[k - 1]
    let a = cuts[k - 1], b = hi
    for (let it = 0; it < 40; it++) { const m = (a + b) / 2; if (areaUpTo(m) < (total * acc) / sum) a = m; else b = m }
    cuts.push((a + b) / 2)
  }
  cuts.push(hi + 1)
  const out: { geometry: Polygon; share: number; index: number }[] = []
  for (let i = 0; i < n; i++) {
    for (const part of clip(loc, strip(cuts[i], cuts[i + 1]))) {
      const [px0, py0, px1, py1] = bbox(part)
      out.push({
        geometry: { type: 'Polygon', coordinates: part.coordinates.map((r) => r.map(f.toGeo)) },
        share: dir === 'frontage' ? (px1 - px0) / (x1 - x0) : (py1 - py0) / (y1 - y0),
        index: i,
      })
    }
  }
  return dir === 'depth' && face === 'max' ? out.reverse() : out
}

/**
 * Splits a polygon along a polyline, extended past both ends (CAD "split by line"). Returns the
 * pieces on either side, or null if the line doesn't cut through. Both sides come from the same
 * half-plane polygon, so the pieces share the cut edge exactly.
 * ponytail: the half-plane is closed with a straight return edge; a line that turns back on itself
 * by more than ~180° can produce a self-intersecting half-plane.
 */
export function splitByLine(g: Polygon, line: LineString): Polygon[] | null {
  const f = frame(turf.centroid(g).geometry.coordinates)
  const loc: Polygon = { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(f.toLocal)) }
  const pts = line.coordinates.map(f.toLocal)
  if (pts.length < 2) return null
  const [bx0, by0, bx1, by1] = bbox(loc)
  const D = 10 * (Math.hypot(bx1 - bx0, by1 - by0) + Math.max(...pts.map((p) => Math.hypot(p[0], p[1]))))
  const unit = (a: Position, b: Position) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l] }
  const u0 = unit(pts[0], pts[1]), u1 = unit(pts[pts.length - 2], pts[pts.length - 1])
  const start: Position = [pts[0][0] - u0[0] * D, pts[0][1] - u0[1] * D]
  const end: Position = [pts[pts.length - 1][0] + u1[0] * D, pts[pts.length - 1][1] + u1[1] * D]
  const left: Polygon = { type: 'Polygon', coordinates: [[start, ...pts, end, [end[0] - u1[1] * D, end[1] + u1[0] * D], [start[0] - u0[1] * D, start[1] + u0[0] * D], start]] }
  const a = clip(loc, left)
  const d = turf.difference(turf.featureCollection([turf.polygon(loc.coordinates), turf.polygon(left.coordinates)]))
  const b: Polygon[] = !d ? [] : d.geometry.type === 'Polygon' ? [d.geometry] : d.geometry.coordinates.map((c) => ({ type: 'Polygon', coordinates: c }))
  const keep = (ps: Polygon[]) => ps.filter((p) => planarArea(p) > 0.01)
  const [A, B] = [keep(a), keep(b)]
  if (!A.length || !B.length) return null
  return [...A, ...B].map((p) => ({ type: 'Polygon', coordinates: p.coordinates.map((r) => r.map(f.toGeo)) }))
}

const num = (v: number | string | undefined) => (v === undefined || v === '' ? undefined : Number(v))
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Splits a plot feature into `n` new plots; frontage/depth are apportioned and every piece re-validated. */
export function splitPlot(p: PlanFeature, n: number, dir: SplitDirection, rules: PlotRules): PlanFeature[] {
  const { issue: _, ...a } = p.properties.attrs
  const no = String(a.plotNo ?? p.properties.name)
  const F = num(a.frontage), D = num(a.depth)
  const pieces = splitPolygon(p.geometry as Polygon, n, plotAxis(p.geometry as Polygon, a), dir, a.face === 'max' ? 'max' : 'min')
  return pieces.map(({ geometry, share }, i) => {
    const frontage = F === undefined ? undefined : dir === 'frontage' ? round1(F * share) : i === 0 ? F : 0
    const attrs: Attrs = { ...a, plotNo: `${no}${LETTERS[i] ?? i + 1}` }
    if (frontage !== undefined) attrs.frontage = frontage
    if (D !== undefined) attrs.depth = dir === 'depth' ? round1(D * share) : D
    const issue = plotIssue(turf.area(geometry), frontage, rules)
    if (issue) attrs.issue = issue
    const id = uid()
    return { type: 'Feature', id, geometry, properties: { ...p.properties, id, name: `Plot ${attrs.plotNo}`, attrs } }
  })
}

/** Merges adjacent plots into one. Returns an error message if they don't form a single polygon. */
export function mergePlots(ps: PlanFeature[], rules: PlotRules): PlanFeature | string {
  if (ps.length < 2) return 'Select at least two plots'
  const u = turf.union(turf.featureCollection(ps.map((p) => turf.feature(p.geometry as Polygon))))
  if (!u || u.geometry.type !== 'Polygon') return 'Plots must share an edge to be merged (use snapping when drawing plots by hand)'
  // Drop the now-collinear vertices left along the old shared edge (union keeps them, with float noise).
  const geometry = turf.simplify(u, { tolerance: 1e-8, highQuality: true }).geometry as Polygon
  // Numbered plots first (natural order); unnumbered hand-drawn plots are absorbed without a number.
  const byNo = (p: PlanFeature) => String(p.properties.attrs.plotNo ?? '￿')
  const sorted = [...ps].sort((x, y) => byNo(x).localeCompare(byNo(y), undefined, { numeric: true }))
  const { issue: _, ...a } = sorted[0].properties.attrs
  const nos = sorted.filter((p) => p.properties.attrs.plotNo).map((p) => String(p.properties.attrs.plotNo))
  const prefix = nos[0]?.includes('-') ? nos[0].slice(0, nos[0].lastIndexOf('-') + 1) : ''
  const plotNo = !nos.length ? undefined : nos.length === 1 ? nos[0]
    : prefix && nos.every((x) => x.startsWith(prefix)) ? prefix + nos.map((x) => x.slice(prefix.length)).join('+') : nos.join('+')
  const fronts = ps.map((p) => num(p.properties.attrs.frontage))
  const depths = ps.map((p) => num(p.properties.attrs.depth) ?? 0)
  const known = fronts.every((x): x is number => x !== undefined)
  const frontage = known ? round1((fronts as number[]).reduce((t, x) => t + x, 0)) : undefined
  // ponytail: side-by-side vs front/back is inferred from frontage — a rear plot (frontage 0) adds depth.
  const attrs: Attrs = { ...a, depth: fronts.includes(0) ? round1(depths.reduce((t, x) => t + x, 0)) : Math.max(...depths) }
  if (frontage !== undefined) attrs.frontage = frontage
  else delete attrs.frontage
  if (plotNo) attrs.plotNo = plotNo
  const issue = plotIssue(turf.area(geometry), frontage, rules)
  if (issue) attrs.issue = issue
  const id = uid()
  return { type: 'Feature', id, geometry, properties: { ...sorted[0].properties, id, name: plotNo ? `Plot ${plotNo}` : sorted[0].properties.name, attrs } }
}

// --- snapping ----------------------------------------------------------------------------
type XY = [number, number]

export interface SnapHit { pt: XY; kind: 'vertex' | 'edge'; path: number; index: number; t: number }

/**
 * Nearest vertex (preferred) or edge point within `tol` pixels, in screen space. `path`/`index`
 * identify the hit vertex (or the segment ending at `index`, at fraction `t`), so callers can
 * return the exact stored coordinate rather than a lossy screen→map round trip.
 */
export function snapScreen(p: XY, paths: XY[][], tol: number, o: { vertices: boolean; edges: boolean }): SnapHit | undefined {
  let best: SnapHit | undefined, bd = tol + 1e-9 // strict < below: first of equal hits wins (closing ring vertex)
  if (o.vertices) paths.forEach((path, pi) => path.forEach((v, j) => {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1])
    if (d < bd) { bd = d; best = { pt: v, kind: 'vertex', path: pi, index: j, t: 0 } }
  }))
  if (best) return best
  if (o.edges) paths.forEach((path, pi) => {
    for (let j = 1; j < path.length; j++) {
      const a = path[j - 1], b = path[j]
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy
      const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
      const q: XY = [a[0] + t * dx, a[1] + t * dy]
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d < bd) { bd = d; best = { pt: q, kind: 'edge', path: pi, index: j, t } }
    }
  })
  return best
}

/** Snaps a position to a metric grid of `size` metres anchored at `origin`, rotated `angle`° clockwise. */
export function snapToGrid(p: Position, origin: Position, size: number, angle = 0): Position {
  const f = frame(origin, -angle)
  const [x, y] = f.toLocal(p)
  return f.toGeo([Math.round(x / size) * size, Math.round(y / size) * size])
}

/** Grid lines covering `bounds` [w, s, e, n], or [] if that would take more than `max` lines. */
export function gridLines(bounds: [number, number, number, number], origin: Position, size: number, angle = 0, max = 400): LineString[] {
  const f = frame(origin, -angle)
  const corners = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]].map(f.toLocal)
  const x0 = Math.min(...corners.map((c) => c[0])), x1 = Math.max(...corners.map((c) => c[0]))
  const y0 = Math.min(...corners.map((c) => c[1])), y1 = Math.max(...corners.map((c) => c[1]))
  const gx0 = Math.floor(x0 / size) * size, gy0 = Math.floor(y0 / size) * size
  if ((x1 - gx0) / size + (y1 - gy0) / size > max) return []
  const lines: LineString[] = []
  for (let x = gx0; x <= x1; x += size) lines.push({ type: 'LineString', coordinates: [f.toGeo([x, y0]), f.toGeo([x, y1])] })
  for (let y = gy0; y <= y1; y += size) lines.push({ type: 'LineString', coordinates: [f.toGeo([x0, y]), f.toGeo([x1, y])] })
  return lines
}

// --- analytics -------------------------------------------------------------------
export interface Stats {
  boundaryArea: number
  plotCount: number; plotArea: number; invalidPlots: number; plotSizes: { label: string; count: number }[]
  roadLength: number; roadArea: number
  greenArea: number
  footprint: number; gfa: number
  landUse: Record<string, number>
  dwellings: number; population: number
  roadCost: number; buildingCost: number
  utilityLength: Record<string, number>
}

export const MULTI_UNIT = new Set(['apartment', 'tower', 'townhouse', 'mixed-use'])
/** Assumed average dwelling size (m² of net floor area) for multi-unit buildings. */
export const UNIT_SIZE = 100
/** Dwelling units a building holds (single-dwelling types count via their plot, so 0 here). */
export const unitsOf = (type: string, gfa: number, unitSize = UNIT_SIZE) => (MULTI_UNIT.has(type) ? Math.floor((gfa * 0.8) / unitSize) : 0)

export function stats(features: PlanFeature[], layers: Layer[], s: Settings & { unitSize?: number }): Stats {
  const kind = new Map(layers.map((l) => [l.id, l.kind]))
  const st: Stats = {
    boundaryArea: 0, plotCount: 0, plotArea: 0, invalidPlots: 0, plotSizes: [],
    roadLength: 0, roadArea: 0, greenArea: 0, footprint: 0, gfa: 0, landUse: {},
    dwellings: 0, population: 0, roadCost: 0, buildingCost: 0, utilityLength: {},
  }
  const buckets = [[0, 150], [150, 300], [300, 500], [500, 1000], [1000, Infinity]]
  const counts = buckets.map(() => 0)
  let resPlots = 0, units = 0
  const zoneLand: Record<string, number> = {}, plotLand: Record<string, number> = {}
  for (const f of features) {
    const { type, attrs } = f.properties
    const k = kind.get(f.properties.layerId)
    const m = measure(f)
    const zoning = attrs.zoning as string | undefined
    if (type === 'boundary') st.boundaryArea += m.area
    if (type === 'plot') {
      st.plotCount++; st.plotArea += m.area
      if (attrs.issue) st.invalidPlots++
      counts[buckets.findIndex(([a, b]) => m.area >= a && m.area < b)]++
      if (zoning === 'residential') resPlots++
    }
    if ((type === 'plot' || type === 'zone') && zoning) { const to = type === 'zone' ? zoneLand : plotLand; to[zoning] = (to[zoning] ?? 0) + m.area }
    if (k === 'green' && m.area) st.greenArea += m.area
    if (k === 'roads' && m.length) {
      const width = Number(attrs.width) || ROAD_CLASSES.local.width
      st.roadLength += m.length; st.roadArea += m.length * width
    }
    if (type === 'roundabout' || type === 'cul-de-sac') st.roadArea += m.area
    if (k === 'utilities' && m.length) {
      const net = String(attrs.network ?? 'other')
      st.utilityLength[net] = (st.utilityLength[net] ?? 0) + m.length
    }
    if (attrs.floors && m.area && componentDef(type).layer !== 'green') {
      const gfa = m.area * Number(attrs.floors)
      st.footprint += m.area; st.gfa += gfa
      units += unitsOf(type, gfa, s.unitSize)
    }
  }
  // plots usually sit inside their zone: count each zoning's land once, as its zones or else its plots
  // ponytail: per zoning, not per area; plots outside a zone of their own zoning are missed when that zone exists
  for (const z of new Set([...Object.keys(zoneLand), ...Object.keys(plotLand)])) st.landUse[z] = Math.max(zoneLand[z] ?? 0, plotLand[z] ?? 0)
  st.plotSizes = buckets.map(([a, b], i) => ({ label: b === Infinity ? `≥${a} m²` : `${a}–${b} m²`, count: counts[i] }))
  st.dwellings = resPlots * s.dwellingsPerPlot + units
  st.population = Math.round(st.dwellings * s.personsPerDwelling)
  st.roadCost = st.roadArea * s.roadCostPerM2
  st.buildingCost = st.gfa * s.buildingCostPerM2
  return st
}
