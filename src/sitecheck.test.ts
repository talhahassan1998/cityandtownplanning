import { describe, expect, it } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { footprint, lineAt } from './geo'
import { makeFeature } from './store'
import * as turf from '@turf/turf'
import { classifyForeign, overpassToGeoJSON } from './formats'
import { isDeveloped, osmConflicts, planConflicts, siteQuery, surveyOf } from './sitecheck'

const C = [55.3, 25.2]
const site = footprint(C, 400, 400)
const far = [55.4, 25.3]

describe('site clearance', () => {
  it('blocks plots, roads and buildings already in the site, not zones, boundaries or far objects', () => {
    const fs = [
      makeFeature('plot', footprint(C, 20, 30), {}, 'Plot 1'),
      makeFeature('road-local', lineAt(C, 100)),
      makeFeature('zone', footprint(C, 100, 100)),
      makeFeature('boundary', footprint(C, 500, 500)),
      makeFeature('plot', footprint(far, 20, 30)),
    ]
    expect(planConflicts(site, fs).map((c) => c.label)).toEqual(['Plot 1', expect.any(String)])
    expect(planConflicts(site, [fs[4]])).toEqual([])
  })

  it('ignores the boundary being planned inside and objects that only touch the edge', () => {
    const b = makeFeature('zone', site)
    expect(planConflicts(site, [b], b.id)).toEqual([])
    // a plot sharing the site's east edge
    const edge = footprint([C[0] + 220 / (111320 * Math.cos((C[1] * Math.PI) / 180)), C[1]], 40, 40)
    expect(planConflicts(site, [makeFeature('plot', edge)])).toEqual([])
  })

  it('treats buildings, roads and built-up land as developed, but not footpaths or farmland', () => {
    expect(isDeveloped({ building: 'yes' })).toBe(true)
    expect(isDeveloped({ highway: 'primary_link' })).toBe(true)
    expect(isDeveloped({ landuse: 'residential' })).toBe(true)
    expect(isDeveloped({ leisure: 'pitch' })).toBe(true)
    expect(isDeveloped({ highway: 'footway' })).toBe(false)
    expect(isDeveloped({ highway: 'track' })).toBe(false)
    expect(isDeveloped({ landuse: 'farmland' })).toBe(false)
  })

  it('reports developed OpenStreetMap features inside the site', () => {
    const fc: FeatureCollection = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: footprint(C, 10, 10), properties: { building: 'house' } },
      { type: 'Feature', geometry: lineAt(C, 50), properties: { highway: 'residential', name: 'Main St' } },
      { type: 'Feature', geometry: lineAt(C, 50), properties: { highway: 'path' } },
      { type: 'Feature', geometry: footprint(far, 10, 10), properties: { building: 'yes' } },
    ] }
    expect(osmConflicts(site, fc).map((c) => c.label)).toEqual(['building', 'highway=residential "Main St"'])
    expect(siteQuery([1, 2, 3, 4])).toContain('way["building"](2,1,4,3);')
    expect(siteQuery([1, 2, 3, 4], [0, 1, 5, 6])).toContain('way["highway"](1,0,6,5);')
  })

  it('surveys development to keep: roads on and near the site, buildings on it', () => {
    const east = [C[0] + 400 / (111320 * Math.cos((C[1] * Math.PI) / 180)), C[1]] // 400 m east: outside the site, within reach
    const fc: FeatureCollection = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: footprint(C, 10, 10), properties: { building: 'house', 'building:levels': '2', osm_id: 'way/1' } },
      { type: 'Feature', geometry: lineAt(east, 100), properties: { highway: 'primary', name: 'Coast Rd' } },
      { type: 'Feature', geometry: lineAt(far, 100), properties: { highway: 'primary' } },
      { type: 'Feature', geometry: lineAt(C, 50), properties: { highway: 'path' } },
    ] }
    const plot = makeFeature('plot', footprint(C, 20, 30))
    const sv = surveyOf(site, [plot], fc, classifyForeign)
    expect(sv.conflicts.map((c) => c.label)).toEqual([expect.any(String), 'building']) // the road outside isn't a conflict
    expect(sv.roads).toHaveLength(1)
    expect(sv.roads[0].width).toBeGreaterThan(10) // primary → arterial width
    expect(sv.obstacles).toHaveLength(2) // the project plot + the OSM building
    expect(sv.adds.map((a) => [a.draft.type, a.draft.attrs.status, a.road])).toEqual([['building', 'existing', undefined], ['road-arterial', 'existing', 0]])
    expect(sv.adds[0].draft.attrs.floors).toBe(2)
    expect(sv.water).toEqual([])
  })

  it('clips kept roads and rivers to the surveyed area, not their whole OSM length', () => {
    const fc: FeatureCollection = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: lineAt(C, 30000), properties: { highway: 'secondary' } }, // Overpass returns whole ways
      { type: 'Feature', geometry: lineAt(C, 30000), properties: { waterway: 'river' } },
    ] }
    const sv = surveyOf(site, [], fc, classifyForeign)
    const [w, s, e, n] = turf.bbox(turf.buffer(turf.feature(site), 520, { units: 'meters' })!)
    expect(sv.adds.map((a) => a.draft.type)).toEqual(['road-arterial', 'lake'])
    for (const a of sv.adds) {
      const [x0, y0, x1, y1] = turf.bbox(a.draft.geometry as any)
      expect(x0 >= w && y0 >= s && x1 <= e && y1 <= n, a.draft.type).toBe(true)
    }
    expect(sv.roads[0].geometry.type).toBe('LineString')
  })

  it('keeps lakes and rivers on the site as water, not as development', () => {
    const fc: FeatureCollection = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: footprint(C, 60, 40), properties: { natural: 'water', name: 'Pond' } },
      { type: 'Feature', geometry: lineAt(C, 300), properties: { waterway: 'river', width: '30' } },
      { type: 'Feature', geometry: lineAt(C, 300), properties: { waterway: 'ditch' } },
    ] }
    const lake = makeFeature('lake', footprint(C, 20, 20))
    const sv = surveyOf(site, [lake], fc, classifyForeign)
    expect(sv.conflicts).toEqual([])
    expect(sv.water).toHaveLength(3) // project lake, OSM pond, river corridor (the ditch is ignored)
    expect(turf.area(sv.water[2])).toBeGreaterThan(300 * 30 * 0.95) // tagged width used
    expect(sv.adds.map((a) => [a.draft.type, a.draft.name])).toEqual([['lake', 'Pond'], ['lake', 'Existing river']])
    expect(siteQuery([1, 2, 3, 4])).toContain('relation["natural"="water"](2,1,4,3);')
  })

  it('assembles multipolygon water relations from their member ways, with islands as holes', () => {
    const sq = (x0: number, y0: number, s: number) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]
    const g = (pts: number[][]) => pts.map(([lon, lat]) => ({ lon, lat }))
    const outer = sq(0, 0, 1)
    const json = { elements: [{ type: 'relation', id: 7, tags: { type: 'multipolygon', natural: 'water' }, members: [
      { type: 'way', role: 'outer', geometry: g(outer.slice(0, 3)) },
      { type: 'way', role: 'outer', geometry: g(outer.slice(2).reverse()) }, // reversed segment
      { type: 'way', role: 'inner', geometry: g(sq(0.4, 0.4, 0.2)) },
    ] }] }
    const [f] = overpassToGeoJSON(json).features
    expect(f.geometry).toMatchObject({ type: 'Polygon' })
    expect((f.geometry as any).coordinates).toHaveLength(2)
    expect(f.properties).toMatchObject({ natural: 'water', osm_id: 'relation/7' })
  })
})
