import * as turf from '@turf/turf'
import type { LineString, Polygon, Position } from 'geojson'
import { frame, measure } from './geo'
import { componentDef, NETWORKS, type PlanFeature } from './model'

/**
 * Infrastructure network checks: quantities, connectivity, open ends, missing source facilities,
 * conflicts with buildings and between water and sewer mains, and service coverage of buildings.
 * Deliberately geometric only — hydraulic, electrical and capacity calculations belong in dedicated
 * engines (EPANET, SWMM, OpenDSS…) fed from these networks; see `NetworkEngine` below.
 */
export type NetIssueCode = 'disconnected' | 'open-end' | 'no-source' | 'under-building' | 'separation' | 'unserved'
export const NET_ISSUE_LABELS: Record<NetIssueCode, string> = {
  disconnected: 'Disconnected segment', 'open-end': 'Open end', 'no-source': 'No source facility',
  'under-building': 'Runs under a building', separation: 'Water–sewer separation', unserved: 'Building not served',
}

export interface NetIssue { id: string; network: string; code: NetIssueCode; message: string; at?: Position }

export interface NetworkSummary {
  network: string
  length: number               // m of line
  segments: number
  nodes: number                // point / polygon facilities on the network
  components: number           // connected pieces (1 = fully connected)
  bySize: Record<string, number> // "150 mm HDPE" → m
}

export interface NetworkReport { summaries: NetworkSummary[]; issues: NetIssue[]; byId: Map<string, NetIssue[]> }

export interface NetOptions { tolerance: number; waterSewerSeparation: number; separationLength: number }
export const NET_DEFAULTS: NetOptions = { tolerance: 1, waterSewerSeparation: 3, separationLength: 10 }

/** Plug-in point for specialised analyses (hydraulics, load flow…) that consume the same networks. */
export interface NetworkEngine { id: string; label: string; run(features: PlanFeature[]): NetIssue[] }

type XY = [number, number]
const segDist = (p: XY, a: XY, b: XY) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
const pathDist = (p: XY, path: XY[]) => { let d = Infinity; for (let i = 1; i < path.length; i++) d = Math.min(d, segDist(p, path[i - 1], path[i])); return path.length === 1 ? Math.hypot(p[0] - path[0][0], p[1] - path[0][1]) : d }
const inRing = (p: XY, r: XY[]) => {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
  return inside
}

/** Grid index over paths (each segment's box; `fill` = the whole bbox, for areas): candidate ids near a box. */
const CELL = 50
function gridIndex(paths: XY[][], fill: (i: number) => boolean = () => false) {
  const cells = new Map<string, number[]>()
  const cover = (x0: number, y0: number, x1: number, y1: number, i: number) => {
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++)
      for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) {
        const k = x + ',' + y, c = cells.get(k)
        if (!c) cells.set(k, [i]); else if (c[c.length - 1] !== i) c.push(i)
      }
  }
  paths.forEach((p, i) => {
    if (fill(i) || p.length === 1) { const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return cover(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), i) }
    for (let k = 1; k < p.length; k++) cover(Math.min(p[k - 1][0], p[k][0]), Math.min(p[k - 1][1], p[k][1]), Math.max(p[k - 1][0], p[k][0]), Math.max(p[k - 1][1], p[k][1]), i)
  })
  /** Ids whose cells overlap the box around p (± r). */
  return (p: XY, r: number, q: XY = p): number[] => {
    const out = new Set<number>()
    for (let x = Math.floor((Math.min(p[0], q[0]) - r) / CELL); x <= Math.floor((Math.max(p[0], q[0]) + r) / CELL); x++)
      for (let y = Math.floor((Math.min(p[1], q[1]) - r) / CELL); y <= Math.floor((Math.max(p[1], q[1]) + r) / CELL); y++)
        for (const i of cells.get(x + ',' + y) ?? []) out.add(i)
    return [...out]
  }
}

/** Which network a feature belongs to (utility lines and facilities, bus stops, stations). */
export const networkOf = (f: PlanFeature): string | undefined => {
  const n = f.properties.attrs.network
  return typeof n === 'string' && NETWORKS[n] ? n : undefined
}

export function analyzeNetworks(features: PlanFeature[], o: NetOptions = NET_DEFAULTS): NetworkReport {
  const out: NetworkReport = { summaries: [], issues: [], byId: new Map() }
  const add = (i: NetIssue) => { out.issues.push(i); out.byId.set(i.id, [...(out.byId.get(i.id) ?? []), i]) }
  const members = features.filter(networkOf)
  if (!members.length) return out
  const f = frame(turf.centroid(turf.featureCollection(members as any)).geometry.coordinates)
  const L = (p: Position) => f.toLocal(p) as XY
  const buildings = features.filter((b) => Number(b.properties.attrs.floors) > 0 && b.geometry.type === 'Polygon')
    .map((b) => ({ f: b, ring: (b.geometry as Polygon).coordinates[0].map(L) }))
  const linesBy = new Map<string, { f: PlanFeature; path: XY[] }[]>()
  const nearBuilding = gridIndex(buildings.map((b) => b.ring), () => true)

  for (const net of Object.keys(NETWORKS)) {
    const mem = members.filter((m) => networkOf(m) === net)
    if (!mem.length) continue
    const lines = mem.filter((m) => m.geometry.type === 'LineString').map((m) => ({ f: m, path: (m.geometry as LineString).coordinates.map(L) }))
    const nodes = mem.filter((m) => m.geometry.type !== 'LineString').map((m) => ({
      f: m, path: m.geometry.type === 'Point' ? [L(m.geometry.coordinates)] : (m.geometry as Polygon).coordinates[0].map(L),
      area: m.geometry.type === 'Polygon',
    }))
    linesBy.set(net, lines)

    // union-find over lines and nodes; things connect when within `tolerance` metres
    const items = [...lines.map((l) => ({ id: l.f.id, path: l.path, area: false })), ...nodes.map((n) => ({ id: n.f.id, path: n.path, area: n.area }))]
    const parent = items.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const touches = (p: XY, k: number) => pathDist(p, items[k].path) <= o.tolerance || (items[k].area && inRing(p, items[k].path))
    const ends = (i: number): XY[] => (i < lines.length ? [items[i].path[0], items[i].path[items[i].path.length - 1]] : items[i].path.length === 1 ? items[i].path : [])
    const degree = lines.map(() => [0, 0])
    const near = gridIndex(items.map((it) => it.path), (j) => items[j].area) // only nearby items can touch
    for (let i = 0; i < lines.length; i++)
      ends(i).forEach((e, k) => { for (const j of near(e, o.tolerance)) if (j !== i && touches(e, j)) { degree[i][k]++; parent[find(i)] = find(j) } })
    for (let j = lines.length; j < items.length; j++) // point nodes on a line
      if (items[j].path.length === 1) for (const i of near(items[j].path[0], o.tolerance)) if (i < lines.length && touches(items[j].path[0], i)) parent[find(i)] = find(j)

    // components: the one with the most line length is the main network
    const comp = new Map<number, number[]>()
    items.forEach((_, i) => { const r = find(i); comp.set(r, [...(comp.get(r) ?? []), i]) })
    const lineLen = lines.map((l) => measure(l.f).length)
    const compLen = (ix: number[]) => ix.reduce((s, i) => s + (i < lines.length ? lineLen[i] : 0), 0)
    const groups = [...comp.values()].filter((ix) => ix.some((i) => i < lines.length))
    const main = groups.sort((a, b) => compLen(b) - compLen(a))[0] ?? []
    for (const g of groups.slice(1))
      for (const i of g) if (i < lines.length)
        add({ id: lines[i].f.id, network: net, code: 'disconnected', message: `${lines[i].f.properties.name} is not connected to the main ${NETWORKS[net].label.toLowerCase()} network (${g.filter((k) => k < lines.length).length} isolated segment(s))` })

    // open ends: line endpoints touching nothing (no other line, no facility)
    lines.forEach((l, i) => degree[i].forEach((d, k) => {
      if (d === 0) add({ id: l.f.id, network: net, code: 'open-end', at: (l.f.geometry as LineString).coordinates[k === 0 ? 0 : (l.f.geometry as LineString).coordinates.length - 1], message: `${l.f.properties.name} has an open ${k === 0 ? 'start' : 'end'} (not connected to a line or facility)` })
    }))

    // a network with lines needs one of its source facilities, connected to the main network
    if (lines.length) {
      const src = nodes.filter((n) => NETWORKS[net].sources.includes(n.f.properties.type))
      const srcInMain = src.some((n) => main.includes(lines.length + nodes.indexOf(n)))
      if (!srcInMain) add({ id: lines[main.find((i) => i < lines.length) ?? 0].f.id, network: net, code: 'no-source', message: src.length ? `The ${NETWORKS[net].sourceLabel} is not connected to the main ${NETWORKS[net].label.toLowerCase()} network` : `No ${NETWORKS[net].sourceLabel} on the ${NETWORKS[net].label.toLowerCase()} network` })
    }

    // pipes and cables under buildings (crossing the footprint, not just touching an edge)
    if (net !== 'transit') for (const l of lines) for (const bi of new Set(l.path.flatMap((p, i) => (i ? nearBuilding(l.path[i - 1], 0, p) : [])))) {
      const b = buildings[bi]
      const inside = l.path.some((p) => inRing(p, b.ring)) || l.path.some((p, i) => i > 0 && segmentCrossesRing(l.path[i - 1], p, b.ring))
      if (inside) add({ id: l.f.id, network: net, code: 'under-building', message: `${l.f.properties.name} runs under ${b.f.properties.name}` })
    }

    out.summaries.push({
      network: net,
      length: lineLen.reduce((s, v) => s + v, 0),
      segments: lines.length,
      nodes: nodes.length,
      components: groups.length,
      bySize: lines.reduce((acc, l, i) => {
        const a = l.f.properties.attrs
        const k = net === 'transit' ? 'route' : `${a.diameter ?? '?'} mm ${a.material ?? ''}`.trim()
        acc[k] = (acc[k] ?? 0) + lineLen[i]
        return acc
      }, {} as Record<string, number>),
    })
  }

  // water mains must keep their separation from sewers (contamination risk) over any long run
  const sewers = linesBy.get('sewer') ?? [], nearSewer = gridIndex(sewers.map((x) => x.path))
  for (const w of linesBy.get('water') ?? []) {
    let run = 0, flagged = false
    for (let i = 1; i < w.path.length && !flagged; i++) {
      const a = w.path[i - 1], b = w.path[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(len / 1))
      for (let k = 0; k <= steps && !flagged; k++) {
        const p: XY = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]
        const near = nearSewer(p, o.waterSewerSeparation).some((k) => pathDist(p, sewers[k].path) < o.waterSewerSeparation)
        run = near ? run + len / steps : 0
        if (run >= o.separationLength) {
          add({ id: w.f.id, network: 'water', code: 'separation', at: f.toGeo(p), message: `${w.f.properties.name} runs within ${o.waterSewerSeparation} m of a sewer for ${o.separationLength}+ m` })
          flagged = true
        }
      }
    }
  }

  // buildings need water, sewer and power within each network's service distance (if that network exists)
  for (const [net, lines] of linesBy) {
    const reach = NETWORKS[net].serviceDistance
    if (!reach || !lines.length) continue
    const nearLine = gridIndex(lines.map((l) => l.path))
    for (const b of buildings) {
      const c = L(turf.centroid(b.f).geometry.coordinates)
      if (!nearLine(c, reach).some((k) => pathDist(c, lines[k].path) <= reach))
        add({ id: b.f.id, network: net, code: 'unserved', message: `${b.f.properties.name} has no ${NETWORKS[net].label.toLowerCase()} line within ${reach} m` })
    }
  }
  return out
}

function segmentCrossesRing(a: XY, b: XY, ring: XY[]) {
  const cross = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1], d = ring[i]
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d)
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  }
  return false
}

/** True for features that are infrastructure network members (used by layers/UI). */
export const isNetworkLine = (f: PlanFeature) => !!networkOf(f) && f.geometry.type === 'LineString' && componentDef(f.properties.type).layer !== 'roads'

let memo: { f: unknown; out: NetworkReport } | null = null
/** Memoised on the immutable features map. */
export function networksOf(features: Record<string, PlanFeature>): NetworkReport {
  if (memo?.f === features) return memo.out
  memo = { f: features, out: analyzeNetworks(Object.values(features)) }
  return memo.out
}
