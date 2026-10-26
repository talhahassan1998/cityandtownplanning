import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as turf from '@turf/turf'
import { footprint, frame, lineAt } from '../geo'
import { newProject, type PlanFeature, type Settings } from '../model'
import { advanceHour, clockLabel, sunDirection, sunPosition } from './sun'
import { laneLayout } from './traffic'
import { NIGHT } from './facades'
import { lngLatToTile, mosaicSampler, mosaicUV, terrariumHeight, tilesFor, type Elevation } from './terrain'
import { layWaterSewer } from '../utilities'
import { memoOnFeatures } from './scene'
import { buildScene, buildTerrain, conformSurface, nearCentre, terrainGrid, orientedBox, sceneBounds, setDetailVisibility } from './scene'

const C: [number, number] = [67.0, 24.86]
const P = newProject()
const layer = (k: string) => P.layers.find((l) => l.kind === k)!.id
let n = 0
const feat = (type: string, layerKind: string, geometry: any, attrs: any = {}): PlanFeature => {
  const id = `${type}-${++n}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: layer(layerKind), type, name: type, attrs } }
}
const opts = { exaggeration: 1, selection: new Set<string>(), trees: true, streetLights: true }
const bboxOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o)

describe('sun', () => {
  it('is overhead at noon on the equator at the equinox', () => {
    expect(sunPosition(0, 80, 12).elevation).toBeGreaterThan(88)
  })
  it('rises in the east and sets in the west', () => {
    const am = sunPosition(25, 172, 7), pm = sunPosition(25, 172, 17)
    expect(am.azimuth).toBeGreaterThan(45); expect(am.azimuth).toBeLessThan(135)
    expect(pm.azimuth).toBeGreaterThan(225); expect(pm.azimuth).toBeLessThan(315)
  })
  it('is due south and lower in winter at northern latitudes', () => {
    const w = sunPosition(51.5, 355, 12), s = sunPosition(51.5, 172, 12)
    expect(w.azimuth).toBeCloseTo(180, 0)
    expect(w.elevation).toBeCloseTo(90 - 51.5 - 23.4, 0)
    expect(s.elevation).toBeCloseTo(90 - 51.5 + 23.4, 0)
    const [x, y, z] = sunDirection(51.5, 355, 12)
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
    expect(z).toBeGreaterThan(0) // south is +z in scene axes
  })
  it('is below the horizon at midnight', () => {
    expect(sunPosition(25, 172, 0).elevation).toBeLessThan(0)
  })
  it('advances the clock and wraps at 24 h', () => {
    expect(advanceHour(10, 1, 3600)).toBeCloseTo(11)
    expect(advanceHour(23.5, 1, 3600)).toBeCloseTo(0.5)
    expect(advanceHour(10, 2, 1)).toBeCloseTo(10 + 2 / 3600)
  })
  it('formats the clock without HH:60', () => {
    expect([10.999, 23.995, 7.5].map(clockLabel)).toEqual(['11:00', '00:00', '07:30'])
  })
})

describe('terrain tiles', () => {
  it('decodes terrarium pixels', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0)
    expect(terrariumHeight(128, 100, 128)).toBeCloseTo(100.5, 6)
  })
  it('converts lng/lat to tiles and picks a bounded tile range', () => {
    expect(lngLatToTile(0, 0, 1)).toEqual([1, 1])
    const r = tilesFor([C[0] - 0.01, C[1] - 0.01, C[0] + 0.01, C[1] + 0.01], 36, 15)
    expect(r.cols * r.rows).toBeLessThanOrEqual(36)
    expect(r.z).toBeGreaterThanOrEqual(13)
    const [u, v] = mosaicUV(r, C[0], C[1])
    expect(u).toBeGreaterThan(0); expect(u).toBeLessThan(1); expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1)
  })
  it('samples a mosaic bilinearly', () => {
    const r = { z: 10, x0: 0, y0: 0, cols: 1, rows: 1 }
    const data = new Float32Array(256 * 256).map((_, i) => i % 256) // rises 1 m per pixel eastward
    const el = mosaicSampler(r, data)
    const tileW = 360 / 1024
    expect(el.at(-180 + tileW * (100.5 / 256), 85)).toBeCloseTo(100, 0)
    expect(el.min).toBe(0); expect(el.max).toBe(255)
  })
})

describe('roofs', () => {
  const rect: [number, number][] = [[-10, -4], [10, -4], [10, 4], [-10, 4], [-10, -4]]
  it('finds the oriented box of a rotated rectangle', () => {
    const a = 0.5, rot = rect.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as [number, number])
    const b = orientedBox(rot)
    expect(b.hx).toBeCloseTo(10, 6); expect(b.hy).toBeCloseTo(4, 6)
    expect(Math.abs(Math.cos(b.angle - a))).toBeCloseTo(1, 6)
  })
})

describe('scene', () => {
  const house = feat('house', 'buildings', footprint(C, 10, 12), { floors: 2, height: 6.4, roof: 'gable' })
  const plot = feat('plot', 'parcels', footprint([C[0] + 0.001, C[1]], 15, 30), { zoning: 'residential' })
  const park = feat('park', 'green', footprint([C[0] - 0.002, C[1]], 80, 60))
  const road = feat('road', 'roads', lineAt([C[0], C[1] - 0.001], 200), { width: 9, lanes: 2 })
  const all = [house, plot, park, road]
  const { origin, bounds } = sceneBounds(all, C)

  it('extrudes buildings to their height and adds the roof on top (flat ground)', () => {
    const s = buildScene(all, P.layers, origin, bounds, opts)
    const parts = s.pickables.filter((o) => o.userData.id === house.id)
    const body = parts.find((o) => o.userData.body)!
    const b = bboxOf(body)
    expect(b.max.y).toBeCloseTo(6.4, 1)
    expect(b.max.x - b.min.x).toBeCloseTo(10, 0)
    expect(Math.max(...parts.map((p) => bboxOf(p).max.y))).toBeGreaterThanOrEqual(6.4 + 0.6 * 5 - 0.01) // gable ridge (+ chimney)
    s.dispose()
  })

  it('places trees in parks deterministically and lights along roads', () => {
    const a = buildScene(all, P.layers, origin, bounds, opts), b = buildScene(all, P.layers, origin, bounds, opts)
    const counts = (s: ReturnType<typeof buildScene>) => s.group.children.filter((c) => c instanceof THREE.InstancedMesh).map((c) => (c as THREE.InstancedMesh).count)
    expect(counts(a)).toEqual(counts(b))
    const [trunks, , poles] = counts(a)
    expect(trunks).toBeCloseTo(4800 / 180, -1) // park 80×60 at 1 tree / 180 m²
    expect(poles).toBeGreaterThan(8) // 200 m road, both sides every 35 m
    a.dispose(); b.dispose()
  })

  it('picks plots through the merged mesh', () => {
    const s = buildScene(all, P.layers, origin, bounds, opts)
    const ray = new THREE.Raycaster(new THREE.Vector3().copy(s.toScene([C[0] + 0.001, C[1]])).add(new THREE.Vector3(0, 50, 0)), new THREE.Vector3(0, -1, 0))
    const hit = ray.intersectObjects(s.pickables, false)[0]
    expect(s.pick(hit)).toBe(plot.id)
    s.dispose()
  })

  it('highlights the selection in place, only on the selected building', () => {
    const twin = feat('house', 'buildings', footprint([C[0], C[1] + 0.0005], 10, 12), { floors: 2, height: 6.4, roof: 'gable' })
    const s = buildScene([...all, twin], P.layers, origin, bounds, opts)
    const part = (id: string, p: 'cap' | 'wall') => (s.pickables.find((o) => o.userData.id === id && o.userData.part === p) as THREE.Mesh).material as THREE.MeshStandardMaterial
    const wall = (id: string) => part(id, 'wall')
    const glow = (id: string) => (wall(id).emissive.getHex() ? wall(id).emissiveIntensity : 0)
    expect(glow(house.id)).toBe(0)
    expect(part(house.id, 'cap')).toBe(part(twin.id, 'cap')) // shared roof cap (few state changes per frame)
    s.setSelection(new Set([house.id]))
    expect(glow(house.id)).toBeGreaterThan(0)
    expect(glow(twin.id)).toBe(0)
    expect(wall(house.id).onBeforeCompile).toBe(wall(twin.id).onBeforeCompile) // night windows survive the highlight
    expect(wall(house.id).userData.night).toBe(wall(twin.id).userData.night)
    s.setSelection(new Set())
    expect(glow(house.id)).toBe(0)
    let disposed = false
    wall(house.id).addEventListener('dispose', () => { disposed = true })
    s.dispose()
    expect(disposed).toBe(false) // shared materials outlive a scene
  })

  it('uses the project style unless the building overrides it', () => {
    const plain = feat('house', 'buildings', footprint(C, 10, 12), { floors: 2, height: 6.4 })
    const top = (settings: Partial<Settings>, attrs = {}) => {
      const f = { ...plain, properties: { ...plain.properties, attrs: { ...plain.properties.attrs, ...attrs } } }
      const s = buildScene([f], P.layers, origin, bounds, { ...opts, settings })
      const y = bboxOf(s.group).max.y
      s.dispose()
      return y
    }
    expect(top({})).toBeGreaterThan(top({ buildingStyle: 'gulf' })) // western pitched > gulf flat
    expect(top({ buildingStyle: 'gulf' }, { style: 'western' })).toBe(top({})) // override wins
  })

  const visibleTris = (m: THREE.Mesh) => { const p = m.geometry.attributes.position.array; let n = 0; for (let i = 0; i < p.length; i += 9) if (p[i] || p[i + 1] || p[i + 2] || p[i + 3] || p[i + 4] || p[i + 5] || p[i + 6] || p[i + 7] || p[i + 8]) n++; return n } // hidden ranges are zeroed
  const batches = (s: ReturnType<typeof buildScene>) => s.group.children.filter((c) => c.userData.batch) as THREE.Mesh[]
  const shown = (s: ReturnType<typeof buildScene>) => batches(s).reduce((n, b) => n + visibleTris(b), 0)

  it('hides building details by camera distance', () => {
    const apt = feat('apartment', 'buildings', footprint(C, 40, 16), { floors: 6, height: 19.2 })
    const s = buildScene([apt], P.layers, origin, bounds, opts)
    expect(s.details.length).toBe(1)
    const all = shown(s)
    const near = s.details[0].center.clone().add(new THREE.Vector3(0, 0, 50))
    setDetailVisibility(s, near); expect(shown(s)).toBe(all)
    setDetailVisibility(s, near.clone().add(new THREE.Vector3(5000, 0, 0))); expect(shown(s)).toBeLessThan(all)
    const far = shown(s)
    setDetailVisibility(s, null); expect(shown(s)).toBe(far)
    setDetailVisibility(s, near); expect(shown(s)).toBe(all)
    s.dispose()
  })

  it('draws buildings through batches, one copy at a time', () => {
    const twin = feat('house', 'buildings', footprint([C[0], C[1] + 0.0005], 10, 12), { floors: 2, height: 6.4, roof: 'gable' })
    const s = buildScene([house, twin, road], P.layers, origin, bounds, opts)
    expect(batches(s).length).toBeGreaterThan(0)
    const own = s.group.children.find((o) => o.userData.owner === house.id && (o as THREE.Group).isGroup)!
    const parts = s.pickables.filter((o) => o.userData.id === house.id).reduce((n, o) => n + (o as THREE.Mesh).geometry.attributes.position.count / 3, 0)
    expect(own.visible).toBe(false)
    const all = shown(s)
    s.setSelection(new Set([house.id]))
    expect(own.visible).toBe(true)
    expect(shown(s)).toBe(all - parts) // its batch copy is hidden while its own group shows
    s.setSelection(new Set())
    expect(own.visible).toBe(false)
    expect(shown(s)).toBe(all)
    s.dispose()
  })

  it('puts traffic lights at a collector crossroads', () => {
    const col = (pts: [number, number][]) => feat('road', 'roads', { type: 'LineString', coordinates: pts }, { width: 14, lanes: 2, roadClass: 'collector' })
    const s = buildScene([col([[C[0] - 0.002, C[1]], [C[0] + 0.002, C[1]]]), col([[C[0], C[1] - 0.002], [C[0], C[1] + 0.002]])], P.layers, origin, bounds, opts)
    const lamps = s.group.children.find((o) => o.userData.signalLamps) as THREE.InstancedMesh
    expect(lamps.count).toBe(12)
    s.dispose()
  })

  it('builds pipes only when underground, and restores everything after', () => {
    const F = frame(origin)
    const laid = layWaterSewer([road], (p) => F.toLocal(p) as [number, number], F.toGeo).map((d) => feat(d.type, 'utilities', d.geometry, d.attrs))
    const s = buildScene([house, road, ...laid], P.layers, origin, bounds, opts)
    const pipeMeshesIn = () => { const out: THREE.Object3D[] = []; s.group.traverse((o) => { if (o.userData.pipe && o.visible && o.parent?.visible) out.push(o) }); return out }
    const roadMesh = s.pickables.find((o) => o.userData.id === road.id) as THREE.Mesh, roadMat = roadMesh.material
    expect(pipeMeshesIn().length).toBe(0)
    s.setUnderground(true)
    expect(pipeMeshesIn().length).toBeGreaterThanOrEqual(2)
    expect(s.pickables.some((o) => o.userData.pipe)).toBe(true)
    expect((roadMesh.material as THREE.Material).transparent).toBe(true)
    s.setSelection(new Set([house.id]))
    const parts = s.pickables.filter((o) => o.userData.id === house.id) as THREE.Mesh[]
    expect(parts.every((m) => (m.material as THREE.Material).transparent)).toBe(true) // still X-ray while selected
    s.setUnderground(false)
    expect(pipeMeshesIn().length).toBe(0)
    expect(s.pickables.some((o) => o.userData.pipe)).toBe(false)
    expect(roadMesh.material).toBe(roadMat)
    const wall = parts.find((m) => m.userData.part === 'wall')!.material as THREE.MeshStandardMaterial
    expect(wall.transparent).toBe(false)
    expect(wall.emissive.getHex()).not.toBe(0) // the selection highlight is back
    s.dispose()
  })

  it('draws plain utility lines as one merged line mesh per colour', () => {
    const F = frame(origin)
    const pipe = (n: number) => feat('water-main', 'utilities', { type: 'LineString', coordinates: [F.toGeo([-50, n]), F.toGeo([50, n])] })
    const s = buildScene([pipe(0), pipe(10), pipe(20)], P.layers, origin, bounds, opts)
    expect(s.group.children.filter((o) => (o as THREE.Line).isLine).length).toBe(1)
    s.dispose()
  })

  it('hides cars, trees and lamps while underground', () => {
    const F = frame(origin)
    const laid = layWaterSewer([road], (p) => F.toLocal(p) as [number, number], F.toGeo).map((d) => feat(d.type, 'utilities', d.geometry, d.attrs))
    const s = buildScene([park, road, ...laid], P.layers, origin, bounds, opts)
    const inst = () => s.group.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count > 0)
    const shown = inst().filter((o) => o.visible).length
    expect(shown).toBeGreaterThan(0)
    s.setUnderground(true)
    expect(inst().filter((o) => o.visible).length).toBe(0)
    s.setNight(1, 22) // night shows lamp pools and beams: not while underground
    expect(inst().filter((o) => o.visible).length).toBe(0)
    s.setNight(0, 12)
    s.setUnderground(false)
    expect(inst().filter((o) => o.visible).length).toBe(shown)
    s.dispose()
  })

  it('reuses unchanged building models across rebuilds', () => {
    const twin = feat('house', 'buildings', footprint([C[0], C[1] + 0.0005], 10, 12), { floors: 2, height: 6.4, roof: 'gable' })
    const geoOf = (s: ReturnType<typeof buildScene>, id: string) => (s.pickables.find((o) => o.userData.id === id && o.userData.part === 'wall') as THREE.Mesh).geometry
    const a = buildScene([house, twin, road], P.layers, origin, bounds, opts)
    const moved = { ...twin, properties: { ...twin.properties, attrs: { ...twin.properties.attrs, floors: 3, height: 9.6 } } }
    const b = buildScene([house, moved, road], P.layers, origin, bounds, opts)
    expect(geoOf(b, house.id)).toBe(geoOf(a, house.id)) // same feature object → same model geometry
    expect(geoOf(b, twin.id)).not.toBe(geoOf(a, twin.id)) // edited → rebuilt
    a.dispose()
    expect(geoOf(b, house.id).attributes.position.count).toBeGreaterThan(0) // a's dispose doesn't break b
    const c = buildScene([house, moved, road], P.layers, origin, bounds, { ...opts, settings: { buildingStyle: 'gulf' } })
    expect(geoOf(c, house.id)).not.toBe(geoOf(b, house.id)) // style change → rebuilt
    b.dispose(); c.dispose()
  })

  it('reuses lane markings while the streets are unchanged', () => {
    const marks = (sc: ReturnType<typeof buildScene>) => (sc.group.children.find((o) => o.userData.markings) as THREE.Mesh).geometry.attributes.position.array
    const a = buildScene([house, road], P.layers, origin, bounds, opts), b = buildScene([{ ...house }, road], P.layers, origin, bounds, opts)
    expect(marks(b)).toBe(marks(a))
    const c = buildScene([house, { ...road }], P.layers, origin, bounds, opts)
    expect(marks(c)).not.toBe(marks(a))
    expect(Array.from(marks(c))).toEqual(Array.from(marks(a))) // same streets, same markings
    a.dispose(); b.dispose(); c.dispose()
  })

  it('memoises on feature identity', () => {
    let calls = 0
    const make = () => { calls++; return [calls] }
    const a = memoOnFeatures([house, road], 'k', make), b = memoOnFeatures([house, road], 'k', make)
    expect(b).toBe(a); expect(calls).toBe(1)
    memoOnFeatures([house, { ...road }], 'k', make); expect(calls).toBe(2) // an edited feature is a new object
    memoOnFeatures([house, road], 'other', make); expect(calls).toBe(3) // different origin / ground / side
    // a hit counts as recent: five newer entries later (cache holds 4), it is still cached because each lookup refreshed it
    const keep = memoOnFeatures([road], 'keep', make)
    for (const k of ['a', 'b', 'c', 'd', 'e']) { memoOnFeatures([road], k, make); expect(memoOnFeatures([road], 'keep', make)).toBe(keep) }
  })

  it('keeps park trees off a road that crosses the park', () => {
    const big = feat('park', 'green', footprint(C, 120, 120))
    const thru = feat('road', 'roads', lineAt(C, 300), { width: 12, lanes: 2 })
    const s = buildScene([big, thru], P.layers, origin, bounds, opts)
    const trunks = s.group.children.find((c) => c instanceof THREE.InstancedMesh) as THREE.InstancedMesh
    expect(trunks.count).toBeGreaterThan(30)
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), roadZ = s.toScene(C).z
    for (let i = 0; i < trunks.count; i++) { trunks.getMatrixAt(i, m); p.setFromMatrixPosition(m); expect(Math.abs(p.z - roadZ)).toBeGreaterThan(6) } // half the 12 m road
    s.dispose()
  })

  it('builds a roads-only scene without batches', () => {
    const s = buildScene([road], P.layers, origin, bounds, opts)
    expect(batches(s).length).toBe(0)
    s.dispose()
  })

  it('keeps the police light glowing when the selection clears', () => {
    const police = feat('police', 'facilities', footprint(C, 25, 20), { floors: 2, height: 6.4 })
    const s = buildScene([police], P.layers, origin, bounds, opts)
    const glow = () => s.pickables.some((o) => [(o as THREE.Mesh).material].flat().some((m) => (m as THREE.MeshStandardMaterial).emissive.getHex() > 0 && (m as THREE.MeshStandardMaterial).emissiveIntensity > 0))
    expect(glow()).toBe(true)
    s.setSelection(new Set([police.id])); s.setSelection(new Set())
    expect(glow()).toBe(true)
    s.dispose()
  })

  it('one bad building does not break the scene', () => {
    const bad = feat('house', 'buildings', { type: 'Polygon', coordinates: [[C, C, C, C]] }, { floors: 2, height: 6.4 })
    const shop = feat('shop', 'buildings', footprint(C, 12, 15), { floors: 1, height: 3.2 })
    const s = buildScene([bad, shop], P.layers, origin, bounds, opts)
    expect(s.pickables.some((o) => o.userData.id === shop.id)).toBe(true)
    s.dispose()
  })

  it('builds a terrain mesh following the elevation', async () => {
    const { buildTerrain } = await import('./scene')
    const slope: Elevation = { min: 0, max: 100, at: (lng) => (lng - C[0]) * 100000 } // 1 m per ~1.1 m east
    const t = buildTerrain(origin, bounds, slope, 1)
    const box = new THREE.Box3().setFromObject(t)
    expect(box.max.y - box.min.y).toBeGreaterThan(100)
    t.geometry.dispose()
  })

  it('omits hidden layers', () => {
    const layers = P.layers.map((l) => (l.kind === 'buildings' ? { ...l, visible: false } : l))
    const s = buildScene(all, layers, origin, bounds, opts)
    expect(s.pickables.some((o) => o.userData.id === house.id)).toBe(false)
    s.dispose()
  })

  it('drapes on terrain and keeps bridge decks above a valley', () => {
    // V-shaped valley 20 m deep along the north–south line through C
    const valley: Elevation = { min: 0, max: 20, at: (lng) => 20 * Math.min(1, Math.abs(lng - C[0]) / 0.0005) }
    const bridge = feat('road', 'roads', lineAt(C, 160), { width: 10, lanes: 2, structure: 'bridge' })
    const b = sceneBounds([bridge], C)
    const s = buildScene([bridge], P.layers, b.origin, b.bounds, { ...opts, elevation: valley, streetLights: false })
    const deck = s.pickables.find((o) => o.userData.id === bridge.id)!
    const db = bboxOf(deck)
    // abutments are at the valley rim; the deck stays high (the ground at the centre is ~20 m lower)
    expect(db.min.y).toBeGreaterThan(s.groundAt(s.toScene(C).x, s.toScene(C).z) + 15)
    const piers = s.group.children.filter((c) => c instanceof THREE.Mesh && (c.geometry as THREE.BufferGeometry).type === 'CylinderGeometry')
    expect(piers.length).toBeGreaterThan(0)
    s.dispose()
  })

  it('drapes zones and grade roads over the terrain inside their outlines, not just at the corners', () => {
    const valley: Elevation = { min: 0, max: 20, at: (lng) => 20 * Math.min(1, Math.abs(lng - C[0]) / 0.0005) }
    const zone = feat('zone', 'zoning', footprint(C, 200, 200), { zoning: 'residential' })
    const road = feat('road', 'roads', lineAt(C, 200), { width: 10, lanes: 2 }) // runs east–west across the valley
    const b = sceneBounds([zone, road], C)
    const s = buildScene([zone, road], P.layers, b.origin, b.bounds, { ...opts, elevation: valley, streetLights: false })
    const ray = new THREE.Raycaster()
    for (const f of [zone, road]) {
      const mesh = s.pickables.find((o) => o.userData.id === f.id)!
      const c = s.toScene(C)
      for (const dx of [-60, -35, -12, 0, 12, 35, 60]) {
        ray.set(new THREE.Vector3(c.x + dx, 500, c.z + 2), new THREE.Vector3(0, -1, 0))
        const hit = ray.intersectObject(mesh)[0]
        expect(hit, `${f.properties.type} at dx=${dx}`).toBeDefined()
        expect(Math.abs(hit.point.y - s.groundAt(c.x + dx, c.z + 2))).toBeLessThan(0.6)
      }
    }
    s.dispose()
  })

  it('adds shared-material vehicles on terrain when cars are on, none when off', () => {
    const valley: Elevation = { min: 0, max: 20, at: (lng) => 20 * Math.min(1, Math.abs(lng - C[0]) / 0.0005) }
    const road = feat('road-local', 'roads', lineAt(C, 300), { width: 12, lanes: 2, sidewalk: 1.5, roadClass: 'local' })
    const lot = feat('parking', 'roads', footprint([C[0], C[1] + 0.0004], 40, 25))
    const b = sceneBounds([road, lot], C)
    const vehicles = (g: THREE.Object3D) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && !!(c.material as THREE.Material).userData.shared)
    const on = buildScene([road, lot], P.layers, b.origin, b.bounds, { ...opts, elevation: valley, streetLights: false, trees: false })
    const cars = vehicles(on.group)
    expect(cars.reduce((n, m) => n + m.count, 0)).toBeGreaterThan(10)
    const m = new THREE.Matrix4(), p = new THREE.Vector3()
    for (const im of cars) for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); p.setFromMatrixPosition(m); expect(p.y).toBeGreaterThanOrEqual(on.groundAt(p.x, p.z) - 0.01) }
    let disposed = false
    ;(cars[0].material as THREE.Material).addEventListener('dispose', () => { disposed = true })
    cars[0].geometry.addEventListener('dispose', () => { disposed = true }) // cached per vehicle kind
    let freed = 0
    for (const im of cars) im.addEventListener('dispose', () => { freed++ }) // per-scene instance buffers
    on.dispose()
    expect(disposed).toBe(false) // shared materials survive scene disposal
    expect(freed).toBe(cars.length)
    const off = buildScene([road, lot], P.layers, b.origin, b.bounds, { ...opts, cars: false, streetLights: false, trees: false })
    expect(vehicles(off.group)).toHaveLength(0)
    off.dispose()
  })

  describe('moving traffic', () => {
    const road = feat('road-local', 'roads', lineAt(C, 400), { width: 12, lanes: 2, sidewalk: 1.5, roadClass: 'local' })
    const b = sceneBounds([road], C)
    const o = { ...opts, streetLights: false, trees: false, moving: true }
    const fleet = (g: THREE.Object3D) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.instanceMatrix.usage === THREE.DynamicDrawUsage)
    const snap = (ms: THREE.InstancedMesh[]) => ms.flatMap((im) => Array.from(im.instanceMatrix.array.slice(0, im.count * 16)))

    it('animates lane traffic when cars are on', () => {
      const s = buildScene([road], P.layers, b.origin, b.bounds, o)
      expect(s.traffic).toBeDefined()
      const ms = fleet(s.group)
      let before: number[] = []
      for (let i = 1; i <= 50; i++) { s.traffic!.step(0.1, 8, () => false); if (i === 40) before = snap(ms) }
      expect(ms.reduce((n, m) => n + m.count, 0)).toBeGreaterThan(0)
      expect(snap(ms)).not.toEqual(before)
      s.dispose()
    })

    it('no traffic when cars are off or on the map layer', () => {
      const off = buildScene([road], P.layers, b.origin, b.bounds, { ...o, cars: false })
      expect(off.traffic).toBeUndefined()
      off.dispose()
      const map = buildScene([road], P.layers, b.origin, b.bounds, { ...o, modelsOnly: true })
      expect(map.traffic).toBeUndefined()
      expect(map.group.children.some((c) => c instanceof THREE.InstancedMesh && c.count > 0)).toBe(true) // static lane cars
      map.dispose()
    })

    it('is static by default', () => {
      const s = buildScene([road], P.layers, b.origin, b.bounds, { ...o, moving: undefined })
      expect(s.traffic).toBeUndefined()
      expect(fleet(s.group)).toHaveLength(0)
      expect(s.group.children.some((c) => c instanceof THREE.InstancedMesh && c.count > 0)).toBe(true)
      s.dispose()
    })

    it('dispose frees fleet instances, not shared parts', () => {
      const s = buildScene([road], P.layers, b.origin, b.bounds, o)
      const ms = fleet(s.group)
      expect(ms.length).toBeGreaterThan(0)
      let shared = false, freed = 0
      ms[0].geometry.addEventListener('dispose', () => { shared = true })
      ;(ms[0].material as THREE.Material).addEventListener('dispose', () => { shared = true })
      for (const im of ms) im.addEventListener('dispose', () => { freed++ })
      s.dispose()
      expect(shared).toBe(false)
      expect(freed).toBe(ms.length)
    })
  })

  describe('night', () => {
    const road = feat('road-local', 'roads', lineAt(C, 400), { width: 12, lanes: 2, sidewalk: 1.5, roadClass: 'local' })
    const b = sceneBounds([road], C)
    const ims = (g: THREE.Object3D) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh)
    const pools = (g: THREE.Object3D) => ims(g).filter((m) => (m.material as THREE.Material).blending === THREE.AdditiveBlending && !m.userData.markings && m.geometry.type === 'CircleGeometry')
    const heads = (g: THREE.Object3D) => ims(g).find((m) => m.geometry.type === 'SphereGeometry')!

    it('lamp heads and pools follow setNight', () => {
      const s = buildScene([road], P.layers, b.origin, b.bounds, { ...opts, trees: false, cars: false })
      const pool = pools(s.group)
      expect(pool).toHaveLength(1)
      expect(pool[0].count).toBe(heads(s.group).count)
      const g = s.group
      s.setNight(1, 20)
      expect((heads(g).material as THREE.MeshStandardMaterial).emissiveIntensity).toBeCloseTo(3.0)
      expect((pool[0].material as THREE.Material).opacity).toBeCloseTo(0.55)
      expect(pool[0].visible).toBe(true)
      expect(NIGHT.home.uDark.value).toBe(1)
      s.setNight(0, 12)
      expect(pool[0].visible).toBe(false)
      expect(NIGHT.home.uDark.value).toBe(0)
      expect(s.group).toBe(g)
      s.dispose()
    })

    it('works without street lights or cars', () => {
      const s = buildScene([road], P.layers, b.origin, b.bounds, { ...opts, trees: false, streetLights: false, cars: false })
      expect(pools(s.group)).toHaveLength(0)
      expect(() => s.setNight(1, 20)).not.toThrow()
      s.setNight(0, 12)
      s.dispose()
    })

    it('darkens the moving fleet', () => {
      const s = buildScene([road], P.layers, b.origin, b.bounds, { ...opts, trees: false, moving: true })
      expect(() => { s.setNight(1, 20); s.setNight(0, 12) }).not.toThrow()
      s.dispose()
    })
  })

  it('stacks draped layers with small depth offsets that cannot swallow cars at low camera angles', () => {
    const zone = feat('zone', 'zoning', footprint(C, 200, 200), { zoning: 'residential' })
    const road = feat('road-local', 'roads', lineAt(C, 200), { width: 12, lanes: 2 })
    const b = sceneBounds([zone, road], C)
    const s = buildScene([zone, road], P.layers, b.origin, b.bounds, { ...opts, cars: false, streetLights: false })
    const off = (id: string) => (s.pickables.find((o) => o.userData.id === id) as THREE.Mesh).material as THREE.MeshStandardMaterial
    for (const id of [zone.id, road.id]) expect(off(id).polygonOffsetFactor).toBeGreaterThanOrEqual(-1)
    expect(off(road.id).polygonOffsetUnits).toBeLessThan(off(zone.id).polygonOffsetUnits) // road drawn over the zone
    s.dispose()
  })

  it('keeps draped roads on top of the visible terrain mesh, even on rippled ground', () => {
    const F = frame(C)
    const ripple: Elevation = { min: -5, max: 5, at: (lng, lat) => 5 * Math.sin(F.toLocal([lng, lat])[0] / 15) }
    const road = feat('road-local', 'roads', lineAt(C, 200), { width: 12, lanes: 2 })
    const b = sceneBounds([road], C)
    const s = buildScene([road], P.layers, b.origin, b.bounds, { ...opts, elevation: ripple, cars: false, streetLights: false })
    const terrain = buildTerrain(b.origin, b.bounds, ripple, 1)
    const mesh = s.pickables.find((o) => o.userData.id === road.id)!, ray = new THREE.Raycaster(), c = s.toScene(C)
    for (let dx = -90; dx <= 90; dx += 3.7) {
      ray.set(new THREE.Vector3(c.x + dx, 500, c.z + 1.3), new THREE.Vector3(0, -1, 0))
      const top = ray.intersectObject(mesh)[0].point.y, ground = ray.intersectObject(terrain)[0].point.y
      expect(top - ground, `dx=${dx}`).toBeGreaterThan(0.05)
      expect(top - ground).toBeLessThan(0.3)
    }
    s.dispose()
  })

  it('lays parking bay lines on sloping terrain instead of floating them', () => {
    const slope: Elevation = { min: 0, max: 50, at: (lng) => (lng - C[0]) * 20000 } // ~20% rise to the east (1° ≈ 101 km here)
    const lot = feat('parking', 'roads', footprint(C, 40, 25))
    const b = sceneBounds([lot], C)
    const s = buildScene([lot], P.layers, b.origin, b.bounds, { ...opts, elevation: slope, cars: false, streetLights: false })
    const white = new THREE.Color('#ffffff'), v = new THREE.Vector3()
    let checked = 0
    s.group.updateMatrixWorld(true)
    s.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || (m as any).isInstancedMesh || !(m.material as THREE.MeshStandardMaterial).color?.equals(white)) return
      const pos = m.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
        const d = v.y - s.groundAt(v.x, v.z)
        expect(d).toBeGreaterThan(-0.01); expect(d).toBeLessThan(0.4)
        checked++
      }
    })
    expect(checked).toBeGreaterThan(0)
    s.dispose()
  })

  it('conforms concave shapes and holes to the terrain without filling or spilling', () => {
    const b = sceneBounds([feat('zone', 'zoning', footprint(C, 300, 300))], C)
    const grid = terrainGrid(b.origin, b.bounds, { min: 0, max: 5, at: (lng) => 5 * Math.sin((lng - C[0]) * 6000) }, 1)
    const circle = (r: number, ccw = true): [number, number][] => Array.from({ length: 49 }, (_, i) => { const a = ((ccw ? 1 : -1) * i * 2 * Math.PI) / 48; return [r * Math.cos(a), r * Math.sin(a)] })
    const square = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]]
    const cases: [string, [number, number][][], number][] = [
      ['roundabout', [circle(20), circle(9, false)], Math.PI * (400 - 81)],
      ['square with hole', [square(50), square(30).reverse()], 100 * 100 - 60 * 60],
      ['U shape', [[[-50, -50], [50, -50], [50, 50], [30, 50], [30, -30], [-30, -30], [-30, 50], [-50, 50], [-50, -50]]], 100 * 100 - 60 * 80],
    ]
    const inPoly = (p: [number, number], rings: [number, number][][]) => turf.booleanPointInPolygon(p, { type: 'Polygon', coordinates: rings })
    for (const [name, rings, want] of cases) {
      const pos = conformSurface(rings, grid, 0.1).attributes.position
      let area = 0, outside = 0
      for (let i = 0; i < pos.count; i += 3) {
        const P = [0, 1, 2].map((k) => [pos.getX(i + k), -pos.getZ(i + k)] as [number, number])
        const a = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0])) / 2
        area += a
        if (!inPoly([(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3], rings)) outside += a
      }
      expect(Math.abs(area - want) / want, `${name} area`).toBeLessThan(0.01)
      expect(outside, `${name} outside`).toBeLessThan(0.5)
    }
  })

  it('survives a parking area too small for any bay line', () => {
    const lot = feat('parking', 'roads', footprint(C, 0.15, 0.15))
    const b = sceneBounds([lot], C)
    const slope: Elevation = { min: 0, max: 50, at: (lng) => (lng - C[0]) * 20000 }
    expect(() => buildScene([lot], P.layers, b.origin, b.bounds, { ...opts, elevation: slope }).dispose()).not.toThrow()
  })

  it('draws lane markings exactly on the lane layout, for either driving side', () => {
    for (const side of ['left', 'right'] as const) {
      const attrs = { width: 24, lanes: 4, sidewalk: 3, roadClass: 'arterial' }
      const road = feat('road-arterial', 'roads', lineAt(C, 300), attrs) // east–west
      const b = sceneBounds([road], C)
      const s = buildScene([road], P.layers, b.origin, b.bounds, { ...opts, cars: false, streetLights: false, settings: { drivingSide: side } })
      const marks = s.group.children.filter((o) => o.userData.markings) as THREE.Mesh[]
      expect(marks.length).toBe(1)
      const L = laneLayout(attrs, 'arterial')!, sgn = side === 'left' ? 1 : -1, c = s.toScene(C)
      const offs = L.lines.map((l) => l.off * sgn)
      const pos = marks[0].geometry.attributes.position, seen = new Set<number>()
      for (let i = 0; i < pos.count; i++) {
        const n = -(pos.getZ(i) - c.z) // scene z = −north; the road runs along the east axis
        const k = offs.findIndex((o) => Math.abs(o - n) < 0.3) // line half-width / double-line spread
        expect(k, `vertex at n=${n.toFixed(2)}`).toBeGreaterThanOrEqual(0)
        seen.add(k)
      }
      expect(seen.size).toBe(offs.length) // every line is drawn
      s.dispose()
    }
  })

  it('computes bounds with a margin around features', () => {
    const { bounds: bb } = sceneBounds([house], C, 150)
    const w = turf.distance([bb[0], C[1]], [bb[2], C[1]], { units: 'meters' })
    expect(w).toBeGreaterThan(300); expect(w).toBeLessThan(520) // margin + snapping outward to 0.001°
    // small edits keep identical bounds (so the cached terrain stays valid)
    const moved = sceneBounds([{ ...house, geometry: footprint([C[0] + 0.00001, C[1]], 10, 12) }], C, 150)
    expect(moved.bounds).toEqual(bb)
  })

  it('draws many point models (hydrants) through the batch, not one mesh each, and still picks and selects them', () => {
    const fr = frame(C)
    const pts = Array.from({ length: 200 }, (_, i) => feat('hydrant', 'utilities', { type: 'Point', coordinates: fr.toGeo([(i % 20) * 10, Math.floor(i / 20) * 10]) }))
    const { origin, bounds } = sceneBounds(pts, C)
    const s = buildScene(pts, P.layers, origin, bounds, opts)
    let visibleMeshes = 0
    s.group.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) visibleMeshes++ })
    expect(visibleMeshes).toBeLessThan(10) // a few merged meshes, not ≥ 200
    expect(s.pickables.filter((p) => p.userData.id === pts[0].id).length).toBeGreaterThan(0)
    s.setSelection(new Set([pts[0].id])) // the selected one shows its own (highlighted) copy
    const own = s.group.children.find((c) => c.userData.owner === pts[0].id)!
    expect(own.visible).toBe(true)
    s.dispose()
  })

  it('shows only the site around the map centre when a project spans far-apart sites', () => {
    const far = { ...house, id: 'far', geometry: footprint([73.47, 32.97], 10, 12) } // ~1000 km away
    const road = feat('road-local', 'roads', lineAt([C[0] + 0.05, C[1]], 200), { width: 12 }) // ~5 km away: same town
    const shown = nearCentre([house, far, road], C)
    expect(shown).toEqual([house, road])
    const r = (b: number[]) => turf.distance([b[0], b[1]], [b[2], b[3]], { units: 'kilometers' }) / 2
    expect(r(sceneBounds(shown, C).bounds)).toBeLessThan(10)
  })
})
