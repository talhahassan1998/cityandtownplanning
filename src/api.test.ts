import { afterEach, describe, expect, it, vi } from 'vitest'
import { gdalExportGpkg, saveServerProject, serverUp, utmEpsg } from './api'

const reply = (status: number, body: unknown, type = 'application/json') =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } }))

afterEach(() => vi.unstubAllGlobals())

describe('backend client', () => {
  it('picks the UTM zone for a project centre', () => {
    expect(utmEpsg([67.0, 24.86])).toBe('EPSG:32642') // Karachi
    expect(utmEpsg([-0.13, 51.5])).toBe('EPSG:32630') // London
    expect(utmEpsg([151.2, -33.9])).toBe('EPSG:32756') // Sydney
  })
  it('surfaces the API error detail', async () => {
    vi.stubGlobal('fetch', reply(422, { detail: 'project id does not match the URL' }))
    await expect(saveServerProject({ id: 'x' } as any)).rejects.toThrow('project id does not match the URL')
  })
  it('treats an unreachable server or missing database as down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect(await serverUp()).toBe(false)
    vi.stubGlobal('fetch', reply(200, { ok: true, db: false }))
    expect(await serverUp()).toBe(false)
    vi.stubGlobal('fetch', reply(200, { ok: true, db: true }))
    expect(await serverUp()).toBe(true)
  })
  it('returns binary exports as a Blob', async () => {
    vi.stubGlobal('fetch', reply(200, 'GPKG', 'application/geopackage+sqlite3'))
    const b = await gdalExportGpkg({ type: 'FeatureCollection', features: [] }, 'EPSG:32642')
    expect(b).toBeInstanceOf(Blob)
    expect((fetch as any).mock.calls[0][0]).toBe('/api/convert/gpkg?srs=EPSG%3A32642')
  })
})
