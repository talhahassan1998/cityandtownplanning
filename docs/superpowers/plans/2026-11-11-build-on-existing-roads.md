# Build on the Existing Roads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second wizard generator that uses the surveyed existing roads as the street frame, subdivides the blocks between them (with new local streets in deep blocks) and assigns land use by whole block.

**Architecture:** New pure module `src/existingplan.ts` exporting `generateOnRoads`, returning the same `Proposal` type as `generatePlan`, so the wizard's preview/accept/pipes paths are reused untouched. The wizard gets a `mode` state and a second button in the blocked-site panel. `src/masterplan.ts` is not edited.

**Tech Stack:** TypeScript 7 (tsgo), Turf 7, Vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-11-build-on-existing-roads-design.md`

## Global Constraints

- `src/masterplan.ts` unchanged: `git diff --stat src/masterplan.ts` prints nothing at the end of every task.
- Reuse geo/roads/infill helpers (`roadSurface`, `subdivide`, `clearRoads`, `measureFrontage`, `plotIssue`, `connectEnds`, `fillPlot`, `housingType`, `residentialPlotSize`, `plotSizeFor`, `unitsOf`, `footprint`, `frame`). Only import types/consts from `masterplan.ts` (`Brief`, `Draft`, `Existing`, `Proposal`, `Variant`).
- Clearances: buildings 3 m, water 10 m (same values as `masterplan.ts` `CLEARANCE` / `WATER_SETBACK`; re-declare locally, don't export from masterplan).
- Facilities/infill/metrics are a copy of `generatePlan` steps 3–5, marked `// ponytail: copy of masterplan.ts steps 3–5, keep in sync`.
- Road area / road cost count only new streets.
- Proposal labels: `Road-based layout A` / `Road-based layout B`. Draft attrs carry `plan: 'roads-A'` / `'roads-B'`.
- New check labels, exact: `Road analysis` (detail `N existing roads, X km, B blocks, average Y ha`), `Buildable blocks` (failing, detail `none found`).
- Every v1 limit from the spec gets a `ponytail:` comment where it is cut.
- No commits unless the user has asked; if they have, work on branch `feat/build-on-roads` (main has unrelated uncommitted work — stage only this feature's files).

## Review Focus

1. A site where an existing road only clips a corner: blocks still form and the corner sliver is open land, not a crash or a 1-plot zone → test in Task 1 (`corner road`).
2. An existing road that runs along the site edge outside it (touches, doesn't cross): it still serves as frontage for the edge block, and the button still shows only if some road intersects the site → covered by Task 1 `edge road` test.
3. Existing roads that cross each other inside the site produce overlapping surfaces: block difference must not leave zero-width slivers that become blocks → Task 1 asserts every block ≥ one plot area.
4. All mix shares zero except residential (user zeroed the rest): every block is residential, no empty zone drafts → Task 2 `residential only` test.
5. Project-only survey (OSM skipped) with no project roads: button hidden, old flow unchanged → Task 3 browser check step.

---

### Task 1: Blocks, subdivision and street connection

**Files:**
- Create: `src/existingplan.ts`
- Test: `src/existingplan.test.ts`

**Interfaces:**
- Produces:
  - `export interface Block { geometry: Polygon; angle: number /* deg clockwise from east */; frontRoad: number /* index into existing.roads, -1 none */; frontWidth: number; area: number }`
  - `export function analyseRoads(site: Polygon, existing: Existing, minArea: number): { used: number[]; lengthM: number; blocks: Block[] }` — `used` = indices of roads intersecting the site.
  - `export function layoutBlock(block: Block, existing: Existing, b: Brief, w: number, d: number, origin: Position): { plots: GeneratedPlot[]; streets: LineString[] }`
  - `export function generateOnRoads(site: Polygon, b: Brief, v: Variant, ruleset?: Ruleset, existing?: Existing): Proposal` (this task: roads + plots only, every plot zoned residential; Task 2 adds zoning, facilities, infill, metrics).

- [ ] **Step 1: Write the failing tests** in `src/existingplan.test.ts`. Fixture: `C = [67.3, 25.25]`, `site = footprint(C, 450, 450)`; `ns`/`ew` = 16 m roads through C, 700 m long (extend past the site), N–S and E–W; `ex = { roads: [{ geometry: ns, width: 16 }, { geometry: ew, width: 16 }], obstacles: [], water: [] }`.
  - `finds the four blocks between two crossing roads`: `analyseRoads(site, ex, 300).blocks.length === 4`, `used` equals `[0, 1]`, every block `area >= 300`.
  - `keeps plots off existing roads and gives each one frontage`: for `p = generateOnRoads(site, DEFAULT_BRIEF, VARIANTS[0], GENERIC_RULESET, ex)`, no `plot` draft intersects `roadSurface(ns,16)` or `roadSurface(ew,16)` (use `turf.booleanIntersects` on a −0.5 m buffer of the plot); every plot has `attrs.frontage > 0`; plots with `issue === 'No street access'` < 10%.
  - `connects every new street end to a street or existing road`: same loop as `masterplan.test.ts` "street network" (endpoint distance < 1.5 m to another road draft, an existing road, or the site edge).
  - `aligns plots to a diagonal road`: one 16 m road through C at bearing 45°; median `attrs.angle` of plot drafts, folded mod 90, within 3° of 45.
  - `corner road`: a road clipping a 60 m corner of the site; no throw, ≥ 1 block, every block area ≥ 300.
  - `edge road`: a road parallel to the north edge, 9 m outside it; the north row of plots has frontage > 0 (≥ 1 plot within 40 m of the edge with frontage > 0).
  - `reports no buildable blocks`: site fully covered by an obstacle → `p.drafts` has no plots and `checks` contains `{ label: 'Buildable blocks', ok: false, detail: 'none found' }`.

- [ ] **Step 2: Run** `npx vitest run src/existingplan.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `analyseRoads`.** Surfaces of the roads intersecting the site (`roadSurface(feature, width)`), unioned with obstacles buffered 3 m and water buffered 10 m; `turf.difference(site, that)`; explode multipolygon; keep pieces ≥ `minArea`. Per block: for each used road, frontage = length of the road's centreline inside `buffer(block, width/2 + 1 m)`; `frontRoad` = argmax (fallback: nearest road by `pointToLineDistance` from the block centroid, `-1` if no roads). `angle` = `turf.bearing` of the front road's segment nearest the block centroid converted to clockwise-from-east (`90 - bearing`), `frontWidth` = that road's width. `lengthM` = summed centreline length inside the site.

- [ ] **Step 4: Implement `layoutBlock`.** `origin` = the point on the front road's centreline nearest the block centroid. Call `subdivide(block.geometry, { plotWidth: w, plotDepth: d, roadWidth: b.localStreetWidth, plotsPerBlock: b.plotsPerBlock, angle: block.angle or +180 so local +y points from the road into the block, origin, startY: frontWidth/2 - b.localStreetWidth, minArea: w*d*0.5, minFrontage: w*0.6 })` — same anchoring trick as `masterplan.ts` line 175. Then `clearRoads` against existing surfaces + buffered obstacles/water; re-measure frontage with `measureFrontage` against existing roads + `sub.roads` (as `PlanFeature`-shaped `{ geometry, properties: { attrs: { width } } }`) and re-run `plotIssue`; drop plots with frontage 0; drop `sub.roads` segments `booleanWithin` an existing surface.

- [ ] **Step 5: Implement `generateOnRoads` (roads + plots).** Plot size: `residentialPlotSize(housingType(b.density), b.density, ruleset.rules.residential?.setback)` if `b.fillBuildings` else `plotSizeFor(b.density)`. Join streets with `connectEnds([...usedRoadGeoms, ...streets], Math.max(maxExistingWidth, b.localStreetWidth)/2 + 1, usedRoadGeoms.length)` and emit the tail as `road-local` drafts named `Local street` (attrs as `masterplan.ts` `street()`: width, lanes 2, `ROAD_CLASSES.local.sidewalk`, `roadClass: 'local'`). Plot drafts named `Plot R<block>-<number>` with the same attrs keys as `masterplan.ts` line 258. No blocks → return the empty proposal with the `Buildable blocks` check. `linkedTo` = `used`. Add `ponytail:` comments: no bridges (streets stop at water); straight grid on curved edges; leftovers not merged; streets not checked against buildings.

- [ ] **Step 6: Run** `npx vitest run src/existingplan.test.ts` — Expected: all Task 1 tests PASS. Then `npx tsc` — no errors. `git diff --stat src/masterplan.ts` — empty.

### Task 2: Land use by block, facilities, infill, metrics, checks

**Files:**
- Modify: `src/existingplan.ts`
- Test: `src/existingplan.test.ts`

**Interfaces:**
- Consumes: `analyseRoads`, `layoutBlock`, `Block` from Task 1.
- Produces: `export function zoneBlocks(blocks: Block[], mix: Brief['mix'], order: 'A' | 'B', centre: Position): Zone[]` (one zone per block, same order as `blocks`); `type Zone = 'residential' | 'commercial' | 'industrial' | 'institutional' | 'green'` (local). `generateOnRoads` now returns full metrics and checks.

- [ ] **Step 1: Write the failing tests.**
  - `follows the mix by whole blocks`: 3×3 grid fixture (four roads, 2 N–S + 2 E–W, on a 900 × 900 m site → 9 blocks); for each zone, `landUse[zone] / siteArea` is within one block's share (largest block area / site area) of `mix[zone] / total`.
  - `puts commercial on the widest road`: in the 3×3 fixture make one E–W road 30 m wide; under variant A every commercial block fronts it (`frontRoad` = that index).
  - `residential only`: mix `{ residential: 100, others 0 }` → every zone draft is residential, no green/commercial zone drafts.
  - `reports the road analysis and costs only new streets`: `checks` has `Road analysis` with `ok: true` and detail matching `/^2 existing roads, [\d.]+ km, 4 blocks, average [\d.]+ ha$/`; `metrics.roadArea` equals the sum of length × width over `Local street` drafts only (±1 m²).
  - `places facilities and fills plots`: with `DEFAULT_BRIEF`, `metrics.facilities.school >= 1` and at least one building draft exists; `labels` are `Road-based layout A` / `B` for `VARIANTS[0]` / `VARIANTS[1]`; the two variants' zone lists differ.

- [ ] **Step 2: Run** `npx vitest run src/existingplan.test.ts` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement `zoneBlocks`.** Rank blocks by `frontWidth` desc, then `area` desc. Targets = `mix[zone]/total × Σarea`. Assignment order:
  - A: commercial from the top of the ranking; industrial = blocks farthest from `centre`; green = lowest-ranked blocks with the lowest `area / (perimeter²)` regularity; institutional next from the top; residential = the rest.
  - B: as A with institutional and residential swapped in the order, and green taken from the largest blocks.
  A zone takes blocks while its assigned area is below its target and the next block doesn't overshoot by more than half that block; zones with share 0 take none. Unassigned blocks become residential.

- [ ] **Step 4: Wire zoning into `generateOnRoads`.** Plot size per zone like `masterplan.ts` line 165 (commercial 25×40, industrial 50×60, institutional 60×60); green blocks → `zone` + `park` drafts, no plots; one `zone` draft per block. Plot names `Plot <Z><blockNo>-<number>`.

- [ ] **Step 5: Copy facilities, infill, metrics, checks** from `masterplan.ts` lines 221–278 (facility placement, `fillPlot`, dwellings/population, checks list) with the `ponytail: copy` comment. Changes from the original: road area over `Local street` drafts only; drop the water/bridge and `Joins existing roads` checks; add `Road analysis` (km to 1 decimal, average ha to 1 decimal). Building `axis` = the plot's own `attrs.angle` instead of a site axis.

- [ ] **Step 6: Run** `npx vitest run src/existingplan.test.ts` then `npm test` — Expected: all PASS (413 existing + the new file). `npx tsc` clean. `git diff --stat src/masterplan.ts` empty.

### Task 3: Wizard option

**Files:**
- Modify: `src/ui/WizardDialog.tsx` (state ~line 44, `generate` lines 84–109, blocked panel lines 213–216, step-4 help ~line 190)

**Interfaces:**
- Consumes: `generateOnRoads(site, b, VARIANTS[i], s.meta.ruleset, sv)` from Task 2.

- [ ] **Step 1: Add state** `const [mode, setMode] = useState<'grid' | 'roads'>('grid')`; reset to `'grid'` in the existing site-change effect (line 60) alongside `setAround(false)`.

- [ ] **Step 2: Extend `generate`** with a third parameter `useRoads = mode === 'roads'`: after the survey, `setMode(useRoads ? 'roads' : 'grid')`; treat `useRoads` like `planAround` for the conflicts gate; at most 2 alternatives in roads mode (`Math.min(count, 2)`); call `generateOnRoads` instead of `generatePlan` when `useRoads`. Import `generateOnRoads` statically (pure module, small).

- [ ] **Step 3: Add the button** in the blocked panel, after "Plan around existing development", shown only when `survey?.sv.roads.some((r) => turf.booleanIntersects(r.geometry, site))`: `<button className="btn-primary mt-1.5 w-full" disabled={!!busy} onClick={() => generate(true, true, true)}>{busy || 'Build on the existing roads'}</button>`, preceded by the line `Or build on them: the existing roads become the street frame, the land between them is subdivided, and deep blocks get new local streets.`

- [ ] **Step 4: Help text.** In step 4, when `mode === 'roads'` replace the "Alternatives vary the spine…" paragraph with `Road-based generation: the existing roads are the frame, blocks between them are subdivided along the road they face, land use is assigned by whole block. Up to 2 alternatives.`

- [ ] **Step 5: Verify.** `npx tsc` clean; `npm test` all PASS; `npm run build` succeeds.

- [ ] **Step 6: Browser check** (dev server on 5317, `--strictPort`; set `__store.setState({ dirty: false })` before any reload). Draw a ~20 ha boundary on a real OSM street grid (e.g. a residential area in Karachi, around 67.07, 24.93), open the wizard, Generate → blocked panel shows both buttons → **Build on the existing roads** → 2 alternatives, preview shows plots along the existing streets → Accept → plots/streets/existing roads present, 3D view opens. Then the Review Focus case 5: "Generate without the OpenStreetMap check" on empty land → no new button, old flow unchanged.

### Task 4: Docs

**Files:**
- Modify: `.claude/CLAUDE.md` (Architecture list + test count), `README.md` (wizard section, one paragraph)

- [ ] **Step 1:** Add to CLAUDE.md Architecture: `` `existingplan.ts` "Build on the existing roads" (wizard blocked-site panel): `generateOnRoads` uses surveyed roads crossing the site as the frame, blocks = site − road surfaces − clearances, each subdivided along the road it fronts (`subdivide` anchored on that road), land use by whole block; facilities/metrics are a copy of masterplan.ts steps 3–5 (keep in sync); masterplan.ts untouched ``. Update `npm test` count to the new total from Task 2 Step 6.
- [ ] **Step 2:** README wizard section: one paragraph describing the option and its v1 limits (no bridges, leftovers stay open land).
- [ ] **Step 3:** If the user asked for commits: `git checkout -b feat/build-on-roads`, `git add src/existingplan.ts src/existingplan.test.ts src/ui/WizardDialog.tsx docs/superpowers/specs/2026-11-11-build-on-existing-roads-design.md docs/superpowers/plans/2026-11-11-build-on-existing-roads.md README.md` (and `.claude/CLAUDE.md` only after confirming its other pending edits may go in the same commit), commit `feat: build a society on the existing road network`.
