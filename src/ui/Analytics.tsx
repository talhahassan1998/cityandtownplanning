import { useMemo } from 'react'
import { stats } from '../geo'
import { BUILDING_STYLES, NETWORKS, ZONING, type BuildingStyle, type Settings } from '../model'
import { useStore, type MapTheme } from '../store'
import { CHECK_LABELS, complianceOf, type CheckCode } from '../zoning'
import { networksOf } from '../networks'
import { zoomTo } from '../map/MapCanvas'
import { googleKey, setGoogleKey } from '../map/google'
import { fmtArea, fmtLen, fmtMoney, fmtNum, pct } from './format'

/** Live planning analytics. Measured values come from geometry; estimates from editable assumptions. */
export default function Analytics() {
  const features = useStore((s) => s.features)
  const layers = useStore((s) => s.layers)
  const settings = useStore((s) => s.meta.settings)
  const setMeta = useStore((s) => s.setMeta)
  const st = useMemo(() => stats(Object.values(features), layers, settings), [features, layers, settings])
  const base = st.boundaryArea || Object.values(st.landUse).reduce((a, b) => a + b, 0)
  const maxBucket = Math.max(1, ...st.plotSizes.map((b) => b.count))
  const setS = (k: keyof Settings, v: number) => setMeta({ settings: { ...settings, [k]: v } })
  const ruleset = useStore((s) => s.meta.ruleset)
  const comp = complianceOf(features, ruleset, settings)
  const nets = networksOf(features)
  const targets = settings.landUseTargets ?? {}
  const setTarget = (z: string, v: number | undefined) => {
    const t = { ...targets }
    if (v === undefined) delete t[z]
    else t[z] = v
    setMeta({ settings: { ...settings, landUseTargets: t } })
  }
  const mapTheme = useStore((s) => s.mapTheme), setMapTheme = useStore((s) => s.setMapTheme)
  const heatmap = useStore((s) => s.heatmap), setHeatmap = useStore((s) => s.setHeatmap)

  return (
    <div>
      <div className="section">
        <div className="label mb-2">Measured</div>
        <div className="grid grid-cols-2 gap-1.5">
          <Card k="Development area" v={fmtArea(st.boundaryArea)} />
          <Card k="Plots" v={`${st.plotCount}`} sub={st.invalidPlots ? `${st.invalidPlots} fail validation` : 'all valid'} bad={st.invalidPlots > 0} />
          <Card k="Plotted land" v={fmtArea(st.plotArea)} sub={pct(st.plotArea, st.boundaryArea)} />
          <Card k="Road length" v={fmtLen(st.roadLength)} />
          <Card k="Road area (ROW)" v={fmtArea(st.roadArea)} sub={pct(st.roadArea, st.boundaryArea) + ' of site'} />
          <Card k="Green space" v={fmtArea(st.greenArea)} sub={pct(st.greenArea, st.boundaryArea) + ' of site'} />
          <Card k="Building footprint" v={fmtArea(st.footprint)} />
          <Card k="Gross floor area" v={fmtArea(st.gfa)} sub={st.boundaryArea ? `FAR ${(st.gfa / st.boundaryArea).toFixed(2)}` : undefined} />
          <Card k="Net developable" v={fmtArea(Math.max(0, st.boundaryArea - st.roadArea - st.greenArea))} sub="site − roads − green" />
        </div>
      </div>

      <div className="section">
        <div className="label mb-2">Land use vs targets</div>
        {Object.keys(st.landUse).length === 0 && <div className="text-muted">Assign zoning to plots or draw zoning areas (Z).</div>}
        {Object.entries(ZONING).filter(([z]) => st.landUse[z] || targets[z] !== undefined).map(([z, info]) => {
          const a = st.landUse[z] ?? 0, share = base ? (a / base) * 100 : 0, t = targets[z]
          return (
            <div key={z} className="mb-1.5">
              <Bar label={info.label} value={a} max={base || a || 1} color={info.color} text={`${fmtArea(a)} · ${share.toFixed(1)}%`} target={t} />
              <div className="flex items-center justify-end gap-1 text-[10px] text-muted">
                target <input className="input !w-12 !py-0" type="number" min={0} max={100} placeholder="—" value={t ?? ''}
                  onChange={(e) => setTarget(z, e.target.value === '' ? undefined : Math.min(100, Math.max(0, +e.target.value)))} /> %
                {t !== undefined && <span className={Math.abs(share - t) <= 2 ? '' : 'text-warn'}>{share - t >= 0 ? '+' : ''}{(share - t).toFixed(1)} pts</span>}
              </div>
            </div>
          )
        })}
        <select className="input mt-1" value="" onChange={(e) => e.target.value && setTarget(e.target.value, 0)}>
          <option value="">Add a target for…</option>
          {Object.entries(ZONING).filter(([z]) => targets[z] === undefined).map(([z, i]) => <option key={z} value={z}>{i.label}</option>)}
        </select>
        <p className="mt-1 text-[10px] text-muted">Shares are of the development area (or of all zoned land if no boundary is drawn).</p>
      </div>

      <div className="section">
        <div className="label mb-2">Development-control compliance</div>
        {comp.violations.length === 0
          ? <div className="text-[#43a047]">✓ No violations{Object.keys(features).length ? '' : ' (nothing to check yet)'}</div>
          : <>
              <div className="mb-1 text-bad">{comp.violations.length} violation(s) on {comp.byId.size} object(s)</div>
              {(Object.keys(CHECK_LABELS) as CheckCode[]).map((c) => [c, comp.violations.filter((v) => v.code === c).length] as const).filter(([, n]) => n).map(([c, n]) => (
                <div key={c} className="flex justify-between text-[11px]"><span className="text-muted">{CHECK_LABELS[c]}</span><span className="font-mono">{n}</span></div>
              ))}
              <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
                {comp.violations.slice(0, 200).map((v, i) => (
                  <button key={i} className="block w-full truncate rounded px-1 text-left text-[11px] hover:bg-panel2" title={v.message}
                    onClick={() => { useStore.getState().select([v.id]); const f = features[v.id]; if (f) zoomTo(f) }}>✗ {v.message}</button>
                ))}
              </div>
            </>}
        <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-2">
          <span className="text-muted">Map theme</span>
          <select className="input" value={mapTheme} onChange={(e) => setMapTheme(e.target.value as MapTheme)}>
            <option value="zoning">Zoning colours</option>
            <option value="far">FAR vs limit</option>
            <option value="coverage">Ground coverage vs limit</option>
            <option value="compliance">Compliance (pass / fail)</option>
          </select>
          <span className="text-muted">Heatmap</span>
          <label className="flex items-center gap-2"><input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} /> Floor-area density</label>
        </div>
        {(mapTheme === 'far' || mapTheme === 'coverage') && (
          <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted">
            {[['#43a047', '≤ 50%'], ['#fdd835', '≤ 90%'], ['#fb8c00', '≤ 100%'], ['#e53935', 'over limit'], ['#cfd8dc', 'vacant'], ['#90a4ae', 'no limit']].map(([c, l]) => (
              <span key={l} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: c }} />{l}</span>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <div className="label mb-2">Plot-size distribution</div>
        {st.plotSizes.map((b) => <Bar key={b.label} label={b.label} value={b.count} max={maxBucket} color="#00b8d4" text={String(b.count)} />)}
      </div>

      {nets.summaries.length > 0 && (
        <div className="section">
          <div className="label mb-2">Infrastructure networks</div>
          {nets.summaries.map((n) => {
            const issues = nets.issues.filter((i) => i.network === n.network)
            return (
              <details key={n.network} className="mb-1">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px]">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: NETWORKS[n.network].color }} />
                  <span className="flex-1">{NETWORKS[n.network].label}</span>
                  <span className="font-mono text-muted">{fmtLen(n.length)}</span>
                  <span className={issues.length ? 'text-bad' : 'text-[#43a047]'}>{issues.length ? `${issues.length} ✗` : '✓'}</span>
                </summary>
                <div className="space-y-0.5 py-1 pl-4 text-[10px] text-muted">
                  <div>{n.segments} segment(s) · {n.nodes} facility/node(s) · {n.components <= 1 ? 'connected' : `${n.components} separate pieces`}</div>
                  {Object.entries(n.bySize).map(([k, m]) => <div key={k} className="flex justify-between"><span>{k}</span><span className="font-mono">{fmtLen(m)}</span></div>)}
                  {issues.slice(0, 50).map((i, x) => (
                    <button key={x} className="block w-full truncate text-left text-bad hover:underline" title={i.message}
                      onClick={() => { useStore.getState().select([i.id]); const f = features[i.id]; if (f) zoomTo(f) }}>✗ {i.message}</button>
                  ))}
                </div>
              </details>
            )
          })}
          <p className="mt-1 text-[10px] text-muted">Geometric checks only (connectivity, open ends, sources, conflicts, 60 m service reach). Hydraulic / load-flow analysis <span className="planned">planned</span></p>
        </div>
      )}

      <div className="section">
        <div className="label mb-2">Estimates <span className="normal-case text-warn">— not measured; derived from the assumptions below</span></div>
        <div className="grid grid-cols-2 gap-1.5">
          <Card k="Housing capacity" v={`${fmtNum(st.dwellings)} dwellings`} est />
          <Card k="Population capacity" v={fmtNum(st.population)} sub={st.boundaryArea ? `${fmtNum(st.population / (st.boundaryArea / 10000))} persons/ha` : undefined} est />
          <Card k="Road construction" v={fmtMoney(st.roadCost)} est />
          <Card k="Building construction" v={fmtMoney(st.buildingCost)} est />
        </div>
      </div>

      <div className="section space-y-1.5">
        <div className="label">Assumptions</div>
        <Num label="Persons per dwelling" v={settings.personsPerDwelling} on={(v) => setS('personsPerDwelling', v)} />
        <Num label="Dwellings per residential plot" v={settings.dwellingsPerPlot} on={(v) => setS('dwellingsPerPlot', v)} />
        <Num label="Road cost per m²" v={settings.roadCostPerM2} on={(v) => setS('roadCostPerM2', v)} />
        <Num label="Building cost per m² GFA" v={settings.buildingCostPerM2} on={(v) => setS('buildingCostPerM2', v)} />
        <label className="grid grid-cols-[1fr_80px] items-center gap-2">
          <span className="text-muted">Building style (3D)</span>
          <select className="input" value={settings.buildingStyle ?? 'western'} onChange={(e) => setMeta({ settings: { ...settings, buildingStyle: e.target.value as BuildingStyle } })}>
            {Object.entries(BUILDING_STYLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="grid grid-cols-[1fr_80px] items-center gap-2">
          <span className="text-muted">Driving side (3D cars)</span>
          <select className="input" value={settings.drivingSide ?? 'left'} onChange={(e) => setMeta({ settings: { ...settings, drivingSide: e.target.value as 'left' | 'right' } })}>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="grid grid-cols-[1fr_120px] items-center gap-2" title="Your own key for the Google Map Tiles API. Stored in this browser only, never in the project file.">
          <span className="text-muted">Google Maps API key</span>
          <input className="input" type="password" autoComplete="off" placeholder="paste key" defaultValue={googleKey()} onBlur={(e) => setGoogleKey(e.target.value)} />
        </label>
        <p className="text-[10px] text-muted">Enables the Google Maps / Google Satellite basemaps (Map Tiles API: free monthly allowance, needs a Google Cloud project with billing; restrict the key to this site).</p>
        <p className="text-[10px] text-muted">Multi-unit buildings add floor area × 80% ÷ 100 m² per dwelling. Heatmaps, facility catchments & zoning-rule checks <span className="planned">planned</span></p>
      </div>
    </div>
  )
}

function Card({ k, v, sub, bad, est }: { k: string; v: string; sub?: string; bad?: boolean; est?: boolean }) {
  return (
    <div className={`rounded border px-2 py-1.5 ${est ? 'border-dashed border-warn/40' : 'border-line'} bg-panel2`}>
      <div className="text-[10px] text-muted">{k}</div>
      <div className="font-mono text-[13px]">{v}</div>
      {sub && <div className={`text-[10px] ${bad ? 'text-bad' : 'text-muted'}`}>{sub}</div>}
    </div>
  )
}

function Bar({ label, value, max, color, text, target }: { label: string; value: number; max: number; color: string; text: string; target?: number }) {
  return (
    <div className="mb-1">
      <div className="flex justify-between text-[11px]"><span>{label}</span><span className="font-mono text-muted">{text}</span></div>
      <div className="relative h-1.5 rounded bg-panel2">
        <div className="h-full rounded" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
        {target !== undefined && <div className="absolute -top-0.5 h-2.5 w-0.5 bg-ink" style={{ left: `${Math.min(100, target)}%` }} title={`target ${target}%`} />}
      </div>
    </div>
  )
}

const Num = ({ label, v, on }: { label: string; v: number; on: (v: number) => void }) => (
  <label className="grid grid-cols-[1fr_80px] items-center gap-2">
    <span className="text-muted">{label}</span>
    <input className="input" type="number" min={0} step="any" value={v} onChange={(e) => on(Math.max(0, +e.target.value))} />
  </label>
)
