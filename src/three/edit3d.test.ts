import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { footprint, lineAt } from '../geo'
import { newProject, type PlanFeature } from '../model'
import { cameraHeading, groundHit, isMovable, isRotatable, ringAngle } from './edit3d'
import { buildScene, sceneBounds } from './scene'

const C: [number, number] = [67.0, 24.86]
const P = newProject()
let n = 0
const feat = (type: string, kind: string, geometry: any): PlanFeature => {
  const id = `${type}-${++n}`
  return { type: 'Feature', id, geometry, properties: { id, layerId: P.layers.find((l) => l.kind === kind)!.id, type, name: type, attrs: {} } }
}

describe('3D editing helpers', () => {
  it('moves objects only, never roads, plots, zones or lines', () => {
    for (const [t, k] of [['house', 'buildings'], ['school', 'facilities'], ['park', 'green'], ['parking', 'roads']]) expect(isMovable(feat(t, k, footprint(C, 20, 20))), t).toBe(true)
    expect(isMovable(feat('bus-stop', 'roads', { type: 'Point', coordinates: C }))).toBe(true)
    for (const [t, k] of [['plot', 'parcels'], ['zone', 'zoning'], ['boundary', 'boundary']]) expect(isMovable(feat(t, k, footprint(C, 20, 20))), t).toBe(false)
    expect(isMovable(feat('road-local', 'roads', lineAt(C, 100)))).toBe(false)
    expect(isMovable(feat('water-main', 'utilities', lineAt(C, 100)))).toBe(false)
  })

  it('measures ring rotation clockwise from above, snapping to 15° unless free', () => {
    const o = { x: 0, z: 0 }, at = (deg: number) => ({ x: 10 * Math.cos((deg * Math.PI) / 180), z: 10 * Math.sin((deg * Math.PI) / 180) }) // +z is south: increasing angle = clockwise
    expect(ringAngle(o, { x: 10, z: 0 }, { x: 0, z: 10 }, true)).toBeCloseTo(90) // east → south
    expect(ringAngle(o, at(0), at(50), false)).toBe(45)
    expect(ringAngle(o, at(0), at(50), true)).toBeCloseTo(50)
    expect(ringAngle(o, at(170), at(-170), true)).toBeCloseTo(20) // across the seam, not −340
  })

  it('hits the ground plane when there is no terrain, and nothing when looking up', () => {
    const r = new THREE.Raycaster(new THREE.Vector3(3, 10, 4), new THREE.Vector3(0, -1, 0))
    const h = groundHit(r, null)!
    expect(h.x).toBeCloseTo(3); expect(h.y).toBeCloseTo(0); expect(h.z).toBeCloseTo(4)
    expect(groundHit(new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 1, 0)), null)).toBeNull()
  })

  it('converts scene positions back to map coordinates', () => {
    const house = feat('house', 'buildings', footprint(C, 10, 12))
    const b = sceneBounds([house], C)
    const s = buildScene([house], P.layers, b.origin, b.bounds, { exaggeration: 1, selection: new Set(), trees: false, streetLights: false, cars: false })
    const p: [number, number] = [67.0012, 24.8593], q = s.toScene(p), back = s.toGeo(q.x, q.z)
    expect(Math.abs(back[0] - p[0])).toBeLessThan(1e-7); expect(Math.abs(back[1] - p[1])).toBeLessThan(1e-7)
    s.dispose()
  })

  it('gives the compass heading the camera looks along (0 = north, 90 = east)', () => {
    const cam = (x: number, y: number, z: number) => { const c = new THREE.PerspectiveCamera(); c.position.set(x, y, z); c.lookAt(0, 0, 0); c.updateMatrixWorld(); return c }
    const o = new THREE.Vector3()
    expect(cameraHeading(cam(0, 50, 100), o)).toBeCloseTo(0, 2) // south of the target, looking north
    expect(cameraHeading(cam(-100, 50, 0), o)).toBeCloseTo(90, 2) // west, looking east
    expect(Math.abs(cameraHeading(cam(0, 50, -100), o))).toBeCloseTo(180, 2)
    expect(Number.isFinite(cameraHeading(cam(0, 100, 0.0001), o))).toBe(true) // straight down
  })

  it('offers rotation only for shapes, not for point items (they have no rotation)', () => {
    expect(isRotatable(feat('house', 'buildings', footprint(C, 10, 12)))).toBe(true)
    expect(isRotatable(feat('parking', 'roads', footprint(C, 40, 25)))).toBe(true)
    expect(isRotatable(feat('bus-stop', 'roads', { type: 'Point', coordinates: C }))).toBe(false)
    expect(isRotatable(feat('road-local', 'roads', lineAt(C, 100)))).toBe(false)
  })

  it('misses (null) past the edge of the terrain instead of hitting an endless plane', () => {
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial())
    terrain.updateMatrixWorld()
    expect(groundHit(new THREE.Raycaster(new THREE.Vector3(10, 50, 10), new THREE.Vector3(0, -1, 0)), terrain)).not.toBeNull()
    expect(groundHit(new THREE.Raycaster(new THREE.Vector3(500, 50, 0), new THREE.Vector3(0, -1, 0)), terrain)).toBeNull()
  })
})
