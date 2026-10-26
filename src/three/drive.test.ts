import { describe, expect, it } from 'vitest'
import type { LineString } from 'geojson'
import { frame } from '../geo'
import { newProject, type PlanFeature } from '../model'
import { buildRoadGraph, createTraffic, demand, MAX_MOVING, signalAt, type GNode, type RoadGraph, type Traffic } from './drive'
import { VEHICLE_SIZE, type CarSpot } from './cars'

const F = frame([67.0, 24.86])
const P = newProject()
const layer = (k: string) => P.layers.find((l) => l.kind === k)!.id
let n = 0
const feat = (type: string, kind: string, geometry: any, attrs: any = {}): PlanFeature => {
  const id = `${type}-${++n}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: layer(kind), type, name: type, attrs } }
}
const line = (pts: [number, number][]): LineString => ({ type: 'LineString', coordinates: pts.map((p) => F.toGeo(p)) })
const street = (pts: [number, number][], attrs: any = {}) => feat('road-local', 'roads', line(pts), { width: 12, lanes: 2, sidewalk: 1.5, roadClass: 'local', ...attrs })
const toLocal = (p: any) => F.toLocal(p) as [number, number]
const build = (fs: PlanFeature[], side: 'left' | 'right' = 'left') => buildRoadGraph(fs, toLocal, side)
const collector = (pts: [number, number][]) => street(pts, { width: 14, roadClass: 'collector' })
const hubOf = (g: RoadGraph) => g.nodes.reduce((a, b) => (b.edges.length > a.edges.length ? b : a))
const giveWay = (g: RoadGraph): RoadGraph => ({ ...g, nodes: g.nodes.map(({ signal: _, ...nd }) => nd) })

describe('buildRoadGraph', () => {
  it('signals busy junctions only', () => {
    expect(hubOf(build([collector([[-100, 0], [100, 0]]), collector([[0, -100], [0, 100]])])).signal?.arms.length).toBe(4)
    expect(hubOf(build([street([[-100, 0], [100, 0]]), street([[0, -100], [0, 100]])])).signal).toBeUndefined()
    expect(hubOf(build([collector([[-100, 0], [100, 0]]), street([[0, -100], [0, 100]])])).signal?.arms.length).toBe(4)
    expect(hubOf(build([street([[-100, 0], [100, 0]]), street([[0, 0], [0, 100]])])).signal).toBeUndefined()
    const t = build([collector([[-100, 0], [100, 0]]), street([[0, 0], [0, 100]])])
    expect(hubOf(t).signal?.arms.length).toBe(3)
    for (const nd of t.nodes) if (nd.edges.length < 3) expect(nd.signal).toBeUndefined()
  })

  it('builds a T-junction as 3 edges meeting at one node', () => {
    const g = build([street([[-100, 0], [100, 0]]), street([[0, 0], [0, 100]])])
    expect(g.edges.length).toBe(3)
    const hub = g.nodes.filter((nd) => nd.edges.length === 3)
    expect(hub.length).toBe(1)
    expect(g.nodes.filter((nd) => nd.edges.length === 1).length).toBe(3)
    expect(hub[0].r).toBe(12 / 2 + 2)
  })

  it('builds a 4-way cross as 4 edges and is connected', () => {
    const g = build([street([[-100, 0], [100, 0]]), street([[0, -100], [0, 100]])])
    expect(g.edges.length).toBe(4)
    expect(g.nodes.length).toBe(5)
    const seen = new Set([0]), q = [0]
    while (q.length) for (const e of g.nodes[q.shift()!].edges) for (const m of [g.edges[e].a, g.edges[e].b]) if (!seen.has(m)) { seen.add(m); q.push(m) }
    expect(seen.size).toBe(5)
  })

  it('joins ends within 5 m', () => {
    const g = build([street([[0, 0], [100, 0]]), street([[103, 0], [200, 0]])])
    expect(g.edges.length).toBe(2)
    expect(g.edges[0].b).toBe(g.edges[1].a)
  })

  it('makes no self-loops when a cut is 3 m from a street end', () => {
    const g = build([street([[0, 0], [100, 0]]), street([[97, -50], [97, 50]])])
    expect(g.edges.some((e) => e.a === e.b)).toBe(false)
    for (const nd of g.nodes) expect(new Set(nd.edges).size).toBe(nd.edges.length)
  })

  it('stays connected when two crossings are 4 m apart near a street start', () => {
    const g = build([street([[0, 0], [100, 0]]), street([[4, -50], [4, 50]]), street([[8, -50], [8, 50]])])
    expect(g.edges.some((e) => e.a === e.b)).toBe(false)
    const seen = new Set([0]), q = [0]
    while (q.length) for (const e of g.nodes[q.shift()!].edges) for (const m of [g.edges[e].a, g.edges[e].b]) if (!seen.has(m)) { seen.add(m); q.push(m) }
    expect(seen.size).toBe(g.nodes.length)
  })

  it('carries length, cumulative distances and width', () => {
    const g = build([street([[0, 0], [60, 0], [60, 40]])])
    const e = g.edges[0]
    expect(e.len).toBeCloseTo(100, 0)
    expect(e.cum[e.cum.length - 1]).toBeCloseTo(e.len)
    expect(e.width).toBe(12)
  })

  it('keeps a closed loop street whole (no fake dead end)', () => {
    const g = build([street([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]])])
    expect(g.edges.reduce((s, e) => s + e.len, 0)).toBeCloseTo(400, 0)
  })

  it('skips bridges, tunnels, rail and paths', () => {
    const rail = feat('rail', 'roads', line([[-100, 20], [100, 20]]), { width: 6 })
    const g = build([street([[-100, 0], [100, 0]], { structure: 'bridge' }), rail])
    expect(g.edges.length).toBe(0)
  })

  it('sigma follows driving side', () => {
    expect(build([], 'left').sigma).toBe(1)
    expect(build([], 'right').sigma).toBe(-1)
  })
})

describe('traffic', () => {
  const flat = { ground: () => 0 }
  const hidden = () => false
  const cross = () => build([street([[-200, 0], [200, 0]]), street([[0, -200], [0, 200]])])
  const run = (t: Traffic, secs: number, hour = 8, each?: () => void) => { for (let i = 0; i < secs * 10; i++) { t.step(0.1, hour, hidden); each?.() } }

  it('cycles each arm green, amber, then all-red', () => {
    const nd: GNode = { id: 0, p: [0, 0], r: 9, edges: [10, 11, 12, 13], signal: { arms: [10, 11, 12, 13], offset: 0 } }
    expect(signalAt(nd, 10, 0)).toBe('green'); expect(signalAt(nd, 10, 19.9)).toBe('green')
    expect(signalAt(nd, 10, 20)).toBe('amber'); expect(signalAt(nd, 10, 22.9)).toBe('amber')
    expect(signalAt(nd, 10, 23)).toBe('red'); expect(signalAt(nd, 11, 23)).toBe('red')
    expect(signalAt(nd, 11, 25)).toBe('green'); expect(signalAt(nd, 10, 100)).toBe('green')
    expect(signalAt(nd, 99, 0)).toBe('red')
    for (let t = 0; t <= 100; t += 0.5) expect(nd.signal!.arms.filter((e) => signalAt(nd, e, t) !== 'red').length).toBeLessThanOrEqual(1)
    expect(signalAt({ ...nd, signal: { arms: nd.signal!.arms, offset: 25 } }, 11, 0)).toBe('green')
  })

  it('gives each signalled junction its own offset', () => {
    const grid = () => { const fs: PlanFeature[] = []; for (let i = 0; i <= 2; i++) { fs.push(collector([[-100, i * 200], [500, i * 200]])); fs.push(collector([[i * 200, -100], [i * 200, 500]])) } return build(fs) }
    const offs = (g: RoadGraph) => { createTraffic(g, { seed: 3, ...flat }); return g.nodes.filter((nd) => nd.signal).map((nd) => nd.signal!.offset) }
    const a = offs(grid())
    expect(a.length).toBe(9)
    expect(new Set(a).size).toBeGreaterThan(1)
    expect(offs(grid())).toEqual(a)
  })

  it('counts the sim clock', () => {
    const t = createTraffic(cross(), { seed: 7, ...flat })
    expect(t.dropped).toBe(0)
    run(t, 10)
    expect(t.time).toBeCloseTo(10, 5)
    t.step(5, 8, hidden)
    expect(t.time).toBeCloseTo(10.1, 5)
  })

  it('demand is low at night and peaks at rush hour', () => {
    expect(Math.abs(demand(3) - 0.15)).toBeLessThan(0.02)
    expect(demand(8)).toBeCloseTo(1, 2)
    expect(demand(17.5)).toBeCloseTo(1, 2)
    expect(demand(13)).toBeGreaterThanOrEqual(0.5)
    expect(demand(13)).toBeLessThanOrEqual(0.7)
    for (let h = 0; h <= 24; h += 0.25) { expect(demand(h)).toBeGreaterThanOrEqual(0.15); expect(demand(h)).toBeLessThanOrEqual(1) }
    expect(demand(24)).toBe(demand(0))
  })

  it('keeps cars on their lane side', () => {
    for (const side of ['left', 'right'] as const) {
      const t = createTraffic(build([street([[-300, 0], [300, 0]])], side), { seed: 1, ...flat })
      run(t, 20)
      const ps = t.poses().filter((_, i) => t.cars[i].inNode === undefined)
      const east = ps.filter((p) => Math.cos((p.heading * Math.PI) / 180) > 0.999), west = ps.filter((p) => Math.cos((p.heading * Math.PI) / 180) < -0.999)
      expect(east.length).toBeGreaterThan(0)
      expect(west.length).toBeGreaterThan(0)
      const sg = side === 'left' ? 1 : -1
      for (const p of east) expect(p.n * sg).toBeGreaterThan(0)
      for (const p of west) expect(p.n * sg).toBeLessThan(0)
    }
  })

  it('never puts two cars in one junction box', () => {
    const g = cross(), hub = g.nodes.find((nd) => nd.edges.length === 4)!.id, t = createTraffic(g, { seed: 7, ...flat })
    let turned = 0
    run(t, 60, 8, () => {
      const box = new Map<number, number>()
      for (const c of t.cars) if (c.inNode !== undefined) box.set(c.inNode, (box.get(c.inNode) ?? 0) + 1)
      for (const k of box.values()) expect(k).toBeLessThanOrEqual(1)
      turned += box.has(hub) ? 1 : 0
    })
    expect(turned).toBeGreaterThan(0)
  })

  const collectorCross = () => build([collector([[-200, 0], [200, 0]]), collector([[0, -200], [0, 200]])])
  /** Runs a signalled cross, reporting per step the cars in the hub box with the edge each arrived on. */
  const watchHub = (secs: number, each: (t: Traffic, inBox: { id: number; via: number; v: number }[], hub: GNode) => void) => {
    const g = collectorCross(), hub = hubOf(g), t = createTraffic(g, { seed: 5, ...flat })
    const prev = new Map<number, number>(), via = new Map<number, number>()
    run(t, secs, 8, () => {
      for (const c of t.cars) if (c.inNode === hub.id && !via.has(c.id)) via.set(c.id, prev.get(c.id)!)
      for (const c of t.cars) if (c.inNode !== hub.id) via.delete(c.id)
      each(t, t.cars.filter((c) => c.inNode === hub.id).map((c) => ({ id: c.id, via: via.get(c.id)!, v: c.v })), hub)
      for (const c of t.cars) prev.set(c.id, c.edge)
    })
  }

  it('stops cars on red at a signalled junction', () => {
    const seen = new Set<number>(), lights: string[] = []
    watchHub(150, (t, box, hub) => { for (const b of box) if (!seen.has(b.id)) { seen.add(b.id); lights.push(signalAt(hub, b.via, t.time)) } })
    expect(lights.length).toBeGreaterThanOrEqual(5)
    for (const l of lights) expect(['green', 'amber']).toContain(l)
  }, 30000)

  it('never mixes two arms in a signalled box', () => {
    watchHub(150, (_t, box) => expect(new Set(box.map((b) => b.via)).size).toBeLessThanOrEqual(1))
  }, 30000)

  it('streams several cars through on green', () => {
    let most = 0
    watchHub(150, (_t, box) => { most = Math.max(most, box.length) })
    expect(most).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('lets a car in the box finish when its light turns red', () => {
    const still = new Map<number, number>()
    let worst = 0
    watchHub(150, (_t, box) => { for (const b of box) { const s = b.v < 0.1 ? (still.get(b.id) ?? 0) + 0.1 : 0; still.set(b.id, s); worst = Math.max(worst, s) } })
    expect(worst).toBeLessThanOrEqual(3)
  }, 30000)

  it('drops fewer stuck cars with signals than give-way', () => {
    const fs: PlanFeature[] = []
    for (let i = 0; i <= 3; i++) { fs.push(arterial([[-100, i * 200], [700, i * 200]])); fs.push(arterial([[i * 200, -100], [i * 200, 700]])) }
    const g = build(fs)
    const dropped = (gr: RoadGraph) => { const t = createTraffic(gr, { seed: 1, ...flat }); for (let i = 0; i < 18000; i++) t.step(0.1, 8, () => true); return t.dropped }
    const gw = dropped(giveWay(g)), sig = dropped(g)
    expect(gw).toBeGreaterThan(0)
    expect(sig).toBeLessThan(gw)
  }, 120000)

  /** Longest time (s) any car stood still, and longest any box car stood still. */
  const stalls = (t: Traffic, secs: number, visible = () => true) => {
    const still = new Map<number, number>()
    let worst = 0, boxWorst = 0
    for (let i = 0; i < secs * 10; i++) {
      t.step(0.1, 8, visible)
      for (const c of t.cars) { const s = c.v < 0.1 ? (still.get(c.id) ?? 0) + 0.1 : 0; still.set(c.id, s); worst = Math.max(worst, s); if (c.inNode !== undefined) boxWorst = Math.max(boxWorst, s) }
    }
    return { worst, boxWorst }
  }

  it('clears a jam on a signalled arterial grid', () => {
    const fs: PlanFeature[] = []
    for (let i = 0; i <= 3; i++) { fs.push(arterial([[-100, i * 200], [700, i * 200]])); fs.push(arterial([[i * 200, -100], [i * 200, 700]])) }
    // the valve clock pauses on red, so a jam clears after 60 s of green = 3 cycles of 100 s (4 arms); + slack. Longer = a jam nothing clears
    expect(stalls(createTraffic(build(fs), { seed: 1, ...flat }), 1800).worst).toBeLessThanOrEqual(360)
  }, 120000)

  it('never stalls a car inside a signalled box on short blocks', () => {
    const g = build([collector([[-200, 0], [200, 0]]), collector([[-200, 12], [200, 12]]), collector([[-50, -200], [-50, 200]]), collector([[50, -200], [50, 200]])])
    for (const seed of [2, 4, 6]) expect(stalls(createTraffic(g, { seed, ...flat }), 600).boxWorst).toBeLessThanOrEqual(5)
  }, 120000)

  it('handles a zero-length lane between signalled nodes', () => {
    const t = createTraffic(build([collector([[-200, 0], [200, 0]]), collector([[-200, 12], [200, 12]]), collector([[-50, -200], [-50, 200]]), collector([[50, -200], [50, 200]])]), { seed: 2, ...flat })
    run(t, 60)
    for (const p of t.poses()) { expect(Number.isFinite(p.e)).toBe(true); expect(Number.isFinite(p.n)).toBe(true) }
  }, 30000)

  it('keeps the following gap', () => {
    const t = createTraffic(cross(), { seed: 7, ...flat })
    run(t, 60, 8, () => {
      const lanes = new Map<string, typeof t.cars>()
      for (const c of t.cars) if (c.inNode === undefined) { const k = `${c.edge}:${c.lane}`; lanes.set(k, [...(lanes.get(k) ?? []), c]) }
      for (const cs of lanes.values()) {
        cs.sort((a, b) => a.s - b.s)
        for (let i = 1; i < cs.length; i++) expect(cs[i].s - cs[i - 1].s - (VEHICLE_SIZE[cs[i].kind][0] + VEHICLE_SIZE[cs[i - 1].kind][0]) / 2).toBeGreaterThanOrEqual(2 - 1e-6)
      }
    })
  })

  const arterial = (pts: [number, number][]) => street(pts, { width: 24, lanes: 4, sidewalk: 3, roadClass: 'arterial' })

  it('keeps the gap to the car turning ahead out of the same lane', () => {
    const g = build([arterial([[-60, 0], [60, 0]]), arterial([[0, -60], [0, 60]]), arterial([[-60, -60], [-60, 60]]), arterial([[60, -60], [60, 60]]), arterial([[-60, 60], [60, 60]])])
    for (const seed of [9, 11]) {
      const t = createTraffic(g, { seed, ...flat })
      let checked = 0
      run(t, 120, 8, () => {
        const cs = t.cars as any[]
        for (const b of cs) {
          if (b.inNode === undefined) continue
          for (const c of b.at.cars as any[]) { checked++; expect(b.at.len - c.s + b.s - (b.L + c.L) / 2).toBeGreaterThanOrEqual(2 - 1e-6) }
        }
      })
      expect(checked).toBeGreaterThan(0)
    }
  })

  it('keeps turning cars clear of cars waiting at the box', () => {
    // separating-axis overlap of two car footprints
    const box = (p: CarSpot) => { const [L, W] = VEHICLE_SIZE[p.kind], a = (-p.heading * Math.PI) / 180, u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]]; return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, q]) => [p.e + (s * L * u[0]) / 2 + (q * W * v[0]) / 2, p.n + (s * L * u[1]) / 2 + (q * W * v[1]) / 2]) }
    const apart = (A: number[][], B: number[][]) => [A, B].some((P) => P.some((a, i) => {
      const b = P[(i + 1) % 4], ax = [b[1] - a[1], a[0] - b[0]], pa = A.map((q) => q[0] * ax[0] + q[1] * ax[1]), pb = B.map((q) => q[0] * ax[0] + q[1] * ax[1])
      return Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)
    }))
    const g = build([arterial([[-60, 0], [60, 0]]), arterial([[0, -60], [0, 60]]), arterial([[-60, -60], [-60, 60]]), arterial([[60, -60], [60, 60]]), arterial([[-60, 60], [60, 60]])])
    const small = new Set(['sedan', 'hatch', 'suv'])
    for (const seed of [3, 5, 9, 11]) {
      const t = createTraffic(g, { seed, ...flat })
      let hits = 0
      run(t, 120, 8, () => {
        const ps = t.poses(), bs = ps.map(box)
        t.cars.forEach((b, i) => {
          if (b.inNode === undefined) return
          t.cars.forEach((c, j) => { if (j !== i && small.has(c.kind) && !apart(bs[i], bs[j])) hits++ })
        })
      })
      expect(hits).toBe(0)
    }
  }, 30000)

  it('never gridlocks a dense arterial grid', () => {
    const fs: PlanFeature[] = []
    for (let i = 0; i <= 3; i++) { fs.push(arterial([[-100, i * 200], [700, i * 200]])); fs.push(arterial([[i * 200, -100], [i * 200, 700]])) }
    const g = build(fs)
    for (const visible of [() => true, () => false]) {
      const t = createTraffic(giveWay(g), { seed: 1, ...flat }), still = new Map<number, number>()
      let worst = 0
      for (let i = 0; i < 6000; i++) {
        t.step(0.1, 8, visible)
        for (const c of t.cars) { const s = c.v < 0.1 ? (still.get(c.id) ?? 0) + 0.1 : 0; still.set(c.id, s); worst = Math.max(worst, s) }
      }
      expect(worst).toBeLessThanOrEqual(60.2)
      if (!visible()) expect(t.dropped).toBeGreaterThan(0) // give-way jams off-screen: the valve fires and is counted
      expect(t.cars.filter((c) => c.v >= 0.1).length).toBeGreaterThan(0)
    }
  }, 30000)

  it('fewer cars at 03:00 than 08:00, never above MAX_MOVING', () => {
    const count = (hour: number) => {
      const t = createTraffic(cross(), { seed: 3, ...flat })
      run(t, 120, hour, () => expect(t.cars.length).toBeLessThanOrEqual(MAX_MOVING))
      return t.cars.length
    }
    expect(count(3)).toBeLessThan(count(8))
  })

  it('is deterministic per seed', () => {
    const [a, b] = [createTraffic(cross(), { seed: 5, ...flat }), createTraffic(cross(), { seed: 5, ...flat })]
    run(a, 30); run(b, 30)
    expect(a.poses().length).toBeGreaterThan(0)
    expect(a.poses()).toEqual(b.poses())
  })

  it('turns back at dead ends', () => {
    const t = createTraffic(build([street([[0, 0], [200, 0]])]), { seed: 2, ...flat })
    const still = new Map<number, number>()
    run(t, 300, 8, () => {
      for (const c of t.cars) {
        still.set(c.id, c.v < 0.1 ? (still.get(c.id) ?? 0) + 0.1 : 0)
        expect(still.get(c.id)!).toBeLessThanOrEqual(30)
      }
    })
    expect(t.cars.length).toBeGreaterThan(0)
  })

  it('handles an empty graph', () => {
    const t = createTraffic(build([]), { seed: 1, ...flat })
    for (let i = 0; i < 10; i++) t.step(0.1, 8, hidden)
    expect(t.cars.length).toBe(0)
    expect(t.poses()).toEqual([])
  })

  it('survives very short edges', () => {
    const g = build([street([[-100, 0], [100, 0]]), street([[-3, -100], [-3, 100]]), street([[3, -100], [3, 100]])])
    expect(g.edges.some((e) => e.len < 7)).toBe(true)
    const t = createTraffic(g, { seed: 4, ...flat })
    run(t, 60, 8, () => { for (const p of t.poses()) for (const x of [p.e, p.n, p.y, p.heading, p.pitch!]) expect(Number.isFinite(x)).toBe(true) })
    expect(t.cars.length).toBeGreaterThan(0)
  })

  it('clamps big dt', () => {
    const t = createTraffic(cross(), { seed: 9, ...flat })
    run(t, 30)
    const before = new Map(t.poses().map((p, i) => [t.cars[i].id, p]))
    t.step(5, 8, hidden)
    const vmax = 30 / 3.6
    t.poses().forEach((p, i) => {
      const q = before.get(t.cars[i].id)
      if (q) expect(Math.hypot(p.e - q.e, p.n - q.n)).toBeLessThanOrEqual(vmax * 0.1 + 1e-6)
    })
  })
})
