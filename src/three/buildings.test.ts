import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { COMPONENTS, FLOOR_HEIGHT, type BuildingStyle } from '../model'
import { buildingModel, RECIPES, WALL_COLORS, type BuildingInput } from './buildings'
import { facadeTexture } from './facades'

type XY = [number, number]
const rect = (w: number, d: number, x = 0, y = 0): XY[] => [[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2], [x - w / 2, y - d / 2]]
const inp = (type: string, style: BuildingStyle, ring = rect(12, 10), floors = 2): BuildingInput =>
  ({ type, style, ring, holes: [], base: 0, height: floors * FLOOR_HEIGHT, floors, color: '#d8c8a8', seed: 7 })
const meshes = (g: THREE.Object3D) => { const out: THREE.Mesh[] = []; g.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh) }); return out }
const verts = (g: THREE.Object3D) => meshes(g).reduce((n, m) => n + m.geometry.attributes.position.count, 0)
const bbox = (g: THREE.Object3D) => new THREE.Box3().setFromObject(g)
const STYLES = ['western', 'gulf'] as const
const RES = ['house', 'villa', 'townhouse', 'apartment', 'tower']
const COM = ['shop', 'market', 'mall', 'office', 'hotel', 'mixed-use', 'tech-park']
const CIV = ['school', 'university', 'hospital', 'clinic', 'police', 'fire', 'government', 'community', 'library', 'religious', 'station']
const IND = ['factory', 'warehouse', 'substation', 'treatment', 'pump-station', 'telecom-exchange', 'waste']
const TYPES = [...RES, ...COM, ...CIV, ...IND]
const SIZE: Record<string, [number, number, number]> = { house: [12, 10, 2], villa: [18, 20, 2], townhouse: [36, 10, 3], apartment: [40, 16, 6], tower: [25, 25, 20], shop: [12, 15, 1], market: [50, 40, 1], mall: [120, 80, 3], office: [35, 25, 10], hotel: [40, 20, 8], 'mixed-use': [30, 20, 6], 'tech-park': [60, 40, 4], school: [60, 40, 2], university: [120, 80, 4], hospital: [80, 50, 5], clinic: [20, 15, 2], police: [25, 20, 2], fire: [30, 25, 2], government: [40, 30, 3], community: [30, 25, 1], library: [25, 20, 2], religious: [30, 30, 2], station: [60, 20, 2], factory: [80, 50, 2], warehouse: [100, 40, 2] }

describe('buildingModel', () => {
  it('gives every mesh a single material (batchable)', () => {
    for (const t of ['house', 'apartment', 'shop', 'factory'])
      for (const m of meshes(buildingModel(inp(t, 'western', rect(20, 14), 3)))) expect(Array.isArray(m.material)).toBe(false)
  })

  it.each(TYPES.flatMap((t) => STYLES.map((s) => [t, s] as const)))('%s/%s builds merged, bounded, with details', (t, s) => {
    const [w, d, fl] = SIZE[t] ?? [30, 20, 2]
    const g = buildingModel(inp(t, s, rect(w, d), fl))
    expect(meshes(g).length).toBeGreaterThan(1) // a real recipe, not the fallback body
    expect(meshes(g).length).toBeLessThanOrEqual(12) // bodies are cap + wall meshes
    expect(g.userData.details).toBeInstanceOf(THREE.Group)
    const b = bbox(g)
    expect(b.min.x).toBeGreaterThanOrEqual(-w / 2 - 3); expect(b.max.x).toBeLessThanOrEqual(w / 2 + 3)
    expect(b.min.z).toBeGreaterThanOrEqual(-d / 2 - 3); expect(b.max.z).toBeLessThanOrEqual(d / 2 + 3)
    expect(b.min.y).toBeGreaterThanOrEqual(-1e-6)
  })

  it('is deterministic for the same seed and varies across seeds', () => {
    const pos = (seed: number) => meshes(buildingModel({ ...inp('house', 'gulf'), seed })).map((m) => Array.from(m.geometry.attributes.position.array).join()).join('|')
    expect(pos(7)).toBe(pos(7))
    expect(pos(7)).not.toBe(pos(8))
  })

  it('western house is pitched, gulf house is flat by default; saved roof wins', () => {
    const top = (g: THREE.Object3D) => bbox(g).max.y
    expect(top(buildingModel(inp('house', 'western')))).toBeGreaterThan(2 * FLOOR_HEIGHT + 1.5)
    expect(top(buildingModel(inp('house', 'gulf')))).toBeLessThan(2 * FLOOR_HEIGHT + 3) // parapet / stair room only
    expect(top(buildingModel({ ...inp('house', 'gulf'), roof: 'gable' }))).toBeGreaterThan(2 * FLOOR_HEIGHT + 1.5)
    expect(top(buildingModel({ ...inp('house', 'western'), roof: 'flat' }))).toBeLessThan(2 * FLOOR_HEIGHT + 3)
  })

  it('falls back for tiny footprints and unknown types', () => {
    for (const g of [buildingModel(inp('house', 'western', rect(3, 3))), buildingModel(inp('nonsense', 'gulf'))]) {
      expect(meshes(g).length).toBe(2) // plain body: cap + wall
      expect((g.userData.details as THREE.Group).children.length).toBe(0)
    }
  })

  it('keeps holes and stays in bounds for L and courtyard footprints', () => {
    const L: XY[] = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20], [0, 0]]
    const gl = buildingModel(inp('apartment', 'western', L, 4))
    const bl = bbox(gl)
    expect(bl.min.x).toBeGreaterThanOrEqual(-3); expect(bl.max.x).toBeLessThanOrEqual(23)
    const court = buildingModel({ ...inp('apartment', 'gulf', rect(30, 30), 4), holes: [rect(10, 10)] })
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0))
    const hit = ray.intersectObject(court, true).filter((h) => h.object.parent === court && h.point.y > 1)
    expect(hit.length).toBe(0) // the courtyard stays open down to the ground
  })

  it('caps repeated parts on a 50-floor tower', () => {
    const g = buildingModel(inp('apartment', 'western', rect(40, 16), 50))
    expect(meshes(g).length).toBeLessThanOrEqual(12) // bodies are cap + wall meshes
    expect(verts(g)).toBeLessThan(200_000)
  })

  it('sits on the given base and puts small parts in the details group', () => {
    const g = buildingModel({ ...inp('apartment', 'gulf', rect(40, 16), 6), base: 12 })
    expect(bbox(g).min.y).toBeCloseTo(12, 3)
    expect(meshes(g.userData.details).length).toBeGreaterThan(0)
  })

  it('caps repeated parts on huge footprints', () => {
    for (const s of STYLES) {
      const g = buildingModel(inp('mall', s, rect(120, 80), 3))
      expect(meshes(g).length).toBeLessThanOrEqual(12) // bodies are cap + wall meshes
      expect(verts(g)).toBeLessThan(200_000)
    }
  })

  it('gives shops and mixed-use a shopfront ground storey', () => {
    const maps = (g: THREE.Object3D) => meshes(g).flatMap((m) => [m.material].flat().map((x) => (x as THREE.MeshStandardMaterial).map))
    for (const s of STYLES) {
      expect(maps(buildingModel(inp('mixed-use', s, rect(30, 20), 4)))).toContain(facadeTexture(s, 'shopfront'))
      expect(maps(buildingModel(inp('mixed-use', s, rect(30, 20), 4)))).toContain(facadeTexture(s, 'apartment'))
      expect(maps(buildingModel(inp('shop', s, rect(12, 15), 1)))).toContain(facadeTexture(s, 'shopfront'))
    }
  })

  it('religious buildings follow the style: bell tower vs minaret', () => {
    const w = bbox(buildingModel(inp('religious', 'western', rect(30, 30), 2)))
    const gu = bbox(buildingModel(inp('religious', 'gulf', rect(30, 30), 2)))
    expect(w.max.y).toBeGreaterThan(2 * FLOOR_HEIGHT + 8) // bell tower
    expect(gu.max.y).toBeGreaterThan(2 * FLOOR_HEIGHT + 12) // minaret
  })

  it('police keeps its emissive light', () => {
    for (const s of STYLES) expect(meshes(buildingModel(inp('police', s, rect(25, 20)))).some((m) => [m.material].flat().some((x) => (x as THREE.MeshStandardMaterial).emissiveIntensity > 0))).toBe(true)
  })

  it('caps repeated parts on a huge warehouse', () => {
    for (const s of STYLES) {
      const g = buildingModel(inp('warehouse', s, rect(100, 40), 3))
      expect(meshes(g).length).toBeLessThanOrEqual(12) // bodies are cap + wall meshes
      expect(verts(g)).toBeLessThan(200_000)
    }
  })

  it('has a recipe for every building type in the catalogue', () => {
    const types = COMPONENTS.filter((c) => c.geom === 'polygon' && c.floors).map((c) => c.type)
    expect(types.length).toBe(25)
    for (const t of types) expect(RECIPES[t], t).toBeTypeOf('function')
  })

  it('uses realistic style wall colours unless the user picked one', () => {
    const wall = (g: THREE.Object3D) => '#' + ((meshes(g).find((m) => m.userData.part === 'wall')!.material as THREE.MeshStandardMaterial).color.getHexString())
    const auto = wall(buildingModel({ ...inp('house', 'western'), color: '' }))
    expect(auto).not.toBe('#d8c8a8')
    expect(WALL_COLORS.western.residential.map((c) => c.toLowerCase())).toContain(auto)
    expect(wall(buildingModel({ ...inp('house', 'gulf'), color: '#336699' }))).toBe('#336699')
  })

  it('gives flat roofs a plain cap, not the windowed façade', () => {
    for (const s of STYLES) {
      const ms = meshes(buildingModel(inp('apartment', s, rect(40, 16), 6)))
      const [cap, wall] = (['cap', 'wall'] as const).map((p) => ms.find((m) => m.userData.part === p)!.material as THREE.MeshStandardMaterial)
      expect(cap.map).toBeNull()
      expect(wall.map).toBe(facadeTexture(s, 'apartment'))
    }
  })

  it('spreads tech-park solar panels over the roof', () => {
    const d = bbox(buildingModel(inp('tech-park', 'western', rect(60, 40), 4)).userData.details).getSize(new THREE.Vector3())
    expect(d.x).toBeGreaterThan(60 * 0.6)
    expect(d.z).toBeGreaterThan(40 * 0.6)
  })
})
