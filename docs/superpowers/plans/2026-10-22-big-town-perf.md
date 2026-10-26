# Big-town 3D Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ~1000-building towns render at ≥30 fps in the 3D view by drawing buildings through one `THREE.BatchedMesh` per material, with picking/selection/3D editing unchanged.

**Architecture:** Buildings are still built per feature (`buildingModel`) and kept as hidden pickable groups; a new pure `three/batch.ts` copies their meshes into per-material BatchedMeshes. Selection shows a building's own (highlighted) group and hides its batch instances. Detail distance-culling flips batch instance visibility.

**Tech Stack:** Three.js 0.186 (`BatchedMesh`), TypeScript, Vitest (node env).

**Spec:** `docs/superpowers/specs/2026-10-22-big-town-perf-design.md`

## Global Constraints
- Building materials are SHARED (cached, `userData.shared`): never mutate or dispose them; batches reuse them as-is.
- Raycasting must keep working on `built.pickables` (the hidden individual meshes); `built.pick` unchanged.
- No CityView / models3d logic changes beyond what `setDetailVisibility` hides.
- Target: 1038-building town ≤ 33 ms/frame (forced render + `readPixels`), 156-apartment scene no slower.
- Not a git repo: no commit steps. Gates after every task: `npx tsc` and `npm test` green.
- Ponytail style: minimal code; `ponytail:` comment for the kept CPU-side duplicate geometry.

## Review Focus
1. Selecting a building, then deselecting: exactly one copy visible each time (no double-draw z-fighting, no vanished building).
2. Drag-move/rotate preview of a selected building: the visible group moves; nothing stays behind in the batch.
3. Selected building zoomed far away: its own `details` group follows distance hiding like the batch does.
4. User-coloured wall (`attrs.color`) gets its own material → its own batch; must not borrow another building's colour.
5. Scene with zero buildings (roads only) and with a building whose recipe failed (plain body): no empty BatchedMesh errors.

Tests for 1, 4 and 5 are in Tasks 2–3; 2 and 3 are checked in the browser (Task 4).

---

### Task 1: Single-material building meshes

**Files:**
- Modify: `src/three/buildings/index.ts:95-100` (`body`)
- Test: `src/three/buildings.test.ts`, `src/three/three.test.ts` (selection test ~line 125)

**Interfaces:**
- Produces: every `THREE.Mesh` inside a `buildingModel` group has a single (non-array) material. Body is two meshes, both `userData.body = true`: caps (`capMaterial`) with `userData.part = 'cap'`, walls (`wallMaterial`) with `userData.part = 'wall'`.

- [ ] **Step 1: Failing test** in `buildings.test.ts`:
```ts
it('gives every mesh a single material (batchable)', () => {
  for (const t of ['house', 'apartment', 'shop', 'factory'])
    buildingModel(inp(t, 'western', rect(20, 14), 3)).traverse((o) => {
      if ((o as THREE.Mesh).isMesh) expect(Array.isArray((o as THREE.Mesh).material)).toBe(false)
    })
})
```
- [ ] **Step 2:** `npx vitest run src/three/buildings.test.ts` → FAIL (body material is an array).
- [ ] **Step 3:** In `body`, split the ExtrudeGeometry by its two groups (group 0 = caps, group 1 = sides; geometry is non-indexed, so slice each attribute by `group.start..start+count`) into two meshes with `capMaterial(b.style)` and `wallMaterial(...)`; keep `castShadow`/`receiveShadow`/`userData.body`, add `userData.part`.
- [ ] **Step 4:** Update the `three.test.ts` selection test: `wall(id)` = the pickable with `userData.part === 'wall'` for that id, cap = `part === 'cap'`; same assertions (shared cap material, glow on/off, night patch survives, not disposed).
- [ ] **Step 5:** `npx tsc` and `npm test` → all green.

### Task 2: `three/batch.ts`

**Files:**
- Create: `src/three/batch.ts`, `src/three/batch.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Batches {
  meshes: THREE.BatchedMesh[]
  /** Shows/hides one building's instances: its main parts ('body') or its `details` group parts ('details'). No-op for unknown ids. */
  setVisible(id: string, which: 'body' | 'details', on: boolean): void
}
/** One BatchedMesh per material over the buildings' meshes (geometry already in scene coordinates). */
export function batchBuildings(buildings: { id: string; group: THREE.Group }[]): Batches
```
A mesh is a 'details' mesh when it sits under `group.userData.details`. Bucket key = the material object (+ `which`, so details share a material's batch only with other details). Per bucket: `new THREE.BatchedMesh(n, totalVerts, totalIndices, material)`, `addGeometry` + `addInstance` per mesh (identity matrix, applying the mesh's `matrixWorld` relative to the group if non-identity), `castShadow`/`receiveShadow` from the first source mesh, `userData.batch = true`. Track `id → [{ mesh, instanceId, which }]`. `setVisible` skips `setVisibleAt` when unchanged (called every map frame). Empty input → `meshes: []`.

- [ ] **Step 1: Failing tests** in `batch.test.ts` (build two `buildingModel`s from `buildings/index.ts` with same style + type, one with `color: '#123456'`):
  - `meshes.length` equals the number of distinct (material, which) pairs across both groups; total instances (`sum of mesh.instanceCount` / `_instanceInfo` via `getVisibleAt` loop) equals total source meshes.
  - The custom-colour wall material appears in exactly one batch, which holds one instance.
  - `setVisible(idA, 'body', false)` → every instance of A with which='body' reports `getVisibleAt(i) === false`, A's details and all of B unchanged; `setVisible(idA, 'body', true)` restores.
  - `batchBuildings([])` → `{ meshes: [] }`, `setVisible('x', 'body', false)` doesn't throw.
- [ ] **Step 2:** `npx vitest run src/three/batch.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement per the interface above.
- [ ] **Step 4:** tests pass; `npx tsc` green.

### Task 3: Wire batches into `buildScene`

**Files:**
- Modify: `src/three/scene.ts` (`BuiltScene.details` type, `setDetailVisibility`, building branch ~386-392, after the feature loop, `setSelection`, `dispose`), `src/three/facades.ts:147-149`
- Test: `src/three/three.test.ts`

**Interfaces:**
- Consumes: `batchBuildings`, `Batches` (Task 2).
- Produces: `BuiltScene.details: { center: THREE.Vector3; setVisible(on: boolean): void }[]` (the `object` field is removed). `setDetailVisibility(built, camera, maxDist)` signature unchanged, now calls `setVisible`.

- [ ] **Step 1: Failing tests** in `three.test.ts`:
  - 'draws buildings through batches, one copy at a time': scene with `house` + twin → `group.children` contains ≥1 `BatchedMesh`; the house's individual group (`group.children.find(o => o.userData.owner === house.id && o.isGroup)`) has `visible === false`; after `setSelection(new Set([house.id]))` it is visible and every batch instance of the house is hidden (check via the batch: count of visible instances drops by the house's mesh count); after `setSelection(new Set())` back to the start counts.
  - 'builds a roads-only scene without batches': `buildScene([road], …)` → no `BatchedMesh` in `group.children`, no throw.
  - Rewrite 'hides building details by camera distance' to assert via the detail batch: near → the apartment's detail instances visible; far / null → hidden (read `getVisibleAt` on the BatchedMeshes whose instances belong to details).
- [ ] **Step 2:** `npx vitest run src/three/three.test.ts` → the new/rewritten tests FAIL.
- [ ] **Step 3:** In the building branch: `model.visible = false`; push `{ id: x.id, group: model }` to a `buildings` list; push a details entry `{ center, setVisible }` whose `setVisible(on)` sets the building's batch details (`'details'`) and `model.userData.details.visible = on`. Cars on the overlay push `{ center, setVisible: (on) => { m.visible = on } }`. After the loop (where `owner = undefined`): `const batches = batchBuildings(buildings)`; `batches.meshes.forEach((m) => add(m))`. Add the `ponytail:` comment (individual geometry kept CPU-side; build on demand when selected if memory bites).
- [ ] **Step 4:** `setSelection`: for each building id, `group.visible = on` and `batches.setVisible(id, 'body', !on)` / `'details'` likewise (details: hidden in batch while selected; the group's own details group keeps its distance state). Keep the existing highlight swap.
- [ ] **Step 5:** `dispose`: BatchedMesh geometry is disposed by the existing traverse (`mesh.dispose()` for `isBatchedMesh`, like InstancedMesh); materials are shared and skipped as today.
- [ ] **Step 6:** `facades.ts` night patch: add `#ifdef USE_BATCHING\n nightP = batchingMatrix * nightP;\n #endif` beside the instancing branch.
- [ ] **Step 7:** `npx tsc` and `npm test` → all green (CityView/models3d compile unchanged).

### Task 4: Browser verification + docs

**Files:**
- Modify: `.claude/CLAUDE.md` (Status line + architecture note for `three/batch.ts`), memory `animation-request.md`

- [ ] **Step 1:** Dev server on 5317, Chrome "Browser 1"; regenerate the 60 ha town at 67.35,25.25 (`squareSite`, `fillBuildings: true`, `VARIANTS[0]`) if not present; open 3D; measure forced-render ms/frame day / traffic / night and `renderer.info.render.calls`. Pass: ≤ 33 ms, calls ≪ 1000.
- [ ] **Step 2:** 156-apartment + 8-street scene: render ≤ 14 ms (no slower than before).
- [ ] **Step 3:** Check Review Focus 1–3 by hand: click-select / deselect a building, shift multi-select, drag-move and rotate a selected building (preview + commit), zoom out (details hide, incl. the selected one), night (windows on batched buildings), 2D map overlay at zoom ≥ 16.
- [ ] **Step 4:** Update CLAUDE.md (architecture: `three/batch.ts` per-material BatchedMesh for buildings; status: big-town perf result) and the memory note; record measured numbers.
