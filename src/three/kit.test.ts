import { describe, expect, it } from 'vitest'
import { arcade, balconies, boundaryWall, gableRoof, hipRoof, parapet, partsBounds, porch, portico, rooftopTanks, tower, type Part } from './kit'

const OB = { cx: 0, cy: 0, hx: 10, hy: 6, angle: 0 }

describe('building kit', () => {
  it('every part stays within the box expanded by 3 m and above ground', () => {
    const sets: Part[][] = [parapet(OB, 6, 1), gableRoof(OB, 6, 0.5, 0.6), hipRoof(OB, 6, 0.5, 0.6), balconies(OB, 4, 'gulf', 2), boundaryWall(OB, 3, 2, 0, 'western'), arcade(OB, 4, 'gulf'), portico(OB, 6, 6, 'western'), porch(OB, 0, 3, 2), rooftopTanks(OB, 6, 4, 1)]
    for (const parts of sets) {
      expect(parts.length).toBeGreaterThan(0)
      const b = partsBounds(parts)
      expect(b.min.x).toBeGreaterThanOrEqual(-13); expect(b.max.x).toBeLessThanOrEqual(13)
      expect(b.min.z).toBeGreaterThanOrEqual(-9); expect(b.max.z).toBeLessThanOrEqual(9)
      expect(b.min.y).toBeGreaterThanOrEqual(-1e-6) // float32 noise
    }
  })

  it('gable roof sits on the eaves and rises by pitch × half-width', () => {
    const b = partsBounds(gableRoof(OB, 6, 0.5, 0.6))
    expect(b.min.y).toBeCloseTo(6, 3)
    expect(b.max.y).toBeCloseTo(6 + 0.6 * 6, 1)
  })

  it('caps repeated parts', () => {
    const big = { cx: 0, cy: 0, hx: 200, hy: 20, angle: 0 }
    expect(balconies(big, 60, 'western', 1).length).toBeLessThanOrEqual(200)
    expect(balconies(big, 60, 'western', 1).length).toBeGreaterThan(100) // thinned, not dropped
    expect(arcade(big, 4, 'gulf').length).toBeLessThanOrEqual(40 * 3)
  })

  it('styles differ', () => {
    expect(arcade(OB, 4, 'gulf').length).not.toBe(arcade(OB, 4, 'western').length)
    expect(partsBounds(tower(0, 0, 2, 20, 'gulf')).max.y).toBeGreaterThan(20) // minaret cap above the shaft
  })

  it('pitched roofs on big footprints rise at most 5 m', () => {
    const big = { cx: 0, cy: 0, hx: 30, hy: 20, angle: 0 }
    expect(partsBounds(gableRoof(big, 6, 0.5, 0.6)).max.y).toBeCloseTo(11, 3)
    expect(partsBounds(hipRoof(big, 6, 0.5, 0.6)).max.y).toBeCloseTo(11, 3)
  })
})
