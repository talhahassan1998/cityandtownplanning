import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import * as turf from '@turf/turf'
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 locates its worker relative to its own module URL, which breaks once Vite
// pre-bundles/hashes it; bundle the worker explicitly instead.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { TerraDraw, TerraDrawLineStringMode, TerraDrawPointMode, TerraDrawPolygonMode, TerraDrawSelectMode, type GeoJSONStoreFeatures, type SnapToCustom } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson'
import { googleCopyright, googleKey, googleSession, googleTileUrl } from './google'
import { BASEMAPS, colorOf, componentDef, GENERIC_RULESET, type PlanFeature, type PlanGeometry } from '../model'
import { designLine, lockedIds, useStore, type State, type Tool } from '../store'
import { gridLines, knobPoint, measure, ringAngle, roadSurface, rotate, roundGeometry, snapScreen, snapToGrid } from '../geo'
import { componentGeometry, measureFrontage } from '../roads'
import { complianceOf, isBuilding, type Compliance } from '../zoning'
import { networksOf } from '../networks'
import { fmtArea, fmtLen } from '../ui/format'

/** Shared map handle for export / fly-to. ponytail: module singleton, one map per app. */
export let mapInstance: maplibregl.Map | null = null

maplibregl.setWorkerUrl(workerUrl)

const RASTER = (tiles: string[], attribution: string) => ({ type: 'raster' as const, tiles, tileSize: 256, attribution, maxzoom: 19 })

const LABEL: maplibregl.SymbolLayerSpecification['layout'] = { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'symbol-placement': 'point', 'text-allow-overlap': false }
const LABEL_PAINT = { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.4 }

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: RASTER(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
    plan: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    surfaces: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    heat: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    preview: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    grid: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    knob: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#e9ebee' } },
    { id: 'base-osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
    { id: 'base-grey', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.9, 'raster-contrast': -0.15, 'raster-brightness-min': 0.15 } },
    { id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#00b8d4', 'line-opacity': 0.25, 'line-width': 0.6 } },
    { id: 'plan-fill', type: 'fill', source: 'plan', filter: ['==', ['geometry-type'], 'Polygon'],
      layout: { 'fill-sort-key': ['get', 'z'] }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fop'] } },
    { id: 'surface-fill', type: 'fill', source: 'surfaces', layout: { 'fill-sort-key': ['get', 'z'] },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] } },
    { id: 'gfa-heat', type: 'heatmap', source: 'heat', maxzoom: 19, layout: { visibility: 'none' },
      paint: {
        'heatmap-weight': ['get', 'w'],
        'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 8, 16, 40, 19, 160],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 17, 1.4],
        'heatmap-opacity': 0.75,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, '#2c7bb6', 0.45, '#abd9e9', 0.65, '#ffffbf', 0.85, '#fdae61', 1, '#d7191c'],
      } },
    { id: 'plan-outline', type: 'line', source: 'plan', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'line-color': ['case', ['get', 'sel'], '#00e5ff', ['get', 'invalid'], '#ff2d2d', ['get', 'stroke']],
        'line-width': ['case', ['get', 'sel'], 3, ['get', 'invalid'], 2.5, ['get', 'sw']],
        'line-dasharray': ['case', ['==', ['get', 'type'], 'boundary'], ['literal', [4, 2]], ['literal', [1, 0]]],
        'line-opacity': ['get', 'op'],
      } },
    { id: 'plan-line', type: 'line', source: 'plan', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['case', ['get', 'sel'], '#00e5ff', ['get', 'stroke']], 'line-width': ['case', ['get', 'sel'], 3, ['get', 'sw']], 'line-opacity': ['get', 'op'],
        'line-dasharray': ['case', ['==', ['get', 'type'], 'measure'], ['literal', [2, 1]], ['literal', [1, 0]]] } },
    { id: 'plan-line-hit', type: 'line', source: 'plan', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-width': 14, 'line-opacity': 0 } },
    { id: 'plan-point', type: 'circle', source: 'plan', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'tag']]],
      paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': ['case', ['get', 'sel'], '#00e5ff', '#ffffff'], 'circle-stroke-width': 2, 'circle-opacity': ['get', 'op'] } },
    { id: 'preview-fill', type: 'fill', source: 'preview', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45 } },
    { id: 'preview-line', type: 'line', source: 'preview', paint: { 'line-color': ['case', ['==', ['geometry-type'], 'LineString'], '#30343a', '#1c2026'], 'line-width': ['case', ['==', ['geometry-type'], 'LineString'], 3, 0.6], 'line-dasharray': [3, 2] } },
    { id: 'plan-label', type: 'symbol', source: 'plan', minzoom: 15.5, filter: ['all', ['has', 'label'], ['!', ['get', 'model']]], layout: LABEL, paint: LABEL_PAINT },
    { id: 'plan-tag', type: 'symbol', source: 'plan', minzoom: 12, filter: ['has', 'tag'], layout: { ...LABEL, 'text-field': ['get', 'tag'], 'text-size': 12 }, paint: { ...LABEL_PAINT, 'text-color': '#c4500a' } },
    // names of modelled things give way to their 3D models from MODELS_MIN_ZOOM (see models3d.ts)
    { id: 'plan-label-model', type: 'symbol', source: 'plan', minzoom: 15.5, maxzoom: 16, filter: ['all', ['has', 'label'], ['get', 'model']], layout: LABEL, paint: LABEL_PAINT },
    // rotate knob above the selected shape (drag it to rotate)
    { id: 'rotate-knob', type: 'circle', source: 'knob', paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#00a3b8', 'circle-stroke-width': 2.5 } },
  ],
}

const HIT_LAYERS = ['plan-fill', 'plan-outline', 'plan-line-hit', 'plan-point', 'surface-fill']

const DRAW_MODE: Partial<Record<Tool, string>> = {
  boundary: 'polygon', zone: 'polygon', plot: 'polygon', 'measure-area': 'polygon',
  road: 'linestring', utility: 'linestring', measure: 'linestring', point: 'point', cut: 'linestring',
}
const TOOL_TYPE: Partial<Record<Tool, string>> = {
  boundary: 'boundary', zone: 'zone', plot: 'plot', road: 'road', utility: 'utility-line', point: 'node', measure: 'measure', 'measure-area': 'measure',
}
const tdMode = (g: PlanGeometry) => (g.type === 'Polygon' ? 'polygon' : g.type === 'LineString' ? 'linestring' : 'point')

// Derived road/pipe surfaces, cached per feature object (store is immutable so identity = version).
const surfaceCache = new WeakMap<PlanFeature, Feature | null>()
function surfaceOf(f: PlanFeature): Feature | null {
  if (!surfaceCache.has(f)) {
    const w = Number(f.properties.attrs.width)
    surfaceCache.set(f, f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads' && w > 0 ? roadSurface(f as Feature<LineString>, w) ?? null : null)
  }
  return surfaceCache.get(f)!
}

// Ratio-to-limit ramp for thematic maps: comfortably within, near, at, over the limit.
const ramp = (ratio: number) => (ratio > 1.0001 ? '#e53935' : ratio > 0.9 ? '#fb8c00' : ratio > 0.5 ? '#fdd835' : '#43a047')

function themeColor(f: PlanFeature, s: State, comp: Compliance): string | undefined {
  if (s.mapTheme === 'zoning') return undefined
  if (s.mapTheme === 'compliance') return f.properties.type === 'plot' || isBuilding(f) ? (comp.byId.has(f.id) ? '#e53935' : '#43a047') : undefined
  if (f.properties.type !== 'plot') return undefined
  const m = comp.plots.get(f.id)
  if (!m?.buildings.length) return '#cfd8dc' // vacant plot
  const rule = m.zone ? (s.meta.ruleset ?? GENERIC_RULESET).rules[m.zone] : undefined
  const limit = s.mapTheme === 'far' ? rule?.maxFAR : rule?.maxCoverage
  if (!limit) return '#90a4ae' // uncontrolled
  return ramp((s.mapTheme === 'far' ? m.far : m.coverage) / limit)
}


function buildData(s: State, editingId: string | null): [FeatureCollection, FeatureCollection, FeatureCollection] {
  const comp = complianceOf(s.features, s.meta.ruleset, s.meta.settings)
  const nets = networksOf(s.features)
  const heat: Feature[] = []
  const order = new Map(s.layers.map((l, i) => [l.id, l]))
  const z = new Map(s.layers.map((l, i) => [l.id, i]))
  const sel = new Set(s.selection)
  const plan: Feature[] = [], surf: Feature[] = []
  for (const f of Object.values(s.features)) {
    const layer = order.get(f.properties.layerId)
    // the feature being edited is drawn by Terra Draw — except roads: it shows their bend points, so keep the (curved) road under them
    if (!layer?.visible || (f.id === editingId && !(f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads'))) continue
    const { type, attrs, name } = f.properties
    const def = componentDef(type)
    const op = layer.opacity
    const color = themeColor(f, s, comp) ?? colorOf(f)
    // red outline: failing plot rules (attrs.issue) or any development-control violation
    const base = { id: f.id, type, color, op, z: z.get(layer.id)!, sel: sel.has(f.id), invalid: !!attrs.issue || comp.byId.has(f.id) || nets.byId.has(f.id) }
    if (s.heatmap && isBuilding(f)) heat.push({ type: 'Feature', geometry: { type: 'Point', coordinates: turf.centroid(f).geometry.coordinates }, properties: { w: measure(f).area * (Number(attrs.floors) || 0) } })
    let label: string | undefined
    if (type === 'plot') label = String(attrs.plotNo ?? '')
    else if (type === 'measure') { const m = measure(f); label = m.area ? fmtArea(m.area) : fmtLen(m.length) }
    else if (def.layer === 'buildings' || def.layer === 'facilities' || def.layer === 'green') label = name
    const fillOp = type === 'boundary' ? 0.04 : type === 'zone' ? 0.25 : type === 'roundabout' || type === 'cul-de-sac' ? 0.95 : def.layer === 'roads' ? 0.6 : 0.55
    plan.push({
      type: 'Feature', id: f.id, geometry: f.geometry,
      properties: {
        ...base, fop: fillOp * op, ...(label ? { label, model: def.layer !== 'green' } : {}),
        stroke: type === 'boundary' ? '#ff7a1a' : f.geometry.type === 'LineString' ? (def.layer === 'roads' ? '#ffffff' : color) : darken(color),
        sw: type === 'boundary' ? 2.5 : f.geometry.type === 'LineString' ? (def.layer === 'roads' ? 1 : 2.5) : 1,
      },
    })
    // one area tag per boundary (a polygon label would repeat on every tile it spans)
    if (type === 'boundary') plan.push({ type: 'Feature', geometry: turf.pointOnFeature(f).geometry, properties: { tag: `${name ? name + ' · ' : ''}${fmtArea(measure(f).area)}` } })
    const sf = surfaceOf(f)
    if (sf) surf.push({ ...sf, properties: { id: f.id, color: sel.has(f.id) ? '#4c6f80' : type === 'rail' ? '#6b5b4d' : color, op: 0.95 * op, z: base.z } })
  }
  // normalise heat weights to 0–1 so the colour ramp means the same thing at any project size
  const maxW = Math.max(1, ...heat.map((h) => h.properties!.w as number))
  for (const h of heat) h.properties!.w = (h.properties!.w as number) / maxW
  return [{ type: 'FeatureCollection', features: plan }, { type: 'FeatureCollection', features: surf }, { type: 'FeatureCollection', features: heat }]
}

function darken(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.round(v * 0.65).toString(16).padStart(2, '0')
  return `#${c(n >> 16)}${c((n >> 8) & 255)}${c(n & 255)}`
}

export default function MapCanvas() {
  const el = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; at: [number, number] } | null>(null)
  const [credit, setCredit] = useState('') // Google's required on-screen attribution

  useEffect(() => {
    const s0 = useStore.getState()
    const map = new maplibregl.Map({ container: el.current!, style: STYLE, center: s0.meta.center, zoom: s0.meta.zoom, attributionControl: { compact: true },
      boxZoom: false, // shift is the multi-select modifier; box zoom would swallow shift+click
    })
    mapInstance = map
    if (import.meta.env.DEV) (globalThis as any).__map = map // debugging / browser automation
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 140 }), 'bottom-right')

    let draw: TerraDraw | null = null
    let editingId: string | null = null
    let editingObj: PlanFeature | null = null

    let ready = false // isStyleLoaded() is false while any tile is loading, so track load ourselves
    const render = () => {
      if (!ready) return
      const s = useStore.getState()
      const [plan, surf, heat] = buildData(s, editingId)
      ;(map.getSource('plan') as GeoJSONSource).setData(plan)
      ;(map.getSource('surfaces') as GeoJSONSource).setData(surf)
      ;(map.getSource('heat') as GeoJSONSource).setData(heat)
      map.setLayoutProperty('gfa-heat', 'visibility', s.heatmap ? 'visible' : 'none')
    }

    // Snap the pointer to vertices / edges of nearby plan features (screen-space tolerance),
    // falling back to the metric grid. Hidden layers aren't rendered, so they're never snap targets.
    const SNAP_TOL = 12
    const snapTo: SnapToCustom = (e) => {
      const s = useStore.getState()
      const { vertices, edges, grid, gridSize } = s.snap
      if (vertices || edges) {
        const box: [[number, number], [number, number]] = [[e.containerX - SNAP_TOL, e.containerY - SNAP_TOL], [e.containerX + SNAP_TOL, e.containerY + SNAP_TOL]]
        const ids = new Set(map.queryRenderedFeatures(box, { layers: HIT_LAYERS.filter((l) => map.getLayer(l)) }).map((h) => h.properties.id as string))
        const geo: number[][][] = []
        for (const id of ids) {
          const f = s.features[id]
          if (!f || id === editingId) continue
          const g = f.geometry
          geo.push(...(g.type === 'Polygon' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [[g.coordinates]]))
        }
        const screen = geo.map((r) => r.map((c): [number, number] => { const p = map.project(c as [number, number]); return [p.x, p.y] }))
        const hit = snapScreen([e.containerX, e.containerY], screen, SNAP_TOL, { vertices, edges })
        // Return stored coordinates exactly, so snapped plots share edges bit-for-bit (needed to merge).
        if (hit?.kind === 'vertex') return [...geo[hit.path][hit.index]]
        if (hit) {
          const a = geo[hit.path][hit.index - 1], b = geo[hit.path][hit.index]
          return [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t]
        }
      }
      if (grid) return snapToGrid([e.lng, e.lat], s.meta.gridOrigin ?? s.meta.center, gridSize, s.snap.gridAngle)
      return undefined
    }

    const renderGrid = () => {
      if (!ready) return
      const s = useStore.getState()
      const b = map.getBounds()
      const lines = s.snap.grid ? gridLines([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], s.meta.gridOrigin ?? s.meta.center, s.snap.gridSize, s.snap.gridAngle) : []
      ;(map.getSource('grid') as GeoJSONSource).setData({ type: 'FeatureCollection', features: lines.map((geometry) => ({ type: 'Feature', geometry, properties: {} })) })
    }

    // what Terra Draw edits: a road's design line (its bend points; the curve is derived), anything else its geometry
    const isRoad = (f: PlanFeature) => f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads'
    const editGeom = (f: PlanFeature): PlanGeometry => roundGeometry(isRoad(f) ? { type: 'LineString', coordinates: designLine(f) } : f.geometry)
    const stopEditing = (commit: boolean) => {
      if (!draw || !editingId) return
      const snap = draw.getSnapshotFeature(editingId)
      const id = editingId
      editingId = null; editingObj = null
      try { draw.deselectFeature(id) } catch { /* already deselected */ }
      if (draw.hasFeature(id)) draw.removeFeatures([id])
      const cur = useStore.getState().features[id]
      if (commit && snap && cur && JSON.stringify(snap.geometry) !== JSON.stringify(editGeom(cur))) // rounding alone is no edit
        if (isRoad(cur)) useStore.getState().setRoadLine(id, (snap.geometry as LineString).coordinates)
        else useStore.getState().updateFeature(id, { geometry: snap.geometry as PlanGeometry })
    }

    // Keep Terra Draw holding exactly the one feature being edited, mirroring store selection.
    const syncEditing = () => {
      if (!draw) return
      const s = useStore.getState()
      const id = s.tool === 'select' && s.selection.length === 1 ? s.selection[0] : null
      const f = id ? s.features[id] : undefined
      const layer = f && s.layers.find((l) => l.id === f.properties.layerId)
      const target = f && layer?.visible && !lockedIds(s).has(layer.id) ? f : null
      if (editingObj && target === editingObj) return
      stopEditing(editingId !== null && editingId !== target?.id)
      if (!target) return
      if (draw.getMode() !== 'select') draw.setMode('select')
      // Terra Draw refuses > 9 decimals (rotation / turf maths gives ~15): round, or the feature can't be edited
      const td = { type: 'Feature', id: target.id, geometry: editGeom(target), properties: { mode: tdMode(target.geometry) } } as GeoJSONStoreFeatures
      const [res] = draw.addFeatures([td])
      if (!res?.valid) { console.warn('[map] not editable:', target.id, res?.reason); return } // stays selectable, not vertex-editable
      editingId = target.id; editingObj = target
      draw.selectFeature(target.id)
    }

    const applyTool = () => {
      if (!draw) return
      const { tool } = useStore.getState()
      stopEditing(true)
      draw.setMode(DRAW_MODE[tool] ?? (tool === 'select' ? 'select' : 'static'))
      map.getCanvas().style.cursor = DRAW_MODE[tool] ? 'crosshair' : ''
      syncEditing()
    }

    // 'load' waits for every basemap tile; the editor only needs the style.
    map.once('style.load', () => {
      ready = true
      setBasemap()
      const snappable = { toCustom: snapTo }
      const editable = { feature: { draggable: true, coordinates: { draggable: true, midpoints: true, deletable: true, resizable: 'center' as const, snappable } } }
      draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawSelectMode({
            flags: { polygon: editable, linestring: { feature: { draggable: true, coordinates: { draggable: true, midpoints: true, deletable: true, snappable } } }, point: { feature: { draggable: true } } },
            keyEvents: { deselect: null, delete: null, rotate: null, scale: null },
            allowManualSelection: false,
            styles: { selectedPolygonColor: '#00e5ff', selectedPolygonFillOpacity: 0.25, selectedPolygonOutlineColor: '#00e5ff', selectedLineStringColor: '#00e5ff', selectionPointColor: '#ffffff', selectionPointOutlineColor: '#00a3b8', midPointColor: '#00e5ff', selectedPointColor: '#00e5ff' },
          }),
          new TerraDrawPolygonMode({ snapping: { toCustom: snapTo, toCoordinate: true }, styles: { fillColor: '#ff7a1a', fillOpacity: 0.15, outlineColor: '#ff7a1a', closingPointColor: '#ffffff' } }),
          new TerraDrawLineStringMode({ snapping: { toCustom: snapTo, toCoordinate: true }, styles: { lineStringColor: '#ff7a1a', lineStringWidth: 3 } }),
          new TerraDrawPointMode({ snapping: { toCustom: snapTo }, styles: { pointColor: '#ff7a1a' } }),
        ],
      })
      draw.start()
      if (import.meta.env.DEV) (globalThis as any).__draw = draw // debugging / browser automation
      draw.on('finish', (id, ctx) => {
        const s = useStore.getState()
        if (ctx.mode === 'select') {
          if (id !== editingId) return
          const snap = draw!.getSnapshotFeature(id)
          if (!snap) return
          const cur = s.features[id as string]
          if (cur && isRoad(cur)) {
            const was = (editGeom(cur) as LineString).coordinates, now = (snap.geometry as LineString).coordinates
            const moved = ctx.action === 'dragCoordinate' && was.length === now.length ? was.findIndex((p, i) => p[0] !== now[i][0] || p[1] !== now[i][1]) : -1
            if (moved >= 0 && was.every((p, i) => i === moved || (p[0] === now[i][0] && p[1] === now[i][1]))) s.moveRoadPoint(cur.id, was[moved], now[moved], moved)
            else s.setRoadLine(cur.id, now)
            editingObj = useStore.getState().features[id as string]
            // the store may have moved more than Terra Draw did (a loop's twin end): show what was stored
            const shown = editGeom(editingObj)
            if (JSON.stringify(shown) !== JSON.stringify(snap.geometry)) draw!.updateFeatureGeometry(id, shown as GeoJSONStoreFeatures['geometry'])
            return
          }
          // Reshaping (not just moving) a parametric footprint makes it free-form.
          const reshaped = ctx.action !== 'dragFeature' && 'rotation' in (s.features[id as string]?.properties.attrs ?? {})
          s.updateFeature(id as string, { geometry: snap.geometry as PlanGeometry, ...(reshaped && { attrs: { shape: 'custom' } }) })
          editingObj = useStore.getState().features[id as string]
          return
        }
        const snap = draw!.getSnapshotFeature(id)
        draw!.removeFeatures([id])
        if (snap && s.tool === 'cut') return s.cutPlots(snap.geometry as LineString)
        const type = TOOL_TYPE[s.tool]
        if (!snap || !type) return
        // Hand-drawn plots get their frontage measured from the roads they touch, so they validate.
        const roads = type === 'plot' ? Object.values(s.features).filter((f) => componentDef(f.properties.type).layer === 'roads') : []
        s.addFeature(type, snap.geometry as PlanGeometry, type === 'plot' ? { frontage: measureFrontage(snap.geometry as Polygon, roads) } : undefined)
      })
      applyTool()
      render()
      renderGrid()
      addModels()
    })

    // 3D models layer (Three.js, lazy-loaded the first time the map reaches street zoom)
    let models: 'none' | 'loading' | 'added' = 'none'
    const addModels = () => {
      if (models !== 'none' || map.getZoom() < 15.5) return
      models = 'loading'
      import('./models3d').then(({ modelsLayer }) => { map.addLayer(modelsLayer(), 'plan-label'); models = 'added' }).catch(() => { models = 'none' })
    }
    map.on('zoomend', addModels)

    const unsub = useStore.subscribe((s, prev) => {
      if (s.tool !== prev.tool) applyTool()
      else if (s.selection !== prev.selection || s.features !== prev.features || s.layers !== prev.layers) syncEditing()
      if (s.tool !== prev.tool || s.selection !== prev.selection || s.features !== prev.features || s.layers !== prev.layers) placeKnob()
      if (s.features !== prev.features || s.layers !== prev.layers || s.selection !== prev.selection
        || s.mapTheme !== prev.mapTheme || s.heatmap !== prev.heatmap || s.meta.ruleset !== prev.meta.ruleset || s.meta.settings !== prev.meta.settings) render()
      if (s.meta.basemap !== prev.meta.basemap) setBasemap()
      if (s.meta.id !== prev.meta.id) map.jumpTo({ center: s.meta.center, zoom: s.meta.zoom })
      if (s.snap !== prev.snap || s.meta.gridOrigin !== prev.meta.gridOrigin) renderGrid()
      if (s.preview !== prev.preview && ready) (map.getSource('preview') as GeoJSONSource).setData(s.preview ?? { type: 'FeatureCollection', features: [] })
    })

    let google: { key: string; session: string } | null = null
    const updateCredit = () => {
      if (!google) return setCredit('')
      const b = map.getBounds()
      googleCopyright(google.key, google.session, map.getZoom(), [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).then((c) => google && setCredit(c)).catch(() => setCredit('Google'))
    }
    function setBasemap() {
      if (!ready) return
      const raw = useStore.getState().meta.basemap
      const b = BASEMAPS.some((x) => x.id === raw) ? raw : 'grey'
      for (const id of ['osm', 'grey']) map.setLayoutProperty(`base-${id}`, 'visibility', id === b ? 'visible' : 'none')
      map.setPaintProperty('bg', 'background-color', b === 'none' ? '#f4f1ea' : '#e9ebee')
      if (map.getLayer('base-google')) map.removeLayer('base-google')
      if (map.getSource('google')) map.removeSource('google')
      google = null; setCredit('')
      if (!b.startsWith('google-')) return
      const key = googleKey(), back = (msg: string) => { useStore.getState().notify(msg); useStore.getState().setMeta({ basemap: 'grey' }) }
      if (!key) return back('Google basemaps need your own Google Maps API key: paste it in Analytics → Google Maps API key, then choose the basemap again.')
      googleSession(key, b === 'google-satellite' ? 'satellite' : 'roadmap').then((session) => {
        if (useStore.getState().meta.basemap !== b || map.getSource('google')) return // switched away meanwhile
        map.addSource('google', { type: 'raster', tiles: [googleTileUrl(key, session)], tileSize: 256, maxzoom: 22 })
        map.addLayer({ id: 'base-google', type: 'raster', source: 'google' }, 'base-osm')
        google = { key, session }
        updateCredit()
      }).catch((e: Error) => back(`Google basemap unavailable: ${e.message} (check the key, that "Map Tiles API" is enabled and allowed in the key's API restrictions, and billing is on in Google Cloud).`))
    }

    map.on('mousemove', (e) => setCursor([e.lngLat.lng, e.lngLat.lat]))
    map.on('moveend', () => {
      renderGrid()
      updateCredit()
      const c = map.getCenter()
      useStore.setState((s) => ({ meta: { ...s.meta, center: [+c.lng.toFixed(6), +c.lat.toFixed(6)], zoom: +map.getZoom().toFixed(2) } }))
    })

    const pick = (e: MapMouseEvent) => {
      const s = useStore.getState()
      const locked = lockedIds(s)
      const hits = map.queryRenderedFeatures(e.point, { layers: HIT_LAYERS.filter((l) => map.getLayer(l)) })
      // Prefer points, then lines, then polygons on the highest layer, then the smallest polygon,
      // so a house wins over the parcel and boundary beneath it.
      const z = new Map(s.layers.map((l, i) => [l.id, i]))
      const rank = (f: PlanFeature) => [{ Point: 0, LineString: 1, Polygon: 2 }[f.geometry.type], -(z.get(f.properties.layerId) ?? 0), measure(f).area]
      const cands = [...new Set(hits.map((h) => h.properties.id as string))]
        .map((id) => s.features[id]).filter((f) => f && !locked.has(f.properties.layerId))
        .map((f) => ({ f, r: rank(f) }))
        .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2])
      return cands[0]?.f.id ?? null
    }

    // Rotate knob: drag it to turn the selected shape about its centre (15° steps; Shift: free), one undo step.
    let turning: { f: PlanFeature; c: { x: number; z: number }; from: { x: number; z: number }; deg: number } | null = null
    let swallowClick = false
    const knobTarget = () => {
      const s = useStore.getState()
      if (s.tool !== 'select' || s.selection.length !== 1) return null
      const f = s.features[s.selection[0]], layer = f && s.layers.find((l) => l.id === f.properties.layerId)
      return f && f.geometry.type !== 'Point' && layer?.visible && !lockedIds(s).has(layer.id) ? f : null
    }
    const placeKnob = () => {
      if (!ready) return
      const f = turning ? null : knobTarget()
      const src = map.getSource('knob') as GeoJSONSource
      if (!f) return src.setData({ type: 'FeatureCollection', features: [] })
      const coords = (f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : (f.geometry as LineString).coordinates) as [number, number][]
      const k = map.unproject(knobPoint(coords.map((c) => { const p = map.project(c); return [p.x, p.y] })))
      src.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [k.lng, k.lat] }, properties: {} })
    }
    map.on('move', placeKnob)
    map.on('mouseenter', 'rotate-knob', () => { map.getCanvas().style.cursor = 'grab' })
    map.on('mouseleave', 'rotate-knob', () => { if (!turning) map.getCanvas().style.cursor = '' })
    map.on('mousedown', 'rotate-knob', (e) => {
      const f = knobTarget()
      if (!f) return
      e.preventDefault()
      map.dragPan.disable()
      const c = map.project(turf.centroid(f).geometry.coordinates as [number, number])
      turning = { f, c: { x: c.x, z: c.y }, from: { x: e.point.x, z: e.point.y }, deg: 0 }
      map.getCanvas().style.cursor = 'grabbing'
      placeKnob()
    })
    map.on('mousemove', (e) => {
      if (!turning) return
      turning.deg = ringAngle(turning.c, turning.from, { x: e.point.x, z: e.point.y }, (e.originalEvent as MouseEvent).shiftKey)
      const t = turning.f, g = isRoad(t) ? turf.transformRotate(turf.lineString(designLine(t)), turning.deg, { pivot: turf.centroid(t).geometry.coordinates }).geometry : rotate(t, turning.deg).geometry
      if (draw?.hasFeature(t.id)) draw.updateFeatureGeometry(t.id, roundGeometry(g) as GeoJSONStoreFeatures['geometry'])
    })
    const endTurn = () => {
      if (!turning) return
      const { f, deg } = turning
      turning = null
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
      swallowClick = true // the click that ends a knob drag must not deselect
      setTimeout(() => { swallowClick = false }, 0)
      if (deg) useStore.getState().rotateFeatures([f.id], deg)
      else if (draw?.hasFeature(f.id)) draw.updateFeatureGeometry(f.id, editGeom(f) as GeoJSONStoreFeatures['geometry'])
      placeKnob()
    }
    window.addEventListener('mouseup', endTurn)

    map.on('click', (e) => {
      setMenu(null)
      if (swallowClick) return
      const s = useStore.getState()
      if (s.tool !== 'select') return
      const id = pick(e)
      // Clicking inside the feature being edited (and nothing else on top) keeps it selected.
      if (!id && editingId && draw?.getFeaturesAtLngLat(e.lngLat, { ignoreSelectFeatures: false }).some((f) => f.id === editingId)) return
      const shift = (e.originalEvent as MouseEvent).shiftKey
      if (shift && id) s.select(s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id])
      else s.select(id ? [id] : [])
    })

    map.on('contextmenu', (e) => {
      const s = useStore.getState()
      const id = pick(e) ?? (editingId && draw?.getFeaturesAtLngLat(e.lngLat).some((f) => f.id === editingId) ? editingId : null)
      if (id && !s.selection.includes(id)) s.select([id])
      setMenu(id || s.clipboard.length ? { x: e.point.x, y: e.point.y, at: [e.lngLat.lng, e.lngLat.lat] } : null)
    })

    return () => { unsub(); window.removeEventListener('mouseup', endTurn); draw?.stop(); map.remove(); mapInstance = null }
  }, [])

  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData('application/x-urbanforge')
    if (!type || !mapInstance) return
    e.preventDefault()
    const r = el.current!.getBoundingClientRect()
    const ll = mapInstance.unproject([e.clientX - r.left, e.clientY - r.top])
    const s = useStore.getState()
    const c = (s.snap.grid ? snapToGrid([ll.lng, ll.lat], s.meta.gridOrigin ?? s.meta.center, s.snap.gridSize, s.snap.gridAngle) : [ll.lng, ll.lat]) as [number, number]
    s.setTool('select')
    s.addFeature(type, componentGeometry(componentDef(type), c))
  }

  return (
    <div className="relative h-full w-full" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div ref={el} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-1 left-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white">
        {cursor ? `${cursor[1].toFixed(6)}°, ${cursor[0].toFixed(6)}°  WGS 84` : 'EPSG:4326'}
      </div>
      {credit && <div className="pointer-events-none absolute bottom-1 right-2 z-10 rounded bg-white/85 px-1.5 py-0.5 text-[10px] text-neutral-700"><b className="font-semibold">Google</b> · {credit}</div>}
      {menu && <ContextMenu {...menu} close={() => setMenu(null)} />}
    </div>
  )
}

function ContextMenu({ x, y, at, close }: { x: number; y: number; at: [number, number]; close: () => void }) {
  const s = useStore()
  const one = s.selection.length === 1 ? s.features[s.selection[0]] : undefined
  const road = (f?: PlanFeature) => !!f && f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads'
  const two = s.selection.length === 2 && s.selection.every((id) => road(s.features[id]))
  const items: [string, string, () => void, boolean?][] = [
    ['Copy', 'Ctrl+C', s.copy, !s.selection.length],
    ['Paste', 'Ctrl+V', s.paste, !s.clipboard.length],
    ['Duplicate', 'Ctrl+D', s.duplicate, !s.selection.length],
    ['Zoom to', '', () => one && zoomTo(one), !one],
    ['Delete', 'Del', s.deleteSelected, !s.selection.length],
    ...(road(one) ? [['Split road here', '', () => s.splitRoad(one!.id, at)] as [string, string, () => void]] : []),
    ...(two ? [['Join roads', '', () => { s.joinRoads(s.selection[0], s.selection[1]) }] as [string, string, () => void]] : []),
  ]
  return (
    <div className="absolute z-20 min-w-44 rounded border border-white/10 bg-panel py-1 text-xs shadow-xl" style={{ left: x, top: y }} onMouseLeave={close}>
      {items.map(([label, key, fn, disabled]) => (
        <button key={label} disabled={disabled} onClick={() => { fn(); close() }}
          className="flex w-full justify-between gap-6 px-3 py-1 text-left hover:bg-accent/20 disabled:opacity-40">
          <span>{label}</span><span className="text-muted">{key}</span>
        </button>
      ))}
    </div>
  )
}

/** `padding`: px kept clear on each side, e.g. to keep a dialog off the features. */
export function zoomTo(f: PlanFeature | PlanFeature[], padding: number | maplibregl.PaddingOptions = 80) {
  if (!mapInstance) return
  const fs = Array.isArray(f) ? f : [f]
  if (!fs.length) return
  const b = new maplibregl.LngLatBounds()
  for (const x of fs) {
    const walk = (c: any): void => { typeof c[0] === 'number' ? b.extend(c as [number, number]) : c.forEach(walk) }
    walk((x.geometry as any).coordinates)
  }
  mapInstance.fitBounds(b, { padding, maxZoom: 18, duration: 600 })
}
