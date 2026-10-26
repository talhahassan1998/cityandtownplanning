import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { carColor, carFleet, carMeshes, VEHICLE_SIZE, type CarSpot, vehicleParts, type VehicleKind } from './cars'

describe('vehicle models', () => {
  it('match real-world sizes (±10%)', () => {
    for (const kind of Object.keys(VEHICLE_SIZE) as VehicleKind[]) {
      const box = new THREE.Box3()
      for (const p of vehicleParts(kind)) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox!) }
      const s = box.getSize(new THREE.Vector3()), [L, W, H] = VEHICLE_SIZE[kind]
      expect(s.z / L, `${kind} length`).toBeGreaterThan(0.9); expect(s.z / L).toBeLessThan(1.1)
      expect(s.x / W, `${kind} width`).toBeGreaterThan(0.9); expect(s.x / W).toBeLessThan(1.1)
      expect(s.y / H, `${kind} height`).toBeGreaterThan(0.9); expect(s.y / H).toBeLessThan(1.1)
      expect(box.min.y).toBeGreaterThanOrEqual(-0.01) // sits on the ground
    }
  })
  it('caches geometry and shares materials', () => {
    expect(vehicleParts('sedan')).toBe(vehicleParts('sedan'))
    const a = carMeshes([{ e: 0, n: 0, y: 0, heading: 0, kind: 'sedan', seed: 1 }])
    const b = carMeshes([{ e: 5, n: 0, y: 0, heading: 0, kind: 'sedan', seed: 2 }])
    expect(a.map((m) => m.material)).toEqual(b.map((m) => m.material))
    for (const m of a) expect((m.material as THREE.Material).userData.shared).toBe(true)
  })
  it('orients a car along its heading (90° = south = scene +z)', () => {
    const ms = carMeshes([{ e: 10, n: 0, y: 0, heading: 90, kind: 'sedan', seed: 1 }])
    const box = new THREE.Box3()
    for (const m of ms) { m.computeBoundingBox(); box.union(m.boundingBox!) }
    const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
    expect(s.z).toBeGreaterThan(s.x)
    expect(c.x).toBeCloseTo(10, 0); expect(c.z).toBeCloseTo(0, 0)
  })
  it('applies pitch so the nose rises on an uphill heading', () => {
    const [m] = carMeshes([{ e: 0, n: 0, y: 0, heading: 0, kind: 'sedan', seed: 1, pitch: 10, roll: 0 }]).filter((x) => (x.material as THREE.MeshStandardMaterial).color.getHex() === 0xffffff)
    const mtx = new THREE.Matrix4(); m.getMatrixAt(0, mtx)
    const nose = new THREE.Vector3(0, 0, 2).applyMatrix4(mtx), tail = new THREE.Vector3(0, 0, -2).applyMatrix4(mtx)
    expect(nose.x).toBeGreaterThan(1.9) // heading east = scene +x
    expect(nose.y - tail.y).toBeCloseTo(4 * Math.sin((10 * Math.PI) / 180), 2)
  })

  it('carFleet poses instances and sets counts', () => {
    const fleet = carFleet({ sedan: 3, bus: 1 })
    const spot = (kind: VehicleKind, e: number): CarSpot => ({ e, n: 5, y: 1, heading: 0, kind, seed: e })
    fleet.update([spot('sedan', 10), spot('bus', 20), spot('sedan', 30)])
    const of = (kind: VehicleKind) => fleet.meshes.filter((m) => vehicleParts(kind).some((p) => p.geo === m.geometry))
    const sedans = of('sedan'), bus = of('bus')
    expect(sedans.length).toBeGreaterThan(0)
    for (const m of sedans) expect(m.count).toBe(2)
    for (const m of bus) expect(m.count).toBe(1)
    const p = new THREE.Vector3(), mtx = new THREE.Matrix4()
    sedans[0].getMatrixAt(0, mtx); p.setFromMatrixPosition(mtx)
    expect([p.x, p.y, p.z]).toEqual([10, 1, -5])
    const ref = carMeshes([spot('sedan', 10)])
    expect(sedans.map((m) => m.geometry)).toEqual(ref.map((m) => m.geometry))
    const plain = (ms: THREE.InstancedMesh[]) => ms.map((m) => m.material as THREE.Material).filter((x) => !(x as THREE.MeshStandardMaterial).emissive.getHex())
    expect(plain(sedans)).toEqual(plain(ref))
    expect(() => fleet.update([spot('sedan', 1), spot('sedan', 2), spot('sedan', 3), spot('sedan', 4), spot('hatch', 5)])).not.toThrow()
    for (const m of sedans) expect(m.count).toBe(3)
  })

  it('fleet lamps and beams follow darkness; parked cars stay dim', () => {
    const fleet = carFleet({ sedan: 3 })
    const spot = (e: number): CarSpot => ({ e, n: 5, y: 1, heading: 0, kind: 'sedan', seed: e })
    fleet.update([spot(1), spot(2), spot(3)])
    const lamp = (ms: THREE.InstancedMesh[], c: number) => ms.map((m) => m.material as THREE.MeshStandardMaterial).find((x) => x.emissive.getHex() === c)!
    const parked = carMeshes([spot(1)])
    const fl = lamp(fleet.meshes, 0xfff3c4), ft = lamp(fleet.meshes, 0x7f0000)
    expect(fl).not.toBe(lamp(parked, 0xfff3c4)); expect(ft).not.toBe(lamp(parked, 0x7f0000))
    const beams = fleet.meshes.filter((m) => (m.material as THREE.Material).userData.beam)
    expect(beams.length).toBe(1)
    expect(beams[0].count).toBe(3)
    expect(beams[0].castShadow || beams[0].receiveShadow).toBe(false)
    fleet.setDarkness(1)
    expect(fl.emissiveIntensity).toBeCloseTo(3.0); expect(ft.emissiveIntensity).toBeCloseTo(2.0)
    expect((beams[0].material as THREE.Material).opacity).toBeCloseTo(0.35)
    expect(beams[0].visible).toBe(true)
    expect(lamp(parked, 0xfff3c4).emissiveIntensity).toBeCloseTo(0.3)
    fleet.setDarkness(0)
    expect(beams[0].visible).toBe(false)
    expect(fl.emissiveIntensity).toBeCloseTo(0.3)
  })

  it('uses a realistic colour mix (mostly white, silver, grey, black)', () => {
    let neutral = 0
    for (let i = 0; i < 1000; i++) { const hsl = carColor(i).getHSL({ h: 0, s: 0, l: 0 }); if (hsl.s < 0.15) neutral++ }
    expect(neutral).toBeGreaterThanOrEqual(500)
  })
})
