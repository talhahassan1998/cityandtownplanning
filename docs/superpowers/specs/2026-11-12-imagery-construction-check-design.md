# Satellite construction check (Sentinel-2) — design

Date: 2026-11-12 · Status: approved in chat, awaiting spec review

## Goal
When the master-plan wizard analyses a site, also warn about **recent construction that OpenStreetMap doesn't show**
(land cleared, foundations, buildings going up), found by comparing free Sentinel-2 imagery of the site now with a year ago.

## Hard constraint
Existing behaviour is untouched. The OSM survey (`sitecheck.ts`), the blocked-site panel, "Plan around existing
development", "Build on the existing roads", generation and acceptance work exactly as today. The imagery check only
**adds** a warning; if it fails, is slow, or the server is offline, the wizard behaves as it does now.

## Decisions (from the brainstorm)
- Source: Sentinel-2 L2A via Element84 Earth Search STAC (`https://earth-search.aws.element84.com/v1`), public COGs,
  no key. Probe 2026-11-12 from the API container: STAC search 1.9 s, one band over ~1 km² 5 s; latest clear scene 2 days old.
- Runs on the backend (GDAL + numpy already in the image). No new dependency.
- Result is a **warning only**: never blocks generation, plots do not keep clear of patches.

## Detection (`backend/app/imagery.py`)
1. `scenes(bbox, start, end)`: STAC search, `eo:cloud_cover < 40`, newest first, max 6 items.
2. Two windows: **now** = last 60 days; **before** = the same 60-day window one year earlier (same season, so crops
   growing/harvested don't read as construction).
3. `composite(items, bbox)`: for each item read `red`, `nir`, `swir16`, `scl` clipped to the site bbox via
   `gdal.Warp('/vsicurl/…', outputBounds, dstSRS=EPSG:4326, 10 m-equivalent resolution)`; mask SCL classes
   cloud/shadow/snow/no-data (0, 1, 3, 8, 9, 10, 11); per-pixel median of unmasked values. Bands read in parallel
   (thread pool). Reflectance = DN / 10000 (offset handled per the item's `raster:bands` metadata when present).
4. Indices: NDVI = (nir−red)/(nir+red); NDBI = (swir16−nir)/(swir16+nir); BSI = ((swir16+red)−nir)/((swir16+red)+nir).
5. `detect(before, now) -> bool mask` (pure, numpy only): pixel flagged when both composites are valid and
   (NDVI_before − NDVI_now > 0.2 and BSI_now > BSI_before + 0.05) **or** (NDBI_now − NDBI_before > 0.15).
6. Pixels outside the site polygon are dropped (`gdal.Rasterize` of the site). Flagged pixels are polygonised
   (`gdal.Polygonize`, 8-connected); patches < 1000 m² (≈10 pixels) are discarded.
7. Too little clear data (< 50 % of site pixels valid in either composite) → `status: 'no-clear-image'`, never "clear".

Thresholds are module constants marked `ponytail:` — tuned on real sites during browser verification, not
learned.

## API (`backend/app/main.py`)
`POST /api/imagery/construction`, session required (like every route but /health and /auth).
- Body: `{ "site": GeoJSON Polygon }`. Site area > 25 km² → 422.
- 200: `{ status: 'ok' | 'no-clear-image', now: 'YYYY-MM-DD' | null, before: 'YYYY-MM-DD' | null,
  patches: FeatureCollection (Polygon, properties { area_m2 }), attribution: 'Contains modified Copernicus Sentinel data <year>' }`
- Upstream (STAC/COG) unreachable or timeout (60 s total) → 502 with a message. No caching (YAGNI).

## Frontend
- `src/imagery.ts`: `checkConstruction(site)` calls the route through `api.ts` conventions; returns the result or
  throws. `imageryNote(result | Error) -> { tone, text }` (pure): text such as
  "Satellite imagery (Sentinel-2, 10 Nov 2026 vs 12 Nov 2025): 2 areas changed recently, 0.8 ha — possible
  construction. Check on the ground." / "no clear image" text / null when no patches.
- `WizardDialog.tsx`: when the survey starts, start `checkConstruction` in parallel (not awaited by the survey).
  Show its outcome as one amber note in step 5 (above proposals / blocked panel), states:
  checking… / warning + "Show on map" / "no recent change detected" / "Imagery check unavailable (needs the server)" / error message.
  Nothing in the existing generate/plan-around/build-on-roads paths reads this state.
- "Show on map": toggles the patches into the existing store preview (`setPreview`, `properties.color` amber),
  already cleared when the wizard unmounts. Not added to project features; not undoable state.
- Attribution line shown with the warning.

## Limits (UI hint + README)
10 m pixels: finds construction sites (≥ ~0.1 ha), not one new house. Only change in the last year. Ploughing,
flooding, fires can false-alarm — always labelled "possible".

## Testing
- `backend/tests/test_imagery.py`: `detect` on synthetic arrays (vegetation → bare flagged; stable bare not flagged;
  seasonal-identical not flagged; masked pixels ignored); route with `scenes`/`composite` monkeypatched
  (ok, no-clear-image, > 25 km² → 422, unauthenticated → 401).
- `src/imagery.test.ts`: `imageryWarning` texts.
- Regression: full `npm test` (443) and backend pytest must still pass; `npx tsc`, `npm run build`.
- Browser: a site with known recent construction and an untouched farmland site; server stopped → "unavailable" and
  the wizard still generates.
