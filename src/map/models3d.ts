import * as THREE from 'three'
import * as turf from '@turf/turf'
import type { Position } from 'geojson'
import { MercatorCoordinate, type CustomLayerInterface, type Map as MlMap } from 'maplibre-gl'
import { useStore } from '../store'
import { frameToMercator } from '../geo'
import { buildScene, nearCentre, sceneBounds, SCENE_REACH, setDetailVisibility, type BuiltScene } from '../three/scene'

export const MODELS_MIN_ZOOM = 16
/** Building details (balconies, signs, rooftop clutter) only from this zoom. */
export const DETAILS_MIN_ZOOM = 17
const ANY = new THREE.Vector3()

/**
 * Three.js layer drawing the procedural 3D models (buildings, street furniture, area details,
 * trees) over the 2D plan at high zoom; tilt the map (Ctrl/right-drag) to see them in 3D.
 * Flat features stay MapLibre layers, so selection/snapping keep working on the 2D shapes.
 * ponytail: flat ground and one mercator scale at the scene origin — fine at street scale;
 * picking still hits the footprint underneath, not the model's tilted silhouette.
 */
export function modelsLayer(): CustomLayerInterface {
  let map: MlMap, renderer: THREE.WebGLRenderer
  const scene = new THREE.Scene(), camera = new THREE.Camera()
  const sun = new THREE.DirectionalLight(0xffffff, 1.8)
  sun.position.set(0.5, 1, 0.7)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 1.3), sun)
  let built: BuiltScene | null = null, xform = new THREE.Matrix4(), timer = 0, unsub = () => {}
  // the overlay is only drawn at zoom ≥ MODELS_MIN_ZOOM with the 3D view closed: rebuild only then (an edit made
  // zoomed out or in the 3D view marks it stale; the first visible frame rebuilds it)
  let stale = false
  let builtAt: Position = [0, 0] // map centre of the last build: moving far from it (another site) rebuilds
  const shown = () => map.getZoom() >= MODELS_MIN_ZOOM && !useStore.getState().view3d
  const schedule = (ms: number) => { clearTimeout(timer); if (shown()) { stale = false; timer = window.setTimeout(rebuild, ms) } else stale = true }

  const rebuild = () => {
    const s = useStore.getState()
    const features = nearCentre(Object.values(s.features), s.meta.center)
    builtAt = s.meta.center
    const { origin, bounds } = sceneBounds(features, s.meta.center)
    if (built) { scene.remove(built.group); built.dispose() }
    built = buildScene(features, s.layers, origin, bounds, { exaggeration: 1, selection: new Set(s.selection), trees: true, streetLights: false, modelsOnly: true, settings: s.meta.settings })
    scene.add(built.group)
    // scene metres (x east, y up, z south) → mercator (x east, y south, z up)
    // ground plane through the frame's own degree scales (geo.ts frameToMercator); heights in MapLibre's metres
    const m = frameToMercator(origin), k = MercatorCoordinate.fromLngLat(origin as [number, number], 0).meterInMercatorCoordinateUnits()
    xform = new THREE.Matrix4().makeTranslation(m.x0, m.y0, 0).scale(new THREE.Vector3(m.sx, -m.sy, k)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    map.triggerRepaint()
  }

  return {
    id: 'models-3d', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      map = m
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true })
      renderer.autoClear = false
      schedule(0)
      unsub = useStore.subscribe((s, p) => {
        if (s.features !== p.features || s.layers !== p.layers || s.meta.settings.buildingStyle !== p.meta.settings.buildingStyle || s.meta.settings.drivingSide !== p.meta.settings.drivingSide
          || (s.meta.center !== p.meta.center && turf.distance(s.meta.center, builtAt, { units: 'meters' }) > SCENE_REACH / 4)) schedule(150)
        else if (s.view3d !== p.view3d) map.triggerRepaint() // repaint after CityView's night reset, not a stale night frame
        else if (s.selection !== p.selection && built) { built.setSelection(new Set(s.selection)); map.triggerRepaint() }
      })
    },
    render(_gl, args) {
      if (stale && shown()) schedule(0)
      if (!built || map.getZoom() < MODELS_MIN_ZOOM) return
      setDetailVisibility(built, map.getZoom() >= DETAILS_MIN_ZOOM ? ANY : null, Infinity)
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(xform)
      renderer.resetState()
      renderer.render(scene, camera)
    },
    onRemove() {
      unsub(); clearTimeout(timer)
      built?.dispose()
      renderer.dispose()
    },
  }
}
