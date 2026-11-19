import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { LineString, Polygon, Position } from 'geojson'
import { footprint, frame, roadSurface } from './geo'
import { measureFrontage } from './roads'
import { GENERIC_RULESET, type PlanFeature } from './model'
import { DEFAULT_BRIEF, VARIANTS, type Existing } from './masterplan'
import { analyseRoads, generateOnRoads, zoneBlocks } from './existingplan'

const C: Position = [67.3, 25.25]
const f = frame(C)
/** Straight road through local point (x, y) metres at `deg` counter-clockwise from east, `len` m long. */
const road = (deg: number, len = 700, x = 0, y = 0): LineString => {
  const a = (deg * Math.PI) / 180, h = len / 2
  return { type: 'LineString', coordinates: [[x - h * Math.cos(a), y - h * Math.sin(a)], [x + h * Math.cos(a), y + h * Math.sin(a)]].map(f.toGeo) }
}
const site = footprint(C, 450, 450)
const ns = road(90), ew = road(0)
const ex: Existing = { roads: [{ geometry: ns, width: 16 }, { geometry: ew, width: 16 }], obstacles: [], water: [] }
const of = (p: ReturnType<typeof generateOnRoads>, t: string) => p.drafts.filter((d) => d.type === t)

describe('blocks between existing roads', () => {
  it('finds the four blocks between two crossing roads', () => {
    const a = analyseRoads(site, ex, 300)
    expect(a.blocks.length).toBe(4)
    expect(a.used).toEqual([0, 1])
    for (const b of a.blocks) expect(b.area).toBeGreaterThanOrEqual(300)
  })

  const p = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, ex)

  it('keeps plots off existing roads and gives each one frontage', { timeout: 60000 }, () => {
    const plots = of(p, 'plot')
    expect(plots.length).toBeGreaterThan(20)
    const surfaces = [ns, ew].map((g) => roadSurface(turf.feature(g), 16)!)
    for (const pl of plots) {
      const inner = turf.buffer(turf.feature(pl.geometry as Polygon), -0.5, { units: 'meters' })
      if (inner) for (const s of surfaces) expect(turf.booleanIntersects(inner, s), String(pl.name)).toBe(false)
      expect(Number(pl.attrs.frontage)).toBeGreaterThan(0)
    }
    expect(plots.filter((x) => x.attrs.issue === 'No street access').length / plots.length).toBeLessThan(0.1)
  })

  it('connects every new street end to a street or existing road', { timeout: 60000 }, () => {
    const streets = of(p, 'road-local').map((d) => turf.feature(d.geometry as LineString))
    expect(streets.length).toBeGreaterThan(0)
    const others = [...streets, ...[ns, ew].map((g) => turf.feature(g))]
    const edge = turf.polygonToLine(turf.feature(site)) as any
    for (const s of streets)
      for (const e of [s.geometry.coordinates[0], s.geometry.coordinates.at(-1)!]) {
        const toRoad = Math.min(...others.filter((o) => o !== s).map((o) => turf.pointToLineDistance(e, o, { units: 'meters' })))
        expect(Math.min(toRoad, turf.pointToLineDistance(e, edge, { units: 'meters' })), `end ${e}`).toBeLessThan(1.5)
      }
  })

  it('aligns plots to a diagonal road', { timeout: 60000 }, () => {
    // 30° counter-clockwise from east = -30° clockwise; folded mod 90 → 60
    const q = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: [{ geometry: road(30), width: 16 }], obstacles: [], water: [] })
    const angles = of(q, 'plot').map((d) => ((Number(d.attrs.angle) % 90) + 90) % 90).sort((a, b) => a - b)
    expect(angles.length).toBeGreaterThan(10)
    expect(Math.abs(angles[Math.floor(angles.length / 2)] - 60)).toBeLessThan(3)
  })

  it('corner road: a road clipping one corner still gives usable blocks', { timeout: 60000 }, () => {
    // 45° road cutting ~60 m off the north-east corner
    const a = analyseRoads(site, { roads: [{ geometry: road(-45, 400, 225 - 30, 225 - 30), width: 16 }], obstacles: [], water: [] }, 300)
    expect(a.blocks.length).toBeGreaterThanOrEqual(1)
    for (const b of a.blocks) expect(b.area).toBeGreaterThanOrEqual(300)
  })

  it('edge road: a road just outside the site gives the edge row frontage', { timeout: 60000 }, () => {
    const q = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: [{ geometry: road(0, 700, 0, 225 + 9), width: 16 }], obstacles: [], water: [] })
    const north = of(q, 'plot').filter((d) => f.toLocal(turf.centroid(d.geometry as Polygon).geometry.coordinates)[1] > 225 - 40)
    expect(north.some((d) => Number(d.attrs.frontage) > 0)).toBe(true)
  })

  it('reports no buildable blocks when the site is fully built over', () => {
    const q = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: [{ geometry: ns, width: 16 }], obstacles: [footprint(C, 500, 500)], water: [] })
    expect(of(q, 'plot').length).toBe(0)
    expect(q.checks).toContainEqual({ label: 'Buildable blocks', ok: false, detail: 'none found' })
  })
})

describe('land use and the rest of the plan', () => {
  // 3 × 3 blocks: two N-S and two E-W roads 300 m apart on a 900 m square; the north E-W road is 30 m wide
  const big = footprint(C, 900, 900)
  const grid: Existing = { roads: [{ geometry: road(90, 1100, -150), width: 16 }, { geometry: road(90, 1100, 150), width: 16 }, { geometry: road(0, 1100, 0, 150), width: 30 }, { geometry: road(0, 1100, 0, -150), width: 16 }], obstacles: [], water: [] }
  const blocks = analyseRoads(big, grid, 300).blocks
  const mix = DEFAULT_BRIEF.mix, total = Object.values(mix).reduce((a, x) => a + x, 0)

  it('follows the mix by whole blocks', { timeout: 120000 }, () => {
    expect(blocks.length).toBe(9)
    const p = generateOnRoads(big, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, grid)
    const site = p.metrics.siteArea, slack = Math.max(...blocks.map((b) => b.area)) / site
    for (const [z, share] of Object.entries(mix)) expect(Math.abs((p.metrics.landUse[z] ?? 0) / site - share / total), z).toBeLessThanOrEqual(slack)
  })

  it('puts commercial on the widest road', () => {
    const zones = zoneBlocks(blocks, mix, 'A', C)
    const com = blocks.filter((_, i) => zones[i] === 'commercial')
    expect(com.length).toBeGreaterThan(0)
    for (const b of com) expect(b.frontRoad).toBe(2)
  })

  it('residential only: every block is housing when the rest of the mix is zero', { timeout: 120000 }, () => {
    const b = { ...DEFAULT_BRIEF, mix: { residential: 100, commercial: 0, industrial: 0, institutional: 0, green: 0 } }
    const zones = of(generateOnRoads(site, b, VARIANTS[0], GENERIC_RULESET, ex), 'zone')
    expect(zones.length).toBe(4)
    for (const z of zones) expect(z.attrs.zoning).toBe('residential')
  })

  it('reports the road analysis and costs only new streets', () => {
    expect(p0.checks.find((c) => c.label === 'Road analysis')).toMatchObject({ ok: true, detail: expect.stringMatching(/^2 existing roads, [\d.]+ km, 4 blocks, average [\d.]+ ha$/) })
    const streets = of(p0, 'road-local').reduce((s, d) => s + turf.length(turf.feature(d.geometry as LineString), { units: 'meters' }) * Number(d.attrs.width), 0)
    expect(Math.abs(p0.metrics.roadArea - streets)).toBeLessThan(1)
  })

  it('places facilities, fills plots, and gives two different alternatives', { timeout: 120000 }, () => {
    expect(p0.metrics.facilities.school).toBeGreaterThanOrEqual(1)
    expect(p0.drafts.some((d) => Number(d.attrs.floors) > 0 && d.type !== 'plot')).toBe(true)
    expect(p0.label).toBe('Road-based layout A')
    expect(generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[1], GENERIC_RULESET, ex).label).toBe('Road-based layout B')
    expect(zoneBlocks(blocks, mix, 'A', C)).not.toEqual(zoneBlocks(blocks, mix, 'B', C))
  })

  const p0 = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, ex)
})

describe('final review fixes', () => {
  /** Straight segment between two local points (m). */
  const seg = (x0: number, y0: number, x1: number, y1: number): LineString => ({ type: 'LineString', coordinates: [[x0, y0], [x1, y1]].map(f.toGeo) })
  // a 12 m road from the south edge that stops at the centre (cul-de-sac / dead end)
  const deadEnd: Existing = { roads: [{ geometry: seg(0, -300, 0, 0), width: 12 }], obstacles: [], water: [] }
  const corner: Existing = { roads: [{ geometry: road(-45, 400, 225 - 30, 225 - 30), width: 16 }], obstacles: [], water: [] }

  it('dead-end road: plots on both sides of it', { timeout: 120000 }, () => {
    const q = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, deadEnd)
    const xs = of(q, 'plot').map((d) => f.toLocal(turf.centroid(d.geometry as Polygon).geometry.coordinates)[0])
    const west = xs.filter((x) => x < -10).length, east = xs.filter((x) => x > 10).length
    expect(east).toBeGreaterThan(50)
    expect(west).toBeGreaterThan(east * 0.5)
  })

  it.each([['dead end', deadEnd], ['corner clip', corner]] as const)('%s: every plot really fronts a road or new street', { timeout: 120000 }, (_, e) => {
    const q = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, e)
    const roads = [...e.roads.map((r) => ({ geometry: r.geometry, properties: { attrs: { width: r.width } } })), ...of(q, 'road-local').map((d) => ({ geometry: d.geometry, properties: { attrs: { width: d.attrs.width } } }))] as unknown as PlanFeature[]
    const plots = of(q, 'plot')
    expect(plots.length).toBeGreaterThan(20)
    const blind = plots.filter((d) => measureFrontage(d.geometry as Polygon, roads, 1.5) === 0)
    expect(blind.map((d) => d.name)).toEqual([])
  })

  it('dual carriageway: the median between the two ways is not a block', () => {
    const dual: Existing = { roads: [{ geometry: road(0, 700, 0, 6), width: 8 }, { geometry: road(0, 700, 0, -6), width: 8 }], obstacles: [], water: [] }
    const zones = of(generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, dual), 'zone')
    expect(zones.length).toBe(2)
    for (const z of zones) expect(turf.buffer(turf.feature(z.geometry as Polygon), -5, { units: 'meters' })).toBeTruthy()
  })

  it('stays fast with many short OpenStreetMap-style ways', { timeout: 120000 }, () => {
    // a 60 m street grid, each street split into 60 m ways (how OSM usually maps them)
    const ways: Existing['roads'] = []
    for (let k = -300; k <= 300; k += 60)
      for (let s = -300; s < 300; s += 60) ways.push({ geometry: seg(k, s, k, s + 60), width: 8 }, { geometry: seg(s, k, s + 60, k), width: 8 })
    const t = performance.now()
    generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, { roads: ways, obstacles: [], water: [] })
    expect(performance.now() - t).toBeLessThan(5000)
  })
})
