import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { Polygon } from 'geojson'
import { footprint, frame, unitsOf, type GeneratedPlot } from './geo'
import { fillPlot, housingType, residentialPlotSize } from './infill'
import { GENERIC_RULESET } from './model'
import { minSetback } from './zoning'

const C: [number, number] = [67.0, 24.86]
const R = GENERIC_RULESET.rules
const plotOf = (w: number, d: number, number = '1', geometry: Polygon = footprint(C, w, d, 0)): GeneratedPlot =>
  ({ geometry, block: 'A', number, area: turf.area(geometry), frontage: w, depth: d, angle: 0, face: 'min' })

function check(plot: GeneratedPlot, zone: string) {
  const b = fillPlot(plot, zone, R[zone], 'house', 0, { plan: 'A' })!
  expect(b).toBeDefined()
  const g = b.geometry as Polygon
  const ring = g.coordinates[0].slice(0, -1)
  expect(ring.every((p) => turf.booleanPointInPolygon(p, plot.geometry))).toBe(true)
  expect(minSetback(ring, plot.geometry)).toBeGreaterThanOrEqual((R[zone].setback ?? 0) - 0.01)
  const fp = turf.area(g), floors = Number(b.attrs.floors)
  expect(fp / plot.area * 100).toBeLessThanOrEqual(R[zone].maxCoverage! + 0.01)
  expect(floors).toBeLessThanOrEqual(R[zone].maxFloors!)
  expect(Number(b.attrs.height)).toBeLessThanOrEqual(R[zone].maxHeight!)
  expect(fp * floors / plot.area).toBeLessThanOrEqual(R[zone].maxFAR! + 0.01)
  return { b, fp, floors }
}

describe('housing type from density', () => {
  it('follows the density thresholds', () => {
    expect([10, 15, 40, 80, 81].map(housingType)).toEqual(['villa', 'house', 'townhouse', 'townhouse', 'apartment'])
  })
  it('sizes house plots near-square so a house fits inside the setbacks', () => {
    const [w, d] = residentialPlotSize('house', 35)
    expect(Math.min(w, d)).toBeGreaterThanOrEqual(14)
    expect(Math.abs(w * d - 7000 / 35)).toBeLessThan(3)
  })
  it('sizes apartment plots for a 16-dwelling block at the brief density', () => {
    const [w, d] = residentialPlotSize('apartment', 100)
    expect(w).toBe(46)
    expect(Math.abs(w * d - (16 * 7000) / 100)).toBeLessThan(3) // depth rounded to 0.1 m
    expect(residentialPlotSize('apartment', 300)[1]).toBe(22) // never shallower than block depth + setbacks
  })
})

describe('fillPlot', () => {
  it('fits a house inside the setback with legal coverage and floors', () => {
    const { b } = check(plotOf(15, 30), 'residential')
    expect(b.type).toBe('house')
  })
  it('keeps a villa at catalogue size on a large plot', () => {
    const b = fillPlot(plotOf(60, 60), 'residential', R.residential, 'villa', 0, {})!
    expect(b.type).toBe('villa')
    expect(Number(b.attrs.width)).toBeLessThanOrEqual(18)
    expect(Number(b.attrs.depth)).toBeLessThanOrEqual(20)
    expect(b.attrs.floors).toBe(2)
  })
  it('caps apartment floors by FAR and dwelling density', () => {
    const p = plotOf(46, 25)
    const b = fillPlot(p, 'residential', R.residential, 'apartment', 0, {})!
    expect(b.type).toBe('apartment')
    const gfa = turf.area(b.geometry as Polygon) * Number(b.attrs.floors)
    expect(Number(b.attrs.floors)).toBeLessThanOrEqual(4)
    expect((1 + unitsOf('apartment', gfa)) / (p.area / 1e4)).toBeLessThanOrEqual(120)
    expect(gfa).toBeLessThanOrEqual(1.5 * p.area + 0.5)
  })
  it('picks shop / mixed-use / office by commercial plot area', () => {
    expect(check(plotOf(20, 30), 'commercial').b.type).toBe('shop')
    expect(check(plotOf(30, 50), 'commercial').b.type).toBe('mixed-use')
    const { b } = check(plotOf(60, 60), 'commercial')
    expect(b.type).toBe('office')
  })
  it('alternates factory and warehouse on industrial plots', () => {
    expect(check(plotOf(50, 60, '1'), 'industrial').b.type).toBe('factory')
    expect(check(plotOf(50, 60, '2'), 'industrial').b.type).toBe('warehouse')
  })
  it('reads the plot index from real generated plot numbers', () => {
    expect(check(plotOf(50, 60, 'B1-3'), 'industrial').b.type).toBe('factory')
    expect(check(plotOf(50, 60, 'B1-4'), 'industrial').b.type).toBe('warehouse')
  })
  it('places nothing when even one floor breaks a strict density limit', () => {
    const strict = { ...R.residential, maxDensity: 20 }
    expect(fillPlot(plotOf(15, 30), 'residential', strict, 'house', 0, {})).toBeUndefined() // 1 dwelling on 450 m² = 22 dw/ha
  })
  it('leaves tiny, invalid, green and non-permitted plots empty', () => {
    expect(fillPlot(plotOf(8, 8), 'residential', R.residential, 'house', 0, {})).toBeUndefined()
    expect(fillPlot({ ...plotOf(15, 30), issue: 'x' }, 'residential', R.residential, 'house', 0, {})).toBeUndefined()
    expect(fillPlot(plotOf(60, 60), 'green', R.green, 'house', 0, {})).toBeUndefined()
    expect(fillPlot(plotOf(15, 30), 'residential', { ...R.residential, uses: ['Commercial'] }, 'house', 0, {})).toBeUndefined()
    expect(fillPlot(plotOf(15, 30), 'residential', undefined, 'house', 0, {})).toBeUndefined()
  })
  it('never breaks the setback on an irregular (clipped-corner) plot', () => {
    const f = frame(C)
    const ring = [[-15, -15], [15, -15], [15, 0], [0, 15], [-15, 15], [-15, -15]].map((p) => f.toGeo(p as [number, number]))
    const plot = plotOf(30, 30, '1', { type: 'Polygon', coordinates: [ring] })
    const b = fillPlot(plot, 'residential', R.residential, 'villa', 0, {})
    if (b) {
      const r = (b.geometry as Polygon).coordinates[0].slice(0, -1)
      expect(r.every((p) => turf.booleanPointInPolygon(p, plot.geometry))).toBe(true)
      expect(minSetback(r, plot.geometry)).toBeGreaterThanOrEqual(2.99)
    }
  })
})
