import { useRef, useState } from 'react'
import { GENERIC_RULESET, USE_CLASSES, ZONING, type Ruleset, type ZoneRule } from '../model'
import { useStore } from '../store'
import { download } from '../persist'
import { parseRuleset } from '../zoning'

const COLS: [keyof Omit<ZoneRule, 'uses'>, string, string][] = [
  ['maxHeight', 'Max height', 'm'],
  ['maxFloors', 'Max floors', ''],
  ['maxFAR', 'Max FAR', ''],
  ['maxCoverage', 'Max coverage', '%'],
  ['minPlotArea', 'Min plot', 'm²'],
  ['setback', 'Setback', 'm'],
  ['maxDensity', 'Max density', 'dw/ha'],
]
const SHORT: Record<string, string> = {
  Residential: 'Res', Commercial: 'Com', 'Public & institutional': 'Pub', 'Green & recreation': 'Grn',
  'Industrial & economic': 'Ind', Utilities: 'Utl', 'Roads & transport': 'Trn',
}

/** Editor for the project's development controls. Edits apply live; blank = not controlled. */
export default function ZoningDialog({ close }: { close: () => void }) {
  const ruleset = useStore((s) => s.meta.ruleset) ?? GENERIC_RULESET
  const setMeta = useStore((s) => s.setMeta)
  const file = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const save = (r: Ruleset) => setMeta({ ruleset: r })
  const setRule = (zone: string, patch: Partial<ZoneRule>) => {
    const rule: ZoneRule = { ...(ruleset.rules[zone] ?? { uses: [] }), ...patch }
    for (const k of Object.keys(patch) as (keyof ZoneRule)[]) if (patch[k] === undefined) delete rule[k]
    // An edited template is no longer the generic template, so don't let reports claim it is.
    const name = ruleset.name === GENERIC_RULESET.name ? 'Custom ruleset (based on generic template)' : ruleset.name
    save({ ...ruleset, name, rules: { ...ruleset.rules, [zone]: rule } })
  }
  const toggleUse = (zone: string, use: string) => {
    const uses = ruleset.rules[zone]?.uses ?? []
    setRule(zone, { uses: uses.includes(use) ? uses.filter((u) => u !== use) : [...uses, use] })
  }
  const importFile = async (f: File) => {
    try { save(parseRuleset(await f.text())); setError(null) } catch (e) { setError(`Import failed: ${(e as Error).message}`) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="max-h-[90vh] w-[1040px] overflow-auto rounded-lg border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="text-sm font-medium">Development controls</span>
          <input className="input flex-1" value={ruleset.name} onChange={(e) => save({ ...ruleset, name: e.target.value })} aria-label="Ruleset name" />
        </div>
        <div className="p-4">
          <table className="w-full text-[11px]">
            <thead className="text-muted">
              <tr>
                <th className="pb-1 text-left font-medium">Zone</th>
                {COLS.map(([k, label, unit]) => <th key={k} className="pb-1 text-left font-medium">{label}{unit && <span className="font-normal"> ({unit})</span>}</th>)}
                <th className="pb-1 text-left font-medium">Permitted uses</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ZONING).map(([zone, z]) => {
                const rule = ruleset.rules[zone]
                return (
                  <tr key={zone} className="border-t border-line">
                    <td className="py-1 pr-2"><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: z.color }} />{z.label}</td>
                    {COLS.map(([k]) => (
                      <td key={k} className="py-1 pr-1.5">
                        <input className="input !w-16" type="number" min={0} step="any" placeholder="—" value={rule?.[k] ?? ''}
                          onChange={(e) => setRule(zone, { [k]: e.target.value === '' ? undefined : Math.max(0, +e.target.value) })} />
                      </td>
                    ))}
                    <td className="py-1">
                      <div className="flex flex-wrap gap-0.5">
                        {USE_CLASSES.map((u) => {
                          const on = rule?.uses.includes(u)
                          return <button key={u} title={u} onClick={() => toggleUse(zone, u)}
                            className={`rounded px-1 py-0.5 text-[10px] ${on ? 'bg-accent/25 text-accent' : 'bg-panel2 text-muted line-through'}`}>{SHORT[u]}</button>
                        })}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-muted">
            Blank = not controlled. Buildings are checked against the zone of the plot they stand on (else the zoning area containing them).
            FAR, coverage and density are per plot; setback is the minimum distance from the building to every plot boundary.
            Permitted uses apply to buildings only; open space, roads and utility lines are allowed in every zone.
            The template values are illustrative. Replace them with your local planning code.
          </p>
          {error && <div className="mt-2 rounded border border-bad/50 bg-bad/10 px-2 py-1 text-bad">{error}</div>}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2">
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = '' }} />
          <button className="btn border border-line" onClick={() => file.current?.click()}>Import ruleset…</button>
          <button className="btn border border-line" onClick={() => download(`${ruleset.name.replace(/[^\w-]+/g, '_').slice(0, 60)}.rules.json`, JSON.stringify(ruleset, null, 1))}>Export ruleset</button>
          <button className="btn border border-line" onClick={() => save(GENERIC_RULESET)}>Reset to template</button>
          <div className="flex-1" />
          <button className="btn-primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  )
}
