# Sector planning (DHA / Bahria style) — design

Date: 2026-11-19 · Status: approved in chat, awaiting spec review

## Goal
Optional wizard mode: the town's housing is grouped into **sectors**, and every sector gets its own
neighbourhood **park**, local **market** and **mosque** near its centre (as in DHA / Bahria Town phases).
Each amenity can be switched off. Off by default — with it off, generated plans are identical to today's.

Scope: the normal wizard (`generatePlan`) only. "Build on the existing roads" (`existingplan.ts`) comes later;
the option is hidden in that mode.

## Decisions (from the user)
- Sector size is set **by population**: `count = ceil(targetPopulation / perSector)`, default 5 000 people per sector.
- Per-sector amenities: park, market, mosque (no per-sector school).
- Approach A: group finished plots into sectors after the street network is built. The street network,
  water/bridge handling and plan-around logic are untouched.

## Brief
`Brief.sectors: { on: boolean; perSector: number; park: boolean; market: boolean; mosque: boolean }`
`DEFAULT_BRIEF.sectors = { on: false, perSector: 5000, park: true, market: true, mosque: true }`
(The brief is not persisted, so no migration.)

## `src/sectors.ts` (pure, no drafts)
`planSectors(plots: GeneratedPlot[], count: number, opts: { park; market; mosque }): SectorPlan`

- Input: free (no `issue`), residential plots. Centroids are taken in a local `frame()` around their mean.
- `count` clamped to `1 … floor(plots / plotsNeededPerSector)` so every sector can hold its amenities.
- Clustering: k-means on plot centroids, deterministic seeding (first seed = plot farthest from the mean,
  then farthest-point), fixed iteration cap (20). Same input → same output.
- Per sector, centre = mean of its plot centroids:
  - **Mosque**: the plot nearest the centre.
  - **Market**: the other plots of the mosque plot's block (same `block`), rezoned `commercial`.
    If the mosque is off, the market takes the block of the nearest plot.
  - **Park**: the whole block nearest the centre (by its nearest plot) other than the market/mosque block;
    its plots become one park polygon (`turf.union`) and are removed from sale.
- Returns `{ sectors: { index, plots, mosque?, market: plot[], park?: { geometry, plots } }[] }` and a
  plot → sector index map.

## `generatePlan` changes
- After `connectEnds` / bridges and before step 3 (facilities), if `b.sectors.on`, call `planSectors` on the
  free residential plots.
- Facility building creation (footprint sizing, ≤ 45 % coverage, institutional attrs) is extracted into a local
  `placeFacility(spot, type)` helper used by both the sector mosques and step 3.
- Sector mosques go through `placeFacility(spot, 'religious')` and are added to `used`; they count toward
  `facilities.religious`, so step 3 places only the remainder of the town-wide religious target.
- Market plots: `zone = 'commercial'` before infill, so `fillPlot` puts shops on them.
- Park: a `park` draft (`zoning: 'green'`, name `Sector N park`); its plots are dropped from `plots`.
- Every residential plot gets `attrs.sector = N`; plot numbers become `S{N}-R{band}-B…` (e.g. `Plot S2-R1-B3-4`).
- `metrics.sectors` = sector count; check **"Each sector has its park / market / mosque"** (only the enabled
  amenities; ok when every sector got each one).
- Dwellings/population are recounted as today, so the population check shows the land given to amenities.

## Wizard (Land use step)
Checkbox **Plan in sectors**; when on, show **People per sector** and checkboxes **Park**, **Market**,
**Mosque**. Hidden in "Build on the existing roads" mode.

## Tests
- `src/sectors.test.ts`: expected sector count; one mosque, one market, one park per sector; a switched-off
  amenity is skipped; deterministic; count clamped on few plots.
- `src/masterplan.test.ts`: sectors on → one religious building per sector and the new check passes;
  sectors off → drafts identical to the default brief's output.

## Known ceilings (`ponytail:` comments)
- Park = one block, not sized per resident (e.g. m² per person).
- Market doesn't seek the busiest street.
- Sectors are plot clusters, not walled phases with gates and ring roads (approach B, later).
