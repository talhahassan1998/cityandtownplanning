import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { FLOOR_HEIGHT, type BuildingStyle } from '../model'
import { BAY, NIGHT, facadeBump, facadeGlow, facadeTexture, setFacadeNight, wallMaterial, withNight, type WallKind } from './facades'

describe('façade textures', () => {
  it('caches one texture per style × kind, tiled per bay and storey', () => {
    const t = facadeTexture('western', 'apartment')
    expect(facadeTexture('western', 'apartment')).toBe(t)
    expect(t.image.width).toBe(32)
    expect(t.repeat.x).toBeCloseTo(1 / BAY, 6)
    expect(t.repeat.y).toBeCloseTo(1 / FLOOR_HEIGHT, 6)
  })

  it('draws different pixels per style and per kind', () => {
    const px = (s: BuildingStyle, k: WallKind) => Array.from(facadeTexture(s, k).image.data as Uint8Array).join()
    expect(px('western', 'residential')).not.toBe(px('gulf', 'residential'))
    expect(px('gulf', 'residential')).not.toBe(px('gulf', 'shopfront'))
    for (const k of ['residential', 'apartment', 'shopfront', 'glass', 'blank'] as const) expect(px('western', k)).not.toBe(px('gulf', k))
  })

  it('shares materials per style, kind and colour, with a bump map', () => {
    expect(wallMaterial('gulf', 'glass', '#cccccc')).toBe(wallMaterial('gulf', 'glass', '#cccccc'))
    expect(wallMaterial('gulf', 'glass', '#cccccc')).not.toBe(wallMaterial('gulf', 'glass', '#dddddd'))
    expect(wallMaterial('gulf', 'glass', '#cccccc').bumpMap).toBe(facadeBump('gulf', 'glass'))
    expect(wallMaterial('gulf', 'glass', '#cccccc').map).toBe(facadeTexture('gulf', 'glass'))
  })

  it('masks glass pixels for night glow', () => {
    const g = facadeGlow('western', 'apartment').image.data as Uint8Array
    const at = (x: number, y: number) => g[(y * 32 + x) * 4]
    expect(at(8, 12)).toBe(255) // glass
    expect(at(1, 1)).toBe(0) // wall
    expect(at(15, 12)).toBe(0) // mullion over the glass
    expect(facadeGlow('western', 'apartment')).toBe(facadeGlow('western', 'apartment'))
  })

  it('patches lit walls with the per-use night uniforms', () => {
    const home = wallMaterial('western', 'residential', '#eeeeee'), office = wallMaterial('western', 'glass', '#eeeeee')
    expect(home.userData.night).toBe(NIGHT.home)
    expect(wallMaterial('gulf', 'apartment', '#eeeeee').userData.night).toBe(NIGHT.home)
    expect(office.userData.night).toBe(NIGHT.office)
    expect(home.emissiveMap).toBe(facadeGlow('western', 'residential'))
    expect(home.emissive.getHex()).toBe(0) // daytime look and selection highlight unchanged
    expect(home.customProgramCacheKey()).not.toBe(office.customProgramCacheKey())
    const blank = wallMaterial('western', 'blank', '#eeeeee')
    expect(blank.emissiveMap).toBeNull()
    expect(blank.userData.night).toBeUndefined()
    expect(home.userData.shared).toBe(true)
  })

  it('injects the uniforms and replaces the shader chunks', () => {
    const m = wallMaterial('western', 'apartment', '#eeeeee')
    const sh = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader }
    m.onBeforeCompile(sh as any, null as any)
    expect(sh.uniforms.uDark).toBe(NIGHT.home.uDark)
    expect(sh.uniforms.uLit).toBe(NIGHT.home.uLit)
    expect(sh.fragmentShader).not.toContain('#include <emissivemap_fragment>')
    expect(sh.fragmentShader).toContain('uniform float uDark')
    expect(sh.fragmentShader).toContain('vNightPos')
    expect(sh.vertexShader).toContain('vNightPos =')
    expect(sh.vertexShader).toContain('#include <worldpos_vertex>')
  })

  it('keeps the patch on clones and sets the uniforms by darkness and hour', () => {
    const m = wallMaterial('western', 'glass', '#eeeeee')
    const c = withNight(m.clone(), m)
    expect(c.onBeforeCompile).toBe(m.onBeforeCompile)
    expect(c.customProgramCacheKey()).toBe(m.customProgramCacheKey())
    expect(c.userData.night).toBe(NIGHT.office)
    setFacadeNight(1, 20)
    expect(NIGHT.home.uDark.value).toBe(1)
    expect(NIGHT.home.uLit.value).toBeCloseTo(0.7, 6)
    setFacadeNight(0, 12)
    expect(NIGHT.office.uDark.value).toBe(0)
  })
})
