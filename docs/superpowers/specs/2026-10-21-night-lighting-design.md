# Night lighting

## Goal
At dusk the 3D city lights up: windows glow in a realistic pattern by building use, street lamps cast soft pools on the road, moving cars show headlights and tail-lights. Visual realism for presentations (piece 3 of the "real-life animation" request; builds on the running clock from pieces 1+2). Cheap fakes only — no real three.js lights (thousands would stall an Intel UHD 620).

## User decisions
- In scope: lit windows, street-lamp pools, car head/tail lights. Bloom/glow halo: out.
- Windows depend on building use (homes / offices / shops).

## `src/three/night.ts` (new, pure)
- `darkness(sunElevation: number): number` — 0 at elevation ≥ 6°, 1 at ≤ −6°, smoothstep between.
- `type LightUse = 'home' | 'office' | 'shop' | 'none'`; `useOfWall(kind: WallKind): LightUse` — residential/apartment → home, glass → office, shopfront → shop, blank → none. (`ponytail:` wall kind stands in for building use; recipes choose the wall per type.)
- `litShare(use: LightUse, solarHour: number): number` in [0, 1], piecewise-linear, wraps at 24:
  - home: 0.15 at 05:00, 0.10 at 08:00–16:00, 0.70 at 18:00–22:00, 0.20 at 01:00.
  - office: 0.60 at 07:00–19:00, 0.10 from 20:00 to 06:00 (ramps 1 h).
  - shop: 0.90 at 08:00–22:00, 0.05 from 23:00 to 07:00 (ramps 1 h).
  - none: 0.
- Visible glow = `darkness × lit`; daytime windows never glow.

## Windows — `src/three/facades.ts`
- `paint` also produces an emissive mask: 255 on glass pixels (the `RECESS`-height glass rects), 0 elsewhere → `facadeGlow(style, kind)` DataTexture, cached with the pair.
- `wallMaterial` materials (shared, cached) get `emissiveMap = glow`, `emissive` warm `#ffd9a0` (home/shop) or cool `#dfe9ff` (office), and an `onBeforeCompile` patch:
  - uniforms shared by all façade materials of one `LightUse`: `uDark` (0–1), `uLit` (0–1) — one uniform object per use, so updating 3 objects updates every building.
  - per-window cell = floor(worldPos / vec3(BAY, FLOOR_HEIGHT, BAY)); `h = hash(cell)`; window glows iff `h < uLit`; emissive × mask × uDark × (0.8 + 0.4·hash2) for slight brightness variation.
  - `customProgramCacheKey` set so the patched program is cached once.
- Selection highlight clones (scene.ts `litOf`) keep `onBeforeCompile` and the uniforms (clone copies them) — the selected building still shows its night windows.

## Street lamps — `src/three/scene.ts`
- Lamp heads: their material's `emissiveIntensity` = 0.6 + 2.4·darkness (one per-scene material, so mutating it is fine).
- Pools: one `InstancedMesh` of a 12 m disc (radial-gradient alpha texture generated from pixels, no canvas), `AdditiveBlending`, `depthWrite: false`, warm `#ffcf8a`, laid flat 0.2 m above the ground at each lamp's position (same `lightSpots`, same `MAX_LIGHTS` cap), `polygonOffset` so it draws over road surfaces; opacity = 0.55·darkness; `visible` false when darkness = 0. Not pickable, no shadows.
- Only when `streetLights` is on (existing checkbox).

## Cars — `src/three/cars.ts`
- `carFleet` uses its own cached copies of the `light` and `tail` slot materials (`fleetLight`, `fleetTail`, shared across scenes, `userData.shared`); parked cars keep the dim originals.
- Fleet adds a `beam` slot: a flat 3 × 8 m quad 0.05 m above the road, 1–9 m ahead of the nose, gradient alpha, additive, warm white, one InstancedMesh per kind sharing the car matrices.
- `setFleetDarkness(d)`: headlight emissiveIntensity 0.3 + 2.7·d, tail 0.3 + 1.7·d, beam opacity 0.35·d (beam hidden at d = 0).

## Wiring
- `BuiltScene.setNight(darkness: number, solarHour: number): void` — sets the 3 façade use uniforms (`uDark`, `uLit = litShare(use, hour)`), lamp head intensity + pool opacity, `setFleetDarkness`. No rebuild.
- CityView: `placeSun` computes `darkness(elevation)` and calls `built.setNight(...)`; also called once after each rebuild.
- Façade uniforms are module-wide per use, so the map's 3D layer (`modelsOnly`) and thumbnails share them. They start at `uDark = 0`, and CityView resets them with `setNight(0, 12)` when it unmounts, so the 2D map and library thumbnails always render in daylight (`ponytail:` note — per-view uniforms are the upgrade if both views are ever shown at once).

## Performance
One extra texture fetch + hash per façade fragment; +1 draw call (pools), +5 (beams, one per kind with cars). Acceptance: ≤ 5% fps drop night vs no-night on the browser-check scene, with Chrome in front.

## Testing
- `night.test.ts`: darkness at 10°, 0°, −10° = 0, 0.5, 1; litShare table values at the listed hours for each use; wraps at 24; always within [0, 1].
- `facades.test.ts`: glow mask non-zero only on glass pixels; two buildings with the same style/kind/colour share one material; materials of one use share one uniforms object; `customProgramCacheKey` defined.
- `three.test.ts`: pools exist only with street lights on; `setNight(1, 20)` raises lamp head intensity and pool opacity, sets façade `uDark = 1`; `setNight(0, 12)` hides pools; no rebuild needed (same group object).
- `cars.test.ts`: fleet light/tail materials differ from parked-car ones; `setFleetDarkness(1)` raises fleet intensity, parked unchanged; beam meshes follow the car count.
- Browser: ×600 from 17:00 to 02:00 — windows come on at dusk and thin out after midnight, offices dim after 20:00, lamp pools on roads, car beams; screenshots + fps on/off.
