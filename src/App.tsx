import { lazy, Suspense, useEffect, useState } from 'react'
import MapCanvas from './map/MapCanvas'
import Toolbar, { ToolRail } from './ui/Toolbar'
import { ChartColumn, Layers as LayersIcon, Shapes, SlidersHorizontal } from 'lucide-react'
import Library from './ui/Library'
import Layers from './ui/Layers'
import Inspector from './ui/Inspector'
import Analytics from './ui/Analytics'
import ProjectDialog from './ui/ProjectDialog'
import SubdivideDialog from './ui/SubdivideDialog'
import ZoningDialog from './ui/ZoningDialog'
import PrintDialog from './ui/PrintDialog'
import WizardDialog from './ui/WizardDialog'
import { clearHistory, redo, toProject, undo, useStore, type Tool } from './store'
import { linkedFile, listProjects, loadProject, loadRecovery, saveProject, saveRecovery, saveToFile } from './persist'
import { saveServerProject, serverUp } from './api'

export type Dialog = 'project' | 'subdivide' | 'zoning' | 'print' | 'wizard' | null

/** Saves to IndexedDB, the linked project file on disk (asked for when `pickFile`), then (best effort) the server. Returns a status line for the user. */
export async function saveCurrent(pickFile = false): Promise<string> {
  const saved = await saveProject(toProject(useStore.getState()))
  useStore.setState((s) => ({ meta: { ...s.meta, updatedAt: saved.updatedAt } }))
  useStore.getState().markSaved()
  localStorage.setItem('urbanforge:last', saved.id)
  let where = 'this browser'
  if (pickFile || (await linkedFile(saved.id))) {
    try { const f = await saveToFile(saved, pickFile); if (f) where = `${f} and this browser` }
    catch (e) { where = `this browser (file save failed: ${(e as Error).message})` }
  }
  try {
    const { invalid } = await saveServerProject(saved)
    return `Project saved to ${where} and the server.${invalid.length ? ` PostGIS flags ${invalid.length} invalid geometr${invalid.length > 1 ? 'ies' : 'y'}: ${invalid.slice(0, 3).map((i) => `${useStore.getState().features[i.id]?.properties.name ?? i.id} (${i.reason})`).join('; ')}.` : ''}`
  } catch (e) {
    return (await serverUp()) ? `Saved to ${where}; server save failed: ${(e as Error).message}` : `Project saved to ${where} (server not running).`
  }
}

// Three.js is only downloaded when the 3D view is first opened.
const CityView = lazy(() => import('./three/CityView'))

const KEY_TOOLS: Record<string, Tool> = { v: 'select', h: 'pan', b: 'boundary', z: 'zone', p: 'plot', r: 'road', u: 'utility', o: 'point', m: 'measure', k: 'cut' }

export default function App() {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [left, setLeft] = useState<'library' | 'layers'>('library')
  const [right, setRight] = useState<'props' | 'stats'>('props')
  const notice = useStore((s) => s.notice)
  const view3d = useStore((s) => s.view3d)
  const setNotice = useStore((s) => s.notify)

  // Startup: recover unsaved work first, else reopen the last project, else offer the project dialog.
  useEffect(() => {
    (async () => {
      const rec = await loadRecovery()
      if (rec) {
        useStore.getState().load(rec)
        useStore.setState({ dirty: true })
        setNotice(`Recovered unsaved changes to “${rec.name}” from ${new Date(rec.updatedAt).toLocaleString()}. Save (Ctrl+S) to keep them.`)
        return
      }
      const last = localStorage.getItem('urbanforge:last')
      const p = last ? await loadProject(last) : undefined
      if (p) useStore.getState().load(p)
      else if ((await listProjects()).length) setDialog('project')
      clearHistory()
    })()
  }, [])

  // Autosave working copy to the recovery slot; warn before closing with unsaved changes.
  useEffect(() => {
    let t: number | undefined
    const unsub = useStore.subscribe((s, p) => {
      if (!s.dirty || (s.features === p.features && s.layers === p.layers && s.meta === p.meta && s.dirty === p.dirty)) return
      clearTimeout(t)
      t = window.setTimeout(() => { if (useStore.getState().dirty) saveRecovery(toProject(useStore.getState())) }, 800)
    })
    const warn = (e: BeforeUnloadEvent) => { if (useStore.getState().dirty) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { unsub(); window.removeEventListener('beforeunload', warn) }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]') || document.pointerLockElement) return // typing, or walking in 3D
      const s = useStore.getState()
      const k = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
      else if (mod && k === 'y') { e.preventDefault(); redo() }
      else if (mod && k === 's') { e.preventDefault(); saveCurrent().then(setNotice) }
      else if (mod && k === 'c') s.copy()
      else if (mod && k === 'v') s.paste()
      else if (mod && k === 'd') { e.preventDefault(); s.duplicate() }
      else if (e.key === 'Delete' || e.key === 'Backspace') s.deleteSelected()
      else if (!mod && (e.code === 'BracketLeft' || e.code === 'BracketRight') && s.selection.length) { e.preventDefault(); s.rotateFeatures(s.selection, (e.code === 'BracketLeft' ? -1 : 1) * (e.shiftKey ? 1 : 15)) }
      else if (!mod && k === 's') { const on = !(s.snap.vertices || s.snap.edges); s.setSnap({ vertices: on, edges: on }); setNotice(`Vertex & edge snapping ${on ? 'on' : 'off'}.`) }
      else if (e.key === 'Escape') { s.select([]); s.setTool('select'); setDialog(null) }
      else if (!mod && !e.altKey && KEY_TOOLS[k]) s.setTool(e.shiftKey && k === 'm' ? 'measure-area' : KEY_TOOLS[k])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tab = (on: boolean) => `flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium border-b-2 ${on ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`

  return (
    <div className="flex h-full flex-col bg-app text-xs text-ink">
      <Toolbar openDialog={setDialog} notify={setNotice} />
      {notice && (
        <div className="flex items-center gap-3 border-b border-line bg-accent/10 px-3 py-1 text-[11px]">
          <span className="flex-1">{notice}</span>
          <button className="btn" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 min-w-48 max-w-[480px] resize-x flex-col overflow-hidden border-r border-line bg-panel">
          <div className="flex border-b border-line">
            <button className={tab(left === 'library')} onClick={() => setLeft('library')}><Shapes size={13} />Components</button>
            <button className={tab(left === 'layers')} onClick={() => setLeft('layers')}><LayersIcon size={13} />Layers</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{left === 'library' ? <Library /> : <Layers />}</div>
        </aside>
        <ToolRail />
        <main className="relative min-w-0 flex-1"><MapCanvas />{view3d && <Suspense fallback={<div className="absolute inset-0 z-10 grid place-items-center bg-app/80 text-muted">Loading 3D view…</div>}><CityView /></Suspense>}</main>
        <aside className="flex w-80 min-w-60 flex-col overflow-hidden border-l border-line bg-panel">
          <div className="flex border-b border-line">
            <button className={tab(right === 'props')} onClick={() => setRight('props')}><SlidersHorizontal size={13} />Properties</button>
            <button className={tab(right === 'stats')} onClick={() => setRight('stats')}><ChartColumn size={13} />Analytics</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{right === 'props' ? <Inspector openDialog={setDialog} /> : <Analytics />}</div>
        </aside>
      </div>
      <StatusBar />
      {dialog === 'project' && <ProjectDialog close={() => setDialog(null)} notify={setNotice} />}
      {dialog === 'subdivide' && <SubdivideDialog close={() => setDialog(null)} notify={setNotice} />}
      {dialog === 'zoning' && <ZoningDialog close={() => setDialog(null)} />}
      {dialog === 'print' && <PrintDialog close={() => setDialog(null)} notify={setNotice} />}
      {dialog === 'wizard' && <WizardDialog close={() => setDialog(null)} notify={setNotice} />}
    </div>
  )
}

const HINT: Record<Tool, string> = {
  select: 'Click to select · Shift+click multi-select · drag to move · drag the round knob or [ ] to rotate (Shift: free / 1°) · drag a corner to resize · right-click for menu',
  pan: 'Drag to pan · scroll to zoom · right-drag to rotate/tilt',
  boundary: 'Click to add boundary vertices · click first point to close',
  zone: 'Draw a zoning polygon · set its category in Properties',
  plot: 'Draw a plot polygon manually',
  road: 'Click to add centreline points · double-click / click last point to finish',
  utility: 'Draw a utility line · set the network in Properties',
  point: 'Click to place a point / utility node',
  measure: 'Click to measure distance · finish on last point',
  'measure-area': 'Click to measure area · close the polygon to finish',
  cut: 'Draw a line across plots to split them (line is extended past its ends) · finish on the last point',
}

function StatusBar() {
  const tool = useStore((s) => s.tool)
  const n = useStore((s) => Object.keys(s.features).length)
  const sel = useStore((s) => s.selection.length)
  const dirty = useStore((s) => s.dirty)
  return (
    <footer className="flex h-6 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted">
      <span className="text-ink">{tool}</span>
      <span className="flex-1 truncate">{HINT[tool]}</span>
      <span>{n} objects · {sel} selected</span>
      <span>CRS EPSG:4326 · geodesic measurements</span>
      <span className={dirty ? 'text-warn' : ''}>{dirty ? '● unsaved (auto-recovery on)' : 'saved'}</span>
    </footer>
  )
}
