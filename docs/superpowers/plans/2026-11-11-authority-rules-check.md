# CDA / RDA Rules Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-pick CDA or RDA from the site's location and add ✓/✗ rows comparing every wizard alternative with that authority's housing-scheme rules.

**Architecture:** New pure module `src/authority.ts` (rule data, `detectAuthority`, `authorityChecks`) plus bundled outlines `src/data/authority-areas.json`. `WizardDialog.tsx` gets a rules dropdown on the Site step and appends the rows to each proposal's `checks` after generation. Generators (`masterplan.ts`, `existingplan.ts`) are not touched.

**Tech Stack:** TypeScript, Turf 7, Vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-11-authority-rules-check-design.md`

## Global Constraints

- Rule values, clauses and unit conversions exactly as the spec's two tables (1 acre = 4 046.86 m², 1 sq yd = 0.836127 m², 1 ft = 0.3048 m, Punjab marla = 272 sq ft → kanal 505.86 m²).
- Row labels `CDA: <rule>` / `RDA: <rule>`; `detail` = `<measured> (<limit>; <clause>)` so the table's `detail.split(' (')[0]` shows the measured value.
- Source line under the table, exact: CDA → `Rules: CDA SRO 64(I)/2020 (Revised Modalities & Procedures) — superseded by SRO 886(I)/2023; verify against the current text. Percentages are subject to minor adjustments for site conditions.` RDA → `Rules: Punjab Private Housing Schemes & Land Sub-Division Rules 2010 — RDA now applies the Punjab DA Private Housing Schemes Rules 2021 (amended 2026); verify against the current text.`
- `git diff src/masterplan.ts src/existingplan.ts` must show nothing new from this feature.
- Outline data credited `© OpenStreetMap contributors, ODbL`. Nominatim is called only once, at implementation time, with a generic User-Agent (`UrbanForge-dev/0.6`), never from the app.
- No commits unless the user asks (branch `feat/build-on-roads` holds uncommitted work).

## Review Focus

1. A site straddling the ICT / Rawalpindi border: the centroid decides; a point 300 m inside each side must detect correctly → Task 1 test `border points`.
2. A proposal with no plots (`Buildable blocks: none found`) or a zero-area site: rows still render, no NaN/Infinity → Task 2 test `empty proposal`.
3. Existing roads that run far outside the site: only their length inside the site counts towards roads % → Task 2 test `clips existing roads`.
4. The user picks None: no rows and no source line; Auto on a Karachi site behaves the same → Task 3 browser step.
5. Plots flagged with an `issue` must not count towards plot-size and economy rules → Task 2 test `ignores flagged plots`.

---

### Task 1: Authority outlines and auto-detection

**Files:**
- Create: `src/data/authority-areas.json`, `src/authority.ts`
- Test: `src/authority.test.ts`

**Interfaces:**
- Produces: `export type AuthorityId = 'none' | 'cda-2-5' | 'cda-4' | 'rda'`; `export function detectAuthority(p: Position): { id: AuthorityId; area: string }` (`area` = `'Islamabad Capital Territory'`, `'Rawalpindi District'` or `''`).

- [ ] **Step 1: Write the failing tests** — `detectAuthority([73.05, 33.72])` → `{ id: 'cda-2-5', area: 'Islamabad Capital Territory' }`; `[73.06, 33.59]` → `{ id: 'rda', area: 'Rawalpindi District' }`; `[67.03, 24.94]` → `{ id: 'none', area: '' }`; `border points`: the two points 300 m either side of the ICT boundary on the line from (73.05, 33.72) to (73.06, 33.59) (find the crossing with `turf.lineIntersect` on the bundled ICT outline in the test) detect `cda-2-5` and `rda`.
- [ ] **Step 2: Run** `npx vitest run src/authority.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Build the data file** with a scratchpad script (not committed): `GET https://nominatim.openstreetmap.org/search?q=<name>&format=geojson&polygon_geojson=1&limit=1` for `Islamabad Capital Territory` and `Rawalpindi District, Punjab, Pakistan` (header `User-Agent: UrbanForge-dev/0.6`), `turf.simplify(…, { tolerance: 0.001, highQuality: true })`, coordinates rounded to 5 decimals. Write `{ "attribution": "© OpenStreetMap contributors, ODbL", "areas": [{ "name": …, "authority": "cda-2-5" | "rda", "geometry": … }] }`. Expected: file < 60 KB, each geometry valid (`turf.booleanValid`).
- [ ] **Step 4: Implement `detectAuthority`** — first area whose geometry contains the point (`turf.booleanPointInPolygon`), else `none`. Add `// ponytail: outlines simplified ≈ 100 m, no ICT zone outlines — sites near a border or in Zone 4 use the wizard override`.
- [ ] **Step 5: Run** the test file — Expected: PASS. `npx tsc` clean.

### Task 2: Rules and the comparison

**Files:**
- Modify: `src/authority.ts`
- Test: `src/authority.test.ts`

**Interfaces:**
- Consumes: `AuthorityId` (Task 1); `Proposal`, `Brief`, `Existing` types from `masterplan.ts`.
- Produces: `export const AUTHORITIES: Record<Exclude<AuthorityId, 'none'>, { name: string; short: 'CDA' | 'RDA'; source: string }>` (`name`: `CDA — Zones 2 & 5`, `CDA — Zone 4`, `RDA (Punjab 2010 rules)`; `source` = the exact Global Constraints line); `export function authorityChecks(p: Proposal, site: Polygon, id: AuthorityId, existing: Existing, b: Brief): Proposal['checks']` (`[]` for `none`).

- [ ] **Step 1: Write the failing tests.** Fixture: a 500 × 500 m site (25 ha) built with `footprint`; a hand-built `Proposal` whose drafts give exactly — residential plots 50 % of the site (200 m² plots, one 100 m² plot), green `zone` 12 %, commercial plots 5 %, institutional plots 6 %, local streets totalling 25 % (length × 12 m width); `existing` empty; `brief` = `DEFAULT_BRIEF` with `localStreetWidth: 12.2`.
  - `CDA zones 2&5`: rows `Scheme area` ok (25 ha ≥ 20.2 ha), `Residential` ok, `Open space` ok, `Roads` ok, `Graveyard` **fail** with detail starting `none reserved`, `Commercial` ok, `Public buildings` ok, `Street width` ok, `Smallest residential plot` ok (100 m² ≥ 75.3), `Economy housing` ok iff ≥ 10 % of residential plot area is in plots ≤ 108.7 m² (build the fixture so it is ok).
  - `CDA zone 4`: `Open space` fails at 12 % (< 15 %); `Smallest residential plot` fails (100 < 108.7).
  - `scheme area`: same proposal on a 200 × 200 m site → CDA `Scheme area` fails.
  - `RDA`: add one 1 200 m² residential plot and an existing 16 m road in `linkedTo` → `Largest residential plot` fails, `Access road` fails (16 < 18.29), `Commercial` ok (4.5–5.5 %), `Low-income plots` evaluated as share of plot count ≤ 126.4 m².
  - `clips existing roads`: a 16 m existing road 2 km long crossing the site adds only 500 m × 16 m to roads.
  - `ignores flagged plots`: a residential plot with `issue` of 30 m² does not fail `Smallest residential plot`.
  - `empty proposal`: no drafts → every row has a finite number in `detail`, no throw.
  - `none`: `authorityChecks(…, 'none', …)` → `[]`.
- [ ] **Step 2: Run** — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the rule tables as data (one array per authority: `{ rule, clause, measure, test }`) and `authorityChecks`. Measures per the spec's "Comparison" list; roads from existing = `lengthInside`-style clip of each `existing.roads` geometry to the site (use `turf.lineSplit` + midpoint-in-site, as `existingplan.ts` does) × width; access road = max width over `road-arterial` drafts and `existing.roads[linkedTo]`. Percent details to 1 decimal; areas in ha (2 decimals) or m². Graveyard `// ponytail: no generator reserves a graveyard yet — always fails until a graveyard land use exists`.
- [ ] **Step 4: Run** the test file, then `npm test` — Expected: all PASS. `npx tsc` clean.

### Task 3: Wizard

**Files:**
- Modify: `src/ui/WizardDialog.tsx` (Site step ~line 155–167; `generate` ~line 99–110; below the proposals table)

**Interfaces:**
- Consumes: `detectAuthority`, `authorityChecks`, `AUTHORITIES`, `AuthorityId` (Tasks 1–2).

- [ ] **Step 1:** State `const [rulesChoice, setRulesChoice] = useState<'auto' | AuthorityId>('auto')`; `const detected = useMemo(() => detectAuthority(turf.centroid(site).geometry.coordinates), [site])`; `const authority = rulesChoice === 'auto' ? detected.id : rulesChoice`. Changing the choice clears proposals (`setProposals([])`).
- [ ] **Step 2:** Site step, after the "Site area" line: a `<select className="input">` with options `Auto — <detected name or 'none'>`, `None`, the three `AUTHORITIES` names; under it, when Auto found one: `Auto: site is in <area>.`
- [ ] **Step 3:** In `generate`, after the loop: `out.forEach((p) => p.checks.push(...authorityChecks(p, site, authority, sv, b)))` (before `setProposals`).
- [ ] **Step 4:** Under the proposals table, when `authority !== 'none'`: `<p className="text-[11px] text-muted">{AUTHORITIES[authority].source}</p>`.
- [ ] **Step 5: Verify** `npx tsc`, `npm test`, `npm run build` all pass.
- [ ] **Step 6: Browser check** (port 5317, `--strictPort`; `__store.setState({ dirty: false })` before reloads; undo test objects afterwards; stop the server): boundary in Islamabad (e.g. around 73.10, 33.62 in Zone 5) → Site step says CDA Zones 2 & 5 (auto); generate (skip OSM if Overpass is down) → CDA rows in the table, graveyard ✗, source line shown. Boundary in Rawalpindi (73.05, 33.60) → RDA rows. Choose None → no rows, no source line. Karachi → Auto says none.

### Task 4: Docs

**Files:**
- Modify: `README.md` (wizard section), `.claude/CLAUDE.md` (Architecture line + test count)

- [ ] **Step 1:** README: one paragraph — auto-selected authority, what is compared, the two sources and that both are superseded (verify), graveyard limit, OSM attribution of the outlines.
- [ ] **Step 2:** CLAUDE.md: `` `authority.ts` CDA/RDA rules check: `detectAuthority` (bundled ICT + Rawalpindi District outlines, `data/authority-areas.json`, OSM ODbL) → `authorityChecks` rows appended to every wizard proposal; values = CDA SRO 64(I)/2020 and Punjab 2010 rules (both superseded — 2023 / 2021 texts not found; swap the data when available) ``; update the test count.
