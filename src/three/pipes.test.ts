import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { FlowNet } from '../pipeflow'
import { ghost, pipeMeshes, preferPipe } from './pipes'

const net = (): FlowNet => ({
  pipes: [
    { id: 'w1', network: 'water', pts: [[0, 0, -1.2], [50, 0, -1.2], [100, 0, -1.2]], diameter: 150, speed: 1, connected: true },
    { id: 'w2', network: 'water', pts: [[0, 40, -1.2], [100, 40, -1.2]], diameter: 150, speed: 1, connected: true },
    { id: 's1', network: 'sewer', pts: [[0, -40, -1.5], [100, -40, -2]], diameter: 225, speed: 0.6, connected: false },
  ],
  manholes: [[0, -40, -1.5, 0], [100, -40, -2, 0]],
})
const water = (p: ReturnType<typeof pipeMeshes>) => p.group.children.find((m) => m.userData.network === 'water') as THREE.Mesh

describe('pipeMeshes', () => {
  it('builds one mesh per network plus manholes', () => {
    const p = pipeMeshes(net())
    expect(p.group.children.length).toBe(3)
    expect(p.group.children.every((m) => (m as THREE.Mesh).isMesh && !m.castShadow)).toBe(true)
  })

  it('runs the flow attribute along the flow direction', () => {
    const g = water(pipeMeshes(net())).geometry, pos = g.attributes.position, flow = g.attributes.flow
    // w1 runs east: flow grows with x (scene x = e)
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i)) < 1) { if (pos.getX(i) < 1) lo = Math.min(lo, flow.getX(i)); if (pos.getX(i) > 99) hi = Math.max(hi, flow.getX(i)) }
    expect(lo).toBeCloseTo(0, 5)
    expect(hi).toBeCloseTo(100, 5)
  })

  it('picks the pipe that was hit', () => {
    const p = pipeMeshes(net())
    p.group.updateMatrixWorld(true)
    const ray = new THREE.Raycaster(new THREE.Vector3(50, 20, -40), new THREE.Vector3(0, -1, 0)) // above w2 (n = 40 → z = −40)
    const hit = ray.intersectObjects(p.group.children, false)[0]
    expect(p.pick(hit)).toBe('w2')
  })

  it('only writes uniforms on setTime', () => {
    const p = pipeMeshes(net()), m = water(p), at = m.geometry.attributes.position as THREE.BufferAttribute, v = at.version
    p.setTime(5)
    expect(at.version).toBe(v)
    expect((m.material as THREE.Material).userData.uniforms.uTime.value).toBe(5)
  })

  it('animates only connected pipes', () => {
    const p = pipeMeshes(net()), sewer = p.group.children.find((m) => m.userData.network === 'sewer') as THREE.Mesh
    const live = sewer.geometry.attributes.live
    for (let i = 0; i < live.count; i++) expect(live.getX(i)).toBe(0)
    const wl = water(p).geometry.attributes.live
    for (let i = 0; i < wl.count; i++) expect(wl.getX(i)).toBe(1)
  })
})

describe('ghost', () => {
  it('ghosts and restores without touching originals', () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#888888' })
    shared.userData.shared = true
    const a = new THREE.Mesh(new THREE.BoxGeometry(), shared), b = new THREE.Mesh(new THREE.BoxGeometry(), shared)
    b.userData.batch = true
    const root = new THREE.Group(); root.add(a, b)
    ghost([root], true, (o) => (o.userData.batch ? 0.12 : 0.25))
    const ga = a.material as THREE.MeshStandardMaterial, gb = b.material as THREE.MeshStandardMaterial
    expect(ga).not.toBe(shared)
    expect(ga.transparent && !ga.depthWrite && ga.opacity === 0.25).toBe(true)
    expect(gb.opacity).toBe(0.12)
    expect(shared.transparent).toBe(false); expect(shared.opacity).toBe(1)
    ghost([root], true, () => 0.5) // idempotent
    expect(a.material).toBe(ga)
    ghost([root], false, () => 0)
    expect(a.material).toBe(shared); expect(b.material).toBe(shared)
  })
})

describe('ghost colours and pipe picking', () => {
  it('follows the original colour when a cached ghost is reused', () => {
    const own = new THREE.MeshStandardMaterial({ color: '#00e5ff' }) // selected (highlight) colour
    const m = new THREE.Mesh(new THREE.BoxGeometry(), own), root = new THREE.Group(); root.add(m)
    ghost([root], true, () => 0.25)
    ghost([root], false, () => 0)
    own.color.set('#777777') // deselected while the view was un-ghosted
    ghost([root], true, () => 0.25)
    expect((m.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('777777')
  })

  it('prefers a pipe hit over the see-through surface above it', () => {
    const road = new THREE.Mesh(new THREE.BoxGeometry()), pipe = new THREE.Mesh(new THREE.BoxGeometry())
    pipe.userData.pipe = true
    const hits = [{ object: road, distance: 10 }, { object: pipe, distance: 12 }] as unknown as THREE.Intersection[]
    expect(preferPipe(hits)?.object).toBe(pipe)
    expect(preferPipe([hits[0]])?.object).toBe(road)
    expect(preferPipe([])).toBeUndefined()
  })
})
