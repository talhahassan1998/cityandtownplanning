# UrbanForge — client demo script (≈ 35 min)

Each step lists **Do** (what to click), **Expect** (what should happen) and **Say** (a suggested line for the client). Run the full script once on your own the day before. Tick each box as it works.

---

## 0. Prepare (day before + 15 min before)

- [ ] `npm install`, then `npm run build && npm run preview`, and open the printed URL in **Chrome**. The preview build is the stable, production-like version. Use `npm run dev` only while developing.
- [ ] Check the **internet connection**: map tiles, 3D terrain and the OpenStreetMap import all download live.
- [ ] Use a **clean browser profile** (or delete old test projects in **Projects…**) so the project list looks tidy.
- [ ] After your rehearsal, use **Export ▾ → Project file** to save a backup `.urbanforge.json`. If anything goes wrong during the demo, **Import ▾ → From file** restores it in seconds.
- [ ] Use a large screen at 100% browser zoom, and close other tabs.
- [ ] Pick a demo location the client knows, ideally fairly empty land, and note its latitude/longitude.

**Interface map:** top toolbar · left = **Components / Layers** · centre = map · right = **Properties / Analytics** · bottom = status bar (current tool + hints).

---

## 1. Projects & map basics (2 min)

1. **Do:** **Projects…** → New project → type a name and the lat/lng → **Create project**.
   **Expect:** the map jumps there, and the status bar says *saved*.
2. **Do:** scroll to zoom and drag to pan. Change the basemap dropdown: OSM (muted) → OpenStreetMap → Blank canvas. Click **◐** for light/dark.
   **Expect:** the bottom-left box shows live coordinates, and a scale bar is at the bottom right.
   **Say:** "Everything is in real geographic coordinates (WGS 84). Areas and lengths are measured on the true Earth surface, not on a picture."

## 2. Draw a site and a road (3 min)

1. **Do:** press **B** (Boundary). Click 4–6 points around a large area, then click the first point to close it.
   **Expect:** an orange dashed boundary. **Properties** shows its area (ha) and perimeter.
2. **Do:** press **R** (Road). Click a line across the site, then double-click (or click the last point again) to finish.
   **Expect:** a grey road surface the width of the road. Properties shows length, right-of-way area and estimated cost.
3. **Do:** in Properties change **Road type** to *Arterial road*.
   **Expect:** the surface widens to 24 m immediately.
4. **Do:** press **M**, measure a distance, and finish on the last point.
   **Expect:** a dashed line with a length label.

## 3. Automatic subdivision (3 min)

1. **Do:** press **V**, click inside the boundary, then **Subdivide…**. Set *Street orientation* to match the site, then **Generate plots**.
   **Expect:** numbered plots (B1-1…), local streets and cross streets, with plots cut back from the existing road. A message reports how many plots fail validation (red).
   **Say:** "Plot size, frontage and street width are all parameters. Plots that break the rules are kept and highlighted, never silently dropped."
2. **Do:** click a red plot.
   **Expect:** Properties explains the problem, e.g. *Area below 350 m²* or *No street access*.
3. **Do:** in Properties (nothing selected) change **Plot rules → Min. area**.
   **Expect:** the red plots update live.

## 4. Editing plots — split, merge, knife, snap (3 min)

1. **Do:** select a plot → **Split plot** → *Into 2* → *Across: Depth* → **Split**.
   **Expect:** the front piece keeps its street frontage; the rear piece is flagged *No street access*.
2. **Do:** with both pieces still selected → **Merge 2 plots**.
   **Expect:** the original plot is restored. Press **Ctrl+Z / Ctrl+Y** to show undo/redo.
3. **Do:** press **K** (knife ✂). Draw a line across 2–3 plots.
   **Expect:** they split along the line, and frontage is re-measured from the roads.
4. **Do:** open **Snap ▾**, tick *Grid*, set the size to 10 m, then **Match selection** with a road selected.
   **Expect:** a grid aligned to the street. Draw a plot with **P** next to an existing one: the corners snap exactly.
   **Say:** "Snapped shapes share edges exactly, so they can be merged and measured precisely."

## 5. Drag-and-drop components (2 min)

1. **Do:** from **Components**, drag a *Detached house*, a *Park*, a *School* and a *Residential tower* onto plots.
   **Expect:** correctly sized footprints. Use the search box to find items quickly.
2. **Do:** select the house. Drag it to move it, and drag a corner to resize it. Use **⟲ 15° / + 10%**, or type *Width / Floors / Rotation* in Properties.
   **Expect:** shape and height update; floor area and cost estimates update.
3. **Do:** right-click it → **Duplicate**; **Delete**; **Ctrl+Z**.

## 6. Road design tools (3 min)

1. **Do:** press **R** and draw a **curved** road (6+ clicks). Select it → **Road tools → Generate plots along road**.
   **Expect:** plots follow the curve, numbered odd on the left and even on the right. A plot on a too-tight bend is flagged.
2. **Do:** draw a straight road crossing it. Select the new road → **Roundabout → At junctions**.
   **Expect:** a roundabout with a central island at the crossing.
3. **Do:** with the same road selected → **Cut back overlapping plots**, then **Turning head → At end**.
   **Expect:** plots are cut back from the new road, and a cul-de-sac appears at its end.

## 7. Layers (1 min)

1. **Do:** open the **Layers** tab. Untick *Parcels & plots*, lock *Buildings*, drag the opacity slider, and open the **⊞** attribute table.
   **Expect:** the map hides or dims accordingly. Locked buildings can't be selected. Clicking a table row zooms to that object.

## 8. Zoning rules & compliance (3 min)

1. **Do:** put a *Residential tower* or *Office building* on a residential plot, then click it.
   **Expect:** Properties → **Development controls** shows ✗ for height, floors and use against the limits, and the building has a red outline.
2. **Do:** **Zoning rules…** → raise *Residential max height* and enable the *Com* use → **Done**.
   **Expect:** the violations disappear live.
   **Say:** "The rules aren't hard-coded to one country. Each jurisdiction keeps its own rule set, which can be imported and exported as a file."

## 9. Analytics (2 min)

1. **Do:** open the **Analytics** tab.
   **Expect:** measured cards (area, plots, roads, green space, floor area), plot-size bars, and estimates in dashed cards, kept clearly separate.
2. **Do:** change *Persons per dwelling*; add a **land-use target** (e.g. Green 15%).
   **Expect:** estimates update, and the target marker and difference appear.
3. **Do:** **Map theme → FAR vs limit**, then **Compliance**; tick **Heatmap**.
   **Expect:** plots coloured by how close they are to their limit; a floor-area heatmap.
4. **Do:** click a line in the compliance list.
   **Expect:** the map zooms to that object and selects it.

## 10. Infrastructure networks (3 min)

1. **Do:** drag a **Water tank** onto the map. Drag a **Water supply pipe**, select it, and reshape it so one end touches the tank. Add a second pipe that doesn't touch anything.
   **Expect:** a *Water supply* layer appears automatically. The isolated pipe is outlined red.
2. **Do:** Analytics → **Infrastructure networks → Water supply** (expand it).
   **Expect:** length by pipe size, the number of separate pieces, and findings such as open ends, *not connected*, and *School has no water supply line within 60 m*.
   **Say:** "These are planning-level checks. Hydraulic modelling plugs in later as a specialist engine."

## 11. 3D city (3 min)

1. **Do:** click **2D** in the toolbar (it switches to **3D**).
   **Expect:** extruded buildings on real terrain with the map draped on the ground, plus trees, street lights and sun shadows.
2. **Do:** drag the **Sun** slider and change the **Season**.
   **Expect:** shadows move.
3. **Do:** click a house. In Properties set **Roof → Gable** and pick a **Colour**.
   **Expect:** the 3D view updates instantly; the selected building is highlighted.
4. **Do:** set a road's **Structure → Bridge** (best on a hilly site).
   **Expect:** a level deck on piers.
5. **Do:** **Top-down**, then **Walk**. Click the view and use WASD to walk. **Esc** releases the mouse, then **Back to 2D map**.
   **Say:** "2D and 3D are the same data. Change one and the other updates."

## 12. Master-plan wizard (4 min) — the highlight

1. **Do:** select your boundary (or select nothing to use a square site) → **Plan wizard…**.
2. **Do:** step through the brief: population (e.g. 5 000), density, land-use mix (try *Size residential land to the population target*), roads, facilities, budget → **Next** to *Alternatives* → **Generate 3 alternative(s)**.
   **Expect:** a comparison table with ✓/✗ against targets: population, green space, facilities, road share and budget.
3. **Do:** **Preview** each alternative (shown dashed on the map) → **Accept** one.
   **Expect:** zones, a main road, streets, plots and facility buildings are added. A single **Ctrl+Z** removes the whole plan.
   **Say:** "This is a starting proposal to discuss, not an approved design. Everything it creates stays fully editable."

## 13. Import, export, print, report (3 min)

1. **Do:** **Import ▾ → OpenStreetMap data for the current view** (zoom in to ≤ 4 km² first).
   **Expect:** real roads, buildings and parks appear as editable objects. *If the public OSM servers are busy the app says so. Skip this and move on (see Troubleshooting).*
2. **Do:** **Import ▾ → From file** and drop in a KML, a zipped Shapefile, a CSV (lat/lon) or a DXF that you prepared beforehand.
3. **Do:** **Export ▾** and show the list: Project file, GeoJSON, KML, Shapefile, CSV, DXF, plot schedule CSV, PNG.
4. **Do:** **Export ▾ → Print layout…** → A3 landscape, *1:2 500* → **Create layout**. Open the downloaded file.
   **Expect:** a printable sheet with grid labels, north arrow, scale bar, legend and title block.
5. **Do:** **Export ▾ → Planning report (HTML)** and open it.
   **Expect:** map snapshot, measured tables, estimates with their assumptions, zoning rules, and the compliance list.

## 14. Save, reload, recovery (2 min)

1. **Do:** **Ctrl+S** → reload the page.
   **Expect:** the project reopens exactly as saved.
2. **Do:** make a change *without saving* and reload.
   **Expect:** the browser warns first. After reloading, a banner says *Recovered unsaved changes*.
   **Say:** "Work is never silently lost."

---

## Troubleshooting during the demo

| Problem | Fix |
|---|---|
| Something looks wrong | **Ctrl+Z**, or restore your backup project file via **Import ▾ → From file** |
| OSM import fails ("no Overpass server answered") | The public servers are busy. Say so and move on; a prepared KML or Shapefile import shows the same thing |
| 3D view is blank or terrain is flat | Check the internet; untick *Terrain* to show flat ground |
| Map tiles are grey | Internet or tile server is slow; switch basemap to *Blank canvas* |
| Page feels slow | You have thousands of plots; use a smaller site for the demo |

## What to say about what isn't built yet

- **GeoPackage, GeoTIFF/terrain files:** work when the backend is running (`docker compose up -d`); otherwise marked "needs backend". **DWG:** not supported (needs the ODA converter).
- **Team collaboration, user roles, cloud storage:** later in Phase 6. Today projects save in this browser and, with the backend running, to the local PostGIS server; project files can be shared by export.
- **Proposals and reports:** always preliminary planning aids. Never present them as legally approved or construction-ready.
