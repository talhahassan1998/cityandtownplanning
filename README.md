# UrbanForge — City & Town Planning Studio

A browser-based GIS/CAD planning editor: draw development boundaries and roads, subdivide land into plots, drag-and-drop buildings and facilities, inspect live planning statistics, and view the same data in 3D.

**Status: release 0.6 covers Phases 1–5.** Phase 3 adds zoning development controls per jurisdiction, compliance checking, thematic maps and a heatmap, land-use targets, and a printable planning report. Phase 4 adds a Three.js 3D city view with real terrain, roofs, sun and shadows, and orbit, top-down and walk cameras. Phase 5 adds infrastructure networks with connectivity checks, KML/KMZ, Shapefile, CSV, DXF and OpenStreetMap import/export, a print composer, and a master-plan wizard. Anything not built yet is shown in the UI as disabled with a `PLANNED` badge. No control pretends to work.

> Generated layouts are preliminary planning aids. They are **not** legally approved or construction-ready designs.

## Quick start

Requires Node.js 20+ (developed on Node 24).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest: geometry + persistence
npm run build      # type-check + production bundle in dist/
npm run preview    # serve the production build locally
```

No API keys or environment variables are needed. A new project opens at a default location; use **Projects… → New project** to set name and lat/lng.

### First workflow

1. `B` draws a development boundary. Click the first vertex to close it.
2. `R` draws a road centreline. Its surface is generated from the road width; change the road type in **Properties**.
3. Select the boundary, then **Subdivide…** generates plots, blocks and local streets. Existing roads are carved out of the new plots. Plots that fail area, frontage or access checks are kept and outlined red.
4. Drag houses, parks, schools and other components from **Components** onto the map, or double-click one to place it at the map centre.
5. Select a road to use the **Road tools**: lay plots along it (curved roads give curvilinear layouts), add roundabouts at its junctions, add a cul-de-sac turning head at either end, or cut back plots it overlaps.
6. Use the knife (`K`) to draw a line across plots and split them along it. Frontage is re-measured from the adjacent roads.
7. Select a plot to **split** it across its frontage or depth. Shift+click several adjacent plots and **merge** them. Plot rules (minimum area and frontage) sit under Properties when nothing is selected, and every plot re-validates when edited.
8. Click to select and drag to move. Drag vertices to reshape, drag a polygon corner to resize, and use **Properties** to set width, depth, rotation, floors and other attributes.
9. **Zoning rules…** (toolbar) sets the development controls per zone: max height, floors, FAR, ground coverage, min plot size, setback, density, and permitted uses. Buildings and plots are checked live. Violations are outlined red, explained in Properties, and listed in Analytics.
10. **2D/3D** opens the 3D city view. Click objects to select and edit them. Pick roof styles and colours in Properties, and mark roads as bridges or tunnels.
11. **Analytics** shows measured quantities and assumption-based estimates. **2D/3D** tilts the camera and extrudes buildings.
12. `Ctrl+S` saves to this browser. **Export** downloads the project file, GeoJSON, plot-schedule CSV or a PNG.

### Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| V | Select / edit | Ctrl+Z / Ctrl+Y | Undo / redo |
| H | Pan | Ctrl+C / Ctrl+V | Copy / paste |
| B | Boundary | Ctrl+D | Duplicate |
| Z | Zoning area | Del | Delete selection |
| P | Plot | Ctrl+S | Save |
| R | Road | Esc | Clear selection / cancel |
| U | Utility line | Shift+click | Multi-select |
| O | Point / node | Right-click | Context menu |
| K | Knife: split plots along a line | | |
| M / Shift+M | Measure distance / area | S | Toggle vertex + edge snapping |

## Architecture

```
src/
  model.ts            data model, component catalogue, zoning & road classes, defaults
  geo.ts              pure geometry: footprints, transforms, measurement, road surfaces,
                      subdivision, road clearance, analytics
  store.ts            Zustand store + zundo undo/redo (features & layers only)
  persist.ts          IndexedDB projects + recovery slot, validation, project/GeoJSON/CSV I/O
  map/MapCanvas.tsx   MapLibre rendering, Terra Draw drawing/editing, hit-testing, drag-drop
  ui/                 Toolbar, Library, Layers, Inspector, Analytics, dialogs
  App.tsx             layout, startup recovery, autosave, keyboard shortcuts
```

**One source of truth.** Every object is a GeoJSON feature in the store. The 2D map, the 3D extrusions, the inspector, the attribute tables and the analytics are all derived from it, so the views cannot drift apart. Derived geometry such as road surfaces is computed (and cached per feature version), never stored.

**Editing.** Terra Draw holds only the single feature being edited. On each finished drag or vertex edit the geometry is written back to the store as one undo step. Drawing tools hand the finished shape to the store and clear Terra Draw.

**Plots.** Subdivision stores each plot's street orientation (`angle`) and street side (`face`), which tells split which piece keeps the frontage. Hand-drawn plots assume the shorter side faces the street. The project's plot rules (`minPlotArea`, `minFrontage`) live in `settings`. Every plot change (edit, split, merge, rule change) recomputes `attrs.issue` from the current geometry, so validation never goes stale. Split and merge are single undo steps.

**Roads.** Roundabouts are true rings (outer radius plus island hole) and cul-de-sacs are circular turning heads. Both live on the road layer, count toward road area, and regenerate when their radius is edited. "Plots along this road" places stations every plot-width along the centreline and offsets them by half the road width (front) and the plot depth (rear). The front and rear edges pass through the centreline's own vertices, so plots follow curves, and neighbours reuse station points so they share edges exactly. A plot that spans a bend tighter than its depth is flagged. Plots are numbered odd on the left and even on the right.

**Measured frontage.** Wherever a layout can't know a plot's frontage (hand-drawn plots, knife cuts, cut-back plots), it is measured: the length of plot boundary that runs within half a road's width of its centreline and roughly parallel to it. Corner plots count both streets; side edges meeting a road at right angles don't count.

**Zoning and compliance** (`src/zoning.ts`). Each project carries a `ruleset` (name + controls per zoning category). It defaults to a generic template whose values are explicitly illustrative, not any country's regulations, and it can be edited, exported, and imported as JSON so each jurisdiction maintains its own. Editing the template renames it so reports don't claim the generic values. A building is anything with floors. Its zone is the zoning of the plot under its centroid, else of the zoning area containing it; buildings in no zone aren't checked.
- **Building checks:** height, floors, permitted use (by component category), staying inside its plot, and setback (minimum distance from every building vertex to the plot boundary).
- **Plot checks:** FAR (Σ footprint × floors ÷ plot area), ground coverage, density (dwellings/ha, using the same dwelling assumptions as Analytics), and minimum plot size for the zone.

Evaluation is pure and memoised on the immutable features map, so the map, Inspector and Analytics share one result per edit.

**Analytics additions.** Land use is compared against per-category targets (% of the development area; editable). Map themes colour plots by FAR or coverage relative to the zone limit, or by pass/fail. A heatmap shows gross floor area density.

**Reports.** Export → *Planning report (HTML)* produces a self-contained, printable document: a map snapshot, measured quantities, land use vs targets, plot sizes, assumption-based estimates (with the assumptions spelled out), the ruleset, and all compliance findings. It carries a "preliminary, not an approval" notice. Print it to PDF from the browser. *Compliance findings (CSV)* lists every violation with its value and limit.

**3D city view** (`src/three/`). The view is built from the same store as the 2D map, so the two can't drift apart.
- **`scene.ts`:** a pure builder (testable in Node) that turns features into a Three.js group.
  - Buildings sit on the lowest ground point under them and come from `buildings/`: a body extruded from the real footprint (L-shapes and courtyards kept), skinned with a generated façade texture (`facades.ts`: windows, frames, sills, shutters, brick/render/stone, with a bump map), plus a per-type recipe of footprint-parametric parts (`kit.ts`: roofs, parapets, balconies, awnings, shopfronts, porches, boundary walls, arcades, porticos, domes, towers, rooftop tanks…). All 25 building types have a recipe in two styles: **Western** (pitched tiled roofs, brick/render, gardens) and **Gulf** (flat parapet roofs, stone, screened windows, arches, compound walls). The project style is set in Analytics → Assumptions; any building can override it (Properties → Style). Roofs default to the style; a saved roof choice (flat, gable, hip, pyramid) still wins. Walls use a real-world finish from the style palette (varied per building, deterministic) unless a colour is set.
  - Each building is merged into one mesh per material, and materials are shared across buildings, so 300 buildings run at ~30 fps on integrated graphics. Small parts (balconies, signs, tanks) sit in a `details` group, hidden beyond 400 m in the 3D view and below zoom 17 on the map's 3D layer.
  - **Editing in 3D** (`three/edit3d.ts`, `CityView.tsx`): drag a selected building, facility, point item or area component across the ground to move it (it follows the terrain, snaps to the grid if on); drag the blue ring around the selection to rotate (15° steps, Shift for free rotation); drop components from the library straight onto the 3D ground. Each move or rotation is one undo step. Roads, plots and zones stay 2D-edited. A **compass** (top-right) shows north, east, south and west as the camera turns; click it to face north.
  - **Vehicles** (`cars.ts`, `traffic.ts`): procedural sedans, hatchbacks, SUVs, buses and trucks, drawn instanced (one draw call per vehicle type and material). They fill about 70% of parking bays, stand in road lanes on the project's **driving side** (Analytics panel, default left), and stand in front of houses, shops and civic buildings. None are placed within 12 m of a junction or on rail, cycle tracks, bridges or tunnels. At most 3,000 per scene. They follow the slope under their wheels. The **Cars** checkbox in the 3D panel turns them off; on the map's 3D layer they appear from zoom 17.
  - **Lanes**: one lane layout per street (`laneLayout` in `traffic.ts`) drives both the cars and the road markings: lanes fill the whole carriageway (no on-street parking), with dashed lines between lanes going the same way, a centre line (double on arterials and highways) between directions, and edge lines. Markings stop at junctions and also show on the map's 3D layer.
  - **Moving traffic and time**: with Cars on, vehicles drive the street network (`drive.ts`): they follow their lane, give way in junctions, thin out at night and queue when it is busy (seeded, so a given plan behaves the same each time). The Time row in the 3D panel plays or pauses the clock at ×1, ×60, ×600 or ×3600; the sun, shadows and sky follow it, and the slider (00:00-24:00) sets the hour by hand.
  - **Night** (`night.ts`): as the sun sets, windows light up by use (homes in the evening, offices on office hours, shops until late), street lamps glow with a light pool on the road, and moving cars switch on headlights and tail lights. It is a look only (no real lights), so it costs almost nothing.
  - **Terrain**: everything on the ground samples the rendered terrain mesh itself, and roads, plots, zones and parking lines are cut along its triangles, so the ground never cuts through them on hilly sites.
  - Plots form one merged mesh, with a triangle-to-plot table for click picking.
  - Roads become draped surfaces with lane markings and instanced street lights. Bridges run straight between their abutments (never below ground + 0.5 m), with piers every 25 m. Tunnels show their route dashed, with portal blocks.
  - Parks and forests get instanced trees, scattered deterministically per feature.
  - Lakes become flat water.
- **`terrain.ts`:** elevation from **AWS Terrain Tiles** (Terrarium PNG; public, no key; ~30 m sources such as SRTM, GMTED2010, ETOPO1 and NED; attribution shown in the view) and ground imagery from the selected basemap. Failed tiles fall back to flat ground with a message. The terrain mesh is cached and reused while the scene area, imagery and exaggeration stay the same. Scene bounds snap outward to 0.001° so ordinary edits don't invalidate that cache.
- **`sun.ts`:** approximate solar position (±1°) from the project latitude, solar hour and season, driving a shadow-casting directional light, with dusk and night shading.
- **`CityView.tsx`:** the renderer, controls and UI.
  - Cameras: orbit, top-down (pan only) and walk (pointer lock, WASD/arrows, Shift to run, eye height 1.7 m above the terrain). App shortcuts are disabled while walking.
  - Selection changes recolour objects in place; any other edit triggers a debounced rebuild.
  - The view and Three.js are lazy-loaded, so 2D-only sessions don't download them.

**Infrastructure networks** (`src/networks.ts`). Six networks are supported: water, sewerage, stormwater, electricity, telecom, and public transport. Each gets its own layer, created on first use; changing a line's network moves it to that layer. The catalogue adds network nodes (valves, hydrants, manholes, outfalls, transformers, cabinets, exchanges, pump stations) and bus/transit routes. The analysis is geometric:
- **Connectivity:** union-find with a 1 m tolerance, covering end-to-end joins, T-joins, and lines ending inside facility polygons.
- **Isolated segments:** anything not part of the main network (the largest by length).
- **Open ends.**
- **Missing or disconnected source facilities:** e.g. no water tank or pump station on the main water network.
- **Conflicts:** lines running under building footprints, and water mains within 3 m of a sewer for 10 m or more.
- **Service coverage:** buildings more than 60 m from water, sewer or power lines, checked only when that network exists.
- **Quantities:** length by size and material.

Results show as red outlines, in Properties, and in Analytics. Hydraulic, load-flow and capacity analysis are left to dedicated engines (EPANET, SWMM, OpenDSS…) through the `NetworkEngine` plug-in interface.

**Master-plan wizard** (`src/masterplan.ts`, toolbar **Plan wizard…**). You enter the brief: site (the selected boundary, or a square of N ha at the map centre), target population, persons per dwelling, gross density, land-use mix, road widths, block length, residents per school/clinic/police/fire/community/religious facility, budget, and cost rates. The generator then:
1. Runs an arterial spine along the site's long axis.
2. Cuts the site into equal-area land-use bands in proportion to the mix (residential split around a civic and commercial core).
3. Subdivides each band. Residential plot size comes from density and the housing type: villas (< 15 dw/ha), detached houses (15–40), townhouse rows (40–80) or apartment blocks (> 80).
4. Carves plots out of the arterial corridor.
5. Reserves the largest civic plots (then plots spread through housing) for facilities. Facility footprints are capped at 45% plot coverage, within the institutional controls.
6. With **Fill plots with buildings** (on by default; `src/infill.ts`), puts a building on every other buildable plot: the housing type on residential plots, a shop, mixed-use building or office (by plot area) on commercial plots, and a factory or warehouse on industrial plots. Each building is centred on its plot and fitted to the zone's setback, coverage (≤ 90% of the limit), floors, height, FAR and dwelling density, so generated buildings raise no compliance issues. A plot where nothing legal fits stays empty. Dwellings count one per residential plot plus the flats in multi-unit buildings, the same rule the stats panel uses.

Up to four alternatives (spine direction × band order) are scored against the brief: population capacity, green share, facilities, road share and budget. You compare them in a table, preview them on the map (a temporary overlay, not project data), and accept one as a single undo step. Everything is marked preliminary.

**Print composer** (Export → Print layout…). Choose A4–A1, landscape or portrait, and either "fit current view" or an exact scale (1:500–1:25 000; the map is zoomed to match, captured, and restored). The output is a print-ready HTML sheet with a graticule in degrees, north arrow, scale bar, a legend of the objects actually in view, map notes, and a title block (title, subtitle, drawn by, date, scale, CRS, sheet, disclaimer). The map is temporarily resized to the frame's proportions during capture so it fills the frame. Print it from the browser with margins set to none.

**Snapping.** While drawing or dragging vertices, the pointer snaps to the nearest vertex within 12 px, then the nearest edge or road centreline, then the metric grid if enabled. Snaps return the *stored* coordinate exactly, not a screen round trip, so snapped plots share edges bit-for-bit and can be merged. The grid is anchored per project (`gridOrigin`) so it doesn't shift as you pan. Snap settings are per-browser (localStorage).

**Parametric footprints.** Library objects store `width`, `depth` and `rotation`. Editing those in Properties regenerates the rectangle around its centre. Reshaping vertices by hand marks the object `shape: custom`, after which its geometry is kept as drawn.

### Data model

```ts
Project { version, id, name, crs: 'EPSG:4326', center, zoom, basemap, settings, layers[], features{}, createdAt, updatedAt }
Layer   { id, name, kind, visible, locked, opacity }
Feature { type:'Feature', id, geometry: Polygon|LineString|Point,
          properties: { id, layerId, type, name, attrs: Record<string, number|string> } }
```

IDs are stable UUIDs. `version` is checked on load, and newer files are refused rather than misread.

### Coordinates and measurement

Geometry is stored in **WGS 84 (EPSG:4326)**. Lengths and areas are computed geodesically with Turf. Subdivision and footprints work in a local equirectangular metre frame around the site, with error below 0.1% over a few km. A per-project projected CRS (UTM or national grid via proj4) is planned for very large sites.

### Persistence and safety

- **Save** writes the project to IndexedDB. The **Projects** dialog lists, opens and deletes saved projects.
- Unsaved work is written to a recovery slot about 0.8 s after each change and restored, with a notice, on next launch.
- Closing the tab with unsaved changes triggers the browser's leave-page warning. Opening or creating a project while dirty offers *Save*, *Discard* or *Cancel*.
- A layer can only be removed when it is empty.
- Imported geometry is validated: closed rings, enough vertices, valid lat/lng ranges, and no self-intersection. Rejected features are reported by count and reason, never dropped silently.

## Supported formats

| Format | Import | Export |
|---|---|---|
| UrbanForge project (`.urbanforge.json`) | ✅ | ✅ |
| GeoJSON (Feature / FeatureCollection / geometry; Multi* exploded) | ✅ | ✅ |
| Plot schedule CSV | — | ✅ |
| Map image PNG | — | ✅ |
| KML (Google Earth) / KMZ | ✅ | ✅ KML (styled, per-layer folders, attributes as ExtendedData) |
| Shapefile (zipped .shp/.shx/.dbf/.prj) | ✅ (reprojected via .prj) | ✅ WGS 84; DBF field names cut to 10 chars |
| CSV — lat/lon columns or a WKT column | ✅ | ✅ (all attributes + WKT) |
| DXF (AutoCAD R12 ASCII) | ✅ LINE, (LW)POLYLINE, POINT, CIRCLE | ✅ metres from the project centre, one CAD layer per UrbanForge layer, plot numbers as TEXT |
| OpenStreetMap (Overpass API, current view ≤ 4 km²) | ✅ roads, buildings, rail, parks, water, land use | — |
| Print layout (A4–A1, fit or exact scale) | — | ✅ print-ready HTML (print to PDF) |
| GeoPackage, GeoTIFF / DEM, DWG | needs backend | needs backend |

**Classification of foreign data.** OSM-style tags map to real types: `highway=*` → road classes, `building` → building (floors from `building:levels`), parks, gardens, pitches, forest, water, and `landuse` → zoning areas. CAD/GIS layer names act as hints too: e.g. "PLOTS" → plot, "BLDG" → building, "WATER" → water main. Unrecognised features become neutral zones, roads or points by geometry; source attributes are always kept. Numeric strings from text formats are restored to numbers, and the type's defaults (e.g. road width) fill any gaps.

**DXF georeferencing.** Exported DXF uses metres relative to the project centre (stated in a header comment), and import assumes the same. A drawing in absolute projected coordinates (far from 0,0) is recentred on the project centre with a warning, because true georeferencing needs the GDAL backend.

**OpenStreetMap.** Data © OpenStreetMap contributors (ODbL). The importer tries overpass-api.de and then two public mirrors (45 s timeout each) and reports each failure. Multipolygon relations are not imported. Respect the Overpass usage policy: keep areas small and requests occasional.

GeoPackage (SQLite), GeoTIFF rasters and DWG need GDAL/OGR, so they wait for the Phase 6 backend. The UI marks them "needs backend" instead of faking them.

## Basemaps and licensing

| Basemap | Source | Requirements |
|---|---|---|
| Google Maps / Satellite (optional) | Google Map Tiles API (`tile.googleapis.com`, `src/map/google.ts`) | Your own API key (Analytics → Google Maps API key; stored in this browser only). Free monthly allowance, needs a Google Cloud project with billing and the Map Tiles API enabled; restrict the key to your site. Google's copyright line is shown bottom-right. The 3D view uses the same imagery for the ground. |
| Terrain (3D) | AWS Terrain Tiles (`s3.amazonaws.com/elevation-tiles-prod/terrarium`) | Public, keyless; attribution (shown in the 3D view). |
| OSM (muted), OpenStreetMap | `tile.openstreetmap.org` raster tiles | Attribution (shown). Usage is governed by the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/): fine for development and light use, **not** for heavy production traffic. |
| Blank canvas | none | — |

For production, point the `osm` source in `src/map/MapCanvas.tsx` at your own tile server or a commercial provider (MapTiler, Stadia, Thunderforest, and similar; most need an API key). CARTO's keyless `basemaps.cartocdn.com` endpoints now require an API key, so they were removed.

Map labels use glyphs from `demotiles.maplibre.org`. Self-host glyphs for offline or production use.

Libraries: MapLibre GL JS (BSD-3), Terra Draw (MIT), Turf.js (MIT), React (MIT), Zustand / zundo (MIT), idb-keyval (Apache-2.0), Tailwind CSS (MIT).

## Deployment

The app is a static site:

```bash
npm run build      # → dist/
```

Serve `dist/` from any static host (Netlify, Vercel, Cloudflare Pages, S3 + CloudFront, nginx). No server rewrites are needed because there is a single route. Example nginx block:

```nginx
server {
  listen 80;
  root /var/www/urbanforge/dist;
  location / { try_files $uri /index.html; }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
}
```

Projects live in each user's browser storage. Tell users to use **Export → Project file** for backups and sharing until cloud storage is available.

## Testing

`npm test` runs Vitest on the core logic:

- `src/geo.test.ts`: footprint dimensions and rotation, translation distance, road length and surface area, subdivision (containment, no overlaps, nominal plot size, validation flags, unique numbering, street angle, road clearance), and analytics aggregation.
- `src/plots.test.ts`: plot validation, split across frontage/depth (frontage apportioning, street side, re-validation, exact tiling, hand-drawn axis inference), merge (round-trip, front/rear depth, renumbering, unnumbered plots, non-adjacent refusal), screen-space vertex/edge snapping, grid snapping and grid lines.
- `src/roads.test.ts`: equal-area split of an irregular plot, knife split (straight and bent lines, exact shared cut edge, miss), rotated grid, roundabout and cul-de-sac geometry, junction detection (crossings and T-junctions once each), plots along straight and curved roads (size, shared edges, clearance from the road, tight-curve flags), measured frontage (matches the generator, corner plots, inland plots), and junction road area in analytics.
- `src/zoning.test.ts`: compliant baseline, height/floors/use, setback and outside-plot, zoning-area fallback, unzoned buildings unchecked, FAR/coverage/density maths, zone minimum plot size, custom and uncontrolled rulesets, memoisation, ruleset JSON validation, template coverage, and report/CSV content (including HTML escaping).
- `src/three/three.test.ts`: solar position (equator noon, east/west rise-set, winter vs summer elevation, night), terrarium decoding, tile ranges and UVs, bilinear sampling, oriented boxes, building and roof heights, project vs per-building style, distance-hidden details, one bad building not breaking the scene, deterministic trees and street lights, merged-plot picking, hidden layers, in-place selection on the selected building only (shared materials survive dispose, own glow kept), terrain mesh relief, bridge decks over a valley, bounds snapping.
- `src/three/buildings.test.ts`, `kit.test.ts`, `facades.test.ts`: every building type × both styles builds merged (≤ 10 meshes), within its footprint + 3 m, with a details group; determinism per seed; pitched vs flat defaults and saved-roof override; fallback for tiny/unknown footprints; holes and L-shapes; caps on 50-floor towers, malls and warehouses; shopfront ground storeys; plain roof caps; capped roof rise; style wall palettes vs user colour; texture/material caching. `src/model.test.ts`: style resolution and unset default roofs.
- `src/networks.test.ts`: connected network with a T-junction, open ends, isolated segments, missing source, a polygon source the line ends inside, pipes under vs beside buildings, water–sewer parallels vs crossings, service coverage only for existing networks, transit routes through stops.
- `src/formats.test.ts` (jsdom): KML round-trip with numeric attributes, broken XML, quoted CSV, WKT round-trip, lat/lon CSV, CSV+WKT round-trip, DXF R12 round-trip (areas within 0.05 m², layer-name classification, skipped-entity notes), absolute-coordinate DXF recentring, Shapefile zip round-trip, Overpass conversion and tag classification, and print-layout helpers and HTML.
- `src/masterplan.test.ts`: plot size from density, spine along the long axis, land-use shares (±0.5%), unique plot numbers and clearance from the arterial, facility counts and coverage cap, checks list, population-shortfall and budget flags, distinct alternatives, and square-site area.
- `src/persist.test.ts`: lossless project round-trip, invalid-geometry rejection, schema-version guard, GeoJSON export/re-import, Multi* explosion, IndexedDB save/list/load/delete (via `fake-indexeddb`), and the plot schedule CSV.

The UI flows were checked manually in Chrome: draw boundary, draw road, subdivide, drag components, move/resize/rotate, layers, analytics, 3D, save and reload, measure, undo.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Map editor, basemaps, persistence, layers, drawing, selection, properties | ✅ done |
| 2 | Drag-drop components, road surfaces, subdivision, plot split (equal-area) / merge / knife, snapping and street-aligned grid, plots along curved roads, roundabouts at junctions, cul-de-sacs | ✅ done |
| 3 | Zoning controls per jurisdiction (height, floors, FAR, coverage, min plot, setback, density, permitted uses), live compliance checking, thematic maps and heatmap, land-use targets, HTML planning report and compliance CSV | ✅ done |
| 4 | Three.js city view: real terrain + draped imagery, roof styles and colours, bridges/tunnels, trees and street lights, sun position and shadows, orbit/top-down/walk cameras, click-to-select | ✅ done |
| 5 | Network layers and checks, KML/KMZ, Shapefile, CSV/WKT, DXF and OSM import/export, print composer, master-plan wizard | ✅ done (GeoPackage, GeoTIFF/DEM and DWG moved to Phase 6 with GDAL) |
| 6 | FastAPI + PostGIS backend with GDAL (GeoPackage, GeoTIFF/DEM, DWG via conversion, reprojection), background jobs, cloud storage, collaboration and roles | planned |

Planned backend shape (not yet in this repo): FastAPI with PostgreSQL/PostGIS, GeoPandas/Shapely/PyProj for processing, GDAL/OGR for format conversion, and a job queue for large imports and generation. The project JSON above is the API payload contract.

## Known limits

- Rendering uses one GeoJSON source. It handles ~12k plots on a typical laptop, though the first load takes a few seconds. Split per layer or move to vector tiles beyond that.
- Hit-testing is MapLibre's rendered-feature query; there is no separate R-tree yet.
- The knife extends its line past both ends, CAD-style, so a short line inside a plot still splits it fully.
- Roads drawn after plots don't move them automatically. Use **Cut back overlapping plots** on the road.
- "Plots along road" doesn't avoid plots that already exist on the map. Cut back or delete them first.
- Merge infers side-by-side vs front/back from frontage (a rear plot with no frontage adds depth).
- Changing plot rules re-validates plots in an undoable step, but the rule values themselves are not undone.
- Setback is one uniform distance to all plot boundaries. Separate front, side, and rear setbacks need a known street edge per plot (planned).
- Zoning patterns (hatching) aren't drawn; zones are distinguished by colour only.
- Ruleset edits aren't part of undo/redo (feature edits are).
- 3D roofs and façade parts on L- or T-shaped footprints are simplified to fit an oriented rectangle (walls follow the real shape).
- Building models are procedural approximations of each style, not surveyed or regional-code-accurate designs. The library thumbnails always show the Western style.
- The 3D sun slider uses solar time (12:00 = sun due south/north), not local clock time.
- 3D rebuilds take about 13 ms for small scenes and about 190 ms per 1,000 plots; projects with 10,000+ plots will lag a second or two after each edit.
- Terrain tiles and OSM imagery are fetched from public servers. For heavy production use, host your own tiles (see Basemaps and licensing).
- The wizard plans inside the site polygon only. It doesn't avoid existing roads, buildings or terrain on the map (or the basemap's real roads), so draw or import the constraints and pick a clear site.
- The wizard's band layout is a deliberately simple rule set (spine + bands + grid blocks) for early massing, not an optimiser.
- Network checks are geometric; they don't test pressures, flows, voltage drop or capacity.
- OpenStreetMap import depends on public Overpass servers, which are sometimes overloaded. The importer tries three servers and then reports the failure.
- Small objects at low zoom are easy to grab by a corner handle (resize) instead of the body (move). Zoom in for precise moves.
