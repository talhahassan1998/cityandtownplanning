import { FLOOR_HEIGHT } from '../../model'
import { acUnits, arcade, B, balconies, boundaryWall, canopy, chimney, Cy, door, hedge, palm, parapet, porch, rooftopTanks, type Part } from '../kit'
import type { RecipeCtx, RecipeFn } from './index'

const seedOf = (c: RecipeCtx) => Math.floor(c.rnd() * 1e6)
/** Is the final roof pitched, given the recipe's default? */
const pitched = (c: RecipeCtx, def: 'flat' | 'gable' | 'hip') => (c.roof ?? def) !== 'flat'

export const residential: Record<string, RecipeFn> = {
  house: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, dx = (c.rnd() - 0.5) * L * 0.8
    if (c.style === 'western') {
      const parts: Part[] = [door(ob, dx, 1.1, 2.2), ...porch(ob, dx, 3, 2)]
      if (pitched(c, 'gable')) parts.push(chimney(L * 0.5, -W * 0.3, top, 0.42 * W + 1.7))
      else parts.push(...parapet(ob, top, 0.6))
      return { wall: 'residential', roof: 'gable', parts, details: hedge(ob, 2.5) }
    }
    return {
      wall: 'residential', roof: 'flat',
      parts: [...parapet(ob, top, 1), B('trim', 3, 2.6, 3, L * 0.5, top, -W * 0.4), door(ob, dx, 1.2, 2.4, 'metal')],
      details: [...boundaryWall(ob, 2.5, 2.2, dx, 'gulf'), ...acUnits(ob, top, 2, seedOf(c))],
    }
  },

  villa: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    if (c.style === 'western') {
      const parts: Part[] = [B('trim', 5, Math.min(top + 1, 2 * FLOOR_HEIGHT + 1), 1.6, -L * 0.2, 0, W + 0.8), door(ob, -L * 0.2, 1.4, 2.4, 'wood'), door(ob, L * 0.55, 3, 2.4, 'wood')]
      if (pitched(c, 'hip')) parts.push(chimney(-L * 0.6, -W * 0.4, top, 0.25 * W + 1.7))
      return { wall: 'residential', roof: 'hip', parts, details: hedge(ob, 3) }
    }
    return {
      wall: 'residential', roof: 'flat',
      parts: [...parapet(ob, top, 1.2), ...arcade(ob, FLOOR_HEIGHT, 'gulf'), door(ob, 0, 1.6, 2.6, 'dark')],
      details: [...boundaryWall(ob, 3, 2.6, 0, 'gulf'), ...palm(-L * 0.7, W + 1.2, 6), ...palm(L * 0.7, W + 1.2, 7)],
    }
  },

  townhouse: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, n = Math.max(2, Math.round((2 * L) / 6)), u = (2 * L) / n
    const xs = Array.from({ length: n }, (_, i) => -L + (i + 0.5) * u)
    const pilasters = xs.slice(1).map((x) => B('trim', 0.3, top, 0.2, x - u / 2, 0, W + 0.1))
    if (c.style === 'western') {
      const parts: Part[] = [...pilasters, ...xs.flatMap((x) => [door(ob, x - u * 0.2, 1, 2.2), B('trim', 1.6, 0.3, 0.8, x - u * 0.2, 0, W + 0.4)])]
      if (pitched(c, 'gable')) parts.push(...xs.map((x) => chimney(x + u * 0.3, 0, top, 0.6 * W + 1.2)))
      return { wall: 'residential', roof: 'gable', parts, details: xs.map((x) => B('green', u * 0.5, 0.8, 0.5, x + u * 0.15, 0, W + 1.5)) }
    }
    return {
      wall: 'residential', roof: 'flat',
      parts: [...pilasters, ...parapet(ob, top, 0.8), ...xs.flatMap((x, i) => [B('trim', u, i % 2 ? 1.6 : 1.1, 0.3, x, top, W - 0.15), door(ob, x, 1.2, 2.4, 'wood')])],
      details: xs.map((x) => B('metal', 0.9, 0.7, 0.6, x, top, -W * 0.5)),
    }
  },

  apartment: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    if (c.style === 'western') return {
      wall: 'apartment', roof: 'flat',
      parts: [...parapet(ob, top, 0.8), B('trim', 2 * L + 0.4, 0.8, 2 * W + 0.4), B('trim', 4, 2.6, 4, -L * 0.5, top, 0), ...canopy(0, W + 1, 4, 2, 3), door(ob, 0, 2, 2.6, 'glass')],
      details: balconies(ob, c.floors, 'western', 1),
    }
    return {
      wall: 'apartment', roof: 'flat',
      parts: [...parapet(ob, top, 1.2), B('trim', 4, 3, 4, -L * 0.5, top, 0), door(ob, 0, 2, 2.6, 'metal')],
      details: [...balconies(ob, c.floors, 'gulf', 2), ...rooftopTanks(ob, top, Math.max(2, Math.min(12, Math.round(L / 6))), seedOf(c)), ...acUnits(ob, top, 4, seedOf(c))],
    }
  },

  tower: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    if (c.style === 'western') return {
      wall: 'glass', roof: 'flat',
      parts: [B('dark', 2 * L + 2, 2 * FLOOR_HEIGHT, 2 * W + 2), B('metal', 2 * L * 0.8, 3, 2 * W * 0.8, 0, top), Cy('metal', 0.15, 8, 0, top + 3, 0, 6), door(ob, 0, 3, 3, 'glass')],
      details: acUnits(ob, top, 4, seedOf(c)),
    }
    return {
      wall: 'glass', roof: 'flat',
      parts: [B('trim', 2 * L + 1, 3 * FLOOR_HEIGHT, 2 * W + 1), B('trim', L, 5, W, 0, top), Cy('accent', 0.6, 10, 0, top + 5, 0, 8, 0.05), door(ob, 0, 3, 3, 'metal')],
      details: acUnits(ob, top, 4, seedOf(c)),
    }
  },
}
