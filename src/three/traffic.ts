import * as turf from '@turf/turf'
import type { Feature, LineString, Polygon, Position } from 'geojson'
import { orientedBox, roadSurface } from '../geo'
import { componentDef, ROAD_CLASSES, type Attrs, type PlanFeature } from '../model'
import { VEHICLE_SIZE, type CarSpot, type VehicleKind } from './cars'
import { parkingBays } from './models'

/**
 * Where the static vehicles go (pure; local metres e/n, headings clockwise from east): parking bays,
 * traffic in lanes on the project's driving side, and cars
 * in front of buildings. Deterministic per feature id.
 */
type XY = [number, number]
const MAX_CARS = 3000
export const SURFACE_LIFT = 0.16
export const SPACING: Record<string, number> = { highway: 25, arterial: 25, collector: 40, local: 70 }
const FRONT_TYPES = new Set(['shop', 'office', 'mixed-use', 'clinic', 'school', 'community', 'police', 'fire', 'government', 'library'])
const CARS: VehicleKind[] = ['sedan', 'sedan', 'hatch', 'suv']

export interface LaneLayout {
  /** Carriageway width (road width minus sidewalks), m. */
  cw: number
  /** Offsets (m) are measured from the centreline towards the kerb of the traffic that drives along the line
   *  (+ = that side); multiply by +1 for left-hand and −1 for right-hand traffic to get the left-normal offset. */
  lanes: { off: number; width: number; dir: 1 | -1 }[]
  lines: { off: number; kind: 'edge' | 'dash' | 'centre' | 'double' }[]
}
/**
 * Lanes and marking lines across a street — one layout for both the cars and the
 * road markings, so cars always sit between the lines. Lanes fill the carriageway (no on-street parking).
 */
export function laneLayout(a: Attrs, cls: string): LaneLayout | undefined {
  const width = Number(a.width) || 0, def = ROAD_CLASSES[cls]
  if (!(cls in SPACING) || !def || width <= 0) return
  const cw = width - 2 * (Number(a.sidewalk ?? def.sidewalk) || 0), n = Math.max(1, Number(a.lanes) || def.lanes)
  if (cw <= 0) return
  const lw = cw / n, fwd = n === 1 ? 1 : Math.ceil(n / 2), top = cw / 2
  const lanes = Array.from({ length: n }, (_, i) => ({ off: top - lw * (i + 0.5), width: lw, dir: (i < fwd ? 1 : -1) as 1 | -1 }))
  const lines: LaneLayout['lines'] = [{ off: top, kind: 'edge' }, { off: top - n * lw, kind: 'edge' }]
  for (let i = 1; i < n; i++) lines.push({ off: top - lw * i, kind: i !== fwd ? 'dash' : cls === 'arterial' || cls === 'highway' ? 'double' : 'centre' })
  return { cw, lanes, lines }
}

const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)
export const rng = (seed: number) => () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((seed >>> 0) % 10000) / 10000 }
export const deg = (dx: number, dy: number) => (Math.atan2(-dy, dx) * 180) / Math.PI // clockwise from east
/** Planar distance from p to a polyline. */
export function distTo(p: XY, pts: XY[]): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
  }
  return best
}
function nearestOn(p: XY, pts: XY[]): XY {
  let best = Infinity, out: XY = pts[0]
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
    const q: XY = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d < best) { best = d; out = q }
  }
  return out
}
/** Corners of a car footprint at (e, n) heading h. */
function corners(e: number, n: number, h: number, kind: VehicleKind): XY[] {
  const [L, W] = VEHICLE_SIZE[kind], a = (-h * Math.PI) / 180, u: XY = [Math.cos(a), Math.sin(a)], v: XY = [-u[1], u[0]]
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, t]) => [e + (s * L * u[0]) / 2 + (t * W * v[0]) / 2, n + (s * L * u[1]) / 2 + (t * W * v[1]) / 2])
}
interface Area { poly: Polygon; box: [number, number, number, number] }
const area = (rings: XY[][]): Area => ({ poly: { type: 'Polygon', coordinates: rings }, box: turf.bbox({ type: 'Polygon', coordinates: rings }) as [number, number, number, number] })
const inside = (p: XY, a: Area) => p[0] >= a.box[0] && p[0] <= a.box[2] && p[1] >= a.box[1] && p[1] <= a.box[3] && turf.booleanPointInPolygon(p, a.poly)

export function placeCars(features: PlanFeature[], toLocal: (p: Position) => XY, side: 'left' | 'right', ground: (e: number, n: number) => number, o?: { lanes?: boolean }): CarSpot[] {
  const out: CarSpot[] = []
  // sit on the draped surfaces (roads +0.12 m, plots +0.15 m) and follow the slope under the wheels
  const push = (e: number, n: number, heading: number, kind: VehicleKind, seed: number) => {
    const [L, W] = VEHICLE_SIZE[kind], a = (-heading * Math.PI) / 180, u: XY = [Math.cos(a), Math.sin(a)], v: XY = [-u[1], u[0]]
    const g = (s: number, t: number) => ground(e + (s * L * u[0]) / 2 + (t * W * v[0]) / 2, n + (s * L * u[1]) / 2 + (t * W * v[1]) / 2)
    const front = (g(1, 1) + g(1, -1)) / 2, back = (g(-1, 1) + g(-1, -1)) / 2, left = (g(1, 1) + g(-1, 1)) / 2, right = (g(1, -1) + g(-1, -1)) / 2
    // tilt from the corners, height from the ground under the whole car: the plane clears every sample (0.5 m apart)
    const sp = (front - back) / L, sr = (left - right) / W
    let y0 = -Infinity
    for (let k = -L / 2; k <= L / 2 + 1e-6; k += L / Math.ceil(L / 0.5)) for (const t of [-W / 2, 0, W / 2]) y0 = Math.max(y0, ground(e + k * u[0] + t * v[0], n + k * u[1] + t * v[1]) - sp * k - sr * t)
    out.push({ e, n, y: y0 + SURFACE_LIFT, heading, kind, seed, pitch: (Math.atan((front - back) / L) * 180) / Math.PI, roll: (Math.atan((left - right) / W) * 180) / Math.PI })
  }
  const sigma = side === 'left' ? 1 : -1

  // roads usable by cars, with their surfaces (for overlap checks) and centrelines (for junction clearance)
  const roads = features.flatMap((f) => {
    if (f.geometry.type !== 'LineString' || componentDef(f.properties.type).layer !== 'roads') return []
    const a = f.properties.attrs, cls = String(a.roadClass ?? componentDef(f.properties.type).roadClass ?? '')
    const width = Number(a.width) || 0
    const surf = width > 0 ? roadSurface(f as Feature<LineString>, width) : undefined
    const polys = !surf ? [] : surf.geometry.type === 'Polygon' ? [surf.geometry.coordinates] : surf.geometry.coordinates
    return [{ f, cls, width, pts: f.geometry.coordinates.map(toLocal), areas: polys.map((p) => area(p.map((r) => r.map(toLocal)))) }]
  })
  const roadAreas = roads.flatMap((r) => r.areas) // overlap: no car on any road, track or rail
  const streets = roads.filter((r) => r.cls in SPACING && r.width > 0) // junctions and building fronts: real streets only
  const buildings = features.filter((f) => f.geometry.type === 'Polygon' && Number(f.properties.attrs.floors) > 0)
  const footprints = buildings.map((b) => area((b.geometry as Polygon).coordinates.map((r) => r.map(toLocal))))

  // 1. parking bays (~70%), nose to the aisle
  for (const f of features) {
    if (f.properties.type !== 'parking' || f.geometry.type !== 'Polygon') continue
    const r = rng(hash(f.id)), ob = orientedBox((f.geometry as Polygon).coordinates[0].map(toLocal))
    const u: XY = [Math.cos(ob.angle), Math.sin(ob.angle)], v: XY = [-u[1], u[0]]
    for (const [x, z] of parkingBays(ob.hx, ob.hy)) {
      if (r() >= 0.7) continue
      // box frame z runs along −v; a bay at z < 0 is on the +v side and faces −v
      const e = ob.cx + x * u[0] - z * v[0], n = ob.cy + x * u[1] - z * v[1], s = z < 0 ? -1 : 1
      push(e, n, deg(s * v[0], s * v[1]), CARS[Math.floor(r() * CARS.length)], Math.floor(r() * 1e6))
    }
  }

  // 2. lane traffic
  for (const road of o?.lanes === false ? [] : roads) {
    const { f, cls, pts } = road, a = f.properties.attrs
    if (['bridge', 'tunnel'].includes(String(a.structure ?? 'grade'))) continue
    const lay = laneLayout(a, cls)
    if (!lay) continue
    const step = SPACING[cls]
    const others = streets.filter((o) => o !== road)
    const r = rng(hash(f.id))
    // walk by arc length across segments (density follows length, not vertex count); keep 3 m off sharp bends
    // (> 30°), where an offset car would cut the corner
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    const total = cum[cum.length - 1]
    const sharp = cum.filter((_, i) => {
      if (i === 0 || i === pts.length - 1) return false
      const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]), a2 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])
      return Math.abs(((a2 - a1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) > Math.PI / 6
    })
    for (const sl of lay.lanes) {
      let i = 1
      for (let s = 3 + r() * step; s < total - 3; s += step * (0.6 + r() * 0.8)) {
        if (sharp.some((c) => Math.abs(c - s) < 3)) continue
        while (i < pts.length - 1 && cum[i] < s) i++
        const [p, q] = [pts[i - 1], pts[i]], len = cum[i] - cum[i - 1]
        if (len < 1e-6) continue
        const u: XY = [(q[0] - p[0]) / len, (q[1] - p[1]) / len], nl: XY = [-u[1], u[0]], off = sl.off * sigma, t = s - cum[i - 1]
        const e = p[0] + u[0] * t + nl[0] * off, n = p[1] + u[1] * t + nl[1] * off
        if (others.some((o) => distTo([e, n], o.pts) < 12 + o.width / 2)) continue
        const big = cls !== 'local' && r() < 1 / 12
        push(e, n, deg(sl.dir * u[0], sl.dir * u[1]), big ? (r() < 0.5 ? 'bus' : 'truck') : CARS[Math.floor(r() * CARS.length)], Math.floor(r() * 1e6))
      }
    }
  }

  // 3. cars in front of buildings, on the face nearest a road
  buildings.forEach((b) => {
    const t = b.properties.type, count = t === 'house' || t === 'villa' ? 1 : FRONT_TYPES.has(t) ? 0 : -1
    if (count < 0 || !streets.length) return
    const r = rng(hash(b.id)), ob = orientedBox((b.geometry as Polygon).coordinates[0].map(toLocal))
    const c: XY = [ob.cx, ob.cy]
    let near: XY | undefined, best = 40
    for (const road of streets) { const q = nearestOn(c, road.pts), d = Math.hypot(q[0] - c[0], q[1] - c[1]); if (d < best) { best = d; near = q } }
    if (!near) return
    const u: XY = [Math.cos(ob.angle), Math.sin(ob.angle)], v: XY = [-u[1], u[0]], to: XY = [near[0] - c[0], near[1] - c[1]]
    const faces = [{ nrm: u, tan: v, dist: ob.hx, half: ob.hy }, { nrm: [-u[0], -u[1]] as XY, tan: v, dist: ob.hx, half: ob.hy }, { nrm: v, tan: u, dist: ob.hy, half: ob.hx }, { nrm: [-v[0], -v[1]] as XY, tan: u, dist: ob.hy, half: ob.hx }]
    const face = faces.reduce((a, x) => (x.nrm[0] * to[0] + x.nrm[1] * to[1] > a.nrm[0] * to[0] + a.nrm[1] * to[1] ? x : a))
    const n = count || Math.max(1, Math.min(1 + Math.floor(r() * 3), Math.floor((2 * face.half) / 5.5)))
    for (let i = 0; i < n; i++) {
      const along = (i - (n - 1) / 2) * 5.5, kind = CARS[Math.floor(r() * CARS.length)]
      const e = c[0] + face.nrm[0] * (face.dist + 1.2) + face.tan[0] * along, nn = c[1] + face.nrm[1] * (face.dist + 1.2) + face.tan[1] * along
      const h = deg(face.tan[0], face.tan[1])
      const cs = corners(e, nn, h, kind)
      if (cs.some((p) => roadAreas.some((a) => inside(p, a)) || footprints.some((a) => inside(p, a)))) continue
      push(e, nn, h, kind, Math.floor(r() * 1e6))
    }
  })

  // ponytail: hard cap, thinned evenly; instancing per distance band (LOD) is the upgrade
  if (out.length <= MAX_CARS) return out
  const k = Math.ceil(out.length / MAX_CARS)
  return out.filter((_, i) => i % k === 0)
}
