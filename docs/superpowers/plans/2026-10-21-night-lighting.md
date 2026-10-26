# Night Lighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At dusk the 3D view lights up — windows by building use, street-lamp pools, moving-car head/tail lights and beams — driven live by the running clock.

**Architecture:** Pure curves in `three/night.ts`; façade materials get an emissive glass mask + an `onBeforeCompile` per-window hash driven by module-wide uniforms per use; lamps get an additive instanced pool mesh; the car fleet gets its own light materials + a beam slot. `BuiltScene.setNight(darkness, hour)` updates everything without a rebuild; CityView calls it from `placeSun`.

**Tech Stack:** TypeScript, Three.js 0.186 (MeshStandardMaterial `onBeforeCompile`, InstancedMesh, DataTexture), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-night-lighting-design.md`

## Global Constraints
- No real three.js lights added. No canvas (textures from pixel arrays so they build in Node tests).
- `darkness`: 0 at sun elevation ≥ 6°, 1 at ≤ −6°, smoothstep between.
- litShare (wraps at 24, piecewise-linear): home 0.15@05:00, 0.10@08:00–16:00, 0.70@18:00–22:00, 0.20@01:00; office 0.60@07:00–19:00, 0.10 20:00–06:00 (1 h ramps); shop 0.90@08:00–22:00, 0.05 23:00–07:00 (1 h ramps); none 0.
- Wall kind → use: residential/apartment → home, glass → office, shopfront → shop, blank → none.
- Colours: home/shop glow `#ffd9a0`, office `#dfe9ff`, lamp pool `#ffcf8a`; lamp pool 12 m disc, opacity 0.55·d; lamp head emissiveIntensity 0.6 + 2.4·d; headlight 0.3 + 2.7·d, tail 0.3 + 1.7·d; beam 3 × 8 m quad, 1–9 m ahead of the nose, opacity 0.35·d.
- Shared materials (`userData.shared`) are never mutated per object; module-wide uniform objects per use are the only night state on them.
- Not a git repo: "Commit" = `npx tsc` clean + `npm test` green.

## Review Focus
- Selecting a building at night (scene.ts `litOf` clones the material) → the selected building keeps its night windows; `Material.clone()` does NOT copy `onBeforeCompile`/`customProgramCacheKey`, so the clone must re-attach them. (Task 2 test)
- Leaving the 3D view at night → map 3D layer and library thumbnails render in daylight (`setNight(0, 12)` on unmount). (Task 4 test on the reset function; browser check)
- Street lights off → no pools at night, no errors from `setNight`. (Task 4 test)
- Cars off (no fleet) or `moving` off → `setNight` still works; parked-car lights never brighten. (Task 3 + Task 4 tests)
- Midnight wrap (hour 23.9 → 0.1) → litShare continuous, no jump of more than 0.05. (Task 1 test)

---

### Task 1: Night curves

**Files:**
- Create: `src/three/night.ts`, `src/three/night.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LightUse = 'home' | 'office' | 'shop' | 'none'
  export function darkness(sunElevation: number): number
  export function useOfWall(kind: WallKind): LightUse   // WallKind from ./facades
  export function litShare(use: LightUse, solarHour: number): number
  ```
- [ ] **Step 1: Failing tests:** `darkness(10) === 0`, `darkness(0) ≈ 0.5`, `darkness(-10) === 1`, monotone non-increasing over −20..20; `useOfWall` mapping for all 5 kinds; `litShare` at the listed hours equals the listed values (±0.01) for each use, e.g. `litShare('home', 20) ≈ 0.70`, `litShare('office', 12) ≈ 0.60`, `litShare('office', 23) ≈ 0.10`, `litShare('shop', 3) ≈ 0.05`, `litShare('none', 20) === 0`; `litShare(u, 24) === litShare(u, 0)`; |litShare(u, 23.9) − litShare(u, 0.1)| < 0.05; all values in [0, 1] for hour 0..24 step 0.25.
- [ ] **Step 2:** `npx vitest run src/three/night.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Keyframe tables `[hour, share][]` per use, linear interpolation with wrap.
- [ ] **Step 4:** PASS. **Step 5:** `npx tsc`, `npm test`.

### Task 2: Lit windows

**Files:**
- Modify: `src/three/facades.ts`, `src/three/scene.ts` (`litOf`, ~line 490)
- Test: `src/three/facades.test.ts`, `src/three/three.test.ts`

**Interfaces:**
- Consumes: `LightUse`, `useOfWall`, `litShare` (Task 1).
- Produces:
  ```ts
  export function facadeGlow(style: BuildingStyle, kind: WallKind): THREE.DataTexture
  export const NIGHT: Record<Exclude<LightUse, 'none'>, { uDark: { value: number }; uLit: { value: number } }>
  export function setFacadeNight(dark: number, solarHour: number): void   // writes NIGHT uniforms
  export function withNight<M extends THREE.Material>(clone: M, from: THREE.Material): M // re-attach onBeforeCompile + cache key
  ```
- [ ] **Step 1: Failing tests** (facades.test.ts): `facadeGlow('western','apartment')` has value 255 on a glass pixel and 0 on a wall pixel (pick coordinates from the DRAW rects, e.g. residential glass x 10–21, y 8–20); `wallMaterial` for kinds residential and apartment share `NIGHT.home` (inspect `material.userData.night === NIGHT.home`); glass ⇒ `NIGHT.office`; blank ⇒ no night patch (no emissiveMap); `customProgramCacheKey()` is defined and differs between home and office materials; `setFacadeNight(1, 20)` ⇒ `NIGHT.home.uDark.value === 1`, `NIGHT.home.uLit.value ≈ 0.70`. three.test.ts: a selected building's highlighted material still has `onBeforeCompile` equal to its source's (Review Focus #1).
- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3: Implement.** In `paint`, mark pixels painted with height `RECESS` *and* a glass role into a mask (add an explicit `glass` flag to the `rect` calls that paint glass rather than inferring from height). `wallMaterial` (non-blank): `emissiveMap = facadeGlow`, `emissive` per use colour, `emissiveIntensity = 1`, `userData.night = NIGHT[use]`, `onBeforeCompile` adds uniforms `uDark`, `uLit` and replaces `#include <emissivemap_fragment>` with: sample mask; `vec3 c = floor(vWorldPos / vec3(3.5, FLOOR_HEIGHT, 3.5)); float h = fract(sin(dot(c, vec3(12.9898, 78.233, 37.719))) * 43758.5453);` window on iff `h < uLit`; `totalEmissiveRadiance *= mask * uDark * step(h, uLit) * (0.8 + 0.4 * fract(h * 7.31))` (needs a `vWorldPos` varying added in the vertex shader via `#include <worldpos_vertex>`). `customProgramCacheKey = () => 'night-' + use`. In scene.ts `litOf`, pass the clone through `withNight(clone, m)`.
- [ ] **Step 4:** PASS. **Step 5:** `npx tsc`, `npm test`, `npm run build` (shader strings compile only in the browser — Task 4's browser check is the real check).

### Task 3: Car lights + beams

**Files:**
- Modify: `src/three/cars.ts`
- Test: `src/three/cars.test.ts`

**Interfaces:**
- Produces: `carFleet(...)` return type gains `setDarkness(d: number): void`; new slot `'beam'` only in fleet meshes.
- [ ] **Step 1: Failing tests:** fleet `light`/`tail` meshes use materials that are not the ones `carMeshes` uses (parked); `fleet.setDarkness(1)` ⇒ fleet headlight `emissiveIntensity ≈ 3.0`, tail ≈ 2.0, beam material opacity ≈ 0.35 and beam meshes visible; parked `carMeshes` light material intensity still 0.3; `setDarkness(0)` ⇒ beams invisible; after `update` with 3 sedans the sedan beam mesh `count === 3`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** Module-cached `fleetLight`/`fleetTail` (clones of the slot materials, `userData.shared = true`) and one `beam` material (MeshBasicMaterial, `AdditiveBlending`, `transparent`, `depthWrite: false`, gradient alpha DataTexture brighter near the car). Beam geometry per kind: PlaneGeometry(3, 8) rotated flat, translated to z = L/2 + 5, y = 0.05; one InstancedMesh per kind sharing the pose matrices in `update`; no shadows. `// ponytail:` beams don't bend with the road or clip at junctions.
- [ ] **Step 4:** PASS. **Step 5:** `npx tsc`, `npm test`.

### Task 4: Lamps, wiring, browser check, docs

**Files:**
- Modify: `src/three/scene.ts` (lights block ~line 457, `BuiltScene`), `src/three/CityView.tsx` (`placeSun` ~line 82, cleanup ~line 405), `.claude/CLAUDE.md`, `README.md`
- Test: `src/three/three.test.ts`

**Interfaces:**
- Consumes: `darkness` (Task 1), `setFacadeNight` (Task 2), fleet `setDarkness` (Task 3).
- Produces: `BuiltScene.setNight(darkness: number, solarHour: number): void`.
- [ ] **Step 1: Failing tests:** with street lights on, the scene has one pool InstancedMesh (additive, count = lamp count); `setNight(1, 20)` ⇒ lamp head material `emissiveIntensity ≈ 3.0`, pool opacity ≈ 0.55 and visible, `NIGHT.home.uDark.value === 1`; `setNight(0, 12)` ⇒ pools invisible, `uDark === 0`; street lights off ⇒ no pool mesh and `setNight(1, 20)` doesn't throw; cars off ⇒ `setNight` doesn't throw; the scene's `group` object is the same before and after `setNight` (no rebuild).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** pools (12 m CircleGeometry rotated flat, radial-gradient alpha DataTexture, `#ffcf8a`, `AdditiveBlending`, `depthWrite: false`, `polygonOffset`, y = ground + 0.2, same `lights` spots, not pickable, no shadows) and `setNight`. CityView: in `placeSun`, `built?.setNight(darkness(elevation), hourRef.current)`; after each rebuild the existing `placeSun()` call covers it; in the effect cleanup call `setFacadeNight(0, 12)`.
- [ ] **Step 4:** PASS; `npx tsc`, `npm test`, `npm run build`.
- [ ] **Step 5: Browser check (controller):** ×600 from 17:00 to 02:00 — windows come on at dusk, offices dim after 20:00, homes thin after midnight, lamp pools on roads, car beams; select a building at night (keeps lit windows); back to 2D map (daylight models); fps with night vs day at the same camera, Chrome in front (≤ 5% drop).
- [ ] **Step 6: Docs:** CLAUDE.md — one Architecture line for `night.ts` + façade night uniforms, Status line, test count; README — one sentence in the 3D section.
