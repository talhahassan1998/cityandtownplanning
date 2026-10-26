# Water & Sewer Flow + Underground View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-lay water mains and sewers under a town's streets, derive flow direction and depth, and show them as animated pipes in an X-ray "Underground" mode of the 3D view — with zero cost while the mode is off.

**Architecture:** `src/utilities.ts` (pure) lays pipe drafts along `buildRoadGraph` edges. `src/pipeflow.ts` (pure) turns the project's water/sewer lines into a `FlowNet` (oriented 3D polylines + manholes). `src/three/pipes.ts` builds merged tube meshes with a pulse shader patch and a ghost-material swapper; `buildScene` exposes a lazy `setUnderground` and `pipeTime`; CityView adds the checkbox and drives time.

**Tech Stack:** TypeScript, Three.js 0.186 (TubeGeometry/merged BufferGeometry, onBeforeCompile), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-pipe-flow-underground-design.md`

## Global Constraints
- Offsets: water main 2 m one side, sewer 1.5 m the other side; skip a street if that network already has a pipe within 6 m of the street edge's midpoint.
- Depths: water 1.2 m (pipe centre below ground); sewer ≥ 1.5 m, invert falls ≥ 0.005 × length downstream; `attrs.depth` overrides.
- Speeds: water 1.0 m/s, sewer 0.6 m/s; pulse spacing 8 m; colours water #4fc3f7 on #1565c0, sewage #d7a86e on #5d4037.
- Tube radius `max(diameter_mm / 2000, 0.25)` m, 6 radial segments; ghost opacity: buildings (batch meshes) 0.12, everything else 0.25; ghosts transparent + depthWrite false.
- Underground off: no pipe geometry, no flow model, no per-frame work. On: ≤ 3 pipe draw calls; first build ≤ 300 ms (big town); "Lay" ≤ 1 s (big town).
- Shared materials (`userData.shared`) are never mutated or disposed — ghosts are clones, cached per original.
- Laid features are "preliminary"; command = toolbar button "Lay pipes" (lucide `Droplets`) next to "Plan wizard" (there is no Utilities menu); wizard checkbox "Lay water & sewer under streets" (Brief `layPipes`, default true).
- Not a git repo: no commits; gates `npx tsc` + `npm test` after every task.

## Review Focus
1. Running "Lay pipes" twice, or on a project with hand-drawn pipes: no duplicates along already-piped streets.
2. A network with two sources or a loop (grid): every pipe still gets a single direction, no NaN, sewer still falls downstream.
3. Underground toggled on → selection changed → toggled off: the selection highlight (litOf copies) and all originals come back; nothing stays ghosted.
4. Scene rebuild while Underground is on (feature edited): new scene comes up in Underground mode with fresh pipes; old pipe geometry disposed.
5. Hilly terrain (`ground` varies ±20 m): sewer depth grows where the ground rises downstream; pipes never above ground.

Tests for 1, 2, 3, 5 are in Tasks 1–3; 4 is checked in the browser (Task 4).

---

### Task 1: Lay water & sewer

**Files:** Create `src/utilities.ts`, `src/utilities.test.ts`; modify `src/masterplan.ts` (Brief `layPipes`), `src/ui/WizardDialog.tsx` (checkbox + accept), `src/ui/Toolbar.tsx` (button).

**Interfaces:**
```ts
type XY = [number, number]
export interface PipeDraft { type: 'water-main' | 'sewer' | 'water-tank' | 'treatment'; geometry: LineString | Point | Polygon; attrs: Record<string, unknown>; name: string }
/** Pipes under every street (road graph edges) plus a tank / treatment plant when missing. Pure. */
export function layWaterSewer(features: PlanFeature[], toLocal: (p: Position) => XY, toGeo: (p: XY) => Position): PipeDraft[]
```
Per edge of `buildRoadGraph(features, toLocal, 'left')`: polyline `[nodeA.p, ...edge.pts offset by d, nodeB.p]` (offset each interior vertex along the averaged normal; endpoints are the node points themselves), water d = +2, sewer d = −1.5. Skip per network when `features` already has a line of that network whose distance to the edge midpoint (`turf.pointToLineDistance`-style in local metres) ≤ 6 m. Tank: Point at the graph node nearest the centroid of all nodes, offset 8 m along the perpendicular of one of its edges, plus a water main node → tank. Plant: 80 × 60 rectangle (`footprint` from geo.ts) centred 50 m beyond the dead-end node (degree 1) farthest from that centroid, along its edge direction, plus a sewer node → plant edge midpoint nearest the node. attrs = `defaultAttrs(type)` (+ `status: 'planned'` not needed); names "Water main (laid)", "Sewer (laid)", "Water tank (laid)", "Treatment plant (laid)".

- [ ] **Step 1: Failing tests** (`utilities.test.ts`; wizard town = `generatePlan(squareSite([67.35, 25.25], 20), { ...DEFAULT_BRIEF, fillBuildings: false }, VARIANTS[0])` turned into features with `makeFeature`; `F = frame([67.35, 25.25])`):
  - `'lays a connected water and sewer network under a wizard town'`: features + laid drafts → `analyzeNetworks(all)` has no issue with code `disconnected`, `no-source` or `separation` for networks water/sewer; drafts contain ≥ 1 `water-tank` and ≥ 1 `treatment`; water-main count = sewer count = number of road-graph edges.
  - `'lays nothing twice'`: run again on features + first drafts → `[]`.
  - `'keeps hand-drawn pipes'`: a street with an existing `sewer` along it → drafts contain its water main but no sewer for it.
  - `'adds no tank or plant when the project has them'`: features incl. a `water-tank` and `treatment` → no source drafts.
  - `'handles no streets'`: `layWaterSewer([], …)` → `[]`.
  - `'is fast on a big town'`: 60 ha wizard town (as in the perf work) → `layWaterSewer` < 1000 ms.
- [ ] **Step 2:** `npx vitest run src/utilities.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `layWaterSewer`.
- [ ] **Step 4:** UI: Toolbar button "Lay pipes" → `layWaterSewer(Object.values(features), frame(meta.center).toLocal, .toGeo)` → `addFeatures(drafts.map(d => makeFeature(d.type, d.geometry, d.attrs, d.name)))`, notify `"Laid N water mains and M sewers (preliminary)…"` or `"Every street already has water and sewer pipes."`. Wizard: Brief `layPipes: true` in `DEFAULT_BRIEF`; checkbox under "Fill plots with buildings"; in `accept`, when `b.layPipes`, run `layWaterSewer` on `[...existing features, ...kept, ...add]` and append its drafts to the same `addFeatures` call (one undo step).
- [ ] **Step 5:** utilities tests pass; `npx tsc`; `npm test` green.

### Task 2: Flow model

**Files:** Create `src/pipeflow.ts`, `src/pipeflow.test.ts`.

**Interfaces:**
```ts
export type XYZ = [number, number, number]
export interface FlowPipe { id: string; network: 'water' | 'sewer'; pts: XYZ[] /* e, n, y = pipe-centre elevation, in flow order */; diameter: number; speed: number; connected: boolean }
export interface FlowNet { pipes: FlowPipe[]; manholes: [number, number, number, number][] /* e, n, yPipe, yGround */ }
export function pipeFlow(features: PlanFeature[], toLocal: (p: Position) => XY, ground: (e: number, n: number) => number): FlowNet
```
Graph per network: line features with `networkOf(f) === net` (water/sewer only), endpoints merged within `NET_DEFAULTS.tolerance` (1 m); sources = features of `NETWORKS[net].sources` types (points: their position; polygons: nearest pipe endpoint within 60 m of the polygon's ring). Dijkstra over pipe lengths from the source nodes. Orient: water pipe runs from its endpoint with smaller distance; sewer pipe runs from the endpoint with larger distance (towards the plant). Unreached pipes: `connected: false`, original vertex order. Elevation: water `y = ground − (depth ?? 1.2)` per vertex; sewer: process nodes in decreasing distance; `inv(node) = min(ground(node) − (depth ?? 1.5), min over incoming pipes (inv(upstream end) − 0.005 × pipe length))`; interior vertices interpolate linearly by length between the two node values, then are clamped to `≤ ground(vertex) − 1.5` while keeping monotone (take running min along the flow). Manholes: sewer graph nodes with degree ≠ 2, plus `manhole` point features (snapped to the nearest sewer vertex for `yPipe`).

- [ ] **Step 1: Failing tests** (local metres with `frame`; helper builds features from local polylines):
  - `'sends water away from the tank'`: tank at (0,0), pipes (0,0)→(100,0)→(200,0) drawn in reverse vertex order → both pipes' `pts[0]` is the end nearer the tank; `connected` true.
  - `'sends sewage to the plant'`: plant polygon at x = 300, sewers along x 0→100→200→290 → each pipe's last point is the plant-side end.
  - `'always falls downstream'`: same sewer with `ground = (e) => 0.05 * e` (ground rising towards the plant) → along every pipe and across pipe joins, `y` is non-increasing in flow order and `y ≤ ground − 1.5 + 1e-9` at every vertex.
  - `'orients every pipe once on a loop with two sources'`: a 3 × 3 grid of water pipes with tanks at two corners → every pipe has finite coordinates and each pipe's start distance ≤ end distance (re-run Dijkstra in the test via the public result: assert no pipe whose `pts` contain NaN, and count of pipes = input count).
  - `'leaves unconnected pipes still'`: a water pipe not touching the network → `connected: false`.
  - `'honours a set depth'`: `attrs.depth = 3` water pipe on flat ground → all `y === -3`.
  - `'puts manholes at sewer junctions and ends'`: T of sewers → 4 manholes (3 ends + junction), each `yGround > yPipe`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** pass; `npx tsc`; `npm test` green.

### Task 3: Pipes, ghosts and the scene hook

**Files:** Create `src/three/pipes.ts`, `src/three/pipes.test.ts`; modify `src/three/scene.ts` (`BuiltScene`), `src/three/CityView.tsx` (checkbox, time, terrain ghost, picking).

**Interfaces:**
```ts
// pipes.ts
export interface PipeMeshes { group: THREE.Group; /** feature id of a hit on a pipe mesh */ pick(hit: THREE.Intersection): string | undefined; setTime(t: number): void; dispose(): void }
export function pipeMeshes(net: FlowNet): PipeMeshes
/** Swaps each mesh's material for a cached transparent copy (on) or back (off). Never touches originals. */
export function ghost(objects: THREE.Object3D[], on: boolean, opacityOf: (o: THREE.Object3D) => number): void
// scene.ts BuiltScene additions
setUnderground(on: boolean, extra?: THREE.Object3D[]): void   // extra = CityView's terrain mesh
pipeTime(t: number): void                                       // no-op until pipes exist
```
`pipeMeshes`: per network one merged geometry of tubes (one `TubeGeometry`-like sweep per pipe along its `pts`, radius per Global Constraints, 6 radial segments, 1 segment per polyline edge) with a float attribute `flow` = metres from the pipe start; material `MeshStandardMaterial` (water/sewer base colour) patched by `onBeforeCompile` with uniforms `uTime`, `uSpeed`, `uPulse` (lit colour) and `uOn` per vertex (attribute `live` = 1 when `connected`): emissive += `uPulse * live * smoothstep(0.75, 1.0, fract((flow - uTime*uSpeed)/8.0))`. Manholes: merged cylinders (r 0.6 m) from `yPipe` to `yGround`. Triangle ranges per pipe id for `pick` (binary search, like the plot mesh). `castShadow` false. `setTime` writes the uniforms only.
`ghost`: `userData.ghostOf` stores the original on the mesh; ghost material cache `Map<Material, Material>` (clone + `transparent = true; opacity; depthWrite = false`; keep `onBeforeCompile`/`customProgramCacheKey` via the existing `withNight`-style re-attach if present); arrays of materials map element-wise. Skips meshes of the pipe group and `THREE.Line`s.
`setUnderground(on)`: first `on` → `pipeFlow(features, L, elevLocal)` + `pipeMeshes` added to `group`, pipe meshes pushed to `pickables`; `ghost([...group children except pipes, ...extra], on, o => o.userData.batch ? 0.12 : 0.25)`; `pipes.group.visible = on`; off removes pipe meshes from `pickables`. `pick` in BuiltScene delegates to `pipes.pick` when `hit.object` is a pipe mesh. `setSelection` while underground: re-apply `ghost(on)` to meshes whose material it swapped (call `ghost` again after the swap). `dispose` disposes pipe geometry/materials and ghost clones.
CityView: Opts `underground: false`; checkbox "Underground" in the panel next to "Cars"; effect calls `built.setUnderground(o.underground, terrain ? [terrain.mesh] : [])` on toggle and after every rebuild; loop: when playing, `pipeT += dt` (real seconds) and `built.pipeTime(pipeT)`.

- [ ] **Step 1: Failing tests** (`pipes.test.ts`, with a tiny `FlowNet` literal; and `three.test.ts` for the scene hook):
  - `'builds one mesh per network plus manholes'`: net with 2 water + 1 sewer pipe + 2 manholes → `group.children.length === 3`.
  - `'runs the flow attribute along the flow direction'`: water mesh `flow` values at vertices nearer `pts[0]` < those nearer the end.
  - `'picks the pipe that was hit'`: ray straight down onto pipe 2's midpoint (no ground) → `pick(hit) === pipe 2 id`.
  - `'only writes uniforms on setTime'`: geometry attribute versions unchanged after `setTime(5)`; material uniform `uTime` (via the patched shader's uniforms object stored on `material.userData.uniforms`) === 5.
  - `'ghosts and restores without touching originals'`: two meshes sharing one material (`userData.shared = true`) → `ghost(on)` gives both the same transparent clone with opacity per `opacityOf`; original's `transparent`/`opacity` unchanged; `ghost(off)` restores the exact original objects.
  - scene (`three.test.ts`) `'builds pipes only when underground'`: scene with a street + laid pipes (use `layWaterSewer`) → before `setUnderground(true)` no pipe meshes in `group`; after → present and pickable; `setUnderground(false)` → hidden, not in `pickables`, every mesh material is its original; a selection change while on keeps ghosts (`setSelection(new Set([houseId]))` → that building's group materials are transparent copies), off → highlight originals (`litOf`) restored.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement `pipes.ts`, the BuiltScene hook, CityView wiring.
- [ ] **Step 4:** pass; `npx tsc`; `npm test` green.

### Task 4: Browser verification + docs

- [ ] **Step 1:** Dev server 5317 (set `dirty: false` before any reload). Big town: "Lay pipes" (time it; ≤ 1 s), 3D, Underground on (time first build; ≤ 300 ms): water pulses out from the tank, sewage towards the plant, manholes reach the surface, ghosts read clearly (no flicker); edit a feature while on (Review Focus 4); off restores the scene.
- [ ] **Step 2:** Forced-render medians on the charger: Underground off vs before this work (no change beyond noise); on ≤ +3 ms; `renderer.info.render.calls` on − off ≤ 3 (+ none in the shadow pass).
- [ ] **Step 3:** CLAUDE.md (utilities.ts, pipeflow.ts, three/pipes.ts; status) + memory.
