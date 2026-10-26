import * as THREE from 'three'
import { FLOOR_HEIGHT, type BuildingStyle } from '../model'
import { litShare, useOfWall, type LightUse } from './night'

/**
 * Generated façade textures: one 32×32 tile = one window bay (BAY m) × one storey, painted from pixel
 * arrays (no canvas, so they also build in Node tests). Walls are near-white so the material colour
 * tints them; glass and frames keep their own tone. A matching bump map gives frames, sills and fins
 * relief. Rows run top-down: ExtrudeGeometry side-wall UVs have v = 1 − height, so with the offset
 * below row 0 is the top of a storey and row 31 its floor. A glow mask (glass = 255) lights windows at night.
 */
export type WallKind = 'residential' | 'apartment' | 'shopfront' | 'glass' | 'blank'
export const BAY = 3.5
const N = 32
type RGB = [number, number, number]

type Rect = (x0: number, y0: number, x1: number, y1: number, c: RGB, h: number, glass?: boolean) => void
function paint(draw: (rect: Rect) => void) {
  const color = new Uint8Array(N * N * 4), bump = new Uint8Array(N * N * 4), glow = new Uint8Array(N * N * 4)
  const rect: Rect = (x0, y0, x1, y1, c, h, glass = false) => {
    const g = glass ? 255 : 0
    for (let y = Math.max(0, y0); y < Math.min(N, y1); y++) for (let x = Math.max(0, x0); x < Math.min(N, x1); x++) {
      const i = (y * N + x) * 4
      color.set([...c, 255], i)
      bump.set([h, h, h, 255], i)
      glow.set([g, g, g, 255], i)
    }
  }
  draw(rect)
  return { color, bump, glow }
}

const WALL = 128, RAISED = 230, RECESS = 40
const DRAW: Record<BuildingStyle, Record<WallKind, Parameters<typeof paint>[0]>> = {
  western: {
    residential: (r) => {
      r(0, 0, N, N, [232, 226, 218], WALL)
      r(8, 6, 24, 23, [250, 250, 250], RAISED) // frame
      r(10, 8, 22, 21, [62, 82, 104], RECESS, true) // glass
      r(15, 8, 17, 21, [250, 250, 250], RAISED); r(10, 13, 22, 15, [250, 250, 250], RAISED) // mullion + transom
      r(7, 23, 25, 25, [245, 245, 240], RAISED) // sill
    },
    apartment: (r) => {
      r(0, 0, N, N, [230, 224, 214], WALL)
      r(4, 7, 28, 23, [250, 250, 250], RAISED)
      r(6, 9, 26, 21, [66, 86, 108], RECESS, true)
      r(15, 9, 17, 21, [250, 250, 250], RAISED)
      r(3, 23, 29, 25, [245, 245, 240], RAISED)
    },
    shopfront: (r) => {
      r(0, 0, N, N, [236, 232, 226], WALL)
      r(0, 2, N, 8, [250, 250, 250], RAISED) // sign band
      r(2, 10, 30, N, [72, 98, 118], RECESS, true) // display glass
      for (const x of [2, 15, 29]) r(x, 10, x + 2, N, [60, 62, 66], RAISED) // mullions
    },
    glass: (r) => {
      r(0, 0, N, N, [84, 110, 132], RECESS, true)
      r(0, 0, N, 4, [150, 158, 166], RAISED) // spandrel
      r(0, 0, 2, N, [180, 186, 192], RAISED); r(16, 4, 17, N, [180, 186, 192], RAISED)
    },
    blank: (r) => {
      r(0, 0, N, N, [214, 214, 214], WALL)
      for (let y = 3; y < N; y += 4) r(0, y, N, y + 1, [190, 190, 190], RECESS)
    },
  },
  gulf: {
    residential: (r) => {
      r(0, 0, N, N, [240, 228, 204], WALL)
      for (const y of [7, 15, 23, 31]) r(0, y, N, y + 1, [222, 208, 182], RECESS + 40) // stone courses
      r(11, 8, 21, 21, [150, 134, 108], RECESS) // deep reveal
      r(13, 10, 19, 20, [52, 62, 72], RECESS, true)
    },
    apartment: (r) => {
      r(0, 0, N, N, [238, 226, 200], WALL)
      r(7, 6, 25, 23, [150, 134, 108], RECESS)
      r(9, 8, 23, 21, [54, 64, 74], RECESS, true)
      for (let y = 15; y < 21; y++) for (let x = 9; x < 23; x++) if ((x + y) % 3 === 0) r(x, y, x + 1, y + 1, [176, 146, 104], RAISED) // mashrabiya
    },
    shopfront: (r) => {
      r(0, 0, N, N, [236, 224, 198], WALL)
      r(0, 2, N, 8, [46, 112, 92], RAISED) // sign band
      for (let y = 10; y < N; y += 2) { r(2, y, 30, y + 1, [204, 206, 208], RAISED); r(2, y + 1, 30, y + 2, [170, 172, 176], RECESS) } // roll-up shutter
    },
    glass: (r) => {
      r(0, 0, N, N, [70, 92, 104], RECESS, true)
      r(0, 0, 4, N, [236, 222, 196], RAISED); r(16, 0, 20, N, [236, 222, 196], RAISED) // stone fins
    },
    blank: (r) => {
      r(0, 0, N, N, [226, 212, 182], WALL)
      for (let y = 5; y < N; y += 6) r(0, y, N, y + 1, [204, 188, 158], RECESS)
    },
  },
}

function texture(data: Uint8Array, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, N, N)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.repeat.set(1 / BAY, 1 / FLOOR_HEIGHT) // side-wall UVs are in metres
  t.offset.set(0, -1 / FLOOR_HEIGHT)
  t.needsUpdate = true
  return t
}

// ponytail: module-level caches, never disposed (≈4 KB per texture, one material per colour in use)
const tex = new Map<string, { map: THREE.DataTexture; bump: THREE.DataTexture; glow: THREE.DataTexture }>()
function pair(style: BuildingStyle, kind: WallKind) {
  const k = `${style}|${kind}`
  let p = tex.get(k)
  if (!p) {
    const { color, bump, glow } = paint(DRAW[style][kind])
    tex.set(k, (p = { map: texture(color, true), bump: texture(bump, false), glow: texture(glow, false) }))
  }
  return p
}
export const facadeTexture = (style: BuildingStyle, kind: WallKind) => pair(style, kind).map
export const facadeBump = (style: BuildingStyle, kind: WallKind) => pair(style, kind).bump
export const facadeGlow = (style: BuildingStyle, kind: WallKind) => pair(style, kind).glow

type Lit = Exclude<LightUse, 'none'>
/** Module-wide night state per use, shared by reference with every patched wall program. */
export const NIGHT: Record<Lit, { uDark: { value: number }; uLit: { value: number } }> = {
  home: { uDark: { value: 0 }, uLit: { value: 0 } },
  office: { uDark: { value: 0 }, uLit: { value: 0 } },
  shop: { uDark: { value: 0 }, uLit: { value: 0 } },
}
export function setFacadeNight(dark: number, solarHour: number) {
  for (const use of Object.keys(NIGHT) as Lit[]) { NIGHT[use].uDark.value = dark; NIGHT[use].uLit.value = litShare(use, solarHour) }
}
const GLOW: Record<Lit, string> = { home: '#ffd9a0', office: '#dfe9ff', shop: '#ffd9a0' }

// Window glow is added on top of the normal emissive (left black, so daytime and the selection highlight are
// untouched); uDark = 0 adds exactly 0. Storeys come from the tile row, bays from the world 3.5 m grid.
// ponytail: bay cells follow world x/z, so on oblique walls a window can straddle two cells (half lit).
function nightPatch(use: Lit): (s: THREE.WebGLProgramParametersWithUniforms) => void {
  const c = new THREE.Color(GLOW[use])
  const col = `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
  return (s) => {
    s.uniforms.uDark = NIGHT[use].uDark
    s.uniforms.uLit = NIGHT[use].uLit
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>
varying vec3 vNightPos;`).replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 nightP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    nightP = instanceMatrix * nightP;
  #endif
  #ifdef USE_BATCHING
    nightP = batchingMatrix * nightP;
  #endif
  vNightPos = (modelMatrix * nightP).xyz;`)
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
uniform float uDark;
uniform float uLit;
varying vec3 vNightPos;`).replace('#include <emissivemap_fragment>', `{
    float mask = texture2D(emissiveMap, vEmissiveMapUv).r;
    vec3 cell = vec3(floor(vNightPos.x / ${BAY.toFixed(1)}), floor(vEmissiveMapUv.y), floor(vNightPos.z / ${BAY.toFixed(1)}));
    float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    totalEmissiveRadiance += ${col} * mask * uDark * step(h, uLit) * (0.8 + 0.4 * fract(h * 7.31));
  }`)
  }
}
const patches = new Map<Lit, (s: THREE.WebGLProgramParametersWithUniforms) => void>()
/** Re-attach the night patch to a clone (`Material.clone()` drops onBeforeCompile and the cache key). */
export function withNight<M extends THREE.Material>(clone: M, from: THREE.Material): M {
  if (from.userData.night) { clone.onBeforeCompile = from.onBeforeCompile; clone.customProgramCacheKey = from.customProgramCacheKey; clone.userData.night = from.userData.night }
  return clone
}

const mats = new Map<string, THREE.MeshStandardMaterial>()
/** Shared wall material for a style, wall kind and tint. */
export function wallMaterial(style: BuildingStyle, kind: WallKind, color: string): THREE.MeshStandardMaterial {
  const k = `${style}|${kind}|${color}`
  let m = mats.get(k)
  if (!m) {
    const { map, bump } = pair(style, kind)
    mats.set(k, (m = new THREE.MeshStandardMaterial({ color, map, bumpMap: bump, bumpScale: 2, roughness: kind === 'glass' ? 0.35 : 0.8, metalness: kind === 'glass' ? 0.2 : 0 })))
    m.userData.shared = true
    const use = useOfWall(kind)
    if (use !== 'none') {
      m.emissiveMap = pair(style, kind).glow
      m.userData.night = NIGHT[use]
      let p = patches.get(use)
      if (!p) patches.set(use, (p = nightPatch(use)))
      m.onBeforeCompile = p
      m.customProgramCacheKey = () => 'night-' + use
    }
  }
  return m
}

const caps = new Map<BuildingStyle, THREE.MeshStandardMaterial>()
/** Plain flat-roof material (bitumen grey / pale screed) for the top cap of a building body. */
export function capMaterial(style: BuildingStyle): THREE.MeshStandardMaterial {
  let m = caps.get(style)
  if (!m) { caps.set(style, (m = new THREE.MeshStandardMaterial({ color: style === 'gulf' ? '#d8cbb0' : '#8c8e90', roughness: 0.95 }))); m.userData.shared = true }
  return m
}
