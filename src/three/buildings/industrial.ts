import { B, boundaryWall, Cy, door, metalRoof, sawtooth, type Part } from '../kit'
import type { OBox } from '../models'
import type { RecipeCtx, RecipeFn } from './index'

const pitchedOverride = (c: RecipeCtx) => !!c.roof && c.roof !== 'flat'
/** Roll-up loading doors along the front (≤ 20). */
const docks = (ob: OBox, spacing: number): Part[] => {
  const n = Math.max(2, Math.min(20, Math.floor((2 * ob.hx) / spacing)))
  return Array.from({ length: n }, (_, i) => -ob.hx + ((i + 0.5) * 2 * ob.hx) / n).flatMap((x) => [door(ob, x, 4, 4.5, 'metal'), B('dark', 4.4, 1.2, 1.5, x, 0, ob.hy + 0.75)])
}
/** Fenced utility building (substations, pumping, treatment, exchanges, waste). */
const utility = (mast: boolean): RecipeFn => (c) => ({
  wall: 'blank', roof: 'flat',
  parts: [B('trim', 2 * c.ob.hx, 0.5, 2 * c.ob.hy, 0, c.top), door(c.ob, 0, 2, 2.6, 'metal'), ...(mast ? [Cy('metal', 0.3, 18, c.ob.hx * 0.5, c.top, 0, 6, 0.1)] : [])],
  details: boundaryWall(c.ob, 3, 2.2, 0, c.style),
})

export const industrial: Record<string, RecipeFn> = {
  factory: (c) => {
    const { ob, top } = c, L = ob.hx, W = ob.hy
    const roof = pitchedOverride(c) ? [] : c.style === 'western' ? sawtooth(ob, top) : metalRoof(ob, top)
    return {
      wall: 'blank', roof: 'none',
      parts: [...roof, door(ob, -L * 0.5, 5, 5, 'metal'), Cy('metal', 1.2, top + 10, L * 0.6, 0, -W * 0.4, 12, 0.9), Cy('metal', 1.2, top + 6, L * 0.3, 0, -W * 0.4, 12, 0.9)],
      details: docks(ob, 12).slice(0, 8),
    }
  },
  warehouse: (c) => ({
    wall: 'blank', roof: 'none',
    parts: [...(pitchedOverride(c) ? [] : metalRoof(c.ob, c.top)), ...docks(c.ob, 8)],
    details: [],
  }),
  substation: utility(false),
  treatment: utility(false),
  'pump-station': utility(false),
  waste: utility(false),
  'telecom-exchange': utility(true),
}
