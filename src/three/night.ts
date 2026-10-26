import type { WallKind } from './facades'

/** Night lighting curves: how dark it is, and what share of a building's lit-up windows are on. */
export type LightUse = 'home' | 'office' | 'shop' | 'none'

/** 0 in daylight (sun ≥ 6°), 1 at dusk depth (sun ≤ −6°), smoothstep between. */
export function darkness(sunElevation: number): number {
  const t = Math.min(1, Math.max(0, (6 - sunElevation) / 12))
  return t * t * (3 - 2 * t)
}

const USE: Record<WallKind, LightUse> = {
  residential: 'home',
  apartment: 'home',
  glass: 'office',
  shopfront: 'shop',
  blank: 'none',
}
export const useOfWall = (kind: WallKind): LightUse => USE[kind]

// [hour, share] keyframes, piecewise-linear, wrapping at 24 h. 1 h ramps around the plateaus.
const KEYS: Record<LightUse, [number, number][]> = {
  home: [[1, 0.2], [5, 0.15], [8, 0.1], [16, 0.1], [18, 0.7], [22, 0.7]],
  office: [[6, 0.1], [7, 0.6], [19, 0.6], [20, 0.1]],
  shop: [[7, 0.05], [8, 0.9], [22, 0.9], [23, 0.05]],
  none: [[0, 0]],
}

export function litShare(use: LightUse, solarHour: number): number {
  const k = KEYS[use]
  const shift = (d: number): [number, number][] => k.map(([h, v]) => [h + d, v])
  const ks = [...shift(-24), ...k, ...shift(24)]
  const t = ((solarHour % 24) + 24) % 24
  let i = 0
  while (ks[i + 1][0] <= t) i++
  const [h0, v0] = ks[i], [h1, v1] = ks[i + 1]
  return v0 + ((v1 - v0) * (t - h0)) / (h1 - h0)
}
