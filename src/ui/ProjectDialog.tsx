import { useEffect, useState } from 'react'
import { newProject } from '../model'
import { clearHistory, useStore } from '../store'
import { canLinkFiles, clearRecovery, deleteProject, listProjects, loadProject, openFromFile, saveProject, type ProjectSummary } from '../persist'
import { deleteServerProject, listServerProjects, loadServerProject } from '../api'
import { mapInstance } from '../map/MapCanvas'
import { saveCurrent } from '../App'
import { searchPlace, type Place } from '../geocode'
import { HardDrive, Search } from 'lucide-react'

export default function ProjectDialog({ close, notify }: { close: () => void; notify: (m: string) => void }) {
  const dirty = useStore((s) => s.dirty)
  const currentId = useStore((s) => s.meta.id)
  const [list, setList] = useState<ProjectSummary[]>([])
  const [name, setName] = useState('New town')
  const c = mapInstance?.getCenter()
  const [lat, setLat] = useState(c ? +c.lat.toFixed(5) : 24.8607)
  const [lng, setLng] = useState(c ? +c.lng.toFixed(5) : 67.0011)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [searching, setSearching] = useState(false)
  const [confirm, setConfirm] = useState<(() => void) | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const [server, setServer] = useState<ProjectSummary[] | null>(null) // null = server not reachable
  const refreshServer = () => listServerProjects().then(setServer, () => setServer(null))
  useEffect(() => { listProjects().then(setList); refreshServer() }, [])

  // Replacing the open project must never discard unsaved work silently.
  const guard = (fn: () => void) => () => (dirty ? setConfirm(() => fn) : fn())

  const open = async (id: string, from: 'local' | 'server' = 'local') => {
    let p = from === 'local' ? await loadProject(id) : await loadServerProject(id).catch((e) => { notify(`Could not load from server: ${e.message}`); return undefined })
    if (!p) return from === 'local' && notify('Project not found in browser storage.')
    if (from === 'server') p = await saveProject(p) // keep an offline copy; reopening on startup reads IndexedDB
    await clearRecovery()
    useStore.getState().load(p); clearHistory()
    localStorage.setItem('urbanforge:last', id)
    notify(`Opened “${p.name}”.`); close()
  }
  const openFile = async () => {
    try {
      const r = await openFromFile()
      if (!r) return
      const p = await saveProject(r.project) // browser copy too, so it reopens on startup and shows in the list
      await clearRecovery()
      useStore.getState().load(p); clearHistory()
      localStorage.setItem('urbanforge:last', p.id)
      notify(`Opened ${r.name}${r.rejected.length ? ` — ${r.rejected.length} invalid feature(s) skipped: ${r.rejected.slice(0, 3).join('; ')}` : ''}. Save updates this file.`); close()
    } catch (e) { notify(`Could not open file: ${(e as Error).message}`) }
  }
  const create = async () => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return notify('Enter a valid latitude/longitude.')
    await clearRecovery()
    useStore.getState().load(newProject(name || 'Untitled project', [lng, lat], 15)); clearHistory()
    await saveCurrent()
    notify(`Created “${name}”. Draw a development boundary (B) to begin.`); close()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[560px] rounded-lg border border-line bg-panel shadow-2xl">
        <div className="border-b border-line px-4 py-2 text-sm font-medium">Projects</div>
        {confirm ? (
          <div className="space-y-3 p-4">
            <p className="text-warn">The current project has unsaved changes.</p>
            <div className="flex gap-2">
              <button className="btn-primary" onClick={async () => { await saveCurrent(); confirm() }}>Save, then continue</button>
              <button className="btn border border-bad/50 text-bad" onClick={() => confirm()}>Discard changes & continue</button>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 divide-x divide-line">
            <div className="space-y-2 p-4">
              <div className="label">New project</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
              <form className="flex gap-1" onSubmit={async (e) => {
                e.preventDefault(); if (!query.trim()) return
                setSearching(true)
                try { const r = await searchPlace(query); setResults(r); if (!r.length) notify('No places found.') }
                catch (err) { notify(`${(err as Error).message} — enter latitude/longitude instead.`) }
                finally { setSearching(false) }
              }}>
                <input className="input flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find place or paste lat, lng" />
                <button className="btn" disabled={searching} title="Search location"><Search size={14} /></button>
              </form>
              {results.length > 0 && (
                <ul className="max-h-32 overflow-y-auto rounded border border-line">
                  {results.map((r, i) => (
                    <li key={i}><button className="w-full truncate px-2 py-1 text-left text-[11px] hover:bg-panel2" title={r.name}
                      onClick={() => { setLat(+r.lat.toFixed(5)); setLng(+r.lng.toFixed(5)); setResults([]); mapInstance?.flyTo({ center: [r.lng, r.lat], zoom: 14 }) }}>{r.name}</button></li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label className="text-muted">Latitude<input className="input" type="number" step="any" value={lat} onChange={(e) => setLat(+e.target.value)} /></label>
                <label className="text-muted">Longitude<input className="input" type="number" step="any" value={lng} onChange={(e) => setLng(+e.target.value)} /></label>
              </div>
              <p className="text-[10px] text-muted">Defaults to the current map centre. Then use <b>Plan wizard…</b> to generate a layout. Place search © OpenStreetMap (Nominatim).</p>
              <button className="btn-primary" onClick={guard(create)}>Create project</button>
            </div>
            <div className="p-4">
              {canLinkFiles && <button className="btn mb-3 w-full justify-center border border-line" onClick={guard(openFile)} title="Open a .urbanforge.json project from your computer; Save then updates that file"><HardDrive size={14} />Open project file…</button>}
              <div className="label mb-2">Saved in this browser</div>
              {!list.length && <div className="text-muted">No saved projects yet.</div>}
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {list.map((p) => (
                  <li key={p.id} className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-panel2">
                    <button className="flex-1 text-left" onClick={guard(() => open(p.id))}>
                      <div className={p.id === currentId ? 'text-accent' : ''}>{p.name}</div>
                      <div className="text-[10px] text-muted">{p.featureCount} objects · {new Date(p.updatedAt).toLocaleString()}</div>
                    </button>
                    {confirmDelete === p.id
                      ? <button className="btn text-bad" onClick={async () => { await deleteProject(p.id); setList(await listProjects()); setConfirmDelete(null) }}>Confirm delete</button>
                      : <button className="btn text-muted opacity-0 group-hover:opacity-100" disabled={p.id === currentId} onClick={() => setConfirmDelete(p.id)}>Delete</button>}
                  </li>
                ))}
              </ul>
              <div className="label mb-2 mt-4">On the server</div>
              {server === null ? <div className="text-[10px] text-muted">Server not running — <code>docker compose up -d</code> to sync projects.</div>
                : !server.length ? <div className="text-muted">Nothing saved on the server yet (Save uploads the open project).</div> : (
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {server.map((p) => (
                    <li key={p.id} className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-panel2">
                      <button className="flex-1 text-left" onClick={guard(() => open(p.id, 'server'))}>
                        <div className={p.id === currentId ? 'text-accent' : ''}>{p.name}</div>
                        <div className="text-[10px] text-muted">{p.featureCount} objects · {new Date(p.updatedAt).toLocaleString()}</div>
                      </button>
                      {confirmDelete === 'srv:' + p.id
                        ? <button className="btn text-bad" onClick={async () => { await deleteServerProject(p.id).catch((e) => notify(e.message)); await refreshServer(); setConfirmDelete(null) }}>Delete from server</button>
                        : <button className="btn text-muted opacity-0 group-hover:opacity-100" onClick={() => setConfirmDelete('srv:' + p.id)}>Delete</button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-between border-t border-line px-4 py-2 text-[10px] text-muted">
          <span>Saved in this browser (IndexedDB) and, when running, the UrbanForge server. Accounts & collaboration <span className="planned">planned</span></span>
          <button className="btn" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  )
}
