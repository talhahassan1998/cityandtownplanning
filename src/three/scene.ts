import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as turf from '@turf/turf'
import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson'
import { frame, orientedBox, roadSurface } from '../geo'
import { carFleet, carMeshes, type VehicleKind } from './cars'
import { buildRoadGraph, createTraffic, MAX_MOVING } from './drive'
import { signalHeads } from './signals'
import { ghost, pipeMeshes, type PipeMeshes } from './pipes'
import { pipeFlow } from '../pipeflow'
import { distTo as distToLine, laneLayout, placeCars, type LaneLayout } from './traffic'
export { orientedBox } from '../geo'
import { colorOf, componentDef, FLOOR_HEIGHT, styleOf, type Layer, type PlanFeature, type Settings } from '../model'
import { mosaicUV, type Elevation, type TileRange } from './terrain'
import { buildingModel } from './buildings'
import { batchBuildings } from './batch'
import { setFacadeNight, withNight } from './facades'
import { groundExtras, parkingLines, pointModel } from './models'

type XY = [number, number]
export type RoofStyle = 'flat' | 'gable' | 'hip' | 'pyramid'

export interface SceneOptions {
  elevation?: Elevation
  exaggeration: number
  selection: Set<string>
  trees: boolean
  streetLights: boolean
  /** Parked and stationary vehicles (default on). */
  cars?: boolean
  /** Only 3D objects (buildings, point models, area details, trees): for overlaying a 2D map that already draws the flat features. */
  modelsOnly?: boolean
  /** Lane cars drive (opt-in; never on the map layer). */
  moving?: boolean
  /** Project settings (building style). */
  settings?: Partial<Settings>
}

export interface BuiltScene {
  group: THREE.Group
  pickables: THREE.Object3D[]
  /** Feature id hit by a raycast intersection, if any. */
  pick(hit: THREE.Intersection): string | undefined
  /** Ground height (scene units) at a scene x/z position. */
  groundAt(x: number, z: number): number
  radius: number
  /** Scene position of a lng/lat on the ground. */
  toScene(p: Position): THREE.Vector3
  /** Inverse of toScene (ground position → WGS 84). */
  toGeo(x: number, z: number): Position
  /** Re-highlights the selection in place (no rebuild). */
  setSelection(ids: Set<string>): void
  /** Each building's small parts (balconies, signs, tanks…) and its centre, for distance culling. */
  details: { center: THREE.Vector3; setVisible(on: boolean): void }[]
  /** Moving lane traffic (absent when cars are off or static). `visible` takes local metres (e, n). */
  traffic?: { step(dt: number, hour: number, visible: (e: number, n: number) => boolean, draw?: boolean): void }
  /** X-ray underground view: water/sewer pipes at depth with flow (built on first use), everything else (+ `extra`, e.g. the terrain) see-through. */
  setUnderground(on: boolean, extra?: THREE.Object3D[]): void
  /** Flow animation time (s); no-op until the pipes exist. */
  pipeTime(t: number): void
  /** Night look from darkness 0..1 and solar hour: façade windows, lamp heads + pools, car lights. No rebuild. */
  setNight(darkness: number, solarHour: number): void
  dispose(): void
}

let poolTex: THREE.DataTexture | undefined
/** Radial alpha falloff for lamp pools (pixel array, no canvas; shared across scenes). */
const poolTexture = () => {
  if (!poolTex) {
    const N = 32, px = new Uint8Array(N * N * 4)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const r = Math.hypot((x + 0.5) / N - 0.5, (y + 0.5) / N - 0.5) * 2, a = Math.max(0, 1 - r) ** 2 * 255, i = (y * N + x) * 4
      px.set([255, 255, 255, a], i)
    }
    poolTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat)
    poolTex.magFilter = poolTex.minFilter = THREE.LinearFilter
    poolTex.needsUpdate = true
    poolTex.userData.shared = true
  }
  return poolTex
}

/**
 * Building models cached per feature object (features are immutable: an edit replaces only the edited one), so a
 * rebuild after one edit remakes one model, not all of them. Each scene gets fresh meshes sharing the template's
 * geometry and materials (the 3D view and the map overlay can hold the same building at once); template geometry is
 * marked shared so a scene's dispose leaves it for the next rebuild.
 */
const memo: { feats: PlanFeature[]; key: string; out: unknown }[] = []
/** Result of `make` reused while the same feature objects (identity) and key come back; a few recent entries (map overlay + 3D view). */
export function memoOnFeatures<T>(feats: PlanFeature[], key: string, make: () => T): T {
  const hit = memo.find((m) => m.key === key && m.feats.length === feats.length && m.feats.every((f, i) => f === feats[i]))
  if (hit) { memo.splice(memo.indexOf(hit), 1); memo.unshift(hit); return hit.out as T } // most recently used first
  const out = make()
  memo.unshift({ feats, key, out }); memo.length = Math.min(memo.length, 4)
  return out
}
const ids = new WeakMap<object, number>()
let nextId = 0
const idOf = (o: object | undefined) => { if (!o) return 0; if (!ids.has(o)) ids.set(o, ++nextId); return ids.get(o)! }

/** One model per point type + colour, shared by every point of it (geometry and materials marked shared):
 * hundreds of hydrants cost one template, and the clones go through the building batch. */
const pointTemplates = new Map<string, THREE.Group>()
function pointClone(type: string, color: string): THREE.Group {
  const k = `${type}|${color}`
  let tpl = pointTemplates.get(k)
  if (!tpl) {
    tpl = pointModel(type, color)
    tpl.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.geometry.userData.shared = true; for (const mt of [m.material].flat()) mt.userData.shared = true } })
    pointTemplates.set(k, tpl)
  }
  return tpl.clone()
}

const modelCache = new WeakMap<PlanFeature, { key: string; template: THREE.Group }>()
function cachedModel(f: PlanFeature, key: string, make: () => THREE.Group): THREE.Group {
  let c = modelCache.get(f)
  if (c?.key !== key) {
    const template = make()
    template.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g) g.userData.shared = true })
    modelCache.set(f, (c = { key, template }))
  }
  const copy = (src: THREE.Object3D, to: THREE.Object3D) => {
    for (const ch of src.children) {
      const m = ch as THREE.Mesh
      if (!m.isMesh) continue
      const n = new THREE.Mesh(m.geometry, m.material)
      n.castShadow = m.castShadow; n.receiveShadow = m.receiveShadow
      if (m.userData.body) n.userData.body = true
      if (m.userData.part) n.userData.part = m.userData.part
      to.add(n)
    }
  }
  const g = new THREE.Group(), details = new THREE.Group()
  details.name = 'details'
  g.add(details); g.userData.details = details
  copy(c.template, g); copy(c.template.userData.details as THREE.Object3D, details)
  return g
}

/** Shows building details within `maxDist` of the camera; a null camera hides them all. */
export function setDetailVisibility(built: BuiltScene, camera: THREE.Vector3 | null, maxDist = 400): void {
  for (const d of built.details) d.setVisible(camera !== null && camera.distanceTo(d.center) <= maxDist)
}

/** Area the 3D scene covers: all features plus a margin, or a default block around `center`. */
/** How far from the map centre the 3D views reach (m): a project may hold sites far apart. */
export const SCENE_REACH = 20000

/** The features the 3D views show: those within `reach` of the map centre, not every far-off site in the project. */
export function nearCentre(features: PlanFeature[], center: Position, reach = SCENE_REACH): PlanFeature[] {
  const f = frame(center)
  return features.filter((x) => {
    const [w, s, e, n] = turf.bbox(x), [x0, y0] = f.toLocal([w, s]), [x1, y1] = f.toLocal([e, n])
    return x1 >= -reach && x0 <= reach && y1 >= -reach && y0 <= reach
  })
}

export function sceneBounds(features: PlanFeature[], center: Position, marginM = 150): { origin: Position; bounds: [number, number, number, number] } {
  const box = features.length ? turf.bbox(turf.featureCollection(features as Feature[])) : [center[0], center[1], center[0], center[1]]
  const origin: Position = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
  const f = frame(origin)
  const [x0, y0] = f.toLocal([box[0], box[1]]), [x1, y1] = f.toLocal([box[2], box[3]])
  const m = features.length ? marginM : 400
  const [w, s] = f.toGeo([x0 - m, y0 - m]), [e, n] = f.toGeo([x1 + m, y1 + m])
  // Snap outward to a 0.001° (~100 m) lattice: ordinary edits then keep the same bounds/origin,
  // so the terrain mesh and imagery can be reused between rebuilds.
  const q = (v: number, up: boolean) => (up ? Math.ceil(v * 1000) : Math.floor(v * 1000)) / 1000
  const bounds: [number, number, number, number] = [q(w, false), q(s, false), q(e, true), q(n, true)]
  return { origin: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], bounds }
}

// --- helpers ------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)
function inRing(p: XY, r: XY[]) {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
  return inside
}
const polys = (g: Polygon | MultiPolygon): Position[][][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)

// --- terrain ---------------------------------------------------------------------------------
/** Ground height (scene units, relative to the origin) for a lng/lat. */
export function groundFn(origin: Position, elevation: Elevation | undefined, exaggeration: number) {
  if (!elevation) return () => 0
  const base = elevation.at(origin[0], origin[1])
  return (p: Position) => (elevation.at(p[0], p[1]) - base) * exaggeration
}

/**
 * Terrain mesh for the scene area, textured with the ground imagery. Built separately from the
 * features so the view can keep it across edits. Grid cells are ≥ 8 m (the elevation data is ~30 m).
 */
/**
 * The terrain as drawn: node heights on the mesh grid plus `at(e, n)`, which interpolates the very
 * triangles the mesh renders. Everything standing on the ground samples this (not the raw elevation),
 * so roads, plots, buildings and cars sit exactly on the visible surface instead of cutting through it.
 */
export function terrainGrid(origin: Position, bounds: [number, number, number, number], elevation: Elevation | undefined, exaggeration: number) {
  const f = frame(origin)
  const elev = groundFn(origin, elevation, exaggeration)
  const [e0, n0] = f.toLocal([bounds[0], bounds[1]]), [e1, n1] = f.toLocal([bounds[2], bounds[3]])
  const segs = Math.max(8, Math.min(128, Math.round(Math.max(e1 - e0, n1 - n0) / 8)))
  const cw = (e1 - e0) / segs, ch = (n1 - n0) / segs, row = segs + 1
  // node (ix, iy): east from e0, south from n1 — PlaneGeometry's vertex order
  const h = new Float32Array(row * row)
  for (let iy = 0; iy <= segs; iy++) for (let ix = 0; ix <= segs; ix++) h[ix + row * iy] = elev(f.toGeo([e0 + ix * cw, n1 - iy * ch]))
  const at = (e: number, n: number) => {
    const fx = Math.min(segs - 1e-9, Math.max(0, (e - e0) / cw)), fy = Math.min(segs - 1e-9, Math.max(0, (n1 - n) / ch))
    const ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy
    const a = h[ix + row * iy], b = h[ix + row * (iy + 1)], c = h[ix + 1 + row * (iy + 1)], d = h[ix + 1 + row * iy]
    // PlaneGeometry splits each cell into (a, b, d) and (b, c, d) along the b–d diagonal
    return u + v <= 1 ? a + u * (d - a) + v * (b - a) : c + (1 - u) * (b - c) + (1 - v) * (d - c)
  }
  return { f, e0, n0, e1, n1, segs, h, at }
}

type Grid = ReturnType<typeof terrainGrid>
/** Sutherland–Hodgman: `ring` clipped to the convex triangle `t` (any orientation). */
function clipToTriangle(ring: XY[], t: XY[]): XY[] {
  const ccw = (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]) > 0 ? 1 : -1
  let out = ring
  for (let k = 0; k < 3 && out.length; k++) {
    const a = t[k], b = t[(k + 1) % 3], side = (p: XY) => ccw * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]))
    const inp = out
    out = []
    for (let i = 0; i < inp.length; i++) {
      const p = inp[i], q = inp[(i + 1) % inp.length], sp = side(p), sq = side(q)
      if (sp >= 0) out.push(p)
      if ((sp >= 0) !== (sq >= 0)) { const r = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * r, p[1] + (q[1] - p[1]) * r]) }
    }
  }
  return out
}
/**
 * A flat shape laid exactly on the terrain mesh, `lift` metres up: the shape is cut along the mesh's
 * own triangles, and inside one triangle the ground is a plane, so no part of the terrain can poke
 * through between vertices (which any fixed subdivision allows on curved ground).
 */
export function conformSurface(rings: XY[][], grid: Grid, lift: number): THREE.BufferGeometry {
  const { e0, n1, segs } = grid, cw = (grid.e1 - e0) / segs, ch = (n1 - grid.n0) / segs
  const open = rings.map((r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r))
  const v2 = (r: XY[]) => r.map(([e, n]) => new THREE.Vector2(e, n))
  const pts = open.flat()
  const pos: number[] = []
  // triangulate the shape once (holes, concavity), then cut each triangle along the terrain triangles under it:
  // convex against convex, so the clip is exact; a fan triangulates each convex piece
  for (const tri of THREE.ShapeUtils.triangulateShape(v2(open[0]), open.slice(1).map(v2))) {
    const T = tri.map((i) => pts[i])
    const xs = T.map((p) => p[0]), ys = T.map((p) => p[1])
    const ix0 = Math.max(0, Math.floor((Math.min(...xs) - e0) / cw)), ix1 = Math.min(segs - 1, Math.floor((Math.max(...xs) - e0) / cw))
    const iy0 = Math.max(0, Math.floor((n1 - Math.max(...ys)) / ch)), iy1 = Math.min(segs - 1, Math.floor((n1 - Math.min(...ys)) / ch))
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
      const a: XY = [e0 + ix * cw, n1 - iy * ch], b: XY = [a[0], a[1] - ch], c: XY = [a[0] + cw, a[1] - ch], d: XY = [a[0] + cw, a[1]]
      for (const t of [[a, b, d], [b, c, d]]) {
        const piece = clipToTriangle(T, t)
        for (let k = 1; k + 1 < piece.length; k++) {
          let [p, q, r] = [piece[0], piece[k], piece[k + 1]]
          const area2 = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
          if (Math.abs(area2) < 1e-9) continue
          if (area2 < 0) [q, r] = [r, q] // counter-clockwise from above, like ShapeGeometry
          for (const [e, n] of [p, q, r]) pos.push(e, grid.at(e, n) + lift, -n)
        }
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

export function buildTerrain(origin: Position, bounds: [number, number, number, number], elevation: Elevation | undefined, exaggeration: number, ground?: { texture: THREE.Texture; range: TileRange }): THREE.Mesh {
  const { f, e0, n0, e1, n1, segs, h } = terrainGrid(origin, bounds, elevation, exaggeration)
  const g = new THREE.PlaneGeometry(e1 - e0, n1 - n0, segs, segs)
  const pos = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const e = pos.getX(i) + (e0 + e1) / 2, n = pos.getY(i) + (n0 + n1) / 2
    pos.setXYZ(i, e, h[i], -n)
    if (ground) { const p = f.toGeo([e, n]); const [u, v] = mosaicUV(ground.range, p[0], p[1]); uv.setXY(i, u, v) }
  }
  g.computeVertexNormals()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: ground ? 0xffffff : 0xd8d4c8, map: ground?.texture ?? null, roughness: 1 }))
  mesh.receiveShadow = true
  return mesh
}

// --- scene ----------------------------------------------------------------------------------------
export function buildScene(features: PlanFeature[], layers: Layer[], origin: Position, bounds: [number, number, number, number], o: SceneOptions): BuiltScene {
  const f = frame(origin)
  const L = (p: Position) => f.toLocal(p) as XY
  const grid = o.elevation ? terrainGrid(origin, bounds, o.elevation, o.exaggeration) : undefined
  const elevLocal = grid ? grid.at : () => 0
  const group = new THREE.Group()
  const pickables: THREE.Object3D[] = []
  const details: BuiltScene['details'] = []
  const buildings: { id: string; group: THREE.Group }[] = []
  const plainLines = new Map<string, number[]>() // drawn through per-material batches (batch.ts)
  const visible = new Set(layers.filter((l) => l.visible).map((l) => l.id))
  const shown = features.filter((x) => visible.has(x.properties.layerId))
  let owner: string | undefined // feature whose objects are being added (3D editing moves them together)
  const add = <T extends THREE.Object3D>(obj: T, pick?: string): T => { if (pick) { obj.userData.id = pick; pickables.push(obj) } if (owner) obj.userData.owner = owner; group.add(obj); return obj }

  const [e0, n0] = L([bounds[0], bounds[1]]), [e1, n1] = L([bounds[2], bounds[3]])
  const base: Record<string, { color?: string; emissive?: boolean }> = {} // per-mesh unselected look
  // draped / flat surfaces from rings in local metres
  const surface = (rings: XY[][], y: ((e: number, n: number) => number) & { lift?: number }) => {
    if (grid && y.lift !== undefined) return conformSurface(rings, grid, y.lift)
    const shape = new THREE.Shape(rings[0].slice(0, -1).map(([e, n]) => new THREE.Vector2(e, n)))
    for (const h of rings.slice(1)) shape.holes.push(new THREE.Path(h.slice(0, -1).map(([e, n]) => new THREE.Vector2(e, n))))
    const g = new THREE.ShapeGeometry(shape)
    const p = g.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) { const e = p.getX(i), n = p.getY(i); p.setXYZ(i, e, y(e, n), -n) }
    g.computeVertexNormals()
    return g
  }
  const drape = (lift: number) => Object.assign((e: number, n: number) => elevLocal(e, n) + lift, { lift }) // lift tag: lay on the terrain mesh
  const lineGeom = (pts: XY[], lift: number, step = 4) => {
    const out: THREE.Vector3[] = []
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
      for (let j = i === 1 ? 0 : 1; j <= k; j++) { const t = j / k, e = a[0] + (b[0] - a[0]) * t, n = a[1] + (b[1] - a[1]) * t; out.push(new THREE.Vector3(e, elevLocal(e, n) + lift, -n)) }
    }
    return new THREE.BufferGeometry().setFromPoints(out)
  }
  const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra })
  const SELECTED = '#00e5ff'
  // draped layers stack by depth offset (zones < areas < plots < roads), not by their few-cm lifts, which fight over terrain at
  // distance. Ordering goes in the constant (units) term; the slope term stays at −1, because a large slope factor pulls a surface
  // towards the camera at low angles and swallows the cars and kerbs standing on it.
  const layerOffset = (n: number) => ({ polygonOffsetFactor: -1, polygonOffsetUnits: -4 * n })

  // plots: one merged mesh (with a triangle → id table for picking) + merged outlines
  const plotGeoms: THREE.BufferGeometry[] = [], plotTri: { end: number; id: string }[] = [], outline: THREE.Vector3[] = []
  const plotVerts: { id: string; count: number; color: THREE.Color }[] = []
  let triTotal = 0
  for (const p of shown) {
    if (o.modelsOnly || p.properties.type !== 'plot' || p.geometry.type !== 'Polygon') continue
    const rings = p.geometry.coordinates.map((r) => r.map(L))
    const g = surface(rings, drape(0.15))
    const c = new THREE.Color(colorOf(p))
    g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => [c.r, c.g, c.b]).flat(), 3))
    plotGeoms.push(g)
    triTotal += (g.index ? g.index.count : g.attributes.position.count) / 3
    plotTri.push({ end: triTotal, id: p.id })
    plotVerts.push({ id: p.id, count: g.attributes.position.count, color: c })
    const ln = lineGeom(rings[0], 0.3).attributes.position as THREE.BufferAttribute
    for (let i = 1; i < ln.count; i++) outline.push(new THREE.Vector3().fromBufferAttribute(ln, i - 1), new THREE.Vector3().fromBufferAttribute(ln, i))
  }
  let plotMesh: THREE.Mesh | undefined
  if (plotGeoms.length) {
    plotMesh = add(new THREE.Mesh(mergeGeometries(plotGeoms), mat('#ffffff', { vertexColors: true, transparent: true, opacity: 0.6, ...layerOffset(6) })))
    plotMesh.receiveShadow = true
    pickables.push(plotMesh)
    add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(outline), new THREE.LineBasicMaterial({ color: 0x6d5a2a })))
    plotGeoms.forEach((g) => g.dispose())
  }

  // everything else
  const treeSpots: { e: number; n: number; s: number }[] = []
  const lightSpots: { e: number; n: number; y: number }[] = []
  const streets: { pts: XY[]; lay: LaneLayout; width: number }[] = []
  for (const x of shown) {
    owner = x.id
    const { type, attrs } = x.properties
    const def = componentDef(type)
    const color = colorOf(x)
    const g = x.geometry

    if (g.type === 'Point') {
      const [e, n] = L(g.coordinates)
      const m = add(pointClone(type, color))
      m.position.set(e, elevLocal(e, n), -n)
      // drawn through the building batch (one draw per material, not per hydrant): this group is the hidden pick/edit copy
      m.visible = false
      buildings.push({ id: x.id, group: m })
      m.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.userData.id = x.id; c.userData.baseMat = (c as THREE.Mesh).material; pickables.push(c) } })
      continue
    }

    if (g.type === 'LineString') {
      if (def.layer === 'roads' && !['bridge', 'tunnel'].includes(String(attrs.structure ?? 'grade'))) {
        const lay = laneLayout(attrs, String(attrs.roadClass ?? def.roadClass ?? ''))
        if (lay) streets.push({ pts: g.coordinates.map(L), lay, width: Number(attrs.width) })
      }
      if (o.modelsOnly) continue
      const pts = g.coordinates.map(L)
      if (def.layer === 'roads') {
        const width = Number(attrs.width) || 0
        const structure = String(attrs.structure ?? 'grade')
        if (structure === 'tunnel') {
          add(new THREE.Line(lineGeom(pts, 0.5), new THREE.LineDashedMaterial({ color: 0xff8a3d, dashSize: 6, gapSize: 4 }))).computeLineDistances()
          for (const end of [pts[0], pts[pts.length - 1]]) {
            const portal = add(new THREE.Mesh(new THREE.BoxGeometry(width + 2, 6, 2), mat('#5b5f66')), x.id)
            portal.position.set(end[0], elevLocal(end[0], end[1]) + 3, -end[1]); portal.castShadow = true
          }
          continue
        }
        const surf = roadSurface(x as Feature<LineString>, width)
        if (!surf) continue
        // bridges run straight between their abutments, never dipping below the ground (+0.5 m)
        let y: ((e: number, n: number) => number) & { lift?: number } = drape(0.12)
        if (structure === 'bridge') {
          const cum = [0]
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
          const total = cum[cum.length - 1] || 1, a = elevLocal(...pts[0]) + 0.5, b = elevLocal(...pts[pts.length - 1]) + 0.5
          const along = (e: number, n: number) => {
            let best = Infinity, s = 0
            for (let i = 1; i < pts.length; i++) {
              const [p, q] = [pts[i - 1], pts[i]], dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy
              const t = l2 ? Math.max(0, Math.min(1, ((e - p[0]) * dx + (n - p[1]) * dy) / l2)) : 0
              const d = Math.hypot(e - p[0] - t * dx, n - p[1] - t * dy)
              if (d < best) { best = d; s = cum[i - 1] + t * Math.sqrt(l2) }
            }
            return s
          }
          y = (e, n) => { const s = along(e, n); return Math.max(a + ((b - a) * s) / total, elevLocal(e, n) + 0.5) }
          for (let s = 15; s < total - 5; s += 25) {
            let i = 1
            while (i < cum.length - 1 && cum[i] < s) i++
            const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), e = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, n = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t
            const top = y(e, n), ground = elevLocal(e, n)
            if (top - ground < 1.5) continue
            const pier = add(new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, top - ground, 10), mat('#9aa0a6')))
            pier.position.set(e, ground + (top - ground) / 2, -n); pier.castShadow = true
          }
        }
        for (const poly of polys(surf.geometry)) {
          const m = add(new THREE.Mesh(surface(poly.map((r) => r.map(L)), y), mat(type === 'rail' ? '#6b5b4d' : structure === 'bridge' ? '#8d939b' : '#4a4f57', { side: THREE.DoubleSide, ...layerOffset(8) })), x.id)
          m.receiveShadow = true; m.castShadow = structure === 'bridge'
        }
        if (o.streetLights && type !== 'rail' && type !== 'road-cycle' && type !== 'walking-track') {
          const cum = [0]
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
          for (let s = 10; s < cum[cum.length - 1]; s += 35) {
            let i = 1
            while (i < cum.length - 1 && cum[i] < s) i++
            const [p, q] = [pts[i - 1], pts[i]], len = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / len
            const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len
            for (const side of [1, -1]) {
              const e = p[0] + (q[0] - p[0]) * t + side * nx * (width / 2 + 0.8), n = p[1] + (q[1] - p[1]) * t + side * ny * (width / 2 + 0.8)
              lightSpots.push({ e, n, y: structure === 'bridge' ? y(e, n) : elevLocal(e, n) })
            }
          }
        }
      } else if (type !== 'measure') {
        // plain lines (utility mains, paths…) merge per colour below: hundreds of laid pipes stay a few draw calls
        const v = (lineGeom(pts, 0.4).attributes.position.array as Float32Array), seg = plainLines.get(color) ?? plainLines.set(color, []).get(color)!
        for (let i = 3; i < v.length; i += 3) seg.push(v[i - 3], v[i - 2], v[i - 1], v[i], v[i + 1], v[i + 2])
      }
      continue
    }

    // polygons
    const rings = (g as Polygon).coordinates.map((r) => r.map(L))
    if (type === 'plot') continue // merged above
    if (o.modelsOnly && (type === 'boundary' || type === 'lake')) continue
    if (type === 'boundary') { add(new THREE.Line(lineGeom(rings[0], 0.6), new THREE.LineBasicMaterial({ color: 0xff7a1a }))); continue }
    const floors = Number(attrs.floors) || 0
    const height = Number(attrs.height) || floors * FLOOR_HEIGHT
    if (height > 0) {
      const ring = rings[0]
      const ev = ring.map(([e, n]) => elevLocal(e, n)), lo = Math.min(...ev), hi = Math.max(...ev)
      const input = { type, style: styleOf(attrs, o.settings), ring, holes: rings.slice(1), base: lo, height: height + (hi - lo), floors, color: /^#[0-9a-f]{6}$/i.test(String(attrs.color ?? '')) ? String(attrs.color) : '', seed: hash(x.id), roof: (attrs.roof || undefined) as RoofStyle | undefined }
      let model: THREE.Group
      try { model = cachedModel(x, `${origin.join()}|${JSON.stringify({ ...input, ring: 0, holes: 0 })}`, () => buildingModel(input)) } catch (e) { console.warn('building model failed', x.id, e); continue }
      add(model)
      model.visible = false // pick/edit copy; shown only while selected
      buildings.push({ id: x.id, group: model })
      // materials stay shared across buildings (few state changes per frame); selection swaps in highlighted copies
      model.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.userData.id = x.id; m.userData.baseMat = m.material; pickables.push(m) } })
      const ob = orientedBox(ring)
      const own = model.userData.details as THREE.Object3D, id = x.id
      details.push({ center: new THREE.Vector3(ob.cx, lo + height / 2, -ob.cy), setVisible: (on) => { own.visible = on; batches.setVisible(id, 'details', on && !model.visible) } })
      continue
    }
    if (type === 'lake') {
      const lo = Math.min(...rings[0].map(([e, n]) => elevLocal(e, n)))
      add(new THREE.Mesh(surface(rings, () => lo + 0.1), new THREE.MeshStandardMaterial({ color: '#3a8fd8', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.9 })), x.id)
      continue
    }
    const isGreen = def.layer === 'green'
    const lift = def.layer === 'roads' ? 0.12 : type === 'zone' ? 0.05 : 0.1
    if (!o.modelsOnly) add(new THREE.Mesh(surface(rings, drape(lift)), mat(isGreen ? '#7cb562' : color, { transparent: true, opacity: type === 'zone' ? 0.25 : def.layer === 'roads' ? 1 : 0.85, side: THREE.DoubleSide, ...layerOffset(type === 'zone' ? 2 : def.layer === 'roads' ? 8 : 4) })), x.id).receiveShadow = true
    const ob = orientedBox(rings[0])
    if (grid && type === 'parking') {
      // on terrain the bay lines are laid on the ground like the surfaces (a flat set would float on a slope)
      const u: XY = [Math.cos(ob.angle), Math.sin(ob.angle)], v: XY = [-u[1], u[0]]
      const at = (x: number, z: number): XY => [ob.cx + x * u[0] - z * v[0], ob.cy + x * u[1] - z * v[1]]
      const lines = parkingLines(ob.hx, ob.hy).map(([x, z]) => surface([[at(x - 0.05, z - 2.5), at(x + 0.05, z - 2.5), at(x + 0.05, z + 2.5), at(x - 0.05, z + 2.5), at(x - 0.05, z - 2.5)]], drape(lift + 0.03)))
      if (lines.length) add(new THREE.Mesh(mergeGeometries(lines), mat('#ffffff', { side: THREE.DoubleSide, ...layerOffset(10) })))
      continue
    }
    for (const d of groundExtras(type, ob, elevLocal(ob.cx, ob.cy) + lift, hash(x.id))) add(d)
    // trees scattered (deterministically) through parks and forests
    const density = { forest: 1 / 60, park: 1 / 180, garden: 1 / 120 }[type as 'forest']
    if (o.trees && density) {
      const rnd = mulberry32(hash(x.id))
      const xs = rings[0].map((p) => p[0]), ys = rings[0].map((p) => p[1])
      const [bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const want = Math.min(1500, Math.round(Math.abs(turf.area(x)) * density))
      for (let k = 0, tries = 0; k < want && tries < want * 4; tries++) {
        const p: XY = [bx0 + rnd() * (bx1 - bx0), by0 + rnd() * (by1 - by0)]
        if (inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h))) { treeSpots.push({ e: p[0], n: p[1], s: 0.75 + rnd() * 0.6 }); k++ }
      }
    }
  }

  owner = undefined
  for (const [color, seg] of plainLines) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3))
    add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })))
  }
  // ponytail: the per-building geometry stays in CPU memory beside the batches (≈2× building geometry); build groups on demand if memory bites
  const batches = batchBuildings(buildings)
  for (const b of batches.meshes) add(b)
  // lane markings from the same layout the cars use, so cars sit between the lines; gaps through junctions
  const side = o.settings?.drivingSide === 'right' ? -1 : 1
  // they depend only on the streets: reused across rebuilds that don't touch a road (≈0.3 s on a big town)
  const markArr = memoOnFeatures(shown.filter((x) => x.geometry.type === 'LineString' && componentDef(x.properties.type).layer === 'roads'),
    `marks|${origin.join()}|${bounds.join()}|${side}|${o.exaggeration}|${idOf(o.elevation)}`, () => {
  const markPos: number[] = []
  for (const st of streets) {
    const { pts, lay } = st, cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    const others = streets.filter((x) => x !== st)
    for (const line of lay.lines) {
      const offs = line.kind === 'double' ? [line.off - 0.15, line.off + 0.15] : [line.off], hw = line.kind === 'edge' ? 0.08 : 0.06
      for (let i = 1; i < pts.length; i++) {
        const [p, q] = [pts[i - 1], pts[i]], len = cum[i] - cum[i - 1]
        if (len < 0.5) continue
        const u: XY = [(q[0] - p[0]) / len, (q[1] - p[1]) / len], nl: XY = [-u[1], u[0]]
        for (let s0 = 0; s0 < len; s0 += line.kind === 'dash' ? 6 : 3) {
          const s1 = Math.min(len, s0 + 3), mid: XY = [p[0] + u[0] * (s0 + s1) / 2, p[1] + u[1] * (s0 + s1) / 2]
          if (others.some((x) => distToLine(mid, x.pts) < x.width / 2 + 1)) continue // junction box
          for (const off of offs) {
            const at = (s: number, d: number): XY => [p[0] + u[0] * s + nl[0] * (off * side + d), p[1] + u[1] * s + nl[1] * (off * side + d)]
            const ring = [at(s0, -hw), at(s1, -hw), at(s1, hw), at(s0, hw), at(s0, -hw)]
            if (grid) markPos.push(...(conformSurface([ring], grid, 0.15).attributes.position.array as Float32Array))
            else for (const k of [0, 1, 2, 0, 2, 3]) markPos.push(ring[k][0], 0.15, -ring[k][1])
          }
        }
      }
    }
  }
  return new Float32Array(markPos)
  })
  if (markArr.length) {
    const mg = new THREE.BufferGeometry()
    mg.setAttribute('position', new THREE.BufferAttribute(markArr, 3))
    mg.computeVertexNormals()
    add(new THREE.Mesh(mg, mat('#f2f2f2', { side: THREE.DoubleSide, ...layerOffset(9) }))).userData.markings = true
  }

  // instanced trees and street lights (one draw call each)
  const MAX_TREES = 6000, MAX_LIGHTS = 3000
  const instanced = (geo: THREE.BufferGeometry, material: THREE.Material, spots: { e: number; n: number; y?: number; s?: number }[], yOff: number, cast = true) => {
    const im = new THREE.InstancedMesh(geo, material, spots.length)
    const mtx = new THREE.Matrix4()
    spots.forEach((p, i) => {
      const s = p.s ?? 1
      mtx.compose(new THREE.Vector3(p.e, (p.y ?? elevLocal(p.e, p.n)) + yOff * s, -p.n), new THREE.Quaternion(), new THREE.Vector3(s, s, s))
      im.setMatrixAt(i, mtx)
    })
    im.castShadow = cast
    return add(im)
  }
  // trees stay off any road crossing a park or forest (carriageway + 1 m verge); tunnels run underneath, so not those
  const strips = shown.flatMap((x) => {
    if (x.geometry.type !== 'LineString' || componentDef(x.properties.type).layer !== 'roads' || x.properties.attrs.structure === 'tunnel') return []
    const w = Number(x.properties.attrs.width) || 0
    if (!w) return []
    const pts = x.geometry.coordinates.map(L), half = w / 2 + 1, xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
    return [{ pts, half, box: [Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half] }]
  })
  const offRoad = (t: { e: number; n: number }) => !strips.some((r) => t.e >= r.box[0] && t.e <= r.box[2] && t.n >= r.box[1] && t.n <= r.box[3] && distToLine([t.e, t.n], r.pts) < r.half)
  const trees = treeSpots.filter(offRoad).slice(0, MAX_TREES)
  if (trees.length) {
    instanced(new THREE.CylinderGeometry(0.18, 0.25, 2.6, 6), new THREE.MeshStandardMaterial({ color: '#6b4f35' }), trees, 1.3)
    instanced(new THREE.IcosahedronGeometry(2.2, 0), new THREE.MeshStandardMaterial({ color: '#3f7d3a', flatShading: true }), trees, 4)
  }
  const lights = lightSpots.slice(0, MAX_LIGHTS)
  let lampHead: THREE.MeshStandardMaterial | undefined, lampPool: THREE.MeshBasicMaterial | undefined, poolMesh: THREE.InstancedMesh | undefined
  if (lights.length) {
    instanced(new THREE.CylinderGeometry(0.08, 0.1, 6, 6), new THREE.MeshStandardMaterial({ color: '#4d5259' }), lights, 3)
    lampHead = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#ffd36b', emissiveIntensity: 0.6 })
    instanced(new THREE.SphereGeometry(0.3, 6, 4), lampHead, lights, 6, false)
    // light pool on the ground: additive disc (no real light), shown only at night
    lampPool = new THREE.MeshBasicMaterial({ color: '#ffcf8a', map: poolTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -40 })
    poolMesh = instanced(new THREE.CircleGeometry(6, 24).rotateX(-Math.PI / 2), lampPool, lights.map((p) => ({ ...p, y: p.y + 0.2 })), 0, false) // ponytail: flat disc at lamp ground height; slopes can clip it
    poolMesh.visible = false
  }
  const drive = o.settings?.drivingSide ?? 'left'
  const moving = o.cars !== false && o.moving === true && !o.modelsOnly
  // one road graph for the traffic sim and the signal heads (createTraffic sets each junction's light offset first)
  const graph = buildRoadGraph(shown, L, drive)
  let traffic: BuiltScene['traffic'], fleetDark: ((d: number) => void) | undefined
  if (moving) {
    const t = createTraffic(graph, { seed: hash(shown.map((x) => x.id).join()), ground: elevLocal })
    // ponytail: every kind gets full capacity (drive.ts may pick any kind for every car); ~600 × slots instances each
    const fleet = carFleet(Object.fromEntries((['sedan', 'hatch', 'suv', 'bus', 'truck'] as VehicleKind[]).map((k) => [k, MAX_MOVING])))
    for (const m of fleet.meshes) add(m)
    fleetDark = fleet.setDarkness
    traffic = { step: (dt, hour, vis, draw = true) => { t.step(dt, hour, vis); heads.update(t.time); if (draw) fleet.update(t.poses()) } }
  }
  // traffic lights at busy junctions; frozen at t = 0 without moving traffic
  const heads = signalHeads(graph, drive, elevLocal)
  for (const m of heads.meshes) add(m)
  if (o.cars !== false)
    for (const m of carMeshes(memoOnFeatures(
      // placeCars reads only roads, buildings and parking: other edits reuse the parked cars
      shown.filter((x) => (x.geometry.type === 'LineString' && componentDef(x.properties.type).layer === 'roads') || (x.geometry.type === 'Polygon' && (x.properties.type === 'parking' || Number(x.properties.attrs.floors) > 0))),
      `cars|${origin.join()}|${bounds.join()}|${drive}|${moving}|${o.exaggeration}|${idOf(o.elevation)}`,
      () => placeCars(shown, L, drive, elevLocal, { lanes: !moving })))) {
      add(m)
      // on the map, vehicles are details: hidden below DETAILS_MIN_ZOOM with the building details
      if (o.modelsOnly) { m.computeBoundingSphere(); details.push({ center: m.boundingSphere!.center.clone(), setVisible: (on) => { m.visible = on } }) }
    }

  const radius = Math.max(50, Math.hypot(e1 - e0, n1 - n0) / 2)
  // unselected look: colour for plain meshes, own glow (e.g. a police light) for emissive-highlighted ones
  const own = new Map<THREE.MeshStandardMaterial, [THREE.Color, number]>()
  for (const p of pickables) {
    if (p === plotMesh) continue
    const ms = [(p as THREE.Mesh).material].flat() as THREE.MeshStandardMaterial[]
    if (p.userData.baseMat) continue
    if (!p.userData.emissive) base[p.uuid] = { color: '#' + ms[0].color.getHexString() }
    else for (const m of ms) own.set(m, [m.emissive.clone(), m.emissive.getHex() ? m.emissiveIntensity : 0])
  }
  const lit = new Map<THREE.Material, THREE.MeshStandardMaterial>() // highlighted copy of a shared material
  const litOf = (m: THREE.Material) => {
    let c = lit.get(m)
    if (!c) { c = withNight((m as THREE.MeshStandardMaterial).clone(), m); c.userData.shared = false; c.emissive.set(SELECTED); c.emissiveIntensity = 0.45; lit.set(m, c) }
    return c
  }
  // underground: pipes are built on first use only (no cost while the view is off)
  let pipes: PipeMeshes | undefined, under = false, ghostExtra: THREE.Object3D[] = []
  const xray = (on: boolean) => ghost([...group.children.filter((c) => c !== pipes?.group), ...ghostExtra], on, (m) => (m.userData.batch || m.userData.baseMat ? 0.12 : 0.25))
  const pipeParts = () => (pipes ? pipes.group.children : [])
  let clutter: THREE.Object3D[] = [] // cars, trees, lamps, signal heads: hidden while underground (surface clutter, costly see-through)
  const setUnderground = (on: boolean, extra: THREE.Object3D[] = []) => {
    if (under) xray(false)
    if (on && !under) { clutter = group.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh && c.visible); for (const c of clutter) c.visible = false }
    if (!on && under) { for (const c of clutter) c.visible = true; clutter = [] }
    if (!on && under) { under = false; night(...lastNight) } // night-only parts (pools, beams) as the hour says
    under = on; ghostExtra = extra
    if (on && !pipes) { pipes = pipeMeshes(pipeFlow(shown, L, elevLocal)); group.add(pipes.group) }
    if (pipes) pipes.group.visible = on
    for (const m of pipeParts()) { const i = pickables.indexOf(m); if (on && i < 0 && !m.userData.manholes) pickables.push(m); if (!on && i >= 0) pickables.splice(i, 1) }
    if (on) xray(true)
  }
  let lastNight: [number, number] = [0, 12]
  function night(d: number, hour: number) {
    lastNight = [d, hour]
    setFacadeNight(d, hour)
    if (lampHead) lampHead.emissiveIntensity = 0.6 + 2.4 * d
    if (lampPool) { lampPool.opacity = 0.55 * d; poolMesh!.visible = d > 0 }
    fleetDark?.(d)
    // underground: night shows pools / beams again; keep them hidden (and restore them with the rest)
    if (under) for (const c of group.children) if ((c as THREE.InstancedMesh).isInstancedMesh && c.visible) { c.visible = false; if (!clutter.includes(c)) clutter.push(c) }
  }
  const setSelection = (ids: Set<string>) => {
    if (under) xray(false) // highlight the originals, never the shared ghost copies
    for (const { id, group: g } of buildings) {
      const on = ids.has(id)
      g.visible = on
      batches.setVisible(id, 'body', !on)
      batches.setVisible(id, 'details', !on && !!(g.userData.details as THREE.Object3D | undefined)?.visible) // point models have no details
    }
    for (const p of pickables) {
      if (p === plotMesh || p.userData.pipe) continue // ponytail: a selected pipe isn't highlighted in 3D (it is in the map and inspector)
      const on = ids.has(p.userData.id)
      const bm = p.userData.baseMat as THREE.Material | THREE.Material[] | undefined
      if (bm) { (p as THREE.Mesh).material = !on ? bm : Array.isArray(bm) ? bm.map(litOf) : litOf(bm); continue }
      const ms = [(p as THREE.Mesh).material].flat() as THREE.MeshStandardMaterial[]
      if (p.userData.emissive) for (const m of ms) { const [c, k] = own.get(m)!; m.emissive.set(on ? SELECTED : c); m.emissiveIntensity = on ? 0.45 : k }
      else ms[0].color.set(on ? SELECTED : base[p.uuid].color!)
    }
    if (plotMesh) {
      const col = plotMesh.geometry.attributes.color as THREE.BufferAttribute
      let i = 0
      for (const v of plotVerts) {
        const c = ids.has(v.id) ? new THREE.Color(SELECTED) : v.color
        for (let k = 0; k < v.count; k++, i++) col.setXYZ(i, c.r, c.g, c.b)
      }
      col.needsUpdate = true
    }
    if (under) xray(true)
  }
  setSelection(o.selection)
  return {
    group, pickables, radius, setSelection, details, traffic, setUnderground,
    pipeTime: (t) => pipes?.setTime(t),
    setNight: night,
    pick(hit) {
      if (hit.object === plotMesh && hit.faceIndex !== undefined && hit.faceIndex !== null) {
        let lo = 0, hi = plotTri.length - 1
        while (lo < hi) { const mid = (lo + hi) >> 1; if (plotTri[mid].end > hit.faceIndex) hi = mid; else lo = mid + 1 }
        return plotTri[lo]?.id
      }
      if (hit.object.userData.pipe) return pipes?.pick(hit)
      return hit.object.userData.id as string | undefined
    },
    groundAt: (x, z) => elevLocal(x, -z),
    toScene: (p) => { const [e, n] = L(p); return new THREE.Vector3(e, elevLocal(e, n), -n) },
    toGeo: (x, z) => f.toGeo([x, -z]),
    dispose() {
      if (under) xray(false) // originals back first: ghost copies are shared, the originals are this scene's to free
      group.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (!m.geometry?.userData.shared) m.geometry?.dispose() // cached geometry (vehicles) outlives scenes
        if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose() // frees its instance buffers
        for (const mt of [m.material].flat()) if (mt && !(mt as THREE.Material).userData.shared) (mt as THREE.Material).dispose()
      })
      for (const c of lit.values()) c.dispose()
    },
  }
}
