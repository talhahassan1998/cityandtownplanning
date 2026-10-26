import type { Feature, LineString, Point, Polygon } from 'geojson'

export const SCHEMA_VERSION = 1

export type LayerKind =
  | 'boundary' | 'zoning' | 'parcels' | 'roads' | 'buildings'
  | 'green' | 'facilities' | 'utilities' | 'annotations'

export interface Layer {
  id: string
  name: string
  kind: LayerKind
  visible: boolean
  locked: boolean
  opacity: number
}

export type Attrs = Record<string, number | string>

export interface PlanProps {
  id: string
  layerId: string
  type: string // ComponentDef.type
  name: string
  attrs: Attrs
}

export type PlanGeometry = Polygon | LineString | Point
export type PlanFeature = Feature<PlanGeometry, PlanProps> & { id: string }

export interface Settings {
  personsPerDwelling: number
  dwellingsPerPlot: number
  roadCostPerM2: number
  buildingCostPerM2: number
  /** Plot validation rules, set by the subdivision dialog; optional so older projects load unchanged. */
  minPlotArea?: number
  minFrontage?: number
  /** Land-use allocation targets, % of the development area per zoning category. */
  landUseTargets?: Record<string, number>
  /** Architectural style of the 3D building models; buildings may override it with `attrs.style`. */
  buildingStyle?: BuildingStyle
  /** Side of the road traffic keeps to (3D vehicles); absent = left. */
  drivingSide?: 'left' | 'right'
}

export type BuildingStyle = 'western' | 'gulf'
export const BUILDING_STYLES: Record<BuildingStyle, string> = { western: 'Western', gulf: 'Gulf' }
/** Effective style of a building: its own override, else the project's, else western. */
export function styleOf(attrs: Attrs, settings?: Partial<Settings>): BuildingStyle {
  const own = String(attrs.style ?? '')
  return own in BUILDING_STYLES ? (own as BuildingStyle) : settings?.buildingStyle && settings.buildingStyle in BUILDING_STYLES ? settings.buildingStyle : 'western'
}

export interface Project {
  version: number
  id: string
  name: string
  crs: 'EPSG:4326'
  center: [number, number]
  zoom: number
  basemap: BasemapId
  settings: Settings
  layers: Layer[]
  features: Record<string, PlanFeature>
  /** Anchor of the snapping grid, fixed once so the grid doesn't shift as the view moves. */
  gridOrigin?: [number, number]
  /** Development controls for this project's jurisdiction; GENERIC_RULESET when absent. */
  ruleset?: Ruleset
  createdAt: string
  updatedAt: string
}

export type BasemapId = 'osm' | 'grey' | 'none' | 'google-roadmap' | 'google-satellite'
export const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'grey', label: 'OSM (muted)' },
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'google-roadmap', label: 'Google Maps' },
  { id: 'google-satellite', label: 'Google Satellite' },
  { id: 'none', label: 'Blank canvas' },
]

export const ZONING: Record<string, { label: string; color: string }> = {
  residential: { label: 'Residential', color: '#f2c94c' },
  commercial: { label: 'Commercial', color: '#eb5757' },
  industrial: { label: 'Industrial', color: '#9b51e0' },
  institutional: { label: 'Institutional', color: '#2f80ed' },
  green: { label: 'Recreational / green', color: '#27ae60' },
  agricultural: { label: 'Agricultural', color: '#a3c35b' },
  mixed: { label: 'Mixed-use', color: '#f2994a' },
  transport: { label: 'Transport & utilities', color: '#828282' },
  protected: { label: 'Protected / restricted', color: '#145a32' },
}

// --- development controls ------------------------------------------------------------
/** Building-use classes used by "permitted uses" (the component library categories). */
export const USE_CLASSES = ['Residential', 'Commercial', 'Public & institutional', 'Green & recreation', 'Industrial & economic', 'Utilities', 'Roads & transport'] as const

/** Controls for one zoning category. Every limit is optional: absent = not controlled. */
export interface ZoneRule {
  maxHeight?: number     // m
  maxFloors?: number
  maxFAR?: number        // gross floor area ÷ plot area
  maxCoverage?: number   // % of plot area under building footprints
  minPlotArea?: number   // m²
  setback?: number       // m, minimum distance from building to every plot boundary
  maxDensity?: number    // dwellings per hectare of plot
  uses: string[]         // permitted USE_CLASSES
}

export interface Ruleset { name: string; rules: Record<string, ZoneRule> }

const R = USE_CLASSES
/**
 * Starting template only. The values are illustrative, not any jurisdiction's regulations;
 * replace them with your local planning code (Zoning rules dialog or JSON import).
 */
export const GENERIC_RULESET: Ruleset = {
  name: 'Generic template (illustrative values; edit for your jurisdiction)',
  rules: {
    residential: { maxHeight: 15, maxFloors: 4, maxFAR: 1.5, maxCoverage: 60, minPlotArea: 120, setback: 3, maxDensity: 120, uses: [R[0], R[2], R[3], R[5], R[6]] },
    commercial: { maxHeight: 45, maxFloors: 12, maxFAR: 4, maxCoverage: 80, minPlotArea: 150, setback: 0, uses: [R[1], R[2], R[3], R[5], R[6]] },
    industrial: { maxHeight: 25, maxFloors: 5, maxFAR: 2, maxCoverage: 70, minPlotArea: 500, setback: 6, uses: [R[4], R[1], R[5], R[6]] },
    institutional: { maxHeight: 30, maxFloors: 6, maxFAR: 2.5, maxCoverage: 50, minPlotArea: 400, setback: 6, uses: [R[2], R[3], R[5], R[6]] },
    green: { maxHeight: 10, maxFloors: 2, maxFAR: 0.1, maxCoverage: 10, setback: 5, uses: [R[3], R[5], R[6]] },
    agricultural: { maxHeight: 10, maxFloors: 2, maxFAR: 0.2, maxCoverage: 15, minPlotArea: 1000, setback: 10, uses: [R[4], R[3], R[5], R[6]] },
    mixed: { maxHeight: 30, maxFloors: 8, maxFAR: 3, maxCoverage: 70, minPlotArea: 150, setback: 3, maxDensity: 300, uses: [R[0], R[1], R[2], R[3], R[5], R[6]] },
    transport: { maxHeight: 15, maxFloors: 3, maxCoverage: 20, uses: [R[5], R[6]] },
    protected: { maxCoverage: 0, maxFAR: 0, uses: [R[3]] },
  },
}

// --- infrastructure networks ------------------------------------------------------------
export interface NetworkDef {
  label: string
  color: string
  /** Facility types that feed (or terminate) the network; a network with lines but none of these is flagged. */
  sources: string[]
  sourceLabel: string
  diameter?: number // default pipe / cable size, mm
  material?: string
  /** Buildings farther than this from the network's lines are flagged as unserved (m). */
  serviceDistance?: number
}

export const NETWORKS: Record<string, NetworkDef> = {
  water: { label: 'Water supply', color: '#1e88e5', sources: ['water-tank', 'pump-station'], sourceLabel: 'water tank or pump station', diameter: 150, material: 'HDPE', serviceDistance: 60 },
  sewer: { label: 'Sewerage', color: '#8d6e63', sources: ['treatment'], sourceLabel: 'treatment plant', diameter: 225, material: 'PVC', serviceDistance: 60 },
  stormwater: { label: 'Stormwater drainage', color: '#26a69a', sources: ['outfall'], sourceLabel: 'outfall', diameter: 450, material: 'Concrete' },
  electricity: { label: 'Electricity', color: '#fbc02d', sources: ['substation', 'solar'], sourceLabel: 'substation or solar farm', diameter: 95, material: 'XLPE cable', serviceDistance: 60 },
  telecom: { label: 'Telecommunications', color: '#7e57c2', sources: ['telecom-exchange'], sourceLabel: 'telecom exchange', diameter: 50, material: 'Fibre duct' },
  transit: { label: 'Public transport', color: '#8e24aa', sources: ['station'], sourceLabel: 'transit station' },
}

export const ROAD_CLASSES: Record<string, { label: string; width: number; lanes: number; sidewalk: number }> = {
  highway: { label: 'Highway', width: 30, lanes: 6, sidewalk: 0 },
  arterial: { label: 'Arterial road', width: 24, lanes: 4, sidewalk: 3 },
  collector: { label: 'Collector road', width: 15, lanes: 2, sidewalk: 2.5 },
  local: { label: 'Local street', width: 9, lanes: 2, sidewalk: 1.5 },
  cycle: { label: 'Cycle lane', width: 3, lanes: 1, sidewalk: 0 },
  rail: { label: 'Railway / metro', width: 8, lanes: 2, sidewalk: 0 },
}

export type GeomKind = 'polygon' | 'line' | 'point'

export interface ComponentDef {
  type: string
  label: string
  category: string
  geom: GeomKind
  layer: LayerKind
  color: string
  w?: number // footprint width (m)
  d?: number // footprint depth (m)
  floors?: number
  zoning?: string
  roadClass?: string
  network?: string
}

const C = (category: string, layer: LayerKind, color: string, items: (Omit<ComponentDef, 'category' | 'layer' | 'color'> & Partial<Pick<ComponentDef, 'layer' | 'color'>>)[], extra: Partial<ComponentDef> = {}) =>
  items.map((i) => ({ category, layer, color, ...extra, ...i }) as ComponentDef)

export const COMPONENTS: ComponentDef[] = [
  ...C('Roads & transport', 'roads', '#5b6470', [
    { type: 'road-highway', label: 'Highway', geom: 'line', roadClass: 'highway' },
    { type: 'road-arterial', label: 'Arterial road', geom: 'line', roadClass: 'arterial' },
    { type: 'road-collector', label: 'Collector road', geom: 'line', roadClass: 'collector' },
    { type: 'road-local', label: 'Local street', geom: 'line', roadClass: 'local' },
    { type: 'road-cycle', label: 'Cycle lane', geom: 'line', roadClass: 'cycle' },
    { type: 'rail', label: 'Railway / metro line', geom: 'line', roadClass: 'rail' },
    { type: 'roundabout', label: 'Roundabout', geom: 'polygon' },
    { type: 'parking', label: 'Parking area', geom: 'polygon', w: 40, d: 25 },
    { type: 'bus-stop', label: 'Bus stop', geom: 'point', network: 'transit' },
    { type: 'station', label: 'Transit station', geom: 'polygon', w: 60, d: 20, floors: 2, network: 'transit' },
    { type: 'bus-route', label: 'Bus / transit route', geom: 'line', network: 'transit', layer: 'utilities', color: '#8e24aa' },
  ]),
  ...C('Residential', 'buildings', '#e0b84c', [
    { type: 'house', label: 'Detached house', geom: 'polygon', w: 10, d: 12, floors: 2 },
    { type: 'villa', label: 'Villa', geom: 'polygon', w: 18, d: 20, floors: 2 },
    { type: 'townhouse', label: 'Townhouse row', geom: 'polygon', w: 36, d: 10, floors: 3 },
    { type: 'apartment', label: 'Apartment block', geom: 'polygon', w: 40, d: 16, floors: 6 },
    { type: 'tower', label: 'Residential tower', geom: 'polygon', w: 25, d: 25, floors: 20 },
    { type: 'res-plot', label: 'Residential plot', geom: 'polygon', w: 15, d: 30, zoning: 'residential' },
  ], { zoning: 'residential' }),
  ...C('Commercial', 'buildings', '#e06c5a', [
    { type: 'shop', label: 'Shop', geom: 'polygon', w: 12, d: 15, floors: 1 },
    { type: 'market', label: 'Market', geom: 'polygon', w: 50, d: 40, floors: 1 },
    { type: 'mall', label: 'Shopping mall', geom: 'polygon', w: 120, d: 80, floors: 3 },
    { type: 'office', label: 'Office building', geom: 'polygon', w: 35, d: 25, floors: 10 },
    { type: 'hotel', label: 'Hotel', geom: 'polygon', w: 40, d: 20, floors: 8 },
    { type: 'mixed-use', label: 'Mixed-use building', geom: 'polygon', w: 30, d: 20, floors: 6, zoning: 'mixed' },
  ], { zoning: 'commercial' }),
  ...C('Public & institutional', 'facilities', '#4a8fe0', [
    { type: 'school', label: 'School', geom: 'polygon', w: 60, d: 40, floors: 2 },
    { type: 'university', label: 'College / university', geom: 'polygon', w: 120, d: 80, floors: 4 },
    { type: 'hospital', label: 'Hospital', geom: 'polygon', w: 80, d: 50, floors: 5 },
    { type: 'clinic', label: 'Clinic', geom: 'polygon', w: 20, d: 15, floors: 2 },
    { type: 'police', label: 'Police station', geom: 'polygon', w: 25, d: 20, floors: 2 },
    { type: 'fire', label: 'Fire station', geom: 'polygon', w: 30, d: 25, floors: 2 },
    { type: 'government', label: 'Government office', geom: 'polygon', w: 40, d: 30, floors: 4 },
    { type: 'community', label: 'Community centre', geom: 'polygon', w: 30, d: 25, floors: 1 },
    { type: 'library', label: 'Library', geom: 'polygon', w: 25, d: 20, floors: 2 },
    { type: 'religious', label: 'Religious building', geom: 'polygon', w: 30, d: 30, floors: 1 },
  ], { zoning: 'institutional' }),
  ...C('Green & recreation', 'green', '#3fae5a', [
    { type: 'park', label: 'Park', geom: 'polygon', w: 80, d: 60 },
    { type: 'garden', label: 'Garden', geom: 'polygon', w: 30, d: 30 },
    { type: 'playground', label: 'Playground', geom: 'polygon', w: 25, d: 20 },
    { type: 'football', label: 'Football ground', geom: 'polygon', w: 105, d: 68 },
    { type: 'cricket', label: 'Cricket ground', geom: 'polygon', w: 150, d: 150 },
    { type: 'forest', label: 'Urban forest', geom: 'polygon', w: 150, d: 100 },
    { type: 'lake', label: 'Lake / pond', geom: 'polygon', w: 60, d: 40 },
    { type: 'walking-track', label: 'Walking / cycling path', geom: 'line', roadClass: 'cycle' },
  ], { zoning: 'green' }),
  ...C('Industrial & economic', 'buildings', '#9a6fd0', [
    { type: 'factory', label: 'Factory', geom: 'polygon', w: 80, d: 50, floors: 1 },
    { type: 'warehouse', label: 'Warehouse', geom: 'polygon', w: 100, d: 40, floors: 1 },
    { type: 'tech-park', label: 'Technology park building', geom: 'polygon', w: 60, d: 40, floors: 5 },
    { type: 'farmland', label: 'Agricultural area', geom: 'polygon', w: 200, d: 150, zoning: 'agricultural' },
  ], { zoning: 'industrial' }),
  ...C('Utilities', 'utilities', '#2cc5c5', [
    { type: 'water-main', label: 'Water supply pipe', geom: 'line', network: 'water' },
    { type: 'sewer', label: 'Sewer line', geom: 'line', network: 'sewer' },
    { type: 'drain', label: 'Stormwater drain', geom: 'line', network: 'stormwater' },
    { type: 'power-line', label: 'Power line', geom: 'line', network: 'electricity' },
    { type: 'telecom', label: 'Telecom / fibre', geom: 'line', network: 'telecom' },
    { type: 'substation', label: 'Electric substation', geom: 'polygon', w: 30, d: 30, network: 'electricity' },
    { type: 'water-tank', label: 'Water tank', geom: 'point', network: 'water' },
    { type: 'treatment', label: 'Treatment plant', geom: 'polygon', w: 80, d: 60, network: 'sewer' },
    { type: 'solar', label: 'Solar farm', geom: 'polygon', w: 150, d: 100, network: 'electricity' },
    { type: 'waste', label: 'Waste facility', geom: 'polygon', w: 60, d: 40, network: 'waste' },
    { type: 'pump-station', label: 'Water pump station', geom: 'polygon', w: 15, d: 15, network: 'water' },
    { type: 'valve', label: 'Water valve', geom: 'point', network: 'water' },
    { type: 'hydrant', label: 'Fire hydrant', geom: 'point', network: 'water' },
    { type: 'manhole', label: 'Sewer manhole', geom: 'point', network: 'sewer' },
    { type: 'outfall', label: 'Stormwater outfall', geom: 'point', network: 'stormwater' },
    { type: 'transformer', label: 'Transformer', geom: 'point', network: 'electricity' },
    { type: 'telecom-cabinet', label: 'Telecom cabinet', geom: 'point', network: 'telecom' },
    { type: 'telecom-exchange', label: 'Telecom exchange', geom: 'polygon', w: 20, d: 15, network: 'telecom' },
  ], { zoning: 'transport' }),
]

const MOVABLE_AREAS = new Set(['parking', 'station', 'substation', 'treatment', 'solar', 'waste', 'pump-station', 'telecom-exchange'])
/** Objects that can be dragged in 3D; roads, plots, zones, boundaries and lines stay 2D-edited (vertex editing there is precise). */
export function isMovable(f: PlanFeature): boolean {
  if (f.geometry.type === 'Point') return true
  if (f.geometry.type !== 'Polygon') return false
  const t = f.properties.type
  return MOVABLE_AREAS.has(t) || ['buildings', 'facilities', 'green'].includes(componentDef(t).layer)
}

// Feature types created by drawing tools / generators (not dragged from the library).
const DRAWN: ComponentDef[] = [
  { type: 'boundary', label: 'Development boundary', category: '', geom: 'polygon', layer: 'boundary', color: '#ff7a1a' },
  { type: 'zone', label: 'Zoning area', category: '', geom: 'polygon', layer: 'zoning', color: '#f2c94c', zoning: 'residential' },
  { type: 'plot', label: 'Plot', category: '', geom: 'polygon', layer: 'parcels', color: '#f2c94c', zoning: 'residential' },
  { type: 'road', label: 'Road', category: '', geom: 'line', layer: 'roads', color: '#5b6470', roadClass: 'local' },
  { type: 'utility-line', label: 'Utility line', category: '', geom: 'line', layer: 'utilities', color: '#2cc5c5', network: 'water' },
  { type: 'node', label: 'Point / node', category: '', geom: 'point', layer: 'facilities', color: '#4a8fe0' },
  { type: 'building', label: 'Building', category: 'Residential', geom: 'polygon', layer: 'buildings', color: '#c9a66b', floors: 2 },
  { type: 'cul-de-sac', label: 'Cul-de-sac turning head', category: '', geom: 'polygon', layer: 'roads', color: '#5b6470' },
  { type: 'measure', label: 'Measurement', category: '', geom: 'line', layer: 'annotations', color: '#ff3df5' },
  { type: 'contour', label: 'Contour line', category: '', geom: 'line', layer: 'annotations', color: '#a1887f' },
]

const ALL = new Map([...COMPONENTS, ...DRAWN].map((c) => [c.type, c]))
export const componentDef = (type: string): ComponentDef =>
  ALL.get(type) ?? { type, label: type, category: '', geom: 'polygon', layer: 'annotations', color: '#888888' }

export const FLOOR_HEIGHT = 3.2

/** Default attributes for a newly created component. */
export function defaultAttrs(def: ComponentDef): Attrs {
  const a: Attrs = {}
  if (def.w) Object.assign(a, { width: def.w, depth: def.d ?? def.w, rotation: 0 })
  if (def.floors) Object.assign(a, { floors: def.floors, height: +(def.floors * FLOOR_HEIGHT).toFixed(1) }) // roof unset: the building style decides
  if (def.zoning) a.zoning = def.zoning
  if (def.roadClass) {
    const r = ROAD_CLASSES[def.roadClass]
    Object.assign(a, { roadClass: def.roadClass, width: r.width, lanes: r.lanes, sidewalk: r.sidewalk })
  }
  if (def.network) Object.assign(a, { network: def.network }, def.geom === 'line' && def.network !== 'transit' ? { diameter: NETWORKS[def.network]?.diameter ?? 300, material: NETWORKS[def.network]?.material ?? 'HDPE' } : {})
  if (def.type === 'plot') a.status = 'planned'
  if (def.type === 'roundabout') Object.assign(a, { radius: 20, island: 9 })
  if (def.type === 'cul-de-sac') a.radius = 12
  return a
}

export const DEFAULT_LAYERS: { kind: LayerKind; name: string }[] = [
  { kind: 'boundary', name: 'City boundary' },
  { kind: 'zoning', name: 'Zoning' },
  { kind: 'parcels', name: 'Parcels & plots' },
  { kind: 'green', name: 'Parks & green space' },
  { kind: 'roads', name: 'Road network' },
  { kind: 'utilities', name: 'Utilities' },
  { kind: 'buildings', name: 'Buildings' },
  { kind: 'facilities', name: 'Public facilities' },
  { kind: 'annotations', name: 'Annotations & measurements' },
]

export const uid = () => crypto.randomUUID()

export function newProject(name = 'Untitled project', center: [number, number] = [67.0011, 24.8607], zoom = 14): Project {
  const now = new Date().toISOString()
  return {
    version: SCHEMA_VERSION,
    id: uid(),
    name,
    crs: 'EPSG:4326',
    center,
    zoom,
    basemap: 'grey',
    settings: { personsPerDwelling: 5, dwellingsPerPlot: 1, roadCostPerM2: 45, buildingCostPerM2: 600 },
    layers: DEFAULT_LAYERS.map((l) => ({ id: uid(), ...l, visible: true, locked: false, opacity: 1 })),
    features: {},
    createdAt: now,
    updatedAt: now,
  }
}

/** Display colour shared by the 2D map and the 3D view: custom colour, else zoning, else component. */
export function colorOf(f: PlanFeature): string {
  const { type, attrs } = f.properties
  if (typeof attrs.color === 'string' && /^#[0-9a-f]{6}$/i.test(attrs.color)) return attrs.color
  const z = attrs.zoning as string | undefined
  if ((type === 'plot' || type === 'zone' || type === 'res-plot') && z && ZONING[z]) return ZONING[z].color
  if (type === 'lake') return '#3a8fd8'
  const def = componentDef(type)
  if (def.layer === 'utilities' && typeof attrs.network === 'string' && NETWORKS[attrs.network]) return NETWORKS[attrs.network].color
  return def.color
}
