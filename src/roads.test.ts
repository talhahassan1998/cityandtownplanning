import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { LineString, Polygon } from 'geojson'
import { footprint, frame, gridLines, lineAt, mergePlots, snapToGrid, splitByLine, splitPolygon, stats, subdivide } from './geo'
import { culDeSacGeom, curveRoad, defaultCurve, junctionPoints, measureFrontage, plotsAlongRoad, roundaboutGeom } from './roads'
import { newProject, type PlanFeature } from './model'

const C: [number, number] = [67.0, 24.86]
const road = (geometry: LineString, width = 10): PlanFeature =>
  ({ type: 'Feature', id: 'r', geometry, properties: { id: 'r', layerId: 'L', type: 'road', name: 'Road', attrs: { width } } })
const plot = (geometry: Polygon, attrs: any = {}): PlanFeature =>
  ({ type: 'Feature', id: 'p', geometry, properties: { id: 'p', layerId: 'L', type: 'plot', name: 'Plot', attrs } })
// a smooth 90° arc of radius 120 m around C
const arc = (r = 120): LineString => ({ type: 'LineString', coordinates: Array.from({ length: 31 }, (_, i) => turf.destination(C, r, (i * 90) / 30, { units: 'meters' }).geometry.coordinates) })

describe('equal-area split', () => {
  it('splits an irregular plot into equal areas', () => {
    // trapezoid: 30 m frontage, narrowing to 10 m at the rear
    const f = (x: number, y: number) => turf.destination(turf.destination(C, x, 90, { units: 'meters' }), y, 0, { units: 'meters' }).geometry.coordinates
    const trap: Polygon = { type: 'Polygon', coordinates: [[f(0, 0), f(30, 0), f(20, 30), f(10, 30), f(0, 0)]] }
    const pieces = splitPolygon(trap, 3, 0, 'depth')
    const areas = pieces.map((p) => turf.area(p.geometry))
    for (const a of areas) expect(a).toBeCloseTo(turf.area(trap) / 3, -1)
    expect(Math.abs(areas[0] - areas[2])).toBeLessThan(2)
  })
})

describe('split by line', () => {
  const sq = footprint(C, 40, 40)
  it('cuts a plot in two along a drawn line, sharing the cut edge exactly', () => {
    const cut = lineAt(C, 10) // short line in the middle, extended through the plot
    const pieces = splitByLine(sq, cut)!
    expect(pieces).toHaveLength(2)
    for (const p of pieces) expect(turf.area(p)).toBeCloseTo(800, -1)
    const merged = mergePlots(pieces.map((g) => plot(g, { plotNo: 'X-1' })), {})
    expect(typeof merged).toBe('object') // exact shared edge => clean union
  })
  it('follows a bent line', () => {
    const f = (x: number, y: number) => turf.destination(turf.destination(C, x, 90, { units: 'meters' }), y, 0, { units: 'meters' }).geometry.coordinates
    const bent: LineString = { type: 'LineString', coordinates: [f(-30, -5), f(0, 5), f(30, -5)] }
    const pieces = splitByLine(sq, bent)!
    expect(pieces).toHaveLength(2)
    expect(pieces.reduce((t, p) => t + turf.area(p), 0)).toBeCloseTo(turf.area(sq), 0)
  })
  it('returns null when the line misses the plot', () => {
    const far = lineAt([C[0], C[1] + 0.01], 10)
    expect(splitByLine(sq, far)).toBeNull()
  })
})

describe('rotated grid', () => {
  it('snaps along a street-aligned grid', () => {
    const g = snapToGrid(turf.destination(C, 33, 90 + 30, { units: 'meters' }).geometry.coordinates, C, 10, 30)
    // 33 m along the 30°-cw x-axis snaps to 30 m along that axis
    expect(turf.distance(C, g, { units: 'meters' })).toBeCloseTo(30, 0)
    expect(turf.bearing(C, g)).toBeCloseTo(120, 0)
  })
  it('covers the view when rotated', () => {
    const b: [number, number, number, number] = [C[0] - 0.001, C[1] - 0.001, C[0] + 0.001, C[1] + 0.001]
    expect(gridLines(b, C, 20, 45).length).toBeGreaterThan(gridLines(b, C, 20, 0).length)
  })
})

describe('junctions', () => {
  it('builds a roundabout ring with an island hole', () => {
    const g = roundaboutGeom(C, 20, 9)
    expect(g.coordinates).toHaveLength(2)
    expect(turf.area(g)).toBeCloseTo(Math.PI * (400 - 81), -1)
  })
  it('builds a cul-de-sac at the chosen road end', () => {
    const l = lineAt(C, 100)
    const g = culDeSacGeom(l, 'end', 12)
    expect(turf.booleanPointInPolygon(l.coordinates[1], g)).toBe(true)
    expect(turf.booleanPointInPolygon(l.coordinates[0], g)).toBe(false)
  })
  it('finds crossings and T-junctions once each', () => {
    const ew = turf.lineString(lineAt(C, 200).coordinates)
    const ns = turf.lineString([turf.destination(C, 100, 0, { units: 'meters' }).geometry.coordinates, turf.destination(C, 100, 180, { units: 'meters' }).geometry.coordinates])
    const stem = turf.lineString([turf.destination(C, 60, 90, { units: 'meters' }).geometry.coordinates, turf.destination(turf.destination(C, 60, 90, { units: 'meters' }), 80, 0, { units: 'meters' }).geometry.coordinates])
    const pts = junctionPoints(ew, [ns, stem, ns])
    expect(pts).toHaveLength(2)
  })
})

describe('analytics', () => {
  it('counts roundabouts and turning heads as road area', () => {
    const p = newProject()
    const roadsLayer = p.layers.find((l) => l.kind === 'roads')!.id
    const rb: PlanFeature = { type: 'Feature', id: 'rb', geometry: roundaboutGeom(C, 20, 9), properties: { id: 'rb', layerId: roadsLayer, type: 'roundabout', name: 'R', attrs: {} } }
    const s = stats([rb], p.layers, p.settings)
    expect(s.roadArea).toBeCloseTo(Math.PI * (400 - 81), -1)
    expect(s.roadLength).toBe(0)
  })
})

describe('plots along a road', () => {
  it('lays straight-road plots of the requested size on both sides', () => {
    const ps = plotsAlongRoad(lineAt(C, 200), { plotWidth: 15, plotDepth: 30, roadWidth: 12, sides: 'both' })
    expect(ps).toHaveLength(26) // floor(200/15)=13 per side
    for (const p of ps) { expect(turf.area(p.geometry)).toBeCloseTo(450, -1); expect(p.tooTight).toBe(false) }
    expect(ps.filter((p) => p.side === 'L').length).toBe(13)
  })
  it('follows a curve with neighbours sharing edges exactly', () => {
    const ps = plotsAlongRoad(arc(), { plotWidth: 15, plotDepth: 30, roadWidth: 12, sides: 'both' })
    expect(ps.length).toBeGreaterThan(20)
    const left = ps.filter((p) => p.side === 'L')
    const merged = mergePlots(left.slice(0, 3).map((p) => plot(p.geometry, { plotNo: `S1-${p.index}` })), {})
    expect(typeof merged).toBe('object')
    // plots stay clear of the road surface
    const surface = turf.buffer(turf.lineString(arc().coordinates), 6, { units: 'meters' })!
    for (const p of ps) {
      const x = turf.intersect(turf.featureCollection([turf.polygon(p.geometry.coordinates), surface as any]))
      expect(x ? turf.area(x) : 0).toBeLessThan(2)
    }
  })
  it('flags plots on the inside of curves tighter than the plot depth', () => {
    const ps = plotsAlongRoad(arc(25), { plotWidth: 8, plotDepth: 30, roadWidth: 8, sides: 'both' })
    expect(ps.some((p) => p.tooTight)).toBe(true)
    expect(ps.filter((p) => p.side === 'R').every((p) => !p.tooTight) || ps.filter((p) => p.side === 'L').every((p) => !p.tooTight)).toBe(true)
  })
  it('returns nothing for a road shorter than one plot', () => {
    expect(plotsAlongRoad(lineAt(C, 10), { plotWidth: 15, plotDepth: 30, roadWidth: 12, sides: 'both' })).toEqual([])
  })
})

describe('measured frontage', () => {
  it('matches the generated frontage of subdivision plots', () => {
    const o = { plotWidth: 15, plotDepth: 25, roadWidth: 10, plotsPerBlock: 6, angle: 0, minArea: 300, minFrontage: 12 }
    const { plots, roads } = subdivide(footprint(C, 200, 120), o)
    const rs = roads.map((g) => road(g, 10))
    const mid = plots.filter((p) => !p.issue && p.number.endsWith('-3'))[0] // mid-block, single frontage
    expect(measureFrontage(mid.geometry, rs)).toBeCloseTo(15, 0)
  })
  it('counts one side, both sides of a corner plot, and zero for an inland plot', () => {
    const r1 = road(lineAt(C, 200), 10) // east-west, edge 5 m north of C
    const sq = turf.transformTranslate(turf.feature(footprint(C, 20, 20)), 15, 0, { units: 'meters' }).geometry as Polygon // south edge on the road edge
    expect(measureFrontage(sq, [r1])).toBeCloseTo(20, 0)
    const east = turf.destination(C, 15, 90, { units: 'meters' }).geometry.coordinates // north-south road 15 m east, edge at 10 m
    const r2 = road({ type: 'LineString', coordinates: [turf.destination(east, 100, 180, { units: 'meters' }).geometry.coordinates, turf.destination(east, 100, 0, { units: 'meters' }).geometry.coordinates] }, 10)
    expect(measureFrontage(sq, [r1, r2])).toBeCloseTo(40, 0)
    const inland = turf.transformTranslate(turf.feature(footprint(C, 20, 20)), 60, 0, { units: 'meters' }).geometry as Polygon
    expect(measureFrontage(inland, [r1])).toBe(0)
  })
})

describe('curveRoad', () => {
  const F = frame(C), L = (p: number[]) => F.toLocal(p) as [number, number], G = (p: [number, number]) => F.toGeo(p)
  const curve = (pts: [number, number][], r: number) => curveRoad(pts.map(G), r, L, G).map(L)
  const near = (a: number[], b: number[], tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol

  it('rounds a right-angle bend into an arc of the given radius', () => {
    const c = curve([[0, 0], [100, 0], [100, 100]], 20)
    expect(near(c[0], [0, 0], 1e-3)).toBe(true)
    expect(near(c[c.length - 1], [100, 100], 1e-3)).toBe(true)
    expect(c.some((p) => near(p, [80, 0], 0.05))).toBe(true)
    expect(c.some((p) => near(p, [100, 20], 0.05))).toBe(true)
    for (const p of c) if (p[0] > 80.01 && p[1] < 19.99) expect(Math.hypot(p[0] - 80, p[1] - 20)).toBeCloseTo(20, 1)
    for (let i = 1; i < c.length; i++) if (c[i - 1][0] > 79.9 && c[i][1] < 20.1) expect(Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1])).toBeLessThanOrEqual(2.05)
  })

  it('shrinks the radius on short legs', () => {
    const c = curve([[0, 0], [10, 0], [10, 10]], 50)
    expect(c.some((p) => near(p, [5, 0], 0.05))).toBe(true)
    expect(c.some((p) => near(p, [10, 5], 0.05))).toBe(true)
  })

  it('leaves straight lines and radius 0 alone', () => {
    const s: [number, number][] = [[0, 0], [50, 0], [100, 0]]
    expect(curve(s, 20).length).toBe(3)
    const bent: [number, number][] = [[0, 0], [100, 0], [100, 100]]
    const z = curve(bent, 0)
    expect(z.length).toBe(3)
    z.forEach((p, i) => expect(near(p, bent[i], 1e-3)).toBe(true))
  })

  it("keeps a loop's start sharp and handles two points", () => {
    const loop = curve([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], 15)
    expect(near(loop[0], [0, 0], 1e-3) && near(loop[loop.length - 1], [0, 0], 1e-3)).toBe(true)
    for (const p of loop) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    expect(curve([[0, 0], [50, 0]], 20).length).toBe(2)
  })

  it('defaultCurve', () => {
    expect(defaultCurve('local')).toBe(15); expect(defaultCurve('arterial')).toBe(60); expect(defaultCurve('whatever')).toBe(15)
  })
})
