import { useRef } from 'react'
import { Box, Cable, Droplets, ChevronDown, Download, FolderOpen, Grid2x2, Hand, HardDrive, LayoutGrid, Magnet, Map as MapIcon, MapPin, Moon, MousePointer2, Pentagon, Redo2, Route, Ruler, Save, Scale, Scissors, Square, SquareDashed, Undo2, Upload, Wand2, type LucideIcon } from 'lucide-react'
import * as turf from '@turf/turf'
import { useStore as useZustand } from 'zustand'
import { makeFeature, redo, toProject, undo, useStore, type Tool } from '../store'
import { BASEMAPS, type BasemapId } from '../model'
import { download, parseProject, plotScheduleCSV, serializeProject, toGeoJSON } from '../persist'
// Format libraries (KML, Shapefile, DXF…) load on first import/export, keeping the initial bundle small.
const formats = () => import('../formats')
// utilities.ts uses the road graph from three/drive.ts: load it on demand so three stays out of the main bundle
const utilities = () => import('../utilities')
const IMPORT_ACCEPT = ['.geojson,.json,.kml,.kmz,.zip,.csv,.dxf', ...[...GDAL_VECTOR, ...GDAL_RASTER].map((x) => '.' + x)].join(',')
import { mapInstance, zoomTo } from '../map/MapCanvas'
import { complianceOf } from '../zoning'
import { complianceCSV, planningReport } from '../report'
import { frame, plotAxis, stats } from '../geo'
import { saveCurrent, type Dialog } from '../App'
import { GDAL_RASTER, GDAL_VECTOR, gdalExportGpkg, serverUp, utmEpsg } from '../api'

const TOOLS: { id: Tool; short: string; label: string; key: string; icon: LucideIcon; group: string }[] = [
  { id: 'select', short: 'Select', label: 'Select & edit — click an object, drag to move', key: 'V', icon: MousePointer2, group: 'Navigate' },
  { id: 'pan', short: 'Pan', label: 'Pan the map — drag to move around', key: 'H', icon: Hand, group: 'Navigate' },
  { id: 'boundary', short: 'Boundary', label: 'Draw the development boundary (site edge)', key: 'B', icon: Pentagon, group: 'Draw' },
  { id: 'zone', short: 'Zone', label: 'Draw a zoning area (residential, commercial…)', key: 'Z', icon: Grid2x2, group: 'Draw' },
  { id: 'plot', short: 'Plot', label: 'Draw a plot / parcel', key: 'P', icon: Square, group: 'Draw' },
  { id: 'road', short: 'Road', label: 'Draw a road along its centreline', key: 'R', icon: Route, group: 'Draw' },
  { id: 'utility', short: 'Utility', label: 'Draw a utility line (water, sewer, power…)', key: 'U', icon: Cable, group: 'Draw' },
  { id: 'point', short: 'Point', label: 'Place a point (hydrant, valve, node…)', key: 'O', icon: MapPin, group: 'Draw' },
  { id: 'cut', short: 'Cut', label: 'Cut plots in two along a line', key: 'K', icon: Scissors, group: 'Edit' },
  { id: 'measure', short: 'Distance', label: 'Measure a distance', key: 'M', icon: Ruler, group: 'Measure' },
  { id: 'measure-area', short: 'Area', label: 'Measure an area', key: 'Shift+M', icon: SquareDashed, group: 'Measure' },
]

/** Vertical tool strip beside the map: every tool shows its icon and its name. */
export function ToolRail() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const groups = [...new Set(TOOLS.map((t) => t.group))]
  return (
    <nav className="flex w-[68px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel pb-2" aria-label="Tools">
      {groups.map((g) => (
        <div key={g} className="border-b border-line/60 px-1 pb-1">
          <div className="pb-0.5 pt-2 text-center text-[9px] font-semibold uppercase tracking-wider text-muted">{g}</div>
          {TOOLS.filter((t) => t.group === g).map((t) => (
            <button key={t.id} onClick={() => setTool(t.id)} title={`${t.label}  (shortcut: ${t.key})`} aria-pressed={tool === t.id}
              className={`flex w-full flex-col items-center gap-0.5 rounded py-1.5 text-[10px] leading-tight ${tool === t.id ? 'bg-accent/20 text-accent' : 'text-ink hover:bg-panel2'}`}>
              <t.icon size={18} strokeWidth={1.75} />
              <span>{t.short}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

const Sep = () => <div className="mx-1 h-5 w-px bg-line" />

export default function Toolbar({ openDialog, notify }: { openDialog: (d: Dialog) => void; notify: (m: string) => void }) {
  const s = useStore()
  const past = useZustand(useStore.temporal, (t) => t.pastStates.length)
  const future = useZustand(useStore.temporal, (t) => t.futureStates.length)
  const file = useRef<HTMLInputElement>(null)
  const sel = s.selection.length === 1 ? s.features[s.selection[0]] : undefined
  const canSubdivide = sel?.geometry.type === 'Polygon' && ['boundary', 'zone'].includes(sel.properties.type)
  const slug = s.meta.name.replace(/[^\w-]+/g, '_')

  const report = (what: string, r: { features: unknown[]; rejected: string[]; notes: string[] }) =>
    notify(`Imported ${r.features.length} feature(s) from ${what}${r.rejected.length ? `; ${r.rejected.length} rejected (${r.rejected.slice(0, 3).join('; ')})` : ''}.${r.notes.length ? ' ' + r.notes.join(' ') : ''}`)

  const onImport = async (f: File) => {
    try {
      const isJson = /\.(geo)?json$/i.test(f.name)
      const text = isJson ? await f.text() : ''
      const json = isJson ? JSON.parse(text) : null
      if (json?.format === 'urbanforge') {
        if (s.dirty) return notify('Save or export the current project before opening another file (unsaved changes would be replaced).')
        const { project, rejected } = parseProject(text)
        s.load(project)
        useStore.setState({ dirty: true })
        notify(`Opened ${f.name}${rejected.length ? ` — ${rejected.length} invalid feature(s) skipped: ${rejected.slice(0, 3).join('; ')}` : ''}. Save to store it in this browser.`)
      } else {
        const r = await (await formats()).importFile(f, s.layerForFeature, s.meta.center)
        s.addFeatures(r.features)
        zoomTo(r.features)
        report(f.name, r)
      }
    } catch (e) {
      notify(`Import failed: ${(e as Error).message}`)
    }
  }

  const exportGpkg = async (srs: string) => {
    try { download(`${slug}${srs === 'EPSG:4326' ? '' : '-' + srs.replace(':', '')}.gpkg`, await gdalExportGpkg(toGeoJSON(Object.values(s.features), s.layers), srs)) }
    catch (e) { notify(`GeoPackage export failed: ${(e as Error).message}${(await serverUp()) ? '' : ' — start the backend with docker compose up -d'}`) }
  }

  // OpenStreetMap features for the current view (Overpass API); kept to small areas out of courtesy.
  const layPipes = async () => {
    const { layWaterSewer } = await utilities()
    const st = useStore.getState(), f = frame(st.meta.center) // after the await: a second click sees the first click's pipes
    const drafts = layWaterSewer(Object.values(st.features), (p) => f.toLocal(p) as [number, number], f.toGeo)
    if (!drafts.length) return notify('Every street already has water and sewer pipes (or there are no streets).')
    st.addFeatures(drafts.map((d) => makeFeature(d.type, d.geometry, d.attrs, d.name)))
    const n = (t: string) => drafts.filter((d) => d.type === t).length
    notify(`Laid ${n('water-main')} water mains and ${n('sewer')} sewers${n('water-tank') ? ', a water tank' : ''}${n('treatment') ? ', a treatment plant' : ''}${n('hydrant') ? `, ${n('hydrant')} hydrants and ${n('manhole')} manholes at dead ends` : ''}. A preliminary layout: check it, edit freely; Ctrl+Z removes it. Open 3D → Underground to see the flow.`)
  }
  const importOSMView = async () => {
    const map = mapInstance
    if (!map) return
    const b = map.getBounds()
    const bounds: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    const km2 = turf.area(turf.bboxPolygon(bounds)) / 1e6
    if (km2 > 4) return notify(`The view covers ${km2.toFixed(1)} km²; zoom in to 4 km² or less to import OpenStreetMap data.`)
    notify('Downloading OpenStreetMap data for the current view…')
    try { const r = await (await formats()).importOSM(bounds, s.layerForFeature); s.addFeatures(r.features); report('OpenStreetMap', r) }
    catch (e) { notify(`OpenStreetMap import failed: ${(e as Error).message}`) }
  }

  const exportPNG = () => {
    const map = mapInstance
    if (!map) return
    map.once('render', () => {
      map.getCanvas().toBlob((b) => b ? download(`${slug}.png`, b) : notify('PNG export failed (canvas unavailable).'))
    })
    map.triggerRepaint()
  }

  // The report embeds a snapshot of the current map view.
  const exportReport = () => {
    const map = mapInstance
    const build = (png?: string) => {
      const st = useStore.getState()
      const project = toProject(st)
      const html = planningReport(project, stats(Object.values(st.features), st.layers, st.meta.settings), complianceOf(st.features, st.meta.ruleset, st.meta.settings), png)
      download(`${slug}-report.html`, html, 'text/html')
    }
    if (!map) return build()
    map.once('render', () => { try { build(map.getCanvas().toDataURL('image/png')) } catch { build() } })
    map.triggerRepaint()
  }

  return (
    <header className="flex h-10 items-center gap-0.5 whitespace-nowrap border-b border-line bg-panel px-2 [&_.btn]:shrink-0 [&_.btn]:text-[13px] [&_select]:text-[13px]">
      <span className="mr-2 font-semibold tracking-tight text-accent">UrbanForge</span>
      <input className="input w-44 !bg-transparent font-medium" value={s.meta.name} onChange={(e) => s.setMeta({ name: e.target.value })} aria-label="Project name" />
      <button className="btn" onClick={() => openDialog('project')} title="Create a new project or open a saved one"><FolderOpen size={14} />Projects</button>
      <button className="btn" onClick={() => saveCurrent().then(notify)} title={s.dirty ? 'Save — you have unsaved changes (Ctrl+S)' : 'Save (Ctrl+S)'}>
        <Save size={14} />Save{s.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-label="unsaved changes" />}
      </button>
      <button className="btn" onClick={() => saveCurrent(true).then(notify)} title="Save the project as a file on your computer; later saves (Ctrl+S) update that file"><HardDrive size={14} />Save to file…</button>
      <Sep />
      <button className="btn" disabled={!past} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={15} /></button>
      <button className="btn" disabled={!future} onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={15} /></button>
      <Sep />
      <button className="btn" disabled={!canSubdivide} onClick={() => openDialog('subdivide')} title={canSubdivide ? 'Split the selected area into plots and streets' : 'Select a boundary or zone first, then subdivide it into plots'}><LayoutGrid size={14} />Subdivide</button>
      <SnapMenu />
      <button className="btn" onClick={() => openDialog('zoning')} title="Development controls per zone: max floors, coverage, setbacks…"><Scale size={14} />Zoning rules</button>
      <button className="btn" onClick={() => openDialog('wizard')} title="Generate master-plan layouts automatically from a brief"><Wand2 size={14} />Plan wizard</button>
      <button className="btn" onClick={layPipes} title="Lay a water main and a sewer under every street (plus a water tank and treatment plant if missing); preliminary"><Droplets size={14} />Lay pipes</button>
      <div className="flex-1" />
      <input ref={file} type="file" accept={IMPORT_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = '' }} />
      <details className="relative">
        <summary className="btn cursor-pointer list-none" title="Bring in GIS / CAD data"><Upload size={14} />Import<ChevronDown size={12} /></summary>
        <div className="absolute right-0 z-30 mt-1 w-72 rounded border border-line bg-panel py-1 shadow-xl" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
          <MenuItem onClick={() => file.current?.click()}>From file — GeoJSON, KML/KMZ, Shapefile (.zip), CSV, DXF, project; GeoPackage, GeoTIFF/DEM via server</MenuItem>
          <MenuItem onClick={importOSMView}>OpenStreetMap data for the current view</MenuItem>
          <MenuItem disabled>DWG<span className="planned">needs ODA converter</span></MenuItem>
        </div>
      </details>
      <details className="relative">
        <summary className="btn cursor-pointer list-none" title="Save the plan as files, images or a report"><Download size={14} />Export<ChevronDown size={12} /></summary>
        <div className="absolute right-0 z-30 mt-1 w-60 rounded border border-line bg-panel py-1 shadow-xl" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
          <MenuItem onClick={() => download(`${slug}.urbanforge.json`, serializeProject(toProject(s)))}>Project file (.urbanforge.json)</MenuItem>
          <MenuItem onClick={() => download(`${slug}.geojson`, JSON.stringify(toGeoJSON(Object.values(s.features), s.layers)), 'application/geo+json')}>All layers — GeoJSON</MenuItem>
          <MenuItem onClick={() => download(`${slug}-plots.csv`, plotScheduleCSV(Object.values(s.features)), 'text/csv')}>Plot schedule — CSV</MenuItem>
          <MenuItem onClick={exportPNG}>Map image — PNG</MenuItem>
          <MenuItem onClick={exportReport}>Planning report — HTML (printable)</MenuItem>
          <MenuItem onClick={() => download(`${slug}-compliance.csv`, complianceCSV(complianceOf(s.features, s.meta.ruleset, s.meta.settings).violations, s.features), 'text/csv')}>Compliance findings — CSV</MenuItem>
          <MenuItem onClick={async () => download(`${slug}.kml`, (await formats()).toKML(Object.values(s.features), s.layers, s.meta.name), 'application/vnd.google-earth.kml+xml')}>All layers — KML (Google Earth)</MenuItem>
          <MenuItem onClick={async () => download(`${slug}-shapefile.zip`, new Blob([await (await formats()).toShapefileZip(Object.values(s.features), s.layers)], { type: 'application/zip' }))}>All layers — Shapefile (.zip, WGS 84)</MenuItem>
          <MenuItem onClick={async () => download(`${slug}.csv`, (await formats()).toCSV(Object.values(s.features), s.layers), 'text/csv')}>All layers — CSV with WKT geometry</MenuItem>
          <MenuItem onClick={async () => download(`${slug}.dxf`, (await formats()).toDXF(Object.values(s.features), s.layers, s.meta.center), 'application/dxf')}>CAD drawing — DXF (metres from project centre)</MenuItem>
          <MenuItem onClick={() => openDialog('print')}>Print layout… (paper, scale, legend, title block)</MenuItem>
          <MenuItem onClick={() => exportGpkg('EPSG:4326')}>All layers — GeoPackage (WGS 84, via server)</MenuItem>
          <MenuItem onClick={() => exportGpkg(utmEpsg(s.meta.center))}>All layers — GeoPackage ({utmEpsg(s.meta.center)} UTM metres, via server)</MenuItem>
          <MenuItem disabled>DWG<span className="planned">needs ODA converter</span></MenuItem>
        </div>
      </details>
      <Sep />
      <MapIcon size={14} className="text-muted" aria-hidden />
      <select className="input !w-32" title="Background map" value={s.meta.basemap} onChange={(e) => s.setMeta({ basemap: e.target.value as BasemapId })} aria-label="Basemap">
        {BASEMAPS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
      </select>
      <button className={`btn ${s.view3d ? 'btn-on' : ''}`} onClick={() => s.setView3d(!s.view3d)} title={s.view3d ? 'Back to the 2D map' : 'Open the 3D city view (same data)'}><Box size={14} />3D view</button>
      <button className="btn" onClick={() => document.documentElement.classList.toggle('light')} title="Switch light / dark theme" aria-label="Switch light or dark theme"><Moon size={15} /></button>
    </header>
  )
}

function MenuItem({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return <button disabled={disabled} onClick={onClick} className="flex w-full items-center px-3 py-1.5 text-left hover:bg-panel2 disabled:opacity-50">{children}</button>
}

function SnapMenu() {
  const snap = useStore((s) => s.snap)
  const setSnap = useStore((s) => s.setSnap)
  const on = snap.vertices || snap.edges || snap.grid
  const sel = useStore((s) => (s.selection.length === 1 ? s.features[s.selection[0]] : undefined))
  // street axis of the selection, clockwise from east, normalised to [0, 180)
  const axis = sel?.geometry.type === 'Polygon' ? plotAxis(sel.geometry, sel.properties.attrs)
    : sel?.geometry.type === 'LineString' ? turf.bearing(sel.geometry.coordinates[0], sel.geometry.coordinates[1]) - 90 : undefined
  const norm = axis === undefined ? undefined : Math.round(((axis % 180) + 180) % 180)
  const box = (k: 'vertices' | 'edges' | 'grid', label: string) => (
    <label className="flex items-center gap-2 px-3 py-1 hover:bg-panel2">
      <input type="checkbox" checked={snap[k]} onChange={(e) => setSnap({ [k]: e.target.checked })} />{label}
    </label>
  )
  return (
    <details className="relative">
      <summary className={`btn cursor-pointer list-none ${on ? 'btn-on' : ''}`} title="Snapping — make new points stick to corners, edges or a grid (S toggles)"><Magnet size={14} />Snap<ChevronDown size={12} /></summary>
      <div className="absolute left-0 z-30 mt-1 w-56 rounded border border-line bg-panel py-1 shadow-xl">
        {box('vertices', 'Vertices')}
        {box('edges', 'Edges & centrelines')}
        {box('grid', 'Grid')}
        <label className="flex items-center gap-2 px-3 py-1">
          <span className="text-muted">Grid angle</span>
          <input className="input !w-16" type="number" step={1} value={snap.gridAngle}
            onChange={(e) => setSnap({ gridAngle: ((+e.target.value % 180) + 180) % 180 })} />
          <span className="text-muted">°</span>
          <button className="btn border border-line" disabled={norm === undefined} onClick={() => norm !== undefined && setSnap({ gridAngle: norm })} title="Align the grid with the selected plot, zone or road">Match selection</button>
        </label>
        <label className="flex items-center gap-2 px-3 py-1">
          <span className="text-muted">Grid size</span>
          <input className="input !w-16" type="number" min={0.5} step={0.5} value={snap.gridSize}
            onChange={(e) => +e.target.value > 0 && setSnap({ gridSize: +e.target.value })} />
          <span className="text-muted">m</span>
        </label>
        <p className="px-3 pt-1 text-[10px] text-muted">Applies while drawing and dragging vertices. Vertices win over edges; the grid is used when nothing is within 12 px. Hidden layers are ignored.</p>
      </div>
    </details>
  )
}
