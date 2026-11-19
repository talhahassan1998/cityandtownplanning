/**
 * Google Earth in the 3D view: Google Photorealistic 3D Tiles (real buildings, trees, terrain) placed so the
 * scene origin sits on Google's ground. Loaded lazily (dynamic import from CityView) — only for the
 * "Google Earth (3D)" basemap. Uses the user's own Map Tiles API key; every tile load counts against their
 * Google allowance (ponytail: no tile budget/limit — add LRU size caps if bills matter).
 * ponytail: existing real buildings on the site show through planned ones; TileFlatteningPlugin (same
 * library) could flatten the site polygon — the upgrade if it bothers users.
 */
import * as THREE from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { TilesRenderer } from '3d-tiles-renderer'
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins'

/** ReorientationPlugin puts X west, Z north; scene.ts uses X east, −Z north: a half turn about Y. */
export const EARTH_YAW = Math.PI

export interface Earth {
  group: THREE.Object3D
  /** Once per frame, before rendering. */
  update(): void
  credits(): { text: string; logo?: string }
  dispose(): void
}

/** Google's required attribution from the renderer's list (never blank while tiles show). */
export function earthCredits(list: { type: string; value: unknown }[]): { text: string; logo?: string } {
  const text = list.filter((a) => a.type === 'string' && a.value).map((a) => String(a.value)).join(' · ') || 'Google'
  const logo = list.find((a) => a.type === 'image' && a.value)?.value
  return logo ? { text, logo: String(logo) } : { text }
}

// ponytail: one ground height (lowest of a 3x3 grid of rays, +-50 m round the origin, so a roof or tree at
// the centre doesn't lift the plan) for the whole plan - on hilly sites the plan floats/sinks;
// per-building ground sampling against the tiles is the upgrade.
const down = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0))
/** World-space height of the ground near the origin of `obj`'s scene (x = z = 0), or null if nothing is under it. */
export function groundHeight(obj: THREE.Object3D): number | null {
  let low: number | null = null
  for (const x of [-50, 0, 50]) for (const z of [-50, 0, 50]) {
    down.ray.origin.set(x, 20000, z)
    const hit = down.intersectObject(obj, true).at(-1) // last hit going down = the lowest surface
    if (hit && (low === null || hit.point.y < low)) low = hit.point.y
  }
  return low
}

/** Resolves once Google's root tileset loaded; rejects with Google's error (bad key, API not enabled, offline). */
export function loadEarth(key: string, [lon, lat]: [number, number], camera: THREE.Camera, renderer: THREE.WebGLRenderer): Promise<Earth> {
  const tiles = new TilesRenderer()
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true, useRecommendedSettings: true }))
  // the plugin never disposes its Draco loader (autoDispose unset in 0.5.3): we do, or each Earth leaks decoder workers
  const draco = new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/')
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }))
  tiles.registerPlugin(new ReorientationPlugin({ lat: lat * THREE.MathUtils.DEG2RAD, lon: lon * THREE.MathUtils.DEG2RAD, recenter: true }))
  tiles.setCamera(camera)
  tiles.setResolutionFromRenderer(camera, renderer)
  const group = new THREE.Group()
  group.rotation.y = EARTH_YAW // -> x east, y up, -z north, the same axes as scene.ts
  group.add(tiles.group)

  let frames = 0
  const ground = () => { // re-sampled as finer tiles load; the hit is in world space, so each correction is a delta
    const y = groundHeight(tiles.group)
    if (y !== null && Math.abs(y) > 0.5) { group.position.y -= y; group.updateMatrixWorld(true) }
  }

  const earth: Earth = {
    group,
    update() {
      tiles.setResolutionFromRenderer(camera, renderer)
      tiles.update()
      if (frames++ % 30 === 0) ground()
    },
    credits: () => earthCredits(tiles.getAttributions() as { type: string; value: unknown }[]),
    dispose() { group.removeFromParent(); tiles.dispose(); draco.dispose() },
  }

  return new Promise((resolve, reject) => {
    const fail = (e: unknown) => { clearTimeout(timer); tiles.dispose(); draco.dispose(); reject(e instanceof Error ? e : new Error(String(e))) }
    const timer = setTimeout(() => fail(new Error('Google 3D Tiles did not answer within 20 s')), 20_000)
    tiles.addEventListener('load-root-tileset', () => { clearTimeout(timer); resolve(earth) })
    tiles.addEventListener('load-error', (e: any) => { if (!e.tile) fail(e.error ?? new Error('Google 3D Tiles failed to load')) })
    tiles.update() // starts the root tileset request
  })
}
