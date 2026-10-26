import * as THREE from 'three'

/** Pure helpers for editing in the 3D view: ring rotation, ground hits, compass heading (what can move: model.ts). */
import { isMovable, type PlanFeature } from '../model'
export { isMovable }

/** The ring rotates shapes only: point items have no rotation (rotateFeatures skips them). */
export const isRotatable = (f: PlanFeature) => isMovable(f) && f.geometry.type !== 'Point'

export { ringAngle } from '../geo'

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
/** Where the ray meets the terrain mesh (null past its edge, so nothing lands outside the scene area);
 *  without a terrain mesh, the y = 0 ground plane; null when it never reaches the ground. */
export function groundHit(ray: THREE.Raycaster, terrain: THREE.Object3D | null): THREE.Vector3 | null {
  if (terrain) return ray.intersectObject(terrain, false)[0]?.point.clone() ?? null
  return ray.ray.intersectPlane(GROUND, new THREE.Vector3())
}

/** Compass heading (degrees clockwise from north; scene north = −z) the camera looks along towards `target`.
 *  Looking straight down, the screen's up direction is the heading. */
export function cameraHeading(camera: THREE.Camera, target: THREE.Vector3): number {
  let dx = target.x - camera.position.x, dz = target.z - camera.position.z
  if (Math.hypot(dx, dz) < 1e-3) { const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); dx = up.x; dz = up.z }
  return (Math.atan2(dx, -dz) * 180) / Math.PI
}
