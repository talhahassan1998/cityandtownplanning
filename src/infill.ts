import * as turf from '@turf/turf'
import { footprint, unitsOf, type GeneratedPlot } from './geo'
import { componentDef, FLOOR_HEIGHT, type ZoneRule } from './model'
import type { Draft } from './masterplan'
import { minSetback } from './zoning'

/**
 * Plot infill: picks a building type for a generated plot and fits its footprint and floors to the
 * zone's development controls. Pure; the master-plan generator calls it once per plot.
 */
export type HousingType = 'villa' | 'house' | 'townhouse' | 'apartment'

/** Housing typology for a gross density (dwellings/ha). */
export const housingType = (density: number): HousingType =>
  density < 15 ? 'villa' : density < 40 ? 'house' : density <= 80 ? 'townhouse' : 'apartment'

/** Residential plot size (m) giving `density` gross dwellings/ha at one dwelling per plot. */
export function plotSizeFor(density: number, streetShare = 0.3): [number, number] {
  const area = (10000 * (1 - streetShare)) / Math.max(1, density)
  const w = Math.max(8, Math.min(40, Math.sqrt(area / 2)))
  return [Math.round(w * 10) / 10, Math.round((area / w) * 10) / 10]
}

/**
 * Plot size for a typology: one plot per house/villa (near-square, so a detached house fits inside the
 * `setback` on every side), per 6-unit townhouse row, per 16-flat block. Area keeps the gross density.
 */
export function residentialPlotSize(h: HousingType, density: number, setback = 3): [number, number] {
  if (h === 'villa' || h === 'house') {
    const area = 7000 / Math.max(1, density), min = 2 * setback + 8
    const w = Math.min(40, Math.max(min, Math.sqrt(area)))
    return [Math.round(w * 10) / 10, Math.round(Math.max(min, area / w) * 10) / 10]
  }
  const [dwellings, w] = h === 'townhouse' ? [6, 42] : [16, 46]
  return [w, Math.max(22, Math.round(((dwellings * 7000) / Math.max(1, density) / w) * 10) / 10)]
}

function typeFor(plot: GeneratedPlot, zone: string, housing: HousingType): string | undefined {
  if (zone === 'residential') return housing
  if (zone === 'commercial') return plot.area < 800 ? 'shop' : plot.area < 2000 ? 'mixed-use' : 'office'
  if (zone === 'industrial') return Number(plot.number.split('-').pop()) % 2 ? 'factory' : 'warehouse' // plot numbers are 'B1-3'
}

/** A building draft fitted to `plot` under `rule`, or undefined when nothing legal fits. */
export function fillPlot(plot: GeneratedPlot, zone: string, rule: ZoneRule | undefined, housing: HousingType, axis: number, tag: Record<string, string>): Draft | undefined {
  if (plot.issue || !rule) return
  const type = typeFor(plot, zone, housing)
  if (!type) return
  const def = componentDef(type)
  if (!rule.uses.includes(def.category)) return
  const s = rule.setback ?? 0
  const bw = plot.frontage - 2 * s, bd = plot.depth - 2 * s
  if (bw < 6 || bd < 6) return
  let w = type === 'townhouse' ? bw : Math.min(def.w ?? bw, bw), d = Math.min(def.d ?? bd, bd)
  if (rule.maxCoverage !== undefined) {
    const max = 0.9 * (rule.maxCoverage / 100) * plot.area
    if (w * d > max) { const k = Math.sqrt(max / (w * d)); w *= k; d *= k }
  }
  const c = turf.centroid(plot.geometry).geometry.coordinates
  // ponytail: centred on the plot; front-setback placement with a rear garden is the upgrade
  for (let i = 0; i < 6; i++, w *= 0.9, d *= 0.9) {
    if (w < 4 || d < 4) return
    const W = Math.floor(w * 10) / 10, D = Math.floor(d * 10) / 10
    const geometry = footprint(c, W, D, axis)
    const ring = geometry.coordinates[0].slice(0, -1)
    if (!ring.every((p) => turf.booleanPointInPolygon(p, plot.geometry)) || minSetback(ring, plot.geometry) < s - 0.01) continue
    const fp = turf.area(geometry)
    let floors = Math.min(def.floors ?? 1, rule.maxFloors ?? Infinity, rule.maxHeight !== undefined ? Math.floor(rule.maxHeight / FLOOR_HEIGHT) : Infinity, rule.maxFAR !== undefined ? Math.floor((rule.maxFAR * plot.area) / fp) : Infinity)
    const base = zone === 'residential' || zone === 'mixed' ? 1 : 0 // the plot's own dwelling (zoning.ts dwellingsPerPlot)
    const over = () => rule.maxDensity !== undefined && (base + unitsOf(type, fp * floors)) / (plot.area / 10000) > rule.maxDensity
    while (floors > 1 && over()) floors--
    if (floors < 1 || over()) return
    return { type, geometry, attrs: { ...tag, width: W, depth: D, rotation: axis, floors, height: +(floors * FLOOR_HEIGHT).toFixed(1), zoning: zone } }
  }
}
