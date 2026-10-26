import * as THREE from 'three'

/**
 * Procedural component models (no asset files): details on flat component areas and small
 * street-furniture models for point features (buildings live in `buildings/`). Everything is built in an
 * oriented-box frame — local x along the footprint's long axis, y up, z = −(short axis) — so it
 * fits any footprint size. Shared by the 3D view, the map's 3D layer and the library thumbnails.
 */
export interface OBox { cx: number; cy: number; hx: number; hy: number; angle: number }

const std = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra })

// --- small builders --------------------------------------------------------------------------
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
  o.position.set(x, y + h / 2, z)
  o.castShadow = true
  return o
}
function cyl(r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 12, rTop = r): THREE.Mesh {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, seg), m)
  o.position.set(x, y + h / 2, z)
  o.castShadow = true
  return o
}
const group = (...kids: THREE.Object3D[]) => { const g = new THREE.Group(); g.add(...kids); return g }
/** Group placed on an oriented box's centre at height `y`, rotated to its long axis. */
function onBox(ob: OBox, y: number, kids: THREE.Object3D[]): THREE.Group {
  const g = group(...kids)
  g.position.set(ob.cx, y, -ob.cy)
  g.rotation.y = ob.angle
  return g
}

/** Parking bay centres (box frame x, z) for an area of half-size hx × hy: two rows facing the aisle. */
export function parkingBays(hx: number, hy: number): [number, number][] {
  const out: [number, number][] = []
  for (let x = -hx + 1.5; x <= hx - 1.5; x += 2.6) for (const z of [-hy + 2.6, hy - 2.6]) out.push([x, z])
  return out
}

/** Bay line centres (box frame x, z); each line is 0.1 m across x and 5 m along z. */
export function parkingLines(hx: number, hy: number): [number, number][] {
  const out: [number, number][] = []
  for (let x = -hx + 0.2; x <= hx; x += 2.6) for (const z of [-hy + 2.6, hy - 2.6]) out.push([x, z])
  return out
}

// --- flat areas -----------------------------------------------------------------------------
/** Details on a flat component area (pitch markings, cars, panels, tanks…) at ground height `y`. */
export function groundExtras(type: string, ob: OBox, y: number, seed: number): THREE.Object3D[] {
  const { hx: L, hy: W } = ob
  const white = std('#ffffff'), kids: THREE.Object3D[] = []
  const flat = (w: number, d: number, m: THREE.Material, x = 0, z = 0) => { const o = box(w, 0.05, d, m, x, 0.05, z); o.castShadow = false; o.receiveShadow = true; return o }
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, at: [number, number, number, number][]) => {
    const im = new THREE.InstancedMesh(geo, mat, at.length), mtx = new THREE.Matrix4(), q = new THREE.Quaternion()
    at.forEach(([x, yy, z, ry], i) => im.setMatrixAt(i, mtx.compose(new THREE.Vector3(x, yy, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1))))
    im.castShadow = true
    return im
  }
  switch (type) {
    case 'football': {
      const l = L * 0.92, w = W * 0.9, t = 0.12
      kids.push(flat(2 * l, t, white, 0, w), flat(2 * l, t, white, 0, -w), flat(t, 2 * w, white, l), flat(t, 2 * w, white, -l), flat(t, 2 * w, white))
      const ring = new THREE.Mesh(new THREE.RingGeometry(9.0, 9.15, 48), white); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1; kids.push(ring)
      for (const s of [-1, 1]) {
        kids.push(flat(t, 40, white, s * (l - 16.5)), flat(16.5, t, white, s * (l - 8.25), 20), flat(16.5, t, white, s * (l - 8.25), -20))
        kids.push(box(0.12, 2.44, 0.12, white, s * l, 0, 3.66), box(0.12, 2.44, 0.12, white, s * l, 0, -3.66), box(0.12, 0.12, 7.44, white, s * l, 2.44, 0))
      }
      break
    }
    case 'cricket':
      kids.push(flat(20, 3, std('#c8a46a')))
      for (const s of [-1, 1]) kids.push(box(0.05, 0.7, 0.25, std('#f5e6c8'), s * 10, 0, 0))
      break
    case 'playground': {
      const steel = std('#e53935', { metalness: 0.3 }), yel = std('#fdd835')
      kids.push(box(0.1, 2.2, 0.1, steel, -3, 0, -1), box(0.1, 2.2, 0.1, steel, -3, 0, 1), box(0.1, 2.2, 0.1, steel, 1, 0, -1), box(0.1, 2.2, 0.1, steel, 1, 0, 1), box(4.2, 0.1, 0.1, steel, -1, 2.2, -1), box(4.2, 0.1, 0.1, steel, -1, 2.2, 1))
      const slide = box(1, 0.1, 4, yel, 4, 0.8, 0); slide.rotation.x = 0.45; kids.push(slide, box(1.2, 1.6, 1.2, std('#1e88e5'), 4, 0, -2.4))
      break
    }
    case 'parking': {
      // bay markings only; the cars come from traffic.ts (parkingBays)
      for (const [x, z] of parkingLines(L, W)) kids.push(flat(0.1, 5, white, x, z))
      break
    }
    case 'solar': {
      const at: [number, number, number, number][] = []
      for (let x = -L + 3; x <= L - 3 && at.length < 600; x += 6) for (let z = -W + 3; z <= W - 3 && at.length < 600; z += 5) at.push([x, 0, z, 0])
      kids.push(instanced(new THREE.BoxGeometry(5, 0.08, 2.4).rotateX(0.5).translate(0, 1.3, 0), std('#1a2a4a', { metalness: 0.5, roughness: 0.25 }), at))
      break
    }
    case 'treatment': {
      const at: [number, number, number, number][] = []
      for (let x = -L + 9; x <= L - 9; x += 18) for (let z = -W + 9; z <= W - 9; z += 18) at.push([x, 0, z, 0])
      kids.push(instanced(new THREE.CylinderGeometry(7, 7, 3, 24).translate(0, 1.5, 0), std('#b0bec5'), at))
      kids.push(instanced(new THREE.CylinderGeometry(6.6, 6.6, 0.1, 24).translate(0, 2.96, 0), std('#4e7d6a', { roughness: 0.2 }), at))
      break
    }
    case 'substation': {
      const grey = std('#8d939b')
      for (let x = -L * 0.6; x <= L * 0.6; x += Math.max(4, L * 0.4)) kids.push(box(2.5, 3, 2, grey, x, 0, 0), cyl(0.1, 6, std('#cfd3d8'), x, 0, -2.5, 6))
      kids.push(...[L, -L].map((x) => box(0.08, 2.2, 2 * W, std('#9e9e9e', { transparent: true, opacity: 0.5 }), x * 0.98)))
      break
    }
    case 'waste':
      kids.push(cyl(Math.min(L, W) * 0.8, Math.min(L, W) * 0.35, std('#6d5f4b'), -L * 0.2, 0, 0, 16, 0.5))
      for (let i = 0; i < 4; i++) kids.push(box(2.4, 1.6, 1.4, std(['#2e7d32', '#1565c0', '#f9a825', '#6d4c41'][i]), L * 0.6, 0, -W * 0.6 + i * 2.2))
      break
    case 'pump-station':
      kids.push(box(L * 1.6, 4, W * 1.6, std('#b0a89a')), cyl(0.4, 2, std('#1565c0'), L * 0.9, 0, 0, 10))
      break
    case 'roundabout':
      kids.push(cyl(2.5, 0.6, std('#cfd8dc')), cyl(0.3, 2.5, std('#4fc3f7', { roughness: 0.2 }), 0, 0.6, 0, 10))
      break
  }
  return kids.length ? [onBox(ob, y, kids)] : []
}

// --- points ---------------------------------------------------------------------------------
/** Street-furniture model for a point component, origin on the ground, materials owned by the group. */
export function pointModel(type: string, color: string): THREE.Group {
  const g = new THREE.Group()
  const M = (c: string, extra?: THREE.MeshStandardMaterialParameters) => std(c, extra)
  switch (type) {
    case 'hydrant': {
      const red = M('#d32f2f')
      g.add(cyl(0.18, 0.75, red), cyl(0.2, 0.1, red, 0, 0.75, 0, 12, 0.08))
      const nz = cyl(0.07, 0.4, red); nz.rotation.z = Math.PI / 2; nz.position.y = 0.5; g.add(nz)
      break
    }
    case 'valve':
      g.add(box(0.5, 0.06, 0.5, M('#37474f')), cyl(0.04, 0.6, M('#1565c0'), 0, 0, 0, 6))
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 16), M('#1565c0')))
      g.children[2].position.y = 0.62; g.children[2].rotation.x = Math.PI / 2
      break
    case 'manhole':
      g.add(cyl(0.35, 0.06, M('#3e4349', { metalness: 0.6 }), 0, 0, 0, 20))
      break
    case 'outfall':
      g.add(box(2.4, 1.6, 0.4, M('#9e9e9e')))
      g.add(cyl(0.45, 1.2, M('#616161')))
      g.children[1].position.set(0, 0.7, 0.6); g.children[1].rotation.x = Math.PI / 2
      break
    case 'transformer':
      g.add(cyl(0.15, 9, M('#8d6e63'), 0, 0, 0, 8), box(0.9, 1.2, 0.7, M('#607d8b'), 0, 5.5, 0.5), box(1.6, 0.1, 0.1, M('#8d6e63'), 0, 8.5, 0))
      break
    case 'telecom-cabinet':
      g.add(box(1.2, 1.4, 0.5, M('#9e9e9e')), box(1.24, 0.06, 0.54, M('#757575'), 0, 1.4, 0))
      break
    case 'water-tank': {
      const leg = M('#78909c')
      for (const [x, z] of [[-2, -2], [2, -2], [2, 2], [-2, 2]]) g.add(cyl(0.2, 12, leg, x, 0, z, 6))
      g.add(cyl(3.2, 4, M('#4a8fe0'), 0, 12, 0, 20), cyl(3.3, 1.2, M('#4a8fe0'), 0, 16, 0, 20, 0.4))
      break
    }
    case 'bus-stop': {
      const frame = M('#455a64', { metalness: 0.4 })
      g.add(box(3, 2.4, 0.08, M('#b3e5fc', { transparent: true, opacity: 0.45 }), 0, 0, -0.7))
      g.add(cyl(0.05, 2.5, frame, -1.5, 0, -0.7, 6), cyl(0.05, 2.5, frame, 1.5, 0, -0.7, 6), box(3.4, 0.08, 1.6, frame, 0, 2.5, 0))
      g.add(box(2.6, 0.08, 0.4, M('#8d6e63'), 0, 0.45, -0.45), cyl(0.04, 2.8, frame, 2.1, 0, 0.6, 6), cyl(0.3, 0.04, M('#1e88e5'), 2.1, 2.8, 0.6, 16))
      break
    }
    default: // generic node: coloured bollard with a cap
      g.add(cyl(0.6, 2.4, M(color), 0, 0, 0, 12), new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 8), M(color)))
      g.children[1].position.y = 2.4
  }
  g.traverse((o) => { o.castShadow = true })
  return g
}
