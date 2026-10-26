import type { LineString, Point, Polygon, Position } from 'geojson'
import { NETWORKS, type PlanFeature } from './model'
import { NET_DEFAULTS, networkOf } from './networks'

/**
 * Flow model for the underground view: water and sewer pipes oriented in their flow direction, at depth.
 * Water runs away from its sources (tank / pump station), sewage towards the treatment plant, by shortest
 * network distance. Sewers fall ≥ 1:200 downstream and keep ≥ 1.5 m cover. Speeds are illustrative; a
 * hydraulics engine (networks.ts NetworkEngine) is meant to replace them per pipe.
 */
type XY = [number, number]
export type XYZ = [number, number, number]
export interface FlowPipe { id: string; network: 'water' | 'sewer'; /** e, n, y (pipe-centre elevation) in flow order */ pts: XYZ[]; diameter: number; /** m/s, illustrative */ speed: number; connected: boolean }
export interface FlowNet { pipes: FlowPipe[]; /** e, n, yPipe, yGround */ manholes: [number, number, number, number][] }

const SPEED = { water: 1.0, sewer: 0.6 }
const DEPTH = { water: 1.2, sewer: 1.5 }
const FALL = 0.005

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1])
const pathLen = (p: XY[]) => p.reduce((s, q, i) => s + (i ? dist(p[i - 1], q) : 0), 0)
function inRing(p: XY, r: XY[]) {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c
  return c
}

export function pipeFlow(features: PlanFeature[], toLocal: (p: Position) => XY, ground: (e: number, n: number) => number): FlowNet {
  const out: FlowNet = { pipes: [], manholes: [] }
  const tol = NET_DEFAULTS.tolerance
  for (const net of ['water', 'sewer'] as const) {
    const lines = features.filter((f) => networkOf(f) === net && f.geometry.type === 'LineString')
      .map((f) => ({ f, path: (f.geometry as LineString).coordinates.map(toLocal) }))
    if (!lines.length) continue
    // graph: pipe ends merged within the tolerance
    // ponytail: only end-to-end joins; a pipe ending mid-way along another shows as unconnected (split it to join)
    const nodes: XY[] = []
    const nodeAt = (p: XY) => { let i = nodes.findIndex((q) => dist(p, q) <= tol); if (i < 0) i = nodes.push(p) - 1; return i }
    const edges = lines.map((l) => ({ ...l, a: nodeAt(l.path[0]), b: nodeAt(l.path[l.path.length - 1]), len: pathLen(l.path) }))
    const adj: number[][] = nodes.map(() => [])
    edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i) })

    // sources: points on a node, polygons containing (or touching) a node
    const srcs = features.filter((f) => NETWORKS[net].sources.includes(f.properties.type))
    const isSrc = nodes.map((p) => srcs.some((s) => s.geometry.type === 'Point'
      ? dist(p, toLocal((s.geometry as Point).coordinates)) <= tol
      : s.geometry.type === 'Polygon' && (() => { const r = (s.geometry as Polygon).coordinates[0].map(toLocal); return inRing(p, r) || r.some((q) => dist(p, q) <= tol) })()))

    // Dijkstra from all sources (O(n²): a few thousand nodes at most)
    const d = nodes.map((_, i) => (isSrc[i] ? 0 : Infinity)), done = nodes.map(() => false)
    for (;;) {
      let u = -1
      for (let i = 0; i < nodes.length; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i
      if (u < 0) break
      done[u] = true
      for (const ei of adj[u]) { const e = edges[ei], v = e.a === u ? e.b : e.a; if (d[u] + e.len < d[v]) d[v] = d[u] + e.len }
    }

    // orientation: water from its nearer-to-source end; sewage towards the plant (from the farther end)
    const flows = edges.map((e) => {
      const connected = d[e.a] < Infinity && d[e.b] < Infinity
      const fwd = !connected || (net === 'water' ? d[e.a] <= d[e.b] : d[e.a] >= d[e.b])
      return { e, connected, path: fwd ? e.path : [...e.path].reverse(), from: fwd ? e.a : e.b, to: fwd ? e.b : e.a }
    })
    const depthOf = (f: PlanFeature) => { const x = Number(f.properties.attrs.depth); return x > 0 ? x : DEPTH[net] }
    const ys = new Map<number, number[]>()
    const inv: number[] = nodes.map(([e, n]) => ground(e, n) - DEPTH.sewer)

    if (net === 'sewer') {
      // gravity: upstream first (larger distance to the plant); each pipe falls ≥ FALL and keeps cover
      const profile = (path: XY[], y0: number) => {
        const y = [y0]
        for (let i = 1; i < path.length; i++) y.push(Math.min(y[i - 1] - FALL * dist(path[i - 1], path[i]), ground(path[i][0], path[i][1]) - DEPTH.sewer))
        return y
      }
      const order = nodes.map((_, i) => i).filter((i) => d[i] < Infinity).sort((x, y) => d[y] - d[x])
      for (const v of order)
        for (const fl of flows) if (fl.connected && fl.to === v && fl.from !== v) inv[v] = Math.min(inv[v], profile(fl.path, inv[fl.from]).at(-1)!)
      flows.forEach((fl, i) => {
        if (!fl.connected || Number(fl.e.f.properties.attrs.depth) > 0) return
        const y = profile(fl.path, inv[fl.from])
        y[y.length - 1] = Math.min(y[y.length - 1], inv[fl.to])
        ys.set(i, y)
      })
      // manholes at junctions and ends
      nodes.forEach(([e, n], i) => { if (adj[i].length !== 2) out.manholes.push([e, n, inv[i], ground(e, n)]) })
      for (const m of features.filter((f) => f.properties.type === 'manhole' && f.geometry.type === 'Point')) {
        const [e, n] = toLocal((m.geometry as Point).coordinates)
        let best: [number, number] = [Infinity, 0]
        flows.forEach((fl, i) => fl.path.forEach((p, j) => { const dd = dist(p, [e, n]); if (dd < best[0]) best = [dd, ys.get(i)?.[j] ?? ground(p[0], p[1]) - depthOf(fl.e.f)] }))
        if (best[0] < Infinity) out.manholes.push([e, n, best[1], ground(e, n)])
      }
    }

    flows.forEach((fl, i) => {
      const y = ys.get(i) ?? fl.path.map(([e, n]) => ground(e, n) - depthOf(fl.e.f))
      out.pipes.push({ id: fl.e.f.id, network: net, pts: fl.path.map(([e, n], j) => [e, n, y[j]]), diameter: Number(fl.e.f.properties.attrs.diameter) || NETWORKS[net].diameter!, speed: SPEED[net], connected: fl.connected })
    })
  }
  return out
}
