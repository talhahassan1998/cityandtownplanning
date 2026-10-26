import { describe, expect, it } from 'vitest'
import { darkness, litShare, useOfWall, type LightUse } from './night'
import type { WallKind } from './facades'

const USES: LightUse[] = ['home', 'office', 'shop', 'none']

describe('darkness', () => {
  it('is 0 in daylight, 0.5 at the horizon, 1 at deep dusk', () => {
    expect(darkness(10)).toBe(0)
    expect(darkness(0)).toBeCloseTo(0.5, 5)
    expect(darkness(-10)).toBe(1)
  })

  it('never rises as the sun drops', () => {
    let prev = Infinity
    for (let e = -20; e <= 20; e += 0.5) {
      const d = darkness(e)
      expect(d).toBeLessThanOrEqual(prev)
      prev = d
    }
  })
})

describe('useOfWall', () => {
  it('maps each wall kind to its use', () => {
    const cases: [WallKind, LightUse][] = [
      ['residential', 'home'],
      ['apartment', 'home'],
      ['glass', 'office'],
      ['shopfront', 'shop'],
      ['blank', 'none'],
    ]
    for (const [kind, use] of cases) expect(useOfWall(kind)).toBe(use)
  })
})

describe('litShare', () => {
  it('matches the listed keyframe values', () => {
    const cases: [LightUse, number, number][] = [
      ['home', 20, 0.7],
      ['home', 5, 0.15],
      ['home', 1, 0.2],
      ['home', 12, 0.1],
      ['office', 12, 0.6],
      ['office', 23, 0.1],
      ['shop', 3, 0.05],
      ['shop', 15, 0.9],
      ['none', 20, 0],
    ]
    for (const [use, hour, value] of cases) expect(litShare(use, hour)).toBeCloseTo(value, 2)
  })

  it('wraps at 24 h', () => {
    for (const u of USES) expect(litShare(u, 24)).toBeCloseTo(litShare(u, 0), 9)
  })

  it('is continuous across midnight', () => {
    for (const u of USES) expect(Math.abs(litShare(u, 23.9) - litShare(u, 0.1))).toBeLessThan(0.05)
  })

  it('stays within [0, 1]', () => {
    for (const u of USES) for (let h = 0; h <= 24; h += 0.25) {
      const v = litShare(u, h)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
