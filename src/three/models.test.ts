import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { footprint, lineAt } from '../geo'
import { newProject, type PlanFeature } from '../model'
import { groundExtras, pointModel } from './models'
import { buildScene } from './scene'

const C: [number, number] = [67.0, 24.86]
const P = newProject()
const layer = (k: string) => P.layers.find((l) => l.kind === k)!.id
const feat = (id: string, type: string, layerKind: string, geometry: any, attrs: any = {}): PlanFeature =>
  ({ type: 'Feature', id, geometry, properties: { id, layerId: layer(layerKind), type, name: type, attrs } })
const size = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3())
const OB = { cx: 0, cy: 0, hx: 20, hy: 10, angle: 0 }

describe('procedural models', () => {
  it('gives point components real-world sized models standing on the ground', () => {
    expect(size(pointModel('hydrant', '#f00')).y).toBeGreaterThan(0.6)
    expect(size(pointModel('hydrant', '#f00')).y).toBeLessThan(1.2)
    expect(size(pointModel('water-tank', '#00f')).y).toBeGreaterThan(15)
    const stop = pointModel('bus-stop', '#000')
    expect(new THREE.Box3().setFromObject(stop).min.y).toBeCloseTo(0, 3)
    expect(size(stop).x).toBeGreaterThan(3)
  })
  it('puts details on flat component areas only', () => {
    expect(groundExtras('football', { ...OB, hx: 52.5, hy: 34 }, 0, 1)).toHaveLength(1)
    expect(groundExtras('park', OB, 0, 1)).toEqual([])
  })
})

describe('buildScene with models', () => {
  const fs = [
    feat('h', 'house', 'buildings', footprint(C, 10, 12), { floors: 2, height: 6.4, roof: 'gable' }),
    feat('y', 'hydrant', 'utilities', { type: 'Point', coordinates: C }),
    feat('r', 'road-local', 'roads', lineAt(C, 120), { width: 9, lanes: 2 }),
    feat('f', 'football', 'green', footprint([C[0] + 0.002, C[1]], 105, 68)),
  ]
  const opts = { exaggeration: 1, selection: new Set<string>(), trees: true, streetLights: true }
  it('makes every mesh of a point model pickable and highlightable', () => {
    const s = buildScene(fs, P.layers, C, [C[0] - 0.01, C[1] - 0.01, C[0] + 0.01, C[1] + 0.01], opts)
    const parts = s.pickables.filter((p) => p.userData.id === 'y')
    expect(parts.length).toBeGreaterThan(1)
    s.setSelection(new Set(['y', 'h']))
    expect(((parts[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0)
    s.dispose()
  })
  it('modelsOnly drops flat features (roads, pitches) but keeps buildings and details', () => {
    const s = buildScene(fs, P.layers, C, [C[0] - 0.01, C[1] - 0.01, C[0] + 0.01, C[1] + 0.01], { ...opts, modelsOnly: true })
    const ids = new Set(s.pickables.map((p) => p.userData.id))
    expect(ids.has('h')).toBe(true)
    expect(ids.has('y')).toBe(true)
    expect(ids.has('r')).toBe(false)
    expect(ids.has('f')).toBe(false) // the pitch surface is the 2D map's job…
    expect(s.group.children.length).toBeGreaterThan(ids.size) // …its goals and lines are still modelled
    s.dispose()
  })
})
