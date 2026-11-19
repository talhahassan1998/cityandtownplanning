import * as turf from '@turf/turf'
import type { LineString, Polygon, Position } from 'geojson'
import data from './data/authority-areas.json'
import type { Brief, Existing, Proposal } from './masterplan'
import { roadSurface } from './geo'

/**
 * Housing-society rules of the authority that controls a site: CDA (Islamabad Capital Territory) or RDA
 * (Rawalpindi), picked from the site's location. Report only: plans are compared, never changed.
 */
export type AuthorityId = 'none' | 'cda-2-5' | 'cda-4' | 'rda'

const AREAS = data.areas.map((a) => ({ name: a.name, id: a.authority as AuthorityId, geometry: a.geometry as Polygon }))

/**
 * The authority whose area contains `p` (a site centroid). Outlines: © OpenStreetMap contributors, ODbL.
 * ponytail: outlines simplified ≈ 100 m, no ICT zone outlines — sites near a border or in Zone 4 use the wizard override.
 */
export function detectAuthority(p: Position): { id: AuthorityId; area: string } {
  const a = AREAS.find((x) => turf.booleanPointInPolygon(p, x.geometry))
  return a ? { id: a.id, area: a.name } : { id: 'none', area: '' }
}

const CDA_SOURCE = 'Rules: CDA SRO 64(I)/2020 (Revised Modalities & Procedures) — superseded by SRO 886(I)/2023; verify against the current text. Percentages are subject to minor adjustments for site conditions.'
const RDA_SOURCE = 'Rules: Punjab Private Housing Schemes & Land Sub-Division Rules 2010 — RDA now applies the Punjab DA Private Housing Schemes Rules 2021 (amended 2026); verify against the current text.'
export const AUTHORITIES: Record<Exclude<AuthorityId, 'none'>, { name: string; short: 'CDA' | 'RDA'; source: string }> = {
  'cda-2-5': { name: 'CDA — Zones 2 & 5', short: 'CDA', source: CDA_SOURCE },
  'cda-4': { name: 'CDA — Zone 4', short: 'CDA', source: CDA_SOURCE },
  rda: { name: 'RDA (Punjab 2010 rules)', short: 'RDA', source: RDA_SOURCE },
}

// units (m, m²)
const ACRE = 4046.86, SQYD = 0.836127, FT = 0.3048, KANAL = 20 * 272 * FT * FT // Punjab marla = 272 sq ft outside Lahore
const ft = (n: number) => n * FT

/** What a proposal measures to, as the rules count it. Shares are % of the site; plot lists skip plots with an issue. */
interface Measured { site: number; res: number; com: number; inst: number; green: number; roads: number; plots: number[]; street: number; access: number }
type Draft = Proposal['drafts'][number]

function measure(p: Proposal, site: Polygon, existing: Existing, b: Brief): Measured {
  const siteArea = turf.area(site)
  const pct = (m2: number) => (siteArea > 0 ? (m2 / siteArea) * 100 : 0)
  const areaOf = (pred: (d: Draft) => boolean) => p.drafts.filter(pred).reduce((s, d) => s + turf.area(d.geometry as Polygon), 0)
  const plotOf = (z: string) => (d: Draft) => d.type === 'plot' && d.attrs.zoning === z
  const newRoads = p.drafts.filter((d) => d.type.startsWith('road') && d.geometry.type === 'LineString')
  // existing roads count only for their length inside the site
  const siteF = turf.feature(site)
  const inside = (g: LineString) => {
    const parts = turf.lineSplit(turf.feature(g), siteF).features
    return (parts.length ? parts : [turf.feature(g)]).reduce((s, x) => {
      const len = turf.length(x, { units: 'meters' })
      return turf.booleanPointInPolygon(turf.along(x, len / 2, { units: 'meters' }), siteF) ? s + len : s
    }, 0)
  }
  // every road, new or existing, counts only for its length inside the site (spine links can run 500 m outside it)
  const allRoads = [...newRoads.map((d) => ({ geometry: d.geometry as LineString, width: Number(d.attrs.width) || 0 })), ...existing.roads]
  const roadArea = allRoads.reduce((s, r) => s + inside(r.geometry) * r.width, 0)
  // open space excludes the road corridors that cross a green zone (the grid generator's bands include the spine)
  const surfaces = allRoads.map((r) => roadSurface(turf.feature(r.geometry), r.width)).filter((x) => !!x)
  const greenArea = p.drafts.filter((d) => d.type === 'zone' && d.attrs.zoning === 'green').reduce((s, d) => {
    const z = turf.feature(d.geometry as Polygon), zb = turf.bbox(z)
    const hits = surfaces.filter((x) => { const b = turf.bbox(x); return b[0] <= zb[2] && zb[0] <= b[2] && b[1] <= zb[3] && zb[1] <= b[3] })
    const open = hits.length ? turf.difference(turf.featureCollection([z, ...hits] as any)) : z
    return s + (open ? turf.area(open) : 0)
  }, 0)
  return {
    site: siteArea,
    res: pct(areaOf(plotOf('residential'))), com: pct(areaOf(plotOf('commercial'))), inst: pct(areaOf(plotOf('institutional'))),
    green: pct(greenArea),
    roads: pct(roadArea),
    plots: p.drafts.filter((d) => plotOf('residential')(d) && !d.attrs.issue).map((d) => turf.area(d.geometry as Polygon)),
    street: b.localStreetWidth,
    // the approach road: links to existing roads and the existing roads joined — not the scheme's own spine
    access: Math.max(0, ...newRoads.filter((d) => d.name === 'Link to existing road').map((d) => Number(d.attrs.width) || 0), ...p.linkedTo.map((i) => existing.roads[i]?.width ?? 0)),
  }
}

interface Rule { rule: string; clause: string; limit: string; ok: (m: Measured) => boolean; value: (m: Measured) => string }
const pc = (v: number) => `${v.toFixed(1)}%`
const share = (key: 'res' | 'com' | 'inst' | 'green' | 'roads', rule: string, clause: string, min: number, max = Infinity): Rule => ({
  rule, clause, limit: max === Infinity ? `≥ ${min}%` : min <= 0 ? `≤ ${max}%` : `${min}–${max}%`,
  ok: (m) => m[key] >= min && m[key] <= max, value: (m) => pc(m[key]),
})
// ponytail: no generator reserves a graveyard yet — always fails until a graveyard land use exists
const graveyard = (clause: string): Rule => ({ rule: 'Graveyard', clause, limit: '≥ 2%', ok: () => false, value: () => 'none reserved: add a graveyard by hand' })
const minArea = (m2: number, label: string, clause: string): Rule => ({ rule: 'Scheme area', clause, limit: `≥ ${label}`, ok: (m) => m.site >= m2, value: (m) => `${(m.site / 10000).toFixed(2)} ha` })
const smallest = (m2: number, label: string, clause: string): Rule => ({
  rule: 'Smallest residential plot', clause, limit: `≥ ${label}`, ok: (m) => m.plots.every((a) => a >= m2),
  value: (m) => (m.plots.length ? `${Math.round(Math.min(...m.plots))} m²` : 'no residential plots'),
})
const econ = (m: Measured) => { const all = m.plots.reduce((s, a) => s + a, 0); return all ? (m.plots.filter((a) => a <= 130 * SQYD).reduce((s, a) => s + a, 0) / all) * 100 : 0 }
const economy = (clause: string): Rule => ({ rule: 'Economy housing', clause, limit: '≥ 10% of residential plot area in plots ≤ 130 sq yd', ok: (m) => econ(m) >= 10, value: (m) => pc(econ(m)) })
const metres = (m: Measured) => `${m.street} m`

function cda(zone4: boolean): Rule[] {
  const c = (cl: string) => `SRO 64(I)/2020 cl. ${zone4 ? '5B' : '5A'}${cl}`
  return [
    minArea(50 * ACRE, '50 acres (20.23 ha)', zone4 ? 'SRO 64(I)/2020 cl. 5B' : 'SRO 64(I)/2020 cl. 1(i)'),
    share('res', 'Residential', c('(i)'), 0, zone4 ? 50 : 55),
    share('green', 'Open space', c('(ii)'), zone4 ? 15 : 10),
    share('roads', 'Roads', c('(iii)'), 23),
    graveyard(c('(iv)')),
    share('com', 'Commercial', c('(v)'), 0, 5),
    share('inst', 'Public buildings', c('(vi)'), 5),
    zone4
      ? { rule: 'Street width', clause: c('(vii)'), limit: '≥ 40 ft (12.19 m)', ok: (m) => m.street >= ft(40), value: metres }
      : { rule: 'Street width', clause: c('(vii)'), limit: '≥ 40 ft (12.19 m); 30 ft where plots ≤ 130 sq yd', ok: (m) => m.street >= ft(40) || (m.street >= ft(30) && m.plots.every((a) => a <= 130 * SQYD)), value: metres },
    zone4 ? smallest(130 * SQYD, '130 sq yd (108.7 m²)', c('(viii)')) : smallest(90 * SQYD, '90 sq yd (75.3 m²)', c('(viii)')),
    economy(c(zone4 ? '(ix)' : '(viii)')),
  ]
}

const P = (cl: string) => `Punjab 2010 r. ${cl}`
const low = (m: Measured) => (m.plots.length ? (m.plots.filter((a) => a <= 5 * KANAL / 20).length / m.plots.length) * 100 : 0)
const RDA_RULES: Rule[] = [
  minArea(100 * KANAL, '100 kanal (5.06 ha)', P('6(b)(iii)')),
  { rule: 'Access road', clause: P('6(b)(i), 10(2)(f)'), limit: '≥ 60 ft (18.29 m) in City Districts', ok: (m) => m.access >= ft(60), value: (m) => (m.access ? `${m.access} m` : 'none joined') },
  share('green', 'Open space', P('10(2)(a)'), 7),
  graveyard(P('10(2)(b)')),
  { ...share('com', 'Commercial', P('10(2)(c)'), 4.5, 5.5), limit: 'fixed 5% (checked 4.5–5.5%)' },
  share('inst', 'Public buildings', P('10(2)(d)'), 5, 10),
  { rule: 'Largest residential plot', clause: P('10(2)(e)'), limit: '≤ 1,000 sq yd (836 m²)', ok: (m) => m.plots.every((a) => a <= 1000 * SQYD), value: (m) => (m.plots.length ? `${Math.round(Math.max(...m.plots))} m²` : 'no residential plots') },
  { rule: 'Internal roads', clause: P('10(2)(g)'), limit: '≥ 40 ft (12.19 m) right of way', ok: (m) => m.street >= ft(40), value: metres },
  { rule: 'Low-income plots', clause: P('10(2)(j)'), limit: '≥ 20% of plots ≤ 5 marla (126 m²)', ok: (m) => low(m) >= 20, value: (m) => pc(low(m)) },
]

/**
 * The proposal compared with the authority's housing-scheme rules: one ✓/✗ row per rule, labelled `CDA: …` / `RDA: …`,
 * detail `<measured> (<limit>; <clause>)`. `[]` for `none`.
 */
export function authorityChecks(p: Proposal, site: Polygon, id: AuthorityId, existing: Existing, b: Brief): Proposal['checks'] {
  if (id === 'none') return []
  const m = measure(p, site, existing, b)
  return (id === 'rda' ? RDA_RULES : cda(id === 'cda-4')).map((r) => ({ label: `${AUTHORITIES[id].short}: ${r.rule}`, ok: r.ok(m), detail: `${r.value(m)} (${r.limit}; ${r.clause})` }))
}
