import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { Position } from 'geojson'
import { footprint } from './geo'
import { componentDef, defaultAttrs, type PlanFeature } from './model'
import { analyzeNetworks } from './networks'

const C: Position = [67.0, 24.86]
// metres east/north of C → lng/lat
const at = (e: number, n: number): Position => turf.destination(turf.destination(C, e, 90, { units: 'meters' }), n, 0, { units: 'meters' }).geometry.coordinates
let k = 0
const feat = (type: string, geometry: any, attrs: any = {}): PlanFeature => {
  const id = `${type}-${++k}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: 'L', type, name: `${type} ${k}`, attrs: { ...defaultAttrs(componentDef(type)), ...attrs } } }
}
const line = (type: string, pts: [number, number][], attrs = {}) => feat(type, { type: 'LineString', coordinates: pts.map(([e, n]) => at(e, n)) }, attrs)
const point = (type: string, e: number, n: number) => feat(type, { type: 'Point', coordinates: at(e, n) })
const codes = (r: ReturnType<typeof analyzeNetworks>, id: string) => (r.byId.get(id) ?? []).map((i) => i.code).sort()

describe('water network', () => {
  // tank at the origin feeding a main east, with a branch north from its midpoint (T-junction)
  const tank = point('water-tank', 0, 0)
  const main = line('water-main', [[0, 0], [200, 0]])
  const branch = line('water-main', [[100, 0], [100, 80]])
  const hydrant = point('hydrant', 100, 80)
  const end = point('valve', 200, 0)

  it('treats a fed, closed network as connected with no issues', () => {
    const r = analyzeNetworks([tank, main, branch, hydrant, end])
    expect(r.issues).toEqual([])
    const s = r.summaries.find((x) => x.network === 'water')!
    expect(s.components).toBe(1)
    expect(s.segments).toBe(2)
    expect(s.nodes).toBe(3)
    expect(s.length).toBeCloseTo(280, 0)
    expect(s.bySize['150 mm HDPE']).toBeCloseTo(280, 0)
  })

  it('flags open ends, isolated segments and a missing source', () => {
    const island = line('water-main', [[0, 300], [50, 300]])
    const r = analyzeNetworks([main, branch, island]) // no tank this time
    expect(codes(r, island.id)).toEqual(['disconnected', 'open-end', 'open-end'])
    expect(r.issues.filter((i) => i.code === 'no-source')).toHaveLength(1)
    expect(codes(r, branch.id)).toEqual(['open-end']) // top of the branch goes nowhere
    expect(r.summaries.find((x) => x.network === 'water')!.components).toBe(2)
  })

  it('accepts a source that is a polygon facility the line ends inside', () => {
    const pump = feat('pump-station', footprint(at(-5, 0), 15, 15))
    const r = analyzeNetworks([pump, main, end])
    expect(r.issues.filter((i) => i.code === 'no-source' || i.code === 'open-end')).toEqual([])
  })
})

describe('conflicts and coverage', () => {
  it('flags pipes under buildings but not ones passing beside them', () => {
    const house = feat('house', footprint(at(50, 0), 10, 12), {})
    const through = line('sewer', [[0, 0], [100, 0]])
    const beside = line('sewer', [[0, 20], [100, 20]])
    const r = analyzeNetworks([house, through, beside, feat('treatment', footprint(at(-40, 10), 80, 60))])
    expect(codes(r, through.id)).toContain('under-building')
    expect(codes(r, beside.id)).not.toContain('under-building')
  })

  it('flags long water–sewer parallels closer than 3 m, not crossings', () => {
    const water = line('water-main', [[0, 0], [100, 0]])
    const parallel = line('sewer', [[20, 2], [60, 2]])
    const crossing = line('sewer', [[50, -30], [50, 30]])
    expect(codes(analyzeNetworks([water, parallel]), water.id)).toContain('separation')
    expect(codes(analyzeNetworks([water, crossing]), water.id)).not.toContain('separation')
  })

  it('flags buildings beyond the service distance of an existing network only', () => {
    const near = feat('house', footprint(at(0, 30), 10, 12), {})
    const far = feat('house', footprint(at(0, 200), 10, 12), {})
    const power = line('power-line', [[-50, 0], [50, 0]])
    const r = analyzeNetworks([near, far, power, feat('substation', footprint(at(-60, 0), 30, 30))])
    expect(codes(r, near.id)).toEqual([])
    expect(codes(r, far.id)).toEqual(['unserved'])
    expect(r.byId.get(far.id)![0].message).toMatch(/electricity line within 60 m/)
    // no water network drawn → nobody is flagged for water
    expect(r.issues.some((i) => i.network === 'water')).toBe(false)
  })
})

describe('transit', () => {
  it('connects routes through stops and requires a station', () => {
    const route = line('bus-route', [[0, 0], [300, 0]])
    const stop = point('bus-stop', 150, 0)
    const r = analyzeNetworks([route, stop])
    expect(r.issues.map((i) => i.code).sort()).toEqual(['no-source', 'open-end', 'open-end'])
    const station = feat('station', footprint(at(0, 0), 60, 20), { floors: 2 })
    const r2 = analyzeNetworks([route, stop, station, feat('station', footprint(at(300, 0), 60, 20), { floors: 2 })])
    expect(r2.issues.filter((i) => i.network === 'transit')).toEqual([])
  })
})
