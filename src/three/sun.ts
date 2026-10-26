const RAD = Math.PI / 180

/**
 * Approximate solar position (±1°, good enough for massing and shadow studies).
 * `solarHour` is local *solar* time (12 = sun due south/north), not clock time.
 * Returns elevation above the horizon and azimuth clockwise from north, in degrees.
 */
export function sunPosition(lat: number, dayOfYear: number, solarHour: number): { elevation: number; azimuth: number } {
  const decl = 23.44 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365) * RAD
  const h = 15 * (solarHour - 12) * RAD
  const phi = lat * RAD
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h)
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)))
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI
  return { elevation: el / RAD, azimuth: ((az / RAD) % 360 + 360) % 360 }
}

/** Unit vector towards the sun in scene axes: x = east, y = up, z = south (three.js uses −z as north). */
export function sunDirection(lat: number, dayOfYear: number, solarHour: number): [number, number, number] {
  const { elevation, azimuth } = sunPosition(lat, dayOfYear, solarHour)
  const el = elevation * RAD, az = azimuth * RAD
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]
}

export const SEASONS = { 'Mar equinox': 80, 'Jun solstice': 172, 'Sep equinox': 266, 'Dec solstice': 355 } as const

/** Running clock: `dt` real seconds at `speed`× (1 = real time), wrapping at 24 h. */
export const advanceHour = (hour: number, dt: number, speed: number) => (hour + (dt * speed) / 3600) % 24

/** HH:MM for a solar hour (rounds to whole minutes, 24:00 shows as 00:00). */
export function clockLabel(hour: number) {
  const t = Math.round(hour * 60) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}
