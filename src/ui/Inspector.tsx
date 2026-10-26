import { useMemo, useState } from 'react'
import { BUILDING_STYLES, colorOf, componentDef, FLOOR_HEIGHT, GENERIC_RULESET, NETWORKS, ROAD_CLASSES, ZONING, type PlanFeature } from '../model'
import { complianceOf, isBuilding } from '../zoning'
import { networksOf } from '../networks'
import { lockedIds, makeFeature, useStore } from '../store'
import { clearRoads, measure, mergePlots, plotIssue, roadSurface, splitPlot, type SplitDirection } from '../geo'
import { culDeSacGeom, defaultCurve, junctionPoints, measureFrontage, plotsAlongRoad, roundaboutGeom, type AlongOptions } from '../roads'
import * as turf from '@turf/turf'
import type { Feature, LineString, Polygon } from 'geojson'
import { zoomTo } from '../map/MapCanvas'
import { fmtArea, fmtLen, fmtMoney } from './format'
import type { Dialog } from '../App'

type Field = { label: string; unit?: string; options?: Record<string, string>; text?: boolean; color?: boolean; readOnly?: boolean }

const opts = (o: Record<string, { label: string }>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.label]))

const FIELDS: Record<string, Field> = {
  plotNo: { label: 'Plot no.', text: true },
  block: { label: 'Block', text: true },
  roadClass: { label: 'Road type', options: opts(ROAD_CLASSES) },
  zoning: { label: 'Zoning', options: opts(ZONING) },
  status: { label: 'Status', options: { planned: 'Planned', reserved: 'Reserved', allocated: 'Allocated', developed: 'Developed' } },
  width: { label: 'Width', unit: 'm' },
  depth: { label: 'Depth', unit: 'm' },
  rotation: { label: 'Rotation', unit: '°' },
  frontage: { label: 'Frontage', unit: 'm' },
  lanes: { label: 'Lanes' },
  curveRadius: { label: 'Curve radius', unit: 'm' },
  sidewalk: { label: 'Sidewalk (each)', unit: 'm' },
  surface: { label: 'Surface', options: { asphalt: 'Asphalt', concrete: 'Concrete', pavers: 'Pavers', gravel: 'Gravel' } },
  floors: { label: 'Floors' },
  height: { label: 'Height', unit: 'm' },
  setback: { label: 'Setback', unit: 'm' },
  vegetation: { label: 'Vegetation', text: true },
  facilities: { label: 'Facilities', text: true },
  network: { label: 'Network', options: { water: 'Water supply', sewer: 'Sewerage', stormwater: 'Stormwater', electricity: 'Electricity', telecom: 'Telecom', waste: 'Waste', transit: 'Public transport' } },
  diameter: { label: 'Diameter / size', unit: 'mm' },
  material: { label: 'Material', text: true },
  capacity: { label: 'Capacity', text: true },
  roof: { label: 'Roof', options: { '': 'Style default', flat: 'Flat', gable: 'Gable', hip: 'Hip', pyramid: 'Pyramid' } },
  style: { label: 'Style', options: { '': 'Project default', ...BUILDING_STYLES } },
  color: { label: 'Colour', color: true },
  structure: { label: 'Structure', options: { grade: 'At grade', bridge: 'Bridge', tunnel: 'Tunnel' } },
  radius: { label: 'Radius', unit: 'm' },
  island: { label: 'Island radius', unit: 'm' },
  notes: { label: 'Notes', text: true },
}

/** Extra editable attributes per layer kind, shown even before they have a value. */
const EXTRA: Record<string, string[]> = {
  roads: ['curveRadius', 'surface', 'structure'],
  green: ['vegetation', 'facilities'],
  buildings: ['style', 'roof', 'color'],
  facilities: ['style', 'roof', 'color'],
  utilities: ['capacity'],
}

export default function Inspector({ openDialog }: { openDialog: (d: Dialog) => void }) {
  const s = useStore()
  const sel = s.selection.map((id) => s.features[id]).filter(Boolean)
  if (!sel.length) return <ProjectPanel />
  if (sel.length > 1) {
    const total = sel.reduce((a, f) => a + measure(f).area, 0)
    return (
      <div className="section space-y-2">
        <div className="text-sm font-medium">{sel.length} objects selected</div>
        <div className="text-muted">Combined area {fmtArea(total)}</div>
        <div className="flex flex-wrap gap-1">
          <button className="btn border border-line" onClick={s.duplicate}>Duplicate</button>
          <button className="btn border border-line" onClick={() => zoomTo(sel)}>Zoom to</button>
          <button className="btn border border-line text-bad" onClick={s.deleteSelected}>Delete</button>
        </div>
        {sel.every((f) => f.properties.type === 'plot') && <MergeBox plots={sel} />}
        {sel.length === 2 && sel.every((f) => f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads') && <button className="btn-primary" onClick={() => s.joinRoads(sel[0].id, sel[1].id)}>Join roads</button>}
        <p className="text-muted">Grouping <span className="planned">planned</span></p>
      </div>
    )
  }
  return <FeaturePanel f={sel[0]} openDialog={openDialog} />
}

function FeaturePanel({ f, openDialog }: { f: PlanFeature; openDialog: (d: Dialog) => void }) {
  const s = useStore()
  const def = componentDef(f.properties.type)
  const { attrs } = f.properties
  const m = measure(f)
  const locked = lockedIds(s).has(f.properties.layerId)
  // Parametric footprints keep width/depth/rotation in sync; shapes reshaped on the map are free-form.
  const param = f.geometry.type === 'Polygon' && 'rotation' in attrs && attrs.shape !== 'custom'
  const custom = f.geometry.type === 'Polygon' && attrs.shape === 'custom'
  const set = (k: string, v: string | number) => {
    // a free-form shape can still be turned to an exact angle: rotate by the difference
    if (k === 'rotation' && !param) return s.rotateFeatures([f.id], (Number(v) || 0) - (Number(attrs.rotation) || 0))
    const patch: Record<string, string | number> = { [k]: v }
    if (k === 'floors') patch.height = +(Number(v) * FLOOR_HEIGHT).toFixed(1)
    if (k === 'roadClass') { const r = ROAD_CLASSES[v as string]; Object.assign(patch, { width: r.width, lanes: r.lanes, sidewalk: r.sidewalk }) }
    s.updateFeature(f.id, { attrs: patch })
  }
  const keys = [...new Set([...Object.keys(FIELDS).filter((k) => k in attrs), ...(EXTRA[def.layer] ?? []), 'notes'])]
    .filter((k) => (k !== 'roof' && k !== 'style') || Number(attrs.floors) > 0)
    .filter((k) => !(custom && (k === 'width' || k === 'depth'))) // meaningless once reshaped by hand
  const width = Number(attrs.width) || 0
  const turn = (deg: number) => s.rotateFeatures([f.id], deg)
  const grow = (k: number) => s.scaleFeatures([f.id], k)

  return (
    <div className={locked ? 'pointer-events-none opacity-60' : ''}>
      <div className="section space-y-2">
        <div className="flex items-center justify-between">
          <span className="label">{def.label}</span>
          {locked && <span className="text-warn">layer locked</span>}
        </div>
        <input className="input text-sm" value={f.properties.name} onChange={(e) => s.updateFeature(f.id, { name: e.target.value })} />
        <Row label="Layer">
          <select className="input" value={f.properties.layerId} onChange={(e) => s.updateFeature(f.id, { layerId: e.target.value })}>
            {s.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Row>
        {attrs.issue && <div className="rounded border border-bad/50 bg-bad/10 px-2 py-1 text-bad">⚠ {attrs.issue}</div>}
      </div>

      <div className="section space-y-1">
        <div className="label">Measured</div>
        {m.area > 0 && <KV k="Area" v={fmtArea(m.area)} />}
        {m.perimeter > 0 && <KV k="Perimeter" v={fmtLen(m.perimeter)} />}
        {m.length > 0 && <KV k="Length" v={fmtLen(m.length)} />}
        {f.geometry.type === 'Point' && <KV k="Position" v={`${f.geometry.coordinates[1].toFixed(6)}, ${f.geometry.coordinates[0].toFixed(6)}`} />}
        {attrs.floors && m.area > 0 && <KV k="Gross floor area" v={fmtArea(m.area * Number(attrs.floors))} />}
        {def.layer === 'roads' && m.length > 0 && <KV k="Right-of-way area" v={fmtArea(m.length * width)} />}
      </div>

      <div className="section space-y-1.5">
        <div className="label">Properties</div>
        {keys.map((k) => {
          const fd = FIELDS[k]
          const v = attrs[k] ?? ''
          return (
            <Row key={k} label={fd.label + (fd.unit ? ` (${fd.unit})` : '')}>
              {fd.color ? (
                <div className="flex items-center gap-1">
                  <input type="color" className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent" value={/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : colorOf(f)} onChange={(e) => set(k, e.target.value)} />
                  {v !== '' && <button className="btn px-1 text-muted" onClick={() => set(k, '')} title="Back to the default colour">reset</button>}
                </div>
              ) : fd.options ? (
                <select className="input" value={String(v)} onChange={(e) => set(k, e.target.value)}>
                  {!(String(v) in fd.options) && <option value="">—</option>}
                  {Object.entries(fd.options).map(([ov, ol]) => <option key={ov} value={ov}>{ol}</option>)}
                </select>
              ) : (
                <input className="input" type={fd.text ? 'text' : 'number'} step="any" value={v}
                  onChange={(e) => set(k, fd.text ? e.target.value : e.target.value === '' ? '' : +e.target.value)} />
              )}
            </Row>
          )
        })}
        {param && <p className="text-[10px] text-muted">Editing width/depth/rotation regenerates the rectangular footprint around its centre.</p>}
        {custom && 'width' in attrs && (
          <div className="flex items-center gap-2 text-[10px] text-muted">
            <span className="flex-1">Free-form shape (reshaped on the map). Rotation and the transform buttons still work.</span>
            <button className="btn border border-line" title={`Back to a ${attrs.width} × ${attrs.depth} m rectangle`}
              onClick={() => s.updateFeature(f.id, { attrs: { shape: '', width: Number(attrs.width), depth: Number(attrs.depth), rotation: Number(attrs.rotation) || 0 } })}>Reset to rectangle</button>
          </div>
        )}
      </div>

      {f.geometry.type !== 'Point' && (
        <div className="section space-y-1.5">
          <div className="label">Transform</div>
          <div className="flex flex-wrap gap-1">
            <button className="btn border border-line" onClick={() => turn(-15)}>⟲ 15°</button>
            <button className="btn border border-line" onClick={() => turn(15)}>⟳ 15°</button>
            <button className="btn border border-line" onClick={() => grow(0.9)}>− 10%</button>
            <button className="btn border border-line" onClick={() => grow(1.1)}>+ 10%</button>
          </div>
          <p className="text-[10px] text-muted">Keys: <b>[</b> / <b>]</b> rotate 15° (with Shift: 1°). On the map: drag the shape to move · drag the round knob above it to rotate (Shift: free) · drag a corner to resize · drag vertices to reshape · midpoints add vertices.</p>
        </div>
      )}

      {f.properties.type === 'plot' && f.geometry.type === 'Polygon' && <SplitBox f={f} />}
      {def.layer === 'roads' && f.geometry.type === 'LineString' && <RoadTools key={f.id} f={f} />}

      {(f.properties.type === 'plot' || isBuilding(f)) && <ComplianceBox f={f} openDialog={openDialog} />}
      <NetworkIssues f={f} />

      <Estimates f={f} area={m.area} length={m.length} />

      <div className="section flex flex-wrap gap-1">
        {(f.properties.type === 'boundary' || f.properties.type === 'zone') && <button className="btn-primary" onClick={() => openDialog('subdivide')}>Subdivide into plots…</button>}
        <button className="btn border border-line" onClick={() => zoomTo(f)}>Zoom to</button>
        <button className="btn border border-line" onClick={s.duplicate}>Duplicate</button>
        <button className="btn border border-line text-bad" onClick={s.deleteSelected}>Delete</button>
      </div>
    </div>
  )
}

function SplitBox({ f }: { f: PlanFeature }) {
  const s = useStore()
  const [n, setN] = useState(2)
  const [dir, setDir] = useState<SplitDirection>('frontage')
  const known = f.properties.attrs.angle !== undefined
  return (
    <div className="section space-y-1.5">
      <div className="label">Split plot</div>
      <Row label="Into">
        <input className="input" type="number" min={2} max={10} value={n} onChange={(e) => setN(Math.max(2, Math.min(10, Math.round(+e.target.value) || 2)))} />
      </Row>
      <Row label="Across">
        <select className="input" value={dir} onChange={(e) => setDir(e.target.value as SplitDirection)}>
          <option value="frontage">Frontage (side by side)</option>
          <option value="depth">Depth (front / rear)</option>
        </select>
      </Row>
      <button className="btn-primary" onClick={() => s.replaceFeatures([f.id], splitPlot(f, n, dir, s.meta.settings))}>Split into {n} plots</button>
      <p className="text-[10px] text-muted">
        Equal-width strips. Rear plots from a depth split have no frontage and are flagged until given access.
        {!known && ' Hand-drawn plot: the shorter side is assumed to face the street.'}
      </p>
    </div>
  )
}

function MergeBox({ plots }: { plots: PlanFeature[] }) {
  const s = useStore()
  const [error, setError] = useState<string | null>(null)
  const merge = () => {
    const r = mergePlots(plots, s.meta.settings)
    if (typeof r === 'string') return setError(r)
    setError(null)
    s.replaceFeatures(plots.map((p) => p.id), [r])
  }
  return (
    <div className="space-y-1 border-t border-line pt-2">
      <button className="btn-primary" onClick={merge}>Merge {plots.length} plots</button>
      {error && <div className="rounded border border-bad/50 bg-bad/10 px-2 py-1 text-bad">{error}</div>}
    </div>
  )
}

function PlotRulesPanel() {
  const settings = useStore((s) => s.meta.settings)
  const setPlotRules = useStore((s) => s.setPlotRules)
  const features = useStore((s) => s.features)
  const [count, failing] = useMemo(() => {
    const plots = Object.values(features).filter((f) => f.properties.type === 'plot')
    return [plots.length, plots.filter((p) => p.properties.attrs.issue).length]
  }, [features])
  return (
    <div className="section space-y-1.5">
      <div className="label">Plot rules</div>
      <Row label="Min. area (m²)">
        <input className="input" type="number" min={0} value={settings.minPlotArea ?? ''} placeholder="none"
          onChange={(e) => setPlotRules({ minPlotArea: e.target.value === '' ? undefined : Math.max(0, +e.target.value) })} />
      </Row>
      <Row label="Min. frontage (m)">
        <input className="input" type="number" min={0} value={settings.minFrontage ?? ''} placeholder="none"
          onChange={(e) => setPlotRules({ minFrontage: e.target.value === '' ? undefined : Math.max(0, +e.target.value) })} />
      </Row>
      <p className="text-[11px] text-muted">{count} plots · <span className={failing ? 'text-bad' : ''}>{failing} failing</span>. Plots re-validate automatically when edited, split, merged, or when these rules change.</p>
    </div>
  )
}

/** Road-design tools for a selected centreline: plots along it, cul-de-sacs, roundabouts at junctions. */
function RoadTools({ f }: { f: PlanFeature }) {
  const s = useStore()
  const line = f.geometry as LineString
  const width = Number(f.properties.attrs.width) || 0
  const [plotWidth, setPlotWidth] = useState(15)
  const [plotDepth, setPlotDepth] = useState(30)
  const [sides, setSides] = useState<AlongOptions['sides']>('both')
  const [headR, setHeadR] = useState(Math.max(10, Math.round(width)))
  const [ringR, setRingR] = useState(Math.max(15, Math.round(width * 1.5)))
  const others = () => Object.values(s.features).filter((x) => x.id !== f.id && componentDef(x.properties.type).layer === 'roads')

  const plotsAlong = () => {
    const along = plotsAlongRoad(line, { plotWidth, plotDepth, roadWidth: width, sides })
    if (!along.length) return s.notify('This road is shorter than one plot width.')
    const blocks = new Set(Object.values(s.features).filter((x) => x.properties.type === 'plot').map((x) => String(x.properties.attrs.block ?? '')))
    let n = 1
    while (blocks.has(`S${n}`)) n++
    const block = `S${n}`
    const rules = s.meta.settings
    const generated = along.map((p) => ({
      geometry: p.geometry, block, angle: p.angle, face: p.face, frontage: p.frontage, depth: plotDepth,
      number: `${block}-${p.side === 'L' ? 2 * p.index + 1 : 2 * p.index + 2}`, // odd numbers left, even right
      area: turf.area(p.geometry),
      issue: p.tooTight ? 'Curve too tight for this plot depth' : plotIssue(turf.area(p.geometry), p.frontage, rules),
    }))
    // Respect the other roads, roundabouts and turning heads already on the map.
    const surfaces = others()
      .map((x) => (x.geometry.type === 'LineString' ? roadSurface(x as Feature<LineString>, Number(x.properties.attrs.width) || 0) : x.geometry.type === 'Polygon' ? turf.feature(x.geometry) : undefined))
      .filter((x): x is NonNullable<typeof x> => !!x)
    const kept = clearRoads(generated, surfaces, rules.minPlotArea ?? 0)
    s.addFeatures(kept.map((p) => makeFeature('plot', p.geometry, {
      plotNo: p.number, block, frontage: p.frontage, depth: p.depth, angle: p.angle, face: p.face, zoning: 'residential', ...(p.issue && { issue: p.issue }),
    }, `Plot ${p.number}`)))
    const bad = kept.filter((p) => p.issue).length
    s.notify(`Laid out ${kept.length} plots along ${f.properties.name} (block ${block}).${bad ? ` ${bad} fail validation (red).` : ''} Preliminary layout, not an approved design.`)
  }

  // Roads drawn after plots don't move them; this carves the corridor out of overlapping plots.
  const cutBack = () => {
    const surface = roadSurface(f as Feature<LineString>, width)
    if (!surface) return
    const hit = Object.values(s.features).filter((x) => x.properties.type === 'plot' && x.geometry.type === 'Polygon' && turf.booleanIntersects(x, surface))
    if (!hit.length) return s.notify('No plots overlap this road.')
    const rules = s.meta.settings
    const gen = hit.map((x) => ({ x, p: { geometry: x.geometry as Polygon, block: '', number: '', area: 0, frontage: 0, depth: 0, angle: 0, face: 'min' as const } }))
    const add: PlanFeature[] = []
    for (const { x, p } of gen) {
      const [kept] = clearRoads([p], [surface], rules.minPlotArea ?? 0)
      if (!kept) continue // nothing usable left; the plot is removed (undo restores it)
      const roads = [...others(), f]
      const { issue: _, ...a } = x.properties.attrs
      const attrs = { ...a, frontage: measureFrontage(kept.geometry, roads) }
      const issue = plotIssue(turf.area(kept.geometry), attrs.frontage, rules)
      add.push({ ...x, geometry: kept.geometry, properties: { ...x.properties, attrs: issue ? { ...attrs, issue } : attrs } })
    }
    s.replaceFeatures(hit.map((x) => x.id), add)
    s.select([f.id])
    s.notify(`Cut ${hit.length} plot(s) back from ${f.properties.name}; ${hit.length - add.length} removed entirely. Frontage re-measured.`)
  }

  const culDeSac = (end: 'start' | 'end') =>
    s.addFeatures([makeFeature('cul-de-sac', culDeSacGeom(line, end, headR), { radius: headR }, `Cul-de-sac (${f.properties.name})`)])

  const roundabouts = () => {
    const existing = Object.values(s.features).filter((x) => x.properties.type === 'roundabout').map((x) => turf.centroid(x).geometry.coordinates)
    const pts = junctionPoints(turf.feature(line), others().filter((x) => x.geometry.type === 'LineString') as Feature<LineString>[])
      .filter((p) => !existing.some((q) => turf.distance(p, q, { units: 'meters' }) < ringR))
    if (!pts.length) return s.notify('No junctions without a roundabout found on this road.')
    const island = Math.max(ringR - 8, 0)
    s.addFeatures(pts.map((p) => makeFeature('roundabout', roundaboutGeom(p, ringR, island), { radius: ringR, island })))
    s.notify(`Added ${pts.length} roundabout(s) at junctions of ${f.properties.name}.`)
  }

  return (
    <div className="section space-y-1.5">
      <div className="label">Road tools</div>
      <div className="flex flex-wrap items-center gap-1">
        <button className="btn border border-line" title="Round every bend with the usual radius for this road type (edit Curve radius to change it; 0 = sharp corners)" onClick={() => s.updateFeature(f.id, { attrs: { curveRadius: defaultCurve(String(f.properties.attrs.roadClass ?? '')) } })}>Round corners ({defaultCurve(String(f.properties.attrs.roadClass ?? ''))} m)</button>
        <span className="text-[10px] text-muted">Right-click the road to split it · select two roads to join them</span>
      </div>
      <div className="text-[11px] font-medium">Plots along this road</div>
      <div className="grid grid-cols-3 gap-1">
        <label className="text-muted">Width<input className="input" type="number" min={3} value={plotWidth} onChange={(e) => setPlotWidth(Math.max(3, +e.target.value))} /></label>
        <label className="text-muted">Depth<input className="input" type="number" min={3} value={plotDepth} onChange={(e) => setPlotDepth(Math.max(3, +e.target.value))} /></label>
        <label className="text-muted">Sides
          <select className="input" value={sides} onChange={(e) => setSides(e.target.value as AlongOptions['sides'])}>
            <option value="both">Both</option><option value="left">Left</option><option value="right">Right</option>
          </select>
        </label>
      </div>
      <button className="btn-primary" onClick={plotsAlong}>Generate plots along road</button>
      <p className="text-[10px] text-muted">Follows curves; draw a curved road for curvilinear layouts. Plots are cut back from other roads.</p>
      <button className="btn border border-line" onClick={cutBack}>Cut back overlapping plots</button>
      <div className="flex items-center gap-1 pt-1">
        <span className="text-muted">Turning head r</span>
        <input className="input !w-14" type="number" min={4} value={headR} onChange={(e) => setHeadR(Math.max(4, +e.target.value))} />
        <button className="btn border border-line" onClick={() => culDeSac('start')}>At start</button>
        <button className="btn border border-line" onClick={() => culDeSac('end')}>At end</button>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted">Roundabout r</span>
        <input className="input !w-14" type="number" min={8} value={ringR} onChange={(e) => setRingR(Math.max(8, +e.target.value))} />
        <button className="btn border border-line" onClick={roundabouts}>At junctions</button>
      </div>
    </div>
  )
}

/** Development-control checks for the selected plot or building: measured value vs limit. */
function ComplianceBox({ f, openDialog }: { f: PlanFeature; openDialog: (d: Dialog) => void }) {
  const features = useStore((s) => s.features)
  const ruleset = useStore((s) => s.meta.ruleset) ?? GENERIC_RULESET
  const settings = useStore((s) => s.meta.settings)
  const comp = complianceOf(features, ruleset, settings)
  const failed = new Set((comp.byId.get(f.id) ?? []).map((v) => v.code))
  const rows: [string, string, string | undefined, boolean][] = [] // label, value, limit, ok
  let zone: string | undefined
  if (f.properties.type === 'plot') {
    const m = comp.plots.get(f.id)
    zone = m?.zone
    const r = zone ? ruleset.rules[zone] : undefined
    if (m) {
      rows.push(['Buildings on plot', String(m.buildings.length), undefined, true])
      rows.push(['Floor area ratio', m.far.toFixed(2), r?.maxFAR?.toString(), !failed.has('far')])
      rows.push(['Ground coverage', `${m.coverage}%`, r?.maxCoverage !== undefined ? `${r.maxCoverage}%` : undefined, !failed.has('coverage')])
      rows.push(['Density', `${m.density} dw/ha`, r?.maxDensity !== undefined ? `${r.maxDensity}` : undefined, !failed.has('density')])
      rows.push(['Plot area', fmtArea(m.area), r?.minPlotArea !== undefined ? `≥ ${r.minPlotArea} m²` : undefined, !failed.has('minPlot')])
    }
  } else {
    const info = comp.buildings.get(f.id)
    zone = info?.zone
    const r = zone ? ruleset.rules[zone] : undefined
    const a = f.properties.attrs
    const plot = info?.plotId ? features[info.plotId] : undefined
    rows.push(['On plot', plot ? String(plot.properties.attrs.plotNo ?? plot.properties.name) : 'none', undefined, true])
    rows.push(['Height', `${a.height ?? 0} m`, r?.maxHeight !== undefined ? `${r.maxHeight} m` : undefined, !failed.has('height')])
    rows.push(['Floors', String(a.floors ?? 0), r?.maxFloors?.toString(), !failed.has('floors')])
    const cat = componentDef(f.properties.type).category || '—'
    rows.push(['Use', r ? `${cat}: ${failed.has('use') ? 'not permitted' : 'permitted'}` : cat, r ? '' : undefined, !failed.has('use')])
    if (plot) rows.push(['Setback (min)', info?.minSetback !== undefined ? `${info.minSetback.toFixed(1)} m` : 'outside plot', r?.setback ? `≥ ${r.setback} m` : undefined, !failed.has('setback') && !failed.has('outside')])
  }
  return (
    <div className="section space-y-1">
      <div className="flex items-center justify-between">
        <span className="label">Development controls</span>
        <button className="text-[10px] text-accent hover:underline" onClick={() => openDialog('zoning')}>edit rules</button>
      </div>
      <div className="text-[11px] text-muted">Zone: {zone ? ZONING[zone]?.label ?? zone : 'none (not checked)'}</div>
      {rows.map(([label, value, limit, ok]) => (
        <div key={label} className="grid grid-cols-[1fr_auto_auto] gap-2 text-[11px]">
          <span className="text-muted">{label}</span>
          <span className="font-mono">{value}{limit && <span className="text-muted"> / {limit}</span>}</span>
          <span className={limit === undefined ? 'text-muted' : ok ? 'text-[#43a047]' : 'text-bad'}>{limit === undefined ? '·' : ok ? '✓' : '✗'}</span>
        </div>
      ))}
      {(comp.byId.get(f.id) ?? []).map((v) => <div key={v.code} className="rounded border border-bad/50 bg-bad/10 px-2 py-0.5 text-[11px] text-bad">✗ {v.message}</div>)}
    </div>
  )
}

/** Infrastructure-network findings for the selected object (lines, facilities, unserved buildings). */
function NetworkIssues({ f }: { f: PlanFeature }) {
  const features = useStore((s) => s.features)
  const issues = networksOf(features).byId.get(f.id) ?? []
  const net = typeof f.properties.attrs.network === 'string' ? NETWORKS[f.properties.attrs.network] : undefined
  if (!issues.length && !net) return null
  return (
    <div className="section space-y-1">
      <div className="label">Network checks{net && <span className="normal-case"> · {net.label}</span>}</div>
      {issues.length ? issues.map((i, k) => <div key={k} className="rounded border border-bad/50 bg-bad/10 px-2 py-0.5 text-[11px] text-bad">✗ {i.message}</div>)
        : <div className="text-[11px] text-[#43a047]">✓ Connected, no conflicts found</div>}
    </div>
  )
}

function Estimates({ f, area, length }: { f: PlanFeature; area: number; length: number }) {
  const st = useStore((s) => s.meta.settings)
  const def = componentDef(f.properties.type)
  const { attrs } = f.properties
  const rows: [string, string][] = []
  if (def.layer === 'roads' && length) rows.push(['Construction cost', fmtMoney(length * Number(attrs.width || 0) * st.roadCostPerM2)])
  if (attrs.floors && area) rows.push(['Construction cost', fmtMoney(area * Number(attrs.floors) * st.buildingCostPerM2)])
  if (f.properties.type === 'plot' && attrs.zoning === 'residential') rows.push(['Dwellings', String(st.dwellingsPerPlot)], ['Residents', String(st.dwellingsPerPlot * st.personsPerDwelling)])
  if (!rows.length) return null
  return (
    <div className="section space-y-1">
      <div className="label">Estimates <span className="normal-case text-warn">(assumption-based)</span></div>
      {rows.map(([k, v]) => <KV key={k} k={k} v={v} />)}
    </div>
  )
}

function ProjectPanel() {
  const s = useStore()
  return (
    <div>
      <div className="section space-y-1.5">
        <div className="label">Project</div>
        <Row label="Name"><input className="input" value={s.meta.name} onChange={(e) => s.setMeta({ name: e.target.value })} /></Row>
        <KV k="Coordinate system" v="WGS 84 (EPSG:4326)" />
        <KV k="Measurements" v="Geodesic (ellipsoidal)" />
        <KV k="View centre" v={`${s.meta.center[1].toFixed(5)}, ${s.meta.center[0].toFixed(5)}`} />
        <KV k="Last saved" v={new Date(s.meta.updatedAt).toLocaleString()} />
        <p className="text-[11px] text-muted">Projected local CRS (UTM / national grids) <span className="planned">planned</span></p>
      </div>
      <PlotRulesPanel />
      <div className="section space-y-1 text-muted">
        <div className="label">Getting started</div>
        <ol className="list-decimal space-y-1 pl-4 text-[11px]">
          <li>Draw a development boundary (B) and click its first vertex to close it.</li>
          <li>Draw roads (R) — surfaces are generated from road width.</li>
          <li>Select the boundary → <b>Subdivide</b> to generate plots and local streets.</li>
          <li>Drag houses, parks and facilities from the Components panel.</li>
          <li>Check Analytics, toggle 3D, then Save (Ctrl+S) or Export.</li>
        </ol>
      </div>
    </div>
  )
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="grid grid-cols-[96px_1fr] items-center gap-2"><span className="text-muted">{label}</span>{children}</label>
)
const KV = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-2"><span className="text-muted">{k}</span><span className="font-mono text-[11px]">{v}</span></div>
)
