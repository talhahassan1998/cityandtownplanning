# Realistic procedural 3D buildings — design

Sub-project 1 of 4 from the request "make the UI more intelligent and modern, use proper 3D models of
components (house, apartment, shop…) like the real world, and make generated towns editable".
Order agreed: **(1) realistic buildings** → (2) generator fills plots with buildings → (3) editing in 3D →
(4) modern / smarter UI. Each later part gets its own spec.

## Goal

Every one of the 25 building types renders as a recognisable, real-world-looking building, in two
architectural styles selectable per project, while a town of ~300 buildings stays smooth in the 3D view.

## Decisions (agreed with the user)

- **Procedural**, no asset files: models are generated in code and fit any footprint and floor count.
- **Styles:** `western` and `gulf` ship first; the system takes more styles later without restructuring.
- **Scope:** all 25 building types fully modelled in both styles.
- **Approach A:** each building is merged into one mesh per material (~5–8 draw calls); windows, frames,
  sills, shutters and brick/render/stone are drawn into generated façade textures; only protruding parts
  (balconies, awnings, roofs, porches, parapets…) are geometry; distant buildings drop small details.

## Data

- `Settings.buildingStyle?: 'western' | 'gulf'` (project, set in the Analytics panel's project settings, next to persons per dwelling). Missing = `western`,
  so existing projects load unchanged.
- `defaultAttrs` stops writing `roof` (unset = the style's default roof); saved `roof` values are still honoured.
- `attrs.style?: 'western' | 'gulf'` per building (Properties panel dropdown, "Project default" = unset).
- Effective style = `attrs.style ?? settings.buildingStyle ?? 'western'`, resolved at render time; never
  written to features unless the user overrides.
- `buildScene` gets the project settings (or just the style) through `SceneOptions`.

## Modules

| File | Responsibility |
|---|---|
| `three/facades.ts` | Generated façade textures (pixel arrays → `DataTexture`, as today; works in Node tests) + bump maps per style × wall kind: `residential`, `apartment`, `shopfront` (ground floor), `glass`, `blank`. UVs in metres (one bay × one storey per tile), cached module-wide. |
| `three/kit.ts` | Footprint-parametric parts, each style-aware: parapet, gable/hip roof with overhang, balcony row, awning, porch + steps, boundary wall + gate, rooftop tank / AC unit, arcade, column portico, canopy, dome, minaret/tower, chimney, signs. Return `THREE.BufferGeometry` tagged with a material key. |
| `three/buildings/residential.ts` | house, villa, townhouse, apartment, tower |
| `three/buildings/commercial.ts` | shop, market, mall, office, hotel, mixed-use, tech-park |
| `three/buildings/civic.ts` | school, university, hospital, clinic, police, fire, government, community, library, religious, station |
| `three/buildings/industrial.ts` | factory, warehouse, and infrastructure building types (substation, treatment, pump-station, telecom-exchange, waste when they have height) |
| `three/buildings/index.ts` | `buildingModel(input): THREE.Object3D` — dispatch to the recipe, merge per material (`BufferGeometryUtils.mergeGeometries`), fallback. |
| `three/models.ts` | Keeps `groundExtras` (pitches, parking, solar…) and `pointModel` (street furniture). Its `buildingExtras` / `facadeMaterials` are replaced by the recipes. |

`buildingModel` input: `{ type, style, ring (local metres), holes, base, height, floors, color, seed, roof? }`.

- Walls are extruded from the **real** footprint (L/T shapes kept); roofs and front-facing parts use the
  oriented rectangle (`orientedBox`), as today.
- `seed = hash(feature.id)` drives small variations (colour shift within the style palette, door/garage
  placement, balcony pattern, rooftop clutter); same id → identical model.
- The feature colour (`colorOf`) sets the base tone so colour-by-zoning still reads.
- Selection highlight keeps working: every mesh carries the feature id as today.

## Per-type look

| Type | Western | Gulf |
|---|---|---|
| house | gable roof + overhang, chimney, porch + steps, front garden + low fence | flat roof + parapet, compound wall + gate, roof-access stair room, AC units |
| villa | hipped roof, 2-storey entrance bay, garage door, hedge | two volumes, arched loggia, screened windows, high wall, palms |
| townhouse | repeated bays: door, steps, chimney each, varied render colours | repeated bays: gate, arched door, stepped parapet |
| apartment | balcony rows, stair core, entrance canopy, plinth | recessed screened balconies, rooftop tanks + AC, stair tower |
| tower | curtain wall, podium, roof crown | stone base, screened shaft, slim crown |
| shop | glass shopfront, striped awning, sign band, door | roll-up shutter, sign band, shade canopy, parapet |
| market | open column hall, gabled glazed roof | arched arcade round a courtyard, stall canopies |
| mixed-use | ground-floor shops, balconied flats above | ground-floor arcade, screened flats above |
| office / tech-park | glass grid, lobby canopy, rooftop plant | stone fins, shaded glazing, portico |
| hotel | entrance canopy, balconies, roof sign | porte-cochère, arched windows, palms |
| mall | big glazed entrance, ribbed walls, parking canopies | domed entrance, arcade, shading |
| school / university | brick wings, flagpole, play-area fence | courtyard walls, arcade, flagpole |
| hospital / clinic | emergency canopy, red-cross sign, helipad (hospital) | same in stone + shading |
| police / fire | signed entrance + blue light; red appliance doors + drill tower | same in stone |
| government / library | column portico, steps, pediment | arched portico, dome or tower |
| community | pitched hall roof, glazed entrance | courtyard hall, arches |
| religious | church: nave, pitched roof, bell tower | mosque: dome, minaret, courtyard wall |
| station | platform canopy, clock, entrance hall | same with arched hall |
| factory / warehouse | sawtooth or metal-clad roof, loading docks, stacks | metal cladding in sand tones, docks, stacks |
| infrastructure buildings | fenced, functional; existing details kept | same |

## Performance

- Shared textures/materials per style × wall kind; per-building geometry merged per material.
- Detail level: each building group has a `details` child (balconies, signs, tanks…). The 3D view hides it
  per frame when the building is >400 m from the camera (no rebuild); the map 3D layer hides all details
  below zoom 17 (models still appear from zoom 16).
- Target, measured in the browser: 300-building town smooth in the 3D view on this machine.

## Consumers

3D view, map 3D layer (`map/models3d.ts`) and library thumbnails (`three/thumbs.ts`) all go through
`buildScene`, so they pick the models up automatically. (Thumbnails are rendered at runtime, no cache to bump.)
`scene.ts`'s current roof handling (`attrs.roof`, `roofGeometry`) is folded into the recipes: an explicit
`attrs.roof` still overrides the style's default roof.

## Errors / fallbacks

Unknown type, footprint shorter than ~4 m on a side, or a recipe throwing → plain extruded body + flat
roof (today's look). One bad feature never breaks the scene.

## Testing

- `three/buildings.test.ts`: for all 25 types × 2 styles on a standard footprint — builds without
  throwing; bounding box within the footprint expanded by ≤3 m (porches, canopies, garden walls);
  ≤10 meshes after merging; deterministic for the same seed; a `details` child exists and holds the small parts.
- Style resolution: per-building override beats project, project beats default, old projects → western.
- Fallback: tiny / degenerate footprint returns a body without throwing.
- Gates: `npm test`, `npx tsc`, `npm run build`, then browser check with screenshots of every type in both
  styles and a generated town (also clears the "models not yet seen in a browser" item in CLAUDE.md).

## Out of scope (later sub-projects)

Filling generated plots with buildings; editing (move/rotate/change type) in 3D and partial regeneration;
UI redesign / assistance.
