/**
 * Print composer: a self-contained, print-ready HTML sheet (paper size + orientation via @page)
 * with the map at a stated scale, coordinate graticule, north arrow, scale bar, legend and title block.
 */
export const PAPER: Record<string, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] } // landscape mm

export interface PrintTick { pos: number; label: string } // pos = 0–1 across the map frame
export interface LegendItem { label: string; color: string; kind: 'fill' | 'line' | 'point' }

export interface PrintInput {
  paper: keyof typeof PAPER
  orientation: 'landscape' | 'portrait'
  title: string
  subtitle?: string
  author?: string
  notes?: string
  png: string
  /** Fraction of the captured image height that is visible in the frame (image is fit to width). */
  scale: number             // 1:N at the printed size
  bearing: number           // map rotation (deg clockwise)
  xTicks: PrintTick[]       // longitude labels along the frame top/bottom
  yTicks: PrintTick[]       // latitude labels along the frame sides
  scaleBar: { metres: number; fraction: number } // bar length on the ground and its share of the frame width
  legend: LegendItem[]
  crs: string
  date: string
}

const MARGIN = 10, SIDE = 72 // mm

/** Map-frame size in mm for a paper/orientation (paper minus margins and the side panel). */
export function frameSize(paper: keyof typeof PAPER, orientation: 'landscape' | 'portrait'): [number, number] {
  const [w, h] = orientation === 'landscape' ? PAPER[paper] : [PAPER[paper][1], PAPER[paper][0]]
  return orientation === 'landscape' ? [w - 2 * MARGIN - SIDE - 6, h - 2 * MARGIN] : [w - 2 * MARGIN, h - 2 * MARGIN - 70]
}

/** Readable scale-bar length (1/2/5 × 10ⁿ m) close to `target` metres. */
export function niceLength(target: number): number {
  const p = 10 ** Math.floor(Math.log10(target)), m = target / p
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p
}

/** Readable graticule spacing in degrees giving roughly `count` lines across `span` degrees. */
export function niceStep(span: number, count = 5): number {
  const raw = span / count, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p
}

export const fmtScale = (n: number) => `1:${Math.round(n).toLocaleString('en')}`

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function printLayout(i: PrintInput): string {
  const [pw, ph] = i.orientation === 'landscape' ? PAPER[i.paper] : [PAPER[i.paper][1], PAPER[i.paper][0]]
  const [fw, fh] = frameSize(i.paper, i.orientation)
  const side = i.orientation === 'landscape'
  const tick = (t: PrintTick, axis: 'x' | 'y') => axis === 'x'
    ? `<span class="tx" style="left:${(t.pos * 100).toFixed(3)}%">${esc(t.label)}</span><span class="tx b" style="left:${(t.pos * 100).toFixed(3)}%">${esc(t.label)}</span><i class="gx" style="left:${(t.pos * 100).toFixed(3)}%"></i>`
    : `<span class="ty" style="top:${(t.pos * 100).toFixed(3)}%">${esc(t.label)}</span><span class="ty r" style="top:${(t.pos * 100).toFixed(3)}%">${esc(t.label)}</span><i class="gy" style="top:${(t.pos * 100).toFixed(3)}%"></i>`
  const swatch = (l: LegendItem) => l.kind === 'line' ? `<svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5" stroke="${esc(l.color)}" stroke-width="3"/></svg>`
    : l.kind === 'point' ? `<svg width="22" height="10"><circle cx="11" cy="5" r="4" fill="${esc(l.color)}" stroke="#333" stroke-width=".6"/></svg>`
    : `<svg width="22" height="10"><rect x="1" y="1" width="20" height="8" fill="${esc(l.color)}" fill-opacity=".75" stroke="${esc(l.color)}"/></svg>`
  const barMm = i.scaleBar.fraction * fw
  const panel = `
    <div class="panel">
      <div class="north"><svg viewBox="0 0 40 52" width="34" style="transform:rotate(${-i.bearing}deg)"><polygon points="20,2 32,40 20,32 8,40" fill="#1c2026"/><polygon points="20,2 20,32 8,40" fill="#fff" stroke="#1c2026"/><text x="20" y="51" text-anchor="middle" font-size="11" font-weight="700">N</text></svg></div>
      <div class="sb"><div class="bar" style="width:${barMm.toFixed(1)}mm"><b></b><b></b><b></b><b></b></div>
        <div class="sbl" style="width:${barMm.toFixed(1)}mm"><span>0</span><span>${i.scaleBar.metres >= 1000 ? `${i.scaleBar.metres / 1000} km` : `${i.scaleBar.metres} m`}</span></div>
        <div class="sc">Scale ${fmtScale(i.scale)} at ${esc(i.paper)}</div></div>
      ${i.legend.length ? `<h3>Legend</h3><div class="legend">${i.legend.map((l) => `<div>${swatch(l)}<span>${esc(l.label)}</span></div>`).join('')}</div>` : ''}
      ${i.notes ? `<h3>Notes</h3><p class="notes">${esc(i.notes).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="tb">
        <div class="t">${esc(i.title)}</div>${i.subtitle ? `<div class="st">${esc(i.subtitle)}</div>` : ''}
        <table><tr><td>Drawn by</td><td>${esc(i.author || '—')}</td></tr><tr><td>Date</td><td>${esc(i.date)}</td></tr>
        <tr><td>Scale</td><td>${fmtScale(i.scale)} (${esc(i.paper)})</td></tr><tr><td>CRS</td><td>${esc(i.crs)}</td></tr><tr><td>Sheet</td><td>1 of 1</td></tr></table>
        <div class="disc">Preliminary planning drawing — not for construction or legal approval. Base map © OpenStreetMap contributors.</div>
      </div>
    </div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(i.title)} — ${esc(i.paper)} layout</title><style>
@page{size:${i.paper} ${i.orientation};margin:0}
*{box-sizing:border-box}body{margin:0;font:9pt/1.35 "Segoe UI",Arial,sans-serif;color:#1c2026;background:#888}
.sheet{width:${pw}mm;height:${ph}mm;padding:${MARGIN}mm;background:#fff;margin:0 auto;display:flex;gap:6mm;${side ? '' : 'flex-direction:column;'}}
.frame{position:relative;width:${fw}mm;height:${fh}mm;border:.5mm solid #1c2026;overflow:hidden;flex:none}
.frame img{width:100%;display:block}
.gx,.gy{position:absolute;background:rgba(0,0,0,.25)}.gx{top:0;bottom:0;width:.15mm}.gy{left:0;right:0;height:.15mm}
.tx,.ty{position:absolute;font-size:6.5pt;background:#fff;padding:0 .6mm;white-space:nowrap}
.tx{top:0;transform:translateX(-50%)}.tx.b{top:auto;bottom:0}.ty{left:0;transform:translateY(-50%) rotate(-90deg) translateY(-50%);transform-origin:left center}.ty.r{left:auto;right:0}
.panel{flex:1;display:flex;flex-direction:column;gap:3mm;min-width:0}
.north{align-self:flex-end}.sb .bar{display:flex;height:2mm;border:.3mm solid #1c2026}.sb .bar b{flex:1}.sb .bar b:nth-child(odd){background:#1c2026}
.sbl{display:flex;justify-content:space-between;font-size:7pt}.sc{font-size:8pt;margin-top:1mm}
h3{font-size:9pt;margin:2mm 0 1mm;border-bottom:.3mm solid #ccc}.legend div{display:flex;align-items:center;gap:2mm;font-size:7.5pt;margin:.6mm 0}
.notes{font-size:8pt;margin:0}.tb{margin-top:auto;border:.4mm solid #1c2026;padding:2mm}.tb .t{font-size:13pt;font-weight:700}.tb .st{font-size:9pt;color:#555}
.tb table{width:100%;border-collapse:collapse;margin-top:1.5mm;font-size:7.5pt}.tb td{border-top:.2mm solid #ccc;padding:.6mm 0}.tb td:first-child{color:#666;width:22mm}
.disc{font-size:6.5pt;color:#666;margin-top:1.5mm}
@media print{body{background:#fff}.sheet{margin:0}}
</style></head><body><div class="sheet"><div class="frame"><img src="${i.png}" alt="Map">${i.xTicks.map((t) => tick(t, 'x')).join('')}${i.yTicks.map((t) => tick(t, 'y')).join('')}</div>${panel}</div></body></html>`
}
