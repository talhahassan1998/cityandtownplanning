# Build on the existing roads — design

Date: 2026-11-11 · Status: approved in chat, awaiting spec review

## Goal

When the master-plan wizard's site lies on an existing city's roads, offer a new generator that **analyses the
existing road structure and builds the society on it**: the existing roads are the frame, the land between them
becomes blocks, big blocks get new local streets, and plots front existing or new streets.

It is a **new option**. The current generator (`generatePlan` in `src/masterplan.ts`) and its "Plan around existing
development" path are not changed: `masterplan.ts` stays byte-for-byte as it is (user decision, 2026-11-11).

## What the user said vs. assumptions

- Said: analyse the existing road structure / area and make the society with the existing road structure; keep the
  old code unchanged; add it as an option when generating. Chosen behaviour: "frame + new streets".
- Assumed: "existing roads" = the roads `surveySite` already finds (OpenStreetMap + project roads). Existing buildings
  are kept with the same clearance as today (3 m); water is never developed (10 m setback).

## User interface (`src/ui/WizardDialog.tsx`)

- The blocked-site panel today shows **Plan around existing development**. A second button, **Build on the existing
  roads**, sits beside it. It uses the same cached `survey` (no second Overpass request).
- The button shows only when at least one surveyed road intersects the site. Otherwise the wizard is unchanged.
- The wizard remembers which generator was chosen (`mode: 'grid' | 'roads'`), so "regenerate" and the alternatives
  count keep using it. Accept is the existing accept path: drafts plus the survey's `adds` (existing OSM roads,
  buildings, water as `status: 'existing'`), then pipes if `layPipes`.
- The step-4 help text gains one line describing the road-based generator when it is the active mode.

## Generator (`src/existingplan.ts`, new)

`generateOnRoads(site, brief, variant, ruleset, existing): Proposal`. It returns the same `Proposal` shape as
`generatePlan`, so the preview, metrics panel and accept path need no changes.

1. **Road analysis.** Existing roads intersecting the site → road surfaces at their surveyed width (`roadSurface`).
   Recorded per road: length inside the site, width and bearing.
2. **Blocks.** Site − road surfaces − buffered obstacles (3 m) − buffered water (10 m) (`turf.difference`). The pieces
   larger than one plot (w × d) are blocks; smaller pieces stay as open land inside the zone.
3. **Block orientation.** For each block, the existing road it fronts along the greatest length (block edge within
   half a road width + 1 m of that road's surface). Its local bearing there sets the block's `angle`. A block fronting
   no road (cut off by water or buildings) takes the bearing of the nearest road.
4. **Subdivision.** `subdivide(block, { angle, origin: a point on the fronting road's edge, startY, plotWidth,
   plotDepth, roadWidth: localStreetWidth, plotsPerBlock, minArea, minFrontage })`, so the first row of plots faces the
   existing road, and deep blocks get new local streets parallel to it. Plots are then:
   - cleared of existing road surfaces, obstacles and water (`clearRoads`);
   - re-measured for frontage against existing roads + the block's new streets (`measureFrontage`), with `plotIssue`
     re-run;
   - dropped when they front no street (the land stays in the zone, as in `generatePlan`).
   New street segments that lie inside an existing road's surface are dropped.
5. **Connection.** `connectEnds([...existingRoads, ...newStreets], max(width)/2 + 1, existingRoads.length)` joins every
   new street end to the road it stops short of. New streets are `road-local` drafts named "Local street".
6. **Land use by whole block**, following the brief's mix by area share. Blocks are ranked by the width of the road
   they front (widest first), then by area:
   - Variant A: commercial on the top-ranked blocks → institutional → residential; green = the lowest-ranked and the
     least regular blocks (lowest plot yield per m²); industrial = the blocks farthest from the site centroid.
   - Variant B: the same with residential and institutional swapped, and green taken from the largest blocks
     (a central park) instead of the leftovers.
   Each block is filled with zones until its zone's share is met (a block is not split between zones). One `zone`
   draft per block; green blocks also get a `park` draft and no plots.
   `VARIANTS[i].angleOffset` is ignored by this generator (orientation comes from the roads); labels read
   "Road-based layout A/B".
7. **Facilities, infill, metrics, checks.** A copy of steps 3–5 of `generatePlan` (facilities on the largest valid
   institutional plots first, `fillPlot` infill, dwellings/population, road area/cost, checks). Copied, not shared,
   per the user's decision; marked `ponytail: copy of masterplan.ts steps 3–5, keep in sync`.
   Road area counts only **new** streets (existing roads are not costed).
8. **New check "Road analysis"**: always ok when ≥ 1 existing road was used. Detail: `N existing roads, X km, B blocks,
   average Y ha`.

## Limits (v1, each marked `ponytail:` in code)

- New streets stop at water (no bridges); `generatePlan`'s bridge logic is not copied.
- Curved existing roads are handled through their local bearing at the fronting edge; a strongly curved block edge
  gets a straight grid, so some edge plots fail frontage and are dropped.
- Odd-shaped leftovers stay open land; they are not merged into neighbouring plots.
- Generated streets are not checked against crossing existing buildings (same ceiling as `generatePlan`).
- Sites with no existing road on them don't show the option.

## Error handling

- No blocks large enough (the site is all road / building / water): the generator returns a proposal with no plots and
  a failed check "Buildable blocks: none found"; the wizard shows it like any failing check.
- Survey failure: the existing path (blocked message + "Generate without the OpenStreetMap check"). Without OSM only
  project roads are known, so the new button appears only if project roads cross the site.

## Testing

- `src/existingplan.test.ts` (new), a ~20 ha square site crossed by two perpendicular existing roads (16 m):
  - 4 blocks are found;
  - no plot intersects an existing road surface;
  - every valid plot has frontage > 0;
  - every new street end touches another street or an existing road (graph connectivity, as in the masterplan test);
  - land-use areas are within one block of the mix shares;
  - a site with a diagonal (45°) road gives plots aligned to ~45°;
  - a site with no roads on it returns the "Buildable blocks" failure, not a crash.
- The existing 413 tests stay green, which shows `generatePlan` is unchanged (`git diff src/masterplan.ts` empty).
- Browser check: one real urban site with an OSM street grid; generate both modes, accept the road-based one, and look
  at it in 2D and 3D.
