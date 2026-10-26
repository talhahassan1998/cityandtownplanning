import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import * as turf from '@turf/turf'
import { Pause, Play } from 'lucide-react'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { lockedIds, useStore } from '../store'
import { snapToGrid } from '../geo'
import { componentDef, isMovable } from '../model'
import { componentGeometry } from '../roads'
import { cameraHeading, groundHit, isRotatable, ringAngle } from './edit3d'
import { buildScene, buildTerrain, nearCentre, sceneBounds, setDetailVisibility, type BuiltScene } from './scene'
import { preferPipe } from './pipes'
import { loadElevation, loadMosaic, tilesFor, TERRAIN_ATTRIBUTION, type Elevation, type TileRange } from './terrain'
import { darkness } from './night'
import { advanceHour, clockLabel, sunDirection, sunPosition, SEASONS } from './sun'
import { googleKey, googleSession, googleTileUrl } from '../map/google'

type CamMode = 'orbit' | 'top' | 'walk'
interface Opts { camera: CamMode; terrain: boolean; exaggeration: number; hour: number; day: number; shadows: boolean; trees: boolean; lights: boolean; cars: boolean; playing: boolean; speed: 1 | 60 | 600 | 3600; underground: boolean }

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const EYE = 1.7

/**
 * Three.js city view over the same store as the 2D map: every edit rebuilds the scene, and
 * clicking an object selects it for the Properties panel. Terrain and ground imagery load once
 * per area; the rest of the scene is rebuilt (debounced) on change.
 */
export default function CityView() {
  const host = useRef<HTMLDivElement>(null)
  const [o, setO] = useState<Opts>({ camera: 'orbit', terrain: true, exaggeration: 1, hour: 15, day: 172, shadows: true, trees: true, lights: true, cars: true, playing: true, speed: 1, underground: false })
  const [status, setStatus] = useState('')
  const [locked, setLocked] = useState(false)
  const optsRef = useRef(o)
  const hourRef = useRef(o.hour) // the running clock; state only mirrors it (throttled) for the slider
  const api = useRef<{ setOpts(o: Opts, prev: Opts): void; drop(x: number, y: number, type: string): void; faceNorth(): void } | null>(null)
  const compass = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = host.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false })
    renderer.setPixelRatio(Math.min(2, devicePixelRatio))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 30000)
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true
    orbit.maxPolarAngle = Math.PI * 0.49
    orbit.zoomToCursor = true // zoom towards what's under the mouse, like the 2D map
    orbit.minDistance = 2
    const walk = new PointerLockControls(camera, renderer.domElement)
    walk.addEventListener('lock', () => setLocked(true))
    walk.addEventListener('unlock', () => setLocked(false))

    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x8a7f6a, 1.1)
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4)
    sun.castShadow = true
    scene.add(hemi, sun, sun.target)

    let built: BuiltScene | null = null
    let terrain: { key: string; mesh: THREE.Mesh } | null = null
    let env: { key: string; elevation?: Elevation; ground?: { texture: THREE.Texture; range: TileRange } } | null = null
    let framed = false
    let disposed = false

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    const lat = () => useStore.getState().meta.center[1]
    const NIGHT = new THREE.Color('#0d1626'), NOON = new THREE.Color('#b9d3ec')
    const sky = new THREE.Color(NOON), fog = new THREE.Fog(sky, 1, 2)
    scene.background = sky; scene.fog = fog
    let sunHour = hourRef.current // hour the sun was last placed for
    const placeSun = () => {
      sunHour = hourRef.current
      const r = built?.radius ?? 500
      const { elevation } = sunPosition(lat(), optsRef.current.day, hourRef.current)
      const [x, y, z] = sunDirection(lat(), optsRef.current.day, hourRef.current)
      const day = Math.max(0, Math.min(1, elevation / 10 + 0.3)) // fades through dusk
      sun.position.set(orbit.target.x + x * r * 2, orbit.target.y + Math.max(y, 0.02) * r * 2, orbit.target.z + z * r * 2)
      sun.target.position.copy(orbit.target)
      sun.intensity = 2.4 * Math.max(0, Math.min(1, elevation / 10)) // ramps up from the horizon, no pop
      hemi.intensity = 0.25 + 0.85 * day
      built?.setNight(darkness(elevation), hourRef.current)
      sky.lerpColors(NIGHT, NOON, day)
      fog.color.copy(sky); fog.near = r * 3; fog.far = r * 9 // mutate, never replace: a new scene.fog makes three re-link fog materials
      const sc = sun.shadow.camera
      sc.left = sc.bottom = -r; sc.right = sc.top = r; sc.near = 1; sc.far = r * 5
      sc.updateProjectionMatrix()
      sun.shadow.mapSize.setScalar(r < 600 ? 4096 : 2048)
      sun.shadow.bias = -0.0005
      renderer.shadowMap.enabled = optsRef.current.shadows
      sun.castShadow = optsRef.current.shadows
    }

    // Terrain + ground imagery for the current area (cached by area/options).
    const loadEnv = async (bounds: [number, number, number, number]) => {
      const s = useStore.getState(), op = optsRef.current
      const key = `${bounds.map((v) => v.toFixed(3))}|${op.terrain}|${s.meta.basemap}`
      if (env?.key === key) return env
      setStatus('Loading terrain & imagery…')
      const next: NonNullable<typeof env> = { key }
      const problems: string[] = []
      await Promise.all([
        op.terrain ? loadElevation(bounds).then((e) => { next.elevation = e }).catch(() => problems.push('terrain unavailable — showing flat ground')) : null,
        s.meta.basemap !== 'none' ? (async () => {
          const range = tilesFor(bounds, 64, 18)
          // Google basemap → the same Google imagery on the 3D ground (one session; OSM if Google fails)
          let tpl = OSM
          const gk = googleKey()
          if (s.meta.basemap.startsWith('google-') && gk)
            tpl = await googleSession(gk, s.meta.basemap === 'google-satellite' ? 'satellite' : 'roadmap').then((ss) => googleTileUrl(gk, ss)).catch(() => OSM)
          const { canvas, failed } = await loadMosaic(tpl, range)
          if (failed === range.cols * range.rows) { problems.push('imagery unavailable'); return }
          if (s.meta.basemap === 'grey') {
            const ctx = canvas.getContext('2d')!
            ctx.filter = 'grayscale(0.9) brightness(1.08)'
            ctx.drawImage(canvas, 0, 0)
          }
          const texture = new THREE.CanvasTexture(canvas)
          texture.colorSpace = THREE.SRGBColorSpace
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
          next.ground = { texture, range }
        })() : null,
      ])
      env?.ground?.texture.dispose()
      env = next
      setStatus(problems.join(' · '))
      return env
    }

    let token = 0
    const rebuild = async () => {
      const my = ++token
      const s = useStore.getState()
      const features = nearCentre(Object.values(s.features), s.meta.center)
      const { origin, bounds } = sceneBounds(features, s.meta.center)
      const e = await loadEnv(bounds)
      if (disposed || my !== token) return
      const op = optsRef.current
      const t0 = performance.now()
      // terrain only changes with the area, imagery or exaggeration — keep it otherwise
      const tKey = `${e.key}|${op.exaggeration}`
      if (terrain?.key !== tKey) {
        if (terrain) { scene.remove(terrain.mesh); terrain.mesh.geometry.dispose(); ((terrain.mesh.userData.ghostOf ?? terrain.mesh.material) as THREE.Material).dispose() } // the original, never a shared ghost copy
        terrain = { key: tKey, mesh: buildTerrain(origin, bounds, e.elevation, op.exaggeration, e.ground) }
        scene.add(terrain.mesh)
      }
      const next = buildScene(features, s.layers, origin, bounds, {
        elevation: e.elevation, exaggeration: op.exaggeration,
        selection: new Set(s.selection), trees: op.trees, streetLights: op.lights, cars: op.cars, moving: true, settings: s.meta.settings,
      })
      if (import.meta.env.DEV) console.debug(`[3d] scene built in ${Math.round(performance.now() - t0)} ms`)
      cancelEdit() // the meshes being dragged are about to be replaced
      if (built) { scene.remove(built.group); built.dispose() }
      built = next
      scene.add(built.group)
      orbit.maxDistance = Math.max(300, built.radius * 3) // the town stays in view
      if (!framed) frame()
      placeSun()
      placeRing()
      if (optsRef.current.underground) built.setUnderground(true, terrain ? [terrain.mesh] : [])
      // ponytail: warm up 20 simulated s offscreen (~60 ms) so streets aren't empty after a rebuild, then one real step to write poses; a direct prefill in drive.ts is the upgrade
      if (built.traffic) {
        for (let i = 0; i < 200; i++) built.traffic.step(0.1, hourRef.current, () => false, false)
        camera.updateMatrixWorld(); frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
        built.traffic.step(0.1, hourRef.current, visible)
      }
    }

    // Initial camera: look at the selection (or the whole scene) from the south-east, 40° down.
    const frame = () => {
      if (!built) return
      framed = true
      const s = useStore.getState()
      const sel = s.selection.map((id) => s.features[id]).filter(Boolean)
      const target = sel.length ? built.toScene(turf.centroid(sel[0]).geometry.coordinates) : new THREE.Vector3(0, built.groundAt(0, 0), 0)
      const d = sel.length ? 120 : built.radius * 1.3
      orbit.target.copy(target)
      camera.position.set(target.x + d * 0.5, target.y + d * 0.65, target.z + d * 0.6)
      orbit.update()
    }

    const setCamera = (mode: CamMode) => {
      if (walk.isLocked) walk.unlock()
      orbit.enabled = mode !== 'walk'
      orbit.enableRotate = mode === 'orbit'
      orbit.mouseButtons.LEFT = mode === 'top' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
      orbit.screenSpacePanning = mode === 'top'
      const t = orbit.target
      if (mode === 'top') {
        camera.position.set(t.x, t.y + (built?.radius ?? 400) * 1.6, t.z + 0.01)
        orbit.update()
      } else if (mode === 'orbit') {
        const d = Math.max(150, camera.position.distanceTo(t))
        camera.position.set(t.x + d * 0.5, t.y + d * 0.65, t.z + d * 0.6)
        orbit.update()
      } else {
        // walk: stand at the orbit target facing the same way the camera was looking
        const dir = new THREE.Vector3().subVectors(t, camera.position).setY(0).normalize()
        camera.position.set(t.x, (built?.groundAt(t.x, t.z) ?? 0) + EYE, t.z)
        camera.lookAt(camera.position.clone().add(dir))
      }
    }

    // walking keys
    const keys = new Set<string>()
    const kd = (e: KeyboardEvent) => { if (walk.isLocked) { keys.add(e.code); e.stopPropagation() } }
    const ku = (e: KeyboardEvent) => keys.delete(e.code)
    window.addEventListener('keydown', kd, true)
    window.addEventListener('keyup', ku)

    const ray = new THREE.Raycaster()
    // --- editing: drag a selected object to move it, drag the ring to rotate (preview; commit once on release) ---
    const ring = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }))
    ring.renderOrder = 999; ring.visible = false
    scene.add(ring)
    const editable = () => {
      const s = useStore.getState(), locked = lockedIds(s)
      return s.selection.map((id) => s.features[id]).filter((f) => f && isMovable(f) && !locked.has(f.properties.layerId))
    }
    const placeRing = () => {
      const fs = optsRef.current.camera === 'walk' || !built ? [] : editable().filter(isRotatable)
      ring.visible = fs.length > 0
      if (!ring.visible || !built) return
      const pts = fs.flatMap((f) => { const [w, s2, e2, n] = turf.bbox(f); return [[w, s2], [e2, n], [w, n], [e2, s2]].map((q) => built!.toScene(q)) })
      const c = pts.reduce((a, q) => a.add(q), new THREE.Vector3()).divideScalar(pts.length)
      const r = Math.max(...pts.map((q) => Math.hypot(q.x - c.x, q.z - c.z))) + 4
      ring.geometry.dispose()
      ring.geometry = new THREE.RingGeometry(r, r + 1.2, 96).rotateX(-Math.PI / 2)
      ring.position.set(c.x, built.groundAt(c.x, c.z) + 0.3, c.z)
    }
    type Edit = { mode: 'move' | 'rotate'; id?: string; x0: number; y0: number; start: THREE.Vector3; ids: string[]; objs: { o: THREE.Object3D; pos: THREE.Vector3; q: THREE.Quaternion; c: THREE.Vector3 }[]; dx: number; dz: number; deg: number; moved: boolean }
    let edit: Edit | null = null
    const cancelEdit = () => {
      if (!edit) return
      for (const { o, pos, q } of edit.objs) { o.position.copy(pos); o.quaternion.copy(q) }
      edit = null; orbit.enabled = optsRef.current.camera !== 'walk'; setStatus('')
    }
    const rayAt = (cx: number, cy: number) => {
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera)
      return ray
    }
    const onEditDown = (e: PointerEvent) => {
      if (e.button !== 0 || optsRef.current.camera === 'walk' || !built) return
      const fs = editable()
      if (!fs.length) return
      const rr = rayAt(e.clientX, e.clientY)
      const onRing = ring.visible && rr.intersectObject(ring, false).length > 0
      const hit = onRing ? undefined : preferPipe(rr.intersectObjects(built.pickables, false))
      const id = hit ? built.pick(hit) : undefined
      if (!onRing && !(id && fs.some((f) => f.properties.id === id))) return // not ours: orbit / select as usual
      const start = groundHit(rr, terrain?.mesh ?? null)
      if (!start) return
      e.stopImmediatePropagation() // keep OrbitControls and the click handler out of it
      const ids = (onRing ? fs.filter(isRotatable) : fs).map((f) => f.properties.id), mine = new Set(ids)
      const centre = new Map(fs.map((f) => [f.properties.id, built!.toScene(turf.centroid(f).geometry.coordinates)]))
      const objs = built.group.children.filter((o) => mine.has(o.userData.owner)).map((o) => ({ o, pos: o.position.clone(), q: o.quaternion.clone(), c: centre.get(o.userData.owner)! }))
      edit = { mode: onRing ? 'rotate' : 'move', id, x0: e.clientX, y0: e.clientY, start, ids, objs, dx: 0, dz: 0, deg: 0, moved: false }
      orbit.enabled = false
      renderer.domElement.setPointerCapture(e.pointerId)
    }
    const onEditMove = (e: PointerEvent) => {
      if (!edit || !built) return
      if (!edit.moved && Math.hypot(e.clientX - edit.x0, e.clientY - edit.y0) <= 4) return
      edit.moved = true
      const p = groundHit(rayAt(e.clientX, e.clientY), terrain?.mesh ?? null)
      if (!p) return
      if (edit.mode === 'move') {
        let dx = p.x - edit.start.x, dz = p.z - edit.start.z
        const s = useStore.getState(), ref = edit.objs[0]?.c
        if (s.snap.grid && ref) { // snap the (first) object's centre to the project grid
          const g = snapToGrid(built.toGeo(ref.x + dx, ref.z + dz), s.meta.gridOrigin ?? s.meta.center, s.snap.gridSize, s.snap.gridAngle), q = built.toScene(g)
          dx = q.x - ref.x; dz = q.z - ref.z
        }
        edit.dx = dx; edit.dz = dz
        for (const { o, pos, c } of edit.objs) o.position.set(pos.x + dx, pos.y + built.groundAt(c.x + dx, c.z + dz) - built.groundAt(c.x, c.z), pos.z + dz)
        ring.visible = false
        setStatus(`Move ${Math.round(Math.hypot(dx, dz))} m`)
      } else {
        edit.deg = ringAngle(ring.position, edit.start, p, e.shiftKey)
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-edit.deg * Math.PI) / 180) // clockwise from above
        for (const { o, pos, q: q0, c } of edit.objs) { o.position.copy(pos).sub(c).applyQuaternion(q).add(c); o.quaternion.copy(q).multiply(q0) }
        setStatus(`Rotate ${Math.round(edit.deg)}°${e.shiftKey ? '' : ' (Shift: free)'}`)
      }
    }
    const onEditUp = (e: PointerEvent) => {
      if (!edit) return
      const ed = edit
      edit = null
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId)
      orbit.enabled = true; setStatus('')
      const st = useStore.getState()
      if (!ed.moved) { // a plain click on a selected object
        if (ed.id) st.select(e.shiftKey ? st.selection.filter((x) => x !== ed.id) : [ed.id])
        return
      }
      // the store change rebuilds the scene; the moved meshes stay where they were dropped until then
      if (ed.mode === 'move') st.moveFeatures(ed.ids, ed.dx, -ed.dz)
      else if (ed.deg) st.rotateFeatures(ed.ids, ed.deg)
      else placeRing()
    }
    renderer.domElement.addEventListener('pointerdown', onEditDown, { capture: true })
    renderer.domElement.addEventListener('pointermove', onEditMove)
    renderer.domElement.addEventListener('pointerup', onEditUp)
    renderer.domElement.addEventListener('pointercancel', onEditUp)

    // click to select (a drag of more than a few pixels is a camera move, not a click)
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      const d = down
      down = null // one press, one click (an edit drag swallows its press)
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !built) return
      if (optsRef.current.camera === 'walk') { if (!walk.isLocked) walk.lock(); return }
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const hit = preferPipe(ray.intersectObjects(built.pickables, false))
      const id = hit ? built.pick(hit) : undefined
      const st = useStore.getState()
      if (e.shiftKey && id) st.select(st.selection.includes(id) ? st.selection.filter((x) => x !== id) : [...st.selection, id])
      else st.select(id ? [id] : [])
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    const fwdV = new THREE.Vector3()
    const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sph = new THREE.Sphere(new THREE.Vector3(), 10)
    const visible = (e: number, n: number) => { sph.center.set(e, built ? built.groundAt(e, -n) : 0, -n); return frustum.intersectsSphere(sph) }
    let lastPush = 0
    const clock = new THREE.Clock()
    let pipeT = 0 // pipe-flow animation time: real seconds while playing
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, clock.getDelta())
      if (walk.isLocked && built) {
        const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 25 : 6) * dt
        const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
        const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
        walk.moveForward(fwd * speed); walk.moveRight(side * speed)
        camera.position.y = built.groundAt(camera.position.x, camera.position.z) + EYE
      } else if (orbit.enabled) {
        orbit.update()
        // panning stops at the scene's edge (the scene is centred on 0,0): move target and camera back together
        const lim = (built?.radius ?? Infinity) * 1.2, h = Math.hypot(orbit.target.x, orbit.target.z)
        if (h > lim) {
          const dx = orbit.target.x * (lim / h - 1), dz = orbit.target.z * (lim / h - 1)
          orbit.target.x += dx; orbit.target.z += dz; camera.position.x += dx; camera.position.z += dz
        }
      }
      if (built) setDetailVisibility(built, camera.position) // one distance per building
      const op = optsRef.current
      if (built && op.playing) {
        built.pipeTime(pipeT += dt)
        const hour = hourRef.current = advanceHour(hourRef.current, dt, op.speed)
        if (Math.abs(hour - sunHour) >= 1 / 60) {
          placeSun()
          const now = performance.now()
          if (now - lastPush >= 250) { lastPush = now; setO((p) => ({ ...p, hour })) } // slider + label only
        }
        if (built.traffic) {
          camera.updateMatrixWorld()
          frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
          built.traffic.step(dt, hour, visible)
        }
      }
      if (compass.current) compass.current.style.transform = `rotate(${-cameraHeading(camera, camera.position.clone().add(camera.getWorldDirection(fwdV)))}deg)`
      renderer.render(scene, camera)
    }
    loop()
    if (import.meta.env.DEV) (globalThis as any).__view = { camera, orbit, renderer, get built() { return built } } // browser testing

    let timer: number | undefined
    const schedule = () => { clearTimeout(timer); timer = window.setTimeout(rebuild, 60) }
    const unsub = useStore.subscribe((s, p) => {
      if (s.meta.id !== p.meta.id) framed = false // another project: frame it afresh
      if (s.features !== p.features || s.layers !== p.layers || s.meta.basemap !== p.meta.basemap || s.meta.settings.buildingStyle !== p.meta.settings.buildingStyle || s.meta.settings.drivingSide !== p.meta.settings.drivingSide) schedule()
      else if (s.selection !== p.selection) { built?.setSelection(new Set(s.selection)); placeRing() } // no rebuild for a click
    })
    api.current = {
      setOpts(next, prev) {
        optsRef.current = next
        if (next.camera !== prev.camera) { setCamera(next.camera); placeRing() }
        if (next.underground !== prev.underground) built?.setUnderground(next.underground, terrain ? [terrain.mesh] : [])
        if (next.hour !== prev.hour || next.playing !== prev.playing || next.day !== prev.day || next.shadows !== prev.shadows) placeSun()
        if (next.terrain !== prev.terrain || next.exaggeration !== prev.exaggeration || next.trees !== prev.trees || next.lights !== prev.lights || next.cars !== prev.cars) schedule()
      },
      // drop a library component onto the ground under the pointer
      drop(cx, cy, type) {
        if (!built) return
        const p = groundHit(rayAt(cx, cy), terrain?.mesh ?? null)
        if (!p) return
        const s = useStore.getState()
        let c = built.toGeo(p.x, p.z) as [number, number]
        if (s.snap.grid) c = snapToGrid(c, s.meta.gridOrigin ?? s.meta.center, s.snap.gridSize, s.snap.gridAngle) as [number, number]
        s.setTool('select')
        s.select([s.addFeature(type, componentGeometry(componentDef(type), c))])
      },
      // turn the camera to face north, keeping its distance and height
      faceNorth() {
        if (walk.isLocked || optsRef.current.camera === 'walk') { camera.lookAt(camera.position.clone().add(new THREE.Vector3(0, 0, -1))); return }
        const t = orbit.target, d = Math.max(0.01, Math.hypot(camera.position.x - t.x, camera.position.z - t.z))
        camera.position.set(t.x, camera.position.y, t.z + d)
        orbit.update()
      },
    }
    rebuild()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      unsub(); ro.disconnect()
      ring.geometry.dispose(); (ring.material as THREE.Material).dispose()
      window.removeEventListener('keydown', kd, true)
      window.removeEventListener('keyup', ku)
      walk.dispose(); orbit.dispose()
      if (built) { built.setNight(0, 12); built.dispose() } // daylight again for the map layer and thumbnails
      if (terrain) { terrain.mesh.geometry.dispose(); (terrain.mesh.material as THREE.Material).dispose() }
      env?.ground?.texture.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  const update = (patch: Partial<Opts>) => setO((prev) => { if (patch.hour !== undefined) hourRef.current = patch.hour; const next = { ...prev, hour: hourRef.current, ...patch }; api.current?.setOpts(next, prev); return next })
  const label = clockLabel(o.hour)

  return (
    <div className="absolute inset-0 z-10 bg-[#b9d3ec]">
      <div ref={host} className="h-full w-full" onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const t = e.dataTransfer.getData('application/x-urbanforge'); if (t) api.current?.drop(e.clientX, e.clientY, t) }} />
      <button ref={compass} onClick={() => api.current?.faceNorth()} title="Compass — click to face north" aria-label="Compass — click to face north"
        className="absolute right-3 top-3 h-16 w-16 rounded-full border border-line bg-panel/90 text-ink shadow-xl">
        <svg viewBox="-32 -32 64 64" className="h-full w-full" aria-hidden>
          <polygon points="0,-20 5,0 -5,0" fill="#e53935" /><polygon points="0,20 5,0 -5,0" fill="#9aa4ae" />
          <text x="0" y="-21" textAnchor="middle" fontSize="10" fontWeight="700" fill="#e53935">N</text>
          <text x="26" y="4" textAnchor="middle" fontSize="9" fill="currentColor">E</text>
          <text x="0" y="29" textAnchor="middle" fontSize="9" fill="currentColor">S</text>
          <text x="-26" y="4" textAnchor="middle" fontSize="9" fill="currentColor">W</text>
        </svg>
      </button>
      <div className="absolute left-2 top-2 w-60 space-y-2 rounded border border-line bg-panel/95 p-2 text-[11px] shadow-xl">
        <div className="flex gap-1">
          {([['orbit', 'Orbit'], ['top', 'Top-down'], ['walk', 'Walk']] as const).map(([m, label]) => (
            <button key={m} className={`btn flex-1 justify-center border border-line ${o.camera === m ? 'btn-on' : ''}`} onClick={() => update({ camera: m })}>{label}</button>
          ))}
        </div>
        <label className="grid grid-cols-[70px_1fr_44px] items-center gap-1">
          <span className="text-muted">Sun (solar)</span>
          <input type="range" min={0} max={24} step={0.25} value={o.hour} onChange={(e) => update({ hour: +e.target.value })} className="w-full min-w-0 accent-[#00b8d4]" />
          <span className="font-mono">{label}</span>
        </label>
        <div className="grid grid-cols-[70px_1fr] items-center gap-1">
          <span className="text-muted">Time</span>
          <div className="flex gap-1">
            <button className="btn justify-center border border-line" aria-label={o.playing ? 'Pause time' : 'Play time'} title={o.playing ? 'Pause' : 'Play'} onClick={() => update({ playing: !o.playing })}>
              {o.playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <select className="input min-w-0 flex-1" aria-label="Time speed" value={o.speed} onChange={(e) => update({ speed: +e.target.value as Opts['speed'] })}>
              {[1, 60, 600, 3600].map((v) => <option key={v} value={v}>×{v}</option>)}
            </select>
          </div>
        </div>
        <label className="grid grid-cols-[70px_1fr] items-center gap-1">
          <span className="text-muted">Season</span>
          <select className="input" value={o.day} onChange={(e) => update({ day: +e.target.value })}>
            {Object.entries(SEASONS).map(([k, d]) => <option key={k} value={d}>{k}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          <label className="flex items-center gap-1"><input type="checkbox" checked={o.terrain} onChange={(e) => update({ terrain: e.target.checked })} /> Terrain</label>
          <label className="flex items-center gap-1">
            <select className="input !py-0" value={o.exaggeration} disabled={!o.terrain} onChange={(e) => update({ exaggeration: +e.target.value })} title="Vertical exaggeration">
              {[1, 2, 3, 5].map((v) => <option key={v} value={v}>{v}× height</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={o.shadows} onChange={(e) => update({ shadows: e.target.checked })} /> Shadows</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={o.trees} onChange={(e) => update({ trees: e.target.checked })} /> Trees</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={o.lights} onChange={(e) => update({ lights: e.target.checked })} /> Street lights</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={o.cars} onChange={(e) => update({ cars: e.target.checked })} /> Cars</label>
          <label className="flex items-center gap-1" title="See through the ground: water and sewer pipes at depth, with their flow"><input type="checkbox" checked={o.underground} onChange={(e) => update({ underground: e.target.checked })} /> Underground</label>
        </div>
        <button className="btn w-full justify-center border border-line" onClick={() => useStore.getState().setView3d(false)}>Back to 2D map</button>
        <p className="text-[10px] text-muted">
          {o.camera === 'walk' ? (locked ? 'WASD / arrows to walk, Shift to run, mouse to look, Esc to release.' : 'Click the view to start walking.')
            : o.camera === 'top' ? 'Drag to pan, scroll to zoom. Click to select.' : 'Drag to orbit, right-drag to pan, scroll to zoom. Click to select; Shift+click adds. Drag a selected object to move it; drag the blue ring to rotate (Shift: free). Drop components from the library onto the ground.'}
        </p>
        {status && <p className="text-[10px] text-warn">{status}</p>}
      </div>
      <div className="pointer-events-none absolute bottom-1 right-2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white">
        © OpenStreetMap contributors · {TERRAIN_ATTRIBUTION}
      </div>
    </div>
  )
}
