# Plot Infill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The master-plan generator places a rule-compliant building on every buildable residential, commercial and industrial plot.

**Architecture:** A new pure module `src/infill.ts` picks a building type per plot and fits its footprint/floors to the zone's controls; `generatePlan` calls it after facility placement and derives dwellings with a shared `unitsOf` helper (moved into `geo.ts`, reused by `stats` and `zoning.evaluate`). The wizard gets one checkbox.

**Tech Stack:** TypeScript, Turf 7, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-plot-infill-design.md`

## Global Constraints
- Not a git repo: no commits; each task's gate is `npm test` + `npx tsc` clean.
- Coordinates WGS 84; metric work via `frame(origin)`; angles degrees clockwise from east.
- Derived values (dwellings) are never stored on features.
- Generated output stays labelled preliminary (existing proposal labels) and is ordinary editable drafts.
- Ponytail style: minimal code, reuse `footprint`, `componentDef`, `FLOOR_HEIGHT`, `GENERIC_RULESET`; `ponytail:` comment on centred placement.

## Review Focus
- Irregular plots clipped by the site edge or arterial: a centred rectangle can cross the setback — expect shrink-then-drop, never an `outside`/`setback` violation (Task 2 test with a triangular-ish plot).
- Custom project ruleset with a zone missing or with `uses` excluding the type (e.g. residential not permitting Residential): no building placed rather than a `use` violation (Task 2 test).
- `fillBuildings: false`: output identical in counts to today (Task 3 test).
- Very low density (5 dph) → villas on huge plots must still meet coverage/FAR, not catalogue-size only (covered: footprint never exceeds catalogue size; Task 2 villa test).
- Large default brief (~1000 buildings): 3D frame rate — measured in Task 4 browser check, reported not fixed.

---

### Task 1: Shared `unitsOf` dwelling helper

**Files:**
- Modify: `src/geo.ts:429-431` (beside `MULTI_UNIT`, `UNIT_SIZE`), `src/geo.ts:469` (stats), `src/zoning.ts:85`
- Test: `src/geo.test.ts`

**Interfaces:**
- Produces: `export function unitsOf(type: string, gfa: number, unitSize = UNIT_SIZE): number` — `MULTI_UNIT.has(type) ? Math.floor((gfa * 0.8) / unitSize) : 0`.

- [ ] **Step 1: Failing test** in `geo.test.ts`:
```ts
it('unitsOf counts flats in multi-unit types only', () => {
  expect(unitsOf('apartment', 1000)).toBe(8)
  expect(unitsOf('townhouse', 360, 90)).toBe(3)
  expect(unitsOf('house', 1000)).toBe(0)
})
```
- [ ] **Step 2:** `npx vitest run src/geo.test.ts` → FAIL (`unitsOf` not exported).
- [ ] **Step 3:** Add `unitsOf`; replace the inline formulas in `stats` (pass `s.unitSize ?? UNIT_SIZE`) and `zoning.ts:85` with it; drop now-unused imports.
- [ ] **Step 4:** `npm test` → all pass (stats/zoning tests unchanged); `npx tsc` clean.

### Task 2: `src/infill.ts`

**Files:**
- Create: `src/infill.ts`, `src/infill.test.ts`
- Modify: `src/zoning.ts:33` — export `minSetback`

**Interfaces:**
- Consumes: `unitsOf` (Task 1); `GeneratedPlot` (`geo.ts`); `ZoneRule` (`model.ts`); `minSetback(building: Position[], plot: Polygon): number` (`zoning.ts`); type-only `Draft` from `masterplan.ts`.
- Produces:
  - `export type HousingType = 'villa' | 'house' | 'townhouse' | 'apartment'`
  - `export function housingType(density: number): HousingType` — `< 15` villa, `< 40` house, `<= 80` townhouse, else apartment.
  - `export function residentialPlotSize(h: HousingType, density: number): [number, number]` — villa/house → `plotSizeFor(density)` (import from masterplan is circular: move `plotSizeFor` into `infill.ts` and re-export it from `masterplan.ts` so existing imports keep working). Townhouse: 6 dwellings, width 42 m; apartment: 16 dwellings, width 46 m; depth = `dwellings × 7000 / density / width`, at least 22 m.
  - `export function fillPlot(plot: GeneratedPlot, zone: string, rule: ZoneRule | undefined, housing: HousingType, axis: number, tag: Record<string, string>): Draft | undefined`

`fillPlot` algorithm (the tests below pin the outcomes):
1. Return `undefined` if `plot.issue` or no `rule`.
2. Type: residential → `housing`; commercial → area `< 800` shop, `< 2000` mixed-use, else office; industrial → `Number(plot.number) % 2 ? 'factory' : 'warehouse'`; any other zone → `undefined`. Return `undefined` if `componentDef(type).category` is not in `rule.uses`.
3. `s = rule.setback ?? 0`; buildable `bw0 = frontage − 2s`, `bd0 = depth − 2s`; `undefined` if either `< 6`. `w = townhouse ? bw0 : min(def.w, bw0)`, `d = min(def.d, bd0)`.
4. Coverage: if `rule.maxCoverage` and `w·d > 0.9·maxCoverage/100·area`, scale both by `sqrt(limit / (w·d))`.
5. Floors = min(`def.floors`, `maxFloors`, `⌊maxHeight / FLOOR_HEIGHT⌋`, `⌊maxFAR·area / (w·d)⌋`); then while `floors > 1` and `rule.maxDensity` and `(dwellingsPerPlot(1 if residential) + unitsOf(type, w·d·floors)) / (area/10000) > maxDensity`, decrement. `undefined` if floors `< 1`.
6. Geometry `footprint(centroid(plot), w, d, axis)`; while any vertex is outside the plot or `minSetback(ring, plot.geometry) < s − 0.01`, shrink `w, d` by 10% (max 5 tries; fail → `undefined`). `// ponytail: centred on the plot; front-setback placement with a rear garden is the upgrade`.
7. Return `{ type, geometry, attrs: { ...tag, width, depth, rotation: axis, floors, height: +(floors·FLOOR_HEIGHT).toFixed(1), zoning: zone } }` (width/depth rounded to 0.1 m).

- [ ] **Step 1: Failing tests** in `infill.test.ts` (build plots with `footprint(C, w, d, 0)` and `GeneratedPlot` fields `frontage: w, depth: d, area: w*d, number: '1'`, rules from `GENERIC_RULESET.rules`):
  - `housingType`: 10→villa, 15→house, 40→townhouse, 80→townhouse, 81→apartment.
  - `residentialPlotSize('apartment', 120)` → width 46, area ≈ 16·7000/120 (±1 m²).
  - house on 15×30 residential plot: type `house`, every vertex inside plot, `minSetback ≥ 3`, footprint ≤ 54% of plot, floors ≤ 4.
  - villa on 60×60 residential plot: footprint ≤ 18×20 (catalogue), floors 2.
  - apartment on 46×25 residential plot: floors ≤ 4; `(1 + unitsOf('apartment', gfa)) / (area/1e4) ≤ 120`; GFA ≤ 1.5·area.
  - commercial 20×30 → shop; 30×50 → mixed-use; 60×60 → office; office floors ≤ 12, height ≤ 45.
  - industrial number '1' → factory, '2' → warehouse; setback ≥ 6.
  - 8×8 residential plot → `undefined`; plot with `issue: 'x'` → `undefined`; zone `green` → `undefined`.
  - rule with `uses: ['Commercial']` on residential → `undefined`.
  - irregular plot (a 30×30 square with one corner clipped to a triangle-ish 5-vertex polygon, frontage 30, depth 30): result is `undefined` or every vertex inside and `minSetback ≥ 3`.
- [ ] **Step 2:** `npx vitest run src/infill.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `src/infill.ts`; export `minSetback` from `zoning.ts`; move `plotSizeFor` per the interface note.
- [ ] **Step 4:** `npx vitest run src/infill.test.ts src/masterplan.test.ts` → PASS; `npx tsc` clean.

### Task 3: Generator integration

**Files:**
- Modify: `src/masterplan.ts` (Brief, DEFAULT_BRIEF, `generatePlan` steps 2–4)
- Test: `src/masterplan.test.ts`

**Interfaces:**
- Consumes: `housingType`, `residentialPlotSize`, `fillPlot` (Task 2); `unitsOf` (Task 1); `GENERIC_RULESET`, `type Ruleset` (`model.ts`).
- Produces: `Brief.fillBuildings: boolean` (DEFAULT_BRIEF `true`); `generatePlan(site: Polygon, b: Brief, v: Variant, ruleset: Ruleset = GENERIC_RULESET): Proposal`.

Changes:
- Residential subdivision size: `residentialPlotSize(housingType(b.density), b.density)` instead of `plotSizeFor(b.density)` (only when `b.fillBuildings`; off → today's `plotSizeFor`).
- After facility placement: when `b.fillBuildings`, for each plot not in `used` and without `issue`, `fillPlot(p, p.zone, ruleset.rules[p.zone], housing, axis, tag)`; push the draft; count `dwellings += (p.zone === 'residential' ? 1 : 0) + unitsOf(draft.type, area(draft)·floors)` (use `settings.dwellingsPerPlot` default 1 — the brief has no field; keep 1).
- `dwellings`: filled → the sum above; off → today's `residentialPlots`.
- Budget check label → `'Budget (roads + buildings)'`.

- [ ] **Step 1: Failing tests** in `masterplan.test.ts`:
  - default plan has `house` drafts (density 35 → house) and `shop|mixed-use|office` and `factory|warehouse` drafts.
  - `const p = newProject()`; convert drafts to features `{ type:'Feature', id: String(i), geometry, properties: { type, name, attrs, layerId: p.layers.find(l => l.kind === componentDef(type).layer)!.id } }` (match `PlanFeature`'s real property names in `model.ts`); `evaluate(features, GENERIC_RULESET, p.meta.settings)` (or wherever `newProject` puts `settings`) → zero violations whose id is a generated building.
  - `plan.metrics.dwellings === stats(features, p.layers, settings).dwellings`.
  - `generatePlan(site, { ...DEFAULT_BRIEF, fillBuildings: false }, VARIANTS[0])` → no residential/commercial/industrial building drafts; `metrics.dwellings === metrics.residentialPlots`.
  - `generatePlan(site, { ...DEFAULT_BRIEF, density: 120 }, VARIANTS[0])` → has `apartment` drafts; every residential plot frontage ≥ 40 m (no 8 m plots).
- [ ] **Step 2:** `npx vitest run src/masterplan.test.ts` → new tests FAIL.
- [ ] **Step 3:** Implement the changes above.
- [ ] **Step 4:** `npm test` → all pass; `npx tsc` clean. Fix any existing masterplan test whose expectation was plot-count-based dwellings by checking it against `fillBuildings: false`, not by loosening it.

### Task 4: Wizard, browser check, docs

**Files:**
- Modify: `src/ui/WizardDialog.tsx:69` (pass `s.meta.ruleset`), add checkbox near line 115; `README.md`; `.claude/CLAUDE.md` (Status + test count); memory `realistic-city-request.md`

- [ ] **Step 1:** Checkbox `<label className="flex items-center gap-2"><input type="checkbox" checked={b.fillBuildings} onChange={(e) => set('fillBuildings', e.target.checked)} /> Fill plots with buildings</label>` after the density field; call `generatePlan(site, b, VARIANTS[i], s.meta.ruleset)`.
- [ ] **Step 2:** `npx tsc`; `npm run build` → OK.
- [ ] **Step 3:** Browser (`npm run dev -- --port 5317 --strictPort`): run the wizard with defaults, accept a proposal; confirm in 2D that buildings sit inside plots, compliance panel shows no building violations; open 3D in western and gulf styles; record building count and fps (`__view.renderer.info` + a 3 s rAF count). Report the number; do not optimise.
- [ ] **Step 4:** Update README (wizard section), CLAUDE.md Status (sub-project 2 done, test count), memory file (part 2 done). Stop the dev server and kill leftover vite on 5317.
