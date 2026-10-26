import { describe, expect, it } from 'vitest'
import { frame } from './geo'
import { componentDef, defaultAttrs, type PlanFeature } from './model'
import { DEFAULT_BRIEF, generatePlan, squareSite, VARIANTS } from './masterplan'
import { analyzeNetworks } from './networks'
import { buildRoadGraph } from './three/drive'
import { layWaterSewer, type PipeDraft } from './utilities'

const O: [number, number] = [67.35, 25.25]
const F = frame(O)
const toLocal = (p: any) => F.toLocal(p) as [number, number]
let k = 0
const feat = (type: string, geometry: any, attrs: any = {}, name?: string): PlanFeature => {
  const id = `${type}-${++k}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: 'L', type, name: name ?? `${type} ${k}`, attrs: { ...defaultAttrs(componentDef(type)), ...attrs } } }
}
const fromDrafts = (ds: PipeDraft[]) => ds.map((d) => feat(d.type, d.geometry, d.attrs, d.name))
const town = (ha: number) => generatePlan(squareSite(O, ha), { ...DEFAULT_BRIEF, fillBuildings: false }, VARIANTS[0]).drafts.map((d) => feat(d.type, d.geometry, d.attrs, d.name))
const lay = (fs: PlanFeature[]) => layWaterSewer(fs, toLocal, F.toGeo)
const street = (pts: [number, number][]) => feat('road-local', { type: 'LineString', coordinates: pts.map((p) => F.toGeo(p)) }, { width: 12, lanes: 2, sidewalk: 1.5, roadClass: 'local' })

describe('layWaterSewer', () => {
  const fs = town(20)
  const drafts = lay(fs)

  it('lays a connected water and sewer network under a wizard town', () => {
    const r = analyzeNetworks([...fs, ...fromDrafts(drafts)])
    const bad = r.issues.filter((i) => (i.network === 'water' || i.network === 'sewer') && ['disconnected', 'no-source', 'separation'].includes(i.code))
    expect(bad).toEqual([])
    expect(drafts.some((d) => d.type === 'water-tank')).toBe(true)
    expect(drafts.some((d) => d.type === 'treatment')).toBe(true)
    const edges = buildRoadGraph(fs, toLocal, 'left').edges.length
    expect(drafts.filter((d) => d.type === 'water-main').length).toBeGreaterThanOrEqual(edges) // + the tank link
    expect(drafts.filter((d) => d.type === 'sewer').length).toBeGreaterThanOrEqual(edges) // + the plant link
    expect(drafts.filter((d) => d.type === 'water-main').length).toBeLessThanOrEqual(edges + 1)
  }, 30000)

  it('lays nothing twice', () => {
    expect(lay([...fs, ...fromDrafts(drafts)])).toEqual([])
  }, 30000)

  it('keeps hand-drawn pipes', () => {
    const s = street([[0, 0], [200, 0]])
    const own = feat('sewer', { type: 'LineString', coordinates: [F.toGeo([0, -1.5]), F.toGeo([200, -1.5])] })
    const tank = feat('water-tank', { type: 'Point', coordinates: F.toGeo([100, 30]) }), plant = feat('treatment', { type: 'Point', coordinates: F.toGeo([300, 0]) })
    const ds = lay([s, own, tank, plant])
    expect(ds.filter((d) => d.type === 'water-main').length).toBe(1)
    expect(ds.filter((d) => d.type === 'sewer').length).toBe(0)
  })

  it('adds no tank or plant when the project has them', () => {
    const s = street([[0, 0], [200, 0]])
    const tank = feat('water-tank', { type: 'Point', coordinates: F.toGeo([100, 30]) })
    const plant = feat('treatment', { type: 'Point', coordinates: F.toGeo([300, 0]) })
    const ds = lay([s, tank, plant])
    expect(ds.some((d) => d.type === 'water-tank' || d.type === 'treatment')).toBe(false)
  })

  it('ends each pipe at a dead-end street on a hydrant (water) or manhole (sewer), so no open ends', () => {
    const tee = [street([[0, 0], [200, 0]]), street([[100, 0], [100, 120]])]
    const ds = lay(tee)
    const open = analyzeNetworks([...tee, ...fromDrafts(ds)]).issues.filter((i) => i.code === 'open-end')
    expect(open).toEqual([])
    expect(ds.filter((d) => d.type === 'hydrant').length).toBeGreaterThan(0)
    expect(ds.filter((d) => d.type === 'manhole').length).toBeGreaterThan(0)
  })

  it('handles no streets', () => {
    expect(lay([])).toEqual([])
  })

  it('keeps the network check fast on a big piped town', () => {
    const big = generatePlan(squareSite(O, 60), { ...DEFAULT_BRIEF, fillBuildings: true }, VARIANTS[0]).drafts.map((d) => feat(d.type, d.geometry, d.attrs, d.name))
    const all = [...big, ...fromDrafts(lay(big))]
    const best = Math.min(...[0, 1, 2].map(() => { const t = performance.now(); analyzeNetworks(all); return performance.now() - t }))
    expect(best).toBeLessThan(300) // runs on every edit (networksOf); best of 3 so parallel test load doesn't flake it
  }, 60000)

  it('is fast on a big town', () => {
    const big = town(60), t = performance.now()
    lay(big)
    expect(performance.now() - t).toBeLessThan(1000)
  }, 60000)
})
