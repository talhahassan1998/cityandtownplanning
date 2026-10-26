# Traffic Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Busy junctions in the 3D animated traffic get traffic lights (each arm green in turn) that cars obey, shown as signal heads whose lamps change with the phase.

**Architecture:** `drive.ts` marks signalled graph nodes and owns the pure timing function `signalAt` plus the car rules (box becomes a per-node list). A new `three/signals.ts` builds instanced signal heads from the graph and recolours lamps; `scene.ts` wires it to `traffic.step`.

**Tech Stack:** TypeScript, Three.js 0.186 (InstancedMesh + instanceColor), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-traffic-signals-design.md`

## Global Constraints
- Signalled node: ≥ 3 edges and ≥ 2 of them with `cls` ≠ `'local'` (collector / arterial / highway).
- Timing: `GREEN = 20`, `AMBER = 3`, `ALL_RED = 2` s; cycle = 25 s × arms; arm order = by angle clockwise from east.
- Amber run-through: a car may enter on amber only if `v² / (2·4) > distance to its lane end`.
- Give-way (unsignalled) junction behaviour unchanged: one car in the box, exit lane must have room.
- Release valve unchanged (60 s / 20 s off-screen) but counted in `Traffic.dropped`.
- Signal heads are scenery (not pickable); lamps readable at night (unlit material).
- Big-town frame time stays ≈ 32 ms median on the charger.
- Not a git repo: no commit steps; gates = `npx tsc` + `npm test` green after each task.

## Review Focus
1. A car already in the box when its arm turns red must finish its turn (never frozen inside the box).
2. Junction with an arm whose lane is zero-length (very short edge between two signalled nodes) — no car stuck at a red it can never see the end of; no NaN in `signalAt`.
3. T-junction (3 arms) cycles 75 s; a dead-end U-turn node is never signalled.
4. Driving side right vs left: heads sit on the driver's side of the approach for both.
5. Clock at ×3600 (`dt` clamped to 0.1 per step, many steps per frame): lamp colours follow `traffic.time`, no flicker from per-step updates.

Tests for 1–4 are in Tasks 1–3; 5 is checked in the browser (Task 4).

---

### Task 1: Signalled nodes, timing, sim clock and drop counter

**Files:**
- Modify: `src/three/drive.ts` (`GNode`, end of `buildRoadGraph`, `Traffic`, `createTraffic` step + valve)
- Test: `src/three/drive.test.ts`

**Interfaces:**
- Produces:
```ts
export interface GNode { id: number; p: XY; r: number; edges: number[]; signal?: { arms: number[]; offset: number } }
export const GREEN = 20, AMBER = 3, ALL_RED = 2
export type Light = 'green' | 'amber' | 'red'
/** Light shown to cars arriving on `edge` at signalled `node` at sim time t (s). Non-arm edge → 'red'. */
export function signalAt(node: GNode, edge: number, t: number): Light
export interface Traffic { cars: MovingCar[]; time: number; dropped: number; step(...): void; poses(): CarSpot[] }
```
`buildRoadGraph` sets `signal = { arms, offset: 0 }` (arms sorted by the angle of each edge's first 10 m leaving the node, clockwise from east = `-atan2(dy, dx)`); `createTraffic` sets each `offset = r() * cycle` from its seed (mutating the graph's nodes is acceptable — rebuilt per scene). Cycle phase: `k = floor(((t + offset) mod cycle) / 25)`, `u = ((t + offset) mod 25)`; arm k green for u < 20, amber for u < 23, else red.

- [ ] **Step 1: Failing tests** (add a `collector(pts)` helper like `street` with `roadClass: 'collector'`, width 14):
  - `'signals busy junctions only'`: collector cross → hub `signal.arms.length === 4`; local cross → no `signal`; a collector street crossed by a local street (2 collector arms + 2 local) → signalled with 4 arms; a local street ending on a local street (T, 0 non-local arms) → not; dead-end and 2-edge nodes never signalled.
  - `'cycles each arm green, amber, then all-red'`: node `{ ..., signal: { arms: [10, 11, 12, 13], offset: 0 } }` → `signalAt(n, 10, 0) === 'green'`, `(n,10,19.9)` green, `(n,10,20)` amber, `(n,10,22.9)` amber, `(n,10,23)` red, `(n,11,23)` red, `(n,11,25)` green, `(n,10,100)` green (cycle 100), `(n,99,0)` red; with `offset: 25` → `(n,11,0)` green; for every t in 0..100 step 0.5 at most one arm is non-red.
  - `'counts the sim clock'`: `t = createTraffic(cross(), …)`; after 100 steps of 0.1 → `t.time` ≈ 10 (`toBeCloseTo(10, 5)`); one `step(5, …)` adds 0.1 (clamped); `t.dropped === 0` on a fresh sim.
  - `'counts release-valve drops'`: a single local street with a car blocked forever is hard to build; instead reuse the dense-arterial-grid loop with `visible = () => false` and assert `t.dropped > 0` there **with all `signal`s deleted** (give-way, the old jam case).
  - `'gives each signalled junction its own offset'`: collector 3×3 grid, two different hub nodes → offsets differ; same seed twice → same offsets.
- [ ] **Step 2:** `npx vitest run src/three/drive.test.ts` → new tests FAIL.
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** drive tests pass; `npx tsc` clean; `npm test` green.

### Task 2: Cars obey the signals

**Files:**
- Modify: `src/three/drive.ts` (`holder` → `box: Car[][]`, step phases 1 and 2, spawn check)
- Test: `src/three/drive.test.ts`

**Interfaces:**
- Consumes: `signalAt`, `GNode.signal`, `Traffic.time` (Task 1).
- Produces: no new exports. `MovingCar.inNode` semantics unchanged (several cars may now share an `inNode` at signalled nodes only).

Rules (from the spec): unsignalled node — enter iff box empty and `backRoom(nx) ≥ 0` (today's rule). Signalled node — head car enters iff light for `ln.e.id` is green, or amber and `v²/8 > ln.len − c.s`; `backRoom(nx) ≥ 0`; every car in the box has `from` arm = `ln.e.id` (store the arriving edge on the car when it enters, e.g. `c.via = ln.e.id`); and the last box car that came from the same lane `ln` has `s ≥ its L + 2`. Lane following keeps the gap to the last box car from the same lane (replacing `holder[ln.to]?.at === ln`). Box cars always finish their turn regardless of the light. Spawning at `ln.from` requires that node's box to be empty (today: `holder[ln.from]`).

- [ ] **Step 1: Failing tests** (helper `collectorCross()` = two 400 m collectors crossing at the origin):
  - `'stops cars on red at a signalled junction'`: run 120 s at hour 8, every step: for each car with `inNode === hub`, its `via` arm… (not exported) — instead assert from the outside: record, on the step a car first appears with `inNode === hub`, the light `signalAt(hub, edgeBefore, t.time)` where `edgeBefore` = the car's `edge` on the previous step; must be `'green'` or `'amber'`. Expect ≥ 5 entries recorded.
  - `'never mixes two arms in a signalled box'`: same run; per step, the set of previous-step edges of cars inside the hub box has size ≤ 1.
  - `'streams several cars through on green'`: same run; at some step ≥ 2 cars have `inNode === hub`.
  - `'lets a car in the box finish when its light turns red'`: same run; no car keeps `inNode === hub` with `v < 0.1` for more than 3 s.
  - `'keeps give-way junctions to one car'`: existing `'never puts two cars in one junction box'` stays as is (local cross) and passes.
  - `'drops fewer stuck cars with signals than give-way'`: collector grid 4×4 at 200 m spacing; run 30 sim-minutes at hour 8 with `visible = () => true`; `withSignals.dropped < giveWay.dropped` where `giveWay` uses a deep copy of the graph with every `signal` deleted. (If give-way drops 0 on this grid, enlarge to arterials / 150 m spacing until it drops > 0 — record the chosen layout as a ruling.)
  - `'handles a zero-length lane between signalled nodes'`: two parallel collectors 12 m apart crossed by two collectors → runs 60 s without throwing and with no NaN in `poses()`.
- [ ] **Step 2:** run → new tests FAIL (current code admits one car, ignores lights).
- [ ] **Step 3:** Implement the rules above.
- [ ] **Step 4:** all drive tests pass (incl. the existing dense-grid, determinism, short-edge, dt-clamp tests); `npx tsc`; `npm test` green.

### Task 3: Signal heads in the scene

**Files:**
- Create: `src/three/signals.ts`, `src/three/signals.test.ts`
- Modify: `src/three/scene.ts` (build graph once, add heads, update in `traffic.step`)

**Interfaces:**
- Consumes: `RoadGraph`, `signalAt`, `Light` (Task 1).
```ts
export interface SignalHeads {
  meshes: THREE.InstancedMesh[]          // [poles, housings, lamps]
  /** Recolours lamps for sim time t; only touches instanceColor when some head's light changed. */
  update(t: number): void
}
/** One head per signalled arm: on the driver's side of the approach, 1 m back from the box edge, facing oncoming cars. */
export function signalHeads(g: RoadGraph, side: 'left' | 'right', ground: (e: number, n: number) => number): SignalHeads
```
Placement: for arm edge e at node n, unit vector `u` from the node along e (first 10 m), position = `n.p + u·(n.r + 1) + perp·(e.width/2 + 0.5)` where `perp` is the driver's side for cars approaching the node (left driving: their left = node-ward travel `−u` rotated; use `g.sigma` the same way `lanePose` offsets lanes so it matches the lane side); head faces along `u` (towards approaching cars). Pole 4.5 m (cylinder r 0.08), housing box 0.35 × 1.0 × 0.3 at the top, lamps (3 small spheres/circles) stacked red/amber/green top→bottom. Lamp material `MeshBasicMaterial` with instance colours: lit `#ff2a1a` / `#ffb300` / `#2ee66b`, unlit = 0.12 × those. Poles/housings: dark grey standard material, `castShadow` true; lamps no shadow. Empty graph / no signals → three meshes with count 0 (or empty `meshes`).

- [ ] **Step 1: Failing tests** in `signals.test.ts` (build a collector cross graph with `buildRoadGraph` as in drive.test.ts, set `offset` 0):
  - `'puts one head per signalled arm'`: housings `count === 4`, lamps `count === 12`; local cross → 0 heads.
  - `'lights exactly the current phase'`: `update(0)` → for the head of `arms[0]` the green lamp colour is the lit green, its red lamp unlit; other heads' red lit. `update(21)` → arms[0] amber lit. Read via `lamps.getColorAt(i, c)`.
  - `'only rewrites colours when a light changes'`: after `update(1)`, record `lamps.instanceColor!.version`; `update(2)` → version unchanged; `update(21)` → version increased.
  - `'places heads on the driver side'`: for an E–W approach arm, heads for `'left'` and `'right'` are on opposite sides of the road centreline (sign of the perpendicular offset differs), both within `n.r + 2` of the node along `u`.
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** Implement `signals.ts`.
- [ ] **Step 4:** Wire into `scene.ts`: build `const graph = buildRoadGraph(shown, L, drive)` once (reuse it for `createTraffic` when moving), `const heads = signalHeads(graph, drive, elevLocal)`, add its meshes, `heads.update(0)`; in the moving branch call `heads.update(t.time)` after `t.step(...)`. Scene test in `three.test.ts`: a scene with a collector cross has an InstancedMesh with 12 lamp instances (`userData.signalLamps = true` set by `signalHeads`).
- [ ] **Step 5:** `npx vitest run src/three/signals.test.ts src/three/three.test.ts` pass; `npx tsc`; `npm test` green.

### Task 4: Browser verification + docs

**Files:**
- Modify: `.claude/CLAUDE.md` (architecture: signals; status), memory `animation-request.md`

- [ ] **Step 1:** Dev server 5317; in the big-town project (or a fresh wizard town), open 3D, find a signalled junction (spine × cross street), watch a full cycle at ×1: heads change green→amber→red per arm in turn, cars queue on red and stream on green; ×3600 (Review Focus 5) and night (lamps glow).
- [ ] **Step 2:** Forced-render median on the charger for the big town: ≈ 32 ms (no regression > 2 ms); compare `__view.built` traffic `dropped` over 5 minutes before/after is not needed — the unit test covers it.
- [ ] **Step 3:** Update CLAUDE.md (drive.ts: signals; `three/signals.ts`) and memory.
