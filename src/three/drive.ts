import type { Feature, LineString, Position } from 'geojson'
import { junctionPoints } from '../roads'
import { componentDef, type PlanFeature } from '../model'
import { deg, laneLayout, rng, SPACING, SURFACE_LIFT, type LaneLayout } from './traffic'
import { VEHICLE_SIZE, type CarSpot, type VehicleKind } from './cars'

/** Road network as a graph (local metres): streets cut at every junction, nodes merged within 5 m. */
type XY = [number, number]
/** `signal`: traffic lights, arms (edge ids) green in turn clockwise from east; `offset` (s) set per seed by createTraffic. */
export interface GNode { id: number; p: XY; r: number; edges: number[]; signal?: { arms: number[]; offset: number } }
export interface GEdge { id: number; cls: string; width: number; pts: XY[]; cum: number[]; len: number; a: number; b: number; lay: LaneLayout }
export interface RoadGraph { nodes: GNode[]; edges: GEdge[]; sigma: 1 | -1 }

const MERGE = 5
const dist = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1])

/** Arc-length along a polyline of the point nearest to p. */
function along(pts: XY[], p: XY): number {
  let best = Infinity, at = 0, run = 0
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy)
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (l * l))) : 0
    const d = dist(p, [a[0] + t * dx, a[1] + t * dy])
    if (d < best) { best = d; at = run + t * l }
    run += l
  }
  return at
}

/** Sub-polyline between arc-lengths s0 and s1. */
function slice(pts: XY[], s0: number, s1: number): XY[] {
  const at = (s: number): XY => {
    let run = 0
    for (let i = 1; i < pts.length; i++) {
      const l = dist(pts[i - 1], pts[i])
      if (run + l >= s || i === pts.length - 1) { const t = l ? Math.min(1, (s - run) / l) : 0; return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])] }
      run += l
    }
    return pts[0]
  }
  const out: XY[] = [at(s0)]
  let run = 0
  for (let i = 1; i < pts.length; i++) { run += dist(pts[i - 1], pts[i]); if (run > s0 + 1e-6 && run < s1 - 1e-6) out.push(pts[i]) }
  out.push(at(s1))
  return out
}

export function buildRoadGraph(features: PlanFeature[], toLocal: (p: Position) => XY, side: 'left' | 'right'): RoadGraph {
  const sigma: 1 | -1 = side === 'left' ? 1 : -1
  // ponytail: bridges/tunnels are dead ends; drive on the deck height to include them
  // ponytail: roundabouts are Polygons, not in the graph, so streets ending at one are dead ends (cars turn back)
  const streets = features.flatMap((f) => {
    if (f.geometry.type !== 'LineString' || componentDef(f.properties.type).layer !== 'roads') return []
    const a = f.properties.attrs, cls = String(a.roadClass ?? componentDef(f.properties.type).roadClass ?? '')
    const lay = laneLayout(a, cls)
    if (!lay || ['bridge', 'tunnel'].includes(String(a.structure ?? 'grade'))) return []
    return [{ f: f as Feature<LineString>, cls, width: Number(a.width), lay }]
  })
  const bbox = (pts: XY[]) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
  const boxes = new Map(streets.map((s) => [s, bbox(s.f.geometry.coordinates.map(toLocal))]))
  const nodes: GNode[] = [], edges: GEdge[] = []
  // ponytail: linear scan, fine to a few thousand nodes; grid hash beyond
  const nodeAt = (p: XY) => (nodes.find((nd) => dist(nd.p, p) < MERGE) ?? nodes[nodes.push({ id: nodes.length, p, r: 0, edges: [] }) - 1]).id

  for (const s of streets) {
    const pts = s.f.geometry.coordinates.map(toLocal)
    const total = pts.reduce((t, p, i) => t + (i ? dist(pts[i - 1], p) : 0), 0) // not along(): wrong for closed/self-touching lines
    const box = bbox(pts)
    // ponytail: bbox prefilter (padded MERGE) keeps junctionPoints near-linear on spread-out networks; a grid index is the upgrade for dense ones
    const near = streets.filter((o) => o !== s && boxes.get(o)!.every((v, i) => (i < 2 ? v <= box[i + 2] + MERGE : v >= box[i - 2] - MERGE))).map((o) => o.f)
    // a closed loop would collapse to one self-loop edge: cut it in half
    const cuts = [0, total, ...(dist(pts[0], pts[pts.length - 1]) < MERGE ? [total / 2] : []), ...junctionPoints(s.f, near, MERGE).map((p) => along(pts, toLocal(p)))].sort((x, y) => x - y)
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] - cuts[i - 1] < 1) continue
      const seg = slice(pts, cuts[i - 1], cuts[i])
      const a = nodeAt(seg[0]), b = nodeAt(seg[seg.length - 1])
      if (a === b) continue
      seg[0] = nodes[a].p; seg[seg.length - 1] = nodes[b].p
      const cum = [0]
      for (let k = 1; k < seg.length; k++) cum.push(cum[k - 1] + dist(seg[k - 1], seg[k]))
      const e: GEdge = { id: edges.length, cls: s.cls, width: s.width, pts: seg, cum, len: cum[cum.length - 1], a, b, lay: s.lay }
      edges.push(e)
      for (const n of [a, b]) { nodes[n].edges.push(e.id); nodes[n].r = Math.max(nodes[n].r, s.width / 2 + 2) }
    }
  }
  // traffic lights where ≥ 3 arms meet and ≥ 2 of them are bigger than local streets
  for (const nd of nodes) {
    if (nd.edges.length < 3 || nd.edges.filter((e) => edges[e].cls !== 'local').length < 2) continue
    const heading = (e: GEdge) => { const [q] = at(e.pts, e.cum, e.a === nd.id ? Math.min(10, e.len) : Math.max(0, e.len - 10)); return -Math.atan2(q[1] - nd.p[1], q[0] - nd.p[0]) }
    nd.signal = { arms: [...nd.edges].sort((x, y) => heading(edges[x]) - heading(edges[y])), offset: 0 }
  }
  return { nodes, edges, sigma }
}

export const GREEN = 20, AMBER = 3, ALL_RED = 2
const PHASE = GREEN + AMBER + ALL_RED
export type Light = 'green' | 'amber' | 'red'
/** Light shown to cars arriving on `edge` at signalled `node` at sim time t (s): each arm green, amber, then all-red in turn. */
export function signalAt(node: GNode, edge: number, t: number): Light {
  const sg = node.signal, k = sg ? sg.arms.indexOf(edge) : -1
  if (!sg || k < 0) return 'red'
  const cycle = PHASE * sg.arms.length, u = ((((t + sg.offset) % cycle) + cycle) % cycle) - PHASE * k
  return u < 0 || u >= PHASE ? 'red' : u < GREEN ? 'green' : u < GREEN + AMBER ? 'amber' : 'red'
}

// ---- traffic simulation ----
// ponytail: hard cap on moving cars; LOD/instancing bands are the upgrade
export const MAX_MOVING = 600
const KMH: Record<string, number> = { local: 30, collector: 40, arterial: 50, highway: 80 }
const KINDS: VehicleKind[] = ['sedan', 'sedan', 'hatch', 'suv']

const wrap = (h: number, c: number) => ((((h - c) % 24) + 36) % 24) - 12
const bell = (h: number, c: number, w: number) => Math.exp(-(wrap(h, c) ** 2) / (2 * w * w))
/** Traffic volume by hour: 0.15 at night, 1 at the 08:00 and 17:30 peaks, ≈ 0.6 at midday. */
export function demand(hour: number): number {
  return 0.15 + 0.85 * Math.min(1, bell(hour, 8, 1.5) + bell(hour, 17.5, 1.5) + 0.52 * bell(hour, 13, 2.5))
}

/** `inNode` = node whose junction box the car is turning in; then edge/lane are the exit lane and s runs along the turn. */
export interface MovingCar { id: number; kind: VehicleKind; edge: number; lane: number; s: number; v: number; inNode?: number }
export interface Traffic {
  cars: MovingCar[]
  /** Sim time (s): the clamped dt summed, so a faster clock runs the lights faster too. */
  time: number
  /** Cars removed by the gridlock release valve. */
  dropped: number
  step(dt: number, hour: number, visible: (e: number, n: number) => boolean): void
  poses(): CarSpot[]
}
/** A lane between two junction boxes: s runs 0…len from the `from` box edge (edge arc t0) in the lane's direction. */
interface Lane { id: number; e: GEdge; i: number; off: number; dir: 1 | -1; from: number; to: number; t0: number; len: number; v0: number; cars: Car[]; exits: Lane[] }
interface Path { pts: XY[]; cum: number[]; len: number; cap: number }
/** `via`: the lane a car in a junction box came from. */
interface Car extends MovingCar { L: number; seed: number; at: Lane; next?: Lane; turn?: Path; via?: Lane; stamp: number; still: number; gone?: boolean }

/** Point and unit direction at arc length t along a polyline. */
function at(pts: XY[], cum: number[], t: number): [XY, XY] {
  let lo = 1, hi = pts.length - 1
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < t) lo = m + 1; else hi = m }
  const p = pts[lo - 1], q = pts[lo], l = cum[lo] - cum[lo - 1]
  const k = l ? Math.max(0, Math.min(1, (t - cum[lo - 1]) / l)) : 0
  return [[p[0] + k * (q[0] - p[0]), p[1] + k * (q[1] - p[1])], l ? [(q[0] - p[0]) / l, (q[1] - p[1]) / l] : [1, 0]]
}
/** Speed (m/s) holding lateral acceleration on a bend of `ang` rad over `len` m. */
const bendCap = (ang: number, len: number) => (ang > 1e-6 && len > 0 ? Math.sqrt(2 / (ang / len)) : Infinity)
const turnAngle = (u: XY, w: XY) => Math.acos(Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1])))

/** Quadratic Bézier a → (control c) → b, sampled for arc-length lookup. */
function bezier(a: XY, c: XY, b: XY): Path {
  const pts: XY[] = [], cum = [0]
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, w0 = (1 - t) ** 2, w1 = 2 * t * (1 - t), w2 = t * t
    pts.push([w0 * a[0] + w1 * c[0] + w2 * b[0], w0 * a[1] + w1 * c[1] + w2 * b[1]])
    if (i) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  }
  const len = cum[8], d1 = dist(a, c), d2 = dist(c, b)
  const ang = d1 && d2 ? turnAngle([(c[0] - a[0]) / d1, (c[1] - a[1]) / d1], [(b[0] - c[0]) / d2, (b[1] - c[1]) / d2]) : 0
  return { pts, cum, len, cap: bendCap(ang, len) }
}

/**
 * Moving lane traffic on a road graph: cars follow (IDM-lite), give way at junction boxes (one car per box) or obey
 * traffic lights (a stream from the green arm per box),
 * turn on Bézier paths, U-turn at dead ends; volume follows `demand(hour)`. Deterministic per seed.
 */
export function createTraffic(g: RoadGraph, o: { seed: number; ground: (e: number, n: number) => number }): Traffic {
  const r = rng(o.seed), { sigma, nodes } = g
  const ro = rng(o.seed ^ 0x51c7) // own stream: offsets don't shift the car sequence
  for (const nd of nodes) if (nd.signal) nd.signal.offset = ro() * PHASE * nd.signal.arms.length
  // lanes trimmed r + 3 m at each end, so a waiting car's nose (≤ 2.4 m for sedan/hatch/suv) stays outside the box;
  // an edge shorter than both trims gives a zero-length lane at the k-weighted point.
  // ponytail: bus/truck noses (4–6 m) still poke into the box; stop them at len − L/2 if it shows
  const lanes: Lane[] = g.edges.flatMap((e) => {
    const ra = nodes[e.a].r + 3, rb = nodes[e.b].r + 3, k = Math.min(1, e.len / (ra + rb))
    return e.lay.lanes.map((l, i) => ({ id: 0, e, i, off: l.off, dir: l.dir, from: l.dir > 0 ? e.a : e.b, to: l.dir > 0 ? e.b : e.a, t0: l.dir > 0 ? ra * k : e.len - rb * k, len: Math.max(0, e.len - (ra + rb) * k), v0: KMH[e.cls] / 3.6, cars: [], exits: [] }))
  })
  const leaving: Lane[][] = nodes.map(() => [])
  lanes.forEach((ln, i) => { ln.id = i; leaving[ln.from].push(ln) })
  // exits: lanes of the other edges leaving the node; a U-turn only at a dead end
  for (const ln of lanes) ln.exits = leaving[ln.to].filter((x) => (nodes[ln.to].edges.length === 1) === (x.e === ln.e))
  const spawnable = lanes.filter((ln) => ln.len >= 15)
  const capacity = lanes.reduce((s, ln) => s + ln.len / SPACING[ln.e.cls], 0)
  // cars turning in each junction box, in entry order
  const box: Car[][] = nodes.map(() => [])
  /** Last car in the box at `n` that came from lane `ln`. */
  const lastFrom = (n: number, ln: Lane) => { const b = box[n]; for (let k = b.length - 1; k >= 0; k--) if (b[k].via === ln) return b[k] }
  /** May the head car of `ln` (at s, speed v) enter the box now? Give-way: box empty. Lights: green (or amber and too fast to stop),
   *  only cars from this lane in the box, and the last of them far enough in. */
  const mayEnter = (ln: Lane, c: Car, nx: Lane) => {
    const nd = nodes[ln.to], b = box[nd.id]
    if (!nd.signal) return b.length === 0
    const light = signalAt(nd, ln.e.id, T.time)
    if (light === 'red' || (light === 'amber' && c.v * c.v / 8 <= ln.len - c.s)) return false
    if (b.some((x) => x.via !== ln)) return false // one lane at a time: lanes of one arm cross each other's turns
    // the exit lane must also hold the box cars already bound for it (an empty lane offers its length, not unlimited room)
    const bound = b.filter((x) => x.next === nx)
    if (bound.length && (nx.cars.length ? backRoom(nx, c) : nx.len) - bound.reduce((s, x) => s + x.L + 2, 0) < 0) return false
    const ld = lastFrom(nd.id, ln)
    return !ld || ld.s - (ld.L + c.L) / 2 >= 2
  }
  const waitingForLight = (ln: Lane) => { const nd = nodes[ln.to]; return !!nd.signal && signalAt(nd, ln.e.id, T.time) !== 'green' }
  const cars: Car[] = []
  let stamp = 0, nextId = 0

  const lanePose = (ln: Lane, s: number): [XY, number] => {
    const [p, u] = at(ln.e.pts, ln.e.cum, ln.t0 + ln.dir * s), off = ln.off * sigma
    return [[p[0] - u[1] * off, p[1] + u[0] * off], deg(ln.dir * u[0], ln.dir * u[1])]
  }
  const turns = new Map<number, Path>()
  const turnOf = (a: Lane, b: Lane) => {
    const key = a.id * lanes.length + b.id
    let t = turns.get(key)
    if (!t) turns.set(key, (t = bezier(lanePose(a, a.len)[0], nodes[a.to].p, lanePose(b, 0)[0])))
    return t
  }
  /** Curvature cap from the next 20 m of the lane's polyline. */
  const curveCap = (ln: Lane, s: number) => {
    const u = at(ln.e.pts, ln.e.cum, ln.t0 + ln.dir * s)[1], w = at(ln.e.pts, ln.e.cum, ln.t0 + ln.dir * Math.min(ln.len, s + 20))[1]
    return bendCap(turnAngle(u, w), 20)
  }
  const speed = (c: Car, ln: Lane) => ln.v0 * (c.kind === 'bus' || c.kind === 'truck' ? 0.85 : 1)
  /** Free distance before c would sit < 2 m behind the last car on ln (from ln's start). */
  const backRoom = (ln: Lane, c: Car) => { const b = ln.cars[ln.cars.length - 1]; return b ? b.s - (b.L + c.L) / 2 - 2 : Infinity }
  const pick = (ln: Lane) => (ln.exits.length ? ln.exits[Math.floor(r() * ln.exits.length)] : undefined)
  /** IDM-lite: desired gap 2 m + 2 s·v, accel ≤ 2, braking ≤ 4; never moves further than `room`. */
  const move = (c: Car, v0: number, room: number, dt: number) => {
    const free = Math.max(0, room), a = Math.max(-4, Math.min(2, 2 * (1 - (c.v / v0) ** 4 - ((2 + 2 * c.v) / (free + 2)) ** 2)))
    const v = Math.max(0, c.v + a * dt), ds = Math.min(v * dt, free)
    c.v = ds < v * dt ? ds / dt : v
    c.still = c.v < 0.1 ? c.still + dt : 0
    return ds
  }

  function step(dt: number, hour: number, visible: (e: number, n: number) => boolean) {
    dt = Math.min(dt, 0.1)
    if (!(dt > 0)) return
    stamp++
    T.time += dt
    const target = Math.min(MAX_MOVING, Math.round(capacity * demand(hour)))
    let live = cars.length, removed = false

    // 1. cars turning in junction boxes, in entry order (they always finish, whatever the light; the exit lane was free on entry)
    for (const b of box) {
      for (let k = 0; k < b.length; k++) {
        const c = b[k], t = c.turn!, nx = c.next!
        let room = t.len - c.s + backRoom(nx, c)
        for (let j = k - 1; j >= 0; j--) if (b[j].via === c.via) { room = Math.min(room, b[j].s - c.s - (b[j].L + c.L) / 2 - 2); break } // same lane: follow (paths start together)
        c.s += move(c, Math.min(speed(c, nx), t.cap), room, dt)
        c.stamp = stamp
        if (c.still >= 60) { c.gone = removed = true; live--; T.dropped++; b.splice(k--, 1); continue } // release valve, in the box too
        if (c.s < t.len) continue
        c.inNode = c.turn = c.via = undefined
        Object.assign(c, { at: nx, s: 0, next: pick(nx) })
        nx.cars.push(c)
        b.splice(k--, 1)
      }
    }

    // 2. lane cars, front to back (each follows its already-moved leader)
    for (const ln of lanes) {
      for (let i = 0; i < ln.cars.length; i++) {
        const c = ln.cars[i]
        if (c.stamp === stamp) continue // just left a junction box
        c.stamp = stamp
        let v0 = Math.min(speed(c, ln), curveCap(ln, c.s)), room: number
        const nx = c.next, end = ln.len - c.s
        const go = i === 0 && !!nx && backRoom(nx, c) >= 0 && mayEnter(ln, c, nx)
        if (i > 0) { const ld = ln.cars[i - 1]; room = ld.s - c.s - (ld.L + c.L) / 2 - 2 }
        else if (nx) {
          const t = turnOf(ln, nx)
          v0 = Math.min(v0, Math.sqrt(t.cap ** 2 + 4 * end)) // ease into the turn at 2 m/s²
          room = go ? end + t.len + backRoom(nx, c) : end
        } else room = end
        // the last car turning in the box ahead came from this lane: keep the gap to it
        const h = i === 0 ? lastFrom(ln.to, ln) : undefined
        if (h) room = Math.min(room, end + h.s - (h.L + c.L) / 2 - 2)
        c.s += move(c, v0, room, dt)
        if (waitingForLight(ln)) c.still = Math.max(0, c.still - dt) // queueing at a light is not a jam: pause the valve clock
        // ponytail: release valve for gridlock (no signals or turn phasing yet; those are the real fix):
        // drop a car stopped > 20 s off-screen or > 60 s anywhere
        if (c.still >= 60 || (c.still > 20 && !visible(...lanePose(ln, c.s)[0]))) {
          c.gone = removed = true; live--; T.dropped++
          ln.cars.splice(i--, 1)
          continue
        }
        if (i > 0 || c.s < ln.len - 1e-9) continue
        // at the lane end: leave the network, enter the box, or wait at its edge
        const [p] = lanePose(ln, ln.len)
        if (!nx || (live > target && (nodes[ln.to].edges.length === 1 || !visible(p[0], p[1])))) {
          c.gone = removed = true; live--
        } else if (go) {
          const t = turnOf(ln, nx)
          box[ln.to].push(c)
          Object.assign(c, { inNode: ln.to, turn: t, via: ln, edge: nx.e.id, lane: nx.i, s: Math.min(c.s - ln.len, t.len) })
        } else { c.s = ln.len; continue }
        ln.cars.shift(); i--
      }
    }

    // 3. spawn at free lane starts at dead ends or off-screen (≤ 5 per step)
    for (let k = Math.min(5, target - live); k > 0 && spawnable.length; k--) {
      const ln = spawnable[Math.floor(r() * spawnable.length)], b = ln.cars[ln.cars.length - 1]
      if (box[ln.from].length || (b && b.s - b.L / 2 < 15)) continue
      const [p] = lanePose(ln, 0)
      if (nodes[ln.from].edges.length > 1 && visible(p[0], p[1])) continue
      const kind: VehicleKind = ln.e.cls !== 'local' && r() < 1 / 12 ? (r() < 0.5 ? 'bus' : 'truck') : KINDS[Math.floor(r() * KINDS.length)]
      const c: Car = { id: nextId++, kind, edge: ln.e.id, lane: ln.i, s: 0, v: 0, L: VEHICLE_SIZE[kind][0], seed: Math.floor(r() * 1e6), at: ln, stamp, still: 0 }
      c.next = pick(ln)
      ln.cars.push(c); cars.push(c); live++
    }
    if (removed) { let j = 0; for (const c of cars) if (!c.gone) cars[j++] = c; cars.length = j }
  }

  function poses(): CarSpot[] {
    return cars.map((c) => {
      let p: XY, h: number
      if (c.inNode === undefined) [p, h] = lanePose(c.at, c.s)
      else { const [q, u] = at(c.turn!.pts, c.turn!.cum, c.s); p = q; h = deg(u[0], u[1]) }
      const a = (-h * Math.PI) / 180, hx = (Math.cos(a) * c.L) / 2, hy = (Math.sin(a) * c.L) / 2
      const pitch = (Math.atan((o.ground(p[0] + hx, p[1] + hy) - o.ground(p[0] - hx, p[1] - hy)) / c.L) * 180) / Math.PI
      return { e: p[0], n: p[1], y: o.ground(p[0], p[1]) + SURFACE_LIFT, heading: h, kind: c.kind, seed: c.seed, pitch, roll: 0 }
    })
  }

  const T: Traffic = { cars, time: 0, dropped: 0, step, poses }
  return T
}
