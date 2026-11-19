# Satellite Construction Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn in the master-plan wizard about recent construction on a site, detected by comparing Sentinel-2 imagery now vs a year ago.

**Architecture:** A backend module (`imagery.py`, GDAL + numpy) searches Earth Search STAC, builds cloud-masked median composites for two same-season windows, flags changed pixels and polygonises them; one FastAPI route exposes it. The wizard fires that request in parallel with the existing survey and shows a non-blocking note.

**Tech Stack:** FastAPI, GDAL 3.10 Python bindings, numpy (ships with the GDAL image), stdlib `urllib`/`concurrent.futures`; React 19 + Zustand frontend, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-11-12-imagery-construction-check-design.md`

## Global Constraints

- No existing behaviour changes: `sitecheck.ts`, `surveySite`, the blocked panel, plan-around, build-on-roads, generate and accept code paths must not read the imagery state.
- No new dependency (Python or npm).
- STAC: `https://earth-search.aws.element84.com/v1/search`, collection `sentinel-2-l2a`, `eo:cloud_cover < 40`, newest first, max 6 items per window; send header `User-Agent: urbanforge`.
- Windows: now = last 60 days; before = same 60 days one year earlier.
- SCL masked classes: 0, 1, 3, 8, 9, 10, 11.
- Thresholds: NDVI drop > 0.2 and BSI rise > 0.05, or NDBI rise > 0.15; min patch 1000 m²; < 50 % valid site pixels → `no-clear-image`; site > 25 km² → 422; 60 s total budget → 502 on upstream failure.
- Attribution text: `Contains modified Copernicus Sentinel data <year of now image>`.
- Result is always labelled "possible construction"; never a block.
- Run backend tests with `docker compose run --rm api python -m pytest -q` (plain pytest can't import `app`). In Git Bash prefix docker commands with `MSYS_NO_PATHCONV=1`.

## Review Focus

- Site straddling a Sentinel-2 tile edge (two items same date, partial coverage) → composite still fills the site from both; test: `composite` merges two half-covering items (Task 1).
- Newer L2A items carry `raster:bands` offset −1000 (processing baseline ≥ 04.00) while older ones don't → before/now reflectance must use each item's own scale/offset, otherwise every site "changes"; test: `reflectance` with and without offset (Task 1).
- All pixels masked in one window (monsoon cloud) → `no-clear-image`, not "no change"; test in Task 2 route test.
- Server offline / signed out / 502 while the wizard generates → generation proceeds unchanged and the note says unavailable; test: `imageryWarning` for error states + manual browser check (Tasks 3–4).
- Site polygon smaller than one pixel or a thin sliver → empty patches, no crash; test: `detect`+`patches` on a 1×1 grid (Task 1).

---

### Task 1: Detection core (`backend/app/imagery.py`)

**Files:**
- Create: `backend/app/imagery.py`
- Test: `backend/tests/test_imagery.py`

**Interfaces:**
- Produces:
  - `reflectance(dn: np.ndarray, band_meta: dict | None) -> np.ndarray` — float32 = dn*scale+offset (defaults 1e-4, 0; uses `band_meta["scale"]/["offset"]` when present); DN 0 → NaN.
  - `indices(red, nir, swir) -> dict[str, np.ndarray]` keys `ndvi`, `ndbi`, `bsi`.
  - `detect(before: dict, now: dict) -> np.ndarray[bool]` — inputs are `indices()` dicts; NaN in either → False.
  - `composite(stacks: list[dict[str, np.ndarray]]) -> dict[str, np.ndarray]` — each stack has `red`,`nir`,`swir16` (reflectance) and `scl` (int); masks SCL classes, per-pixel `np.nanmedian`.
  - `patches(mask: np.ndarray, site_mask: np.ndarray, gt: tuple, min_m2=1000) -> list[dict]` — GeoJSON Polygon features `{area_m2}` via `gdal.Polygonize` on an in-memory raster (8-connected); area in m² from `gt` pixel size × cos(lat) metres.
  - Constants `NDVI_DROP=0.2`, `BSI_RISE=0.05`, `NDBI_RISE=0.15`, `MIN_M2=1000`, `MASK_SCL={0,1,3,8,9,10,11}`, each with a `ponytail:` comment ("hand-set thresholds; tune on real sites").

- [ ] **Step 1: Write failing tests** in `backend/tests/test_imagery.py` (synthetic 20×20 arrays, no network):
  - `test_vegetation_to_bare_is_flagged`: before red .05 nir .4 swir .15; now red .2 nir .25 swir .3 in a 5×5 block → `detect(...)[block].all()` and nothing else flagged.
  - `test_stable_and_seasonal_identical_not_flagged`: identical before/now → `not detect(...).any()`; stable bare soil both dates → not flagged.
  - `test_masked_pixels_ignored`: SCL 9 in one stack's block and the other stack valid → composite uses the valid one; all stacks masked → NaN → not flagged.
  - `test_reflectance_offset`: `reflectance(np.array([2000]), {"scale":1e-4,"offset":-0.1})` ≈ 0.1; `reflectance(np.array([2000]), None)` ≈ 0.2; DN 0 → NaN.
  - `test_composite_merges_half_covering_items`: two stacks each NaN/0 on opposite halves → composite fully finite.
  - `test_patches_min_area_and_tiny_site`: 10 m-pixel `gt` at lat 0; a 4×4 flagged block (1600 m²) → 1 patch with `area_m2` ≈ 1600 (±5 %); a 2×2 block → dropped; 1×1 grid → `[]`; pixels outside `site_mask` dropped.
- [ ] **Step 2: Run** `MSYS_NO_PATHCONV=1 docker compose run --rm api python -m pytest -q tests/test_imagery.py` → FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `backend/app/imagery.py` (call `gdal.UseExceptions()` at import).
- [ ] **Step 4: Run** the same command → all pass.
- [ ] **Step 5: Commit** `backend/app/imagery.py backend/tests/test_imagery.py` — "feat: Sentinel-2 change-detection core" (only when the user has asked for commits).

### Task 2: Fetching + route

**Files:**
- Modify: `backend/app/imagery.py`, `backend/app/main.py` (one model + one route after the convert routes)
- Test: `backend/tests/test_imagery.py`

**Interfaces:**
- Consumes: Task 1 functions.
- Produces:
  - `scenes(bbox: list[float], start: date, end: date) -> list[dict]` — STAC items (stdlib `urllib`, JSON POST, timeout 20 s).
  - `read_stack(item: dict, bbox: list[float], shape: tuple[int,int]) -> dict` — reads `red`,`nir`,`swir16`,`scl` hrefs via `gdal.Warp('/vsimem/…', '/vsicurl/'+href, outputBounds=bbox, outputBoundsSRS='EPSG:4326', dstSRS='EPSG:4326', width, height, resampleAlg='near')`, applies `reflectance` with each asset's `raster:bands[0]`. Set `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR`. Bands in a `ThreadPoolExecutor(8)`.
  - `construction(site: dict, today: date | None = None) -> dict` — returns `{status, now, before, patches: FeatureCollection, attribution}` per spec; raises `UpstreamError(str)` on network failure/timeout (60 s budget). Grid shape from bbox at 10 m (`frame` cos(lat)), site mask via `gdal.Rasterize` of the polygon.
  - Route `POST /api/imagery/construction` body `ConstructionRequest{site: dict}` (Polygon), `_: dict = User`; area via `osr`/`ogr` geodesic area or cos(lat) approximation > 25 km² → 422; `UpstreamError` → 502.

- [ ] **Step 1: Write failing route tests** (reuse `client`/`signed_in` pattern from `test_api.py`; monkeypatch `imagery.scenes` and `imagery.read_stack`):
  - `test_route_ok`: fake one item per window, stacks with a vegetation→bare block of 10×10 px → 200, `status == "ok"`, 1 patch, `now`/`before` dates, attribution contains `Copernicus Sentinel data`.
  - `test_route_no_clear_image`: all SCL 9 in now window → `status == "no-clear-image"`, `patches.features == []`.
  - `test_route_no_items`: `scenes` returns `[]` → `no-clear-image`.
  - `test_route_too_big`: 6 km × 6 km site → 422.
  - `test_route_upstream_down`: `scenes` raises `UpstreamError` → 502.
  - `test_route_needs_session`: anonymous `TestClient` → 401.
- [ ] **Step 2: Run** `… pytest -q tests/test_imagery.py` → new tests FAIL.
- [ ] **Step 3: Implement** `scenes`, `read_stack`, `construction`, `UpstreamError` and the route.
- [ ] **Step 4: Run** full backend suite `MSYS_NO_PATHCONV=1 docker compose run --rm api python -m pytest -q` → all pass (existing 8+ unchanged).
- [ ] **Step 5: Live smoke** (not a test): `docker compose exec -T api python3 -c "from app.imagery import construction; …"` on a 1 km² site → returns within 60 s with a status. Record the timing.
- [ ] **Step 6: Commit** (when asked) — "feat: /api/imagery/construction".

### Task 3: Frontend client + warning text

**Files:**
- Create: `src/imagery.ts`, `src/imagery.test.ts`
- Modify: `src/api.ts` (export one call)

**Interfaces:**
- Produces:
  - `api.ts`: `export const checkConstruction = (site: Polygon) => call<ConstructionResult>('/imagery/construction', json({ site }))`.
  - `imagery.ts`: `export type ConstructionResult = { status: 'ok' | 'no-clear-image'; now: string | null; before: string | null; patches: FeatureCollection<Polygon, { area_m2: number }>; attribution: string }`.
  - `imageryNote(r: ConstructionResult | Error): { tone: 'warn' | 'info'; text: string }` (pure). Texts:
    - patches: `Satellite imagery (Sentinel-2, <d Mon yyyy> vs <d Mon yyyy>): <n> area(s) changed recently, <ha 1 dp> ha — possible construction. Check on the ground.` (warn)
    - ok, none: `Satellite imagery (Sentinel-2, <now> vs <before>): no recent change detected (10 m pixels: a single new house can be missed).` (info)
    - no-clear-image: `Satellite imagery: no clear (cloud-free) image of this site in the last 60 days — construction not checked.` (info)
    - Error: `Imagery check unavailable (<message>).` (info); message `Failed to fetch`/`401…`/`502…` passed through.
- [ ] **Step 1: Write failing tests** in `src/imagery.test.ts` for all four texts (2 patches 3000 + 5000 m² → "2 area(s)", "0.8 ha", dates "10 Nov 2026 vs 12 Nov 2025").
- [ ] **Step 2: Run** `npx vitest run src/imagery.test.ts` → FAIL.
- [ ] **Step 3: Implement** (dates via `toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })`).
- [ ] **Step 4: Run** → PASS; `npx tsc` clean.
- [ ] **Step 5: Commit** (when asked).

### Task 4: Wizard note + Show on map

**Files:**
- Modify: `src/ui/WizardDialog.tsx`

**Interfaces:**
- Consumes: `checkConstruction` (api.ts), `imageryNote`, `ConstructionResult` (imagery.ts), store `setPreview`.

- [ ] **Step 1: Add state** `imagery: { site: Polygon; r?: ConstructionResult | Error } | null`. In `generate`, right where the survey starts (only when `!sv`, i.e. a new site), fire `checkConstruction(site).then(r => …, e => …)` without awaiting and without touching `busy`/`blocked`/`sv`. Stale responses (different `site`) are ignored. Reset it in the existing reset effect (line ~70).
- [ ] **Step 2: Render** in step 5, above the blocked panel: one bordered note — "Checking satellite imagery…" while pending, else `imageryNote(r)`; tone warn = amber border/text (use existing `warn` colour token if present, else `bad`); for patches a `btn` "Show on map"/"Hide" toggling `setPreview({ type:'FeatureCollection', features: patches with properties.color '#f5a524' })`, plus attribution in `text-muted text-[10px]` and "10 m pixels; ploughing or floods can false-alarm."
- [ ] **Step 3: Verify** `npx tsc`, `npm test` (all 443 + new pass), `npm run build`.
- [ ] **Step 4: Browser check** (dev server :5317, backend up; `__store.setState({ dirty: false })` before reloads):
  - site with known recent construction → warning + patches on map;
  - untouched farmland → "no recent change";
  - `docker compose stop api` → note "unavailable", generation still produces proposals exactly as before; restart api.
  - Record timings and any threshold tuning in the plan/README.
- [ ] **Step 5: Docs**: README section + `.claude/CLAUDE.md` architecture line for `imagery.py`/`imagery.ts` and test count. Commit (when asked).
