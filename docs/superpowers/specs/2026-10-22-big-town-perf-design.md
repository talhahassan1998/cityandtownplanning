# Big-town 3D performance — design

Date: 2026-10-22 · Status: approved in chat, spec awaiting review

## Goal
A wizard town of ~1000 buildings runs smoothly in the 3D view (and the zoom ≥16 map overlay) on the
target laptop (Intel UHD 620), with picking, selection highlight, 3D move/rotate, distance detail hiding
and night windows all behaving exactly as today.

## Measured problem (2026-10-22)
60 ha wizard town, 1038 buildings, 3D view, forced render + `readPixels` sync (immune to Chrome's rAF
throttling): **≈140 ms/frame (≈7 fps)**. 5.2k building meshes (≈5 per building; the body mesh has two
materials) → 6.4k draw calls, 12.7k with the shadow pass (96 ms/frame without shadows). Materials are
already shared (a few dozen distinct), so the cost is per-object draw overhead. Traffic step (1.1 ms)
and night lighting cost nothing measurable. 1.05 M triangles.

## Approach: one `THREE.BatchedMesh` per material
- **Single-material meshes.** `buildingModel` splits the extruded body (ExtrudeGeometry groups:
  caps, sides) into two meshes, caps and walls, so every building mesh has exactly one material.
  Recipes are untouched.
- **New `three/batch.ts`** (pure, tested): `batchBuildings(groups)` takes the per-building groups,
  buckets every mesh by material (main parts and `details` parts separately), and builds one
  BatchedMesh per bucket (geometry already in scene coordinates, identity instance matrix,
  `castShadow`/`receiveShadow` as the source meshes, per-object frustum culling on). It returns the
  meshes plus a `setVisible(id, which: 'body' | 'details', on)` that flips that building's instances.
  Attribute sets inside a bucket must match (walls: position/normal/uv; parts: position/normal) — they
  do, because buckets are per material and each material is only used by one kind of mesh.
- **`scene.ts` wiring.** Buildings are built as today and kept as the pickable groups (`owner`,
  `userData.id`, `baseMat`) but hidden (`visible = false`); raycasting ignores visibility, so picking and
  `built.pick` are unchanged. The batches are added to `group` once, after the feature loop.
- **Selection.** `setSelection` additionally shows the selected buildings' own groups (highlighted via
  the existing `litOf` swap) and hides their batch instances; deselecting reverses it. CityView's
  drag-move/rotate already moves `group.children` with `userData.owner`, i.e. the visible individual
  groups of the selected buildings — no CityView change needed.
- **Details by distance.** `BuiltScene.details` entries keep `center` and gain `setVisible(on)`;
  for buildings it drives the detail batch instances (and the individual `details` group when the
  building is selected). Cars on the map overlay keep plain `object.visible`. `setDetailVisibility`
  calls `setVisible`; callers (`CityView`, `map/models3d.ts`) stay as they are.
- **Night windows.** `facades.ts` night patch gains a `USE_BATCHING` branch
  (`nightP = batchingMatrix * nightP`) next to the instancing one, so it stays correct if a batch
  matrix is ever non-identity.
- **Dispose.** Batches dispose their own geometry; building materials stay shared (never disposed).

`ponytail:` the individual building geometry stays in CPU memory (never drawn unless selected) —
roughly doubles building geometry memory; upgrade path: build a group on demand when selected.

## Not in scope
The ≈9 s scene build time and triangle LOD. Revisit only if the target below is missed.

## Success criteria
- The same 1038-building town: ≤ 33 ms/frame (≥ 30 fps) day, with traffic, and at night, measured as
  above; draw calls in the low hundreds or fewer.
- The 156-apartment / 8-street scene is no slower than before (9–14 ms render).
- Browser re-check: click-select, multi-select highlight, drag-move + rotate ring (preview and commit),
  library drop, detail hiding when zooming out, night windows/lamps, map overlay at zoom ≥16.
- Tests: `batch.ts` (bucketing by material, instance count, per-id visibility for body/details);
  scene test that a selected building's group becomes visible and its batch instances hidden, and back;
  existing pick/selection/detail tests keep passing (updated only where they asserted `object.visible`).
