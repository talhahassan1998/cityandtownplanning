import type { Stats } from './geo'
import { GENERIC_RULESET, USE_CLASSES, ZONING, type PlanFeature, type Project } from './model'
import { CHECK_LABELS, type Compliance, type Violation } from './zoning'

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const area = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2).toLocaleString()} m²`)
const len = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`)
const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—')
const table = (head: string[], rows: readonly (readonly unknown[])[]) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`

/**
 * Self-contained, printable HTML planning report (open in a browser, print to PDF). Measured
 * quantities, assumption-based estimates and rule checks are kept in separate, labelled sections.
 */
export function planningReport(p: Project, st: Stats, comp: Compliance, mapPng?: string): string {
  const rs = p.ruleset ?? GENERIC_RULESET
  const targets = p.settings.landUseTargets ?? {}
  const base = st.boundaryArea || Object.values(st.landUse).reduce((a, b) => a + b, 0)
  const name = (id: string) => p.features[id]?.properties.attrs.plotNo ?? p.features[id]?.properties.name ?? id
  const byCode = Object.entries(CHECK_LABELS).map(([code, label]) => [label, comp.violations.filter((v) => v.code === code).length] as const).filter(([, n]) => n)
  const zones = Object.keys({ ...ZONING, ...rs.rules })
  const lim = (v?: number, unit = '') => (v === undefined ? '—' : `${v}${unit}`)

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.name)} — Planning report</title>
<style>
body{font:13px/1.45 "Segoe UI",system-ui,sans-serif;color:#1c2026;max-width:960px;margin:24px auto;padding:0 24px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #ccd;padding-bottom:4px}
.meta{color:#667;margin:4px 0 12px}.note{background:#fff6e6;border:1px solid #f3d9a4;border-radius:4px;padding:8px 12px;margin:12px 0}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #d8dbe0;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f1f3f6;font-weight:600}td.n{text-align:right}img{width:100%;border:1px solid #ccd}
.ok{color:#1a7f37}.bad{color:#c62828}@media print{body{margin:0}h2{break-after:avoid}table{break-inside:auto}}
</style></head><body>
<h1>${esc(p.name)}</h1>
<div class="meta">Planning report · generated ${esc(new Date().toLocaleString())} · CRS EPSG:4326, geodesic measurements · rules: ${esc(rs.name)}</div>
<div class="note"><b>Preliminary planning document.</b> Generated layouts and checks support early design. They are not a legal approval or a construction-ready design. Estimates depend on the stated assumptions.</div>
${mapPng ? `<h2>Plan</h2><img src="${mapPng}" alt="Map of ${esc(p.name)}">` : ''}

<h2>Measured quantities</h2>
${table(['Quantity', 'Value', 'Share of site'], [
    ['Development area', area(st.boundaryArea), ''],
    ['Plots', `${st.plotCount} (${st.invalidPlots} failing plot rules)`, ''],
    ['Plotted land', area(st.plotArea), pct(st.plotArea, st.boundaryArea)],
    ['Road length', len(st.roadLength), ''],
    ['Road area (right-of-way)', area(st.roadArea), pct(st.roadArea, st.boundaryArea)],
    ['Green space', area(st.greenArea), pct(st.greenArea, st.boundaryArea)],
    ['Building footprint', area(st.footprint), pct(st.footprint, st.boundaryArea)],
    ['Gross floor area', area(st.gfa), st.boundaryArea ? `site FAR ${(st.gfa / st.boundaryArea).toFixed(2)}` : ''],
  ])}

<h2>Land use</h2>
${table(['Category', 'Area', 'Share', 'Target', 'Difference'], Object.entries(st.landUse).sort((a, b) => b[1] - a[1]).map(([z, a]) => {
    const share = base ? (a / base) * 100 : 0, t = targets[z]
    return [ZONING[z]?.label ?? z, area(a), `${share.toFixed(1)}%`, t === undefined ? '—' : `${t}%`, t === undefined ? '—' : `${(share - t).toFixed(1)} pts`]
  }))}

<h2>Plot-size distribution</h2>
${table(['Size band', 'Plots'], st.plotSizes.map((b) => [b.label, b.count]))}

<h2>Estimates (assumption-based)</h2>
${table(['Estimate', 'Value', 'Assumption'], [
    ['Housing capacity', `${st.dwellings.toLocaleString()} dwellings`, `${p.settings.dwellingsPerPlot} per residential plot + multi-unit floor area × 80% ÷ 100 m²`],
    ['Population capacity', st.population.toLocaleString(), `${p.settings.personsPerDwelling} persons per dwelling`],
    ['Road construction', money(st.roadCost), `${money(p.settings.roadCostPerM2)} per m² of right-of-way`],
    ['Building construction', money(st.buildingCost), `${money(p.settings.buildingCostPerM2)} per m² of floor area`],
  ])}

<h2>Development controls — ${esc(rs.name)}</h2>
${table(['Zone', 'Max height', 'Max floors', 'Max FAR', 'Max coverage', 'Min plot', 'Setback', 'Max density', 'Permitted uses'], zones.filter((z) => rs.rules[z]).map((z) => {
    const r = rs.rules[z]
    return [ZONING[z]?.label ?? z, lim(r.maxHeight, ' m'), lim(r.maxFloors), lim(r.maxFAR), lim(r.maxCoverage, '%'), lim(r.minPlotArea, ' m²'), lim(r.setback, ' m'), lim(r.maxDensity, ' dw/ha'), r.uses.filter((u) => (USE_CLASSES as readonly string[]).includes(u)).join(', ') || 'none']
  }))}

<h2>Compliance</h2>
${comp.violations.length
    ? `<p class="bad"><b>${comp.violations.length}</b> violation(s) on <b>${comp.byId.size}</b> object(s).</p>${table(['Check', 'Violations'], byCode)}
${table(['Object', 'Check', 'Finding'], comp.violations.slice(0, 1000).map((v) => [name(v.id), CHECK_LABELS[v.code], v.message]))}${comp.violations.length > 1000 ? '<p>First 1,000 shown; export the compliance CSV for the full list.</p>' : ''}`
    : `<p class="ok">No violations of the development controls were found.</p>`}
</body></html>`
}

export function complianceCSV(violations: Violation[], features: Record<string, PlanFeature>): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [['object_id', 'object', 'type', 'check', 'value', 'limit', 'finding'],
    ...violations.map((v) => {
      const f = features[v.id]
      return [v.id, f?.properties.attrs.plotNo ?? f?.properties.name, f?.properties.type, CHECK_LABELS[v.code], v.value, v.limit, v.message]
    })].map((r) => r.map(q).join(',')).join('\n')
}
