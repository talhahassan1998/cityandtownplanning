import { describe, expect, it } from 'vitest'
import { componentDef, defaultAttrs, styleOf } from './model'

describe('building style', () => {
  it('resolves building style: feature beats project beats western', () => {
    expect(styleOf({}, {})).toBe('western')
    expect(styleOf({}, undefined)).toBe('western')
    expect(styleOf({}, { buildingStyle: 'gulf' })).toBe('gulf')
    expect(styleOf({ style: 'western' }, { buildingStyle: 'gulf' })).toBe('western')
    expect(styleOf({ style: '' }, { buildingStyle: 'gulf' })).toBe('gulf') // "Project default" in the inspector
    expect(styleOf({ style: 'bogus' }, { buildingStyle: 'gulf' })).toBe('gulf') // unknown values ignored
  })

  it('leaves roof unset on new buildings so the style decides', () => {
    expect(defaultAttrs(componentDef('house')).roof).toBeUndefined()
    expect(defaultAttrs(componentDef('house')).floors).toBe(2)
  })
})
