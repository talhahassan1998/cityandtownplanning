# Road Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Curved roads (rounded corners with a radius), junction-linked point dragging, split / join, and a Curve radius field, in the 2D editor.

**Architecture:** `roads.ts` gets the pure `curveRoad`. Curved roads keep their design points in `attrs.pi` (JSON) and store the curve as geometry, so all consumers see the curve unchanged. The store gets `setRoadLine`, `moveRoadPoint`, `splitRoad`, `joinRoads`; MapCanvas hands Terra Draw the design line and routes its edits through those actions.

**Tech Stack:** TypeScript, Zustand store, Terra Draw, Turf, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-road-editing-design.md`

## Global Constraints
- Arc sampling ≤ 2 m; bends < 1° stay sharp; radius 0 → polyline unchanged; tangent length capped at half of each adjacent leg.
- Default radii when a road is first curved: local 15, collector 30, arterial 60, highway 150, otherwise 15 (m).
- `attrs.pi` = JSON string of `[lng, lat][]`; `attrs.curveRadius` number (m). Roads without `pi` behave exactly as today.
- Junction link tolerance 1 m; every road edit is one undo step; coordinates written rounded to 9 decimals (`roundGeometry` / round in `toGeo`).
- Not a git repo: no commits; gates `npx tsc` + `npm test` after each task.

## Review Focus
1. A closed-loop road (first point = last) or a 2-point road: curve / split / join don't crash; a loop's start/end stays a sharp corner.
2. Dragging a junction where three roads meet, one curved: all three follow; the curved one recomputes its curve.
3. Undo after a junction drag / split / join restores every touched road in one step.
4. A road with `pi` rotated with the knob, then a bend point dragged: the curve stays at the rotated position (pi was rotated too).
5. Setting Curve radius back to 0: geometry returns to the design line (sharp corners), `pi` kept.

Tests for 1–5 are in Tasks 1–3.

---

### Task 1: `curveRoad`

**Files:** Modify `src/roads.ts`; test `src/roads.test.ts`.

**Interfaces — Produces:**
```ts
/** Road through design points `pi` with each interior bend rounded to an arc of `radiusM` (tangent to both legs, ≤ 2 m samples). */
export function curveRoad(pi: Position[], radiusM: number, toLocal: (p: Position) => [number, number], toGeo: (p: [number, number]) => Position): Position[]
export const DEFAULT_CURVE: Record<string, number> // { local: 15, collector: 30, arterial: 60, highway: 150 }
export function defaultCurve(roadClass: string): number // DEFAULT_CURVE[c] ?? 15
```
Arc per interior vertex B between A and C: turn angle θ (between AB and BC directions); tangent length t = R·tan(θ/2), capped at min(|AB|, |BC|)/2 (then R = t / tan(θ/2)); tangent points T1 = B − t·u(AB), T2 = B + t·u(BC); centre on the inside bisector at distance R/cos(θ/2) from B; sample the arc T1→T2. Skip bends with θ < 1° (keep B). A closed polyline (first == last) keeps its first/last vertex sharp.

- [ ] **Step 1: Failing tests** in `roads.test.ts` (local metres via `frame` of a test origin):
  - `'rounds a right-angle bend into an arc of the given radius'`: pi (0,0)→(100,0)→(100,100), R 20 → first point (0,0) and last (100,100) unchanged (≤ 1e-6 m); every curve point between T1 (80,0) and T2 (100,20) lies 20 ± 0.05 m from the centre (80,20); consecutive points ≤ 2.05 m apart; points (80,0) and (100,20) present (± 0.05 m).
  - `'shrinks the radius on short legs'`: (0,0)→(10,0)→(10,10), R 50 → tangent points at (5,0) and (10,5) (± 0.05 m).
  - `'leaves straight lines and radius 0 alone'`: (0,0)→(50,0)→(100,0) R 20 → 3 points equal to input; any pi with R 0 → equals input.
  - `'keeps a loop's start sharp'` and `'handles two points'`: no throw, finite coordinates; 2-point pi → returned unchanged.
  - `'defaultCurve'`: local 15, arterial 60, unknown 15.
- [ ] **Step 2:** `npx vitest run src/roads.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** pass; `npx tsc`; `npm test` green.

### Task 2: Store — design line, curve radius, junction drag

**Files:** Modify `src/store.ts`; test `src/store.test.ts`.

**Interfaces — Consumes:** `curveRoad`, `defaultCurve` (Task 1). **Produces:**
```ts
/** The road's design line: parsed attrs.pi, else its geometry coordinates. */
export function designLine(f: PlanFeature): Position[]
// State actions
setRoadLine(id: string, line: Position[]): void          // pi (if curved) or geometry := line; geometry recomputed; one undo step
moveRoadPoint(id: string, from: Position, to: Position): void // moves that point and every other road's end/design point within 1 m of `from` to `to`; one undo step
```
Helpers inside store.ts: `withLine(f, line, settings?)` returns the road with `pi`/geometry set (if `curveRadius > 0`: `pi = JSON.stringify(line)`, geometry = `curveRoad(line, r, …)` with `frame(line[0])`; else geometry = line, `pi` kept as is if present). `updateFeature`: when `patch.attrs.curveRadius` is set on a road → if no `pi`, `pi` := current geometry; recompute geometry (radius 0 → geometry = design line). `rotateFeatures` / `moveFeatures` / paste `translate`: for roads with `pi`, transform `pi` the same way (rotate about the geometry centre / translate) and recompute.

- [ ] **Step 1: Failing tests** (`store.test.ts`, build roads with `makeFeature('road-local', lineString, { width: 12, roadClass: 'local' })` in a fresh project):
  - `'curves a road when a radius is set and straightens it at 0'`: L-shaped road; `updateFeature(id, { attrs: { curveRadius: 20 } })` → geometry has > 10 points, `JSON.parse(attrs.pi)` equals the 3 original points; then `curveRadius: 0` → geometry equals the 3 points, `pi` still present.
  - `'moves every road meeting at a junction'`: roads A (0,0)→(100,0) and B (100,0)→(100,100) and C (100,0)→(200,0), plus D far away; `moveRoadPoint(A.id, [100,0] geo, [110,10] geo)` → A's last, B's first and C's first are at (110,10) (± 0.01 m); D unchanged; one undo (`useStore.temporal.getState().undo()`) restores A, B, C.
  - `'recomputes a curved road at a moved junction'`: B curved (radius 20) → after the move B's `pi[0]` is the new point and its geometry starts there.
  - `'keeps pi through rotate and move'`: curved road, `rotateFeatures([id], 90)` → `pi` rotated (its first point moved accordingly; geometry still = curveRoad(pi)); `setRoadLine(id, pi with one point moved)` → curve follows from the rotated position.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** pass; tsc; npm test green.

### Task 3: Split and join

**Files:** Modify `src/store.ts`; test `src/store.test.ts`.

**Interfaces — Produces:**
```ts
splitRoad(id: string, at: Position): void   // two roads (new ids, names "<name> (1)"/"(2)", same attrs), selection = both; one undo step
joinRoads(a: string, b: string): boolean    // one road (id of a, attrs of a); false + notice when no shared end (1 m)
```
Split on the design line: nearest point on it, inserted as the shared end; curved roads split `pi` and recompute both. Join: orient so a.end meets b.start (reverse either as needed), drop the duplicate point, concatenate design lines; `pi` kept if a is curved.

- [ ] **Step 1: Failing tests:** `'splits a road where you click'` (straight 0→200 m at 80 m → two roads ending/starting at 80 m, attrs equal, names suffixed); `'joins two roads that share an end'` (A 0→100, B reversed 200→100 → one road 0→100→200, B deleted, attrs of A); `'refuses to join roads apart'` (returns false, notice set, nothing changed); `'split then join round-trips'` (coordinates equal ± 0.01 m); `'splits a curved road on its design line'` (both halves have `pi`, joined geometry continuous); split/join on a 2-point road works.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** pass; tsc; npm test green.

### Task 4: Editor wiring, UI, browser check

**Files:** Modify `src/map/MapCanvas.tsx` (syncEditing, finish handler, knob, ContextMenu), `src/ui/Inspector.tsx` (FIELDS `curveRadius`, Join button for two roads), `.claude/CLAUDE.md`.

- syncEditing: roads hand Terra Draw `roundGeometry({ type: 'LineString', coordinates: designLine(f) })`; stopEditing compares against the design line.
- finish (select mode, road): `dragCoordinate` → find the one coordinate that changed between the old design line and the snapshot → `moveRoadPoint(id, old, new)`; any other action → `setRoadLine(id, snapshot coords)`.
- Knob on a curved road: preview rotates the design line; release → `rotateFeatures` (Task 2 handles pi).
- ContextMenu: menu state carries the clicked `lngLat`; items "Split road here" (one road selected, `splitRoad(id, lngLat)`) and "Join roads" (two roads selected).
- Inspector: `curveRadius: { label: 'Curve radius', unit: 'm' }`, shown for roads (default value shown = `defaultCurve(roadClass)` hint, empty = sharp); multi-selection of exactly two roads shows "Join roads".
- [ ] **Step 1:** tsc + npm test green.
- [ ] **Step 2:** Browser (dev server, fresh navigation; features made with the app store's `layerForFeature`): set Curve radius on an L-bend → curve in 2D and 3D; drag a bend handle → curve follows; drag a junction → connected roads follow; right-click → Split; select both → Join; rotate a curved road with the knob, then drag a bend; Ctrl+Z after each.
- [ ] **Step 3:** CLAUDE.md (roads: `pi`/`curveRadius`, store road actions) + final review.
