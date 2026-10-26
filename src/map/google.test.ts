import { afterEach, describe, expect, it, vi } from 'vitest'
import { googleCopyright, googleKey, googleSession, googleTileUrl, setGoogleKey, _resetGoogleSessions } from './google'

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
afterEach(() => { vi.unstubAllGlobals(); _resetGoogleSessions() })

describe('Google Map Tiles', () => {
  it('creates a session with the map type and builds tile URLs from it', async () => {
    const fetch = vi.fn(() => ok({ session: 'S1', expiry: String(Math.floor(Date.now() / 1000) + 3600), tileWidth: 256, imageFormat: 'png' }))
    vi.stubGlobal('fetch', fetch)
    const s = await googleSession('KEY', 'satellite')
    expect(s).toBe('S1')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://tile.googleapis.com/v1/createSession?key=KEY')
    expect(JSON.parse(String(init.body))).toMatchObject({ mapType: 'satellite' })
    expect(googleTileUrl('KEY', 'S1')).toBe('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=S1&key=KEY')
  })

  it('reuses a session until shortly before it expires', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => ok({ session: `S${++n}`, expiry: String(Math.floor(Date.now() / 1000) + (n === 1 ? 3600 : 30)) })))
    expect(await googleSession('KEY', 'roadmap')).toBe('S1')
    expect(await googleSession('KEY', 'roadmap')).toBe('S1') // cached
    expect(await googleSession('KEY', 'satellite')).toBe('S2') // per map type
    expect(await googleSession('KEY', 'satellite')).toBe('S3') // S2 expires within a minute → renewed
  })

  it("reports Google's error message (bad key, API not enabled, no billing)", async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), { status: 400 }))))
    await expect(googleSession('BAD', 'roadmap')).rejects.toThrow('API key not valid.')
  })

  it('reads the copyright line for the visible area', async () => {
    const fetch = vi.fn(() => ok({ copyright: 'Map data ©2026 Google' }))
    vi.stubGlobal('fetch', fetch)
    expect(await googleCopyright('KEY', 'S1', 15, [66.9, 24.8, 67.1, 24.9])).toBe('Map data ©2026 Google')
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toContain('zoom=15&north=24.9&south=24.8&east=67.1&west=66.9')
  })

  it('keeps the key in this browser only and survives blocked storage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    setGoogleKey('  K1 ')
    expect(googleKey()).toBe('K1')
    setGoogleKey('')
    expect(googleKey()).toBe('')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(googleKey()).toBe('')
    expect(() => setGoogleKey('K2')).not.toThrow()
  })
})
