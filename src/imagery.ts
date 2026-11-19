import type { FeatureCollection, Polygon } from 'geojson'

/** Backend `POST /api/imagery/construction`: Sentinel-2 now vs a year ago (backend/app/imagery.py). A warning aid, never proof. */
export type ConstructionResult = {
  status: 'ok' | 'no-clear-image'
  now: string | null
  before: string | null
  patches: FeatureCollection<Polygon, { area_m2: number }>
  attribution: string
}

const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '?'

/** The wizard's one-line note for a check result (or its failure). */
export function imageryNote(r: ConstructionResult | Error): { tone: 'warn' | 'info'; text: string } {
  if (r instanceof Error) return { tone: 'info', text: `Imagery check unavailable (${r.message}).` }
  if (r.status === 'no-clear-image') return { tone: 'info', text: 'Satellite imagery: no clear (cloud-free) image of this site in the last 60 days — construction not checked.' }
  const head = `Satellite imagery (Sentinel-2, ${day(r.now)} vs ${day(r.before)})`
  const n = r.patches.features.length
  if (!n) return { tone: 'info', text: `${head}: no recent change detected (10 m pixels: a single new house can be missed).` }
  const ha = r.patches.features.reduce((s, f) => s + f.properties.area_m2, 0) / 1e4
  return { tone: 'warn', text: `${head}: ${n} area(s) changed recently, ${ha.toFixed(1)} ha — possible construction. Check on the ground.` }
}
