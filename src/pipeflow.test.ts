import { describe, expect, it } from 'vitest'
import { footprint, frame } from './geo'
import { componentDef, defaultAttrs, type PlanFeature } from './model'
import { pipeFlow, type FlowPipe } from './pipeflow'

const F = frame([67.0, 24.86])
const toLocal = (p: any) => F.toLocal(p) as [number, number]
let k = 0
const feat = (type: string, geometry: any, attrs: any = {}): PlanFeature => {
  const id = `${type}-${++k}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: 'L', type, name: id, attrs: { ...defaultAttrs(componentDef(type)), ...attrs } } }
}
const pipe = (type: 'water-main' | 'sewer', pts: [number, number][], attrs = {}) => feat(type, { type: 'LineString', coordinates: pts.map((p) => F.toGeo(p)) }, attrs)
const point = (type: string, e: number, n: number) => feat(type, { type: 'Point', coordinates: F.toGeo([e, n]) })
const flat = () => 0
const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5
const byId = (ps: FlowPipe[], f: PlanFeature) => ps.find((p) => p.id === f.id)!

describe('pipeFlow', () => {
  it('sends water away from the tank', () => {
    const a = pipe('water-main', [[100, 0], [0, 0]]), b = pipe('water-main', [[200, 0], [100, 0]])
    const net = pipeFlow([point('water-tank', 0, 0), a, b], toLocal, flat)
    expect(near(byId(net.pipes, a).pts[0], [0, 0])).toBe(true)
    expect(near(byId(net.pipes, b).pts[0], [100, 0])).toBe(true)
    expect(net.pipes.every((p) => p.connected && p.network === 'water' && p.speed === 1)).toBe(true)
  })

  it('sends sewage to the plant', () => {
    const plant = feat('treatment', footprint(F.toGeo([300, 0]), 80, 60))
    const ps = [pipe('sewer', [[0, 0], [100, 0]]), pipe('sewer', [[200, 0], [100, 0]]), pipe('sewer', [[200, 0], [290, 0]])]
    const net = pipeFlow([plant, ...ps], toLocal, flat)
    expect(near(byId(net.pipes, ps[0]).pts.at(-1)!, [100, 0])).toBe(true)
    expect(near(byId(net.pipes, ps[1]).pts.at(-1)!, [200, 0])).toBe(true)
    expect(near(byId(net.pipes, ps[2]).pts.at(-1)!, [290, 0])).toBe(true)
    expect(net.pipes.every((p) => p.connected && p.speed === 0.6)).toBe(true)
  })

  it('always falls downstream, deeper where the ground rises', () => {
    const plant = feat('treatment', footprint(F.toGeo([300, 0]), 80, 60))
    const ps = [pipe('sewer', [[0, 0], [50, 0], [100, 0]]), pipe('sewer', [[100, 0], [150, 0], [200, 0]]), pipe('sewer', [[200, 0], [290, 0]])]
    const ground = (e: number) => 0.05 * e
    const net = pipeFlow([plant, ...ps], toLocal, ground)
    const chain = ps.map((p) => byId(net.pipes, p))
    let prev = Infinity
    for (const p of chain) for (const [e, , y] of p.pts) {
      expect(y).toBeLessThanOrEqual(prev + 1e-9)
      expect(y).toBeLessThanOrEqual(ground(e) - 1.5 + 1e-9)
      prev = y
    }
  })

  it('orients every pipe once on a loop with two sources', () => {
    const fs: PlanFeature[] = [point('water-tank', 0, 0), point('water-tank', 200, 200)]
    for (let i = 0; i <= 2; i++) for (let j = 0; j < 2; j++) { fs.push(pipe('water-main', [[j * 100, i * 100], [j * 100 + 100, i * 100]])); fs.push(pipe('water-main', [[i * 100, j * 100], [i * 100, j * 100 + 100]])) }
    const net = pipeFlow(fs, toLocal, flat)
    expect(net.pipes.length).toBe(12)
    for (const p of net.pipes) { expect(p.connected).toBe(true); for (const v of p.pts) for (const x of v) expect(Number.isFinite(x)).toBe(true) }
    // the pipes leaving each tank run away from it
    for (const t of [[0, 0], [200, 200]]) for (const p of net.pipes) if (near(p.pts.at(-1)!, t)) throw new Error('flows into a tank')
  })

  it('leaves unconnected pipes still', () => {
    const lone = pipe('water-main', [[500, 500], [600, 500]])
    const net = pipeFlow([point('water-tank', 0, 0), pipe('water-main', [[0, 0], [100, 0]]), lone], toLocal, flat)
    expect(byId(net.pipes, lone).connected).toBe(false)
  })

  it('honours a set depth', () => {
    const p = pipe('water-main', [[0, 0], [100, 0]], { depth: 3 })
    const net = pipeFlow([point('water-tank', 0, 0), p], toLocal, flat)
    for (const v of byId(net.pipes, p).pts) expect(v[2]).toBeCloseTo(-3, 9)
  })

  it('puts water mains 1.2 m deep by default', () => {
    const p = pipe('water-main', [[0, 0], [100, 0]])
    for (const v of byId(pipeFlow([point('water-tank', 0, 0), p], toLocal, () => 10).pipes, p).pts) expect(v[2]).toBeCloseTo(8.8, 9)
  })

  it('puts manholes at sewer junctions and ends', () => {
    const plant = feat('treatment', footprint(F.toGeo([0, -80]), 80, 60))
    const net = pipeFlow([plant, pipe('sewer', [[-100, 0], [0, 0]]), pipe('sewer', [[100, 0], [0, 0]]), pipe('sewer', [[0, 0], [0, -60]])], toLocal, flat)
    expect(net.manholes.length).toBe(4)
    for (const [, , yPipe, yGround] of net.manholes) expect(yGround).toBeGreaterThan(yPipe)
  })

  it('ignores other networks and handles none', () => {
    expect(pipeFlow([], toLocal, flat).pipes).toEqual([])
    expect(pipeFlow([feat('power-line', { type: 'LineString', coordinates: [F.toGeo([0, 0]), F.toGeo([10, 0])] })], toLocal, flat).pipes).toEqual([])
  })
})
