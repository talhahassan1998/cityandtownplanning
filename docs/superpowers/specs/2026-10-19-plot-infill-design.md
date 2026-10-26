# Plot infill — generator fills plots with buildings (sub-project 2 of 4)

## Goal
The master-plan wizard (`masterplan.ts`) today emits roads, zones, plots and civic facilities only. It should also place a realistic, rule-compliant building on every buildable residential, commercial and industrial plot, so a generated town looks like a town in 2D and 3D and its population/cost metrics reflect real building capacity. Output stays preliminary and fully editable (ordinary features, one undo step).

## User decisions
- Housing typology is chosen automatically from the brief's density (option A).
- Fill residential, commercial and industrial plots; civic plots keep today's facilities; green stays open (option A).
- New pure module `infill.ts`, called by the generator, reusable by sub-project 3.

## `src/infill.ts` (pure, tested)
- `housingType(density): 'villa' | 'house' | 'townhouse' | 'apartment'` — density in gross dwellings/ha: `< 15` villa, `15–40` house, `40–80` townhouse, `> 80` apartment.
- `fillPlot(plot, zone, rule, opts) → Draft | undefined` where `plot` is a `GeneratedPlot` (geometry, frontage, depth, angle, area, number), `rule` the zone's `ZoneRule` from the project ruleset (`GENERIC_RULESET` fallback), `opts` = `{ housing, axis, tag }`.
  - Type: residential → `housing`; commercial by plot area `< 800 m²` shop, `< 2000 m²` mixed-use, else office; industrial → factory on odd plot numbers, warehouse on even.
  - Footprint: start from the type's catalogue `w × d`, clamp to `(frontage − 2·setback) × (depth − 2·setback)`; scale uniformly so coverage ≤ 0.9 × `maxCoverage`. Townhouse width = full buildable frontage (row). Centred on the plot centroid, rotated to the plot angle. `ponytail:` centred placement; front-setback placement with a rear garden is the upgrade.
  - Floors = min(type default, `maxFloors`, ⌊`maxHeight` / FLOOR_HEIGHT⌋, ⌊`maxFAR` · plotArea / footprintArea⌋), at least 1. Height = floors × FLOOR_HEIGHT.
  - Dwellings are derived, never stored (project convention): the app's existing rule — `MULTI_UNIT` types (apartment, townhouse, mixed-use, tower) hold ⌊GFA × 0.8 / UNIT_SIZE (100 m²)⌋ units, plus `dwellingsPerPlot` per residential plot — moves into a shared `unitsOf(type, gfa)` in `geo.ts`, used by stats, compliance and the generator.
  - Floors are further capped so the plot's dwellings/ha stay ≤ `maxDensity`.
  - If the centred footprint breaks the setback (irregular plots), it shrinks in 10% steps (max 5) and is dropped if still failing.
  - Returns `undefined` when the buildable rectangle is under 6 × 6 m or the plot has an `issue` — the plot stays `planned`, nothing forced.
  - Attrs follow `defaultAttrs` conventions: `width, depth, rotation, floors, height, zoning`, plus the plan tag.

## Generator changes (`masterplan.ts`)
- `Brief.fillBuildings: boolean` (default `true`); `generatePlan(site, brief, variant, ruleset = GENERIC_RULESET)` — the wizard passes the project's ruleset.
- Residential plot size depends on the typology: villa/house as today (`plotSizeFor`); townhouse plots sized for a 6-unit row; apartment plots sized for one block — in each case plot area = units × the per-dwelling land area at the brief's density, so gross density still matches the brief.
- After facilities are placed, every unused, valid residential/commercial/industrial plot is passed to `fillPlot`; plots that get a building become status `planned` with the building alongside (plots holding facilities stay `reserved`).
- Metrics: `dwellings` = Σ over filled plots of (`dwellingsPerPlot` (1) on residential plots + `unitsOf(type, gfa)`) when filling (unchanged plot count when `fillBuildings` is off); population = dwellings × personsPerDwelling; `buildingCost` = all generated GFA (already computed from drafts with floors); budget check relabelled "Budget (roads + buildings)".

## Wizard (`ui/WizardDialog.tsx`)
- One checkbox "Fill plots with buildings", bound to `brief.fillBuildings`.

## Constraints & ceilings
- Buildings must produce zero compliance issues (`zoning.ts`) under the generic ruleset with the default brief.
- 3D was verified at 300 buildings ≈ 30 fps; the default brief yields ~1000 houses. Measure in the browser and report; no LOD work in this sub-project.
- Style: buildings use the project's style; per-building variety comes from the existing seeded recipes.

## Testing
- `src/infill.test.ts`: housingType thresholds; footprint inside plot inset by setback; coverage, floors, height, FAR within rule; density cap; tiny/invalid plot → undefined; commercial/industrial type selection.
- `src/masterplan.test.ts` (new cases): default brief → every generated building passes `zoning.ts` compliance; dwellings match `stats()` for the same features; `fillBuildings: false` reproduces today's output counts; high density (120) produces apartments, not 8 m plots.
- Browser check: generate default plan, view 2D + 3D in both styles, record fps.
