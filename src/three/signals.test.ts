import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { frame } from '../geo'
import { newProject, type PlanFeature } from '../model'
import { buildRoadGraph } from './drive'
import { signalHeads } from './signals'

const F = frame([67.0, 24.86])
const P = newProject()
let n = 0
const street = (pts: [number, number][], cls: string): PlanFeature => {
  const id = `s-${++n}`
  return { type: 'Feature', id, geometry: { type: 'LineString', coordinates: pts.map((p) => F.toGeo(p)) }, properties: { id, layerId: P.layers.find((l) => l.kind === 'roads')!.id, type: 'road-local', name: 'r', attrs: { width: 14, lanes: 2, sidewalk: 1.5, roadClass: cls } } }
}
const cross = (cls = 'collector', side: 'left' | 'right' = 'left') => buildRoadGraph([street([[-200, 0], [200, 0]], cls), street([[0, -200], [0, 200]], cls)], (p) => F.toLocal(p) as [number, number], side)
const flat = () => 0
const RED = new THREE.Color('#ff2a1a'), AMBER = new THREE.Color('#ffb300'), GREEN = new THREE.Color('#2ee66b')
const lampsOf = (h: ReturnType<typeof signalHeads>) => h.meshes.find((m) => m.userData.signalLamps)!
const colour = (m: THREE.InstancedMesh, i: number) => { const c = new THREE.Color(); m.getColorAt(i, c); return { equals: (o: THREE.Color) => Math.abs(c.r - o.r) + Math.abs(c.g - o.g) + Math.abs(c.b - o.b) < 1e-3 } }

describe('signalHeads', () => {
  it('puts one head per signalled arm', () => {
    const h = signalHeads(cross(), 'left', flat)
    expect(h.meshes.length).toBe(3)
    expect(lampsOf(h).count).toBe(12)
    expect(h.meshes.every((m) => m.count === 4 || m === lampsOf(h))).toBe(true)
    expect(signalHeads(cross('local'), 'left', flat).meshes).toEqual([])
  })

  it('lights exactly the current phase', () => {
    const g = cross(), h = signalHeads(g, 'left', flat), lamps = lampsOf(h)
    // heads in arm order; lamps per head: red, amber, green
    h.update(0)
    expect(colour(lamps, 2).equals(GREEN)).toBe(true)
    expect(colour(lamps, 0).equals(RED)).toBe(false)
    expect(colour(lamps, 3).equals(RED)).toBe(true)
    expect(colour(lamps, 5).equals(GREEN)).toBe(false)
    h.update(21)
    expect(colour(lamps, 1).equals(AMBER)).toBe(true)
    expect(colour(lamps, 2).equals(GREEN)).toBe(false)
  })

  it('only rewrites colours when a light changes', () => {
    const h = signalHeads(cross(), 'left', flat), lamps = lampsOf(h)
    h.update(1)
    const v = lamps.instanceColor!.version
    h.update(2)
    expect(lamps.instanceColor!.version).toBe(v)
    h.update(21)
    expect(lamps.instanceColor!.version).toBeGreaterThan(v)
  })

  it('places heads on the driver side', () => {
    const east = (side: 'left' | 'right') => {
      const g = cross('collector', side), hub = g.nodes.find((nd) => nd.signal)!, h = signalHeads(g, side, flat)
      const housings = h.meshes.find((m) => m.userData.signalHousings)!, m = new THREE.Matrix4(), p = new THREE.Vector3()
      // the head furthest east sits on the east arm
      let best = { n: 0, x: -Infinity, r: hub.r }
      for (let i = 0; i < housings.count; i++) { housings.getMatrixAt(i, m); p.setFromMatrixPosition(m); if (p.x > best.x) best = { n: -p.z, x: p.x, r: hub.r } }
      return best
    }
    const l = east('left'), r = east('right')
    expect(Math.sign(l.n)).toBe(-Math.sign(r.n))
    expect(l.x).toBeLessThanOrEqual(l.r + 2)
    // cars approaching from the east drive west: left-hand traffic keeps to their left = south (n < 0)
    expect(l.n).toBeLessThan(0)
  })
})
