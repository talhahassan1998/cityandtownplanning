# Google Earth (3D) Background Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Google Earth (3D)" background option: Google satellite in the 2D map, Google Photorealistic 3D Tiles around the plan in the 3D view.

**Architecture:** One new `BasemapId`. A shared `googleMapType()` maps basemaps to the 2D tile type, so both existing ternaries use it. A lazily imported `three/earth.ts` wraps `3d-tiles-renderer` and is driven from CityView's existing rebuild + render loop. Our terrain mesh is skipped for this option only.

**Tech Stack:** Three.js 0.186, `3d-tiles-renderer@0.5.3` (exact pin; 0.5.4 is < 2 weeks old), Draco decoder copied from `three/examples/jsm/libs/draco/gltf/`.

**Spec:** `docs/superpowers/specs/2026-11-13-google-earth-3d-design.md`

## Global Constraints
- Don't change anything existing (user): other basemaps, terrain options, KML, wizard and store shape all behave exactly as before.
- Key = the existing `googleKey()` (localStorage); never stored in the project file.
- Library loaded only through dynamic `import()` when the option is active; it must not be in the main chunk.
- Google attribution (logo + copyright strings) is visible whenever tiles show.
- Lucide icons only, no Unicode glyphs. `ponytail:` comments on the known limits (site buildings show through, flat plan level, billing).

## Review Focus
1. **No key set**, Google Earth chosen → the 3D view shows our normal terrain plus a notify message; it must not be a black void. (Task 3, browser check.)
2. **Bad key / API error / offline** → same fallback, and the message carries Google's error text. (Task 2 test: `loadEarth` rejects when the root tileset fetch fails.)
3. **Switching basemap while the 3D view is open** (Earth → OSM and back) → tiles disposed / re-added, terrain rebuilt, no leaked renderer. (Task 3, browser check.)
4. **Old saved projects**: a basemap value `google-earth` never appears in them, and nothing else depends on it. (Task 1 test: existing ids unchanged.)
5. **Closing the 3D view** disposes the tiles (no network after close). (Task 3, cleanup step.)

---

### Task 1: The option + 2D map type

**Files:**
- Modify: `src/model.ts:74-79` (BasemapId, BASEMAPS)
- Modify: `src/map/google.ts` (add `googleMapType`)
- Modify: `src/map/MapCanvas.tsx:381-384`, `src/three/CityView.tsx:123-124` (use the helper)
- Test: `src/map/google.test.ts`

**Interfaces:**
- Produces: `BasemapId` includes `'google-earth'`; `googleMapType(b: BasemapId): GoogleMapType | null` (`google-roadmap` → `'roadmap'`, `google-satellite` and `google-earth` → `'satellite'`, others → `null`).

- [ ] **Step 1: Write the failing test** in `google.test.ts`, named `maps basemaps to Google tile types`. It asserts the four mappings above, plus `BASEMAPS.map(b => b.id)` equals `['osm','grey','none','google-roadmap','google-satellite','google-earth']`. Read the current order from model.ts first and keep it; only the last id is new.
- [ ] **Step 2: Run** `npx vitest run src/map/google.test.ts` → FAIL (`googleMapType` not exported).
- [ ] **Step 3: Implement.** Add the id, add the label `'Google Earth (3D)'` last, add the helper. Replace the two `startsWith('google-')` + ternary sites with `googleMapType(...)`; behaviour for the existing ids is identical.
- [ ] **Step 4: Run** the test plus `npx tsc` → PASS, no errors.
- [ ] **Step 5: Commit** `feat: Google Earth (3D) basemap option, satellite in 2D` (only when the user asks for commits).

### Task 2: `three/earth.ts` tiles wrapper

**Files:**
- Create: `src/three/earth.ts`, `src/three/earth.test.ts`
- Create: `public/draco/` (copy `draco_decoder.js`, `draco_decoder.wasm`, `draco_wasm_wrapper.js` from `node_modules/three/examples/jsm/libs/draco/gltf/`)
- Modify: `package.json` (`"3d-tiles-renderer": "0.5.3"`, exact)

**Interfaces:**
- Produces:
  - `loadEarth(key: string, origin: [lon: number, lat: number], camera: THREE.Camera, renderer: THREE.WebGLRenderer): Promise<Earth>`
  - `interface Earth { group: THREE.Object3D; update(): void; credits(): { text: string; logo?: string }; dispose(): void }`
  - `earthCredits(list: { type: string; value: unknown }[]): { text: string; logo?: string }` (pure: joins string values with ' · ', takes the first `type === 'image'` value as `logo`).
- Implementation notes:
  - `new TilesRenderer()` plus three plugins:
    - `GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true })`
    - `GLTFExtensionsPlugin({ dracoLoader: new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/') })`
    - `ReorientationPlugin({ lat: lat*DEG2RAD, lon: lon*DEG2RAD, recenter: true })`. Its frame is x east, y up, −z north, the same as scene.ts.
  - Then `setCamera`, `setResolutionFromRenderer`.
  - Resolve the promise on the first `load-tile-set` event; reject on `load-error` for the root (message from the event's error).
  - Grounding: `update()` calls `tiles.update()`. Every 30th call it raycasts straight down at x=z=0 against `tiles.group` and sets `group.position.y = -hit.y`. The ground sharpens as finer tiles load. Add a `// ponytail:` note: flat plan level; the upgrade is per-building ground sampling.
  - `dispose()` calls `tiles.dispose()`.

- [ ] **Step 1: Write the failing test** `earth.test.ts` → `earthCredits` cases:
  - `[{type:'string',value:'Map data ©2026 Google'},{type:'image',value:'logo.png'}]` → `{ text: 'Map data ©2026 Google', logo: 'logo.png' }`
  - `[]` → `{ text: 'Google' }` (never blank)
- [ ] **Step 2: Run** `npx vitest run src/three/earth.test.ts` → FAIL.
- [ ] **Step 3:** `npm install 3d-tiles-renderer@0.5.3 --save-exact`, copy the Draco files, implement `earth.ts`.
- [ ] **Step 4: Run** the test plus `npx tsc` → PASS.
- [ ] **Step 5: Commit** `feat: Google Photorealistic 3D Tiles wrapper` (only when the user asks).

### Task 3: Wire into the 3D view

**Files:**
- Modify: `src/three/CityView.tsx` (loadEnv, rebuild, loop, cleanup, credit line)

**Interfaces:**
- Consumes: `loadEarth`, `Earth`, `googleMapType` (Tasks 1–2).

- [ ] **Step 1: loadEnv.** When `basemap === 'google-earth'`, load neither the elevation nor the mosaic (this keeps `e.elevation` and `e.ground` undefined). The env key already includes the basemap.
- [ ] **Step 2: rebuild.**
  - If the option is on and `googleKey()` is set: when there's no earth yet, or its origin changed, run `(await import('./earth')).loadEarth(key, origin, camera, renderer)` and add `earth.group` to the scene. Don't build the terrain mesh; remove any existing one.
  - On rejection: `notify('Google Earth unavailable: ' + msg + ' — showing normal terrain')`, then continue down the normal terrain path for this rebuild.
  - When the option is off: dispose and remove the earth.
  - No key: the same notify plus normal terrain.
- [ ] **Step 3: loop.** `earth?.update()` just before `renderer.render`.
- [ ] **Step 4: cleanup.** `earth?.dispose()` in the unmount block.
- [ ] **Step 5: credit line.** When earth is active, show `earth.credits()`: the logo `<img>` (h-3) plus text, instead of the OSM/terrain credit. Refresh it with the existing `status` render cadence (a state set every ~1 s from the loop is fine).
- [ ] **Step 6: Verify.**
  - `npx tsc`, `npm test`, `npm run build`.
  - Then `grep -l TilesRenderer dist/assets/*.js` must not match the main `index-*.js` chunk.
- [ ] **Step 7: Browser** (port 5317 dev server, the user's key). Check each:
  - The option is listed.
  - 2D shows satellite.
  - 3D shows photorealistic tiles with the plan on top and north aligned (compare a road to the satellite).
  - Attribution is visible.
  - Without a key, the fallback message appears.
  - Earth → OSM → Earth works with the 3D view open.
  - Closing the 3D view stops tile requests.
- [ ] **Step 8:** Update `.claude/CLAUDE.md` (one line under Architecture/three) and README basemaps. Commit `feat: Google Earth (3D) in the 3D view` (only when the user asks).
