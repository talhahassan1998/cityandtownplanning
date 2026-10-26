import * as THREE from 'three'
import { componentGeometry } from '../roads'
import { defaultAttrs, type ComponentDef, type Layer, type PlanFeature } from '../model'
import { buildScene, sceneBounds } from './scene'
import { NIGHT } from './facades'

const C: [number, number] = [0, 0]
const LAYER: Layer = { id: 't', name: '', kind: 'buildings', visible: true, locked: false, opacity: 1 }

/**
 * Renders each component once through the real 3D scene builder (so thumbnails match the 3D
 * view) into PNG data URLs, using one throwaway WebGL context.
 */
export function renderThumbs(defs: ComponentDef[], px = 56): Record<string, string> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(px, px, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(1, 2, 1.5)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 1.4), sun)
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 5000)
  const out: Record<string, string> = {}
  // thumbnails are cached for the session: always render them in daylight, whatever the live night state
  const dark = Object.values(NIGHT).map(n => n.uDark.value)
  for (const n of Object.values(NIGHT)) n.uDark.value = 0
  try {
  for (const def of defs) {
    const id = def.type
    const f: PlanFeature = { type: 'Feature', id, geometry: componentGeometry(def, C), properties: { id, type: def.type, layerId: 't', name: def.label, attrs: defaultAttrs(def) } }
    const { origin, bounds } = sceneBounds([f], C, 5)
    const built = buildScene([f], [LAYER], origin, bounds, { exaggeration: 1, selection: new Set(), trees: true, streetLights: false })
    scene.add(built.group)
    const sphere = new THREE.Box3().setFromObject(built.group).getBoundingSphere(new THREE.Sphere())
    const d = (sphere.radius || 5) / Math.sin(THREE.MathUtils.degToRad(15)) * 0.9
    camera.position.copy(sphere.center).add(new THREE.Vector3(0.55, 0.6, 0.6).normalize().multiplyScalar(d))
    camera.lookAt(sphere.center)
    renderer.render(scene, camera)
    out[id] = renderer.domElement.toDataURL()
    scene.remove(built.group)
    built.dispose()
  }
  } finally {
    Object.values(NIGHT).forEach((n, i) => { n.uDark.value = dark[i] })
    renderer.dispose()
    renderer.forceContextLoss()
  }
  return out
}
