# Road editing — design

Date: 2026-10-22 · Status: approved in chat, spec awaiting review

## Goal
Make roads properly editable in the 2D map: smooth curved bends with a set radius, extend / shorten /
split / join, junctions that move every road meeting there, and easy width / lanes / type changes — with
2D, 3D, traffic, plots and pipes following automatically.

## User decisions
- All four: reshape/curve, extend-shorten-split-join, junctions move together, width/lanes/type.
- Curves: rounded corners (tangent straights + circular arcs, radius per road).

## 1. Curves — `src/roads.ts` (pure, tested)
- `curveRoad(pi: Position[], radiusM: number, toLocal, toGeo): Position[]` — the road through the design
  points (`pi`), each interior bend replaced by a circular arc of `radiusM` tangent to both legs, sampled every
  ≤ 2 m of arc. The radius shrinks at a bend where the tangent length would exceed half of either adjacent
  leg (two neighbouring bends can't overlap). `radiusM = 0` or bends < 1° → the polyline unchanged.
- Road attrs: `curveRadius` (m; Properties field "Curve radius") and `pi` (the design points, JSON string
  of [lng, lat] pairs; attrs are string|number). Defaults by class when a road is curved for the first time:
  local 15, collector 30, arterial 60, highway 150; rail/cycle/path 15.
- Geometry stored = the curve (`curveRoad(pi, curveRadius)`), so every existing consumer (surfaces, 3D,
  lane markings, traffic graph, plots, pipes, exports, network checks) sees the real curve unchanged.
- Roads without `pi` behave exactly as today (geometry is the design line, radius 0). Setting Curve radius > 0
  on such a road copies its geometry into `pi` first.

## 2. Editing in 2D — `src/map/MapCanvas.tsx`
- A road with `pi` is handed to Terra Draw as its design line (`pi`), not the dense curve; on `finish`
  (drag point / add midpoint / delete point / drag feature) the new design line becomes `pi` and the geometry is
  recomputed. Rotate knob and Inspector transforms rotate/move `pi` too (store `rotateFeatures` /
  `moveFeatures` / `translate` paths apply the same transform to `pi`).
- Changing Curve radius in Properties recomputes the geometry immediately.

## 3. Junctions move together — store
- `moveRoadPoint(id, from: Position, to: Position)` (store action, one undo step): moves that design point of
  the road and, for every other road that has an end or design point within 1 m of `from`, moves that point
  to `to` as well; curved roads recompute. MapCanvas calls it when a Terra Draw `dragCoordinate` finishes on
  a road (the moved coordinate is the one that changed between the old and new design line).

## 4. Split / join / extend — store + UI
- `splitRoad(id, at: Position)`: splits the design line at the nearest point on the road into two roads with
  the same attrs (new ids, names "… (1)", "… (2)"), one undo step. UI: right-click a road → "Split road here".
- `joinRoads(a, b)`: two roads sharing an end (within 1 m) → one road, design lines concatenated in order
  (reversing b if needed), attrs of `a` (any classes); refuses with a notice when they don't share an end. UI: two roads selected → "Join roads" in Properties
  and the right-click menu.
- Extend / shorten: dragging an end point (already possible); drawing a new road from a road end snaps to it
  (existing vertex snapping), then Join.

## 5. Width / lanes / type
Existing fields stay; add "Curve radius" for roads. Verify every road attr change updates 2D surfaces and 3D
immediately (they derive from the features object).

## Not in scope
Spiral transitions, vertical alignment / grades, auto-regenerating plots after a road moves (they re-validate
as today), one-way roads.

## Success criteria
- Tests: `curveRoad` (90° bend → arc of the given radius tangent to both legs, endpoints unchanged, radius
  shrinks on short legs, 0 / straight → unchanged); a curved road keeps `pi` through rotate/move;
  `moveRoadPoint` moves the connected roads' points (and only those within 1 m), one undo step; `splitRoad` /
  `joinRoads` keep attrs, geometry continuous, round-trip join(split(r)) ≈ r.
- Browser: on a wizard town — set a curve radius, drag a bend point (curve follows), drag a junction (all
  roads follow), split and join a road; 3D, lane markings and traffic follow; editing stays responsive.
