import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import * as turf from '@turf/turf'
import type { Feature, Polygon } from 'geojson'
import { useStore, makeFeature } from '../store'
import { colorOf, type PlanFeature } from '../model'
import { mapInstance, zoomTo } from '../map/MapCanvas'

/** Fit padding keeping the site clear of this dialog (460 px wide, over the map's right edge). */
const CLEAR_OF_DIALOG = { top: 60, bottom: 60, left: 60, right: 460 + 60 }
import { housingType, residentialPlotSize } from '../infill'
import { DEFAULT_BRIEF, generatePlan, plotSizeFor, portionOf, squareSite, VARIANTS, type Brief, type Proposal } from '../masterplan'
import { REACH, surveySite, type Conflict, type Survey } from '../sitecheck'
import { fmtArea, fmtMoney } from './format'
import { frame } from '../geo'

const STEPS = ['Site', 'People & housing', 'Land use', 'Roads & facilities', 'Budget', 'Alternatives'] as const

/**
 * Guided master-planning: brief → generated alternatives → preview on the map → accept one.
 * Docked beside the map (not modal) so previews stay visible.
 */
export default function WizardDialog({ close, notify }: { close: () => void; notify: (m: string) => void }) {
  const s = useStore()
  const selected = s.selection.length === 1 ? s.features[s.selection[0]] : undefined
  const selBoundary = selected && selected.geometry.type === 'Polygon' && (selected.properties.type === 'boundary' || selected.properties.type === 'zone') ? selected : undefined
  const [step, setStep] = useState(0)
  const [useSel, setUseSel] = useState(!!selBoundary)
  const [hectares, setHectares] = useState(40)
  // part of the selected boundary to develop (null = all of it), cut from one end
  const [devHa, setDevHa] = useState<number | null>(null)
  const [fromEnd, setFromEnd] = useState(false)
  const [b, setB] = useState<Brief>({ ...DEFAULT_BRIEF, personsPerDwelling: s.meta.settings.personsPerDwelling, roadCostPerM2: s.meta.settings.roadCostPerM2, buildingCostPerM2: s.meta.settings.buildingCostPerM2 })
  const [count, setCount] = useState(3)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [shown, setShown] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  // the site the alternatives were generated for (the map may move afterwards)
  const [genSite, setGenSite] = useState<Polygon | null>(null)
  // site clearance: only undeveloped ground may be planned (sitecheck.ts)
  const [blocked, setBlocked] = useState<Conflict[] | string | null>(null)
  // what's already on/near the site, for the site it was surveyed for; `around`: plan around it
  const [survey, setSurvey] = useState<{ site: Polygon; sv: Survey } | null>(null)
  const [around, setAround] = useState(false)

  const site: Polygon = useMemo(() => {
    if (useSel && selBoundary) return devHa ? portionOf(selBoundary.geometry as Polygon, devHa, fromEnd) : selBoundary.geometry as Polygon
    const c = mapInstance?.getCenter()
    return squareSite(c ? [c.lng, c.lat] : s.meta.center, hectares)
  }, [useSel, selBoundary, hectares, devHa, fromEnd, s.meta.center])
  const fullHa = selBoundary ? turf.area(selBoundary) / 10000 : 0
  const partial = !!(useSel && selBoundary) && site !== selBoundary!.geometry
  const siteHa = turf.area(site) / 10000
  const mixSum = Object.values(b.mix).reduce((a, x) => a + x, 0)
  const neededResHa = b.targetPopulation / b.personsPerDwelling / b.density
  const planResHa = siteHa * (b.mix.residential / (mixSum || 1))
  const housing = housingType(b.density)
  const [pw, pd] = b.fillBuildings ? residentialPlotSize(housing, b.density, s.meta.ruleset?.rules.residential?.setback) : plotSizeFor(b.density)

  useEffect(() => { setBlocked(null); setAround(false) }, [useSel, selBoundary, hectares, devHa, fromEnd]) // not `site`: it follows every map move (meta.center)
  // outline the part that will be developed while choosing it
  useEffect(() => { if (step === 0) useStore.getState().setPreview(partial ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: site, properties: { color: '#ff7a1a' } }] } : null) }, [step, site, partial])
  useEffect(() => () => useStore.getState().setPreview(null), []) // never leave a preview behind

  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => { setB({ ...b, [k]: v }); setProposals([]) }
  const num = (label: string, v: number, on: (v: number) => void, unit = '', min = 0) => (
    <label key={label} className="grid grid-cols-[1fr_96px_72px] items-center gap-2">
      <span className="text-muted">{label}</span>
      <input className="input" type="number" min={min} step="any" value={v} onChange={(e) => on(Math.max(min, +e.target.value))} />
      <span className="text-muted">{unit}</span>
    </label>
  )

  const show = (i: number | null) => {
    setShown(i)
    if (i === null) return useStore.getState().setPreview(null)
    useStore.getState().setPreview({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: genSite!, properties: { color: '#ff7a1a' } } as Feature,
        ...proposals[i].drafts.map((d) => ({ type: 'Feature', geometry: d.geometry, properties: { color: colorOf({ properties: { type: d.type, attrs: d.attrs } } as PlanFeature) } }) as Feature)],
    })
  }

  const generate = async (planAround = around, checkOsm = true) => {
    setBlocked(null)
    let sv = survey?.site === site ? survey.sv : undefined
    if (!sv) {
      setBusy(checkOsm ? `Surveying the site and roads within ${REACH} m (project + OpenStreetMap)…` : 'Checking the site against this project…')
      try {
        sv = await surveySite(site, Object.values(s.features), useSel ? selBoundary?.id : undefined, checkOsm)
        setSurvey({ site, sv })
      } catch (e) {
        setBusy(''); setBlocked(`Could not survey the site: ${(e as Error).message}`); return
      }
    }
    if (sv.conflicts.length && !planAround) { setBusy(''); setBlocked(sv.conflicts); zoomTo([{ type: 'Feature', geometry: site } as unknown as PlanFeature], CLEAR_OF_DIALOG); return }
    setAround(planAround)
    const out: Proposal[] = []
    for (let i = 0; i < count; i++) {
      setBusy(`Generating alternative ${i + 1} of ${count}…`)
      await new Promise((r) => setTimeout(r, 30)) // let the UI paint between heavy steps
      out.push(generatePlan(site, b, VARIANTS[i], s.meta.ruleset, sv))
    }
    setBusy('')
    setGenSite(site)
    setProposals(out)
    setShown(null)
    zoomTo([{ type: 'Feature', geometry: site } as unknown as PlanFeature], CLEAR_OF_DIALOG)
  }

  const accepting = useRef(false)
  useEffect(() => { void import('../utilities') }, []) // preload: Accept stays quick
  const accept = async (i: number) => {
    if (accepting.current) return // a double click must not add the plan twice
    accepting.current = true
    const p = proposals[i]
    const st = useStore.getState()
    // rules first, so the plan itself lands as a single undo step
    if (st.meta.settings.minPlotArea === undefined) st.setPlotRules({ minPlotArea: Math.round(pw * pd * 0.5), minFrontage: Math.round(pw * 0.6) })
    const add = p.drafts.map((d) => makeFeature(d.type, d.geometry, d.attrs, d.name))
    if (!(useSel && selBoundary) || partial) add.unshift(makeFeature('boundary', genSite!, { plan: String(p.drafts[0]?.attrs.plan ?? '') }, 'Development boundary (wizard)'))
    // existing OpenStreetMap roads (on the site or joined by the plan), buildings and water, kept as existing objects
    const kept = (survey?.site === genSite ? survey.sv.adds : [])
      .filter((a) => a.road === undefined || p.linkedTo.includes(a.road) || turf.booleanIntersects(a.draft.geometry, genSite!))
      .map((a) => makeFeature(a.draft.type, a.draft.geometry, a.draft.attrs, a.draft.name))
    let pipes: ReturnType<typeof makeFeature>[] = []
    if (b.layPipes) {
      try {
        const { layWaterSewer } = await import('../utilities'), fr = frame(st.meta.center)
        pipes = layWaterSewer([...Object.values(st.features), ...kept, ...add], (p) => fr.toLocal(p) as [number, number], fr.toGeo).map((d) => makeFeature(d.type, d.geometry, d.attrs, d.name))
      } catch (e) { notify(`Could not lay pipes: ${(e as Error).message}. The plan is added without them.`) }
    }
    st.addFeatures([...kept, ...add, ...pipes])
    st.setPreview(null)
    notify(`Added ${p.label}: ${add.length} objects${pipes.length ? ` and ${pipes.length} water/sewer items` : ''}${kept.length ? `, plus ${kept.length} existing roads, buildings and water bodies from OpenStreetMap` : ''}. A preliminary proposal, not an approved design. Edit freely; Ctrl+Z removes it.`)
    close()
  }

  return (
    <div className="fixed bottom-6 right-[330px] top-12 z-40 flex w-[460px] flex-col rounded-lg border border-line bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <span className="text-sm font-medium">Master-plan wizard</span>
        <span className="text-[11px] text-muted">step {step + 1} of {STEPS.length}: {STEPS[step]}</span>
        <div className="flex-1" />
        <button className="btn" onClick={close} title="Close" aria-label="Close"><X size={15} /></button>
      </div>
      <div className="flex gap-1 border-b border-line px-4 py-1.5">
        {STEPS.map((x, i) => <button key={x} onClick={() => setStep(i)} className={`h-1.5 flex-1 rounded ${i <= step ? 'bg-accent' : 'bg-panel2'}`} title={x} />)}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {step === 0 && <>
          {selBoundary
            ? <label className="flex items-center gap-2"><input type="checkbox" checked={useSel} onChange={(e) => setUseSel(e.target.checked)} /> Use the selected {selBoundary.properties.type} ({fmtArea(turf.area(selBoundary))})</label>
            : <p className="text-[11px] text-muted">Tip: select a drawn development boundary first to plan inside it.</p>}
          {useSel && selBoundary && <>
            {num('Area to develop', +(devHa ?? fullHa).toFixed(2), (v) => { setDevHa(v >= fullHa * 0.999 ? null : v); setProposals([]) }, `of ${fullHa.toFixed(1)} ha`, 0.1)}
            {partial && <label className="flex items-center gap-2"><input type="checkbox" checked={fromEnd} onChange={(e) => { setFromEnd(e.target.checked); setProposals([]) }} /> Start from the other end</label>}
            <p className="text-[11px] text-muted">{partial ? 'The outlined part is developed; the rest of the boundary stays open land.' : 'Enter fewer hectares to develop only part of the boundary.'}</p>
          </>}
          {!(useSel && selBoundary) && num('Square site at map centre', hectares, (v) => { setHectares(Math.max(1, v)); setProposals([]) }, 'ha', 1)}
          <p className="text-[11px]">Site area: <b>{siteHa.toFixed(1)} ha</b>. Location {(turf.centroid(site).geometry.coordinates[1]).toFixed(4)}, {(turf.centroid(site).geometry.coordinates[0]).toFixed(4)}.</p>
        </>}

        {step === 1 && <>
          {num('Target population', b.targetPopulation, (v) => set('targetPopulation', v), 'people', 1)}
          {num('Persons per dwelling', b.personsPerDwelling, (v) => set('personsPerDwelling', v), '', 1)}
          {num('Housing density (gross)', b.density, (v) => set('density', v), 'dw/ha', 1)}
          <label className="flex items-center gap-2"><input type="checkbox" checked={b.fillBuildings} onChange={(e) => set('fillBuildings', e.target.checked)} /> Fill plots with buildings</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={b.layPipes} onChange={(e) => set('layPipes', e.target.checked)} /> Lay water &amp; sewer under streets</label>
          <p className="text-[11px] text-muted">≈ {pw} × {pd} m plots ({b.fillBuildings ? `${housing === 'townhouse' ? 'townhouse rows' : `${housing}s`}` : 'one dwelling each'}). The target needs ≈ <b className={neededResHa > planResHa ? 'text-warn' : 'text-ink'}>{neededResHa.toFixed(1)} ha</b> of residential land; the current mix gives {planResHa.toFixed(1)} ha.</p>
        </>}

        {step === 2 && <>
          {(Object.keys(b.mix) as (keyof Brief['mix'])[]).map((k) => num(k[0].toUpperCase() + k.slice(1), b.mix[k], (v) => set('mix', { ...b.mix, [k]: v }), '%'))}
          <p className={`text-[11px] ${Math.abs(mixSum - 100) > 0.5 ? 'text-warn' : 'text-muted'}`}>Total {mixSum}% {Math.abs(mixSum - 100) > 0.5 && '(shares are rescaled to 100%)'}</p>
          <button className="btn border border-line" onClick={() => {
            const res = Math.min(85, Math.round((neededResHa / siteHa) * 100))
            const rest = Object.entries(b.mix).filter(([k]) => k !== 'residential').reduce((a, [, v]) => a + v, 0) || 1
            set('mix', Object.fromEntries(Object.entries(b.mix).map(([k, v]) => [k, k === 'residential' ? res : Math.round(((100 - res) * v) / rest)])) as Brief['mix'])
          }}>Size residential land to the population target</button>
        </>}

        {step === 3 && <>
          {num('Arterial road width', b.arterialWidth, (v) => set('arterialWidth', v), 'm', 6)}
          {num('Local street width', b.localStreetWidth, (v) => set('localStreetWidth', v), 'm', 4)}
          {num('Plots per block', b.plotsPerBlock, (v) => set('plotsPerBlock', Math.round(v)), '', 2)}
          <div className="label pt-2">One facility per … residents (0 = none)</div>
          {(Object.keys(b.facilities) as (keyof Brief['facilities'])[]).map((k) => num(k[0].toUpperCase() + k.slice(1), b.facilities[k], (v) => set('facilities', { ...b.facilities, [k]: v }), 'people'))}
        </>}

        {step === 4 && <>
          {num('Budget (roads + facilities)', b.budget, (v) => set('budget', v), '0 = none')}
          {num('Road cost', b.roadCostPerM2, (v) => set('roadCostPerM2', v), '/m²')}
          {num('Building cost', b.buildingCostPerM2, (v) => set('buildingCostPerM2', v), '/m²')}
          {num('Alternatives to generate', count, (v) => setCount(Math.max(1, Math.min(4, Math.round(v)))), '1–4', 1)}
          <p className="text-[11px] text-muted">Alternatives vary the spine direction and the order of land-use bands. Generation is rule-based: an arterial spine on the long axis, land-use bands in proportion to the mix, subdivided blocks, and facilities sized to the population.</p>
        </>}

        {step === 5 && <>
          {!proposals.length && <button className="btn-primary" disabled={!!busy} onClick={() => generate()}>{busy || `Generate ${count} alternative(s)`}</button>}
          {blocked && (
            <div className="rounded border border-bad p-2 text-[11px] text-bad">
              {typeof blocked === 'string' ? <>
                {blocked}
                <button className="btn mt-1.5 w-full justify-center border border-line text-ink" disabled={!!busy} onClick={() => generate(around, false)}>Generate without the OpenStreetMap check</button>
                <div className="mt-1 text-muted">Only this project is checked: existing buildings and roads on the ground won't be detected or kept.</div>
              </> : <>
                <b>This site already has development on it.</b>
                <ul className="mt-1 list-disc pl-4 text-ink">
                  {blocked.slice(0, 8).map((c, i) => <li key={i}>{c.label} <span className="text-muted">({c.source === 'osm' ? 'OpenStreetMap' : 'this project'})</span></li>)}
                </ul>
                {blocked.length > 8 && <div className="text-muted">…and {blocked.length - 8} more.</div>}
                <div className="mt-1 text-ink">Plan around it: existing roads and buildings are kept, plots stay clear of them, and the new roads join the existing ones.</div>
                <button className="btn-primary mt-1.5 w-full" disabled={!!busy} onClick={() => generate(true)}>{busy || 'Plan around existing development'}</button>
                <div className="mt-1 text-muted">Or move the map / draw a boundary on empty land and try again.</div>
              </>}
            </div>
          )}
          {proposals.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead><tr className="text-muted"><th className="text-left font-medium" />{proposals.map((p, i) => <th key={i} className="px-1 text-left font-medium">{p.label}</th>)}</tr></thead>
                <tbody>
                  {([['Plots', (p: Proposal) => p.metrics.plots.toLocaleString()], ['Dwellings', (p: Proposal) => p.metrics.dwellings.toLocaleString()], ['Road area', (p: Proposal) => fmtArea(p.metrics.roadArea)], ['Cost (roads + facilities)', (p: Proposal) => fmtMoney(p.metrics.roadCost + p.metrics.buildingCost)]] as const).map(([label, fn]) => (
                    <tr key={label} className="border-t border-line"><td className="py-0.5 text-muted">{label}</td>{proposals.map((p, i) => <td key={i} className="px-1 font-mono">{fn(p)}</td>)}</tr>
                  ))}
                  {proposals[0].checks.map((c, k) => (
                    <tr key={c.label} className="border-t border-line"><td className="py-0.5 text-muted">{c.label}</td>
                      {proposals.map((p, i) => <td key={i} className={`px-1 ${p.checks[k].ok ? 'text-[#43a047]' : 'text-bad'}`} title={p.checks[k].detail}>{p.checks[k].ok ? '✓' : '✗'} <span className="text-muted">{p.checks[k].detail.split(' (')[0]}</span></td>)}
                    </tr>
                  ))}
                  <tr className="border-t border-line"><td />{proposals.map((_, i) => (
                    <td key={i} className="space-y-1 px-1 py-1">
                      <button className={`btn w-full justify-center border border-line ${shown === i ? 'btn-on' : ''}`} onClick={() => show(shown === i ? null : i)}>{shown === i ? 'Hide' : 'Preview'}</button>
                      <button className="btn-primary w-full" onClick={() => accept(i)}>Accept</button>
                    </td>
                  ))}</tr>
                </tbody>
              </table>
              <button className="btn mt-2 border border-line" onClick={() => { show(null); setProposals([]) }}>Change brief / regenerate</button>
            </div>
          )}
          <p className="text-[10px] text-muted">Proposals are preliminary planning aids, not legally approved or construction-ready designs. Accepting adds them as ordinary, editable objects.</p>
        </>}
      </div>

      <div className="flex justify-between border-t border-line px-4 py-2">
        <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {step < STEPS.length - 1 && <button className="btn-primary" onClick={() => setStep(step + 1)}>Next</button>}
      </div>
    </div>
  )
}
