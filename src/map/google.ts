/**
 * Google Map Tiles API (2D roadmap / satellite) — the official, metered way to show Google basemaps in
 * a non-Google renderer. Uses the user's own API key, kept in this browser only (localStorage), never in
 * the project file. Free within Google's monthly allowance; Google's terms require its attribution on
 * screen and forbid caching tiles beyond the session.
 */
export type GoogleMapType = 'roadmap' | 'satellite'
const API = 'https://tile.googleapis.com'
const KEY = 'urbanforge.googleMapsKey'

export function googleKey(): string {
  try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}
export function setGoogleKey(key: string): void {
  try { key.trim() ? localStorage.setItem(KEY, key.trim()) : localStorage.removeItem(KEY) } catch { /* storage blocked: key lasts this page only */ }
}

const sessions = new Map<string, { session: string; expires: number }>()
/** Test hook. */
export const _resetGoogleSessions = () => sessions.clear()

async function json(r: Response) {
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body?.error?.message ?? `Google Map Tiles API: HTTP ${r.status}`)
  return body
}

/** A tile session for `type` (cached; renewed a minute before it expires). */
export async function googleSession(key: string, type: GoogleMapType): Promise<string> {
  const id = `${key}|${type}`, hit = sessions.get(id)
  if (hit && hit.expires - Date.now() > 60_000) return hit.session
  const body = await json(await fetch(`${API}/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: type, language: navigator?.language || 'en-US', region: 'US' }),
  }))
  sessions.set(id, { session: body.session, expires: Number(body.expiry) * 1000 })
  return body.session
}

export const googleTileUrl = (key: string, session: string) => `${API}/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${key}`

/** Copyright text Google requires for the visible area ([west, south, east, north]). */
export async function googleCopyright(key: string, session: string, zoom: number, [w, s, e, n]: number[]): Promise<string> {
  const q = `session=${session}&key=${key}&zoom=${Math.round(zoom)}&north=${n}&south=${s}&east=${e}&west=${w}`
  return (await json(await fetch(`${API}/tile/v1/viewport?${q}`))).copyright ?? 'Google'
}
