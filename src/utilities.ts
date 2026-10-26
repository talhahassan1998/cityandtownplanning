import type { LineString, Point, Polygon, Position } from 'geojson'
import { footprint } from './geo'
import { componentDef, defaultAttrs, NETWORKS, type Attrs, type PlanFeature } from './model'
import { networkOf } from './networks'
import { buildRoadGraph } from './three/drive'

/**
 * Lays a preliminary water main and sewer under every street (road-graph edge: streets cut at junctions),
 * water 2 m to one side, sewer 1.5 m to the other; each pipe starts and ends on the junction points, so a
 * network is connected wherever the streets are; a dead-end street's pipe ends on a hydrant / manhole.
 * Adds a water tank / treatment plant when the project has none.
 * Imported lazily by the UI (drive.ts pulls in three).
 */
type XY = [number, number]
export interface PipeDraft { type: 'water-main' | 'sewer' | 'water-tank' | 'treatment' | 'hydrant' | 'manhole'; geometry: LineString | Point | Polygon; attrs: Attrs; name: string }

const OFFSET = { water: 2, sewer: -1.5 } as const
const PIPE = { water: 'water-main', sewer: 'sewer' } as const
const NAME = { water: 'Water main (laid)', sewer: 'Sewer (laid)' } as const
/** What closes a pipe at a dead-end street: a hydrant flushes a water main, a manhole heads a sewer. */
const END = { water: ['hydrant', 'Fire hydrant (laid)'], sewer: ['manhole', 'Sewer manhole (laid)'] } as const

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]]
const len = (v: XY) => Math.hypot(v[0], v[1])
const unit = (v: XY): XY => { const l = len(v) || 1; return [v[0] / l, v[1] / l] }

/** Nearest point on a polyline: distance and arc length along it. */
function nearest(p: XY, path: XY[]): { d: number; s: number; total: number } {
  let best = { d: Infinity, s: 0 }, acc = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], ab = sub(path[i], a), l2 = ab[0] ** 2 + ab[1] ** 2
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0
    const d = Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1])
    if (d < best.d) best = { d, s: acc + t * Math.sqrt(l2) }
    acc += Math.sqrt(l2)
  }
  return { ...best, total: acc }
}

/** Polyline offset by d metres to its left (averaged normals at interior vertices). */
function offset(pts: XY[], d: number): XY[] {
  return pts.map((p, i) => {
    const u0 = unit(sub(pts[Math.max(1, i)], pts[Math.max(1, i) - 1])), u1 = unit(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.min(pts.length - 1, i + 1) - 1]))
    const n = unit([-(u0[1] + u1[1]), u0[0] + u1[0]])
    return [p[0] + n[0] * d, p[1] + n[1] * d]
  })
}

export function layWaterSewer(features: PlanFeature[], toLocal: (p: Position) => XY, toGeo: (p: XY) => Position): PipeDraft[] {
  const g = buildRoadGraph(features, toLocal, 'left')
  if (!g.edges.length) return []
  const line = (pts: XY[]): LineString => ({ type: 'LineString', coordinates: pts.map(toGeo) })
  const pipesOf = (net: string) => features.filter((f) => networkOf(f) === net && f.geometry.type === 'LineString').map((f) => (f.geometry as LineString).coordinates.map(toLocal))
  const out: PipeDraft[] = []

  for (const net of ['water', 'sewer'] as const) {
    const have = pipesOf(net)
    for (const e of g.edges) {
      const ends = [e.a, e.b].filter((n) => g.nodes[n].edges.length === 1)
      // already piped: a pipe of this network runs past the street's middle (not merely ending at a junction near it)
      let k = 1
      while (k < e.cum.length - 1 && e.cum[k] < e.len / 2) k++
      const t = (e.len / 2 - e.cum[k - 1]) / (e.cum[k] - e.cum[k - 1] || 1), mid: XY = [e.pts[k - 1][0] + t * (e.pts[k][0] - e.pts[k - 1][0]), e.pts[k - 1][1] + t * (e.pts[k][1] - e.pts[k - 1][1])]
      if (have.some((p) => { const n = nearest(mid, p); return n.d <= 6 && n.s > 1 && n.s < n.total - 1 })) continue
      out.push({ type: PIPE[net], geometry: line([g.nodes[e.a].p, ...offset(e.pts, OFFSET[net]), g.nodes[e.b].p]), attrs: defaultAttrs(componentDef(PIPE[net])), name: NAME[net] })
      for (const n of ends) out.push({ type: END[net][0], geometry: { type: 'Point', coordinates: toGeo(g.nodes[n].p) }, attrs: defaultAttrs(componentDef(END[net][0])), name: END[net][1] })
    }
  }
  if (!out.length) return out

  const has = (net: string) => features.some((f) => NETWORKS[net].sources.includes(f.properties.type))
  const nodes = g.nodes.filter((n) => n.edges.length)
  const c: XY = [nodes.reduce((s, n) => s + n.p[0], 0) / nodes.length, nodes.reduce((s, n) => s + n.p[1], 0) / nodes.length]
  /** Unit vector from node n along its first street. */
  const along = (n: (typeof nodes)[number]): XY => { const e = g.edges[n.edges[0]]; return unit(sub(e.a === n.id ? e.pts[1] : e.pts[e.pts.length - 2], n.p)) }
  if (!has('water')) {
    // tank on the corner diagonal beside the junction nearest the centre (clear of both streets)
    const n0 = nodes.reduce((a, b) => (len(sub(b.p, c)) < len(sub(a.p, c)) ? b : a)), u = along(n0)
    const at: XY = [n0.p[0] + (u[0] - u[1]) * 8, n0.p[1] + (u[1] + u[0]) * 8]
    out.push({ type: 'water-tank', geometry: { type: 'Point', coordinates: toGeo(at) }, attrs: defaultAttrs(componentDef('water-tank')), name: 'Water tank (laid)' })
    out.push({ type: 'water-main', geometry: line([n0.p, at]), attrs: defaultAttrs(componentDef('water-main')), name: NAME.water })
  }
  if (!has('sewer')) {
    // plant 50 m beyond the street end farthest from the centre (a dead end if there is one)
    const ends = nodes.filter((n) => n.edges.length === 1)
    const n1 = (ends.length ? ends : nodes).reduce((a, b) => (len(sub(b.p, c)) > len(sub(a.p, c)) ? b : a)), u = along(n1)
    const at: XY = [n1.p[0] - u[0] * 50, n1.p[1] - u[1] * 50]
    // ponytail: the plant may land on a plot or another street; it is an ordinary feature the user moves
    out.push({ type: 'treatment', geometry: footprint(toGeo(at), 80, 60), attrs: defaultAttrs(componentDef('treatment')), name: 'Treatment plant (laid)' })
    out.push({ type: 'sewer', geometry: line([n1.p, at]), attrs: defaultAttrs(componentDef('sewer')), name: NAME.sewer })
  }
  return out
}
