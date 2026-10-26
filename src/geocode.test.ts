import { describe, expect, it } from 'vitest'
import { parseLatLng } from './geocode'

describe('parseLatLng', () => {
  it('reads lat,lng pairs', () => {
    expect(parseLatLng('24.8607, 67.0011')).toMatchObject({ lat: 24.8607, lng: 67.0011 })
    expect(parseLatLng(' -33.9 18.4 ')).toMatchObject({ lat: -33.9, lng: 18.4 })
  })
  it('rejects place names and out-of-range values', () => {
    expect(parseLatLng('Karachi')).toBeNull()
    expect(parseLatLng('95, 10')).toBeNull()
    expect(parseLatLng('10, 200')).toBeNull()
  })
})
