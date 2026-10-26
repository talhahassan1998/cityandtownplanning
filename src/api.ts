import type { FeatureCollection, Position } from 'geojson'
import type { Project } from './model'
import type { ProjectSummary } from './persist'

/**
 * Client for the Phase 6 backend (backend/, FastAPI + PostGIS + GDAL), reached via /api (Vite proxies it
 * in dev). Everything here is optional: when the server is down the editor keeps working on IndexedDB.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, init)
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try { const d = (await r.json()).detail; if (d) msg = typeof d === 'string' ? d : JSON.stringify(d) } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const type = r.headers.get('content-type') ?? ''
  return (r.status === 204 ? undefined : type.includes('json') ? r.json() : r.blob()) as Promise<T>
}

/** True when the API and its database answer (re-checked every call, cheap). */
export const serverUp = () => call<{ db: boolean }>('/health').then((h) => h.db, () => false)

export const listServerProjects = () => call<ProjectSummary[]>('/projects')
export const loadServerProject = (id: string) => call<Project>(`/projects/${encodeURIComponent(id)}`)
export const deleteServerProject = (id: string) => call<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** Stores the project; returns PostGIS geometry-validity problems (reported, not rejected). */
export const saveServerProject = (p: Project) =>
  call<{ updatedAt: string; invalid: { id: string; reason: string }[] }>(`/projects/${encodeURIComponent(p.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) })

/** Formats GDAL reads on the server. Rasters become contour lines. */
export const GDAL_VECTOR = ['gpkg', 'fgb', 'gml', 'gpx', 'tab', 'mif', 'sqlite', 'gdb']
export const GDAL_RASTER = ['tif', 'tiff', 'geotiff', 'asc', 'hgt', 'img', 'dem', 'bil']

export async function gdalImport(file: File, contourInterval?: number): Promise<{ featureCollection: FeatureCollection; notes: string[] }> {
  const body = new FormData()
  body.append('file', file)
  try {
    return await call(`/convert/import${contourInterval ? `?interval=${contourInterval}` : ''}`, { method: 'POST', body })
  } catch (e) {
    throw new Error(`${(e as Error).message}${(await serverUp()) ? '' : ' — the GDAL backend is not running (docker compose up -d)'}`)
  }
}

export const gdalExportGpkg = (fc: FeatureCollection, srs = 'EPSG:4326') =>
  call<Blob>(`/convert/gpkg?srs=${encodeURIComponent(srs)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fc) })

/** WGS 84 / UTM zone EPSG code for a lon/lat (metric CRS for CAD/GIS hand-off). */
export function utmEpsg([lon, lat]: Position): string {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1))
  return `EPSG:${lat >= 0 ? 32600 + zone : 32700 + zone}`
}
