// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import { footprint, lineAt } from './geo'
import { componentDef, defaultAttrs, newProject, type PlanFeature } from './model'
import { importFeatureCollection } from './persist'
import {
  classifyForeign, csvToGeoJSON, dxfToGeoJSON, fromWKT, kmlTextToGeoJSON, overpassToGeoJSON, parseCSV,
  shapefileZipToGeoJSON, toCSV, toDXF, toKML, toShapefileZip, toWKT,
} from './formats'

const C: [number, number] = [67.0, 24.86]
const P = newProject('Formats')
const layerOf = (t: string) => P.layers.find((l) => l.kind === componentDef(t).layer)!.id
let n = 0
const feat = (type: string, geometry: any, attrs: any = {}): PlanFeature => {
  const id = `${type}-${++n}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: layerOf(type), type, name: `${type} ${n}`, attrs: { ...defaultAttrs(componentDef(type)), ...attrs } } }
}
const sample = [
  feat('plot', footprint(C, 15, 30), { plotNo: 'B1-1', zoning: 'residential' }),
  feat('road', lineAt(C, 200), { width: 12 }),
  feat('house', footprint([C[0] + 0.001, C[1]], 10, 12)),
  feat('hydrant', { type: 'Point', coordinates: [C[0], C[1] + 0.001] }),
]
const roundTripTypes = (fs: PlanFeature[]) => fs.map((f) => f.properties.type).sort()
const areaOf = (fs: PlanFeature[], t: string) => turf.area(fs.find((f) => f.properties.type === t)! as any)

describe('KML', () => {
  it('round-trips geometry, types and numeric attributes', () => {
    const fc = kmlTextToGeoJSON(toKML(sample, P.layers, 'Formats & <test>'))
    const { features, rejected } = importFeatureCollection(fc, layerOf, classifyForeign)
    expect(rejected).toEqual([])
    expect(roundTripTypes(features)).toEqual(roundTripTypes(sample))
    expect(features.find((f) => f.properties.type === 'road')!.properties.attrs.width).toBe(12)
    expect(areaOf(features, 'plot')).toBeCloseTo(450, -1)
  })
  it('rejects broken XML', () => {
    expect(() => kmlTextToGeoJSON('<kml><Document>')).toThrow(/KML/)
  })
})

describe('CSV / WKT', () => {
  it('parses quoted CSV and semicolons', () => {
    expect(parseCSV('a,b\n"x, ""y""",2\n')).toEqual([['a', 'b'], ['x, "y"', '2']])
    expect(parseCSV('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('round-trips WKT', () => {
    for (const f of sample) expect(fromWKT(toWKT(f.geometry))).toEqual(f.geometry)
    expect(fromWKT('MULTIPOINT ((1 2), (3 4))')).toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] })
  })
  it('imports lat/lon points and round-trips the WKT export', () => {
    const pts = csvToGeoJSON('name,Latitude,Longitude,kind\nWell A,24.86,67.01,water\n')
    expect(pts.features[0].geometry).toEqual({ type: 'Point', coordinates: [67.01, 24.86] })
    expect(pts.features[0].properties).toEqual({ name: 'Well A', kind: 'water' })
    const back = importFeatureCollection(csvToGeoJSON(toCSV(sample, P.layers)), layerOf, classifyForeign).features
    expect(roundTripTypes(back)).toEqual(roundTripTypes(sample))
  })
  it('explains what columns it needs', () => {
    expect(() => csvToGeoJSON('a,b\n1,2')).toThrow(/lat\/lon/)
  })
})

describe('DXF', () => {
  it('exports R12 that parses back to the same shapes, in project-relative metres', () => {
    const { fc, notes } = dxfToGeoJSON(toDXF(sample, P.layers, C), C)
    expect(notes).toEqual(['Skipped unsupported DXF entities: TEXT ×1']) // the plot-number label
    const polys = fc.features.filter((f) => f.geometry.type === 'Polygon')
    expect(polys).toHaveLength(2)
    const original = sample.filter((f) => f.geometry.type === 'Polygon').map((f) => turf.area(f as any)).sort((a, b) => a - b)
    polys.map((p) => turf.area(p)).sort((a, b) => a - b).forEach((a, i) => expect(a).toBeCloseTo(original[i], 1))
    const road = fc.features.find((f) => f.geometry.type === 'LineString')!
    expect(turf.length(road as any, { units: 'meters' })).toBeCloseTo(200, 0)
    expect(fc.features.find((f) => f.geometry.type === 'Point')).toBeDefined()
    // layer names survive and drive classification
    const parcels = importFeatureCollection(fc, layerOf, classifyForeign).features.filter((f) => f.properties.type === 'plot')
    expect(parcels).toHaveLength(1)
  })
  it('recentres drawings in absolute coordinates and says so', () => {
    const dxf = toDXF([feat('plot', footprint(C, 15, 30))], P.layers, C).replace(/\n10\r?\n(-?[\d.]+)/g, (_m, x) => `\n10\r\n${(Number(x) + 500000).toFixed(3)}`)
    const { fc, notes } = dxfToGeoJSON(dxf, C)
    expect(notes.join(' ')).toMatch(/absolute/)
    expect(turf.distance(turf.centroid(fc.features[0] as any), C, { units: 'meters' })).toBeLessThan(5)
  })
})

describe('Shapefile', () => {
  it('round-trips through a zipped shapefile set', async () => {
    const zip = await toShapefileZip(sample, P.layers)
    const fc = await shapefileZipToGeoJSON(zip)
    const back = importFeatureCollection(fc, layerOf, classifyForeign).features
    expect(roundTripTypes(back)).toEqual(roundTripTypes(sample))
    expect(areaOf(back, 'plot')).toBeCloseTo(450, -1)
  })
})

describe('OpenStreetMap', () => {
  const json = {
    elements: [
      { type: 'way', id: 1, tags: { highway: 'primary', name: 'Main Rd' }, geometry: [{ lon: 67, lat: 24.86 }, { lon: 67.002, lat: 24.86 }] },
      { type: 'way', id: 2, tags: { building: 'yes', 'building:levels': '5' }, geometry: [[67, 24.861], [67.0002, 24.861], [67.0002, 24.8612], [67, 24.8612], [67, 24.861]].map(([lon, lat]) => ({ lon, lat })) },
      { type: 'way', id: 3, tags: { leisure: 'park' }, geometry: [[67, 24.862], [67.001, 24.862], [67.001, 24.863], [67, 24.862]].map(([lon, lat]) => ({ lon, lat })) },
      { type: 'way', id: 4, tags: { landuse: 'industrial' }, geometry: [[67, 24.864], [67.001, 24.864], [67.001, 24.865], [67, 24.864]].map(([lon, lat]) => ({ lon, lat })) },
      { type: 'relation', id: 9, tags: { type: 'multipolygon' } },
    ],
  }
  it('converts ways and classifies them by tag', () => {
    const fc = overpassToGeoJSON(json)
    expect(fc.features.map((f) => f.geometry.type)).toEqual(['LineString', 'Polygon', 'Polygon', 'Polygon'])
    const fs = importFeatureCollection(fc, layerOf, classifyForeign).features
    expect(fs.map((f) => f.properties.type)).toEqual(['road-arterial', 'building', 'park', 'zone'])
    expect(fs[0].properties.name).toBe('Main Rd')
    expect(fs[0].properties.attrs.width).toBe(24) // arterial default
    expect(fs[1].properties.attrs.floors).toBe(5)
    expect(fs[3].properties.attrs.zoning).toBe('industrial')
  })
})

describe('print layout', () => {
  it('sizes frames, picks readable scale bars and escapes text', async () => {
    const { frameSize, niceLength, niceStep, printLayout, fmtScale } = await import('./print')
    expect(frameSize('A3', 'landscape')).toEqual([420 - 20 - 72 - 6, 297 - 20])
    expect(niceLength(137)).toBe(100)
    expect(niceLength(380)).toBe(200)
    expect(niceLength(0.7)).toBe(0.5)
    expect(niceStep(0.0123)).toBeCloseTo(0.002, 6)
    expect(fmtScale(2500)).toBe('1:2,500')
    const html = printLayout({
      paper: 'A3', orientation: 'landscape', title: 'Town <A>', notes: 'line 1\nline 2', png: 'data:image/png;base64,xx',
      scale: 2500, bearing: 0, xTicks: [{ pos: 0.5, label: '67.000°E' }], yTicks: [{ pos: 0.25, label: '24.860°N' }],
      scaleBar: { metres: 100, fraction: 0.12 }, legend: [{ label: 'Plots — Residential', color: '#f2c94c', kind: 'fill' }],
      crs: 'WGS 84 (EPSG:4326)', date: '2026-10-14',
    })
    expect(html).toContain('@page{size:A3 landscape')
    expect(html).toContain('Town &lt;A&gt;')
    expect(html).toContain('line 1<br>line 2')
    expect(html).toContain('1:2,500')
    expect(html).toContain('67.000°E')
    expect(html).toContain('Plots — Residential')
    expect(html).toContain('not for construction')
  })
})
