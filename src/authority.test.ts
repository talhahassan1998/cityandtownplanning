import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import type { LineString, Polygon, Position } from 'geojson'
import { footprint, frame } from './geo'
import { DEFAULT_BRIEF, VARIANTS, type Draft, type Existing, type Proposal } from './masterplan'
import areas from './data/authority-areas.json'
import { authorityChecks, detectAuthority } from './authority'

describe('detectAuthority', () => {
  it('finds CDA in Islamabad, RDA in Rawalpindi and nothing in Karachi', () => {
    expect(detectAuthority([73.05, 33.72])).toEqual({ id: 'cda-2-5', area: 'Islamabad Capital Territory' })
    expect(detectAuthority([73.06, 33.59])).toEqual({ id: 'rda', area: 'Rawalpindi District' })
    expect(detectAuthority([67.03, 24.94])).toEqual({ id: 'none', area: '' })
  })

  it('border points: 300 m either side of the ICT boundary', () => {
    const ict = areas.areas.find((a) => a.authority === 'cda-2-5')!.geometry as Polygon
    const line = turf.lineString([[73.05, 33.72], [73.06, 33.59]])
    const cross = turf.lineIntersect(line, turf.polygonToLine(turf.feature(ict)) as any).features[0].geometry.coordinates
    const north = turf.destination(cross, 0.3, turf.bearing([73.06, 33.59], [73.05, 33.72])).geometry.coordinates
    const south = turf.destination(cross, 0.3, turf.bearing([73.05, 33.72], [73.06, 33.59])).geometry.coordinates
    expect(detectAuthority(north).id).toBe('cda-2-5')
    expect(detectAuthority(south).id).toBe('rda')
  })
})

describe('authorityChecks', () => {
  const C: Position = [73.1, 33.62], f = frame(C)
  const site = footprint(C, 500, 500) // 25 ha
  const plot = (zoning: string, w: number, d: number, extra: Record<string, unknown> = {}): Draft => ({ type: 'plot', geometry: footprint(C, w, d), attrs: { zoning, ...extra } })
  const line = (len: number): LineString => ({ type: 'LineString', coordinates: [[-len / 2, 0], [len / 2, 0]].map(f.toGeo) })
  // 50 % residential (130 plots of 100 m² = 10.4 % economy, 560 of 200 m²), 12 % green, 4.9 % commercial, 6 % institutional, 25 % roads
  const base: Draft[] = [
    ...Array.from({ length: 130 }, () => plot('residential', 10, 10)),
    ...Array.from({ length: 560 }, () => plot('residential', 10, 20)),
    // green square in the north half, clear of the streets
    { type: 'zone', geometry: footprint(f.toGeo([0, 120]), Math.sqrt(30000), Math.sqrt(30000)), attrs: { zoning: 'green' } },
    plot('commercial', 122.5, 100), plot('institutional', 150, 100),
    // 25 % roads: 11 streets of 12 m, 473.5 m long, inside the south half of the site
    ...Array.from({ length: 11 }, (_, k): Draft => ({ type: 'road-local', geometry: { type: 'LineString', coordinates: [[-236.7, -245 + k * 24], [236.7, -245 + k * 24]].map(f.toGeo) }, attrs: { width: 12 }, name: 'Local street' })),
  ]
  const prop = (drafts: Draft[], linkedTo: number[] = []): Proposal => ({ label: 'T', variant: VARIANTS[0], drafts, metrics: {} as Proposal['metrics'], checks: [], linkedTo })
  const none: Existing = { roads: [], obstacles: [], water: [] }
  const brief = { ...DEFAULT_BRIEF, localStreetWidth: 12.2 }
  const row = (rows: Proposal['checks'], label: string) => { const r = rows.find((x) => x.label === label); if (!r) throw new Error(`no row ${label}: ${rows.map((x) => x.label)}`); return r }
  const num = (detail: string) => parseFloat(detail)

  it('CDA zones 2 & 5: passes everything but the graveyard', () => {
    const rows = authorityChecks(prop(base), site, 'cda-2-5', none, brief)
    for (const l of ['Scheme area', 'Residential', 'Open space', 'Roads', 'Commercial', 'Public buildings', 'Street width', 'Smallest residential plot', 'Economy housing'])
      expect(row(rows, `CDA: ${l}`).ok, l).toBe(true)
    expect(row(rows, 'CDA: Graveyard')).toMatchObject({ ok: false, detail: expect.stringMatching(/^none reserved/) })
    expect(row(rows, 'CDA: Open space').detail).toMatch(/^12\.0% \(≥ 10%; .*5A\(ii\)/)
  })

  it('CDA zone 4: 12 % open space and 100 m² plots fail', () => {
    const rows = authorityChecks(prop(base), site, 'cda-4', none, brief)
    expect(row(rows, 'CDA: Open space').ok).toBe(false)
    expect(row(rows, 'CDA: Smallest residential plot').ok).toBe(false)
  })

  it('scheme area: a 4 ha site is below the CDA minimum', () => {
    expect(row(authorityChecks(prop(base), footprint(C, 200, 200), 'cda-2-5', none, brief), 'CDA: Scheme area').ok).toBe(false)
  })

  it('RDA: flags a 1 200 m² plot, a 16 m access road and too few small plots', () => {
    const ex: Existing = { roads: [{ geometry: line(2000), width: 16 }], obstacles: [], water: [] }
    const rows = authorityChecks(prop([...base, plot('residential', 30, 40)], [0]), site, 'rda', ex, brief)
    expect(row(rows, 'RDA: Largest residential plot').ok).toBe(false)
    expect(row(rows, 'RDA: Access road').ok).toBe(false)
    expect(row(rows, 'RDA: Commercial').ok).toBe(true)
    expect(row(rows, 'RDA: Open space').ok).toBe(true)
    expect(row(rows, 'RDA: Internal roads').ok).toBe(true)
    expect(row(rows, 'RDA: Low-income plots').ok).toBe(false) // 130 of 691 plots ≤ 5 marla < 20 %
  })

  it('clips existing roads to the site', () => {
    const ex: Existing = { roads: [{ geometry: line(2000), width: 16 }], obstacles: [], water: [] }
    const a = num(row(authorityChecks(prop(base), site, 'cda-2-5', none, brief), 'CDA: Roads').detail)
    const b = num(row(authorityChecks(prop(base), site, 'cda-2-5', ex, brief), 'CDA: Roads').detail)
    expect(b - a).toBeCloseTo((500 * 16) / 250000 * 100, 0)
  })

  it('ignores flagged plots for plot sizes', () => {
    const rows = authorityChecks(prop([...base, plot('residential', 5, 6, { issue: 'Area below 99 m²' })]), site, 'cda-2-5', none, brief)
    expect(row(rows, 'CDA: Smallest residential plot').ok).toBe(true)
  })

  it('empty proposal: rows render with finite numbers', () => {
    for (const id of ['cda-2-5', 'cda-4', 'rda'] as const)
      for (const r of authorityChecks(prop([]), site, id, none, brief)) expect(r.detail, r.label).not.toMatch(/NaN|Infinity/)
  })

  it('none: no rows', () => {
    expect(authorityChecks(prop(base), site, 'none', none, brief)).toEqual([])
  })
})

describe('final review fixes', () => {
  const C: Position = [73.1, 33.62], f = frame(C)
  const site = footprint(C, 500, 500)
  const seg = (x0: number, y0: number, x1: number, y1: number): LineString => ({ type: 'LineString', coordinates: [[x0, y0], [x1, y1]].map(f.toGeo) })
  const prop = (drafts: Draft[], linkedTo: number[] = []): Proposal => ({ label: 'T', variant: VARIANTS[0], drafts, metrics: {} as Proposal['metrics'], checks: [], linkedTo })
  const none: Existing = { roads: [], obstacles: [], water: [] }
  const row = (rows: Proposal['checks'], label: string) => rows.find((x) => x.label === label)!
  const num = (detail: string) => parseFloat(detail)

  it('access road: the internal spine is not an approach road', () => {
    const spine: Draft = { type: 'road-arterial', geometry: seg(-240, 0, 240, 0), attrs: { width: 24 }, name: 'Arterial spine' }
    const r = row(authorityChecks(prop([spine]), site, 'rda', none, DEFAULT_BRIEF), 'RDA: Access road')
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/^none joined/) })
    const link: Draft = { type: 'road-arterial', geometry: seg(240, 0, 400, 0), attrs: { width: 24 }, name: 'Link to existing road' }
    expect(row(authorityChecks(prop([spine, link]), site, 'rda', none, DEFAULT_BRIEF), 'RDA: Access road').ok).toBe(true)
  })

  it('roads %: new roads outside the site do not count', () => {
    const inside: Draft = { type: 'road-local', geometry: seg(-240, 0, 240, 0), attrs: { width: 12 }, name: 'Local street' }
    const outside: Draft = { type: 'road-arterial', geometry: seg(300, 0, 1300, 0), attrs: { width: 24 }, name: 'Link to existing road' }
    const a = num(row(authorityChecks(prop([inside]), site, 'cda-2-5', none, DEFAULT_BRIEF), 'CDA: Roads').detail)
    const b = num(row(authorityChecks(prop([inside, outside]), site, 'cda-2-5', none, DEFAULT_BRIEF), 'CDA: Roads').detail)
    expect(b).toBeCloseTo(a, 1)
  })

  it('open space: streets crossing a green zone are not open space', () => {
    // a 100 m wide green band across the site, crossed by a 24 m road along its length
    const band: Draft = { type: 'zone', geometry: footprint(C, 500, 100), attrs: { zoning: 'green' } }
    const road: Draft = { type: 'road-arterial', geometry: seg(-260, 0, 260, 0), attrs: { width: 24 }, name: 'Arterial spine' }
    const g = num(row(authorityChecks(prop([band, road]), site, 'cda-2-5', none, DEFAULT_BRIEF), 'CDA: Open space').detail)
    expect(g).toBeCloseTo(((100 - 24) * 500) / 250000 * 100, 0) // ≈ 15.2 %, not 20 %
  })
})
