import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import { footprint, gridLines, mergePlots, plotAxis, plotIssue, snapScreen, snapToGrid, splitPlot, splitPolygon, subdivide } from './geo'
import type { PlanFeature } from './model'
import type { Polygon } from 'geojson'

const C: [number, number] = [67.0, 24.86]
const plot = (geometry: any, attrs: any = {}): PlanFeature =>
  ({ type: 'Feature', id: 'p', geometry, properties: { id: 'p', layerId: 'L', type: 'plot', name: 'Plot', attrs } })
const rules = { minPlotArea: 150, minFrontage: 6 }

describe('plotIssue', () => {
  it('checks access, area and frontage in that order', () => {
    expect(plotIssue(400, 0, rules)).toBe('No street access')
    expect(plotIssue(100, 10, rules)).toMatch(/Area below/)
    expect(plotIssue(400, 5, rules)).toMatch(/Frontage below/)
    expect(plotIssue(400, 10, rules)).toBeUndefined()
    expect(plotIssue(400, undefined, rules)).toBeUndefined() // unknown frontage isn't an access failure
  })
})

describe('split', () => {
  // 20 m frontage (east-west) × 30 m depth, street to the south ('min' face)
  const p = plot(footprint(C, 20, 30), { plotNo: 'B1-4', block: 'B1', frontage: 20, depth: 30, angle: 0, face: 'min', zoning: 'residential' })

  it('splits across the frontage into equal plots that all keep street access', () => {
    const out = splitPlot(p, 2, 'frontage', rules)
    expect(out).toHaveLength(2)
    for (const q of out) {
      expect(turf.area(q.geometry)).toBeCloseTo(300, -1)
      expect(q.properties.attrs.frontage).toBeCloseTo(10, 1)
      expect(q.properties.attrs.depth).toBe(30)
      expect(q.properties.attrs.issue).toBeUndefined()
    }
    expect(out.map((q) => q.properties.attrs.plotNo)).toEqual(['B1-4A', 'B1-4B'])
    expect(new Set(out.map((q) => q.id)).size).toBe(2)
  })

  it('splits across the depth: only the street-side piece keeps frontage, the rest are flagged', () => {
    const out = splitPlot(p, 3, 'depth', rules)
    expect(out.map((q) => q.properties.attrs.frontage)).toEqual([20, 0, 0])
    expect(out[0].properties.attrs.issue).toBeUndefined()
    expect(out[1].properties.attrs.issue).toBe('No street access')
    expect(out[0].properties.attrs.depth).toBeCloseTo(10, 1)
    // the street-side piece is the southern one
    expect(turf.centroid(out[0].geometry).geometry.coordinates[1]).toBeLessThan(turf.centroid(out[1].geometry).geometry.coordinates[1])
  })

  it('orders depth pieces street-first for north-facing plots', () => {
    const north = splitPlot({ ...p, properties: { ...p.properties, attrs: { ...p.properties.attrs, face: 'max' } } }, 2, 'depth', rules)
    expect(turf.centroid(north[0].geometry).geometry.coordinates[1]).toBeGreaterThan(turf.centroid(north[1].geometry).geometry.coordinates[1])
  })

  it('re-validates pieces against the rules', () => {
    const out = splitPlot(p, 4, 'frontage', rules) // 5 m frontage, 150 m²
    expect(out.every((q) => q.properties.attrs.issue === 'Frontage below 6 m')).toBe(true)
  })

  it('pieces tile the original exactly', () => {
    const rotated = plot(footprint(C, 18, 32, 25), { angle: 25 })
    const pieces = splitPolygon(rotated.geometry as any, 3, 25, 'frontage')
    const sum = pieces.reduce((t, q) => t + turf.area(q.geometry), 0)
    expect(sum).toBeCloseTo(turf.area(rotated.geometry), 0)
  })

  it('infers the street side of hand-drawn plots from the longest edge', () => {
    // 12 m wide east-west, 40 m deep north-south → frontage axis runs east-west (0°)
    const a = plotAxis(footprint(C, 12, 40) as any, {})
    expect(Math.abs(((a % 180) + 180) % 180)).toBeCloseTo(0, 0)
  })
})

describe('merge', () => {
  it('merges split pieces back into the original', () => {
    const p = plot(footprint(C, 20, 30), { plotNo: 'B1-4', frontage: 20, depth: 30, angle: 0, face: 'min' })
    const merged = mergePlots(splitPlot(p, 2, 'frontage', rules), rules) as PlanFeature
    expect(typeof merged).toBe('object')
    expect(turf.area(merged.geometry)).toBeCloseTo(600, -1)
    expect(merged.properties.attrs.frontage).toBeCloseTo(20, 1)
    expect(merged.properties.attrs.plotNo).toBe('B1-4A+4B')
    expect(merged.properties.attrs.issue).toBeUndefined()
    expect(merged.geometry.coordinates[0]).toHaveLength(5) // split vertices removed
  })

  it('merges a rear plot into the front plot by adding depth', () => {
    const p = plot(footprint(C, 20, 30), { plotNo: 'B1-4', frontage: 20, depth: 30, angle: 0, face: 'min' })
    const merged = mergePlots(splitPlot(p, 2, 'depth', rules), rules) as PlanFeature
    expect(merged.properties.attrs.frontage).toBe(20)
    expect(merged.properties.attrs.depth).toBeCloseTo(30, 1)
  })

  it('merges adjacent plots from a subdivision and renumbers them', () => {
    const { plots } = subdivide(footprint(C, 200, 120), { plotWidth: 15, plotDepth: 25, roadWidth: 10, plotsPerBlock: 6, angle: 0, minArea: 300, minFrontage: 12 })
    const [a, b] = plots.filter((q) => !q.issue && q.block === plots.find((x) => !x.issue)!.block)
    const toF = (q: typeof a): PlanFeature => plot(q.geometry, { plotNo: q.number, frontage: q.frontage, depth: q.depth, angle: q.angle, face: q.face })
    const m = mergePlots([toF(b), toF(a)], rules) as PlanFeature
    expect(typeof m).toBe('object')
    expect(m.properties.attrs.plotNo).toBe(`${a.number}+${b.number.split('-')[1]}`)
    expect(turf.area(m.geometry)).toBeCloseTo(750, -1)
  })

  it('absorbs an unnumbered hand-drawn plot into a numbered one', () => {
    const a = plot(footprint(C, 20, 30), { plotNo: 'B2-6', frontage: 20, depth: 30 })
    const ar = (a.geometry as Polygon).coordinates[0]
    const east = turf.transformTranslate(turf.feature(footprint(C, 20, 30)), 20, 90, { units: 'meters' }).geometry
    // share the exact edge, as vertex snapping guarantees
    east.coordinates[0][0] = ar[1]; east.coordinates[0][3] = ar[2]; east.coordinates[0][4] = east.coordinates[0][0]
    const m = mergePlots([plot(east, {}), a], rules) as PlanFeature
    expect(typeof m).toBe('object')
    expect(m.properties.attrs.plotNo).toBe('B2-6')
    expect(m.properties.attrs.frontage).toBeUndefined() // unknown for the hand-drawn part
  })

  it('refuses plots that do not touch', () => {
    const far = (dx: number) => plot(footprint([C[0] + dx, C[1]], 10, 10), { plotNo: `X-${dx}` })
    expect(mergePlots([far(0), far(0.01)], rules)).toMatch(/share an edge/)
    expect(mergePlots([far(0)], rules)).toMatch(/at least two/)
  })
})

describe('snapping', () => {
  const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]
  it('prefers a vertex within tolerance', () => {
    expect(snapScreen([4, 3], [square], 10, { vertices: true, edges: true })).toMatchObject({ pt: [0, 0], kind: 'vertex', path: 0, index: 0 })
  })
  it('falls back to the nearest point on an edge', () => {
    expect(snapScreen([50, 6], [square], 10, { vertices: true, edges: true })).toMatchObject({ pt: [50, 0], kind: 'edge', path: 0, index: 1, t: 0.5 })
  })
  it('respects tolerance and toggles', () => {
    expect(snapScreen([50, 30], [square], 10, { vertices: true, edges: true })).toBeUndefined()
    expect(snapScreen([4, 3], [square], 10, { vertices: false, edges: false })).toBeUndefined()
  })
  it('snaps to a metric grid', () => {
    const q = snapToGrid([C[0] + 0.00012, C[1] + 0.00004], C, 10) // ≈ 12 m east, 4.4 m north
    expect(turf.distance(C, [q[0], C[1]], { units: 'meters' })).toBeCloseTo(10, 0)
    expect(turf.distance(C, [C[0], q[1]], { units: 'meters' })).toBeCloseTo(0, 0)
  })
  it('generates grid lines but refuses dense grids', () => {
    expect(gridLines([C[0] - 0.001, C[1] - 0.001, C[0] + 0.001, C[1] + 0.001], C, 20).length).toBeGreaterThan(10)
    expect(gridLines([C[0] - 1, C[1] - 1, C[0] + 1, C[1] + 1], C, 1)).toEqual([])
  })
})
