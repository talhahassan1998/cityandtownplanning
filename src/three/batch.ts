import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Buildings drawn through one merged mesh per material (a few dozen draw calls for a whole town instead
 * of ~5 per building). The per-building groups stay as the pickable/editable copies; callers hide a
 * building's merged triangles while its own group is shown (selection, 3D editing).
 * Not THREE.BatchedMesh: on ANGLE/D3D11 (the target Intel laptops) multi-draw is emulated as one draw per
 * instance, which measured 72 ms/frame for a 1000-building town vs ~30 ms merged.
 */
export type Which = 'body' | 'details'
export interface Batches {
  meshes: THREE.Mesh[]
  /** Shows/hides one building's triangles: its main parts ('body') or its `details` group parts. No-op for unknown ids. */
  setVisible(id: string, which: Which, on: boolean): void
}

type Src = { id: string; which: Which; geo: THREE.BufferGeometry; cast: boolean; receive: boolean }

/** One merged mesh per material over the buildings' meshes (geometry moved by the mesh's transform within its building group). */
export function batchBuildings(buildings: { id: string; group: THREE.Group }[]): Batches {
  const buckets = new Map<string, { material: THREE.Material; srcs: Src[] }>()
  for (const { id, group } of buildings) {
    group.updateMatrixWorld(true)
    const inv = group.matrixWorld.clone().invert(), details = group.userData.details as THREE.Object3D | undefined
    group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      let which: Which = 'body'
      for (let p = mesh.parent; p; p = p.parent) if (p === details) which = 'details'
      const g = mesh.geometry, m = inv.clone().multiply(mesh.matrixWorld)
      // same material, kind and attribute layout → one mesh (mergeGeometries needs matching attributes)
      const key = `${(mesh.material as THREE.Material).uuid}|${which}|${Object.keys(g.attributes).sort()}|${g.index ? 'i' : 'n'}`
      if (!buckets.has(key)) buckets.set(key, { material: mesh.material as THREE.Material, srcs: [] })
      buckets.get(key)!.srcs.push({ id, which, geo: m.equals(new THREE.Matrix4()) ? g : g.clone().applyMatrix4(m), cast: mesh.castShadow, receive: mesh.receiveShadow })
    })
  }
  // a building's vertex range in each merged mesh; hidden = positions zeroed (degenerate), restored from `orig`
  const own = new Map<string, { pos: THREE.BufferAttribute; orig: Float32Array; start: number; count: number; which: Which; on: boolean }[]>()
  const meshes = [...buckets.values()].map(({ material, srcs }) => {
    const geo = mergeGeometries(srcs.map((s) => s.geo))
    const pos = geo.attributes.position as THREE.BufferAttribute, orig = (pos.array as Float32Array).slice()
    let start = 0
    for (const s of srcs) {
      const count = s.geo.attributes.position.count
      if (!own.has(s.id)) own.set(s.id, [])
      own.get(s.id)!.push({ pos, orig, start, count, which: s.which, on: true })
      start += count
    }
    geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = srcs[0].cast; mesh.receiveShadow = srcs[0].receive
    mesh.userData.batch = true
    return mesh
  })
  return {
    meshes,
    setVisible(id, which, on) {
      for (const x of own.get(id) ?? []) {
        if (x.which !== which || x.on === on) continue
        x.on = on
        const a = x.start * 3, b = (x.start + x.count) * 3
        if (on) (x.pos.array as Float32Array).set(x.orig.subarray(a, b), a)
        else (x.pos.array as Float32Array).fill(0, a, b)
        x.pos.addUpdateRange(a, b - a)
        x.pos.needsUpdate = true
      }
    },
  }
}
