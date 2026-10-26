import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { FlowNet, FlowPipe } from '../pipeflow'
import { withNight } from './facades'

/**
 * Underground view: water / sewer pipes as tubes at depth (one merged mesh per network) with pulses running
 * in the flow direction (a shader patch on `flow` = metres along the pipe; only uniforms change per frame),
 * manhole shafts up to the ground, and `ghost` — the see-through look for everything else.
 */
export interface PipeMeshes {
  group: THREE.Group
  /** Feature id of a hit on a pipe mesh. */
  pick(hit: THREE.Intersection): string | undefined
  setTime(t: number): void
  dispose(): void
}

const LOOK = { water: { base: '#1565c0', pulse: '#4fc3f7' }, sewer: { base: '#5d4037', pulse: '#d7a86e' } } as const
const SIDES = 6, SPACING = 8

/** Tubes for one network: positions/normals plus `flow` (m along the pipe) and `live` (1 = animated); triangle ranges per pipe. */
function tubes(pipes: FlowPipe[]) {
  const pos: number[] = [], nor: number[] = [], flow: number[] = [], live: number[] = [], idx: number[] = [], ranges: { end: number; id: string }[] = []
  const up = new THREE.Vector3(0, 1, 0), t = new THREE.Vector3(), side = new THREE.Vector3(), top = new THREE.Vector3(), v = new THREE.Vector3()
  for (const p of pipes) {
    const r = Math.max(p.diameter / 2000, 0.25), pts = p.pts.map(([e, n, y]) => new THREE.Vector3(e, y, -n)), base = pos.length / 3
    let s = 0
    pts.forEach((c, i) => {
      if (i) s += c.distanceTo(pts[i - 1])
      t.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize()
      side.crossVectors(t, up)
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
      side.normalize(); top.crossVectors(side, t).normalize()
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2
        v.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(top, Math.sin(a))
        nor.push(v.x, v.y, v.z); pos.push(c.x + v.x * r, c.y + v.y * r, c.z + v.z * r); flow.push(s); live.push(p.connected ? 1 : 0)
      }
    })
    for (let i = 0; i + 1 < pts.length; i++)
      for (let k = 0; k < SIDES; k++) {
        const a = base + i * SIDES + k, b = base + i * SIDES + ((k + 1) % SIDES), c = a + SIDES, d = b + SIDES
        idx.push(a, c, b, b, c, d)
      }
    ranges.push({ end: idx.length / 3, id: p.id })
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 1))
  g.setAttribute('live', new THREE.Float32BufferAttribute(live, 1))
  g.setIndex(idx)
  return { g, ranges }
}

/** Standard material + pulses: emissive += pulse colour where fract((flow − t·speed) / 8 m) is near 1, on live pipes. */
function flowMaterial(net: 'water' | 'sewer', speed: number) {
  const m = new THREE.MeshStandardMaterial({ color: LOOK[net].base, roughness: 0.5, metalness: 0.1 })
  // ponytail: one speed per network; per-pipe speeds (hydraulics) would move into a vertex attribute
  const uniforms = { uTime: { value: 0 }, uSpeed: { value: speed }, uPulse: { value: new THREE.Color(LOOK[net].pulse) } }
  m.userData.uniforms = uniforms
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms)
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float flow;\nattribute float live;\nvarying float vFlow;\nvarying float vLive;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFlow = flow; vLive = live;')
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSpeed;\nuniform vec3 uPulse;\nvarying float vFlow;\nvarying float vLive;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += uPulse * vLive * smoothstep(0.6, 1.0, fract((vFlow - uTime * uSpeed) / ${SPACING.toFixed(1)}));`)
  }
  m.customProgramCacheKey = () => 'pipe-flow'
  return m
}

export function pipeMeshes(net: FlowNet): PipeMeshes {
  const group = new THREE.Group(), owned: { g: THREE.BufferGeometry; m: THREE.Material }[] = []
  const add = (g: THREE.BufferGeometry, m: THREE.Material, data: Record<string, unknown>) => {
    const mesh = new THREE.Mesh(g, m)
    Object.assign(mesh.userData, { pipe: true }, data)
    group.add(mesh); owned.push({ g, m })
    return mesh
  }
  for (const n of ['water', 'sewer'] as const) {
    const ps = net.pipes.filter((p) => p.network === n)
    if (!ps.length) continue
    const { g, ranges } = tubes(ps)
    add(g, flowMaterial(n, ps[0].speed), { network: n, ranges })
  }
  if (net.manholes.length) {
    const shafts = net.manholes.map(([e, n, yPipe, yGround]) => new THREE.CylinderGeometry(0.6, 0.6, Math.max(0.1, yGround - yPipe), 8, 1, true).translate(e, (yPipe + yGround) / 2, -n))
    add(mergeGeometries(shafts), new THREE.MeshStandardMaterial({ color: '#6d7278', roughness: 0.8, side: THREE.DoubleSide }), { manholes: true })
  }
  return {
    group,
    pick(hit) {
      const ranges = hit.object.userData.ranges as { end: number; id: string }[] | undefined
      if (!ranges || hit.faceIndex === undefined || hit.faceIndex === null) return undefined
      let lo = 0, hi = ranges.length - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ranges[mid].end > hit.faceIndex) hi = mid; else lo = mid + 1 }
      return ranges[lo]?.id
    },
    setTime(t) { for (const { m } of owned) if (m.userData.uniforms) m.userData.uniforms.uTime.value = t },
    dispose() { for (const { g, m } of owned) { g.dispose(); m.dispose() } },
  }
}

// ghost copies, cached per original material and opacity; shared (they outlive scenes, like building materials)
const ghosts = new WeakMap<THREE.Material, Map<number, THREE.Material>>()
const ghostOf = (m: THREE.Material, opacity: number) => {
  let byOp = ghosts.get(m)
  if (!byOp) ghosts.set(m, (byOp = new Map()))
  let c = byOp.get(opacity)
  if (!c) {
    c = withNight(m.clone(), m)
    Object.assign(c, { transparent: true, opacity, depthWrite: false })
    c.userData.shared = true
    byOp.set(opacity, c)
  }
  // follow the original's current look (selection highlights change colour / emissive on per-scene materials)
  const o = m as THREE.MeshStandardMaterial, g = c as THREE.MeshStandardMaterial
  if (o.color && g.color) g.color.copy(o.color)
  if (o.emissive && g.emissive) { g.emissive.copy(o.emissive); g.emissiveIntensity = o.emissiveIntensity }
  return c
}

/** Underground, the see-through surface above a pipe is hit first: prefer the pipe. */
export const preferPipe = (hits: THREE.Intersection[]): THREE.Intersection | undefined => hits.find((h) => h.object.userData.pipe) ?? hits[0]

/** Swaps each mesh's material for a cached transparent copy (on) or back (off). Never touches originals; skips pipes. */
export function ghost(objects: THREE.Object3D[], on: boolean, opacityOf: (o: THREE.Object3D) => number): void {
  for (const root of objects)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || mesh.userData.pipe) return
      if (on) {
        if (mesh.userData.ghostOf !== undefined) return
        mesh.userData.ghostOf = mesh.material
        const op = opacityOf(mesh)
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => ghostOf(m, op)) : ghostOf(mesh.material, op)
      } else if (mesh.userData.ghostOf !== undefined) {
        mesh.material = mesh.userData.ghostOf
        delete mesh.userData.ghostOf
      }
    })
}
