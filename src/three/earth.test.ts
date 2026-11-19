import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { WGS84_ELLIPSOID } from '3d-tiles-renderer'
import { OBJECT_FRAME } from '3d-tiles-renderer/src/three/renderer/math/Ellipsoid.js' // the package's types omit this re-export
import { EARTH_YAW, earthCredits, groundHeight, loadEarth } from './earth'

describe('Google Earth credits', () => {
  it('joins copyright strings and picks the logo', () => {
    expect(earthCredits([{ type: 'string', value: 'Map data ©2026 Google' }, { type: 'image', value: 'logo.png' }]))
      .toEqual({ text: 'Map data ©2026 Google', logo: 'logo.png' })
  })
  it('is never blank', () => {
    expect(earthCredits([])).toEqual({ text: 'Google' })
    expect(earthCredits([{ type: 'string', value: '' }])).toEqual({ text: 'Google' })
  })
})

describe('loadEarth', () => {
  it('rejects with Google\'s error when the key is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }))))
    const renderer = { getSize: (v: THREE.Vector2) => v.set(800, 600), getPixelRatio: () => 1 } as unknown as THREE.WebGLRenderer
    const drop = vi.spyOn(DRACOLoader.prototype, 'dispose')
    await expect(loadEarth('BAD', [73.05, 33.7], new THREE.PerspectiveCamera(), renderer)).rejects.toThrow(/400|not valid|key/i)
    expect(drop).toHaveBeenCalled() // the decoder's workers go with it
    vi.unstubAllGlobals()
  })
})

describe('Google Earth orientation', () => {
  // reproduce ReorientationPlugin's placement (tiles.group = inverse object frame), then our outer turn
  const toScene = (lat: number, lon: number) => {
    const R = THREE.MathUtils.DEG2RAD, o = [33.7, 73.05]
    const m = WGS84_ELLIPSOID.getObjectFrame(o[0] * R, o[1] * R, 0, 0, 0, 0, new THREE.Matrix4(), OBJECT_FRAME).invert()
    const p = WGS84_ELLIPSOID.getCartographicToPosition(lat * R, lon * R, 0, new THREE.Vector3()).applyMatrix4(m)
    return p.applyEuler(new THREE.Euler(0, EARTH_YAW, 0))
  }
  it('puts north at −z and east at +x, like scene.ts', () => {
    const n = toScene(33.7 + 100 / 110574, 73.05), e = toScene(33.7, 73.05 + 100 / (111320 * Math.cos(33.7 * Math.PI / 180)))
    expect(n.z).toBeCloseTo(-100, -1); expect(Math.abs(n.x)).toBeLessThan(1)
    expect(e.x).toBeCloseTo(100, -1); expect(Math.abs(e.z)).toBeLessThan(1)
  })
})

describe('Google Earth grounding', () => {
  it('finds the ground under a roof, not the roof', () => {
    const world = new THREE.Group()
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial())
    const roof = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 30).translate(0, 6, 0), new THREE.MeshBasicMaterial())
    world.add(ground, roof); world.position.y = 7; world.updateMatrixWorld(true)
    expect(groundHeight(world)).toBeCloseTo(7, 3)
    expect(groundHeight(new THREE.Group())).toBeNull()
  })
})
