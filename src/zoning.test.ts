import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import { footprint } from './geo'
import { GENERIC_RULESET, newProject, type PlanFeature, type Ruleset } from './model'
import { complianceOf, evaluate, parseRuleset } from './zoning'

const C: [number, number] = [67.0, 24.86]
const settings = newProject().settings
let n = 0
const feat = (type: string, geometry: any, attrs: any = {}): PlanFeature => {
  const id = `${type}-${++n}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: 'L', type, name: type, attrs } }
}
const plotAt = (w = 20, d = 30, zoning = 'residential') => feat('plot', footprint(C, w, d), { plotNo: 'B1-1', zoning })
const codes = (r: ReturnType<typeof evaluate>, id: string) => (r.byId.get(id) ?? []).map((v) => v.code).sort()

describe('building controls', () => {
  it('passes a compliant house on a residential plot', () => {
    const plot = plotAt()
    const house = feat('house', footprint(C, 10, 12), { floors: 2, height: 6.4 })
    const r = evaluate([plot, house], GENERIC_RULESET, settings)
    expect(r.violations).toEqual([])
    expect(r.buildings.get(house.id)).toMatchObject({ zone: 'residential', plotId: plot.id })
    expect(r.buildings.get(house.id)!.minSetback).toBeCloseTo(5, 0) // (20 − 10) / 2
  })

  it('flags height, floors and use', () => {
    const plot = plotAt(60, 60)
    const tower = feat('office', footprint(C, 20, 20), { floors: 10, height: 32 })
    const r = evaluate([plot, tower], GENERIC_RULESET, settings)
    expect(codes(r, tower.id)).toEqual(['floors', 'height', 'use'])
    expect(r.byId.get(tower.id)!.find((v) => v.code === 'use')!.message).toMatch(/Commercial use is not permitted in Residential/)
  })

  it('flags setback and buildings that leave their plot', () => {
    const plot = plotAt(20, 30)
    const tight = feat('house', footprint(C, 18, 12), { floors: 2, height: 6.4 }) // 1 m each side < 3 m
    const r1 = evaluate([plot, tight], GENERIC_RULESET, settings)
    expect(codes(r1, tight.id)).toEqual(['setback'])
    expect(r1.byId.get(tight.id)![0].value).toBeCloseTo(1, 1)
    const over = feat('house', turf.transformTranslate(turf.feature(footprint(C, 10, 12)), 8, 90, { units: 'meters' }).geometry, { floors: 2, height: 6.4 })
    expect(codes(evaluate([plot, over], GENERIC_RULESET, settings), over.id)).toEqual(['outside'])
  })

  it('falls back to a zoning polygon when the building is not on a plot', () => {
    const zone = feat('zone', footprint(C, 200, 200), { zoning: 'green' })
    const house = feat('house', footprint(C, 10, 12), { floors: 2, height: 6.4 })
    const r = evaluate([zone, house], GENERIC_RULESET, settings)
    expect(r.buildings.get(house.id)!.zone).toBe('green')
    expect(codes(r, house.id)).toEqual(['use'])
  })

  it('does not check buildings outside any zone', () => {
    const house = feat('tower', footprint(C, 25, 25), { floors: 40, height: 128 })
    expect(evaluate([house], GENERIC_RULESET, settings).violations).toEqual([])
  })
})

describe('plot controls', () => {
  it('computes FAR, coverage and density and flags excess', () => {
    const plot = plotAt(20, 30) // 600 m²
    const apt = feat('apartment', footprint(C, 14, 24), { floors: 4, height: 12.8 }) // 336 m², GFA 1344
    const r = evaluate([plot, apt], GENERIC_RULESET, { ...settings, dwellingsPerPlot: 1 })
    const m = r.plots.get(plot.id)!
    expect(m.coverage).toBeCloseTo(56, 0)
    expect(m.far).toBeCloseTo(2.24, 1)
    expect(m.dwellings).toBe(1 + Math.floor((1344 * 0.8) / 100)) // 11
    expect(m.density).toBeCloseTo(11 / 0.06, -1)
    expect(codes(r, plot.id)).toEqual(['density', 'far'])
    expect(codes(r, apt.id)).toEqual([]) // exactly the 3 m setback each side: compliant
  })

  it('flags undersized plots for their zone', () => {
    const plot = plotAt(15, 25, 'industrial') // 375 < 500
    expect(codes(evaluate([plot], GENERIC_RULESET, settings), plot.id)).toEqual(['minPlot'])
  })

  it('respects a custom ruleset and uncontrolled limits', () => {
    const lax: Ruleset = { name: 'Lax', rules: { residential: { uses: ['Residential', 'Commercial'] } } }
    const plot = plotAt(60, 60)
    const tower = feat('office', footprint(C, 20, 20), { floors: 30, height: 96 })
    expect(evaluate([plot, tower], lax, settings).violations).toEqual([])
  })
})

describe('memo + rulesets', () => {
  it('reuses results for unchanged inputs', () => {
    const fs = { a: plotAt() }
    expect(complianceOf(fs, undefined, settings)).toBe(complianceOf(fs, undefined, settings))
    expect(complianceOf({ ...fs }, undefined, settings)).not.toBe(complianceOf(fs, undefined, settings))
  })
  it('round-trips the generic ruleset through JSON and rejects bad values', () => {
    expect(parseRuleset(JSON.stringify(GENERIC_RULESET))).toEqual(GENERIC_RULESET)
    expect(() => parseRuleset('{"name":"x","rules":{"residential":{"maxFAR":-1,"uses":[]}}}')).toThrow(/maxFAR/)
    expect(() => parseRuleset('{"rules":{}}')).toThrow()
  })
  it('generic template covers every zoning category', () => {
    for (const z of ['residential', 'commercial', 'industrial', 'institutional', 'green', 'agricultural', 'mixed', 'transport', 'protected']) expect(GENERIC_RULESET.rules[z]).toBeDefined()
  })
})


describe('report', () => {
  it('builds a self-contained report with escaped text and the findings', async () => {
    const { planningReport, complianceCSV } = await import('./report')
    const { stats } = await import('./geo')
    const p = newProject('<Town & "Co">')
    const plot = plotAt(60, 60)
    const tower = feat('office', footprint(C, 20, 20), { floors: 10, height: 32 })
    p.features = { [plot.id]: plot, [tower.id]: tower }
    p.settings.landUseTargets = { residential: 50 }
    const comp = evaluate([plot, tower], GENERIC_RULESET, p.settings)
    const html = planningReport(p, stats([plot, tower], p.layers, p.settings), comp)
    expect(html).toContain('&lt;Town &amp; &quot;Co&quot;&gt;')
    expect(html).not.toContain('<Town')
    for (const h of ['Measured quantities', 'Land use', 'Estimates (assumption-based)', 'Development controls', 'Compliance']) expect(html).toContain(h)
    expect(html).toContain('3</b> violation(s)')
    expect(html).toContain('not a legal approval')
    const csv = complianceCSV(comp.violations, p.features).split('\n')
    expect(csv).toHaveLength(4)
    expect(csv[0]).toBe('"object_id","object","type","check","value","limit","finding"')
  })
})
