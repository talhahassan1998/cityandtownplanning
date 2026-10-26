import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { footprint, lineAt } from './geo'
import { componentDef, newProject, uid, type PlanFeature } from './model'
import { deleteProject, geometryProblem, listProjects, loadProject, loadRecovery, parseGeoJSON, parseProject, plotScheduleCSV, saveProject, saveRecovery, serializeProject, toGeoJSON } from './persist'

function sample() {
  const p = newProject('Test town')
  const L = (k: string) => p.layers.find((l) => l.kind === k)!.id
  const add = (type: string, geometry: any, layer: string, attrs = {}) => {
    const id = uid()
    p.features[id] = { type: 'Feature', id, geometry, properties: { id, type, layerId: L(layer), name: type, attrs } } as PlanFeature
  }
  add('boundary', footprint([67, 24.86], 300, 200), 'boundary')
  add('road', lineAt([67, 24.86], 200), 'roads', { width: 9, roadClass: 'local' })
  add('plot', footprint([67, 24.86], 15, 25), 'parcels', { plotNo: 'B1-1', block: 'B1', zoning: 'residential' })
  return p
}

describe('project files', () => {
  it('round-trips through serialize/parse unchanged', () => {
    const p = sample()
    const { project, rejected } = parseProject(serializeProject(p))
    expect(rejected).toEqual([])
    expect(project).toEqual(p)
  })
  it('rejects invalid geometry and reports it', () => {
    const p = sample()
    const bad = Object.values(p.features)[0]
    bad.geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] } // bow-tie
    const { project, rejected } = parseProject(serializeProject(p))
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatch(/self-intersecting/)
    expect(Object.keys(project.features)).toHaveLength(2)
  })
  it('refuses foreign or newer files', () => {
    expect(() => parseProject('{"type":"FeatureCollection"}')).toThrow()
    expect(() => parseProject(JSON.stringify({ format: 'urbanforge', version: 99 }))).toThrow(/newer/)
  })
  it('geometryProblem catches common defects', () => {
    expect(geometryProblem({ type: 'LineString', coordinates: [[0, 0]] })).toBeTruthy()
    expect(geometryProblem({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })).toMatch(/closed|4/)
    expect(geometryProblem({ type: 'Point', coordinates: [200, 0] })).toBeTruthy()
    expect(geometryProblem({ type: 'Point', coordinates: [67, 24] })).toBeUndefined()
  })
})

describe('GeoJSON', () => {
  it('exports and re-imports with types preserved', () => {
    const p = sample()
    const fc = toGeoJSON(Object.values(p.features), p.layers)
    const { features, rejected } = parseGeoJSON(JSON.stringify(fc), (t) => p.layers.find((l) => l.kind === componentDef(t).layer)!.id)
    expect(rejected).toEqual([])
    expect(features.map((f) => f.properties.type).sort()).toEqual(['boundary', 'plot', 'road'])
    expect(features.find((f) => f.properties.type === 'road')!.properties.attrs.width).toBe(9)
  })
  it('explodes multi-geometries from foreign data', () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { highway: 'residential' }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [0, 1]], [[1, 1], [2, 2]]] } }] }
    const { features } = parseGeoJSON(JSON.stringify(fc), () => 'L')
    expect(features).toHaveLength(2)
    expect(features[0].properties.type).toBe('road')
    expect(features[0].properties.attrs.width).toBe(9) // local-street defaults filled in
    expect(features[0].properties.attrs.highway).toBe('residential') // source attributes kept
  })
})

describe('IndexedDB persistence', () => {
  it('saves, lists, reloads and deletes projects', async () => {
    const p = sample()
    await saveRecovery(p)
    const saved = await saveProject(p)
    expect(await loadRecovery()).toBeUndefined() // explicit save clears recovery
    expect((await listProjects()).map((s) => s.id)).toContain(p.id)
    const loaded = await loadProject(p.id)
    expect(loaded).toEqual(saved)
    await deleteProject(p.id)
    expect(await loadProject(p.id)).toBeUndefined()
  })
})

describe('plot schedule', () => {
  it('lists plots with area and validation', () => {
    const csv = plotScheduleCSV(Object.values(sample().features))
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^"B1-1","B1","37\d\.\d"/)
  })
})
