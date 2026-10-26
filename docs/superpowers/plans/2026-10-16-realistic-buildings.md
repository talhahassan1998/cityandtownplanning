# Realistic Procedural Buildings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All 25 building types render as real-world-looking buildings in two per-project styles (Western, Gulf), with a 300-building town smooth in the 3D view.

**Architecture:** A recipe per building type combines footprint-parametric kit parts (`three/kit.ts`) over a body extruded from the real footprint and skinned with generated façade textures (`three/facades.ts`). `buildingModel()` merges everything into one mesh per material, with small parts in a separate `details` child that viewers hide by distance/zoom. `buildScene` calls it, so the 3D view, map 3D layer and thumbnails all get the models.

**Tech Stack:** TypeScript 7 (tsgo), Three.js 0.186 (`mergeGeometries` from `three/addons/utils/BufferGeometryUtils.js`, already used in `scene.ts`), Vitest (node env), React 19 for the two UI fields.

**Spec:** `docs/superpowers/specs/2026-10-16-realistic-buildings-design.md`

## Global Constraints

- Styles: `'western' | 'gulf'`; effective style = `attrs.style ?? settings.buildingStyle ?? 'western'`. Never written to features unless the user overrides.
- Procedural only, no asset files; textures are `THREE.DataTexture` from pixel arrays (tests run in Node, no canvas).
- One mesh per material per building after merging; ≤10 meshes per building (body + details together).
- Details hidden beyond 400 m from the camera in the 3D view; hidden below zoom 17 on the map 3D layer.
- Bounding box of a model ≤ footprint's oriented box expanded by 3 m horizontally.
- Footprint with either oriented-box side < 4 m, unknown type, or a throwing recipe → plain extruded body + flat roof.
- Explicit saved `attrs.roof` overrides the style's default roof.
- Coordinates: scene frame is local metres (e = x, n = −z, y up); kit parts are built in the oriented-box frame (x along long axis, y up, z = −short axis, origin at box centre on the ground, front face at z = +hy).
- Project style: lucide-react icons, no Unicode glyphs; minimal code; `ponytail:` comments for known ceilings; each new module gets a test file.
- This folder is not a git repository: commit steps are replaced by "run the full gates".

## Review Focus

- **Tiny footprints** (a 3 × 3 m shed drawn as `house`): expect the plain fallback body, no throw. → Task 4 test `falls back for tiny footprints`.
- **Courtyard / L-shaped footprints** (ring with a hole, L-shape): walls follow the real ring (hole stays open); roof/kit parts stay inside the expanded oriented box. → Task 4 test `keeps holes and stays in bounds for L and courtyard footprints`.
- **Very tall buildings** (tower, 50 floors): one façade tile per storey; repeated parts (balconies) capped so vertex count stays bounded. → Task 4 test `caps repeated parts on a 50-floor tower`.
- **Huge footprints** (mall 120 × 80, warehouse 100 × 40): repeated parts (docks, columns, stalls) capped. → Task 5 test `caps repeated parts on huge footprints`, Task 7 same.
- **Legacy projects**: saved `roof: 'gable'` on a building in a Gulf project stays gable; project without `buildingStyle` renders Western. → Task 1 and Task 4 tests.

---

### Task 1: Style data + UI fields

**Files:**
- Modify: `src/model.ts` (`Settings` at :31, `defaultAttrs` at :276, add exports)
- Modify: `src/ui/Inspector.tsx` (`FIELDS` :30–47, `EXTRA` :50–56)
- Modify: `src/ui/Analytics.tsx` (settings block near :154)
- Test: `src/model.test.ts` (new)

**Interfaces:**
- Produces: `export type BuildingStyle = 'western' | 'gulf'`; `export const BUILDING_STYLES: Record<BuildingStyle, string> = { western: 'Western', gulf: 'Gulf' }`; `export function styleOf(attrs: Attrs, settings?: Partial<Settings>): BuildingStyle`; `Settings.buildingStyle?: BuildingStyle`.

- [ ] **Step 1: Write the failing tests** in `src/model.test.ts`

```ts
it('resolves building style: feature beats project beats western', () => {
  expect(styleOf({}, {})).toBe('western')
  expect(styleOf({}, { buildingStyle: 'gulf' })).toBe('gulf')
  expect(styleOf({ style: 'western' }, { buildingStyle: 'gulf' })).toBe('western')
  expect(styleOf({ style: 'bogus' }, { buildingStyle: 'gulf' })).toBe('gulf') // unknown values ignored
})
it('leaves roof unset on new buildings so the style decides', () => {
  expect(defaultAttrs(componentDef('house')!).roof).toBeUndefined()
  expect(defaultAttrs(componentDef('house')!).floors).toBe(2)
})
```

- [ ] **Step 2: Run** `npx vitest run src/model.test.ts` — Expected: FAIL (`styleOf` not exported, roof is `'gable'`).
- [ ] **Step 3: Implement** the exports above in `model.ts`; drop `roof` from `defaultAttrs` and delete the now-unused `PITCHED` set. In `Inspector.tsx` add `style: { label: 'Style', options: { '': 'Project default', western: 'Western', gulf: 'Gulf' } }` and an `''` → `'Style default'` option on `roof`; add `'style'` to `EXTRA.buildings` and `EXTRA.facilities`; setting `''` must remove the attr (check how `set(k, v)` handles empty values; delete the key if it doesn't). In `Analytics.tsx` add a "Building style" select bound to `settings.buildingStyle` through the existing `setS`.
- [ ] **Step 4: Run** `npx vitest run src/model.test.ts && npx tsc` — Expected: PASS, no type errors.

---

### Task 2: Façade textures

**Files:**
- Create: `src/three/facades.ts`
- Test: `src/three/facades.test.ts`

**Interfaces:**
- Consumes: `BuildingStyle` (Task 1), `FLOOR_HEIGHT` from `model.ts`.
- Produces: `export type WallKind = 'residential' | 'apartment' | 'shopfront' | 'glass' | 'blank'`; `export const BAY = 3.5` (m); `export function facadeTexture(style: BuildingStyle, kind: WallKind): THREE.DataTexture`; `export function facadeBump(style: BuildingStyle, kind: WallKind): THREE.DataTexture`; `export function wallMaterial(style: BuildingStyle, kind: WallKind, color: string): THREE.MeshStandardMaterial` (cached by `style|kind|color`).

Pixel content (32 × 32 px tile = one bay × one storey, white-based so `material.color` tints the wall; glass/frames keep their own colours):
- western: residential = render with white-framed sash window + sill; apartment = same, wider window; shopfront = full-width glass with mullions + fascia band at top; glass = blue-grey curtain wall grid; blank = horizontal cladding lines.
- gulf: residential = stone with small deep window + dark recess border; apartment = window with mashrabiya lattice in its lower half; shopfront = roll-up shutter bands + sign band; glass = glass with vertical stone fins; blank = sand-tone cladding.
- Bump: frames/sills/fins raised, recesses lowered (greyscale, same tile layout).
- UVs: `repeat = (1/BAY, 1/FLOOR_HEIGHT)`, `offset.y = −1/FLOOR_HEIGHT` (ExtrudeGeometry side UVs are metres, as in today's `windowTile`).

- [ ] **Step 1: Write the failing tests**

```ts
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
})
it('shares materials per style, kind and colour', () => {
  expect(wallMaterial('gulf', 'glass', '#cccccc')).toBe(wallMaterial('gulf', 'glass', '#cccccc'))
  expect(wallMaterial('gulf', 'glass', '#cccccc').bumpMap).toBe(facadeBump('gulf', 'glass'))
})
```

- [ ] **Step 2: Run** `npx vitest run src/three/facades.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `facades.ts` per the interface and pixel notes above (small `rect(x0,y0,x1,y1,rgba)` painter over a `Uint8Array`; `// ponytail:` note that textures are module-level and never disposed).
- [ ] **Step 4: Run** the test — Expected: PASS.

---

### Task 3: Building kit (parts)

**Files:**
- Create: `src/three/kit.ts`
- Test: `src/three/kit.test.ts`

**Interfaces:**
- Consumes: `OBox` (from `models.ts`), `BuildingStyle`.
- Produces:
  - `export type MatKey = 'trim' | 'roof' | 'glass' | 'metal' | 'wood' | 'awning' | 'green' | 'accent' | 'sign' | 'dark'`
  - `export interface Part { mat: MatKey; geo: THREE.BufferGeometry }` — geometry in the oriented-box frame (see Global Constraints).
  - `export const PALETTE: Record<BuildingStyle, Record<MatKey, string>>` (western roof `#8a4b3a`, trim `#f4f1ea`; gulf roof n/a, trim `#e9dcc0`, accent `#b8925a`).
  - Parts, all returning `Part[]`; `L = ob.hx`, `W = ob.hy`, `top` = eaves height above base:
    `parapet(ob, top, h)` · `gableRoof(ob, top, overhang, pitch)` · `hipRoof(ob, top, overhang, pitch)` · `balconies(ob, floors, style, every)` (front face, one per `every` bays per floor from floor 1; **capped at 200 total**) · `awning(x, w, h, style)` (front face) · `shopfront(x, w, style)` (sign band + door) · `porch(x, w, d)` (slab, steps, two posts, small roof) · `boundaryWall(ob, margin, h, gateX, style)` (rectangle `margin` outside the box, gap at `gateX`; `margin ≤ 3`) · `rooftopTanks(ob, top, n, seed)` · `acUnits(ob, top, n, seed)` · `arcade(ob, h, style)` (front face, arches for gulf / square piers for western; **≤ 40 bays**) · `portico(ob, h, cols, style)` (≤ 12 columns + entablature/pediment for western, arches for gulf) · `canopy(x, z, w, d, h)` · `dome(x, z, r, y)` · `tower(x, z, r, h, style)` (bell tower western / minaret gulf) · `chimney(x, z, top)` · `door(x, w, h, mat)` · `palm(x, z, h)` · `hedge(ob, margin)`.
  - `export function partsBounds(parts: Part[]): THREE.Box3`.

- [ ] **Step 1: Write the failing tests**

```ts
const OB = { cx: 0, cy: 0, hx: 10, hy: 6, angle: 0 }
it('every part stays within the box expanded by 3 m and above ground', () => {
  for (const parts of [parapet(OB, 6, 1), gableRoof(OB, 6, 0.5, 0.6), balconies(OB, 4, 'gulf', 2), boundaryWall(OB, 3, 2, 0, 'western'), arcade(OB, 4, 'gulf'), portico(OB, 6, 6, 'western')]) {
    const b = partsBounds(parts)
    expect(b.min.x).toBeGreaterThanOrEqual(-13); expect(b.max.x).toBeLessThanOrEqual(13)
    expect(b.min.z).toBeGreaterThanOrEqual(-9); expect(b.max.z).toBeLessThanOrEqual(9)
    expect(b.min.y).toBeGreaterThanOrEqual(0)
  }
})
it('gable roof sits on the eaves and rises by pitch × half-width', () => {
  const b = partsBounds(gableRoof(OB, 6, 0.5, 0.6))
  expect(b.min.y).toBeCloseTo(6, 3); expect(b.max.y).toBeCloseTo(6 + 0.6 * 6, 1)
})
it('caps repeated parts', () => {
  const big = { cx: 0, cy: 0, hx: 200, hy: 20, angle: 0 }
  expect(balconies(big, 60, 'western', 1).length).toBeLessThanOrEqual(200)
  expect(arcade(big, 4, 'gulf').length).toBeLessThanOrEqual(40 * 3)
})
it('styles differ', () => {
  expect(arcade(OB, 4, 'gulf').length).not.toBe(arcade(OB, 4, 'western').length)
})
```

- [ ] **Step 2: Run** `npx vitest run src/three/kit.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `kit.ts` (reuse the `box`/`cyl` sizing conventions from `models.ts`, but return translated `BufferGeometry` instead of meshes; one `Part` per primitive is fine, merging happens in Task 4).
- [ ] **Step 4: Run** the test — Expected: PASS.

---

### Task 4: `buildingModel` + residential recipes

**Files:**
- Create: `src/three/buildings/index.ts`, `src/three/buildings/residential.ts`
- Test: `src/three/buildings.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `orientedBox`, `XY` from `geo.ts`; `RoofStyle` from `model.ts`.
- Produces:
  - `export interface BuildingInput { type: string; style: BuildingStyle; ring: XY[]; holes: XY[][]; base: number; height: number; floors: number; color: string; seed: number; roof?: RoofStyle }` (ring/holes in scene-frame local metres, closed rings as `scene.ts` has them; `height` already includes the terrain step `hi − lo`).
  - `export interface RecipeCtx { ob: OBox; style: BuildingStyle; floors: number; top: number; rnd: () => number }` (`ob` re-centred: cx = cy = 0, angle = 0 — the caller transforms).
  - `export interface Recipe { wall: WallKind; ground?: WallKind; roof: RoofStyle | 'none'; parts: Part[]; details: Part[] }` and `export type RecipeFn = (c: RecipeCtx) => Recipe`.
  - `export const RECIPES: Record<string, RecipeFn>` (filled by the per-family modules via `Object.assign(RECIPES, residential)` etc. in `index.ts`).
  - `export function buildingModel(b: BuildingInput): THREE.Group` — children: merged body/part meshes (one per material) and one `THREE.Group` named `'details'` (merged per material). `group.userData.details` points at it.

Behaviour:
- Body: `ExtrudeGeometry` of ring + holes (as `scene.ts:285-288` does now), material `wallMaterial(style, recipe.wall, color)`. If `recipe.ground` is set and floors ≥ 2, extrude the ground storey separately with that wall kind and the upper body from `FLOOR_HEIGHT` up.
- Roof: `b.roof ?? recipe.roof`; `'flat'` → nothing extra (recipes add parapets); `gable`/`hip` → kit roofs; `pyramid` → existing `roofGeometry(ring, 'pyramid')` from `scene.ts` (move `roofGeometry` into this module if importing `scene.ts` would be circular).
- Parts/details: transform each geometry by the oriented-box matrix (rotate Y by `ob.angle`, translate to `(ob.cx, base, −ob.cy)`), group by `mat`, `mergeGeometries` per group, material from `PALETTE[style][mat]` (shared, cached). Drop non-indexed/indexed mismatch with `toNonIndexed()` before merging.
- Fallback when `Math.min(ob.hx, ob.hy) * 2 < 4`, type missing from `RECIPES`, or the recipe throws: body only with `wallMaterial(style, 'residential', color)` and an empty `details` group.
- `rnd = mulberry32(seed)` (copy the 3-line helper from `scene.ts:82`, or export it from there).
- Residential recipes per the spec table: `house`, `villa`, `townhouse`, `apartment`, `tower`. Western house: wall `residential`, roof `gable`, parts chimney + porch, details hedge/fence. Gulf house: roof `flat`, parts parapet + boundaryWall + stair room (small box on the roof), details acUnits. Apartment: wall `apartment`, details balconies (western every 1 bay, gulf every 2 with lattice), rooftopTanks for gulf. Tower: wall `glass`, parts podium (western) / stone base (gulf), crown.

- [ ] **Step 1: Write the failing tests** (`buildings.test.ts`; helper `rect(w, d)` returns a closed ring centred on 0,0)

```ts
const inp = (type: string, style: BuildingStyle, ring = rect(12, 10), floors = 2): BuildingInput =>
  ({ type, style, ring, holes: [], base: 0, height: floors * FLOOR_HEIGHT, floors, color: '#d8c8a8', seed: 7 })
const meshes = (g: THREE.Object3D) => { const out: THREE.Mesh[] = []; g.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh) }); return out }
const RES = ['house', 'villa', 'townhouse', 'apartment', 'tower']

it.each(RES.flatMap((t) => (['western', 'gulf'] as const).map((s) => [t, s])))('%s/%s builds merged, bounded, with details', (t, s) => {
  const g = buildingModel(inp(t, s))
  expect(meshes(g).length).toBeLessThanOrEqual(10)
  expect(g.userData.details).toBeInstanceOf(THREE.Group)
  const b = new THREE.Box3().setFromObject(g)
  expect(b.min.x).toBeGreaterThanOrEqual(-6 - 3); expect(b.max.x).toBeLessThanOrEqual(6 + 3)
})
it('is deterministic for the same seed and varies across seeds', () => { /* compare position arrays of the first mesh */ })
it('western house is pitched, gulf house is flat by default; saved roof wins', () => {
  const top = (g: THREE.Object3D) => new THREE.Box3().setFromObject(g).max.y
  expect(top(buildingModel(inp('house', 'western')))).toBeGreaterThan(2 * FLOOR_HEIGHT + 1.5)
  expect(top(buildingModel(inp('house', 'gulf')))).toBeLessThan(2 * FLOOR_HEIGHT + 3) // parapet / stair room only
  expect(top(buildingModel({ ...inp('house', 'gulf'), roof: 'gable' }))).toBeGreaterThan(2 * FLOOR_HEIGHT + 1.5)
})
it('falls back for tiny footprints and unknown types', () => {
  for (const g of [buildingModel(inp('house', 'western', rect(3, 3))), buildingModel(inp('nonsense', 'gulf'))]) {
    expect(meshes(g).length).toBe(1); expect((g.userData.details as THREE.Group).children.length).toBe(0)
  }
})
it('keeps holes and stays in bounds for L and courtyard footprints', () => { /* L ring and rect(30,30)+hole rect(10,10): builds, bounds within ob ± 3 m */ })
it('caps repeated parts on a 50-floor tower', () => {
  const g = buildingModel(inp('apartment', 'western', rect(40, 16), 50))
  const verts = meshes(g).reduce((n, m) => n + m.geometry.attributes.position.count, 0)
  expect(verts).toBeLessThan(200_000)
})
```

- [ ] **Step 2: Run** `npx vitest run src/three/buildings.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `buildings/index.ts` and `buildings/residential.ts` per the behaviour list.
- [ ] **Step 4: Run** the test — Expected: PASS.

---

### Task 5: Commercial recipes

**Files:**
- Create: `src/three/buildings/commercial.ts` (register in `index.ts`)
- Test: extend `src/three/buildings.test.ts`

**Interfaces:**
- Consumes: `RecipeFn`, `RECIPES`, kit parts.
- Produces: recipes `shop`, `market`, `mall`, `office`, `hotel`, `mixed-use`, `tech-park`.

Per spec table. Wall kinds: shop → `ground: 'shopfront'`, wall `residential`; mixed-use → `ground: 'shopfront'`, wall `apartment`; office/tech-park/hotel/mall → `glass`; market → `blank` + arcade/columns. Western shop: awning + shopfront parts, flat roof with parapet; gulf shop: shutter-look `shopfront` texture, canopy, parapet.

- [ ] **Step 1: Write the failing tests** — extend the `it.each` list with the 7 types; add:

```ts
it('caps repeated parts on huge footprints', () => {
  for (const s of ['western', 'gulf'] as const) {
    const g = buildingModel(inp('mall', s, rect(120, 80), 3))
    expect(meshes(g).length).toBeLessThanOrEqual(10)
    expect(meshes(g).reduce((n, m) => n + m.geometry.attributes.position.count, 0)).toBeLessThan(200_000)
  }
})
it('gives shops and mixed-use a shopfront ground storey', () => {
  const kinds = (g: THREE.Object3D) => meshes(g).map((m) => (m.material as THREE.MeshStandardMaterial).map)
  expect(kinds(buildingModel(inp('mixed-use', 'western', rect(30, 20), 4)))).toContain(facadeTexture('western', 'shopfront'))
})
```

- [ ] **Step 2: Run** — Expected: FAIL for the new types (fallback has 1 mesh / no shopfront).
- [ ] **Step 3: Implement** `commercial.ts`.
- [ ] **Step 4: Run** `npx vitest run src/three/buildings.test.ts` — Expected: PASS.

---

### Task 6: Civic recipes

**Files:**
- Create: `src/three/buildings/civic.ts` (register in `index.ts`)
- Test: extend `src/three/buildings.test.ts`

**Interfaces:**
- Produces: recipes `school`, `university`, `hospital`, `clinic`, `police`, `fire`, `government`, `community`, `library`, `religious`, `station`.

Carry over today's identifying details from `buildingExtras` (`models.ts:73-133`): hospital roof cross, clinic red sign, school flag, police blue light (emissive), fire red appliance doors, government/library columns, religious dome + minaret, station canopy. Add per spec: hospital helipad (flat 'H' disc on roof, western and gulf), fire drill tower, western religious = nave + gable + bell `tower`, gulf religious = `dome` + `tower` (minaret) + `boundaryWall`, gulf government = arched `portico` + `dome`.

- [ ] **Step 1: Write the failing tests** — extend the `it.each` list with the 11 types; add:

```ts
it('religious buildings follow the style: bell tower vs dome', () => {
  const w = new THREE.Box3().setFromObject(buildingModel(inp('religious', 'western', rect(30, 30), 2)))
  const gu = new THREE.Box3().setFromObject(buildingModel(inp('religious', 'gulf', rect(30, 30), 2)))
  expect(w.max.y).toBeGreaterThan(2 * FLOOR_HEIGHT + 8) // bell tower
  expect(gu.max.y).toBeGreaterThan(2 * FLOOR_HEIGHT + 12) // minaret
})
it('police keeps its emissive light', () => {
  expect(meshes(buildingModel(inp('police', 'gulf', rect(25, 20)))).some((m) => (m.material as THREE.MeshStandardMaterial).emissiveIntensity > 0)).toBe(true)
})
```

- [ ] **Step 2: Run** — Expected: FAIL for the new types.
- [ ] **Step 3: Implement** `civic.ts` (add `'emissive'` handling: `PALETTE` material for key `accent` on police uses `emissive: '#1e88e5', emissiveIntensity: 0.6` — add an optional `MatKey` `'light'` to `kit.ts` if cleaner).
- [ ] **Step 4: Run** `npx vitest run src/three/buildings.test.ts` — Expected: PASS.

---

### Task 7: Industrial recipes + retire old building details

**Files:**
- Create: `src/three/buildings/industrial.ts` (register in `index.ts`)
- Modify: `src/three/models.ts` (delete `buildingExtras`, `facadeMaterials`, `windowTile`, `tile`, `GLASSY`, `BLANK`)
- Modify: `src/three/models.test.ts` (delete the two tests for removed functions, `:25-35`)
- Test: extend `src/three/buildings.test.ts`

**Interfaces:**
- Produces: recipes `factory`, `warehouse`, `substation`, `treatment`, `pump-station`, `telecom-exchange`, `waste` (only reached when these have height; their flat-area details stay in `groundExtras`).

Factory: wall `blank`, western sawtooth roof (series of tilted boxes, ≤ 30) / gulf flat metal roof in sand tone, stacks (`cyl` as today), loading docks. Warehouse: wall `blank`, docks (≤ 20 roll-up doors), low-pitch metal roof. Infrastructure: wall `blank`, fence via `boundaryWall`, telecom mast kept.

- [ ] **Step 1: Write the failing tests** — extend the `it.each` list with the 7 types; add `caps repeated parts on huge footprints` for `warehouse` with `rect(100, 40)`; add a completeness check:

```ts
it('has a recipe for every building type in the catalogue', () => {
  const types = COMPONENTS.flatMap((g) => g.items ?? [g]).filter((c) => c.geom === 'polygon' && c.floors).map((c) => c.type)
  expect(types.length).toBe(25)
  for (const t of types) expect(RECIPES[t], t).toBeTypeOf('function')
})
```

(Adjust the `COMPONENTS` flattening to its actual shape at `model.ts:170`.)

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `industrial.ts`; delete the retired code from `models.ts` and its tests.
- [ ] **Step 4: Run** `npx vitest run src/three && npx tsc` — Expected: PASS; tsc will flag `scene.ts`'s now-missing imports, fixed in Task 8 (if executing tasks separately, keep a temporary re-export until Task 8).

---

### Task 8: Wire into `buildScene`, viewers and detail hiding

**Files:**
- Modify: `src/three/scene.ts` (`SceneOptions` :15; building block :280-296; imports)
- Modify: `src/three/CityView.tsx` (`buildScene` call :138; render loop)
- Modify: `src/map/models3d.ts` (`buildScene` call :28; render/zoom)
- Modify: `src/three/thumbs.ts` (`buildScene` call :27)
- Test: extend `src/three/three.test.ts`

**Interfaces:**
- Consumes: `buildingModel`, `styleOf`.
- Produces: `SceneOptions.settings?: Partial<Settings>`; `BuiltScene.details: { object: THREE.Object3D; center: THREE.Vector3 }[]`; `export function setDetailVisibility(built: BuiltScene, camera: THREE.Vector3 | null, maxDist = 400): void` (null camera = hide all).

- [ ] **Step 1: Write the failing tests** in `three.test.ts`

```ts
it('uses the project style unless the building overrides it', () => {
  const house = feature('house', { floors: 2, height: 6.4 })          // reuse the file's existing feature helper
  const top = (s: Partial<Settings>, a = {}) => new THREE.Box3().setFromObject(buildScene([{ ...house, properties: { ...house.properties, attrs: { ...house.properties.attrs, ...a } } }], LAYERS, O, B, { ...OPTS, settings: s }).group).max.y
  expect(top({})).toBeGreaterThan(top({ buildingStyle: 'gulf' }))                 // western pitched > gulf flat
  expect(top({ buildingStyle: 'gulf' }, { style: 'western' })).toBe(top({}))      // override wins
})
it('keeps every building mesh pickable and hides details by distance', () => {
  const built = buildScene([feature('apartment', { floors: 6, height: 19.2 })], LAYERS, O, B, OPTS)
  expect(built.details.length).toBe(1)
  setDetailVisibility(built, new THREE.Vector3(0, 0, 0)); expect(built.details[0].object.visible).toBe(true)
  setDetailVisibility(built, new THREE.Vector3(5000, 0, 0)); expect(built.details[0].object.visible).toBe(false)
  setDetailVisibility(built, null); expect(built.details[0].object.visible).toBe(false)
})
it('one bad building does not break the scene', () => {
  const bad = feature('house', { floors: 2, height: 6.4 }, /* degenerate ring: all points equal */)
  expect(() => buildScene([bad, feature('shop', { floors: 1, height: 3.2 })], LAYERS, O, B, OPTS)).not.toThrow()
})
```

(Use the helpers/constants the file already defines; add a `ring` param to its feature helper if it lacks one.)

- [ ] **Step 2: Run** `npx vitest run src/three/three.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
  - `scene.ts`: replace the body/roof/`buildingExtras` block with `buildingModel({ type, style: styleOf(attrs, o.settings), ring, holes: rings.slice(1), base: lo, height: height + (hi - lo), floors, color: colorOf(x), seed: hash(x.id), roof: attrs.roof as RoofStyle | undefined })`, wrapped in `try/catch` that falls back to the plain body; register every mesh with `add(…, x.id)` so picking/highlight keep working (`userData.emissive` on body meshes as today); push `{ object: g.userData.details, center }` into `details`.
  - `setDetailVisibility`: sets `object.visible = camera !== null && camera.distanceTo(center) <= maxDist`.
  - `CityView.tsx`: pass `settings: s.meta.settings`; call `setDetailVisibility(built, camera.position)` each frame before render (cheap: one distance per building).
  - `models3d.ts`: pass `settings`; on render call `setDetailVisibility(built, map.getZoom() >= 17 ? <any vector> : null, Infinity)`.
  - `thumbs.ts`: pass no settings (western), keep details visible.
  - Rebuild triggers: make sure a change to `meta.settings.buildingStyle` rebuilds the scene in both `CityView` and `models3d` (they currently rebuild on `features`/`layers`; add `meta.settings` to the comparison).
- [ ] **Step 4: Run** `npm test && npx tsc && npm run build` — Expected: all tests pass (count = 123 − 2 removed + new), no type errors, build succeeds.

---

### Task 9: Browser verification, performance, docs

**Files:**
- Modify: `.claude/CLAUDE.md` (Architecture: new `three/facades.ts`, `three/kit.ts`, `three/buildings/`; Status: unverified item cleared; test count)
- Modify: `README.md` (3D section: styles + per-building override)

- [ ] **Step 1:** Start `npm run dev -- --port 5317 --strictPort` in the background; open it in the browser (follow CLAUDE.md browser gotchas: `__store` / `__map` dev globals, save before code edits).
- [ ] **Step 2:** Through `__store`, place one of each of the 25 building types in a grid; screenshot the 3D view in Western, switch the project style to Gulf, screenshot again; override one building back to Western and confirm only it changes. Expected: every type is recognisable, no fallback boxes except intentional ones, no console errors.
- [ ] **Step 3:** Map 3D layer: zoom 16 shows bodies without details, zoom 17+ shows details. Library thumbnails show the new models.
- [ ] **Step 4:** Performance: generate a master plan, then (until sub-project 2 fills plots) add ~300 houses/shops/apartments on plots via `__store`; orbit the 3D view and record FPS with `performance` / a `requestAnimationFrame` counter over 5 s. Expected: ≥ 30 fps on this machine. If below, report the number and the largest contributors (draw calls via `renderer.info.render.calls`) before tuning.
- [ ] **Step 5:** Update `CLAUDE.md` and `README.md`; stop the dev server and kill the leftover `node vite.js` on 5317 per CLAUDE.md.
- [ ] **Step 6:** Final gates: `npm test && npx tsc && npm run build` — Expected: all pass.
