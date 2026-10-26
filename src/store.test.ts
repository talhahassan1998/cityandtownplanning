import { describe, expect, it } from 'vitest'
import * as turf from '@turf/turf'
import { footprint, frame } from './geo'
import { newProject } from './model'
import { makeFeature, useStore } from './store'

const C: [number, number] = [67.0, 24.86]
const reset = () => { useStore.getState().load(newProject('t')); useStore.temporal.getState().clear() }
const longEdgeBearing = (id: string) => {
  const r = (useStore.getState().features[id].geometry as any).coordinates[0]
  const sides = [0, 1].map((i) => ({ len: turf.distance(r[i], r[i + 1], { units: 'meters' }), b: turf.bearing(r[i], r[i + 1]) }))
  const b = sides.sort((x, y) => y.len - x.len)[0].b
  return ((b % 180) + 180) % 180
}

describe('rotate / scale components', () => {
  it('rotates a dropped (parametric) component and keeps its size and Rotation field in sync', () => {
    reset()
    const s = useStore.getState()
    const id = s.addFeature('townhouse', footprint(C, 36, 10))
    const before = longEdgeBearing(id)
    useStore.getState().rotateFeatures([id], 30)
    const f = useStore.getState().features[id]
    expect(f.properties.attrs.rotation).toBe(30)
    expect(turf.area(f as any)).toBeCloseTo(360, -1)
    expect(Math.abs(longEdgeBearing(id) - ((before + 30) % 180))).toBeLessThan(0.5)
  })

  it('still rotates a component after it was reshaped on the map (free-form)', () => {
    reset()
    const s = useStore.getState()
    const id = s.addFeature('townhouse', footprint(C, 36, 10))
    s.updateFeature(id, { geometry: footprint(C, 40, 12), attrs: { shape: 'custom' } }) // as after a corner drag
    const before = longEdgeBearing(id)
    useStore.getState().rotateFeatures([id], 45)
    const f = useStore.getState().features[id]
    expect(Math.abs(longEdgeBearing(id) - ((before + 45) % 180))).toBeLessThan(0.5)
    expect(turf.area(f as any)).toBeCloseTo(480, -1) // keeps its reshaped size
    expect(f.properties.attrs.rotation).toBe(45)
  })

  it('scales parametric components through width/depth', () => {
    reset()
    const id = useStore.getState().addFeature('townhouse', footprint(C, 36, 10))
    useStore.getState().scaleFeatures([id], 1.1)
    const a = useStore.getState().features[id].properties.attrs
    expect(a.width).toBeCloseTo(39.6, 6); expect(a.depth).toBeCloseTo(11, 6)
  })

  it('rotates several objects as one undo step and skips locked layers', () => {
    reset()
    const s = useStore.getState()
    const a = s.addFeature('house', footprint(C, 10, 12))
    const b = s.addFeature('house', footprint([C[0] + 0.001, C[1]], 10, 12))
    useStore.temporal.getState().clear()
    const layer = useStore.getState().features[b].properties.layerId
    useStore.getState().updateLayer(layer, { locked: true }) // locks both (same layer)
    useStore.temporal.getState().clear()
    useStore.getState().rotateFeatures([a, b], 15)
    expect(useStore.getState().features[a].properties.attrs.rotation).toBe(0) // locked → untouched
    useStore.getState().updateLayer(layer, { locked: false })
    useStore.temporal.getState().clear()
    useStore.getState().rotateFeatures([a, b], 15)
    expect(useStore.temporal.getState().pastStates).toHaveLength(1)
    useStore.temporal.getState().undo()
    expect(useStore.getState().features[a].properties.attrs.rotation).toBe(0)
  })
})

describe('addFeatures', () => {
  it('re-validates added plots against the project rules, not a stale issue', () => {
    reset()
    useStore.getState().setPlotRules({ minPlotArea: 99 })
    const p = makeFeature('plot', footprint(C, 40, 40), { frontage: 40, issue: 'Area below 1800 m²' })
    useStore.getState().addFeatures([p])
    expect(useStore.getState().features[p.id].properties.attrs.issue).toBe('')
  })
})

describe('convert selected area into a component', () => {
  it('replaces the selected area with the component, keeping its outline, as one undo step', () => {
    reset()
    const s = useStore.getState()
    const plot = s.addFeature('plot', footprint(C, 30, 20))
    const geom = useStore.getState().features[plot].geometry
    useStore.temporal.getState().clear()
    expect(useStore.getState().convertSelection('school')).toBe(true)
    const st = useStore.getState()
    expect(st.features[plot]).toBeUndefined()
    const f = st.features[st.selection[0]]
    expect(f.properties.type).toBe('school')
    expect(f.geometry).toEqual(geom)
    expect(f.properties.attrs.shape).toBe('custom') // width/depth edits won't snap it back to a rectangle
    expect(useStore.temporal.getState().pastStates).toHaveLength(1)
  })
  it('does nothing for line/point components or without a selected area', () => {
    reset()
    const s = useStore.getState()
    s.addFeature('plot', footprint(C, 30, 20))
    expect(useStore.getState().convertSelection('hydrant')).toBe(false)
    useStore.getState().select([])
    expect(useStore.getState().convertSelection('school')).toBe(false)
  })
})

describe('moveFeatures (3D drag)', () => {
  const centre = (id: string) => turf.centroid(useStore.getState().features[id] as any).geometry.coordinates
  it('moves an object by metres in one undo step, keeping its parameters', () => {
    reset()
    const id = useStore.getState().addFeature('house', footprint(C, 10, 12))
    useStore.temporal.getState().clear()
    const before = centre(id), attrs = useStore.getState().features[id].properties.attrs
    useStore.getState().moveFeatures([id], 20, 0)
    const after = centre(id)
    expect(turf.distance(before, after, { units: 'meters' })).toBeCloseTo(20, 1)
    expect(turf.bearing(before, after)).toBeCloseTo(90, 0) // east
    expect(useStore.getState().features[id].properties.attrs).toEqual(attrs)
    useStore.temporal.getState().undo()
    expect(turf.distance(before, centre(id), { units: 'meters' })).toBeLessThan(0.01)
  })
  it('leaves roads and locked layers where they are', () => {
    reset()
    const s = useStore.getState()
    const house = s.addFeature('house', footprint(C, 10, 12))
    const road = s.addFeature('road-local', { type: 'LineString', coordinates: [[66.999, 24.86], [67.001, 24.86]] })
    const roadGeom = useStore.getState().features[road].geometry
    useStore.getState().moveFeatures([house, road], 0, 15)
    expect(useStore.getState().features[road].geometry).toEqual(roadGeom)
    const layerId = useStore.getState().features[house].properties.layerId
    useStore.getState().updateLayer(layerId, { locked: true })
    const g = useStore.getState().features[house].geometry
    useStore.getState().moveFeatures([house], 30, 0)
    expect(useStore.getState().features[house].geometry).toEqual(g)
  })
})

describe('road editing', () => {
  const F = frame(C), G = (e: number, n: number) => F.toGeo([e, n]), L = (p: number[]) => F.toLocal(p)
  const near = (p: number[], e: number, n: number, tol = 0.01) => { const [x, y] = L(p); return Math.hypot(x - e, y - n) <= tol }
  const road = (pts: [number, number][], attrs = {}) => useStore.getState().addFeature('road-local', { type: 'LineString', coordinates: pts.map(([e, n]) => G(e, n)) }, { width: 12, roadClass: 'local', ...attrs })
  const coords = (id: string) => (useStore.getState().features[id].geometry as any).coordinates as number[][]

  it('curves a road when a radius is set and straightens it at 0', () => {
    reset()
    const id = road([[0, 0], [100, 0], [100, 100]])
    useStore.getState().updateFeature(id, { attrs: { curveRadius: 20 } })
    expect(coords(id).length).toBeGreaterThan(10)
    const pi = JSON.parse(String(useStore.getState().features[id].properties.attrs.pi))
    expect(pi.length).toBe(3)
    expect(near(pi[1], 100, 0)).toBe(true)
    useStore.getState().updateFeature(id, { attrs: { curveRadius: 0 } })
    expect(coords(id).length).toBe(3)
    expect(useStore.getState().features[id].properties.attrs.pi).toBeTruthy()
  })

  it('moves every road meeting at a junction, as one undo step', () => {
    reset()
    const a = road([[0, 0], [100, 0]]), b = road([[100, 0], [100, 100]]), c = road([[100, 0], [200, 0]]), d = road([[0, 300], [100, 300]])
    useStore.temporal.getState().clear()
    useStore.getState().moveRoadPoint(a, G(100, 0), G(110, 10))
    expect(near(coords(a)[1], 110, 10)).toBe(true)
    expect(near(coords(b)[0], 110, 10)).toBe(true)
    expect(near(coords(c)[0], 110, 10)).toBe(true)
    expect(near(coords(d)[1], 100, 300)).toBe(true)
    useStore.temporal.getState().undo()
    expect(near(coords(a)[1], 100, 0) && near(coords(b)[0], 100, 0) && near(coords(c)[0], 100, 0)).toBe(true)
  })

  it('recomputes a curved road at a moved junction', () => {
    reset()
    const a = road([[0, 0], [100, 0]]), b = road([[100, 0], [100, 100], [200, 100]], { curveRadius: 20 })
    useStore.getState().updateFeature(b, { attrs: { curveRadius: 20 } })
    useStore.getState().moveRoadPoint(a, G(100, 0), G(90, -10))
    const pi = JSON.parse(String(useStore.getState().features[b].properties.attrs.pi))
    expect(near(pi[0], 90, -10)).toBe(true)
    expect(near(coords(b)[0], 90, -10)).toBe(true)
  })

  it('splits a road where you click', () => {
    reset()
    const id = road([[0, 0], [200, 0]])
    useStore.getState().splitRoad(id, G(80, 3))
    const sel = useStore.getState().selection
    expect(sel.length).toBe(2)
    const [a, b] = sel.map((x) => useStore.getState().features[x])
    expect(useStore.getState().features[id]).toBeUndefined()
    expect(near((a.geometry as any).coordinates.at(-1), 80, 0)).toBe(true)
    expect(near((b.geometry as any).coordinates[0], 80, 0)).toBe(true)
    expect(a.properties.attrs).toEqual(b.properties.attrs)
    expect(a.properties.name.endsWith('(1)') && b.properties.name.endsWith('(2)')).toBe(true)
  })

  it('joins two roads that share an end', () => {
    reset()
    const a = road([[0, 0], [100, 0]], { lanes: 4 }), b = road([[200, 0], [100, 0]])
    expect(useStore.getState().joinRoads(a, b)).toBe(true)
    expect(useStore.getState().features[b]).toBeUndefined()
    const c = coords(a)
    expect(c.length).toBe(2) // straight through: the meeting point goes (ruling)
    expect(near(c[0], 0, 0) && near(c[1], 200, 0)).toBe(true)
    expect(useStore.getState().features[a].properties.attrs.lanes).toBe(4)
  })

  it('refuses to join roads that are apart', () => {
    reset()
    const a = road([[0, 0], [100, 0]]), b = road([[150, 0], [250, 0]])
    const before = useStore.getState().features
    expect(useStore.getState().joinRoads(a, b)).toBe(false)
    expect(useStore.getState().features).toBe(before)
    expect(useStore.getState().notice).toBeTruthy()
  })

  it('split then join round-trips, also for curved and 2-point roads', () => {
    for (const [pts, r] of [[[[0, 0], [100, 0], [100, 100]], 20], [[[0, 0], [100, 0]], 0]] as [[number, number][], number][]) {
      reset()
      const id = road(pts)
      if (r) useStore.getState().updateFeature(id, { attrs: { curveRadius: r } })
      const original = coords(id).map((p) => L(p))
      useStore.getState().splitRoad(id, G(50, 0))
      const [x, y] = useStore.getState().selection
      if (r) for (const k of [x, y]) expect(useStore.getState().features[k].properties.attrs.pi).toBeTruthy()
      expect(useStore.getState().joinRoads(x, y)).toBe(true)
      const back = coords(x).map((p) => L(p))
      expect(near(coords(x)[0], ...(original[0] as [number, number]))).toBe(true)
      expect(near(coords(x).at(-1)!, ...(original.at(-1) as [number, number]))).toBe(true)
      if (!r) expect(back.length).toBe(2)
    }
  })

  it('moves only the dragged point of the dragged road (short road, loop)', () => {
    reset()
    const stub = road([[0, 0], [0.5, 0]])
    useStore.getState().moveRoadPoint(stub, G(0.5, 0), G(20, 0), 1)
    expect(near(coords(stub)[0], 0, 0) && near(coords(stub)[1], 20, 0)).toBe(true) // the start stayed
    const loop = road([[0, 0], [100, 0], [100, 100], [0, 0]])
    useStore.getState().moveRoadPoint(loop, G(0, 0), G(-10, -10), 0)
    const c = coords(loop)
    expect(near(c[0], -10, -10) && near(c[c.length - 1], -10, -10)).toBe(true) // still closed
    expect(near(c[1], 100, 0)).toBe(true)
  })

  it('scales a curved road with its bend points', () => {
    reset()
    const id = road([[0, 0], [100, 0], [100, 100]])
    useStore.getState().updateFeature(id, { attrs: { curveRadius: 20 } })
    const before = JSON.parse(String(useStore.getState().features[id].properties.attrs.pi))
    useStore.getState().scaleFeatures([id], 1.5)
    const pi = JSON.parse(String(useStore.getState().features[id].properties.attrs.pi))
    expect(near(pi[0], ...(L(before[0]) as [number, number]))).toBe(false) // pi scaled too
    expect(near(coords(id)[0], ...(L(pi[0]) as [number, number]))).toBe(true) // geometry = curve of the scaled pi
  })

  it('keeps pi through rotate and design-line edits', () => {
    reset()
    const id = road([[0, 0], [100, 0], [100, 100]])
    useStore.getState().updateFeature(id, { attrs: { curveRadius: 20 } })
    const before = JSON.parse(String(useStore.getState().features[id].properties.attrs.pi))
    useStore.getState().rotateFeatures([id], 90)
    const pi = JSON.parse(String(useStore.getState().features[id].properties.attrs.pi))
    expect(near(pi[0], ...(L(before[0]) as [number, number]))).toBe(false) // rotated
    expect(near(coords(id)[0], ...(L(pi[0]) as [number, number]), 0.01)).toBe(true) // geometry follows pi
    const moved = pi.map((p: number[]) => [...p]); moved[1] = G(...(L(pi[1]).map((v, k) => v + (k ? 5 : 0)) as [number, number]))
    useStore.getState().setRoadLine(id, moved)
    const pi2 = JSON.parse(String(useStore.getState().features[id].properties.attrs.pi))
    expect(near(pi2[0], ...(L(pi[0]) as [number, number]))).toBe(true)
    expect(coords(id).length).toBeGreaterThan(10)
  })
})
