import { create } from 'zustand'
import * as turf from '@turf/turf'
import type { FeatureCollection, LineString, Position } from 'geojson'
import { temporal } from 'zundo'
import { componentDef, defaultAttrs, isMovable, newProject, NETWORKS, uid, type Attrs, type Layer, type LayerKind, type PlanFeature, type PlanGeometry, type Project } from './model'
import { footprint, center, frame, translate, measure, plotIssue, rotate, scale, splitByLine, LETTERS, type PlotRules } from './geo'
import { curveRoad, measureFrontage, roundaboutGeom } from './roads'

export type MapTheme = 'zoning' | 'far' | 'coverage' | 'compliance'

export interface SnapSettings { vertices: boolean; edges: boolean; grid: boolean; gridSize: number; gridAngle: number }
const SNAP_KEY = 'urbanforge:snap'
const loadSnap = (): SnapSettings => {
  const d = { vertices: true, edges: true, grid: false, gridSize: 5, gridAngle: 0 }
  try { return { ...d, ...JSON.parse(localStorage.getItem(SNAP_KEY) ?? '{}') } } catch { return d }
}

export type Tool = 'select' | 'pan' | 'boundary' | 'zone' | 'plot' | 'road' | 'utility' | 'point' | 'measure' | 'measure-area' | 'cut'

type Meta = Omit<Project, 'features' | 'layers'>

export interface State {
  meta: Meta
  features: Record<string, PlanFeature>
  layers: Layer[]
  selection: string[]
  tool: Tool
  view3d: boolean
  snap: SnapSettings
  mapTheme: MapTheme
  heatmap: boolean
  /** Temporary overlay (e.g. a master-plan alternative) drawn above the plan; not project data. */
  preview: FeatureCollection | null
  setPreview(fc: FeatureCollection | null): void
  dirty: boolean
  clipboard: PlanFeature[]
  activeLayerId: string | null
  /** One-line status message shown under the toolbar. */
  notice: string | null
  notify(m: string | null): void
  /** Knife tool: splits every visible, unlocked plot the line crosses, as one undo step. */
  cutPlots(line: LineString): void

  load(p: Project): void
  setMeta(m: Partial<Meta>): void
  setTool(t: Tool): void
  setView3d(v: boolean): void
  setSnap(p: Partial<SnapSettings>): void
  setMapTheme(t: MapTheme): void
  setHeatmap(on: boolean): void
  select(ids: string[]): void
  addFeature(type: string, geometry: PlanGeometry, attrs?: Attrs, name?: string): string
  addFeatures(fs: PlanFeature[]): void
  /** Removes and adds features as a single undo step (split, merge). */
  replaceFeatures(removeIds: string[], add: PlanFeature[]): void
  /** Turns the selected areas into a polygon component, keeping their shapes (one undo step). False when nothing applies. */
  convertSelection(type: string): boolean
  /** Updates plot rules and re-validates every plot, as one undo step. */
  setPlotRules(r: PlotRules): void
  updateFeature(id: string, patch: { name?: string; layerId?: string; attrs?: Attrs; geometry?: PlanGeometry }): void
  deleteSelected(): void
  /** Rotates features about their centres (one undo step). Parametric footprints keep width/depth/rotation in sync. */
  rotateFeatures(ids: string[], deg: number): void
  /** Sets a road's design line (its bend points; the curve is recomputed) — one undo step. */
  setRoadLine(id: string, line: Position[]): void
  /** Moves a road's point and every other road's end / bend point within 1 m of it (a junction) — one undo step. */
  moveRoadPoint(id: string, from: Position, to: Position, index?: number): void
  /** Splits a road at the point on it nearest `at` into two roads with the same settings (both selected) — one undo step. */
  splitRoad(id: string, at: Position): void
  /** Joins two roads that share an end into the first one (its settings); false + a notice when they don't meet. */
  joinRoads(a: string, b: string): boolean
  /** Translate movable, unlocked features by metres east (dx) / north (dy) — one undo step (3D drag). */
  moveFeatures(ids: string[], dx: number, dy: number): void
  /** Scales features about their centres (one undo step). */
  scaleFeatures(ids: string[], k: number): void
  copy(): void
  paste(): void
  duplicate(): void
  markSaved(): void
  layerFor(kind: LayerKind): string
  /** The layer for one infrastructure network ("Water supply", "Sewerage"…), created on first use. */
  networkLayer(network: string): string
  /** Layer for a new feature: its network's layer for utilities, else the default layer of its kind. */
  layerForFeature(type: string, attrs: Attrs): string
  addLayer(kind: LayerKind, name: string): void
  updateLayer(id: string, patch: Partial<Layer>): void
  moveLayer(id: string, dir: -1 | 1): void
  removeLayer(id: string): void
  setActiveLayer(id: string | null): void
}

export const toProject = (s: Pick<State, 'meta' | 'features' | 'layers'>): Project =>
  ({ ...s.meta, features: s.features, layers: s.layers })

const split = (p: Project) => {
  const { features, layers, ...meta } = p
  return { meta, features, layers }
}

export const useStore = create<State>()(
  temporal(
    (set, get) => ({
      ...split(newProject()),
      selection: [],
      tool: 'select',
      view3d: false,
      snap: loadSnap(),
      mapTheme: 'zoning',
      heatmap: false,
      setMapTheme: (mapTheme) => set({ mapTheme }),
      setHeatmap: (heatmap) => set({ heatmap }),
      preview: null,
      setPreview: (preview) => set({ preview }),
      dirty: false,
      clipboard: [],
      activeLayerId: null,
      notice: null,
      notify: (notice) => set({ notice }),

      cutPlots: (line) => {
        const s = get()
        const skip = new Set(s.layers.filter((l) => !l.visible || l.locked).map((l) => l.id))
        const roads = Object.values(s.features).filter((f) => componentDef(f.properties.type).layer === 'roads')
        const remove: string[] = [], add: PlanFeature[] = []
        for (const f of Object.values(s.features)) {
          if (f.properties.type !== 'plot' || f.geometry.type !== 'Polygon' || skip.has(f.properties.layerId)) continue
          if (!turf.booleanIntersects(f, turf.feature(line))) continue
          const pieces = splitByLine(f.geometry, line)
          if (!pieces) continue
          remove.push(f.id)
          const { issue: _i, depth: _d, ...a } = f.properties.attrs // depth no longer meaningful after a free cut
          const no = a.plotNo ? String(a.plotNo) : ''
          pieces.forEach((g, i) => {
            const id = uid()
            const attrs: Attrs = { ...a, frontage: measureFrontage(g, roads) }
            if (no) attrs.plotNo = `${no}${LETTERS[i] ?? i + 1}`
            add.push(revalidate({ type: 'Feature', id, geometry: g, properties: { ...f.properties, id, name: no ? `Plot ${attrs.plotNo}` : f.properties.name, attrs } }, s.meta.settings))
          })
        }
        if (!remove.length) return set({ notice: 'The cut line doesn’t cross any visible, unlocked plot.' })
        get().replaceFeatures(remove, add)
        set({ notice: `Cut ${remove.length} plot(s) into ${add.length}. Frontage was re-measured from adjacent roads.` })
      },

      load: (p) => set({ ...split(p), selection: [], dirty: false, activeLayerId: null }),
      setMeta: (m) => set((s) => ({ meta: { ...s.meta, ...m }, dirty: true })),
      setTool: (tool) => set({ tool }),
      setView3d: (view3d) => set({ view3d }),
      setSnap: (p) => set((s) => {
        const snap = { ...s.snap, ...p }
        localStorage.setItem(SNAP_KEY, JSON.stringify(snap))
        // Anchor the grid the first time it's used in a project.
        const meta = snap.grid && !s.meta.gridOrigin ? { ...s.meta, gridOrigin: s.meta.center } : s.meta
        return { snap, meta }
      }),
      select: (selection) => set({ selection }),

      layerFor: (kind) => {
        const { layers, activeLayerId } = get()
        const active = layers.find((l) => l.id === activeLayerId)
        if (active?.kind === kind && !active.locked) return active.id
        const l = layers.find((l) => l.kind === kind && !l.locked) ?? layers.find((l) => l.kind === kind)
        if (l) return l.id
        get().addLayer(kind, kind[0].toUpperCase() + kind.slice(1))
        return get().layers.at(-1)!.id
      },

      networkLayer: (network) => {
        const label = NETWORKS[network]?.label
        if (!label) return get().layerFor('utilities')
        const found = get().layers.find((l) => l.kind === 'utilities' && l.name === label)
        if (found) return found.id
        get().addLayer('utilities', label)
        return get().layers.at(-1)!.id
      },

      layerForFeature: (type, attrs) => {
        const def = componentDef(type)
        return def.layer === 'utilities' && typeof attrs.network === 'string' ? get().networkLayer(attrs.network) : get().layerFor(def.layer)
      },

      addFeature: (type, geometry, attrs, name) => {
        const def = componentDef(type)
        const id = uid()
        const a = { ...defaultAttrs(def), ...attrs }
        const layerId = get().layerForFeature(type, a)
        const f: PlanFeature = { type: 'Feature', id, geometry, properties: { id, type, layerId, name: name ?? def.label, attrs: a } }
        set((s) => ({ features: { ...s.features, [id]: f.properties.type === 'plot' ? revalidate(f, s.meta.settings) : f }, selection: [id], dirty: true }))
        return id
      },

      addFeatures: (fs) => set((s) => {
        const features = { ...s.features }
        for (const f of fs) features[f.id] = f.properties.type === 'plot' ? revalidate(f, s.meta.settings) : f
        return { features, dirty: true }
      }),

      replaceFeatures: (removeIds, add) => set((s) => {
        const features = { ...s.features }
        for (const id of removeIds) delete features[id]
        for (const f of add) features[f.id] = f
        return { features, selection: add.map((f) => f.id), dirty: true }
      }),

      convertSelection: (type) => {
        const s = get(), def = componentDef(type)
        const locked = lockedIds(s)
        const areas = s.selection.map((id) => s.features[id]).filter((f) => f?.geometry.type === 'Polygon' && !locked.has(f.properties.layerId))
        if (def.geom !== 'polygon' || !areas.length) return false
        const todo = areas.filter((f) => f.properties.type !== type)
        if (!todo.length) return true
        // the area's own outline wins over the component's default rectangle
        const custom: Attrs = 'rotation' in defaultAttrs(def) ? { shape: 'custom' } : {}
        s.replaceFeatures(todo.map((f) => f.id), todo.map((f) => makeFeature(type, f.geometry, custom)))
        set({ notice: `Replaced ${todo.length} area(s) with ${def.label}.` })
        return true
      },

      setPlotRules: (r) => set((s) => {
        const settings = { ...s.meta.settings, ...r }
        let features = s.features // keep the same object when nothing changes, so no empty undo step
        for (const f of Object.values(s.features)) {
          const g = f.properties.type === 'plot' ? revalidate(f, settings) : f
          if (g !== f) { if (features === s.features) features = { ...s.features }; features[f.id] = g }
        }
        return { meta: { ...s.meta, settings }, features, dirty: true }
      }),

      updateFeature: (id, patch) => set((s) => {
        const f = s.features[id]
        if (!f) return {}
        const attrs = patch.attrs ? { ...f.properties.attrs, ...patch.attrs } : f.properties.attrs
        let geometry = patch.geometry ?? f.geometry
        // Parametric footprint: editing width/depth/rotation regenerates the rectangle.
        if (patch.attrs && geometry.type === 'Polygon' && attrs.shape !== 'custom' && ['width', 'depth', 'rotation'].some((k) => k in patch.attrs!) && attrs.width && attrs.depth)
          geometry = footprint(center(f), Number(attrs.width), Number(attrs.depth), Number(attrs.rotation) || 0)
        if (patch.attrs && ('radius' in patch.attrs || 'island' in patch.attrs) && (f.properties.type === 'roundabout' || f.properties.type === 'cul-de-sac')) {
          const r = Math.max(1, Number(attrs.radius) || 1), isl = f.properties.type === 'roundabout' ? Number(attrs.island) || 0 : 0
          geometry = roundaboutGeom(center(f), r, isl) // circles are centred on their centroid
        }
        // Changing a utility's network moves it to that network's layer (unless the layer was set explicitly).
        const netMove = patch.attrs?.network !== undefined && !patch.layerId && componentDef(f.properties.type).layer === 'utilities' && NETWORKS[String(patch.attrs.network)]
          ? get().networkLayer(String(patch.attrs.network)) : undefined
        const properties = { ...f.properties, attrs, ...(patch.name !== undefined && { name: patch.name }), ...((patch.layerId || netMove) && { layerId: patch.layerId ?? netMove! }) }
        let next: PlanFeature = { ...f, geometry, properties }
        if (patch.attrs && 'curveRadius' in patch.attrs && isRoadLine(f)) next = withLine(next, designLine(f)) // radius 0: sharp corners, bend points kept
        return { features: { ...s.features, [id]: f.properties.type === 'plot' ? revalidate(next, s.meta.settings) : next }, dirty: true }
      }),

      moveFeatures: (ids, dx, dy) => set((s) => {
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return s
        const locked = lockedIds(s), features = { ...s.features }
        for (const id of ids) {
          const f = features[id]
          if (f && isMovable(f) && !locked.has(f.properties.layerId)) features[id] = translate(f, dx, dy)
        }
        return { features, dirty: true }
      }),
      rotateFeatures: (ids, deg) => set((s) => {
        const locked = lockedIds(s)
        const features = { ...s.features }
        for (const id of ids) {
          const f = features[id]
          if (!f || f.geometry.type === 'Point' || locked.has(f.properties.layerId)) continue
          if (isRoadLine(f) && f.properties.attrs.pi) { features[id] = withLine(f, turf.transformRotate(turf.lineString(designLine(f)), deg, { pivot: center(f) }).geometry.coordinates); continue }
          const a = f.properties.attrs
          const angle = (((Number(a.rotation) || 0) + deg) % 360 + 360) % 360
          const parametric = f.geometry.type === 'Polygon' && 'rotation' in a && a.shape !== 'custom' && Number(a.width) > 0 && Number(a.depth) > 0
          const geometry = parametric ? footprint(center(f), Number(a.width), Number(a.depth), angle) : rotate(f, deg).geometry
          const attrs = 'rotation' in a ? { ...a, rotation: +angle.toFixed(2) } : a
          features[id] = { ...f, geometry, properties: { ...f.properties, attrs } }
        }
        return { features, dirty: true }
      }),

      setRoadLine: (id, line) => set((s) => {
        const f = s.features[id]
        if (!f || !isRoadLine(f) || line.length < 2) return {}
        return { features: { ...s.features, [id]: withLine(f, line) }, dirty: true }
      }),

      moveRoadPoint: (id, from, to, index) => set((s) => {
        const locked = lockedIds(s), features = { ...s.features }
        let moved = false
        for (const f of Object.values(s.features)) {
          if (!isRoadLine(f) || locked.has(f.properties.layerId)) continue
          const line = designLine(f)
          let hit = false
          if (f.id === id && index !== undefined && line[index]) {
            // the dragged road: only the dragged point (and its twin end on a closed loop), never its other points near it
            const next = line.map((p) => [...p]), last = line.length - 1, closed = turf.distance(line[0], line[last], { units: 'meters' }) < 0.01
            next[index] = [...to]
            if (closed && (index === 0 || index === last)) { next[0] = [...to]; next[last] = [...to] }
            features[f.id] = withLine(f, next); moved = true
            continue
          }
          const next = line.map((p) => (turf.distance(p, from, { units: 'meters' }) <= 1 || (f.id === id && p[0] === from[0] && p[1] === from[1]) ? ((hit = true), [...to]) : p))
          if (hit) { features[f.id] = withLine(f, next); moved = true }
        }
        return moved ? { features, dirty: true } : {}
      }),

      splitRoad: (id, at) => {
        const s = get(), f = s.features[id]
        if (!f || !isRoadLine(f)) return
        const line = designLine(f), snap = turf.nearestPointOnLine(turf.lineString(line), at)
        const k = snap.properties.index ?? 0, p = snap.geometry.coordinates.map((v) => Math.round(v * 1e9) / 1e9)
        const same = (q: Position) => turf.distance(q, p, { units: 'meters' }) < 0.01
        const one = [...line.slice(0, k + 1).filter((q, i) => i < k + 1 && !(i === k && same(q))), p]
        const two = [p, ...line.slice(k + 1).filter((q, i) => !(i === 0 && same(q)))]
        if (one.length < 2 || two.length < 2) return set({ notice: 'Click inside the road, not on its end, to split it.' })
        const part = (pts: Position[], n: number): PlanFeature => { const nid = uid(); return withLine({ ...f, id: nid, properties: { ...f.properties, id: nid, name: `${f.properties.name} (${n})`, attrs: { ...f.properties.attrs } } }, pts) }
        const a = part(one, 1), b = part(two, 2)
        get().replaceFeatures([id], [a, b])
      },

      joinRoads: (a, b) => {
        const s = get(), fa = s.features[a], fb = s.features[b]
        if (!fa || !fb || a === b || !isRoadLine(fa) || !isRoadLine(fb)) return false
        const la = designLine(fa), lb = designLine(fb), meet = (p: Position, q: Position) => turf.distance(p, q, { units: 'meters' }) <= 1
        const joined = meet(la.at(-1)!, lb[0]) ? [...la, ...lb.slice(1)] : meet(la.at(-1)!, lb.at(-1)!) ? [...la, ...[...lb].reverse().slice(1)]
          : meet(la[0], lb.at(-1)!) ? [...lb, ...la.slice(1)] : meet(la[0], lb[0]) ? [...[...lb].reverse(), ...la.slice(1)] : null
        if (!joined) { set({ notice: 'These roads don’t share an end: drag one end onto the other first.' }); return false }
        // the meeting point goes when the road runs straight through it
        const j = joined.findIndex((p, i) => i > 0 && i < joined.length - 1 && (meet(p, la.at(-1)!) || meet(p, la[0])))
        if (j > 0) {
          const b1 = turf.bearing(joined[j - 1], joined[j]), b2 = turf.bearing(joined[j], joined[j + 1])
          if (Math.abs((((b2 - b1) % 360) + 540) % 360 - 180) < 1) joined.splice(j, 1)
        }
        set((st) => { const features = { ...st.features, [a]: withLine(fa, joined) }; delete features[b]; return { features, selection: [a], dirty: true } })
        return true
      },

      scaleFeatures: (ids, k) => set((s) => {
        const locked = lockedIds(s)
        const features = { ...s.features }
        for (const id of ids) {
          const f = features[id]
          if (!f || f.geometry.type === 'Point' || locked.has(f.properties.layerId)) continue
          const a = f.properties.attrs
          if (isRoadLine(f) && a.pi) { features[id] = withLine(f, turf.transformScale(turf.lineString(designLine(f)), k, { origin: center(f) }).geometry.coordinates); continue }
          const parametric = f.geometry.type === 'Polygon' && 'rotation' in a && a.shape !== 'custom' && Number(a.width) > 0 && Number(a.depth) > 0
          if (parametric) {
            const width = +(Number(a.width) * k).toFixed(2), depth = +(Number(a.depth) * k).toFixed(2)
            features[id] = { ...f, geometry: footprint(center(f), width, depth, Number(a.rotation) || 0), properties: { ...f.properties, attrs: { ...a, width, depth } } }
          } else features[id] = { ...f, geometry: scale(f, k).geometry }
          if (features[id].properties.type === 'plot') features[id] = revalidate(features[id], s.meta.settings)
        }
        return { features, dirty: true }
      }),

      deleteSelected: () => set((s) => {
        const locked = lockedIds(s)
        const features = { ...s.features }
        for (const id of s.selection) if (!locked.has(features[id]?.properties.layerId)) delete features[id]
        return { features, selection: [], dirty: true }
      }),

      copy: () => set((s) => ({ clipboard: s.selection.map((id) => s.features[id]).filter(Boolean) })),
      paste: () => {
        const { clipboard } = get()
        if (!clipboard.length) return
        const copies = clipboard.map((f) => {
          const id = uid()
          const moved = { ...translate(f, 15, -15), id, properties: { ...f.properties, id, attrs: { ...f.properties.attrs } } }
          return isRoadLine(f) && f.properties.attrs.pi ? withLine(moved, (translate({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: designLine(f) } } as any, 15, -15).geometry as LineString).coordinates) : moved
        })
        get().addFeatures(copies)
        set({ selection: copies.map((c) => c.id), clipboard: copies })
      },
      duplicate: () => { get().copy(); get().paste() },
      markSaved: () => set({ dirty: false }),

      addLayer: (kind, name) => set((s) => ({ layers: [...s.layers, { id: uid(), kind, name, visible: true, locked: false, opacity: 1 }], dirty: true })),
      updateLayer: (id, patch) => set((s) => ({ layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)), dirty: true })),
      moveLayer: (id, dir) => set((s) => {
        const i = s.layers.findIndex((l) => l.id === id), j = i + dir
        if (i < 0 || j < 0 || j >= s.layers.length) return {}
        const layers = [...s.layers];[layers[i], layers[j]] = [layers[j], layers[i]]
        return { layers, dirty: true }
      }),
      removeLayer: (id) => set((s) => {
        // Never silently drop features: a layer can only be removed when empty.
        if (Object.values(s.features).some((f) => f.properties.layerId === id)) return {}
        return { layers: s.layers.filter((l) => l.id !== id), dirty: true }
      }),
      setActiveLayer: (activeLayerId) => set({ activeLayerId }),
    }),
    {
      partialize: (s) => ({ features: s.features, layers: s.layers }),
      equality: (a, b) => a.features === b.features && a.layers === b.layers,
      limit: 200,
    },
  ),
)

/** Recomputes a plot's validation issue from its current geometry, frontage and the project rules. */
function revalidate(f: PlanFeature, r: PlotRules): PlanFeature {
  const a = f.properties.attrs
  const frontage = a.frontage === undefined || a.frontage === '' ? undefined : Number(a.frontage)
  const issue = plotIssue(measure(f).area, frontage, r) ?? ''
  return issue === (a.issue ?? '') ? f : { ...f, properties: { ...f.properties, attrs: { ...a, issue } } }
}

export const lockedIds = (s: Pick<State, 'layers'>) => new Set(s.layers.filter((l) => l.locked).map((l) => l.id))
export const undo = () => { useStore.temporal.getState().undo(); useStore.setState({ dirty: true, selection: [] }) }
export const redo = () => { useStore.temporal.getState().redo(); useStore.setState({ dirty: true, selection: [] }) }
export const clearHistory = () => useStore.temporal.getState().clear()

// Dev-only handle for debugging / browser automation.
if (import.meta.env.DEV) (globalThis as any).__store = useStore

/** Builds a plan feature on the default layer for its type (does not add it to the store). */
export function makeFeature(type: string, geometry: PlanGeometry, attrs: Attrs = {}, name?: string): PlanFeature {
  const def = componentDef(type)
  const id = uid()
  const a = { ...defaultAttrs(def), ...attrs }
  const layerId = useStore.getState().layerForFeature(type, a)
  return { type: 'Feature', id, geometry, properties: { id, type, layerId, name: name ?? def.label, attrs: a } }
}

const isRoadLine = (f: PlanFeature) => f.geometry.type === 'LineString' && componentDef(f.properties.type).layer === 'roads'
/** A road's design line: its bend points (attrs.pi) when it has them, else its geometry. */
export function designLine(f: PlanFeature): Position[] {
  const pi = f.properties.attrs.pi
  if (typeof pi === 'string' && pi) try { return JSON.parse(pi) as Position[] } catch { /* fall back to the geometry */ }
  return f.geometry.type === 'LineString' ? f.geometry.coordinates : []
}
/** The road with design line `line`: geometry = the rounded-corner curve when curveRadius > 0, else the line itself. */
function withLine(f: PlanFeature, line: Position[]): PlanFeature {
  const a = f.properties.attrs, r = Number(a.curveRadius) || 0, fr = frame(line[0])
  const coordinates = r > 0 ? curveRoad(line, r, (p) => fr.toLocal(p) as [number, number], (p) => fr.toGeo(p)) : line.map((p) => [...p])
  const attrs = r > 0 || a.pi ? { ...a, pi: JSON.stringify(line) } : a
  return { ...f, geometry: { type: 'LineString', coordinates }, properties: { ...f.properties, attrs } }
}
