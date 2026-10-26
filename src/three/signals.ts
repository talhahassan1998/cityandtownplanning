import * as THREE from 'three'
import { signalAt, type Light, type RoadGraph } from './drive'

/** Traffic-light heads at signalled junctions (drive.ts): a pole + 3-lamp head per arm, lamps coloured by the phase. */
export interface SignalHeads {
  /** [poles, housings, lamps]; empty when no junction is signalled. */
  meshes: THREE.InstancedMesh[]
  /** Recolours lamps for sim time t; only touches instanceColor when some head's light changed. */
  update(t: number): void
}

const POLE = 4.5
const LIT: Record<Light, THREE.Color> = { red: new THREE.Color('#ff2a1a'), amber: new THREE.Color('#ffb300'), green: new THREE.Color('#2ee66b') }
const ORDER: Light[] = ['red', 'amber', 'green'] // top to bottom
const DIM = Object.fromEntries(ORDER.map((l) => [l, LIT[l].clone().multiplyScalar(0.12)])) as Record<Light, THREE.Color>

let shared: { pole: THREE.BufferGeometry; housing: THREE.BufferGeometry; lamp: THREE.BufferGeometry; dark: THREE.Material } | undefined
const parts = () => {
  if (!shared) {
    shared = {
      pole: new THREE.CylinderGeometry(0.08, 0.08, POLE, 6).translate(0, POLE / 2, 0),
      housing: new THREE.BoxGeometry(0.35, 1, 0.35),
      lamp: new THREE.SphereGeometry(0.12, 8, 6),
      dark: new THREE.MeshStandardMaterial({ color: '#2b2f33', roughness: 0.6 }),
    }
    for (const g of [shared.pole, shared.housing, shared.lamp]) g.userData.shared = true
    shared.dark.userData.shared = true
  }
  return shared
}

/** One head per signalled arm: on the driver's side of the approach, 1 m back from the box edge, facing oncoming cars. */
export function signalHeads(g: RoadGraph, side: 'left' | 'right', ground: (e: number, n: number) => number): SignalHeads {
  const heads = g.nodes.flatMap((nd) => (nd.signal?.arms ?? []).map((id) => {
    const e = g.edges[id], q = e.a === nd.id ? e.pts[1] : e.pts[e.pts.length - 2], d = Math.hypot(q[0] - nd.p[0], q[1] - nd.p[1]) || 1
    const u: [number, number] = [(q[0] - nd.p[0]) / d, (q[1] - nd.p[1]) / d] // away from the node along the arm
    // cars arrive travelling −u; they keep left (left-hand traffic) or right: the near kerb is that side of −u
    const s = side === 'left' ? 1 : -1, perp: [number, number] = [u[1] * s, -u[0] * s]
    const k = nd.r + 1, w = e.width / 2 + 0.5
    const p: [number, number] = [nd.p[0] + u[0] * k + perp[0] * w, nd.p[1] + u[1] * k + perp[1] * w]
    return { nd, edge: id, p, u, y: ground(p[0], p[1]) }
  }))
  if (!heads.length) return { meshes: [], update() {} }
  const { pole, housing, lamp, dark } = parts()
  const poles = new THREE.InstancedMesh(pole, dark, heads.length), boxes = new THREE.InstancedMesh(housing, dark, heads.length)
  const lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ toneMapped: false }), heads.length * 3) // unlit: reads at night too
  poles.castShadow = boxes.castShadow = true
  boxes.userData.signalHousings = true
  lamps.userData.signalLamps = true
  const m = new THREE.Matrix4()
  heads.forEach((h, i) => {
    poles.setMatrixAt(i, m.makeTranslation(h.p[0], h.y, -h.p[1]))
    boxes.setMatrixAt(i, m.makeTranslation(h.p[0], h.y + POLE - 0.5, -h.p[1]))
    // lamps on the face towards the approaching cars (scene z = −north)
    ORDER.forEach((l, k) => lamps.setMatrixAt(i * 3 + k, m.makeTranslation(h.p[0] + h.u[0] * 0.18, h.y + POLE - 0.2 - k * 0.3, -(h.p[1] + h.u[1] * 0.18))))
  })
  const shown: (Light | undefined)[] = heads.map(() => undefined)
  const update = (t: number) => {
    let changed = false
    heads.forEach((h, i) => {
      const now = signalAt(h.nd, h.edge, t)
      if (now === shown[i]) return
      shown[i] = now; changed = true
      ORDER.forEach((l, k) => lamps.setColorAt(i * 3 + k, l === now ? LIT[l] : DIM[l]))
    })
    if (changed) lamps.instanceColor!.needsUpdate = true
  }
  update(0)
  return { meshes: [poles, boxes, lamps], update }
}
