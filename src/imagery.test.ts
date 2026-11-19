import { describe, expect, it } from 'vitest'
import { imageryNote, type ConstructionResult } from './imagery'

const sq = (area_m2: number) => ({ type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { area_m2 } })
const res = (over: Partial<ConstructionResult>): ConstructionResult => ({
  status: 'ok', now: '2026-11-10', before: '2025-11-12', patches: { type: 'FeatureCollection', features: [] }, attribution: 'Contains modified Copernicus Sentinel data 2026', ...over,
})

describe('imageryNote', () => {
  it('warns about changed areas with dates and hectares', () => {
    const n = imageryNote(res({ patches: { type: 'FeatureCollection', features: [sq(3000), sq(5000)] } }))
    expect(n.tone).toBe('warn')
    expect(n.text).toBe('Satellite imagery (Sentinel-2, 10 Nov 2026 vs 12 Nov 2025): 2 area(s) changed recently, 0.8 ha — possible construction. Check on the ground.')
  })
  it('reports no change, never as proof', () => {
    expect(imageryNote(res({}))).toEqual({ tone: 'info', text: 'Satellite imagery (Sentinel-2, 10 Nov 2026 vs 12 Nov 2025): no recent change detected (10 m pixels: a single new house can be missed).' })
  })
  it('says when no clear image exists', () => {
    expect(imageryNote(res({ status: 'no-clear-image', now: null })).text).toBe('Satellite imagery: no clear (cloud-free) image of this site in the last 60 days — construction not checked.')
  })
  it('says unavailable on errors', () => {
    expect(imageryNote(new Error('502 Bad Gateway'))).toEqual({ tone: 'info', text: 'Imagery check unavailable (502 Bad Gateway).' })
  })
})
