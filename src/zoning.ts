import * as turf from '@turf/turf'
import type { Polygon, Position } from 'geojson'
import { frame, measure, unitsOf } from './geo'
import { componentDef, GENERIC_RULESET, ZONING, type PlanFeature, type Ruleset, type Settings, type ZoneRule } from './model'

export type CheckCode = 'height' | 'floors' | 'use' | 'setback' | 'outside' | 'far' | 'coverage' | 'minPlot' | 'density'

export const CHECK_LABELS: Record<CheckCode, string> = {
  height: 'Building height', floors: 'Number of floors', use: 'Permitted use', setback: 'Setback',
  outside: 'Building outside plot', far: 'Floor area ratio', coverage: 'Ground coverage', minPlot: 'Minimum plot size', density: 'Density',
}

/** One violated control. `value`/`limit` are in the control's own unit (m, %, ratio, dw/ha…). */
export interface Violation { id: string; code: CheckCode; message: string; value?: number; limit?: number }

export interface PlotMetrics { zone?: string; area: number; footprint: number; gfa: number; far: number; coverage: number; dwellings: number; density: number; buildings: string[] }
export interface BuildingInfo { zone?: string; plotId?: string; minSetback?: number }

export interface Compliance {
  violations: Violation[]
  byId: Map<string, Violation[]>
  plots: Map<string, PlotMetrics>
  buildings: Map<string, BuildingInfo>
}

/** A building for zoning purposes: anything that carries floors (houses, offices, schools…). */
export const isBuilding = (f: PlanFeature) => Number(f.properties.attrs.floors) > 0

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const bboxHit = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/** Smallest distance (m) from any building vertex to the plot boundary, in a local metric frame. */
export function minSetback(building: Position[], plot: Polygon): number {
  const f = frame(turf.centroid(plot).geometry.coordinates)
  const rings = plot.coordinates.map((r) => r.map(f.toLocal))
  let best = Infinity
  for (const p of building.map(f.toLocal))
    for (const r of rings)
      for (let i = 1; i < r.length; i++) {
        const a = r[i - 1], b = r[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
        const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
      }
  return best
}

/**
 * Checks every building and plot against the development controls of its zone. A building's zone
 * is that of the plot containing its centroid, else of the zoning polygon containing it; plot-based
 * controls (FAR, coverage, density, setback) only apply to buildings that sit on a plot.
 * ponytail: linear bbox scan for building→plot lookup; add an R-tree (rbush) for 100k+ objects.
 */
export function evaluate(all: PlanFeature[], ruleset: Ruleset, settings: Settings): Compliance {
  const plots = all.filter((f) => f.properties.type === 'plot' && f.geometry.type === 'Polygon')
  const zones = all.filter((f) => f.properties.type === 'zone' && f.geometry.type === 'Polygon')
  const buildings = all.filter(isBuilding)
  const plotBox = plots.map((p) => turf.bbox(p))
  const zoneBox = zones.map((z) => turf.bbox(z))
  const out: Compliance = { violations: [], byId: new Map(), plots: new Map(), buildings: new Map() }
  const add = (v: Violation) => { out.violations.push(v); out.byId.set(v.id, [...(out.byId.get(v.id) ?? []), v]) }
  const ruleOf = (zone?: string): ZoneRule | undefined => (zone ? ruleset.rules[zone] : undefined)
  const zoneLabel = (z?: string) => (z ? ZONING[z]?.label ?? z : '—')

  for (const p of plots) out.plots.set(p.id, { zone: p.properties.attrs.zoning as string | undefined, area: measure(p).area, footprint: 0, gfa: 0, far: 0, coverage: 0, dwellings: 0, density: 0, buildings: [] })

  for (const b of buildings) {
    const c = turf.centroid(b)
    const cb = c.geometry.coordinates
    const pi = plots.findIndex((p, i) => bboxHit(plotBox[i], [cb[0], cb[1], cb[0], cb[1]]) && turf.booleanPointInPolygon(c, p as any))
    const plot = pi >= 0 ? plots[pi] : undefined
    let zone = plot?.properties.attrs.zoning as string | undefined
    if (!zone) {
      const zi = zones.findIndex((z, i) => bboxHit(zoneBox[i], [cb[0], cb[1], cb[0], cb[1]]) && turf.booleanPointInPolygon(c, z as any))
      zone = zi >= 0 ? (zones[zi].properties.attrs.zoning as string) : undefined
    }
    const info: BuildingInfo = { zone, plotId: plot?.id }
    out.buildings.set(b.id, info)
    const rule = ruleOf(zone)
    const a = b.properties.attrs
    const area = measure(b).area, floors = Number(a.floors) || 0, height = Number(a.height) || 0

    if (plot) {
      const m = out.plots.get(plot.id)!
      m.footprint += area; m.gfa += area * floors; m.buildings.push(b.id)
      m.dwellings += unitsOf(b.properties.type, area * floors)
    }
    if (!rule) continue
    if (rule.maxHeight !== undefined && height > rule.maxHeight)
      add({ id: b.id, code: 'height', value: height, limit: rule.maxHeight, message: `Height ${round(height, 1)} m exceeds ${rule.maxHeight} m allowed in ${zoneLabel(zone)}` })
    if (rule.maxFloors !== undefined && floors > rule.maxFloors)
      add({ id: b.id, code: 'floors', value: floors, limit: rule.maxFloors, message: `${floors} floors exceeds ${rule.maxFloors} allowed in ${zoneLabel(zone)}` })
    const use = componentDef(b.properties.type).category
    if (use && !rule.uses.includes(use))
      add({ id: b.id, code: 'use', message: `${use} use is not permitted in ${zoneLabel(zone)}` })
    if (plot && b.geometry.type === 'Polygon') {
      const ring = b.geometry.coordinates[0].slice(0, -1)
      if (!ring.every((p) => turf.booleanPointInPolygon(p, plot as any, { ignoreBoundary: false })))
        add({ id: b.id, code: 'outside', message: `Building extends outside plot ${plot.properties.attrs.plotNo ?? plot.properties.name}` })
      else {
        info.minSetback = round(minSetback(ring, plot.geometry as Polygon), 2)
        if (rule.setback && info.minSetback < rule.setback - 0.01)
          add({ id: b.id, code: 'setback', value: info.minSetback, limit: rule.setback, message: `Setback ${info.minSetback.toFixed(1)} m is less than the ${rule.setback} m required` })
      }
    }
  }

  for (const p of plots) {
    const m = out.plots.get(p.id)!
    if (m.zone === 'residential' || m.zone === 'mixed') m.dwellings += settings.dwellingsPerPlot
    m.far = m.area ? round(m.gfa / m.area, 2) : 0
    m.coverage = m.area ? round((m.footprint / m.area) * 100, 1) : 0
    m.density = m.area ? round(m.dwellings / (m.area / 10000), 1) : 0
    const rule = ruleOf(m.zone)
    if (!rule) continue
    const no = p.properties.attrs.plotNo ?? p.properties.name
    if (rule.minPlotArea !== undefined && m.area < rule.minPlotArea)
      add({ id: p.id, code: 'minPlot', value: round(m.area, 1), limit: rule.minPlotArea, message: `Plot ${no} is ${Math.round(m.area)} m², below the ${rule.minPlotArea} m² minimum for ${zoneLabel(m.zone)}` })
    if (rule.maxFAR !== undefined && m.far > rule.maxFAR)
      add({ id: p.id, code: 'far', value: m.far, limit: rule.maxFAR, message: `FAR ${m.far} exceeds ${rule.maxFAR} on plot ${no}` })
    if (rule.maxCoverage !== undefined && m.coverage > rule.maxCoverage)
      add({ id: p.id, code: 'coverage', value: m.coverage, limit: rule.maxCoverage, message: `Ground coverage ${m.coverage}% exceeds ${rule.maxCoverage}% on plot ${no}` })
    if (rule.maxDensity !== undefined && m.buildings.length && m.density > rule.maxDensity)
      add({ id: p.id, code: 'density', value: m.density, limit: rule.maxDensity, message: `Density ${m.density} dwellings/ha exceeds ${rule.maxDensity} on plot ${no}` })
  }
  return out
}

/** Memoised evaluation keyed on the (immutable) features map, ruleset and settings. */
let memo: { f: unknown; r: unknown; s: unknown; out: Compliance } | null = null
export function complianceOf(features: Record<string, PlanFeature>, ruleset: Ruleset | undefined, settings: Settings): Compliance {
  const r = ruleset ?? GENERIC_RULESET
  if (memo && memo.f === features && memo.r === r && memo.s === settings) return memo.out
  memo = { f: features, r, s: settings, out: evaluate(Object.values(features), r, settings) }
  return memo.out
}

/** Validates a ruleset loaded from JSON; throws with a readable reason. */
export function parseRuleset(text: string): Ruleset {
  const raw = JSON.parse(text)
  if (typeof raw?.name !== 'string' || typeof raw?.rules !== 'object' || !raw.rules) throw new Error('Expected { name, rules: { <zone>: { … } } }')
  const nums = ['maxHeight', 'maxFloors', 'maxFAR', 'maxCoverage', 'minPlotArea', 'setback', 'maxDensity'] as const
  const rules: Record<string, ZoneRule> = {}
  for (const [zone, r] of Object.entries<any>(raw.rules)) {
    const rule: ZoneRule = { uses: Array.isArray(r?.uses) ? r.uses.filter((u: unknown) => typeof u === 'string') : [] }
    for (const k of nums) {
      if (r?.[k] === undefined || r[k] === null) continue
      if (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0) throw new Error(`${zone}.${k} must be a non-negative number`)
      rule[k] = r[k]
    }
    rules[zone] = rule
  }
  return { name: raw.name, rules }
}
