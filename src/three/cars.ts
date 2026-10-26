import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Procedural vehicles (no asset files). Bodies are side profiles extruded across the width, so
 * sedans, hatchbacks and SUVs get real silhouettes (bonnet, windscreen, roof, boot) at box cost.
 * Origin on the ground centre, length along +z (front = +z), width along x. Drawn instanced: one
 * InstancedMesh per kind × material slot, materials shared and cached (never disposed).
 */
export type VehicleKind = 'sedan' | 'hatch' | 'suv' | 'bus' | 'truck'
type Slot = 'body' | 'glass' | 'tyre' | 'light' | 'tail' | 'trim'

/** Length, width, height (m). */
export const VEHICLE_SIZE: Record<VehicleKind, [number, number, number]> = {
  sedan: [4.6, 1.8, 1.45], hatch: [4.0, 1.75, 1.5], suv: [4.8, 1.9, 1.8], bus: [12, 2.55, 3.2], truck: [8, 2.5, 3.4],
}

/** A placed vehicle: ground-centre position, heading clockwise from east, nose-up pitch and left-up roll (degrees). */
export interface CarSpot { e: number; n: number; y: number; heading: number; kind: VehicleKind; seed: number; pitch?: number; roll?: number }

/** Side profile (z, y) extruded across `w`, centred on x = 0. */
function extrude(pts: [number, number][], w: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: w, bevelEnabled: false })
  return g.translate(0, 0, -w / 2).rotateY(-Math.PI / 2)
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z)
const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

// car shape: bonnet length, windscreen run, rear-window run, boot length, belt-line height, wheel inset
const SHAPE: Record<'sedan' | 'hatch' | 'suv', { bonnet: number; ws: number; rw: number; boot: number; belt: number; axle: number }> = {
  sedan: { bonnet: 1.15, ws: 0.75, rw: 0.6, boot: 0.85, belt: 0.9, axle: 0.85 },
  hatch: { bonnet: 0.9, ws: 0.7, rw: 0.45, boot: 0.15, belt: 0.92, axle: 0.7 },
  suv: { bonnet: 1.1, ws: 0.6, rw: 0.3, boot: 0.15, belt: 1.05, axle: 0.85 },
}

function build(kind: VehicleKind): Record<Slot, THREE.BufferGeometry[]> {
  const [L, W, H] = VEHICLE_SIZE[kind], f = L / 2, r = -L / 2
  const out: Record<Slot, THREE.BufferGeometry[]> = { body: [], glass: [], tyre: [], light: [], tail: [], trim: [] }
  const tyres = (rad: number, axle: number) => {
    for (const x of [-1, 1]) for (const z of [f - axle, r + axle])
      out.tyre.push(new THREE.CylinderGeometry(rad, rad, 0.24, 8) // 8 sides: wheels were ~40% of a big town's triangles at 14
        .rotateZ(Math.PI / 2).translate(x * (W / 2 - 0.14), rad, z))
  }
  const lamps = (y: number, h: number) => {
    for (const x of [-1, 1]) {
      out.light.push(box(0.36, h, 0.06, x * (W / 2 - 0.3), y, f - 0.02))
      out.tail.push(box(0.32, h, 0.06, x * (W / 2 - 0.28), y, r + 0.02))
    }
  }
  if (kind === 'bus') {
    out.body.push(extrude([[r, 0.35], [f, 0.35], [f, H - 0.15], [f - 0.15, H], [r, H]], W))
    out.glass.push(extrude([[r + 0.4, 1.35], [f + 0.02, 1.35], [f + 0.02, H - 0.35], [r + 0.4, H - 0.35]], W + 0.04))
    tyres(0.5, 2.6); lamps(0.6, 0.18)
  } else if (kind === 'truck') {
    out.body.push(extrude([[f - 2.2, 0.45], [f, 0.45], [f, 2.5], [f - 0.35, 2.9], [f - 2.2, 2.9]], W))
    out.glass.push(extrude([[f - 1.0, 1.7], [f + 0.02, 1.7], [f + 0.02, 2.45], [f - 0.32, 2.85], [f - 1.0, 2.85]], W + 0.04))
    out.trim.push(box(W, H - 0.9, L - 2.35, 0, 0.9, r + (L - 2.35) / 2), box(W * 0.9, 0.3, L - 2.2, 0, 0.6, r + (L - 2.2) / 2))
    tyres(0.5, 1.3); lamps(0.7, 0.16)
  } else {
    const s = SHAPE[kind]
    const wsBase: [number, number] = [f - s.bonnet, s.belt], wsTop: [number, number] = [f - s.bonnet - s.ws, H]
    const rwBase: [number, number] = [r + s.boot, s.belt], rwTop: [number, number] = [r + s.boot + s.rw, H]
    out.body.push(extrude([[r, 0.28], [f, 0.28], [f, 0.62], [f - 0.12, s.belt - 0.05], wsBase, wsTop, rwTop, rwBase, [r + 0.05, s.belt - 0.04], [r, 0.62]], W))
    // glass: the cabin between belt line and roof, pushed 3 cm out of the slopes so windscreen and rear window show
    const t0 = 0.03 / (H - s.belt), t1 = (H - 0.07 - s.belt) / (H - s.belt)
    const g = ([z, y]: [number, number], dz: number): [number, number] => [z + dz, y]
    out.glass.push(extrude([g(lerp(rwBase, rwTop, t0), -0.03), g(lerp(wsBase, wsTop, t0), 0.03), g(lerp(wsBase, wsTop, t1), 0.03), g(lerp(rwBase, rwTop, t1), -0.03)], W + 0.04))
    tyres(0.33, s.axle); lamps(0.6, 0.12)
  }
  return out
}

const parts = new Map<VehicleKind, { slot: Slot; geo: THREE.BufferGeometry }[]>()
/** Merged geometry per material slot for a vehicle kind (cached). */
export function vehicleParts(kind: VehicleKind): { slot: Slot; geo: THREE.BufferGeometry }[] {
  let p = parts.get(kind)
  if (!p) {
    const b = build(kind)
    parts.set(kind, (p = (Object.keys(b) as Slot[]).filter((s) => b[s].length).map((slot) => ({ slot, geo: mergeGeometries(b[slot].map((x) => x.toNonIndexed())) }))))
    for (const x of p) x.geo.userData.shared = true
  }
  return p
}

const mats = new Map<Slot, THREE.MeshStandardMaterial>()
const SLOT_LOOK: Record<Slot, THREE.MeshStandardMaterialParameters> = {
  body: { color: '#ffffff', roughness: 0.35, metalness: 0.4 },
  glass: { color: '#1d2733', roughness: 0.1, metalness: 0.6 },
  tyre: { color: '#1b1b1b', roughness: 0.9 },
  light: { color: '#fff8e1', emissive: '#fff3c4', emissiveIntensity: 0.3 },
  tail: { color: '#b71c1c', emissive: '#7f0000', emissiveIntensity: 0.3 },
  trim: { color: '#e0e0e0', roughness: 0.7 },
}
function slotMaterial(slot: Slot): THREE.MeshStandardMaterial {
  let m = mats.get(slot)
  if (!m) { mats.set(slot, (m = new THREE.MeshStandardMaterial(SLOT_LOOK[slot]))); m.userData.shared = true }
  return m
}

// Moving cars get their own lamp materials so night brightening never touches parked cars (module-wide, like the slot materials).
const fleetLamps = new Map<Slot, THREE.MeshStandardMaterial>()
function fleetMaterial(slot: Slot): THREE.MeshStandardMaterial {
  if (slot !== 'light' && slot !== 'tail') return slotMaterial(slot)
  let m = fleetLamps.get(slot)
  if (!m) { fleetLamps.set(slot, (m = slotMaterial(slot).clone())); m.userData = { shared: true, fleetLamp: true } }
  return m
}

let beamMat: THREE.MeshBasicMaterial | undefined
/** Additive headlight-beam material; alpha gradient from a pixel array (no canvas), bright by the car, fading away and sideways. */
function beamMaterial(): THREE.MeshBasicMaterial {
  if (!beamMat) {
    const W = 8, H = 16, d = new Uint8Array(W * H * 4).fill(255)
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) d[(j * W + i) * 4 + 3] = Math.round(255 * (j / (H - 1)) ** 1.5 * (1 - Math.abs((i + 0.5) / W - 0.5) * 2))
    const t = new THREE.DataTexture(d, W, H); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true
    beamMat = new THREE.MeshBasicMaterial({ map: t, color: '#fff3c4', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    beamMat.userData = { shared: true, beam: true }
  }
  return beamMat
}
const beamGeos = new Map<VehicleKind, THREE.BufferGeometry>()
/** 3 × 8 m flat quad 1–9 m ahead of the nose, in the car's own frame (cached per kind). */
function beamGeometry(kind: VehicleKind): THREE.BufferGeometry {
  let g = beamGeos.get(kind)
  if (!g) { beamGeos.set(kind, (g = new THREE.PlaneGeometry(3, 8).rotateX(-Math.PI / 2).translate(0, 0.05, VEHICLE_SIZE[kind][0] / 2 + 5))); g.userData.shared = true }
  return g
}

const PALETTE: [string, number][] = [['#f4f4f2', 25], ['#b8bcc0', 20], ['#6d7175', 15], ['#16181a', 15], ['#a31b1b', 7], ['#1f4e8c', 7], ['#2f5d3a', 4], ['#c8b896', 4], ['#7a2e5c', 3]]
const TOTAL = PALETTE.reduce((s, [, w]) => s + w, 0)
/** Realistic car colour for a seed: mostly white, silver, grey and black. */
export function carColor(seed: number, out = new THREE.Color()): THREE.Color {
  let x = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % TOTAL
  for (const [c, w] of PALETTE) { if (x < w) return out.set(c); x -= w }
  return out.set(PALETTE[0][0])
}

const R = Math.PI / 180, _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _c = new THREE.Color()
/** Pose matrix of a spot (shared scratch: valid until the next call). Heading is clockwise from east; the model's front is +z (left side +x), scene z = −north; nose up = −x rotation. */
function poseOf(s: CarSpot): THREE.Matrix4 {
  _e.set(-(s.pitch ?? 0) * R, (90 - s.heading) * R, (s.roll ?? 0) * R)
  return _m.compose(_p.set(s.e, s.y, -s.n), _q.setFromEuler(_e), _one)
}

const setShadow = (im: THREE.InstancedMesh, slot: Slot) => { im.castShadow = slot === 'body' || slot === 'trim'; im.receiveShadow = slot === 'body' }

/**
 * Moving fleet: fixed-capacity dynamic InstancedMeshes per kind × slot, re-posed every frame by update()
 * (allocation-light). Poses beyond a kind's capacity are dropped.
 */
export function carFleet(capacity: Partial<Record<VehicleKind, number>>): { meshes: THREE.InstancedMesh[]; update(poses: CarSpot[]): void; setDarkness(d: number): void } {
  const groups = (Object.keys(capacity) as VehicleKind[]).filter((k) => capacity[k]! > 0).map((kind) => {
    const ims: { im: THREE.InstancedMesh; body: boolean }[] = vehicleParts(kind).map(({ slot, geo }) => {
      const im = new THREE.InstancedMesh(geo, fleetMaterial(slot), capacity[kind]!)
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.count = 0; im.frustumCulled = false; setShadow(im, slot)
      if (slot === 'body') { im.setColorAt(0, _c.set('#ffffff')); im.instanceColor!.setUsage(THREE.DynamicDrawUsage) }
      return { im, body: slot === 'body' }
    })
    // beam: same pose matrices as the car (geometry is pre-offset ahead of the nose); ponytail: beams don't bend with the road or clip at junctions
    const beam = new THREE.InstancedMesh(beamGeometry(kind), beamMaterial(), capacity[kind]!)
    beam.instanceMatrix.setUsage(THREE.DynamicDrawUsage); beam.count = 0; beam.frustumCulled = false; beam.visible = false; beam.renderOrder = 2
    beam.castShadow = beam.receiveShadow = false
    ims.push({ im: beam, body: false })
    return { kind, cap: capacity[kind]!, ims, beam }
  })
  return {
    meshes: groups.flatMap((g) => g.ims.map((x) => x.im)),
    setDarkness(d) {
      fleetMaterial('light').emissiveIntensity = 0.3 + 2.7 * d
      fleetMaterial('tail').emissiveIntensity = 0.3 + 1.7 * d
      beamMaterial().opacity = 0.35 * d
      for (const g of groups) g.beam.visible = d > 0
    },
    update(poses) {
      for (const g of groups) {
        let n = 0
        for (const s of poses) {
          if (s.kind !== g.kind || n >= g.cap) continue
          const m = poseOf(s)
          for (const { im, body } of g.ims) { im.setMatrixAt(n, m); if (body) im.setColorAt(n, carColor(s.seed, _c)) }
          n++
        }
        for (const { im, body } of g.ims) { im.count = n; im.instanceMatrix.needsUpdate = true; if (body) im.instanceColor!.needsUpdate = true }
      }
    },
  }
}

/** Instanced meshes for the spots: one per kind × slot; body colour per instance. */
export function carMeshes(spots: CarSpot[]): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = []
  for (const kind of Object.keys(VEHICLE_SIZE) as VehicleKind[]) {
    const mine = spots.filter((s) => s.kind === kind)
    if (!mine.length) continue
    for (const { slot, geo } of vehicleParts(kind)) {
      const im = new THREE.InstancedMesh(geo, slotMaterial(slot), mine.length)
      mine.forEach((s, i) => {
        im.setMatrixAt(i, poseOf(s))
        if (slot === 'body') im.setColorAt(i, carColor(s.seed))
      })
      setShadow(im, slot)
      out.push(im)
    }
  }
  return out
}
