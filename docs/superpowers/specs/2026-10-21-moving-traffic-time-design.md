# Moving traffic + running time of day

## Goal
Bring the 3D view to life: lane cars drive, turn and queue, and the clock can run so the sun, sky and shadows move. Visual realism for presentations and walkthroughs — not a traffic model (no demand, counts or travel times). Pieces 1 + 2 of the "real-life animation" list (later: night lighting, pedestrians, ambient motion, signals, buses/flythrough/video).

## User decisions
- Purpose: visual realism (A). Traffic analysis is a separate future sub-project.
- Time: Play/Pause + speed choice; hour slider runs 0–24 and moves while playing; cars always drive at real speed (A).
- Traffic volume follows the hour of day (A).
- Junctions: random exit, give way when the junction is occupied (A).

## `src/three/drive.ts` — road graph + simulation (pure, no Three.js)
### Graph
`buildRoadGraph(features, toLocal, side) → RoadGraph`
- Streets = road LineStrings whose class has a `laneLayout` (highway, arterial, collector, local), `structure` grade only. Bridges/tunnels are not drivable: `ponytail:` cars treat them as dead ends; upgrade = drive on the deck height.
- Centrelines (local metres) are cut at `roads.ts` `junctionPoints` (5 m merge) and at ends; ends within 5 m share a node. Edge = polyline + cumulative arc length + `LaneLayout` + class.
- Node = position + junction radius `r` = max(width/2 of its edges) + 2 m (the "junction box"). Degree-1 nodes are dead ends.
- Lanes: `laneLayout` lanes with `dir` 1 drive start→end, −1 end→start; lateral offset = `off · sigma` (sigma +1 left-hand, −1 right-hand), exactly like `placeCars`. Lanes are trimmed `r` at each end (the junction box belongs to the node).

### Cars
`Car { id, kind, seed, edge, lane, s /* m along lane in its direction */, v /* m/s */, turn?: TurnPath }`
- Target speed: local 30, collector 40, arterial 50, highway 80 km/h; bus/truck × 0.85; on curves capped so lateral acceleration ≤ 2 m/s² (curvature from the next 20 m of the polyline).
- Following (IDM-lite): desired gap = 2 m + 2 s · v to the leader in the same lane (or in the junction it is about to enter / just left); accel ≤ 2 m/s², braking ≤ 4 m/s², never closer than 2 m (hard clamp).
- Junctions: when the lane end is within braking distance, the car picks an exit — uniformly among the node's other edge-lanes leaving the node, a U-turn only at a dead end — seeded per car. It enters only if the node is free (`node.holder` empty), else it stops at the box edge. Entering sets `holder`; the turn is a quadratic Bézier from its lane end to the exit lane start (control point = the node); leaving the box clears `holder`.
- Kinds: sedan/hatch/suv mix as `placeCars`; bus/truck ≈ 1 in 12 on non-local roads.

### Volume
- `demand(hour) ∈ [0.15, 1]`: smooth curve, night 0.15, peaks 1.0 at 08:00 and 17:30, ~0.6 midday.
- Capacity = Σ lane length / spacing (`SPACING` from traffic.ts), capped at `MAX_MOVING = 600` (`ponytail:` cap; LOD/instancing bands are the upgrade). Target = round(capacity · demand(hour)).
- Below target: spawn at a dead end, or at a lane start not visible to the camera (`visible(e, n)` callback), if the first 15 m of that lane are clear. Above target: remove cars that reach a dead end or are out of view.
- Seeded RNG (seed from the project features) — the same input and step sequence gives the same result.

### API
`createTraffic(graph, { seed, ground, side }) → { cars, step(dt, hour, visible), poses(): CarPose[] }`
`CarPose` = `CarSpot` (e, n, y, heading, pitch, kind, seed). y = ground at the centre + `SURFACE_LIFT`; pitch from ground samples at front and back; roll 0. `dt` clamped to 0.1 s.

## `src/three/cars.ts` — fleet meshes
`carFleet(capacity: Record<VehicleKind, number>) → { meshes: InstancedMesh[], update(poses: CarSpot[]) }`: same geometry/materials as `carMeshes` (shared, never disposed); `update` writes matrices + body colours and sets `count` per kind. The pose → matrix code is shared with `carMeshes`.

## `src/three/traffic.ts`
`placeCars` gains `lanes?: boolean` (default true); with moving traffic on, the scene passes `lanes: false` so only parking and building-front cars stay static.

## Scene + CityView
- `buildScene` (cars on): builds the graph + traffic + fleet and returns `traffic?: { step(dt, hour, visible): void }` on `BuiltScene`; meshes live in the built group and are disposed with it (geometry/materials are shared, so only the InstancedMesh objects go).
- CityView loop: when playing, `hour += dt · speed / 3600` (wraps at 24), `traffic.step(dt, hour, inFrustum)`; `placeSun` is called when the hour moved by ≥ 1 minute. Paused: nothing advances.
- `visible` = camera frustum test on a 10 m sphere.
- Panel: Play/Pause button (lucide `Play`/`Pause`), speed select ×1 (default) / ×60 / ×600 / ×3600, hour slider widened to 0–24. Dragging the slider sets the hour while playing. Default: playing at ×1.
- Edits rebuild the scene → graph and cars restart. The existing "Cars" checkbox turns everything (static + moving) off.

## Performance
Step + matrix update for 600 cars < 1 ms/frame; acceptance: ≤ 10% fps drop on the 300-building scene on Intel UHD 620 (measured in browser).

## Testing (`src/three/drive.test.ts`)
- T-junction and 4-way cross: graph has the expected nodes/edges, every edge reachable from every other (connected).
- Lane offset: on a straight road a car's pose is offset to the left of travel for left-hand traffic, right for right-hand.
- Give way: over 60 s of simulation on a busy cross, no node ever has two cars inside its box.
- Following: no two cars in the same lane ever closer than 2 m.
- Volume: car count settles lower at 03:00 than at 08:00; never above `MAX_MOVING`.
- Deterministic: two runs with the same seed and steps give identical poses.
- Dead end: a car reaching a cul-de-sac end turns back (or is removed when above target) — never stuck.
- `three.test.ts`: cars on → scene has fleet meshes and `traffic`; cars off → neither.

Browser check: cars visibly move, turn and queue at a junction; time play moves shadows; fps measured with and without traffic.
