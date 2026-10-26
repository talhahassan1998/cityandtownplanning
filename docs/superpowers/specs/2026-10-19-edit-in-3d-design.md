# Editing in 3D — move, rotate and add objects in the 3D view (sub-project 3 of 4)

## Goal
Let planners rearrange a town directly in the 3D city view: drag objects across the ground, rotate them with an on-screen ring, and drop new components from the library into the scene. Today 3D supports click-select plus the Properties panel and app keys (`[` `]`, Delete, undo).

## User decisions
- In scope: **move & rotate**, **add from library**. Out of scope (later): change type in 3D, regenerate a selection.
- Movable: **objects only** — buildings, facilities, point items, area components (parks, parking, sports grounds…). Roads, plots, zones, boundaries, utility lines stay 2D-edited.
- Rotation: **ring handle + keys** — ring snaps to 15°, Shift = free; `[` `]` unchanged.
- Approach: preview while dragging, commit once on release (one undo step), then the normal rebuild.

## Behaviour
- **Move:** pointer-down on a selected movable object (or any member of a multi-selection) starts a drag; orbit controls are disabled until pointer-up. The selection's meshes follow the pointer's ground point (terrain-aware: each mesh's y follows `groundAt` at its new centre). With grid snap on (`snap.grid`), the moved selection centre snaps to the project grid. Pointer-up commits `moveFeatures(ids, dx, dy)` (metres east/north) — one undo step. A press/release within 4 px stays a click (selection unchanged behaviour). Pointer-down on empty space or a non-selected object behaves as today (orbit / select).
- **Rotate:** while a movable selection exists (not in walk mode), a flat ring (radius = selection's horizontal radius + 4 m, 1.2 m wide, accent colour, slightly above ground) is drawn around the selection centre. Dragging on the ring rotates the selection's meshes about the centre; the live angle is shown in the 3D status line. Angle snaps to 15° unless Shift is held. Pointer-up commits `rotateFeatures(ids, deg)` (existing action; clockwise degrees) — one undo step.
- **Add from library:** dragging a library component over the 3D canvas and dropping places it at the ground point under the pointer (grid snap if on), via the same `componentGeometry(componentDef(type), c)` + `addFeature` as the 2D map; the new feature is selected.
- **Exclusions:** locked layers (`lockedIds`) and non-movable types are ignored by move/rotate (a drag that starts on them orbits). No editing in walk mode. Dropping outside the terrain/ground does nothing.

- **Compass (added on request):** a compass rose (N, E, S, W; N in red) in the 3D view's top-right corner, rotating with the camera's heading so it always shows the real directions on screen; clicking it turns the orbit/top-down camera to face north (keeping its distance and tilt). Shown in every camera mode.

## Units
- `src/three/edit3d.ts` (pure, tested):
  - `isMovable(f: PlanFeature): boolean` — true for Point features and for Polygon features whose component layer is `buildings`, `facilities` or `green`, plus the polygon types `parking`, `station`, `substation`, `treatment`, `solar`, `waste`, `pump-station`, `telecom-exchange`; false for everything else (all LineStrings — roads, utility lines, paths — and plots, zones, boundaries, roundabouts, cul-de-sacs, annotations).
  - `groundHit(ray, built, terrain?)` → scene point on the terrain mesh, else on the y = 0 plane.
  - `sceneToGeo(built, x, z): Position` (inverse of `toScene`) — added to `BuiltScene` as `toGeo`.
  - `ringAngle(center, from, to, free: boolean): number` — clockwise degrees between two ground points around the centre, snapped to 15° unless `free`.
- `store.ts`: `moveFeatures(ids: string[], dx: number, dy: number): void` — translates (metres) every listed, unlocked, movable feature in one `set` (one undo step); parametric footprints keep their attrs.
- `edit3d.ts`: `cameraHeading(camera, target): number` — degrees clockwise from north that the camera looks along (0 = looking north).
- `three/CityView.tsx`: drag/rotate state machine on pointer events; ring mesh; drop handler; status text.

## Testing
- `edit3d.test.ts`: `cameraHeading` — camera south of the target looking north → 0; west of it looking east → 90.
- `edit3d.test.ts`: movable classification (house, school, park, parking, bus-stop true; road, plot, zone, boundary, water-main false); `ringAngle` (90° quarter turn clockwise, snapping 50° → 45°, free keeps 50°, wrap-around across ±180°); `toGeo(toScene(p)) ≈ p`.
- `store.test.ts`: `moveFeatures` moves a house 20 m east (centroid shift 20 ± 0.01 m) in one undo step; skips locked-layer and non-movable features.
- Headless browser: generated town → select a house in 3D → drag 20 m → undo restores; rotate 45° with the ring; drop a school from the library onto the 3D ground.
