import { useState } from 'react'
import { clearRoads, roadSurface, subdivide, type SubdivideOptions } from '../geo'
import { componentDef, defaultAttrs, ROAD_CLASSES, uid, ZONING, type PlanFeature } from '../model'
import { useStore } from '../store'
import type { Feature, LineString, Polygon } from 'geojson'

const FIELDS: [Exclude<keyof SubdivideOptions, 'origin' | 'startY'>, string, string][] = [
  ['plotWidth', 'Plot width (frontage)', 'm'],
  ['plotDepth', 'Plot depth', 'm'],
  ['roadWidth', 'Local street width', 'm'],
  ['plotsPerBlock', 'Plots per block (along street)', ''],
  ['angle', 'Street orientation', '° cw'],
  ['minArea', 'Minimum plot area', 'm²'],
  ['minFrontage', 'Minimum frontage', 'm'],
]

export default function SubdivideDialog({ close, notify }: { close: () => void; notify: (m: string) => void }) {
  const s = useStore()
  const boundary = s.selection.length === 1 ? s.features[s.selection[0]] : undefined
  const [o, setO] = useState<SubdivideOptions>({ plotWidth: 15, plotDepth: 30, roadWidth: 12, plotsPerBlock: 8, angle: 0, minArea: s.meta.settings.minPlotArea ?? 350, minFrontage: s.meta.settings.minFrontage ?? 12 })
  const [zoning, setZoning] = useState('residential')
  if (!boundary || boundary.geometry.type !== 'Polygon') return null

  const run = () => {
    const bad = FIELDS.find(([k]) => k !== 'angle' && !(o[k] > 0) && k !== 'minArea' && k !== 'minFrontage')
    if (bad) return notify(`${bad[1]} must be greater than 0.`)
    const generated = subdivide(boundary.geometry as Polygon, o)
    // Respect roads that already exist: carve their corridors out of the new plots.
    const existing = Object.values(s.features)
      .filter((f) => f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads')
      .map((f) => roadSurface(f as Feature<LineString>, Number(f.properties.attrs.width) || 0))
      .filter((x): x is NonNullable<typeof x> => !!x)
    const plots = clearRoads(generated.plots, existing, o.minArea), roads = generated.roads
    if (!plots.length) return notify('No plots fit inside this boundary with these dimensions.')
    const plotLayer = s.layerFor('parcels'), roadLayer = s.layerFor('roads')
    const roadAttrs = { ...defaultAttrs(componentDef('road')), roadClass: 'local', width: o.roadWidth, lanes: 2, sidewalk: ROAD_CLASSES.local.sidewalk }
    const out: PlanFeature[] = [
      ...plots.map((p): PlanFeature => {
        const id = uid()
        return { type: 'Feature', id, geometry: p.geometry, properties: { id, type: 'plot', layerId: plotLayer, name: `Plot ${p.number}`,
          attrs: { plotNo: p.number, block: p.block, frontage: p.frontage, depth: p.depth, angle: p.angle, face: p.face, zoning, status: 'planned', ...(p.issue && { issue: p.issue }) } } }
      }),
      ...roads.map((g): PlanFeature => {
        const id = uid()
        return { type: 'Feature', id, geometry: g, properties: { id, type: 'road', layerId: roadLayer, name: 'Local street', attrs: { ...roadAttrs } } }
      }),
    ]
    s.addFeatures(out) // one undo step
    s.setPlotRules({ minPlotArea: o.minArea, minFrontage: o.minFrontage }) // reused by split/merge/edits
    const invalid = plots.filter((p) => p.issue).length
    notify(`Generated ${plots.length} plots in ${new Set(plots.map((p) => p.block)).size} blocks and ${roads.length} street segments. ${invalid ? `${invalid} plot(s) fail validation (red) — adjust or merge them.` : 'All plots pass validation.'} This is a preliminary layout, not an approved design.`)
    close()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="w-96 rounded-lg border border-line bg-panel shadow-2xl">
        <div className="border-b border-line px-4 py-2 text-sm font-medium">Subdivide “{boundary.properties.name}”</div>
        <div className="space-y-1.5 p-4">
          {FIELDS.map(([k, label, unit]) => (
            <label key={k} className="grid grid-cols-[1fr_90px_32px] items-center gap-2">
              <span className="text-muted">{label}</span>
              <input className="input" type="number" step="any" value={o[k]} onChange={(e) => setO({ ...o, [k]: +e.target.value })} />
              <span className="text-muted">{unit}</span>
            </label>
          ))}
          <label className="grid grid-cols-[1fr_122px] items-center gap-2">
            <span className="text-muted">Plot zoning</span>
            <select className="input" value={zoning} onChange={(e) => setZoning(e.target.value)}>
              {Object.entries(ZONING).map(([k, z]) => <option key={k} value={k}>{z.label}</option>)}
            </select>
          </label>
          <p className="pt-1 text-[11px] text-muted">Plots are laid out back-to-back between parallel streets with cross streets every block. Plots below the minimum area/frontage or without street access are kept and highlighted red. Reserve parks/schools by changing a plot's zoning afterwards. Automatic reservations & curvilinear layouts <span className="planned">planned</span></p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn-primary" onClick={run}>Generate plots</button>
        </div>
      </div>
    </div>
  )
}
