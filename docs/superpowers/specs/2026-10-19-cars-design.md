# Cars — realistic vehicles in parking, on roads and at buildings

## Goal
Replace the box cars in parking areas with realistic procedural vehicles and add stationary traffic, kerb parking and cars at building fronts, so 3D scenes read as a lived-in town. Static only (no animation) — user choice A.

## User decisions
- Static vehicles; moving traffic is out of scope.
- Placements: parking areas, traffic in lanes, kerb parking, driveways / building fronts.
- Mixed fleet: sedan, hatchback, SUV/pickup, plus bus and box truck on main roads.
- Driving side is a per-project setting, default **left**.
- Procedural models, instanced (project rule: no asset files).

## `src/three/cars.ts` — models
- `type VehicleKind = 'sedan' | 'hatch' | 'suv' | 'bus' | 'truck'`.
- `vehicleGeometry(kind)` → cached merged geometries per material slot (body, glass, tyre, light), origin at ground centre, length along local +z (front = +z). Body built from 2–3 stacked tapered sections (bonnet, cabin, boot) so silhouettes differ; wheels as cylinders. Sizes (L × W × H, m): sedan 4.6 × 1.8 × 1.45, hatch 4.0 × 1.75 × 1.5, suv 4.8 × 1.9 × 1.8, bus 12 × 2.55 × 3.2, truck 8 × 2.5 × 3.4.
- Shared cached materials (`userData.shared = true`), never mutated or disposed per car (same rule as building materials). Body uses per-instance colour.
- `carColor(seed)` palette: white 25%, silver 20%, grey 15%, black 15%, red/blue/green/beige/other 25%.
- `carMeshes(placements)` → one `InstancedMesh` per kind × material slot.

## `src/three/traffic.ts` — placements (pure)
`interface CarSpot { e: number; n: number; heading: number /* deg cw from east */; kind: VehicleKind; seed: number }`

`placeCars(features, side: 'left' | 'right', frame) → CarSpot[]`, deterministic (seeded by feature id), at most 3000 (thinned evenly; `ponytail:` cap, instancing LOD is the upgrade).
- **Parking areas** (`parking`): ~70% of bays (existing 2.6 m bay grid in `groundExtras`), facing the aisle. `groundExtras` keeps the bay markings and stops drawing box cars.
- **Lane traffic** on `road-arterial`, `road-collector`, `road-local`, `road-highway` (grade only): lanes = `attrs.lanes`, carriageway = width − 2·sidewalk, lane centres split evenly; half the lanes per direction, the driving side's lanes heading along the line. Spacing: highway/arterial 1 per 25 m per lane, collector 1 per 40 m, local 1 per 70 m, with ±40% seeded jitter. Bus/truck ≈ 1 in 12 on arterial/collector/highway only.
- **Kerb parking** on local and collector streets: parked rows of 2.2 m beside the lanes when carriageway ≥ lanes·2.75 + 2.2 per row (both sides if room for two rows, else the driving-side kerb); cars every 6 m with ~60% occupancy, parallel to the kerb.
- **Junction clearance**: no lane or kerb car within 12 m of another road's surface.
- **Building fronts**: house/villa → one car parallel to the building's face nearest a road, in the gap between building and road if the gap is ≥ 2.4 m; shop/office/mixed-use/clinic/school/community/police/fire/government/library → 1–3 cars along that face. Skip any car whose footprint overlaps a road surface or a building footprint.
- Rail, cycle, walking tracks, tunnels and bridges: none.

## Settings & rendering
- `Settings.drivingSide?: 'left' | 'right'` (absent = left). Select "Driving side" next to the building style in `ui/Analytics.tsx`.
- `SceneOptions.cars: boolean`; CityView "Cars" checkbox next to Trees/Street lights (default on); rebuild on toggle and on `drivingSide` change.
- Map 3D layer (`map/models3d.ts`, `modelsOnly`): cars included, visible from zoom 17 (`DETAILS_MIN_ZOOM`) like building details.
- Cars sit on `elevLocal(e, n)` (terrain-aware). Cars are not pickable.

## Testing
- `src/three/traffic.test.ts`: left vs right side of a straight road (cars offset to the correct side, headings opposite per side); no car within 12 m of a crossing road; kerb rows appear for a 12 m local street (one row) and not for a 9 m one; driveway car never overlaps its house or the road; deterministic for the same input; cap at 3000 with 5000 candidates; nothing on rail/cycle/bridge.
- `src/three/cars.test.ts`: each kind's bounding box within ±10% of the sizes above; materials shared across calls.
- `three.test.ts`: `cars: false` scene has no vehicle meshes; parking area has no box-car geometry.
- Headless browser: parking close-up, street close-up, generated town in left and right driving; record fps with cars on vs off.
