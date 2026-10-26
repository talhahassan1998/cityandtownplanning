import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import { clearRoads, footprint, lineAt, measure, roadSurface, rotate, stats, subdivide, translate, unitsOf, frame, frameToMercator, knobPoint, roundGeometry } from './geo'
import { newProject, type PlanFeature } from './model'

const C: [number, number] = [67.0, 24.86]
const feat = (geometry: any, type = 'house', attrs: any = {}, layerId = 'L'): PlanFeature =>
  ({ type: 'Feature', id: type, geometry, properties: { id: type, layerId, type, name: type, attrs } })

describe('footprint', () => {
  it('has the requested area and edge lengths', () => {
    const f = feat(footprint(C, 20, 10))
    const m = measure(f)
    expect(m.area).toBeCloseTo(200, -1) // ±5 m²
    expect(m.perimeter).toBeCloseTo(60, 0)
  })
  it('rotation preserves area', () => {
    expect(measure(feat(footprint(C, 20, 10, 37))).area).toBeCloseTo(200, -1)
    expect(measure(rotate(feat(footprint(C, 20, 10)), 45)).area).toBeCloseTo(200, -1)
  })
  it('translate moves the centroid by the requested metres', () => {
    const a = feat(footprint(C, 10, 10))
    const b = translate(a, 100, 0)
    expect(turf.distance(turf.centroid(a), turf.centroid(b), { units: 'meters' })).toBeCloseTo(100, 0)
  })
})

describe('roads', () => {
  it('line length and surface area ≈ length × width', () => {
    const line = feat(lineAt(C, 200), 'road')
    expect(measure(line).length).toBeCloseTo(200, 0)
    const surf = roadSurface(line as any, 10)!
    // buffer adds two half-disc end caps: 200*10 + π*5²
    expect(turf.area(surf)).toBeGreaterThan(2000)
    expect(turf.area(surf)).toBeLessThan(2000 + Math.PI * 25 + 20)
  })
  it('rejects degenerate input', () => {
    expect(roadSurface(feat(lineAt(C, 50), 'road') as any, 0)).toBeUndefined()
  })
})

describe('subdivide', () => {
  const boundary = footprint(C, 200, 120)
  const opts = { plotWidth: 15, plotDepth: 25, roadWidth: 10, plotsPerBlock: 6, angle: 0, minArea: 300, minFrontage: 12 }

  it('produces plots inside the boundary that do not overlap', () => {
    const { plots, roads } = subdivide(boundary, opts)
    expect(plots.length).toBeGreaterThan(20)
    expect(roads.length).toBeGreaterThan(2)
    const total = plots.reduce((s, p) => s + turf.area(p.geometry), 0)
    expect(total).toBeLessThan(turf.area(boundary))
    for (const p of plots.slice(0, 10)) expect(turf.booleanWithin(turf.centroid(p.geometry), boundary)).toBe(true)
    // pairwise overlap check on a sample
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const x = turf.intersect(turf.featureCollection([turf.polygon(plots[i].geometry.coordinates), turf.polygon(plots[j].geometry.coordinates)]))
      expect(x ? turf.area(x) : 0).toBeLessThan(1)
    }
  })

  it('full plots measure width × depth and pass validation', () => {
    const { plots } = subdivide(boundary, opts)
    const full = plots.filter((p) => !p.issue)
    expect(full.length).toBeGreaterThan(10)
    expect(full[0].area).toBeCloseTo(375, 0)
    expect(full[0].frontage).toBeCloseTo(15, 0)
    expect(turf.area(full[0].geometry)).toBeCloseTo(375, -1)
  })

  it('flags plots that fail constraints instead of dropping them', () => {
    const { plots } = subdivide(boundary, { ...opts, minArea: 400 })
    expect(plots.every((p) => p.issue)).toBe(true)
    expect(plots[0].issue).toMatch(/Area below/)
  })

  it('numbers plots uniquely per block', () => {
    const { plots } = subdivide(boundary, opts)
    expect(new Set(plots.map((p) => p.number)).size).toBe(plots.length)
  })

  it('carves existing roads out of plots and flags remnants', () => {
    const { plots } = subdivide(boundary, opts)
    const road = roadSurface(feat(lineAt(C, 400), 'road') as any, 20)!
    const before = plots.filter((p) => turf.booleanIntersects(p.geometry, road)).length
    expect(before).toBeGreaterThan(0)
    const out = clearRoads(plots, [road], opts.minArea)
    for (const p of out) {
      const x = turf.intersect(turf.featureCollection([turf.polygon(p.geometry.coordinates), road as any]))
      expect(x ? turf.area(x) : 0).toBeLessThan(1)
    }
    expect(out.some((p) => p.issue?.includes('existing road'))).toBe(true)
  })

  it('respects street angle', () => {
    const { plots } = subdivide(footprint(C, 200, 120, 30), { ...opts, angle: 30 })
    expect(Math.max(...plots.map((p) => p.area))).toBeCloseTo(375, 0)
    expect(plots.filter((p) => !p.issue).length).toBeGreaterThan(10)
  })
})

describe('stats', () => {
  it('aggregates measured quantities and estimates', () => {
    const p = newProject()
    const L = (k: string) => p.layers.find((l) => l.kind === k)!.id
    const fs = [
      feat(footprint(C, 100, 100), 'boundary', {}, L('boundary')),
      feat(footprint(C, 15, 25), 'plot', { zoning: 'residential' }, L('parcels')),
      feat(lineAt(C, 100), 'road', { width: 10 }, L('roads')),
      feat(footprint(C, 40, 25), 'apartment', { floors: 5 }, L('buildings')),
      feat(footprint(C, 30, 30), 'park', {}, L('green')),
    ]
    const s = stats(fs, p.layers, p.settings)
    expect(s.boundaryArea).toBeCloseTo(10000, -2)
    expect(s.plotCount).toBe(1)
    expect(s.roadLength).toBeCloseTo(100, 0)
    expect(s.roadArea).toBeCloseTo(1000, -1)
    expect(s.greenArea).toBeCloseTo(900, -1)
    expect(s.gfa).toBeCloseTo(5000, -2)
    // 1 residential plot + floor(5000*0.8/100)=40 units
    expect(s.dwellings).toBe(41)
    expect(s.population).toBe(205)
  })

  it("counts a zone's land once, not again for the plots inside it", () => {
    const p = newProject()
    const L = (k: string) => p.layers.find((l) => l.kind === k)!.id
    const zoned = stats([
      feat(footprint(C, 100, 100), 'zone', { zoning: 'residential' }, L('zoning')),
      feat(footprint(C, 15, 25), 'plot', { zoning: 'residential' }, L('parcels')),
      feat(footprint([67.01, 24.86], 20, 20), 'plot', { zoning: 'commercial' }, L('parcels')), // no commercial zone: plots count
    ], p.layers, p.settings)
    expect(zoned.landUse.residential).toBeCloseTo(10000, -2)
    expect(zoned.landUse.commercial).toBeCloseTo(400, -1)
  })
})

describe('unitsOf', () => {
  it('counts flats in multi-unit types only', () => {
    expect(unitsOf('apartment', 1000)).toBe(8)
    expect(unitsOf('townhouse', 360, 90)).toBe(3)
    expect(unitsOf('house', 1000)).toBe(0)
  })
})

describe('frameToMercator', () => {
  // web-mercator in 0..1 units, as MapLibre defines it (spherical)
  const merc = ([lng, lat]: number[]) => [(180 + lng) / 360, (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360]
  const mPerUnit = (lat: number) => 2 * Math.PI * 6371008.8 * Math.cos((lat * Math.PI) / 180)
  it('maps frame metres to web-mercator without drift', () => {
    const origin = [73.445, 32.929], F = frame(origin), m = frameToMercator(origin)
    for (const [e, n] of [[1900, 5300], [-3000, -4000], [15000, -18000]]) {
      const ll = F.toGeo([e, n]), want = merc(ll), got = [m.x0 + e * m.sx, m.y0 - n * m.sy]
      const errM = Math.hypot(got[0] - want[0], got[1] - want[1]) * mPerUnit(ll[1])
      expect(errM).toBeLessThan(Math.abs(n) > 10000 ? 25 : 2) // curvature residual grows with distance²
    }
  })
})

describe('roundGeometry', () => {
  it('rounds every coordinate to 9 decimals (what the map editor accepts)', () => {
    const g = { type: 'Polygon' as const, coordinates: [[[67.123456789123456, 24.987654321987654], [67.1, 24.9], [67.2, 24.95], [67.123456789123456, 24.987654321987654]]] }
    const r = roundGeometry(g)
    expect(r.coordinates[0][0]).toEqual([67.123456789, 24.987654322])
    expect(roundGeometry({ type: 'LineString', coordinates: [[1.0000000004, 2]] }).coordinates[0]).toEqual([1, 2])
    expect(roundGeometry({ type: 'Point', coordinates: [1.12345678951, 2] }).coordinates).toEqual([1.12345679, 2])
    expect(g.coordinates[0][0][0]).toBe(67.123456789123456) // input untouched
  })
})

describe('knobPoint', () => {
  it('puts the rotate knob centred above the shape on screen', () => {
    expect(knobPoint([[10, 50], [90, 50], [90, 120], [10, 120]])).toEqual([50, 2]) // 48 px above the top edge: beyond Terra Draw's 40 px grab distance
    expect(knobPoint([[0, 0], [100, 40]], 10)).toEqual([50, -10])
  })
})
