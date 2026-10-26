# Water & sewer flow + underground view — design

Date: 2026-10-22 · Status: approved in chat, spec awaiting review

## Goal
Presentation first: show how a town's water supply and sewerage work — pipes at realistic depths under the
streets, water pushed out from the tank / pump station, sewage running by gravity to the treatment plant —
in an X-ray "Underground" view of the 3D scene. Built so a later hydraulics engine (real flow rates, pressure,
gradients, warnings) plugs into the same flow model without touching the rendering.

## User decisions
- Purpose: both, presentation first (hydraulics = next sub-project).
- Auto-lay: yes — a "Lay water & sewer" command + wizard option.
- Underground view: X-ray ground (camera stays above, looks through the ground).
- **Must not slow the system** (see Performance — hard requirements).

## 1. Laying pipes — `src/utilities.ts` (new, pure + tested)
`layWaterSewer(features: PlanFeature[], toLocal: (p: Position) => XY, toGeo: (p: XY) => Position): Draft[]`
(`Draft = { type, geometry, attrs, name }`, like the wizard's drafts):
- Streets come from `buildRoadGraph` (drive.ts — pure; streets cut at junctions, ends merged within 5 m; it
  skips bridges/tunnels/rail/paths, so pipes do too). For every graph edge: a `water-main` running
  junction node → the edge offset 2 m to one side → next junction node, and a `sewer` the same at 1.5 m on the
  other side (3.5 m apart along the run ≥ the 3 m separation rule; they meet only at the junction points,
  shorter than the rule's 10 m run).
- Connectivity: pipes of a network share exact junction-node coordinates, so `analyzeNetworks` sees one
  connected network per type wherever the streets are connected (test: no `disconnected` issue on a wizard town).
- Skips a street when a pipe of that network already runs within 6 m of its midpoint.
- Sources: if the project has no `water-tank`/`pump-station`, add a `water-tank` point beside the street node
  nearest the town centroid, linked by a short water main; if it has no `treatment` plant, add an 80 × 60 m
  `treatment` polygon beyond the street end farthest from the centroid, linked by a sewer.
- Attributes from `defaultAttrs` (diameter, material, network). Names "Water main (laid)", "Sewer (laid)".
- UI: toolbar Utilities menu command "Lay water & sewer" (one undo step via `addFeatures`, notify with counts,
  "preliminary" wording); wizard checkbox "Lay water & sewer under streets" (default on) applied on accept.
- `ponytail:` the plant / tank may land on a plot; the user moves it (they are ordinary features).

## 2. Flow model — `src/pipeflow.ts` (new, pure + tested)
`pipeFlow(features, toLocal, ground): FlowNet` where
```
FlowPipe { id: string; network: 'water' | 'sewer'; pts: [e, n, y][]  // y = pipe centre elevation, in flow order
           diameter: number; speed: number /* m/s, illustrative */; connected: boolean }
FlowNet  { pipes: FlowPipe[]; manholes: [e, n, yPipe, yGround][] }
```
- Graph of each network's line features (endpoints and crossings merged within `tolerance`), sources as in
  `NETWORKS[net].sources`.
- Water: shortest network distance from any source; each pipe oriented from its nearer-to-source end.
- Sewer: shortest network distance to the treatment plant; oriented towards it.
- Pipes not reached from a source: `connected: false` (drawn, not animated) — matches the `no-source` issue.
- Depth (pipe centre below ground): `attrs.depth` if set; else water 1.2 m; sewer gravity: processed upstream →
  downstream, invert = min(ground − 1.5 m, upstream invert − 0.005 × length) so it always falls ≥ 1:200
  towards the plant. Points follow the pipe's polyline vertices (no resampling).
- Speeds (illustrative): water 1.0 m/s, sewer 0.6 m/s. A future `NetworkEngine` replaces `speed` per pipe.
- Manholes: sewer junctions and ends (graph nodes of degree ≠ 2), plus existing `manhole` point features.

## 3. Underground view — `src/three/pipes.ts` (new) + `scene.ts` + `CityView.tsx`
- 3D panel checkbox "Underground" (off by default; not saved in the project, like camera mode).
- On: the flow model and pipe meshes are built (lazily, first time; cached until the scene rebuilds) and shown;
  every other visible mesh swaps to a cached **ghost copy** of its material (transparent, depthWrite off;
  ground/roads/plots opacity ≈ 0.25, buildings ≈ 0.12). Shared building/kit materials are never mutated
  (copies only; Gotchas). Off: originals restored, pipe group hidden. Surface pipe lines stay as today.
- Pipes: one merged tube mesh per network (radius = max(diameter / 2, 0.25 m) for visibility, 6 radial
  segments), plus one merged mesh for manhole shafts. Flow = a per-vertex `flow` attribute (metres along the
  flow direction) and a material patch (`onBeforeCompile`) adding bright pulses
  `fract((flow − uTime·speed) / 8 m)` → water #4fc3f7 on #1565c0, sewage #d7a86e on #5d4037; unconnected pipes
  have no pulses. `uTime` advances with the CityView clock (paused with it).
- Selection/picking: pipes are pickable as their feature ids (click a tube to select the main).

## Performance — hard requirements
- Underground **off**: zero added draw calls, no flow-model computation, no per-frame work. The big-town frame
  time and scene build time are unchanged (within run-to-run noise).
- Underground **on**: pipes add ≤ 3 draw calls (water, sewer, manholes) + their shadow-less pass; per frame only
  one uniform write per network. First toggle builds in ≤ 300 ms for the 1038-building town with all streets
  piped; later toggles are instant (material swaps only).
- "Lay water & sewer" on the big town completes in ≤ 1 s.

## Not in scope
House service connections, stormwater / power / telecom flow, camera below ground, real hydraulics
(next sub-project), saving the underground toggle.

## Success criteria
- Tests: `layWaterSewer` on a wizard town → `analyzeNetworks` has no `disconnected` / `no-source` issues and no
  `separation` issue for laid pairs; re-running lays nothing new. `pipeFlow`: water direction away from the tank,
  sewer towards the plant on sample networks; sewer centre elevation strictly falls downstream along every pipe;
  unconnected pipe → `connected: false`. `pipes.ts`: one mesh per network, pulse attribute increases in flow
  direction; underground on → off restores every original material object.
- Browser: lay pipes on a wizard town, Underground on: water pulses out from the tank, sewage to the plant,
  manholes reach the surface; toggle off restores the scene; big-town frame time with Underground off unchanged,
  with it on ≤ +3 ms (median, on the charger).
