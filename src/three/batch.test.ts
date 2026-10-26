import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { FLOOR_HEIGHT } from '../model'
import { batchBuildings } from './batch'
import { buildingModel, type BuildingInput } from './buildings'

type XY = [number, number]
const rect = (w: number, d: number, x = 0): XY[] => [[x - w / 2, -d / 2], [x + w / 2, -d / 2], [x + w / 2, d / 2], [x - w / 2, d / 2], [x - w / 2, -d / 2]]
const inp = (x: number, color = ''): BuildingInput => ({ type: 'apartment', style: 'western', ring: rect(40, 16, x), holes: [], base: 0, height: 6 * FLOOR_HEIGHT, floors: 6, color, seed: 7 })
const meshesOf = (g: THREE.Object3D) => { const out: THREE.Mesh[] = []; g.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh) }); return out }
const isDetail = (g: THREE.Group, m: THREE.Mesh) => { for (let p = m.parent; p; p = p.parent) if (p === g.userData.details) return true; return false }
/** Triangles not collapsed to a point (hidden ranges are zeroed). */
const visibleTris = (m: THREE.Mesh) => { const p = m.geometry.attributes.position.array; let n = 0; for (let i = 0; i < p.length; i += 9) if (p[i] || p[i + 1] || p[i + 2] || p[i + 3] || p[i + 4] || p[i + 5] || p[i + 6] || p[i + 7] || p[i + 8]) n++; return n }
const tris = (m: THREE.Mesh) => m.geometry.attributes.position.count / 3

describe('batchBuildings', () => {
  const a = buildingModel(inp(0)), b = buildingModel(inp(100, '#123456'))
  const all = [{ id: 'a', group: a }, { id: 'b', group: b }]

  it('makes one batch per material and detail/body kind, holding every mesh once', () => {
    const { meshes } = batchBuildings(all)
    const keys = new Set(all.flatMap(({ group }) => meshesOf(group).map((m) => `${(m.material as THREE.Material).uuid}:${isDetail(group, m)}`)))
    expect(meshes.length).toBe(keys.size)
    const src = [...meshesOf(a), ...meshesOf(b)]
    expect(meshes.reduce((n, m) => n + tris(m), 0)).toBe(src.reduce((n, m) => n + tris(m), 0))
    for (const m of meshes) expect(Array.isArray(m.material)).toBe(false)
  })

  it('keeps a user-coloured wall in its own batch', () => {
    const { meshes } = batchBuildings(all)
    const own = meshes.filter((m) => '#' + (m.material as THREE.MeshStandardMaterial).color.getHexString() === '#123456')
    expect(own.length).toBe(1)
    expect(tris(own[0])).toBe(meshesOf(b).filter((m) => m.userData.part === 'wall').reduce((n, m) => n + tris(m), 0))
  })

  it('hides and shows one building per kind', () => {
    const bt = batchBuildings(all), total = () => bt.meshes.reduce((n, m) => n + visibleTris(m), 0)
    const n = total(), aBody = meshesOf(a).filter((m) => !isDetail(a, m)).reduce((k, m) => k + tris(m), 0), aAll = meshesOf(a).reduce((k, m) => k + tris(m), 0)
    bt.setVisible('a', 'body', false)
    expect(total()).toBe(n - aBody)
    bt.setVisible('a', 'body', false) // idempotent
    expect(total()).toBe(n - aBody)
    bt.setVisible('a', 'details', false)
    expect(total()).toBe(n - aAll)
    bt.setVisible('a', 'body', true); bt.setVisible('a', 'details', true)
    expect(total()).toBe(n)
  })

  it('handles no buildings and unknown ids', () => {
    const bt = batchBuildings([])
    expect(bt.meshes).toEqual([])
    expect(() => bt.setVisible('x', 'body', false)).not.toThrow()
  })
})
