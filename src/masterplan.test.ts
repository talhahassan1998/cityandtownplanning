import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { LineString, Polygon } from 'geojson'
import { footprint, roadSurface, stats } from './geo'
import { componentDef, GENERIC_RULESET, newProject, type PlanFeature } from './model'
import { evaluate } from './zoning'
import { DEFAULT_BRIEF, generatePlan, plotSizeFor, portionOf, squareSite, VARIANTS } from './masterplan'

const C: [number, number] = [67.0, 24.86]
const site = footprint(C, 900, 500, 20) // 45 ha, long axis 20° clockwise of east
const plan = generatePlan(site, DEFAULT_BRIEF, VARIANTS[0])
const of = (type: string) => plan.drafts.filter((d) => d.type === type)

describe('plot size from density', () => {
  it('gives smaller plots for higher densities and stays within sensible bounds', () => {
    const [w20, d20] = plotSizeFor(20), [w60, d60] = plotSizeFor(60)
    expect(w20 * d20).toBeGreaterThan(w60 * d60)
    expect(w20 * d20).toBeCloseTo(350, 0) // 10 000 m² × 70% net ÷ 20 dwellings
    expect(plotSizeFor(1000)[0]).toBeGreaterThanOrEqual(8)
  })
})

describe('generated master plan', () => {
  it('runs an arterial spine along the long axis', () => {
    const [art] = of('road-arterial')
    expect(art).toBeDefined()
    const len = turf.length(turf.feature(art.geometry), { units: 'meters' })
    expect(len).toBeGreaterThan(850) // spans the 900 m long side
    const b = turf.bearing((art.geometry as any).coordinates[0], (art.geometry as any).coordinates[1])
    expect(Math.abs(((b - 90 - 20) % 180 + 180) % 180)).toBeLessThan(1) // 20° cw of east (= bearing 110°)
  })

  it('allocates land-use bands in proportion to the mix', () => {
    const total = turf.area(site)
    for (const [zone, pct] of Object.entries(DEFAULT_BRIEF.mix)) {
      const area = of('zone').filter((z) => z.attrs.zoning === zone).reduce((s, z) => s + turf.area(z.geometry as Polygon), 0)
      expect(area / total * 100).toBeCloseTo(pct, 0)
    }
    expect(of('park')).toHaveLength(1)
  })

  it('subdivides bands into numbered plots clear of the arterial', () => {
    const plots = of('plot')
    expect(plots.length).toBeGreaterThan(100)
    expect(new Set(plots.map((p) => p.attrs.plotNo)).size).toBe(plots.length)
    const surf = roadSurface(turf.feature(of('road-arterial')[0].geometry as any), DEFAULT_BRIEF.arterialWidth)!
    for (const p of plots.slice(0, 200)) {
      const x = turf.intersect(turf.featureCollection([turf.polygon((p.geometry as Polygon).coordinates), surf as any]))
      expect(x ? turf.area(x) : 0).toBeLessThan(1)
    }
    expect(of('road-local').length).toBeGreaterThan(5)
  })

  it('places facilities in proportion to the target population and reports checks', () => {
    // 5 000 people: 1 school, 1 clinic, 1 police, 1 fire, 1 community, 1 religious
    expect(plan.metrics.facilities).toEqual({ school: 1, clinic: 1, police: 1, fire: 1, community: 1, religious: 1 })
    expect(of('school')).toHaveLength(1)
    // facility footprints respect a 45% ground-coverage cap on their reserved plot
    const reservedPlots = of('plot').filter((p) => p.attrs.status === 'reserved')
    for (const f of plan.drafts.filter((d) => d.attrs.zoning === 'institutional' && Number(d.attrs.floors) > 0)) {
      const host = reservedPlots.find((p) => turf.booleanPointInPolygon(turf.centroid(f.geometry as any), p.geometry as any))!
      expect(turf.area(f.geometry as any) / turf.area(host.geometry as any)).toBeLessThanOrEqual(0.46)
    }
    const reserved = of('plot').filter((p) => p.attrs.status === 'reserved')
    expect(reserved).toHaveLength(6)
    expect(plan.metrics.population).toBe(plan.metrics.dwellings * 5)
    expect(plan.checks.map((c) => c.label)).toEqual(['Population capacity', 'Green space', 'Facilities placed', 'Road share'])
    expect(plan.checks.find((c) => c.label === 'Facilities placed')!.ok).toBe(true)
    expect(plan.checks.find((c) => c.label === 'Green space')!.ok).toBe(true)
  })

  it('flags a population shortfall and a blown budget', () => {
    const p = generatePlan(squareSite(C, 4), { ...DEFAULT_BRIEF, targetPopulation: 50000, budget: 1000 }, VARIANTS[0])
    expect(p.checks.find((c) => c.label === 'Population capacity')!.ok).toBe(false)
    expect(p.checks.find((c) => c.label.startsWith('Budget'))!.ok).toBe(false)
  })

  it('produces genuinely different alternatives', () => {
    const industrialCentroid = (v: number) => turf.centroid(generatePlan(site, DEFAULT_BRIEF, VARIANTS[v]).drafts.find((d) => d.type === 'zone' && d.attrs.zoning === 'industrial')!.geometry as any).geometry.coordinates
    expect(turf.distance(industrialCentroid(0), industrialCentroid(1), { units: 'meters' })).toBeGreaterThan(300) // other end of the spine
    const rotated = generatePlan(site, DEFAULT_BRIEF, VARIANTS[2])
    const len = turf.length(turf.feature(rotated.drafts.find((d) => d.type === 'road-arterial')!.geometry), { units: 'meters' })
    expect(len).toBeLessThan(600) // spine now crosses the short side
  }, 20000) // builds three full plans; can exceed the 5 s default when the suite runs in parallel

  it('makes a square site of the requested area', () => {
    expect(Math.abs(turf.area(squareSite(C, 25)) / 250000 - 1)).toBeLessThan(0.01) // local-frame approximation
  })

  it('fills residential, commercial and industrial plots with buildings', () => {
    expect(of('house').length).toBeGreaterThan(50) // 35 dw/ha → detached houses
    expect(plan.drafts.some((d) => ['shop', 'mixed-use', 'office'].includes(d.type))).toBe(true)
    expect(plan.drafts.some((d) => ['factory', 'warehouse'].includes(d.type))).toBe(true)
  })

  it('generates buildings that pass every development control, with dwellings matching the stats', () => {
    const p = newProject()
    const features: PlanFeature[] = plan.drafts.map((d, i) => ({
      type: 'Feature', id: String(i), geometry: d.geometry,
      properties: { id: String(i), layerId: p.layers.find((l) => l.kind === componentDef(d.type).layer)!.id, type: d.type, name: d.name ?? d.type, attrs: d.attrs },
    }))
    const generated = new Set(features.filter((f) => ['house', 'shop', 'mixed-use', 'office', 'factory', 'warehouse'].includes(f.properties.type)).map((f) => f.id))
    const c = evaluate(features, GENERIC_RULESET, p.settings)
    expect(c.violations.filter((v) => generated.has(v.id))).toEqual([])
    // plot-level controls (FAR, coverage, density) on filled plots
    const hosts = new Set([...c.buildings.entries()].filter(([id]) => generated.has(id)).map(([, b]) => b.plotId))
    expect(c.violations.filter((v) => hosts.has(v.id))).toEqual([])
    // stats() counts every residential plot; the proposal skips invalid (issue) plots
    const valid = features.filter((f) => !(f.properties.type === 'plot' && f.properties.attrs.issue))
    expect(plan.metrics.dwellings).toBe(stats(valid, p.layers, p.settings).dwellings)
  })

  it('places facility buildings within the institutional setback (wizard default site)', () => {
    const p = newProject(), sq = generatePlan(squareSite(C, 40), { ...DEFAULT_BRIEF, fillBuildings: true }, VARIANTS[0])
    const features: PlanFeature[] = sq.drafts.map((d, i) => ({
      type: 'Feature', id: String(i), geometry: d.geometry,
      properties: { id: String(i), layerId: p.layers.find((l) => l.kind === componentDef(d.type).layer)!.id, type: d.type, name: d.name ?? d.type, attrs: d.attrs },
    }))
    const civic = new Set(features.filter((f) => ['school', 'clinic', 'police', 'fire-station', 'community', 'mosque'].includes(f.properties.type) || f.properties.attrs.zoning === 'institutional' && Number(f.properties.attrs.floors) > 0).map((f) => f.id))
    expect(civic.size).toBeGreaterThan(0)
    expect(evaluate(features, GENERIC_RULESET, p.settings).violations.filter((v) => civic.has(v.id))).toEqual([])
  })

  it('reproduces the empty-plot output when filling is off', () => {
    const off = generatePlan(site, { ...DEFAULT_BRIEF, fillBuildings: false }, VARIANTS[0])
    expect(off.drafts.some((d) => ['house', 'shop', 'mixed-use', 'office', 'factory', 'warehouse'].includes(d.type))).toBe(false)
    expect(off.metrics.dwellings).toBe(off.metrics.residentialPlots)
  })

  it('builds apartments on wide plots at high density', () => {
    const hi = generatePlan(site, { ...DEFAULT_BRIEF, density: 120 }, VARIANTS[0])
    expect(hi.drafts.some((d) => d.type === 'apartment')).toBe(true)
    const res = hi.drafts.filter((d) => d.type === 'plot' && d.attrs.zoning === 'residential' && !d.attrs.issue)
    expect(res.every((d) => Number(d.attrs.frontage) >= 40)).toBe(true)
  })
})

describe('portionOf', () => {
  it('cuts the requested hectares from one end of the boundary, inside it', () => {
    const a = portionOf(site, 15), b = portionOf(site, 15, true)
    expect(turf.area(a) / 10000).toBeCloseTo(15, 0)
    expect(turf.area(b) / 10000).toBeCloseTo(15, 0)
    expect(turf.booleanWithin(turf.buffer(turf.feature(a), -1, { units: 'meters' })!, turf.feature(site))).toBe(true)
    expect(turf.distance(turf.centroid(a), turf.centroid(b), { units: 'meters' })).toBeGreaterThan(500) // opposite ends of the 900 m axis
  })

  it('returns the whole boundary when asked for all of it or more', () => {
    expect(portionOf(site, turf.area(site) / 10000)).toBe(site)
    expect(portionOf(site, 100)).toBe(site)
  })
})

describe('planning around existing development', () => {
  // a north-south road 200 m past the east end of the spine (spine bearing 110°), and a house on a plot
  const east = turf.destination(C, 0.65, 110).geometry.coordinates
  const road: LineString = { type: 'LineString', coordinates: [turf.destination(east, 0.3, 20), turf.destination(east, 0.3, 200)].map((p) => p.geometry.coordinates) }
  const house = footprint(turf.centroid(of('plot')[40].geometry as Polygon).geometry.coordinates, 15, 15)
  const p = generatePlan(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: [{ geometry: road, width: 20 }], obstacles: [house], water: [] })

  it('links the spine to the nearest existing road and reports it', () => {
    const links = p.drafts.filter((d) => d.name === 'Link to existing road')
    expect(links).toHaveLength(1)
    const end = (links[0].geometry as LineString).coordinates[1]
    expect(turf.pointToLineDistance(end, road, { units: 'meters' })).toBeLessThan(0.5)
    expect(turf.length(turf.feature(links[0].geometry), { units: 'meters' })).toBeGreaterThan(150)
    expect(p.linkedTo).toEqual([0])
    expect(p.checks.find((c) => c.label === 'Joins existing roads')?.ok).toBe(true)
  })

  it('keeps plots off existing buildings', () => {
    const plots = p.drafts.filter((d) => d.type === 'plot')
    expect(plots.length).toBeGreaterThan(of('plot').length * 0.9)
    expect(plots.some((d) => turf.booleanIntersects(d.geometry as Polygon, house))).toBe(false)
  })

  it('reports no join when no road is within reach', () => {
    const far: LineString = { type: 'LineString', coordinates: [[67.2, 24.9], [67.2, 25.0]] }
    const q = generatePlan(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: [{ geometry: far, width: 10 }], obstacles: [], water: [] })
    expect(q.drafts.some((d) => d.name === 'Link to existing road')).toBe(false)
    expect(q.checks.find((c) => c.label === 'Joins existing roads')?.ok).toBe(false)
  })

  it('leaves a river undeveloped and bridges it with the spine and cross streets only', () => {
    // a 40 m river running across the spine (perpendicular to it), 150 m east of the centre
    const at = turf.destination(C, 0.15, 110).geometry.coordinates
    const river = roadSurface(turf.lineString([turf.destination(at, 0.6, 20), turf.destination(at, 0.6, 200)].map((x) => x.geometry.coordinates)), 40)!.geometry as Polygon
    const w = generatePlan(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: [], obstacles: [], water: [river] })
    const wet = (d: { geometry: unknown }) => turf.booleanIntersects(d.geometry as Polygon, river)
    // no plot, zone, park or building touches the water (zones/parks may only touch its bank)
    expect(w.drafts.filter((d) => d.geometry.type === 'Polygon' && wet(d) && turf.area(turf.intersect(turf.featureCollection([turf.feature(d.geometry as Polygon), turf.feature(river)])) ?? turf.featureCollection([])) > 1).map((d) => d.name)).toEqual([])
    const bridges = w.drafts.filter((d) => d.attrs.structure === 'bridge')
    expect(bridges.some((d) => d.name === 'Bridge (Arterial spine)')).toBe(true)
    for (const b of bridges) expect(turf.length(turf.feature(b.geometry), { units: 'meters' })).toBeLessThan(80) // spans the river, not more
    // every road piece over the water is a bridge; ordinary local streets stop at the bank
    const overWater = w.drafts.filter((d) => d.geometry.type === 'LineString' && turf.booleanWithin(turf.feature(d.geometry), turf.buffer(turf.feature(river), 0.5, { units: 'meters' })!))
    expect(overWater.every((d) => d.attrs.structure === 'bridge')).toBe(true)
    expect(bridges.every((d) => /Arterial|Cross/.test(String(d.name)))).toBe(true)
    expect(w.checks.find((c) => c.label === 'Water left undeveloped')).toMatchObject({ ok: true })
  })
})

describe('street network', () => {
  // small sites (narrow bands) were where streets ended as disconnected stubs
  const cases = [[900, 500, 20], [260, 105, 50], [170, 160, -35], [600, 300, 0]] as const
  it.each(cases)('connects every street end to another road or the site edge (%i × %i m, %i°)', { timeout: 60000 }, (w, d, rot) => {
    const s = footprint(C, w, d, rot)
    for (const v of VARIANTS) {
      const p = generatePlan(s, DEFAULT_BRIEF, v)
      const roads = p.drafts.filter((x) => x.type.startsWith('road')).map((x) => turf.feature(x.geometry as LineString))
      const edge = turf.polygonToLine(turf.feature(s)) as any
      for (const [i, r] of roads.entries()) {
        if (p.drafts.filter((x) => x.type.startsWith('road'))[i].type === 'road-arterial') continue
        for (const e of [r.geometry.coordinates[0], r.geometry.coordinates.at(-1)!]) {
          const toRoad = Math.min(...roads.filter((_, j) => j !== i).map((o) => turf.pointToLineDistance(e, o, { units: 'meters' })))
          const toEdge = turf.pointToLineDistance(e, edge, { units: 'meters' })
          expect(Math.min(toRoad, toEdge), `${v.order}${v.angleOffset} end ${e}`).toBeLessThan(1.5)
        }
      }
      const plots = p.drafts.filter((x) => x.type === 'plot')
      expect(plots.filter((x) => x.attrs.issue === 'No street access').length / plots.length).toBeLessThan(0.1)
    }
  })

  it('gives the edge column of plots access from the local street beside it (wizard default site)', { timeout: 60000 }, () => {
    const p = generatePlan(squareSite(C, 40), { ...DEFAULT_BRIEF, fillBuildings: true }, VARIANTS[0])
    expect(p.drafts.filter((x) => x.type === 'plot' && x.attrs.issue === 'No street access').length).toBe(0)
  })
})
