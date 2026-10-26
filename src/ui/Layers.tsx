import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, LocateFixed, Lock, LockOpen, Table2, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { zoomTo } from '../map/MapCanvas'
import { measure } from '../geo'
import { fmtArea, fmtLen } from './format'
import type { LayerKind } from '../model'

const KINDS: LayerKind[] = ['boundary', 'zoning', 'parcels', 'roads', 'buildings', 'green', 'facilities', 'utilities', 'annotations']

/** GIS-style layer manager. Top of list = drawn on top. */
export default function Layers() {
  const s = useStore()
  const [table, setTable] = useState<string | null>(null)
  const [newKind, setNewKind] = useState<LayerKind>('buildings')
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const f of Object.values(s.features)) c[f.properties.layerId] = (c[f.properties.layerId] ?? 0) + 1
    return c
  }, [s.features])

  return (
    <div className="text-xs">
      <div className="label px-3 pt-2">Basemap</div>
      <div className="px-3 pb-2 text-muted">Choose in toolbar · tiles © OpenStreetMap contributors</div>
      <div className="label px-3 py-1">Project layers</div>
      {[...s.layers].reverse().map((l) => (
        <div key={l.id} className={`group border-t border-line px-2 py-1.5 ${s.activeLayerId === l.id ? 'bg-accent/10' : ''}`}>
          <div className="flex items-center gap-1">
            <button className={`btn px-1 ${l.visible ? '' : 'text-muted'}`} onClick={() => s.updateLayer(l.id, { visible: !l.visible })} title={l.visible ? 'Hide layer' : 'Show layer'} aria-pressed={l.visible}>{l.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
            <button className="flex-1 truncate text-left" onClick={() => s.setActiveLayer(s.activeLayerId === l.id ? null : l.id)} title="Set as active layer for new objects of this kind">
              {l.name} <span className="text-muted">({counts[l.id] ?? 0})</span>
            </button>
            <button className={`btn px-1 ${l.locked ? 'text-warn' : 'text-muted'}`} onClick={() => s.updateLayer(l.id, { locked: !l.locked })} title={l.locked ? 'Locked — click to allow editing' : 'Lock to prevent editing'}>{l.locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
            <button className="btn px-1" onClick={() => s.moveLayer(l.id, 1)} title="Move up (draw above)" aria-label="Move layer up"><ChevronUp size={14} /></button>
            <button className="btn px-1" onClick={() => s.moveLayer(l.id, -1)} title="Move down (draw below)" aria-label="Move layer down"><ChevronDown size={14} /></button>
          </div>
          <div className="mt-1 flex items-center gap-1 pl-5">
            <input type="range" min={0} max={1} step={0.05} value={l.opacity} className="w-full min-w-0 flex-1 accent-[#00b8d4]" onChange={(e) => s.updateLayer(l.id, { opacity: +e.target.value })} title="Opacity" />
            <span className="w-8 text-right text-muted">{Math.round(l.opacity * 100)}%</span>
            <button className="btn px-1" onClick={() => setTable(table === l.id ? null : l.id)} title="Show a table of this layer's objects" aria-label="Attribute table"><Table2 size={14} /></button>
            <button className="btn px-1" onClick={() => zoomTo(Object.values(s.features).filter((f) => f.properties.layerId === l.id))} title="Zoom the map to this layer" aria-label="Zoom to layer"><LocateFixed size={14} /></button>
            <button className="btn px-1" disabled={!!counts[l.id]} onClick={() => s.removeLayer(l.id)} title={counts[l.id] ? 'Layer must be empty to remove' : 'Remove layer'} aria-label="Remove layer"><Trash2 size={14} /></button>
          </div>
          {table === l.id && <AttributeTable layerId={l.id} />}
        </div>
      ))}
      <div className="flex gap-1 border-t border-line p-2">
        <select className="input" value={newKind} onChange={(e) => setNewKind(e.target.value as LayerKind)}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button className="btn-primary shrink-0" onClick={() => s.addLayer(newKind, `New ${newKind} layer`)}>Add layer</button>
      </div>
      <p className="px-3 pb-3 text-[11px] text-muted">Click a layer name to make it the active target for new objects. Locked layers can't be selected or edited. Nested groups & filters: <span className="planned">planned</span></p>
    </div>
  )
}

function AttributeTable({ layerId }: { layerId: string }) {
  const s = useStore()
  const rows = Object.values(s.features).filter((f) => f.properties.layerId === layerId)
  if (!rows.length) return <div className="py-1 pl-5 text-muted">No objects</div>
  return (
    <div className="mt-1 max-h-56 overflow-auto rounded border border-line">
      <table className="w-full text-[10px]">
        <thead className="sticky top-0 bg-panel2 text-muted"><tr><th className="px-1 text-left">Name</th><th className="px-1 text-left">Type</th><th className="px-1 text-right">Size</th></tr></thead>
        <tbody>
          {rows.map((f) => {
            const m = measure(f)
            return (
              <tr key={f.id} onClick={() => { s.select([f.id]); zoomTo(f) }} className={`cursor-pointer hover:bg-panel2 ${s.selection.includes(f.id) ? 'text-accent' : ''} ${f.properties.attrs.issue ? 'text-bad' : ''}`}>
                <td className="truncate px-1">{f.properties.name}</td>
                <td className="px-1 text-muted">{f.properties.type}</td>
                <td className="px-1 text-right">{m.area ? fmtArea(m.area) : m.length ? fmtLen(m.length) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
