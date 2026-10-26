import { del, get, set } from 'idb-keyval'
import * as turf from '@turf/turf'
import type { FeatureCollection, Position } from 'geojson'
import { componentDef, defaultAttrs, newProject, SCHEMA_VERSION, uid, type Attrs, type Layer, type PlanFeature, type Project } from './model'
import { measure } from './geo'

// --- IndexedDB -------------------------------------------------------------------
export interface ProjectSummary { id: string; name: string; updatedAt: string; featureCount: number }

const INDEX = 'projects:index'
const RECOVERY = 'projects:recovery'

export async function listProjects(): Promise<ProjectSummary[]> {
  return ((await get<ProjectSummary[]>(INDEX)) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function saveProject(p: Project): Promise<Project> {
  const saved = { ...p, updatedAt: new Date().toISOString() }
  await set(`project:${p.id}`, saved)
  const index = (await listProjects()).filter((s) => s.id !== p.id)
  await set(INDEX, [{ id: p.id, name: p.name, updatedAt: saved.updatedAt, featureCount: Object.keys(p.features).length }, ...index])
  await del(RECOVERY)
  return saved
}

export const loadProject = (id: string) => get<Project>(`project:${id}`)

export async function deleteProject(id: string) {
  await del(`project:${id}`)
  await set(INDEX, (await listProjects()).filter((s) => s.id !== id))
}

/** Unsaved working copy, written continuously so a crash/closed tab never loses work. */
export const saveRecovery = (p: Project) => set(RECOVERY, { ...p, updatedAt: new Date().toISOString() })
export const loadRecovery = () => get<Project>(RECOVERY)
export const clearRecovery = () => del(RECOVERY)

// --- validation ---------------------------------------------------------------------
const okPos = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90

/** Returns a reason string if the geometry can't be used, undefined if valid. */
export function geometryProblem(g: any): string | undefined {
  if (!g || typeof g !== 'object') return 'missing geometry'
  switch (g.type) {
    case 'Point': return okPos(g.coordinates) ? undefined : 'bad coordinates'
    case 'LineString':
      if (!Array.isArray(g.coordinates) || g.coordinates.length < 2 || !g.coordinates.every(okPos)) return 'line needs ≥2 valid positions'
      return undefined
    case 'Polygon': {
      const rings = g.coordinates
      if (!Array.isArray(rings) || !rings.length) return 'empty polygon'
      for (const r of rings) {
        if (!Array.isArray(r) || r.length < 4 || !r.every(okPos)) return 'ring needs ≥4 valid positions'
        const a = r[0], b = r[r.length - 1]
        if (a[0] !== b[0] || a[1] !== b[1]) return 'ring not closed'
      }
      if (turf.kinks(turf.polygon(rings)).features.length) return 'self-intersecting polygon'
      return undefined
    }
    default: return `unsupported geometry type ${g.type}`
  }
}

// --- project files -----------------------------------------------------------------
export const serializeProject = (p: Project) => JSON.stringify({ format: 'urbanforge', ...p }, null, 1)

export function parseProject(text: string): { project: Project; rejected: string[] } {
  const raw = JSON.parse(text)
  if (raw.format !== 'urbanforge') throw new Error('Not an UrbanForge project file')
  if (raw.version > SCHEMA_VERSION) throw new Error(`Project schema v${raw.version} is newer than this app (v${SCHEMA_VERSION})`)
  const { format: _, ...rest } = raw
  const project: Project = { ...newProject(), ...rest, features: {} }
  const layerIds = new Set(project.layers.map((l: Layer) => l.id))
  const rejected: string[] = []
  for (const [id, f] of Object.entries<any>(raw.features ?? {})) {
    const why = geometryProblem(f?.geometry) ?? (layerIds.has(f?.properties?.layerId) ? undefined : 'unknown layer')
    if (why) rejected.push(`${id}: ${why}`)
    else project.features[id] = f
  }
  return { project, rejected }
}

// --- project files on the user's disk ------------------------------------------------
// File System Access API (Chrome/Edge): the chosen file stays linked to the project (handle kept in IndexedDB),
// so every later Save overwrites it. Other browsers fall back to a download.
const PICK = { types: [{ description: 'UrbanForge project', accept: { 'application/json': ['.json'] } }] }
const fsa = globalThis as any // showSaveFilePicker / requestPermission aren't in the DOM typings yet
export const canLinkFiles = 'showSaveFilePicker' in globalThis
export const linkedFile = (id: string) => get<FileSystemFileHandle>(`file:${id}`)
const cancelled = (e: unknown) => (e as Error).name === 'AbortError'

/** Writes the project to its linked file, asking where on first use (or when `pick`). Returns the file name; undefined = user cancelled. */
export async function saveToFile(p: Project, pick = false): Promise<string | undefined> {
  const suggestedName = `${p.name.replace(/[^\w-]+/g, '_')}.urbanforge.json`
  if (!canLinkFiles) { download(suggestedName, serializeProject(p)); return `${suggestedName} (Downloads)` }
  let h: any = pick ? undefined : await linkedFile(p.id)
  if (h && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = undefined
  try { h ??= await fsa.showSaveFilePicker({ ...PICK, suggestedName }) } catch (e) { if (cancelled(e)) return; throw e }
  const w = await h.createWritable()
  await w.write(serializeProject(p)); await w.close()
  await set(`file:${p.id}`, h)
  return h.name
}

/** Picks a project file from disk and links it, so Save writes back to it. undefined = user cancelled. */
export async function openFromFile(): Promise<{ project: Project; rejected: string[]; name: string } | undefined> {
  let h: FileSystemFileHandle
  try { [h] = await fsa.showOpenFilePicker(PICK) } catch (e) { if (cancelled(e)) return; throw e }
  const r = parseProject(await (await h.getFile()).text())
  await set(`file:${r.project.id}`, h)
  return { ...r, name: h.name }
}

// --- GeoJSON -------------------------------------------------------------------------
export function toGeoJSON(features: PlanFeature[], layers: Layer[]): FeatureCollection {
  const names = new Map(layers.map((l) => [l.id, l.name]))
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature', id: f.id, geometry: f.geometry,
      properties: { id: f.id, type: f.properties.type, name: f.properties.name, layer: names.get(f.properties.layerId), ...f.properties.attrs },
    })),
  }
}

/** Maps a foreign feature's properties to an UrbanForge type (+ extra attributes), if recognised. */
export type Classifier = (props: Record<string, unknown>, geom: 'Polygon' | 'LineString' | 'Point') => { type: string; attrs?: Attrs } | undefined
/** Layer that a feature of this type/attributes belongs on (see store.layerForFeature). */
export type LayerOf = (type: string, attrs: Attrs) => string

/** Imports GeoJSON text. See `importFeatureCollection`. */
export const parseGeoJSON = (text: string, layerOf: LayerOf, classify?: Classifier) => importFeatureCollection(JSON.parse(text), layerOf, classify)

/**
 * Imports a GeoJSON FeatureCollection / Feature / geometry. Features exported by UrbanForge keep
 * their type; foreign ones go through `classify`, else become a zone / road / node by geometry.
 * Multi* geometries are exploded. Invalid features are reported, never silently dropped.
 */
export function importFeatureCollection(raw: any, layerOf: LayerOf, classify?: Classifier): { features: PlanFeature[]; rejected: string[] } {
  const list: any[] = raw.type === 'FeatureCollection' ? raw.features : raw.type === 'Feature' ? [raw] : [{ type: 'Feature', geometry: raw, properties: {} }]
  const out: PlanFeature[] = [], rejected: string[] = []
  list.forEach((f, i) => {
    const g = f?.geometry
    const parts = g?.type?.startsWith('Multi') ? g.coordinates.map((c: any) => ({ type: g.type.slice(5), coordinates: c })) : [g]
    for (const geometry of parts) {
      const why = geometryProblem(geometry)
      if (why) { rejected.push(`#${i}: ${why}`); continue }
      const props = f.properties ?? {}
      const { id: _i, type: t, name, layer: _l, ...attrs } = props
      const known = typeof t === 'string' && componentDef(t).label !== t
      const guess = known ? undefined : classify?.(props, geometry.type)
      const type = known ? t : guess?.type ?? (geometry.type === 'Polygon' ? 'zone' : geometry.type === 'LineString' ? 'road' : 'node')
      const def = componentDef(type)
      const id = uid()
      // text formats (KML, CSV, DXF, DBF) carry numbers as strings: restore plain numeric values
      const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => typeof v === 'number' || typeof v === 'string')
        .map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v])) as Attrs
      // defaults first (e.g. road width), then the file's own values, then what the classifier derived
      const all: Attrs = { ...defaultAttrs(def), ...clean, ...guess?.attrs }
      out.push({ type: 'Feature', id, geometry, properties: { id, type, layerId: layerOf(type, all), name: String(name ?? props.Name ?? props.NAME ?? def.label), attrs: all } })
    }
  })
  return { features: out, rejected }
}

// --- reports ---------------------------------------------------------------------------
export function plotScheduleCSV(features: PlanFeature[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = features
    .filter((f) => f.properties.type === 'plot')
    .map((f) => {
      const a = f.properties.attrs
      const c = turf.centroid(f).geometry.coordinates
      return [a.plotNo ?? f.properties.name, a.block, measure(f).area.toFixed(1), a.frontage, a.depth, a.zoning, a.status, a.issue || 'OK', c[1].toFixed(6), c[0].toFixed(6)]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
  return [['plot_no', 'block', 'area_m2', 'frontage_m', 'depth_m', 'zoning', 'status', 'validation', 'lat', 'lng'], ...rows].map((r) => r.map(esc).join(',')).join('\n')
}

export function download(filename: string, data: string | Blob, mime = 'application/json') {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type: mime }) : data)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
