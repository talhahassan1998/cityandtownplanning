import { FLOOR_HEIGHT } from '../../model'
import { acUnits, arcade, B, boundaryWall, canopy, Cy, dome, door, flag, parapet, portico, tower, type Part } from '../kit'
import type { RecipeCtx, RecipeFn } from './index'

const seedOf = (c: RecipeCtx) => Math.floor(c.rnd() * 1e6)
const flatTop = (c: RecipeCtx, h = 1): Part[] => (c.roof && c.roof !== 'flat' ? [] : parapet(c.ob, c.top, h))
/** Red cross of size s lying on the roof (y) or standing on the front face. */
const cross = (s: number, x: number, y: number, z: number, upright = false): Part[] =>
  upright ? [B('red', s, s / 4, 0.15, x, y + s * 0.375, z), B('red', s / 4, s, 0.15, x, y, z)] : [B('red', s, 0.3, s / 4, x, y, z), B('red', s / 4, 0.3, s, x, y, z)]

const school = (c: RecipeCtx, big: boolean) => {
  const { ob, top } = c, L = ob.hx, W = ob.hy
  if (c.style === 'western') return {
    wall: 'residential' as const, roof: 'hip' as const,
    parts: [door(ob, 0, 3, 2.6), ...(big ? portico(ob, 2 * FLOOR_HEIGHT, 8, 'western') : []), ...flag(-L + 1, W + 1)],
    details: boundaryWall(ob, 3, 1.2, 0, 'western'),
  }
  return {
    wall: 'residential' as const, roof: 'flat' as const,
    parts: [...flatTop(c), ...arcade(ob, FLOOR_HEIGHT, 'gulf'), ...flag(-L + 1, W + 1), ...(big ? dome(0, 0, Math.min(L, W) * 0.3, top) : [])],
    details: boundaryWall(ob, 3, 2.4, 0, 'gulf'),
  }
}

export const civic: Record<string, RecipeFn> = {
  school: (c) => school(c, false),
  university: (c) => school(c, true),

  hospital: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, s = Math.min(L, W) * 0.5, r = Math.min(L, W) * 0.3
    return {
      wall: 'apartment', roof: 'flat',
      parts: [...flatTop(c), ...cross(s, -L * 0.45, top, 0), Cy('dark', r, 0.1, L * 0.45, top, 0, 24), B('trim', r * 0.15, 0.12, r, L * 0.45 - r * 0.3, top, 0), B('trim', r * 0.15, 0.12, r, L * 0.45 + r * 0.3, top, 0), B('trim', r * 0.6, 0.12, r * 0.15, L * 0.45, top, 0),
        ...canopy(L * 0.5, W + 1.5, 8, 3, 3.6, c.style === 'gulf' ? 'trim' : 'metal'), door(ob, L * 0.5, 3, 2.6, 'glass')],
      details: acUnits(ob, top, 6, seedOf(c)),
    }
  },

  clinic: (c) => {
    const { ob } = c
    return {
      wall: 'residential', roof: c.style === 'western' ? 'gable' : 'flat',
      parts: [...(c.style === 'gulf' ? flatTop(c) : []), ...cross(1.6, -ob.hx * 0.4, Math.min(c.top - 2, 3), ob.hy + 0.1, true), door(ob, 0, 2.4, 2.6, 'glass')],
      details: acUnits(ob, c.top, 2, seedOf(c)),
    }
  },

  police: (c) => {
    const { ob, top } = c
    return {
      wall: 'residential', roof: 'flat',
      parts: [...flatTop(c, c.style === 'gulf' ? 1.2 : 0.8), B('light', 1.5, 0.6, 0.6, 0, top), B('sign', 4, 0.8, 0.15, 0, FLOOR_HEIGHT - 0.9, ob.hy + 0.08), door(ob, 0, 2, 2.6, 'dark')],
      details: acUnits(ob, top, 2, seedOf(c)),
    }
  },

  fire: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, dw = Math.min(4, L * 0.5)
    return {
      wall: 'residential', roof: 'flat',
      parts: [...flatTop(c), ...[-L * 0.45, 0, L * 0.45].map((x) => door(ob, x, dw, 4, 'red')), B('trim', 3, top + 6, 3, L - 1.5, 0, -W + 1.5)],
      details: acUnits(ob, top, 2, seedOf(c)),
    }
  },

  government: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, h = Math.min(top, 8)
    return c.style === 'western'
      ? { wall: 'residential', roof: 'flat', parts: [...flatTop(c, 1.2), ...portico(ob, h, Math.max(4, Math.round(L / 3)), 'western')], details: [] }
      : { wall: 'residential', roof: 'flat', parts: [...flatTop(c, 1.2), ...portico(ob, h, Math.max(4, Math.round(L / 3)), 'gulf'), ...dome(0, 0, Math.min(L, W) * 0.35, top)], details: acUnits(ob, top, 4, seedOf(c)) }
  },

  community: (c) => {
    const { ob, top } = c, W = ob.hy
    return c.style === 'western'
      ? { wall: 'residential', roof: 'gable', parts: [B('glass', 6, 3, 1.5, 0, 0, W + 0.75), B('trim', 6.6, 0.3, 1.8, 0, 3, W + 0.9)], details: [] }
      : { wall: 'residential', roof: 'flat', parts: [...flatTop(c), ...arcade(ob, FLOOR_HEIGHT, 'gulf')], details: acUnits(ob, top, 2, seedOf(c)) }
  },

  library: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, h = Math.min(top, 7)
    return c.style === 'western'
      ? { wall: 'residential', roof: 'flat', parts: [...flatTop(c), ...portico(ob, h, 4, 'western')], details: [] }
      : { wall: 'residential', roof: 'flat', parts: [...flatTop(c), ...portico(ob, h, 4, 'gulf'), ...tower(L - 2, -W + 2, 1.5, top + 6, 'gulf')], details: acUnits(ob, top, 2, seedOf(c)) }
  },

  religious: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    return c.style === 'western'
      ? { wall: 'residential', roof: 'gable', parts: [...tower(-L + 2.2, W - 2.2, 2, top + 10, 'western'), door(ob, 0, 2.4, 3.6, 'wood')], details: [] }
      : { wall: 'residential', roof: 'flat', parts: [...flatTop(c), ...dome(0, 0, Math.min(L, W) * 0.45, top), ...tower(L - 2, W - 2, 1.4, top + 14, 'gulf'), door(ob, 0, 2.4, 3.2, 'wood')], details: boundaryWall(ob, 3, 2.4, 0, 'gulf') }
  },

  station: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    return c.style === 'western'
      ? { wall: 'apartment', roof: 'flat', parts: [...flatTop(c, 0.8), B('metal', 2 * L, 0.4, 3, 0, 4.5, W + 1.5), ...[-0.8, 0, 0.8].map((k) => Cy('metal', 0.15, 4.5, k * L, 0, W + 2.7, 6)), B('trim', 1.6, 1.6, 0.2, 0, top - 2, W + 0.1), door(ob, 0, 4, 3, 'glass')], details: [] }
      : { wall: 'apartment', roof: 'flat', parts: [...flatTop(c, 1.2), ...arcade(ob, 4.5, 'gulf'), door(ob, 0, 4, 3, 'glass')], details: acUnits(ob, top, 4, seedOf(c)) }
  },
}
