import { FLOOR_HEIGHT } from '../../model'
import { acUnits, arcade, awning, B, balconies, canopy, Cy, dome, door, gableRoof, palm, parapet, portico, rooftopTanks, shopfront, type Part } from '../kit'
import type { OBox } from '../models'
import type { RecipeCtx, RecipeFn } from './index'

const seedOf = (c: RecipeCtx) => Math.floor(c.rnd() * 1e6)
/** Shop units along the front, ~8 m each (≤ 12). */
const units = (ob: OBox) => {
  const n = Math.max(1, Math.min(12, Math.round((2 * ob.hx) / 8))), u = (2 * ob.hx) / n
  return { u, xs: Array.from({ length: n }, (_, i) => -ob.hx + (i + 0.5) * u) }
}
const shops = (c: RecipeCtx): Part[] => {
  const { u, xs } = units(c.ob)
  return xs.flatMap((x) => [...shopfront(c.ob, x, u * 0.85, c.style), ...(c.style === 'western' ? awning(c.ob, x, u * 0.8, FLOOR_HEIGHT - 1, 'western') : [])])
}
/** Rooftop solar panels in an even grid over the roof (≤ 6 × 5). */
const solar = (ob: OBox, top: number): Part[] => {
  const nx = Math.max(1, Math.min(6, Math.floor((2 * ob.hx - 4) / 4))), nz = Math.max(1, Math.min(5, Math.floor((2 * ob.hy - 4) / 3)))
  const out: Part[] = []
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const p = B('glass', 3, 0.1, 1.6)
    p.geo.rotateX(-0.4).translate(-ob.hx + 2 + ((i + 0.5) * (2 * ob.hx - 4)) / nx, top + 0.6, -ob.hy + 2 + ((j + 0.5) * (2 * ob.hy - 4)) / nz)
    out.push(p)
  }
  return out
}

const office = (c: RecipeCtx, solarRoof: boolean) => {
  const { ob, top } = c, L = ob.hx, W = ob.hy
  const roof = solarRoof ? solar(ob, top) : acUnits(ob, top, 6, seedOf(c))
  if (c.style === 'western') return {
    wall: 'glass' as const, roof: 'flat' as const,
    parts: [B('metal', Math.min(L, 6), 2.5, Math.min(W, 4), 0, top), Cy('metal', 0.12, 6, L * 0.4, top, 0, 6), ...canopy(0, W + 1.5, 8, 3, 4), door(ob, 0, 4, 3, 'glass')],
    details: roof,
  }
  return {
    wall: 'glass' as const, roof: 'flat' as const,
    parts: [...parapet(ob, top, 1), ...portico(ob, 2 * FLOOR_HEIGHT, 6, 'gulf'), door(ob, 0, 4, 3, 'metal')],
    details: roof,
  }
}

export const commercial: Record<string, RecipeFn> = {
  shop: (c) => ({
    wall: 'residential', ground: 'shopfront', roof: 'flat',
    parts: [...parapet(c.ob, c.top, c.style === 'gulf' ? 1 : 0.8), ...shops(c), ...(c.style === 'gulf' ? units(c.ob).xs.flatMap((x) => awning(c.ob, x, units(c.ob).u * 0.9, FLOOR_HEIGHT - 0.2, 'gulf')) : [])],
    details: acUnits(c.ob, c.top, c.style === 'gulf' ? 2 : 1, seedOf(c)),
  }),

  market: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    const n = Math.max(1, Math.min(10, Math.floor((2 * L) / 5)))
    const stalls = Array.from({ length: n }, (_, i) => -L + ((i + 0.5) * 2 * L) / n).flatMap((x) => canopy(x, -W - 1.5, 3, 2.4, 2.4, 'awning'))
    return {
      wall: 'blank', roof: 'none',
      parts: [...arcade(ob, Math.max(3.2, top - 0.4), c.style), ...(c.style === 'western' ? gableRoof(ob, top, 0.5, 0.4, 'glass') : parapet(ob, top, 1))],
      details: stalls,
    }
  },

  mall: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy, ew = Math.min(2 * L * 0.4, 24)
    if (c.style === 'western') return {
      wall: 'blank', roof: 'flat',
      parts: [...parapet(ob, top, 1.2), B('glass', ew, top + 2, 2.5, 0, 0, W + 1.25), B('trim', ew + 1, 1, 2.8, 0, top + 2, W + 1.4)],
      details: [...acUnits(ob, top, 10, seedOf(c)), B('metal', Math.min(L, 12), 3, Math.min(W, 8), 0, top)],
    }
    return {
      wall: 'blank', roof: 'flat',
      parts: [...parapet(ob, top, 1.5), ...arcade(ob, FLOOR_HEIGHT * 1.5, 'gulf'), B('trim', ew, top + 1, 3, 0, 0, W - 1.5), ...dome(0, W - 6, Math.min(6, W * 0.4), top + 1)],
      details: acUnits(ob, top, 10, seedOf(c)),
    }
  },

  office: (c) => office(c, false),
  'tech-park': (c) => office(c, true),

  hotel: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    if (c.style === 'western') return {
      wall: 'apartment', roof: 'flat',
      parts: [...parapet(ob, top, 0.8), ...canopy(0, W + 1.5, 10, 3, 4.2, 'awning'), B('sign', Math.min(L, 12), 2.5, 0.3, 0, top, W - 0.5), door(ob, 0, 3, 3, 'glass')],
      details: balconies(ob, c.floors, 'western', 1),
    }
    return {
      wall: 'apartment', roof: 'flat',
      parts: [...parapet(ob, top, 1.2), ...canopy(0, W + 1.5, 12, 3, 5, 'trim'), door(ob, 0, 3, 3, 'metal')],
      details: [...palm(-L * 0.6, W + 1.2, 7), ...palm(L * 0.6, W + 1.2, 7), ...acUnits(ob, top, 6, seedOf(c))],
    }
  },

  'mixed-use': (c) => {
    const { ob, top } = c
    if (c.style === 'western') return {
      wall: 'apartment', ground: 'shopfront', roof: 'flat',
      parts: [...parapet(ob, top, 0.8), ...shops(c)],
      details: balconies(ob, c.floors, 'western', 2),
    }
    return {
      wall: 'apartment', ground: 'shopfront', roof: 'flat',
      parts: [...parapet(ob, top, 1.2), ...arcade(ob, FLOOR_HEIGHT, 'gulf'), ...shops(c)],
      details: [...balconies(ob, c.floors, 'gulf', 2), ...rooftopTanks(ob, top, 4, seedOf(c))],
    }
  },
}
