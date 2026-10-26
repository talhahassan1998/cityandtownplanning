# Traffic signals — design (animation piece 4)

Date: 2026-10-22 · Status: approved in chat, spec awaiting review

## Goal
Presentation realism in the 3D view: busy junctions get traffic lights that cycle visibly, cars queue
on red and stream through on green; jams resolve by themselves more often, so the gridlock release
valve (drop a car stopped ≥ 60 s, > 20 s off-screen) fires less. Not a traffic-analysis tool.

## User decisions
- **Where:** automatic — a junction is signalled when ≥ 3 arms meet and ≥ 2 of them are non-local
  (collector / arterial / highway). Local-street junctions stay give-way.
- **Phasing:** each arm in turn.

## Simulation (`src/three/drive.ts`)
- `GNode` gains `signal?: { arms: number[]; offset: number }` — arm edge ids ordered by angle (clockwise
  from east), set by `buildRoadGraph` from the rule above. `offset` (seconds) is filled by
  `createTraffic` from its seed, so neighbouring junctions are not in lockstep.
- Timing constants: `GREEN = 20`, `AMBER = 3`, `ALL_RED = 2` s; cycle = 25 s × arms.
- `export function signalAt(node: GNode, edge: number, t: number): 'green' | 'amber' | 'red'` — pure;
  `t` is sim time (s). Arm k is green for [25k, 25k+20), amber [25k+20, 25k+23), red otherwise
  (including the 2 s all-red), all shifted by `offset`.
- `Traffic` gains `time: number` (sim seconds; advances by the clamped `dt` each step, so faster clock
  speeds run the lights faster with the cars) and `dropped: number` (cars removed by the release valve).
- **Junction box:** `holder` becomes a per-node list of cars turning in the box.
  - Give-way node (no `signal`): unchanged rule — enter only if the box is empty and the exit lane has room.
  - Signalled node: the lane's head car may enter when its arm is `green` (or `amber` and it cannot stop:
    `v² / (2·4 m/s²) > distance to the stop line`), the exit lane has room, every car in the box came from
    the same arm, and the last box car from the same lane is ≥ its length + 2 m along its turn path.
    On red/amber-and-can-stop the car stops at the lane end (the stop line), as it waits today.
  - Lane following keeps the gap to the last box car that came from the same lane (today: the single holder).
- The release valve stays (safety net), now counting into `dropped`.

## Visuals (new `src/three/signals.ts` + test, wired in `src/three/scene.ts`)
- One head per signalled arm: pole (≈ 4.5 m) + 3-lamp housing, placed on the driver's side of the
  approach (`settings.drivingSide`), ≈ 1 m back from the box edge, facing the oncoming approach.
- Three `InstancedMesh`es for all heads (poles, housings, lamps — 3 lamp instances per head with
  per-instance colour: lit = full red / amber / green, unlit = dark). Lamps use an unlit material so they
  read at night too.
- `BuiltScene.traffic.step` updates lamp colours from `signalAt(…, traffic.time)` only when a phase
  changed. Without moving traffic (static cars, map overlay) heads are shown in their t = 0 state.
- Heads are scenery, not features: not pickable, like street lights.

## Not in scope
Turn arrows / protected phases, pedestrian crossings, user-placed or removed signals, roundabout logic,
actuated (demand-responsive) timing.

## Success criteria
- Tests (`drive.test.ts`): signal rule (crossroads of collectors → signalled; local crossroads and
  2-arm bends → not); `signalAt` sequence for a 4-arm node incl. amber/all-red and offset; no car from a
  red arm is in the box; never two arms in a box at once; several cars from the green arm in the box
  together; on a collector grid at the 08:00 peak over 30 sim-minutes `dropped` is lower with signals than
  with the same grid's junctions forced to give-way.
- Scene test: one head per signalled arm, lamps change colour when a phase changes.
- Browser: a signalled crossroads cycles, queues form on red and discharge on green, works at ×3600 and at
  night; big-town frame time stays ≈ 32 ms (median, on the charger).
