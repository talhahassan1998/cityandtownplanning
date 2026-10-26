# Moving Traffic + Running Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lane cars in the 3D view drive, turn and give way at junctions, traffic volume follows the hour, and the clock can play so sun/sky/shadows move.

**Architecture:** A pure module `src/three/drive.ts` builds a road graph from street features and steps a seeded car simulation (no Three.js). `cars.ts` gains a fixed-capacity instanced fleet that is re-posed every frame. `buildScene` wires graph + fleet and exposes `traffic.step`; CityView's existing rAF loop advances the hour and steps traffic.

**Tech Stack:** TypeScript, Three.js 0.186 (InstancedMesh), Turf 7, Vitest, React 19, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-21-moving-traffic-time-design.md`

## Global Constraints
- `drive.ts` is pure (no `three` import); local metres e/n, headings degrees clockwise from east (project convention).
- Lane offsets come only from `laneLayout` × sigma (+1 left-hand, −1 right-hand traffic) — same as `placeCars`.
- Target speeds km/h: local 30, collector 40, arterial 50, highway 80; bus/truck × 0.85; lateral accel ≤ 2 m/s².
- Following: gap = 2 m + 2 s · v; accel ≤ 2 m/s², braking ≤ 4 m/s²; hard min gap 2 m.
- `MAX_MOVING = 600`; `demand(hour)` night 0.15, peaks 1.0 at 08:00 and 17:30, ~0.6 midday.
- Speeds offered: ×1 (default), ×60, ×600, ×3600; default playing; hour slider 0–24.
- Vehicle geometry/materials stay shared (`userData.shared`): never mutated or disposed.
- Bridges/tunnels not drivable (`ponytail:` comment).
- Project is not a git repo: "Commit" steps = run `npx tsc` + `npm test` green instead.

## Review Focus
- Plan with no streets (only parking/buildings) → `buildRoadGraph` returns an empty graph, `traffic` steps without error and has 0 cars. (Task 2 test)
- A single isolated straight street (two dead ends, no junction) → cars U-turn at ends, never stuck at v = 0 forever. (Task 2 test)
- Very short edges (< 2·junction radius, lane trimmed to ≤ 0) → no NaN poses; car passes straight onto the next node. (Task 2 test)
- Huge `dt` after a backgrounded tab → clamped to 0.1 s, no car jumps through another. (Task 2 test)
- Scene rebuild while playing → old fleet meshes disposed (InstancedMesh only), no shared geometry disposed. (Task 4 test)

---

### Task 1: Road graph

**Files:**
- Create: `src/three/drive.ts`
- Test: `src/three/drive.test.ts`

**Interfaces:**
- Consumes: `laneLayout(a, cls)`, `LaneLayout` (traffic.ts), `junctionPoints(line, others, 5)` (roads.ts, lng/lat), `componentDef`, `ROAD_CLASSES` (model.ts).
- Produces:
  ```ts
  type XY = [number, number]
  interface GNode { id: number; p: XY; r: number; edges: number[] /* edge ids touching */ }
  interface GEdge { id: number; cls: string; pts: XY[]; cum: number[]; len: number; a: number /* start node */; b: number /* end node */; lay: LaneLayout }
  interface RoadGraph { nodes: GNode[]; edges: GEdge[]; sigma: 1 | -1 }
  export function buildRoadGraph(features: PlanFeature[], toLocal: (p: Position) => XY, side: 'left' | 'right'): RoadGraph
  ```

- [ ] **Step 1: Write failing tests** in `drive.test.ts` (reuse the `feat`/`line`/`street` helpers pattern from `traffic.test.ts`):
  - `builds a T-junction as 3 edges meeting at one node`: streets (−100,0)→(100,0) and (0,0)→(0,100) ⇒ `edges.length === 3`, one node with `edges.length === 3`, 3 nodes of degree 1; junction node `r === 12/2 + 2`.
  - `builds a 4-way cross as 4 edges and is connected`: (−100,0)→(100,0) and (0,−100)→(0,100) ⇒ 4 edges; BFS over nodes from node 0 reaches all 5 nodes.
  - `joins ends within 5 m`: (0,0)→(100,0) and (103,0)→(200,0) ⇒ the two share a node.
  - `skips bridges, tunnels, rail and paths`: a `structure: 'bridge'` street and a rail line ⇒ `edges.length === 0`.
  - `sigma follows driving side`: left ⇒ 1, right ⇒ −1.
- [ ] **Step 2: Run** `npx vitest run src/three/drive.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `buildRoadGraph`.** Streets = LineString road features with `laneLayout` defined and `structure` grade (`// ponytail: bridges/tunnels are dead ends; drive on the deck height to include them`). For each street, cut points = its `junctionPoints` against the other streets plus its ends; map to local; split the local polyline at the arc-length positions of those points (project each point onto the polyline). Nodes are merged by position within 5 m (linear scan is fine). `r = max over touching edges of width/2 + 2`.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Verify** `npx tsc` clean.

### Task 2: Traffic simulation

**Files:**
- Modify: `src/three/drive.ts`
- Test: `src/three/drive.test.ts`

**Interfaces:**
- Consumes: `RoadGraph` (Task 1); `CarSpot`, `VehicleKind`, `VEHICLE_SIZE` (cars.ts); `SPACING` — export it from `traffic.ts`.
- Produces:
  ```ts
  export const MAX_MOVING = 600
  export function demand(hour: number): number
  export interface Traffic {
    cars: { id: number; kind: VehicleKind; edge: number; lane: number; s: number; v: number; inNode?: number }[]
    step(dt: number, hour: number, visible: (e: number, n: number) => boolean): void
    poses(): CarSpot[]
  }
  export function createTraffic(g: RoadGraph, o: { seed: number; ground: (e: number, n: number) => number }): Traffic
  ```
  `inNode` = id of the node whose junction box the car is in (turning), else undefined. `poses()` y = ground + 0.16 (`SURFACE_LIFT`), pitch from ground at ±L/2, roll 0.

- [ ] **Step 1: Write failing tests:**
  - `demand is low at night and peaks at rush hour`: `demand(3) ≈ 0.15` (±0.02), `demand(8) ≈ 1`, `demand(17.5) ≈ 1`, `demand(13)` in [0.5, 0.7], all values in [0.15, 1] for hour 0..24 step 0.25; `demand(24) === demand(0)`.
  - `keeps cars on their lane side`: straight street (−300,0)→(300,0), left-hand; after 20 s at hour 8, every pose with heading ≈ 0 (eastbound) has n > 0 and westbound (≈180) has n < 0; right-hand ⇒ mirrored.
  - `never puts two cars in one junction box`: 4-way cross (each arm 200 m, `lanes: 2`), hour 8, `visible = () => false`, 600 steps of 0.1 s; after each step, count cars per `inNode` ≤ 1.
  - `keeps the following gap`: same run; per (edge, lane), sorted by s, consecutive gaps (centre distance − half lengths) ≥ 2 − 1e-6.
  - `fewer cars at 03:00 than 08:00, never above MAX_MOVING`: run 120 s at each hour on the cross; `count(3) < count(8)`; count ≤ `MAX_MOVING` throughout.
  - `is deterministic per seed`: two traffics, same seed and steps ⇒ `poses()` deep-equal.
  - `turns back at dead ends`: single street (0,0)→(200,0), hour 8, 300 s; no car has v < 0.1 for more than 30 consecutive simulated seconds (track per id).
  - `handles an empty graph`: `createTraffic(buildRoadGraph([], …))`; step 10× ⇒ `cars.length === 0`, no throw.
  - `survives very short edges`: streets meeting with a 6 m middle edge; 60 s; every pose has finite e, n, y, heading.
  - `clamps big dt`: one `step(5, 8, …)` moves no car more than `v_max · 0.1 + ε`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Lane `s` runs from `r(a)` to `len − r(b)` in the lane's direction (dir −1 ⇒ measured from b). Per step (`dt = min(dt, 0.1)`):
  1. Target count = `min(MAX_MOVING, round(Σ lane length / SPACING[cls] · demand(hour)))`.
  2. Spawn (≤ 5 per step) at lane starts at dead ends or where `!visible(e, n)`, if the first 15 m are clear; remove cars reaching a dead end (or off-screen at any node) while count > target.
  3. For each car: leader = nearest car ahead on the same lane, else the car in the next node box / first car on its chosen exit lane; IDM-lite accel toward `vTarget` (class speed × kind factor, capped by `sqrt(2 · 2 / κ)` from curvature over the next 20 m); clamp position so the gap ≥ 2 m.
  4. At lane end: choose exit once (seeded rng; other edges at the node, U-turn only at degree 1); wait unless `node.holder` is empty; enter ⇒ `holder = id`, follow quadratic Bézier lane-end → node centre (control) → exit-lane start, parameterised by arc length; exit ⇒ clear holder.
  Seeded rng as in traffic.ts (`rng(seed)`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Verify** `npx tsc` + full `npm test`.

### Task 3: Fleet meshes + static-lane option

**Files:**
- Modify: `src/three/cars.ts`, `src/three/traffic.ts`
- Test: `src/three/cars.test.ts`, `src/three/traffic.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function carFleet(capacity: Partial<Record<VehicleKind, number>>): { meshes: THREE.InstancedMesh[]; update(poses: CarSpot[]): void }
  // traffic.ts
  export const SPACING: Record<string, number>
  export function placeCars(features, toLocal, side, ground, o?: { lanes?: boolean }): CarSpot[] // lanes default true
  ```
- [ ] **Step 1: Write failing tests:**
  - cars.test `carFleet poses instances and sets counts`: capacity `{ sedan: 3, bus: 1 }`; `update` with 2 sedans + 1 bus ⇒ sedan meshes `count === 2`, bus `count === 1`; matrix position of sedan 0 equals (e, y, −n); geometry/material are the same objects `carMeshes` uses. Extra poses beyond capacity are dropped (not thrown).
  - traffic.test `lanes: false leaves only parking and building cars`: a street + parking lot ⇒ with `{ lanes: false }` no spot lies on the road surface, parking spots unchanged vs default.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Extract the pose→matrix (`eu.set(...)`, `compose`) from `carMeshes` into one helper used by both; `carFleet` creates InstancedMesh per kind × slot with `setUsage(THREE.DynamicDrawUsage)`, `count = 0`, `frustumCulled = false` (instances move outside the initial bounds); `update` sets matrices + body colour, `count`, `instanceMatrix.needsUpdate`. `placeCars` skips section "2. lane traffic" when `o?.lanes === false`; export `SPACING`.
- [ ] **Step 4: Run** — PASS. **Step 5:** `npx tsc` + `npm test`.

### Task 4: Scene wiring

**Files:**
- Modify: `src/three/scene.ts` (`BuiltScene`, `SceneOptions`, cars block ~line 457)
- Test: `src/three/three.test.ts`

**Interfaces:**
- Consumes: `buildRoadGraph`, `createTraffic`, `MAX_MOVING` (Task 1–2), `carFleet` (Task 3).
- Produces: `BuiltScene.traffic?: { step(dt: number, hour: number, visible: (e: number, n: number) => boolean): void }`; `SceneOptions.moving?: boolean` (default true; `modelsOnly` map layer passes nothing → treat `modelsOnly` as `moving: false`, the 2D map stays static).
- [ ] **Step 1: Write failing tests** in three.test.ts:
  - `animates lane traffic when cars are on`: road scene ⇒ `built.traffic` defined; after `traffic.step(0.1, 8, () => false)` × 50, fleet meshes' total `count > 0`, and one sedan's matrix position changed between step 40 and 50.
  - `no traffic when cars are off or on the map layer`: `cars: false` ⇒ `traffic` undefined; `modelsOnly: true` ⇒ undefined and static lane cars present.
  - `dispose frees fleet instances, not shared parts`: as the existing dispose test, over fleet meshes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** When cars on and moving: static `placeCars(..., { lanes: false })`; `const t = createTraffic(buildRoadGraph(shown, L, side), { seed: hash of feature ids, ground: elevLocal })`; fleet capacity per kind = `MAX_MOVING` for sedan/hatch/suv split by their mix (ceil), bus/truck `MAX_MOVING/12`; add meshes to the group; `traffic.step = (dt, h, vis) => { t.step(dt, h, vis); fleet.update(t.poses()) }`. Existing dispose path covers InstancedMesh.
- [ ] **Step 4: Run** — PASS. **Step 5:** `npx tsc` + `npm test`.

### Task 5: Clock UI + loop, browser check, docs

**Files:**
- Modify: `src/three/CityView.tsx`, `.claude/CLAUDE.md` (Status, test count), `README.md` (3D section, one paragraph)

**Interfaces:**
- Consumes: `BuiltScene.traffic` (Task 4).
- [ ] **Step 1: Opts** gain `playing: boolean` (default true) and `speed: 1 | 60 | 600 | 3600` (default 1). Hour slider `min={0} max={24}`; a row with a Play/Pause icon button (lucide `Play`/`Pause`, `aria-label`) and a `<select>` of ×1/×60/×600/×3600.
- [ ] **Step 2: Loop.** In `loop()`, when `optsRef.current.playing`: `hour = (hour + dt * speed / 3600) % 24`; if it moved ≥ 1/60 h since the last sun placement, `placeSun()` and push the hour into React state (throttled — at most every 250 ms) so the slider moves; `built?.traffic?.step(dt, hour, visible)` where `visible(e, n)` tests a 10 m sphere at scene (e, ground, −n) against a `THREE.Frustum` built once per frame from the camera. Paused ⇒ neither advances.
- [ ] **Step 3: Verify** `npx tsc`, `npm test`, `npm run build` all green.
- [ ] **Step 4: Browser check** (work-laptop Chrome, `npm run dev -- --port 5317 --strictPort`, save before editing code): open a wizard plan in 3D; confirm cars move, turn, queue at a busy junction; ×3600 moves shadows and darkens the sky at night; Pause freezes both. Measure fps (`__view.renderer.info` + rAF counter over 5 s) with Cars on vs off on the ~300-building scene; accept ≤ 10% drop. Record numbers.
- [ ] **Step 5: Docs.** CLAUDE.md: add `drive.ts` to Architecture (one line), update test count and Status; README 3D paragraph.
