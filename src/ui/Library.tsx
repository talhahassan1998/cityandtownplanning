import { useEffect, useMemo, useState } from 'react'
import { COMPONENTS, type ComponentDef } from '../model'
import { componentGeometry } from '../roads'
import { useStore } from '../store'
import { mapInstance } from '../map/MapCanvas'

// 3D thumbnails, rendered once per session after the panel mounts (Three.js loads lazily).
// Utility/path lines stay as SVG: a pipe is a thin line in 3D too.
let thumbs: Promise<Record<string, string>> | undefined
const loadThumbs = () => (thumbs ??= import('../three/thumbs').then((m) => m.renderThumbs(COMPONENTS.filter((c) => c.geom !== 'line' || c.layer === 'roads'))).catch(() => ({})))

function Preview({ c, src }: { c: ComponentDef; src?: string }) {
  if (src) return <img src={src} alt="" className="h-7 w-7 shrink-0" draggable={false} />
  const color = c.type === 'lake' ? '#3a8fd8' : c.color
  if (c.geom === 'line') return <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0 p-1"><path d="M3 18 L21 6" stroke={color} strokeWidth={c.roadClass && c.roadClass !== 'cycle' ? 5 : 2} strokeLinecap="round" /></svg>
  if (c.type === 'roundabout') return <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0 p-1"><circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="5" /></svg>
  if (c.geom === 'point') return <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0 p-1"><circle cx="12" cy="12" r="5" fill={color} stroke="#fff" strokeWidth="1.5" /></svg>
  const w = c.w ?? 20, d = c.d ?? w, k = 18 / Math.max(w, d)
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0 p-1">
      <rect x={12 - (w * k) / 2} y={12 - (d * k) / 2} width={w * k} height={d * k} fill={color} fillOpacity={0.75} stroke={color} rx={c.type === 'roundabout' || c.type === 'lake' ? 9 : 1} />
    </svg>
  )
}

/** Searchable, categorised component library. Drag onto the map, double-click to place at map centre, or click to convert the selected area(s). */
export default function Library() {
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [img, setImg] = useState<Record<string, string>>({})
  useEffect(() => { let live = true; loadThumbs().then((t) => live && setImg(t)); return () => { live = false } }, [])
  const groups = useMemo(() => {
    const m = new Map<string, ComponentDef[]>()
    for (const c of COMPONENTS) if (c.label.toLowerCase().includes(q.toLowerCase()) || c.category.toLowerCase().includes(q.toLowerCase())) m.set(c.category, [...(m.get(c.category) ?? []), c])
    return [...m]
  }, [q])

  const placeAtCentre = (c: ComponentDef) => {
    if (!mapInstance) return
    const { lng, lat } = mapInstance.getCenter()
    const s = useStore.getState()
    s.setTool('select')
    s.addFeature(c.type, componentGeometry(c, [lng, lat]))
  }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-panel p-2">
        <input className="input" placeholder="Search components…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.map(([cat, items]) => (
        <div key={cat}>
          <button className="label flex w-full justify-between px-3 py-1.5 hover:text-ink" onClick={() => setClosed((s) => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n })}>
            {cat}<span>{closed.has(cat) && !q ? '+' : '−'}</span>
          </button>
          {(!closed.has(cat) || q) && (
            <ul className="pb-1">
              {items.map((c) => (
                <li key={c.type} draggable
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-urbanforge', c.type); e.dataTransfer.effectAllowed = 'copy' }}
                  onClick={(e) => { if (e.detail === 1) useStore.getState().convertSelection(c.type) }}
                  onDoubleClick={() => { if (!useStore.getState().convertSelection(c.type)) placeAtCentre(c) }}
                  title={`${c.label}${c.w ? ` · ${c.w}×${c.d} m` : ''}${c.floors ? ` · ${c.floors} floors` : ''} — drag onto the map, double-click to place, or click to turn the selected area into this`}
                  className="flex cursor-grab items-center gap-2 px-3 py-1 hover:bg-panel2 active:cursor-grabbing">
                  <Preview c={c} src={img[c.type]} />
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-[10px] text-muted">{c.w ? `${c.w}×${c.d}` : c.geom}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
