import * as turf from '@turf/turf'
import type { Feature, LineString, Point, Polygon, Position } from 'geojson'
import { footprint, frame, lineAt } from './geo'
import type { ComponentDef, PlanFeature, PlanGeometry } from './model'

// --- junction shapes ------------------------------------------------------------------
const circleRing = (c: Position, r: number) => turf.circle(c, r, { units: 'meters', steps: 48 }).geometry.coordinates[0]

/** Roundabout carriageway: a ring of outer radius `r` around a central island of radius `island`. */
export function roundaboutGeom(c: Position, r: number, island: number): Polygon {
  const outer = circleRing(c, r)
  return island > 0 && island < r ? { type: 'Polygon', coordinates: [outer, circleRing(c, island).reverse()] } : { type: 'Polygon', coordinates: [outer] }
}

/** Cul-de-sac turning head: a circle of radius `r` centred on the chosen end of a road. */
export function culDeSacGeom(line: LineString, end: 'start' | 'end', r: number): Polygon {
  const c = end === 'start' ? line.coordinates[0] : line.coordinates[line.coordinates.length - 1]
  return { type: 'Polygon', coordinates: [circleRing(c, r)] }
}

/** Geometry for a component dropped/placed at `c`. Roundabouts are true rings, not rectangles. */
export function componentGeometry(def: ComponentDef, c: Position): PlanGeometry {
  if (def.type === 'roundabout') return roundaboutGeom(c, 20, 9)
  if (def.geom === 'polygon') return footprint(c, def.w ?? 20, def.d ?? def.w ?? 20)
  if (def.geom === 'line') return lineAt(c, 120)
  return { type: 'Point', coordinates: [...c] } as Point
}

/**
 * Points where `line` meets other roads (crossings, T-junctions, shared endpoints), merged when
 * closer than `mergeM` metres so one junction yields one point.
 */
export function junctionPoints(line: Feature<LineString>, others: Feature<LineString>[], mergeM = 5): Position[] {
  const pts: Position[] = []
  const add = (p: Position) => { if (!pts.some((q) => turf.distance(p, q, { units: 'meters' }) < mergeM)) pts.push(p) }
  for (const o of others) {
    for (const p of turf.lineIntersect(line, o).features) add(p.geometry.coordinates)
    // T-junction whose stem stops at (or within 1 m of) this road
    for (const e of [o.geometry.coordinates[0], o.geometry.coordinates[o.geometry.coordinates.length - 1]])
      if (turf.pointToLineDistance(e, line, { units: 'meters' }) < 1) add(turf.nearestPointOnLine(line, e).geometry.coordinates)
  }
  return pts
}

/**
 * Joins dangling street ends to the nearest other road within `tolM` metres (extending or trimming the
 * end onto it), so generated streets form one connected network instead of stubs that stop short.
 * The first `fixed` lines (e.g. an arterial) are targets only and never move.
 * ponytail: O(n²) with a bbox prefilter; fine for wizard-sized networks (hundreds of streets).
 */
export function connectEnds(lines: LineString[], tolM: number, fixed = 0): LineString[] {
  const out = lines.map((l) => ({ ...l, coordinates: l.coordinates.map((p) => [...p]) }))
  const pad = tolM / 111320 / Math.cos(((out[0]?.coordinates[0]?.[1] ?? 0) * Math.PI) / 180) // metres → degrees of longitude (≥ latitude)
  const boxes = out.map((l) => turf.bbox(l))
  for (let i = fixed; i < out.length; i++) {
    for (const end of [0, -1]) {
      const c = out[i].coordinates, k = end === 0 ? 0 : c.length - 1, p = c[k]
      let best: { d: number; q: Position } | undefined
      for (let j = 0; j < out.length; j++) {
        const b = boxes[j]
        if (j === i || p[0] < b[0] - pad || p[0] > b[2] + pad || p[1] < b[1] - pad || p[1] > b[3] + pad) continue
        const q = turf.nearestPointOnLine(out[j], p, { units: 'meters' })
        const d = q.properties.dist ?? Infinity
        if (d <= tolM && (!best || d < best.d)) best = { d, q: q.geometry.coordinates }
      }
      if (best && best.d > 0.05) { c[k] = best.q; boxes[i] = turf.bbox(out[i]) }
    }
  }
  return out
}

// --- plots along a road (curvilinear layouts) -----------------------------------------------
export interface AlongOptions { plotWidth: number; plotDepth: number; roadWidth: number; sides: 'both' | 'left' | 'right' }
export interface AlongPlot { geometry: Polygon; side: 'L' | 'R'; index: number; frontage: number; angle: number; face: 'min' | 'max'; tooTight: boolean }

/**
 * Lays plots along both sides of a (possibly curved) road. Stations every `plotWidth` metres
 * along the centreline are offset by the half road width (front) and by the plot depth (rear);
 * neighbouring plots reuse the same station points, so they share edges exactly. Plots on the
 * inside of curves tighter than the plot depth self-intersect and are flagged `tooTight`.
 */
export function plotsAlongRoad(line: LineString, o: AlongOptions): AlongPlot[] {
  const mid = turf.along(turf.lineString(line.coordinates), turf.length(turf.lineString(line.coordinates), { units: 'meters' }) / 2, { units: 'meters' }).geometry.coordinates
  const f = frame(mid)
  const pts = line.coordinates.map(f.toLocal)
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const L = cum[cum.length - 1]
  const n = Math.floor(L / o.plotWidth)
  if (n < 1) return []
  const at = (s: number): Position => {
    s = Math.max(0, Math.min(L, s))
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)
    return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]
  }
  const start = (L - n * o.plotWidth) / 2 // centre the run, leaving equal remnants at both ends
  const stations = Array.from({ length: n + 1 }, (_, k) => start + k * o.plotWidth)
  // left-hand unit normal from a central difference, so a bend gets one shared normal (no gaps/overlaps)
  const normal = (s: number) => {
    const a = at(s - 1), b = at(s + 1)
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]
  }
  const off = (s: number, d: number): Position => { const p = at(s), nn = normal(s); return [p[0] + nn[0] * d, p[1] + nn[1] * d] }
  // Front/rear edges pass through the centreline's own vertices between stations, so plots
  // follow the curve instead of cutting chords into the road.
  const between = (s0: number, s1: number) => cum.filter((c) => c > s0 + 0.01 && c < s1 - 0.01)
  const front = o.roadWidth / 2, rear = o.roadWidth / 2 + o.plotDepth
  const out: AlongPlot[] = []
  for (const [side, sgn] of [['L', 1], ['R', -1]] as const) {
    if (o.sides !== 'both' && (o.sides === 'left') !== (side === 'L')) continue
    for (let k = 0; k < n; k++) {
      const s0 = stations[k], s1 = stations[k + 1], mids = between(s0, s1)
      const frontEdge = [s0, ...mids, s1].map((s) => off(s, sgn * front))
      const rearEdge = [s1, ...[...mids].reverse(), s0].map((s) => off(s, sgn * rear))
      const ring = [...frontEdge, ...rearEdge, frontEdge[0]]
      const geometry: Polygon = { type: 'Polygon', coordinates: [(sgn > 0 ? ring : [...ring].reverse()).map(f.toGeo)] }
      const p0 = at(s0), p1 = at(s1), dx = p1[0] - p0[0], dy = p1[1] - p0[1]
      const frontLen = frontEdge.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - frontEdge[i - 1][0], p[1] - frontEdge[i - 1][1]) : 0), 0)
      out.push({
        geometry, side, index: k,
        frontage: Math.round(frontLen * 10) / 10,
        angle: Math.round((-(Math.atan2(dy, dx) * 180) / Math.PI) * 10) / 10,
        face: side === 'L' ? 'min' : 'max', // left plots extend to +y of the street's local frame
        tooTight: turf.kinks(turf.polygon(geometry.coordinates)).features.length > 0,
      })
    }
  }
  return out
}

// --- measured frontage ------------------------------------------------------------------------
/**
 * Length of a plot's boundary that runs along a road edge: boundary sampled every 0.5 m, a sample
 * counts when it lies within half the road width (+`tol`) of a road centreline. Corner plots get
 * both street sides. Used where frontage can't be known from the layout (hand-drawn plots, cuts).
 */
export function measureFrontage(plot: Polygon, roads: PlanFeature[], tol = 0.75): number {
  const f = frame(turf.centroid(plot).geometry.coordinates)
  const ring = plot.coordinates[0].map(f.toLocal)
  const [px0, py0, px1, py1] = turf.bbox({ type: 'LineString', coordinates: ring })
  const near = roads
    .filter((r) => r.geometry.type === 'LineString')
    .map((r) => ({ pts: (r.geometry as LineString).coordinates.map(f.toLocal), half: (Number(r.properties.attrs.width) || 0) / 2 + tol }))
    .filter(({ pts, half }) => {
      const [x0, y0, x1, y1] = turf.bbox({ type: 'LineString', coordinates: pts })
      return x0 - half <= px1 && px0 <= x1 + half && y0 - half <= py1 && py0 <= y1 + half
    })
  if (!near.length) return 0
  const segDist = (p: Position, a: Position, b: Position) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  // A boundary sample fronts a road if it's within reach of a road segment running roughly
  // parallel to that boundary edge (side edges meeting the road at right angles don't count).
  const COS_30 = Math.cos(Math.PI / 6)
  const onRoad = (p: Position, ux: number, uy: number) => near.some(({ pts, half }) => pts.some((q, i) => {
    if (!i) return false
    const a = pts[i - 1], dx = q[0] - a[0], dy = q[1] - a[1], l = Math.hypot(dx, dy) || 1
    return Math.abs((ux * dx + uy * dy) / l) >= COS_30 && segDist(p, a, q) <= half
  }))
  let len = 0
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (!L) continue
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L
    const steps = Math.max(1, Math.ceil(L / 0.5))
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps
      if (onRoad([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], ux, uy)) len += L / steps
    }
  }
  return Math.round(len * 10) / 10
}

// --- curved roads (rounded corners) -----------------------------------------------------
/** Curve radius (m) a road gets by default when it is first curved, by road class. */
export const DEFAULT_CURVE: Record<string, number> = { local: 15, collector: 30, arterial: 60, highway: 150 }
export const defaultCurve = (roadClass: string) => DEFAULT_CURVE[roadClass] ?? 15

/**
 * Road through design points `pi` with each interior bend rounded to a circular arc of `radiusM`, tangent to both
 * legs and sampled every ≤ 2 m. The radius shrinks where the tangent would pass half of either leg (neighbouring
 * bends never overlap); bends under 1° stay as they are. A loop's start/end stays a sharp corner.
 */
export function curveRoad(pi: Position[], radiusM: number, toLocal: (p: Position) => [number, number], toGeo: (p: [number, number]) => Position): Position[] {
  if (pi.length < 3 || !(radiusM > 0)) return pi.map((p) => [...p])
  const pts = pi.map(toLocal), out: Position[] = [[...pi[0]]]
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]]
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
    const u1 = [(b[0] - a[0]) / (l1 || 1), (b[1] - a[1]) / (l1 || 1)], u2 = [(c[0] - b[0]) / (l2 || 1), (c[1] - b[1]) / (l2 || 1)]
    const turn = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])))
    if (!l1 || !l2 || turn < Math.PI / 180) { out.push([...pi[i]]); continue }
    const t = Math.min(radiusM * Math.tan(turn / 2), l1 / 2, l2 / 2), r = t / Math.tan(turn / 2)
    const side = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]) // +1 left turn (anticlockwise)
    const t1: [number, number] = [b[0] - u1[0] * t, b[1] - u1[1] * t]
    const ctr = [t1[0] - u1[1] * r * side, t1[1] + u1[0] * r * side]
    const a0 = Math.atan2(t1[1] - ctr[1], t1[0] - ctr[0]), steps = Math.max(1, Math.ceil((r * turn) / 2))
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + side * turn * (k / steps)
      out.push(toGeo([ctr[0] + r * Math.cos(ang), ctr[1] + r * Math.sin(ang)]))
    }
  }
  out.push([...pi[pi.length - 1]])
  return out
}
