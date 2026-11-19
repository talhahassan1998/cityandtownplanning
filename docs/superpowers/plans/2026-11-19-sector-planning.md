# Sector Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional wizard mode that groups housing into population-sized sectors, each with its own park, market and mosque.

**Architecture:** A pure `src/sectors.ts` clusters the finished residential plots (k-means) and picks amenity plots per sector; `generatePlan` turns that into drafts between the street network and the facilities step. Off by default — output unchanged.

**Tech Stack:** TypeScript, Turf 7, Vitest, React (WizardDialog).

**Spec:** `docs/superpowers/specs/2026-11-19-sector-planning-design.md`

## Global Constraints
- `DEFAULT_BRIEF.sectors = { on: false, perSector: 5000, park: true, market: true, mosque: true }`.
- With `sectors.on === false`, `generatePlan` drafts are byte-identical to today's.
- Sector count = `ceil(targetPopulation / perSector)`, clamped to `1 … floor(distinct blocks / 2)`.
- Sector mosques count toward `facilities.religious`; step 3 places only the remainder.
- `masterplan.ts` steps 3–5 are copied in `existingplan.ts` — do NOT touch existingplan.ts (normal wizard only).
- Ponytail style: minimal code, `ponytail:` comments for the three ceilings in the spec. Icons via lucide-react if any.
- Tests: `npx vitest run <file>`; type-check `npx tsc`.

## Review Focus
1. Sector on a site with a single residential block (tiny site / huge perSector): count clamps to 1, no crash, park skipped if no second block — Task 1 test `clamps on few blocks`.
2. `perSector` 0 or empty input in the wizard → treat as off, never divide by zero — Task 2 test `perSector 0 behaves as off`.
3. Mosque switched off but market on: market still placed — Task 1 test `market without mosque`.
4. Plot names stay unique with sectors on (no two drafts share `plotNo`) — Task 2 test.
5. Religious target smaller than sector count (e.g. 1 per 50 000): sectors still each get a mosque, step 3 adds none — Task 2 test.

---

### Task 1: `src/sectors.ts`

**Files:**
- Create: `src/sectors.ts`
- Test: `src/sectors.test.ts`

**Interfaces:**
- Consumes: `GeneratedPlot` (`src/geo.ts:137`), `frame` (geo.ts).
- Produces:
  ```ts
  export interface SectorOpts { park: boolean; market: boolean; mosque: boolean }
  export interface Sector { index: number /* 1-based */; plots: GeneratedPlot[]; mosque?: GeneratedPlot; market: GeneratedPlot[]; park?: { geometry: Polygon; plots: GeneratedPlot[] } }
  export function planSectors(plots: GeneratedPlot[], count: number, opts: SectorOpts): Sector[]
  ```
  Every input plot is in exactly one `Sector.plots`; mosque/market/park plots are subsets of it and disjoint.

- [ ] **Step 1: Write failing tests** in `src/sectors.test.ts`. Build fixture plots with a helper `grid(blocksX, blocksY, perBlock)` making 20 × 30 m rectangle plots (via `footprint` around a fixed origin e.g. `[73.05, 33.7]`, metres → degrees through `frame(origin).toGeo`), `block: 'B<n>'`, unique `number`.
  - `splits into the requested number of sectors`: 4×4 blocks × 8 plots, count 4 → `length 4`, every plot appears once across `plots`.
  - `gives every sector one mosque, a market and a park`: same fixture → each sector has `mosque`, `market.length > 0`, `park.plots.length > 0`; mosque/market/park plot sets disjoint; market plots share the mosque's `block`; park plots share one block different from it.
  - `skips switched-off amenities`: `{ park: false, market: true, mosque: false }` → no `mosque`, no `park`, market non-empty.
  - `market without mosque` covered by the above.
  - `is deterministic`: two calls → `JSON.stringify` equal.
  - `clamps on few blocks`: 1 block × 8 plots, count 5 → `length 1`, `park` undefined (no second block).
- [ ] **Step 2:** `npx vitest run src/sectors.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.** Centroids in `frame(meanCentroid)` metres. Clamp `k = max(1, min(count, floor(blocks / 2)))`. k-means, max 20 iterations, seeding:
  ```ts
  // seed 1 = point farthest from the mean; each next seed = point farthest from its nearest seed
  ```
  Empty cluster after an iteration → keep its previous centre. Per sector: centre = mean of its points; mosque = nearest plot (if `opts.mosque`); market block = mosque's block, or the nearest plot's block when mosque off; `market` = that block's remaining plots in this sector (if `opts.market`); park block = block (within this sector) whose nearest plot to the centre is closest, excluding the market block; geometry = `turf.union` of its plots (largest polygon if multi). Add `ponytail:` comments: park = one block (not m²/person); market not on busiest street.
- [ ] **Step 4:** `npx vitest run src/sectors.test.ts` → PASS.
- [ ] **Step 5: Commit** `git add src/sectors.ts src/sectors.test.ts && git commit -m "Add sector clustering for per-sector park, market and mosque"`

### Task 2: wire into `generatePlan`

**Files:**
- Modify: `src/masterplan.ts` (Brief ~l.13–42, step 3 ~l.221–246, plot drafts ~l.256–257, metrics/checks ~l.266–282)
- Test: `src/masterplan.test.ts`

**Interfaces:**
- Consumes: `planSectors`, `Sector` (Task 1).
- Produces: `Brief.sectors: { on: boolean; perSector: number; park: boolean; market: boolean; mosque: boolean }`; `Proposal.metrics.sectors: number` (0 when off).

- [ ] **Step 1: Write failing tests** in `src/masterplan.test.ts` (use the file's existing `site`, `DEFAULT_BRIEF`, `VARIANTS[0]`; brief `{ ...DEFAULT_BRIEF, targetPopulation: 15000, sectors: { ...DEFAULT_BRIEF.sectors, on: true } }`):
  - `plans each sector with its own park, market and mosque`: `metrics.sectors >= 2`; count of `religious` drafts ≥ `metrics.sectors`; park drafts named `/^Sector \d+ park$/` count = `metrics.sectors`; check `Each sector has its park / market / mosque` exists and `ok`; residential plot drafts have `attrs.sector` set and names matching `/^Plot S\d+-R\d+-/`.
  - `keeps plot numbers unique with sectors on`: `new Set(plotNos).size === plotNos.length`.
  - `does not add town-wide mosques beyond the sectors when the target is met`: brief `facilities.religious: 50000` → religious drafts === `metrics.sectors`.
  - `leaves the plan unchanged with sectors off`: `JSON.stringify(generatePlan(site, DEFAULT_BRIEF, v).drafts)` equals a run with `sectors: { ...DEFAULT_BRIEF.sectors, on: false, perSector: 1234 }`, and no draft has `attrs.sector`.
  - `perSector 0 behaves as off`: `on: true, perSector: 0` → `metrics.sectors === 0`.
- [ ] **Step 2:** `npx vitest run src/masterplan.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement.**
  - Add `sectors` to `Brief` + `DEFAULT_BRIEF` (Global Constraints values).
  - Extract the facility-building body of step 3 into a local `placeFacility(spot: GeneratedPlot, type: string)` (pushes the draft, adds to `used`, sets `spot.zone = 'institutional'`); step 3 calls it unchanged.
  - Before step 3, when `b.sectors.on && b.sectors.perSector > 0`: run `planSectors(free residential plots, ceil(targetPopulation / perSector), b.sectors)`. For each sector: `placeFacility(mosque, 'religious')` and `facilities.religious++`; market plots `zone = 'commercial'`; park → `drafts.push({ type: 'park', geometry, attrs: { ...tag, zoning: 'green', sector: n }, name: \`Sector ${n} park\` })` and remove its plots from `plots` (and `free`); record plot → sector for naming.
  - Step 3: start `facilities[k]` from the existing count and place only `n - facilities[k]` more.
  - Plot drafts: prefix `S${n}-` to `plotNo`/name and add `attrs.sector = n` for plots in a sector.
  - `metrics.sectors`; check `{ label: 'Each sector has its park / market / mosque', ok, detail: '<n> sectors' + missing list }` pushed only when sectors ran, counting only enabled amenities.
  - Facilities check: religious target is `max(ceil(pop/per), sectors-with-mosque)` — unchanged formula still passes since count ≥ target.
- [ ] **Step 4:** `npx vitest run src/masterplan.test.ts src/sectors.test.ts && npx tsc` → PASS, no type errors (also `existingplan.ts` compiles; it ignores `sectors`).
- [ ] **Step 5:** `npm test` → all pass (454 + new).
- [ ] **Step 6: Commit** `git add src/masterplan.ts src/masterplan.test.ts && git commit -m "Wizard: optional sector planning with per-sector park, market and mosque"`

### Task 3: wizard option, docs, browser check

**Files:**
- Modify: `src/ui/WizardDialog.tsx` (Land use step; checkbox style as at l.211–212)
- Modify: `.claude/CLAUDE.md` (Architecture: one `sectors.ts` line; test count)

**Interfaces:**
- Consumes: `Brief.sectors` (Task 2).

- [ ] **Step 1:** In the Land use step, when `mode !== 'roads'`: checkbox **Plan in sectors** (`b.sectors.on`); when on, `num('People per sector', b.sectors.perSector, …, 'people')` and checkboxes **Park**, **Market**, **Mosque**, plus a muted line: "Each sector gets its own amenities near its centre, like DHA / Bahria phases."
- [ ] **Step 2:** `npx tsc && npm run build` → success.
- [ ] **Step 3: Browser check** (`npm run dev -- --port 5317 --strictPort`; set `__store.setState({ dirty: false })` before reloads): wizard on the default site, 15 000 people, sectors on → proposal shows the sector check passing; accepted plan shows one park + market shops + mosque per sector in 2D and 3D; sectors off → same layout as before.
- [ ] **Step 4:** Update `.claude/CLAUDE.md` (sectors.ts line, test count). Do NOT commit these two files: both already carry other uncommitted work on this branch (build-on-roads, Google Earth, login) — leave them for the user's branch commit.
