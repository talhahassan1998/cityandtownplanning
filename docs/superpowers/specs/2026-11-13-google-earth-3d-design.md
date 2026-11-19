# Google Earth (3D) background option — design

Date: 2026-11-13 · Status: approved in chat, spec awaiting review

## Goal
The user wants "Google Earth, not Google Maps" in the project: Google's photorealistic 3D world (real buildings,
trees, terrain) around their plan. User constraint: **don't change anything existing — just add a new option.**

## What changes
1. `model.ts`: `BasemapId` gains `'google-earth'`; `BASEMAPS` gains `{ id: 'google-earth', label: 'Google Earth (3D)' }`
   after Google Satellite. Nothing else in the list changes.
2. 2D map (`map/MapCanvas.tsx`): `google-earth` shows Google satellite tiles (the 2D map cannot draw 3D). One condition
   widened: satellite when basemap is `google-satellite` **or** `google-earth`.
3. 3D view (`three/CityView.tsx`): when basemap is `google-earth` and a key is set, our terrain mesh is not built;
   a Google Photorealistic 3D Tiles layer is added instead, placed so the scene origin (`sceneBounds` origin) sits on
   the tiles' ground. Plan buildings, roads, cars, lights draw on top unchanged (they use flat ground, as with Terrain off).
4. New module `three/earth.ts` (lazy, only imported when the option is chosen):
   `loadEarth(key, origin, renderer, camera) → { group, update(), attribution(), dispose() }` using
   `3d-tiles-renderer@0.5.3` (`TilesRenderer` + `GoogleCloudAuthPlugin` + `ReorientationPlugin` at origin lat/lon).
   `update()` is called once per frame from CityView's render loop.
   Ground height at origin found by one downward raycast against the loaded tiles; the group shifts so that ground is y=0.
5. Attribution: Google's required logo/copyright (from the tiles' attributions) shown in the 3D view's credit line.
6. Failure: no key / API error → `notify(...)` with the reason, and the 3D view falls back to our normal terrain.

## Not changing
Other basemaps, terrain options, KML, wizard, store shape, saved projects (an old project never has `google-earth`).

## Known limits (`ponytail:` comments in code)
- Existing real buildings on the site show through planned ones (Google tiles can't be clipped per site).
- Plan sits on a flat level: on hilly sites it can float/sink relative to Google's ground.
- Usage is billed per tile load on the user's Map Tiles API allowance.

## Testing
- Unit (`three/earth.test.ts`): `BASEMAPS` contains `google-earth`; origin-placement maths (pure helper) puts the
  origin at y≈0.
- `npx tsc`, `npm test`, `npm run build` (check the library is in a separate lazy chunk).
- Browser with the user's key: option visible, 2D shows satellite, 3D shows photorealistic tiles with plan on top,
  attribution visible, fallback message without a key.
