import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { orientedBox } from '../../geo'
import { FLOOR_HEIGHT, type BuildingStyle } from '../../model'
import { capMaterial, wallMaterial, type WallKind } from '../facades'
import { gableRoof, hipRoof, kitMaterial, type MatKey, type Part } from '../kit'
import type { OBox } from '../models'
import type { RoofStyle } from '../scene'
import { civic } from './civic'
import { commercial } from './commercial'
import { industrial } from './industrial'
import { residential } from './residential'

/**
 * Real-world-looking building models: a body extruded from the real footprint and skinned with a
 * style façade texture, plus a per-type recipe of kit parts. Parts are merged into one mesh per
 * material; small parts go into a separate `details` group that viewers hide by distance/zoom.
 */
type XY = [number, number]
export interface BuildingInput {
  type: string
  style: BuildingStyle
  /** Closed rings in scene-local metres (east, north). */
  ring: XY[]
  holes: XY[][]
  base: number
  /** Eaves height above `base` (already includes any terrain step). */
  height: number
  floors: number
  /** User-picked wall colour; '' = a real-world finish from the style palette. */
  color: string
  seed: number
  /** Saved roof choice; overrides the recipe's default. */
  roof?: RoofStyle
}
/** Recipe context: oriented box re-centred (cx = cy = 0, angle = 0), heights relative to the base. */
export interface RecipeCtx { ob: OBox; style: BuildingStyle; floors: number; top: number; rnd: () => number; /** Saved roof override, if any. */ roof?: RoofStyle }
export interface Recipe { wall: WallKind; ground?: WallKind; roof: RoofStyle | 'none'; parts: Part[]; details: Part[] }
export type RecipeFn = (c: RecipeCtx) => Recipe

export const RECIPES: Record<string, RecipeFn> = { ...residential, ...commercial, ...civic, ...industrial }

const ROOFS = new Set(['flat', 'gable', 'hip', 'pyramid'])
const PITCH = 0.6

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function extrude(ring: XY[], holes: XY[][], y0: number, h: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(ring.slice(0, -1).map(([e, n]) => new THREE.Vector2(e, n)))
  for (const r of holes) shape.holes.push(new THREE.Path(r.slice(0, -1).map(([e, n]) => new THREE.Vector2(e, n))))
  return new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0)
}

/** One mesh per material from parts in the oriented-box frame, moved onto the footprint by `m`. */
function merged(parts: Part[], m: THREE.Matrix4, style: BuildingStyle): THREE.Mesh[] {
  const by = new Map<MatKey, THREE.BufferGeometry[]>()
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
    if (!g.attributes.normal) g.computeVertexNormals()
    by.set(p.mat, [...(by.get(p.mat) ?? []), g.applyMatrix4(m)])
  }
  return [...by].map(([k, gs]) => {
    const mesh = new THREE.Mesh(mergeGeometries(gs), kitMaterial(style, k))
    mesh.castShadow = mesh.receiveShadow = true
    return mesh
  })
}

/** Real-world wall finishes per style and wall kind; each building picks one by seed. */
export const WALL_COLORS: Record<BuildingStyle, Record<WallKind, string[]>> = {
  western: {
    residential: ['#e8dcc8', '#d9c3a5', '#b5654a', '#efe9df', '#c98f6b', '#a95c43'],
    apartment: ['#e6e0d6', '#d8cdbd', '#c4a484', '#bfc4c9', '#b0624a'],
    shopfront: ['#ece6dc', '#d9d2c6'],
    glass: ['#d7dde3', '#c9d1d9', '#e2e6ea'],
    blank: ['#c9ccd0', '#b8bcc2', '#d6d2c8'],
  },
  gulf: {
    residential: ['#efe3c8', '#e8d6b0', '#f3ead8', '#dcc59c', '#f6f0e4'],
    apartment: ['#efe3c8', '#e6d3ad', '#f3ead8', '#d9c29a'],
    shopfront: ['#efe3c8', '#e6d6b6'],
    glass: ['#efe6d2', '#e3d6bc'],
    blank: ['#e2d3b2', '#d6c39c', '#ebe0c8'],
  },
}

export function buildingModel(b: BuildingInput): THREE.Group {
  const g = new THREE.Group(), details = new THREE.Group()
  details.name = 'details'
  g.add(details)
  g.userData.details = details
  const body = (kind: WallKind, color: string, y0: number, h: number) => {
    // one material per mesh (batchable): ExtrudeGeometry is non-indexed with groups [caps, sides]
    const geo = extrude(b.ring, b.holes, y0, h)
    for (const gr of geo.groups) {
      const part = new THREE.BufferGeometry()
      for (const [k, a] of Object.entries(geo.attributes)) part.setAttribute(k, new THREE.BufferAttribute((a.array as Float32Array).slice(gr.start * a.itemSize, (gr.start + gr.count) * a.itemSize), a.itemSize))
      const cap = gr.materialIndex === 0
      const m = new THREE.Mesh(part, cap ? capMaterial(b.style) : wallMaterial(b.style, kind, color))
      m.castShadow = m.receiveShadow = true
      m.userData.body = true
      m.userData.part = cap ? 'cap' : 'wall'
      g.add(m)
    }
    geo.dispose()
  }
  const ob = orientedBox(b.ring)
  const rnd = mulberry32(b.seed)
  const pick = rnd()
  const tint = (kind: WallKind) => b.color || WALL_COLORS[b.style][kind][Math.floor(pick * WALL_COLORS[b.style][kind].length)]
  const fn = RECIPES[b.type]
  const saved = b.roof && ROOFS.has(b.roof) ? b.roof : undefined
  let recipe: Recipe | undefined
  if (fn && Math.min(ob.hx, ob.hy) * 2 >= 4) {
    try { recipe = fn({ ob: { cx: 0, cy: 0, hx: ob.hx, hy: ob.hy, angle: 0 }, style: b.style, floors: Math.max(1, b.floors), top: b.height, rnd, roof: saved }) } catch (e) { console.warn(`building recipe '${b.type}' failed, drawing a plain body`, e) }
  }
  if (!recipe) { body('residential', tint('residential'), b.base, b.height); return g }

  const color = tint(recipe.wall)
  if (recipe.ground && b.floors >= 2 && b.height > FLOOR_HEIGHT) {
    body(recipe.ground, color, b.base, FLOOR_HEIGHT)
    body(recipe.wall, color, b.base + FLOOR_HEIGHT, b.height - FLOOR_HEIGHT)
  } else body(recipe.ground ?? recipe.wall, color, b.base, b.height)

  const roof = saved ?? recipe.roof
  const local: OBox = { cx: 0, cy: 0, hx: ob.hx, hy: ob.hy, angle: 0 }
  const roofParts = roof === 'gable' ? gableRoof(local, b.height, 0.5, PITCH) : roof === 'hip' ? hipRoof(local, b.height, 0.5, PITCH) : roof === 'pyramid' ? hipRoof(local, b.height, 0.5, PITCH, 'roof', true) : []
  const m = new THREE.Matrix4().makeTranslation(ob.cx, b.base, -ob.cy).multiply(new THREE.Matrix4().makeRotationY(ob.angle))
  g.add(...merged([...recipe.parts, ...roofParts], m, b.style))
  const d = merged(recipe.details, m, b.style)
  if (d.length) details.add(...d)
  return g
}
