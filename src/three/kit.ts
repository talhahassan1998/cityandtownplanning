import * as THREE from 'three'
import { FLOOR_HEIGHT, type BuildingStyle } from '../model'
import { BAY } from './facades'
import type { OBox } from './models'

/**
 * Footprint-parametric building parts. Every part is plain geometry in the oriented-box frame —
 * x along the long axis (±hx), y up from the building base, z = −(short axis) so the front face is
 * z = +hy — tagged with a material key. `buildingModel` moves them onto the footprint and merges them
 * per material, so a part may be as many small pieces as it likes.
 */
export type MatKey = 'trim' | 'roof' | 'glass' | 'metal' | 'wood' | 'awning' | 'green' | 'accent' | 'sign' | 'dark' | 'brick' | 'light' | 'red'
export interface Part { mat: MatKey; geo: THREE.BufferGeometry }

export const PALETTE: Record<BuildingStyle, Record<MatKey, string>> = {
  western: { trim: '#f4f1ea', roof: '#8a4b3a', glass: '#5d7f99', metal: '#6f767d', wood: '#7a5a3c', awning: '#b7412e', green: '#5f8f4a', accent: '#c9a227', sign: '#2f3a44', dark: '#3b2f2a', brick: '#8a5544', light: '#1e88e5', red: '#d32f2f' },
  gulf: { trim: '#e9dcc0', roof: '#b9a27a', glass: '#4f6b78', metal: '#8d939b', wood: '#6d4c33', awning: '#f2ece0', green: '#6e9a48', accent: '#b8925a', sign: '#2e705c', dark: '#2f2a26', brick: '#c8a97a', light: '#1e88e5', red: '#d32f2f' },
}
const mats = new Map<string, THREE.MeshStandardMaterial>()
/** Shared material for a kit part. ponytail: module-level cache, never disposed (26 materials max). */
export function kitMaterial(style: BuildingStyle, key: MatKey): THREE.MeshStandardMaterial {
  const k = `${style}|${key}`
  let m = mats.get(k)
  if (!m) {
    const glossy = key === 'glass' || key === 'metal'
    mats.set(k, (m = new THREE.MeshStandardMaterial({ color: PALETTE[style][key], roughness: glossy ? 0.35 : 0.8, metalness: key === 'metal' ? 0.4 : 0, side: THREE.DoubleSide, ...(key === 'light' && { emissive: PALETTE[style].light, emissiveIntensity: 0.6 }) })))
    m.userData.shared = true
  }
  return m
}

// --- primitives ----------------------------------------------------------------------------
/** Box w (x) × h (y) × d (z), bottom centred at (x, y, z). */
export const B = (mat: MatKey, w: number, h: number, d: number, x = 0, y = 0, z = 0): Part => ({ mat, geo: new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z) })
export const Cy = (mat: MatKey, r: number, h: number, x = 0, y = 0, z = 0, seg = 12, rTop = r): Part => ({ mat, geo: new THREE.CylinderGeometry(rTop, r, h, seg).translate(x, y + h / 2, z) })
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
function tris(mat: MatKey, ts: THREE.Vector3[][]): Part {
  const g = new THREE.BufferGeometry().setFromPoints(ts.flat())
  g.computeVertexNormals()
  return { mat, geo: g }
}
const FRONT = (ob: OBox) => ob.hy
/** Evenly spaced positions along the long axis, at most `max`. */
function along(L: number, step: number, max: number): number[] {
  const n = Math.max(1, Math.min(max, Math.floor((2 * L) / step)))
  return Array.from({ length: n }, (_, i) => -L + ((i + 0.5) * 2 * L) / n)
}

// --- roofs ---------------------------------------------------------------------------------
export function parapet(ob: OBox, top: number, h: number, mat: MatKey = 'trim'): Part[] {
  const { hx: L, hy: W } = ob, t = 0.25
  return [B(mat, 2 * L, h, t, 0, top, W - t / 2), B(mat, 2 * L, h, t, 0, top, -W + t / 2), B(mat, t, h, 2 * W, L - t / 2, top), B(mat, t, h, 2 * W, -L + t / 2, top)]
}
/** Real roofs stop rising on deep buildings: ridge at most this far above the eaves (m). */
const MAX_RISE = 5
/** Ridge along the long axis; eaves at `top` on the overhang line, ridge `pitch × hy` (≤ MAX_RISE) above. */
export function gableRoof(ob: OBox, top: number, overhang: number, pitch: number, mat: MatKey = 'roof'): Part[] {
  const L = ob.hx + overhang, W = ob.hy + overhang, h = top + Math.min(pitch * ob.hy, MAX_RISE)
  const A = V(-L, top, -W), Bv = V(L, top, -W), C = V(L, top, W), D = V(-L, top, W), R1 = V(-L, h, 0), R2 = V(L, h, 0)
  const wall = V(-ob.hx, top, -ob.hy), wall2 = V(-ob.hx, top, ob.hy), e1 = V(-ob.hx, h, 0), w3 = V(ob.hx, top, -ob.hy), w4 = V(ob.hx, top, ob.hy), e2 = V(ob.hx, h, 0)
  return [tris(mat, [[A, Bv, R2], [A, R2, R1], [C, D, R1], [C, R1, R2]]), tris('trim', [[wall, wall2, e1], [w3, w4, e2]])]
}
/** Hip roof; a square-ish footprint (hx ≤ hy) or `pyramid` gives a single apex. */
export function hipRoof(ob: OBox, top: number, overhang: number, pitch: number, mat: MatKey = 'roof', pyramid = false): Part[] {
  const L = ob.hx + overhang, W = ob.hy + overhang, h = top + Math.min(pitch * ob.hy, MAX_RISE), r = pyramid ? 0 : Math.max(0, L - W)
  const A = V(-L, top, -W), Bv = V(L, top, -W), C = V(L, top, W), D = V(-L, top, W), R1 = V(-r, h, 0), R2 = V(r, h, 0)
  return [tris(mat, [[A, Bv, R2], [A, R2, R1], [C, D, R1], [C, R1, R2], [D, A, R1], [Bv, C, R2]])]
}
/** Low-pitched metal roof (industrial). */
export const metalRoof = (ob: OBox, top: number) => gableRoof(ob, top, 0.3, 0.15, 'metal')
/** Sawtooth roof: north-light teeth across the long axis (≤ 30). */
export function sawtooth(ob: OBox, top: number): Part[] {
  const xs = along(ob.hx, 8, 30), w = (2 * ob.hx) / xs.length, W = ob.hy
  return xs.flatMap((x) => [tris('metal', [[V(x - w / 2, top, -W), V(x + w / 2, top, -W), V(x + w / 2, top + 3, -W)], [V(x - w / 2, top, W), V(x + w / 2, top + 3, W), V(x + w / 2, top, W)], [V(x - w / 2, top, -W), V(x + w / 2, top + 3, -W), V(x + w / 2, top + 3, W)], [V(x - w / 2, top, -W), V(x + w / 2, top + 3, W), V(x - w / 2, top, W)]]), B('glass', 0.1, 3, 2 * W, x + w / 2 - 0.05, top)])
}

// --- façade elements -------------------------------------------------------------------------
/** Balconies on the front face from floor 1 up, one per `every` bays; ≤ 100 balconies, thinned by skipping floors evenly. */
export function balconies(ob: OBox, floors: number, style: BuildingStyle, every: number): Part[] {
  const bays = along(ob.hx, BAY, 400).filter((_, i) => i % every === 0)
  const fl = Array.from({ length: Math.max(0, floors - 1) }, (_, i) => i + 1)
  const stride = Math.max(1, Math.ceil((fl.length * bays.length) / 100))
  const W = FRONT(ob), d = 1.2, w = BAY * 0.8
  const out: Part[] = []
  for (const f of fl.filter((_, i) => i % stride === 0)) for (const x of bays) {
    if (out.length >= 200) return out
    const y = f * FLOOR_HEIGHT
    out.push(B('trim', w, 0.15, d, x, y, W + d / 2))
    out.push(style === 'gulf' ? B('accent', w, 1.1, 0.12, x, y + 0.15, W + d - 0.06) : B('metal', w, 1.0, 0.05, x, y + 0.15, W + d - 0.03))
  }
  return out
}
/** Shop awning centred at x on the front face, its top at height h. */
export function awning(ob: OBox, x: number, w: number, h: number, style: BuildingStyle): Part[] {
  const W = FRONT(ob), d = 1.6
  if (style === 'gulf') return [B('awning', w, 0.15, d + 0.4, x, h, W + (d + 0.4) / 2)] // flat shade canopy
  const a = W, b = W + d, lo = h - 0.8
  return [tris('awning', [[V(x - w / 2, h, a), V(x + w / 2, h, a), V(x + w / 2, lo, b)], [V(x - w / 2, h, a), V(x + w / 2, lo, b), V(x - w / 2, lo, b)], [V(x - w / 2, h, a), V(x - w / 2, lo, b), V(x - w / 2, lo, a)], [V(x + w / 2, h, a), V(x + w / 2, lo, a), V(x + w / 2, lo, b)]])]
}
/** Sign board + door of a shop unit centred at x. */
export function shopfront(ob: OBox, x: number, w: number, style: BuildingStyle): Part[] {
  const W = FRONT(ob)
  return [B('sign', w * 0.9, 0.7, 0.15, x, FLOOR_HEIGHT - 0.9, W + 0.08), door(ob, x + w * 0.3, 1.1, 2.3, style === 'gulf' ? 'metal' : 'glass')]
}
export const door = (ob: OBox, x: number, w: number, h: number, mat: MatKey = 'dark'): Part => B(mat, w, h, 0.12, x, 0, FRONT(ob) + 0.06)
/** Front porch at x: plinth, two steps, two posts and a small roof; depth d ≤ 3. */
export function porch(ob: OBox, x: number, w: number, d: number): Part[] {
  const W = FRONT(ob)
  return [B('trim', w, 0.3, d, x, 0, W + d / 2), B('trim', w * 0.6, 0.15, 0.4, x, 0, W + d + 0.2 - 0.4), ...[-1, 1].map((s) => B('trim', 0.2, 2.6, 0.2, x + s * (w / 2 - 0.2), 0.3, W + d - 0.2)), B('roof', w + 0.3, 0.15, d + 0.2, x, 2.9, W + d / 2)]
}
/** Ground-floor arcade along the front (≤ 40 bays): square piers (western) or piers + arches (gulf). */
export function arcade(ob: OBox, h: number, style: BuildingStyle): Part[] {
  const W = FRONT(ob), d = 3, xs = along(ob.hx, BAY, 40), step = (2 * ob.hx) / xs.length
  const piers = [...xs.map((x) => x - step / 2), ob.hx].map((x) => B('trim', 0.5, h, 0.5, Math.max(-ob.hx + 0.25, Math.min(ob.hx - 0.25, x)), 0, W + d - 0.25))
  const arches = style === 'gulf' ? xs.map((x) => ({ mat: 'trim' as MatKey, geo: new THREE.TorusGeometry(step / 2 - 0.25, 0.2, 4, 10, Math.PI).translate(x, h - step / 2, W + d - 0.25) })) : []
  return [...piers, ...arches, B('trim', 2 * ob.hx, 0.4, d, 0, h, W + d / 2)]
}
/** Entrance portico on the front (≤ 12 columns): pediment (western) or arches + flat top (gulf). */
export function portico(ob: OBox, h: number, cols: number, style: BuildingStyle): Part[] {
  const W = FRONT(ob), d = 2.8, n = Math.max(2, Math.min(12, cols)), span = Math.min(2 * ob.hx * 0.8, n * 3)
  const xs = Array.from({ length: n }, (_, i) => -span / 2 + (i * span) / (n - 1))
  const out: Part[] = [B('trim', span + 1.5, 0.5, d, 0, 0, W + d / 2), ...xs.map((x) => (style === 'gulf' ? B('trim', 0.6, h, 0.6, x, 0.5, W + d - 0.4) : Cy('trim', 0.35, h, x, 0.5, W + d - 0.4, 12))), B('trim', span + 1.2, 0.6, d, 0, h + 0.5, W + d / 2)]
  if (style === 'western') out.push(tris('trim', [[V(-span / 2 - 0.6, h + 1.1, W + d), V(span / 2 + 0.6, h + 1.1, W + d), V(0, h + 1.1 + span * 0.12, W + d)], [V(-span / 2 - 0.6, h + 1.1, W), V(0, h + 1.1 + span * 0.12, W), V(span / 2 + 0.6, h + 1.1, W)], [V(-span / 2 - 0.6, h + 1.1, W), V(-span / 2 - 0.6, h + 1.1, W + d), V(0, h + 1.1 + span * 0.12, W + d)], [V(-span / 2 - 0.6, h + 1.1, W), V(0, h + 1.1 + span * 0.12, W + d), V(0, h + 1.1 + span * 0.12, W)], [V(span / 2 + 0.6, h + 1.1, W), V(0, h + 1.1 + span * 0.12, W), V(0, h + 1.1 + span * 0.12, W + d)], [V(span / 2 + 0.6, h + 1.1, W), V(0, h + 1.1 + span * 0.12, W + d), V(span / 2 + 0.6, h + 1.1, W + d)]]))
  else for (let i = 0; i < n - 1; i++) { const r = (xs[i + 1] - xs[i]) / 2 - 0.3; if (r > 0.3) out.push({ mat: 'trim', geo: new THREE.TorusGeometry(r, 0.2, 4, 10, Math.PI).translate((xs[i] + xs[i + 1]) / 2, h + 0.5 - r, W + d - 0.4) }) }
  return out
}
/** Flat canopy w × d at height h with two posts, centred at (x, z). */
export const canopy = (x: number, z: number, w: number, d: number, h: number, mat: MatKey = 'metal'): Part[] => [B(mat, w, 0.2, d, x, h, z), ...[-1, 1].map((s) => Cy('metal', 0.1, h, x + s * (w / 2 - 0.3), 0, z + d / 2 - 0.3, 6))]

// --- site ----------------------------------------------------------------------------------
/** Wall (or fence when h ≤ 1.2) `margin` outside the box (≤ 3 m), with a 3.5 m gate gap at gateX on the front. */
export function boundaryWall(ob: OBox, margin: number, h: number, gateX: number, style: BuildingStyle): Part[] {
  const m = Math.min(3, margin), L = ob.hx + m, W = ob.hy + m, t = 0.25, mat: MatKey = h <= 1.2 ? (style === 'gulf' ? 'trim' : 'wood') : 'trim'
  const g0 = gateX - 1.75, g1 = gateX + 1.75
  const out = [B(mat, 2 * L, h, t, 0, 0, -W + t / 2), B(mat, t, h, 2 * W, L - t / 2), B(mat, t, h, 2 * W, -L + t / 2)]
  if (g0 > -L) out.push(B(mat, g0 + L, h, t, (-L + g0) / 2, 0, W - t / 2))
  if (g1 < L) out.push(B(mat, L - g1, h, t, (g1 + L) / 2, 0, W - t / 2))
  if (h > 1.2) out.push(B('metal', 3.5, h - 0.2, 0.08, gateX, 0, W - t / 2))
  return out
}
export const hedge = (ob: OBox, margin: number): Part[] => {
  const L = ob.hx + margin, W = ob.hy + margin
  return [B('green', 2 * L, 0.9, 0.6, 0, 0, -W + 0.3), B('green', 0.6, 0.9, 2 * W, L - 0.3), B('green', 0.6, 0.9, 2 * W, -L + 0.3)]
}
export const palm = (x: number, z: number, h: number): Part[] => [Cy('wood', 0.18, h, x, 0, z, 6, 0.14), { mat: 'green', geo: new THREE.ConeGeometry(1.8, 1.2, 7).translate(x, h, z) }]

// --- roof clutter & landmarks -----------------------------------------------------------------
const rng = (seed: number) => () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((seed >>> 0) % 10000) / 10000 }
const roofSpot = (ob: OBox, r: () => number): [number, number] => [(r() * 2 - 1) * ob.hx * 0.7, (r() * 2 - 1) * ob.hy * 0.7]
export const rooftopTanks = (ob: OBox, top: number, n: number, seed: number): Part[] => {
  const r = rng(seed)
  return Array.from({ length: n }, () => roofSpot(ob, r)).flatMap(([x, z]) => [B('metal', 1.4, 0.5, 1.4, x, top, z), Cy('dark', 0.6, 1.3, x, top + 0.5, z, 10)])
}
export const acUnits = (ob: OBox, top: number, n: number, seed: number): Part[] => {
  const r = rng(seed + 1)
  return Array.from({ length: n }, () => roofSpot(ob, r)).map(([x, z]) => B('metal', 0.9, 0.7, 0.6, x, top, z))
}
export const chimney = (x: number, z: number, top: number, h = 2.2): Part => B('brick', 0.8, h, 0.8, x, top - 0.5, z)
export const dome = (x: number, z: number, r: number, y: number): Part[] => [Cy('trim', r * 1.02, r * 0.3, x, y, z, 20), { mat: 'accent', geo: new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, y + r * 0.3, z) }]
/** Bell tower with spire (western) or minaret with balcony and cap (gulf); shaft height h. */
export function tower(x: number, z: number, r: number, h: number, style: BuildingStyle): Part[] {
  if (style === 'gulf') return [Cy('trim', r, h, x, 0, z, 12, r * 0.85), Cy('trim', r * 1.4, 0.4, x, h * 0.8, z, 12), Cy('trim', r * 0.8, r * 2, x, h, z, 12), { mat: 'accent', geo: new THREE.ConeGeometry(r * 0.9, r * 2.5, 12).translate(x, h + r * 2 + r * 1.25, z) }]
  return [B('trim', 2 * r, h, 2 * r, x, 0, z), B('dark', 2 * r + 0.1, 1.2, 2 * r + 0.1, x, h - 2, z), { mat: 'roof', geo: new THREE.ConeGeometry(r * 1.45, r * 3, 4).rotateY(Math.PI / 4).translate(x, h + r * 1.5, z) }]
}
export const flag = (x: number, z: number): Part[] => [Cy('metal', 0.08, 9, x, 0, z, 6), B('green', 0.05, 1, 1.6, x, 7.8, z + 0.8)]

export function partsBounds(parts: Part[]): THREE.Box3 {
  const b = new THREE.Box3()
  for (const p of parts) { p.geo.computeBoundingBox(); b.union(p.geo.boundingBox!) }
  return b
}
