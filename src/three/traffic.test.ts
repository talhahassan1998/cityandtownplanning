import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { LineString, Polygon } from 'geojson'
import { footprint, frame, roadSurface } from '../geo'
import { newProject, type PlanFeature } from '../model'
import { parkingBays } from './models'
import { laneLayout, placeCars } from './traffic'
import { VEHICLE_SIZE } from './cars'

const C: [number, number] = [67.0, 24.86]
const F = frame(C)
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
const flat = () => 0
const ang = (h: number) => ((h % 360) + 360) % 360

describe('placeCars', () => {
  const ew = street([[-200, 0], [200, 0]])

  it('keeps traffic on the left (default) or right of its heading', () => {
    for (const side of ['left', 'right'] as const) {
      const cars = placeCars([ew], toLocal, side, flat)
      expect(cars.length).toBeGreaterThan(2)
      for (const c of cars) {
        const east = ang(c.heading) < 1 || ang(c.heading) > 359
        expect(east || Math.abs(ang(c.heading) - 180) < 1).toBe(true)
        // heading east: left = north (n > 0)
        expect(Math.sign(c.n)).toBe((east ? 1 : -1) * (side === 'left' ? 1 : -1))
      }
    }
  })

  it('has no kerb parking: lanes fill the whole carriageway', () => {
    for (const [width, lanes, sidewalk, cls] of [[12, 2, 1.5, 'local'], [15, 2, 2.5, 'collector'], [20, 2, 1.5, 'local']] as const) {
      const L = laneLayout({ width, lanes, sidewalk }, cls)!
      expect('kerbs' in L).toBe(false)
      expect(L.lanes.reduce((w, l) => w + l.width, 0)).toBeCloseTo(width - 2 * sidewalk)
    }
    const cw = 12 - 2 * 1.5, lane = cw / 2
    for (const c of placeCars([ew], toLocal, 'left', flat)) expect(Math.abs(Math.abs(c.n) - lane / 2)).toBeLessThan(0.01) // lane centres only
  })

  it('keeps clear of junctions', () => {
    const ns = feat('road-arterial', 'roads', line([[0, -200], [0, 200]]), { width: 24, lanes: 4, sidewalk: 3, roadClass: 'arterial' })
    const cars = placeCars([ew, ns], toLocal, 'left', flat)
    for (const c of cars.filter((c) => Math.abs(c.n) < 6)) expect(Math.abs(c.e)).toBeGreaterThanOrEqual(12 + 12 - 0.01) // on the E–W street, clear of the arterial
    for (const c of cars.filter((c) => Math.abs(c.e) < 12)) expect(Math.abs(c.n)).toBeGreaterThanOrEqual(12 + 6 - 0.01)
  })

  it('follows a bent street and stays on its surface', () => {
    const bent = street([[-150, 0], [0, 0], [0, 150]])
    const surf = roadSurface(bent as any, 12)!
    const local: Polygon = { type: 'Polygon', coordinates: (surf.geometry as Polygon).coordinates.map((r) => r.map(toLocal)) }
    const cars = placeCars([bent], toLocal, 'left', flat)
    expect(cars.length).toBeGreaterThan(2)
    for (const c of cars) expect(turf.booleanPointInPolygon([c.e, c.n], local)).toBe(true)
  })

  it('spaces traffic by length, not by vertex count, on finely drawn curves', () => {
    const arc = (step: number): [number, number][] => { const R = 150, n = Math.round((Math.PI * R) / step); return Array.from({ length: n + 1 }, (_, i) => [R * Math.cos((Math.PI * i) / n), R * Math.sin((Math.PI * i) / n)] as [number, number]) }
    const straight = placeCars([street([[-236, 0], [236, 0]])], toLocal, 'left', flat).length
    for (const step of [7.5, 3]) expect(placeCars([street(arc(step))], toLocal, 'left', flat).length, `segments ${step} m`).toBeGreaterThan(straight * 0.6)
  })

  it('ignores cycle tracks, footpaths and rail for junctions and building fronts', () => {
    const alone = placeCars([ew], toLocal, 'left', flat).length
    const cycle = feat('road-cycle', 'roads', line([[-200, 8], [200, 8]]), { width: 3, lanes: 1, roadClass: 'cycle' })
    expect(placeCars([ew, cycle], toLocal, 'left', flat).length).toBe(alone)
    const rail = feat('rail', 'roads', line([[-100, 25], [100, 25]]), { width: 8, lanes: 2, roadClass: 'rail' })
    const house = feat('house', 'buildings', footprint(F.toGeo([0, 15]), 10, 12), { floors: 2 })
    expect(placeCars([rail, house], toLocal, 'left', flat)).toEqual([]) // no street within 40 m: no driveway car
  })

  it('lays lanes out to fill the carriageway, centre line between the directions', () => {
    for (const [width, lanes, sidewalk, cls] of [[12, 2, 1.5, 'local'], [15, 2, 2.5, 'collector'], [24, 4, 3, 'arterial'], [20, 2, 1.5, 'local'], [9, 2, 1.5, 'local']] as const) {
      const L = laneLayout({ width, lanes, sidewalk }, cls)!
      const cw = width - 2 * sidewalk
      expect(L.cw).toBeCloseTo(cw)
      const strips = L.lanes.map((l) => [l.off - l.width / 2, l.off + l.width / 2]).sort((a, b) => a[0] - b[0])
      expect(strips[0][0]).toBeCloseTo(-cw / 2); expect(strips[strips.length - 1][1]).toBeCloseTo(cw / 2)
      for (let i = 1; i < strips.length; i++) expect(strips[i][0]).toBeCloseTo(strips[i - 1][1]) // no gaps, no overlaps
      const fwd = L.lanes.filter((l) => l.dir === 1), back = L.lanes.filter((l) => l.dir === -1)
      expect(Math.min(...fwd.map((l) => l.off))).toBeGreaterThan(Math.max(...back.map((l) => l.off)))
      expect(L.lines.some((l) => l.kind === 'centre' || l.kind === 'double')).toBe(true)
    }
  })

  it('puts every car exactly on a lane centre, without overlapping another car', () => {
    for (const side of ['left', 'right'] as const) {
      const sgn = side === 'left' ? 1 : -1
      for (const attrs of [{}, { width: 15, sidewalk: 2.5, roadClass: 'collector', lanes: 2 }, { width: 20 }]) {
        const road = street([[-300, 0], [300, 0]], attrs)
        const L = laneLayout(road.properties.attrs, String(road.properties.attrs.roadClass))!
        const centres = L.lanes.map((l) => l.off * sgn)
        const cars = placeCars([road], toLocal, side, flat)
        expect(cars.length).toBeGreaterThan(3)
        for (const c of cars) expect(Math.min(...centres.map((o) => Math.abs(o - c.n)))).toBeLessThan(0.01)
        const box = (c: typeof cars[0]) => { const [l, w] = VEHICLE_SIZE[c.kind]; return turf.polygon([[[c.e - l / 2, c.n - w / 2], [c.e + l / 2, c.n - w / 2], [c.e + l / 2, c.n + w / 2], [c.e - l / 2, c.n + w / 2], [c.e - l / 2, c.n - w / 2]]]) }
        for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) expect(turf.booleanIntersects(box(cars[i]), box(cars[j])), `${side} ${JSON.stringify(attrs)} cars ${i},${j}`).toBe(false)
      }
    }
  })

  it('handles one-lane and zero-width roads', () => {
    const one = placeCars([street([[-200, 0], [200, 0]], { lanes: 1, width: 6, sidewalk: 0 })], toLocal, 'left', flat)
    expect(one.length).toBeGreaterThan(0)
    expect(new Set(one.map((c) => Math.round(ang(c.heading)))).size).toBe(1)
    const none = placeCars([street([[-200, 0], [200, 0]], { width: 0 })], toLocal, 'left', flat)
    expect(none).toEqual([])
  })

  it('parks a car in front of a house, never on it or on the road', () => {
    const road = street([[-100, 0], [100, 0]], { width: 9 })
    const house = feat('house', 'buildings', footprint(F.toGeo([0, 15]), 10, 12), { floors: 2 })
    const cars = placeCars([road, house], toLocal, 'left', flat).filter((c) => c.n > 4.5) // not on the road
    expect(cars).toHaveLength(1)
    const [c] = cars
    expect(c.n).toBeLessThan(9) // between the house (n ≥ 9) and the road (n ≤ 4.5)
    const far = placeCars([feat('house', 'buildings', footprint(F.toGeo([0, 300]), 10, 12), { floors: 2 })], toLocal, 'left', flat)
    expect(far).toEqual([])
  })

  it('fills about 70% of parking bays, inside the parking area', () => {
    const lot = feat('parking', 'roads', footprint(C, 40, 25))
    const cars = placeCars([lot], toLocal, 'left', flat)
    const bays = parkingBays(20, 12.5).length
    expect(cars.length).toBeGreaterThan(bays * 0.4); expect(cars.length).toBeLessThan(bays * 0.95)
    for (const c of cars) { expect(Math.abs(c.e)).toBeLessThan(20); expect(Math.abs(c.n)).toBeLessThan(12.5) }
  })

  it('lanes: false leaves only parking and building cars', () => {
    const road = street([[-200, 0], [200, 0]]), lot = feat('parking', 'roads', footprint(F.toGeo([0, 60]), 40, 25))
    expect(placeCars([road, lot], toLocal, 'left', flat).some((c) => Math.abs(c.n) < 6)).toBe(true)
    const cars = placeCars([road, lot], toLocal, 'left', flat, { lanes: false })
    expect(cars.length).toBeGreaterThan(0)
    for (const c of cars) expect(Math.abs(c.n)).toBeGreaterThan(6)
    expect(cars).toEqual(placeCars([lot], toLocal, 'left', flat))
  })

  it('sits cars on top of the road surface and tilts them with the slope', () => {
    const slope = (e: number) => e * 0.2 // rises 20% to the east
    const cars = placeCars([ew], toLocal, 'left', slope)
    expect(cars.length).toBeGreaterThan(2)
    for (const c of cars) {
      expect(c.y).toBeGreaterThanOrEqual(slope(c.e) + 0.15) // above the draped road (lift 0.12) and plots (0.15)
      const east = ang(c.heading) < 1 || ang(c.heading) > 359
      expect(c.pitch!).toBeCloseTo((east ? 1 : -1) * (Math.atan(0.2) * 180) / Math.PI, 0) // nose up when driving uphill
      expect(Math.abs(c.roll!)).toBeLessThan(0.5)
    }
  })

  it('keeps the whole car clear of the road on a hump between its centre and an axle', () => {
    for (const ridge of [1, -1.5, 2]) {
      const g = (e: number) => -0.1 * Math.abs(e - ridge) // crest across the road
      const [c] = placeCars([street([[-200, 0], [200, 0]])], toLocal, 'left', (e) => g(e)).filter((c) => Math.abs(c.e) < 40).sort((a, b) => Math.abs(a.e) - Math.abs(b.e))
      if (!c) continue
      const slope = Math.tan((c.pitch! * Math.PI) / 180) * (ang(c.heading) < 90 || ang(c.heading) > 270 ? 1 : -1)
      for (let j = 0; j <= 10; j++) { const k = -2.3 + j * 0.46; expect(c.y + slope * k - g(c.e + k), `ridge ${ridge} at ${k.toFixed(2)}`).toBeGreaterThanOrEqual(0.12 - 0.001) } // a sedan's ground samples
    }
  })

  it('is deterministic, capped at 3000, and skips rail, cycle and bridges', () => {
    expect(placeCars([ew], toLocal, 'left', flat)).toEqual(placeCars([ew], toLocal, 'left', flat))
    const grid: PlanFeature[] = []
    for (let i = 0; i < 12; i++) grid.push(feat('road-arterial', 'roads', line([[-1500, i * 120], [1500, i * 120]]), { width: 30, lanes: 6, sidewalk: 0, roadClass: 'highway' }))
    expect(placeCars(grid, toLocal, 'left', flat).length).toBeLessThanOrEqual(3000)
    const rail = feat('rail', 'roads', line([[-200, 0], [200, 0]]), { width: 8, lanes: 2 })
    const cycle = feat('road-cycle', 'roads', line([[-200, 0], [200, 0]]), { width: 3, lanes: 1 })
    const bridge = street([[-200, 0], [200, 0]], { structure: 'bridge' })
    expect(placeCars([rail, cycle, bridge], toLocal, 'left', flat)).toEqual([])
  })
})
