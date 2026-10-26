import { useState } from 'react'
import * as turf from '@turf/turf'
import { mapInstance } from '../map/MapCanvas'
import { useStore } from '../store'
import { download } from '../persist'
import { colorOf, componentDef, NETWORKS, ZONING } from '../model'
import { fmtScale, frameSize, niceLength, niceStep, PAPER, printLayout, type LegendItem, type PrintTick } from '../print'

const SCALES = [500, 1000, 2000, 2500, 5000, 10000, 25000]

/** Builds the legend from what is actually visible in the current view. */
function legendFor(bounds: [number, number, number, number]): LegendItem[] {
  const s = useStore.getState()
  const visible = new Set(s.layers.filter((l) => l.visible).map((l) => l.id))
  const view = turf.bboxPolygon(bounds)
  const items = new Map<string, LegendItem>()
  for (const f of Object.values(s.features)) {
    if (!visible.has(f.properties.layerId) || !turf.booleanIntersects(f, view)) continue
    const { type, attrs } = f.properties
    const def = componentDef(type)
    const kind = f.geometry.type === 'Point' ? 'point' : f.geometry.type === 'LineString' ? 'line' : 'fill'
    let label = def.label
    if ((type === 'plot' || type === 'zone') && typeof attrs.zoning === 'string') label = `${type === 'plot' ? 'Plot' : 'Zone'} — ${ZONING[attrs.zoning]?.label ?? attrs.zoning}`
    else if (def.layer === 'roads' && kind === 'line') label = 'Road'
    else if (def.layer === 'utilities' && typeof attrs.network === 'string' && NETWORKS[attrs.network]) label = NETWORKS[attrs.network].label
    if (!items.has(label)) items.set(label, { label, color: def.layer === 'roads' && kind === 'line' ? '#5b6470' : colorOf(f), kind })
  }
  return [...items.values()].slice(0, 22)
}

export default function PrintDialog({ close, notify }: { close: () => void; notify: (m: string) => void }) {
  const meta = useStore((s) => s.meta)
  const [paper, setPaper] = useState<keyof typeof PAPER>('A3')
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape')
  const [scaleMode, setScaleMode] = useState<number>(0) // 0 = fit current view
  const [title, setTitle] = useState(meta.name)
  const [subtitle, setSubtitle] = useState('Preliminary master plan')
  const [author, setAuthor] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [fw, fh] = frameSize(paper, orientation)

  const create = async () => {
    const map = mapInstance
    if (!map) return
    setBusy(true)
    const saved = { center: map.getCenter(), zoom: map.getZoom() }
    const box = map.getContainer(), savedHeight = box.style.height
    try {
      // Give the map the frame's exact proportions for the capture, so the image fills the frame.
      const W0 = map.getCanvas().clientWidth
      box.style.height = `${Math.round((W0 * fh) / fw)}px`
      map.resize()
      map.jumpTo({ center: saved.center })
      const canvas = map.getCanvas(), W = canvas.clientWidth, H = canvas.clientHeight
      if (scaleMode) {
        // metres per CSS pixel needed so the frame width shows `scale × frame width` on the ground
        const mpp = (scaleMode * fw) / 1000 / W
        const zoom = Math.log2((40075016.686 * Math.cos((saved.center.lat * Math.PI) / 180)) / (512 * mpp))
        map.jumpTo({ zoom })
        await new Promise<void>((r) => { const t = setTimeout(r, 8000); map.once('idle', () => { clearTimeout(t); r() }) })
      }
      await new Promise<void>((r) => { const t = setTimeout(r, 8000); map.once('idle', () => { clearTimeout(t); r() }) })
      const png = await new Promise<string>((r) => { map.once('render', () => r(canvas.toDataURL('image/png'))); map.triggerRepaint() })
      const visH = Math.min(H, (W * fh) / fw) // image is fit to the frame width
      const mid = map.unproject([W / 2, visH / 2])
      const ground = turf.distance(map.unproject([0, visH / 2]).toArray(), map.unproject([W, visH / 2]).toArray(), { units: 'meters' })
      const scale = ground / (fw / 1000)
      const bearing = map.getBearing()
      // graticule (only meaningful for a north-up map)
      let xTicks: PrintTick[] = [], yTicks: PrintTick[] = []
      if (Math.abs(bearing) < 0.5) {
        const w = map.unproject([0, visH]).lng, e = map.unproject([W, 0]).lng, s = map.unproject([0, visH]).lat, n = map.unproject([W, 0]).lat
        const step = niceStep(Math.max(e - w, n - s), 5), dp = Math.max(0, -Math.floor(Math.log10(step)))
        for (let x = Math.ceil(w / step) * step; x <= e; x += step) xTicks.push({ pos: map.project([x, mid.lat]).x / W, label: `${Math.abs(x).toFixed(dp)}°${x >= 0 ? 'E' : 'W'}` })
        for (let y = Math.ceil(s / step) * step; y <= n; y += step) yTicks.push({ pos: map.project([mid.lng, y]).y / visH, label: `${Math.abs(y).toFixed(dp)}°${y >= 0 ? 'N' : 'S'}` })
      }
      const b = [map.unproject([0, visH]).lng, map.unproject([0, visH]).lat, map.unproject([W, 0]).lng, map.unproject([W, 0]).lat] as [number, number, number, number]
      const metres = niceLength(ground / 5)
      const html = printLayout({
        paper, orientation, title, subtitle, author, notes, png, scale, bearing, xTicks, yTicks,
        scaleBar: { metres, fraction: metres / ground }, legend: legendFor(b),
        crs: 'WGS 84 (EPSG:4326); graticule in degrees', date: new Date().toLocaleDateString(),
      })
      download(`${meta.name.replace(/[^\w-]+/g, '_')}-${paper}-${orientation}.html`, html, 'text/html')
      notify(`Layout created at ${fmtScale(scale)} on ${paper} ${orientation}. Open it and print (set margins to none).${Math.abs(bearing) >= 0.5 ? ' Graticule omitted because the map is rotated.' : ''}`)
      close()
    } finally {
      box.style.height = savedHeight
      map.resize()
      map.jumpTo({ center: saved.center, zoom: saved.zoom })
      setBusy(false)
    }
  }

  const row = 'grid grid-cols-[110px_1fr] items-center gap-2'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[440px] rounded-lg border border-line bg-panel shadow-2xl">
        <div className="border-b border-line px-4 py-2 text-sm font-medium">Print layout</div>
        <div className="space-y-2 p-4">
          <label className={row}><span className="text-muted">Paper</span>
            <div className="flex gap-1">
              <select className="input" value={paper} onChange={(e) => setPaper(e.target.value as keyof typeof PAPER)}>{Object.keys(PAPER).map((p) => <option key={p}>{p}</option>)}</select>
              <select className="input" value={orientation} onChange={(e) => setOrientation(e.target.value as 'landscape' | 'portrait')}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select>
            </div>
          </label>
          <label className={row}><span className="text-muted">Scale</span>
            <select className="input" value={scaleMode} onChange={(e) => setScaleMode(+e.target.value)}>
              <option value={0}>Fit current view</option>
              {SCALES.map((s) => <option key={s} value={s}>{fmtScale(s)}</option>)}
            </select>
          </label>
          <label className={row}><span className="text-muted">Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className={row}><span className="text-muted">Subtitle</span><input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></label>
          <label className={row}><span className="text-muted">Drawn by</span><input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
          <label className="block"><span className="text-muted">Map notes</span><textarea className="input mt-1 h-16" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <p className="text-[11px] text-muted">Map frame {fw} × {fh} mm. The map is captured from the current view, centred where it is now{scaleMode ? `, zoomed to exactly ${fmtScale(scaleMode)}` : ''}. Includes north arrow, scale bar, graticule, legend of visible objects and a title block.</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={create}>{busy ? 'Rendering…' : 'Create layout'}</button>
        </div>
      </div>
    </div>
  )
}
