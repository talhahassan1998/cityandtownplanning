declare module 'shpjs' {
  import type { FeatureCollection } from 'geojson'
  type Result = (FeatureCollection & { fileName?: string }) | (FeatureCollection & { fileName?: string })[]
  /** Parses a zipped shapefile set; reprojects to WGS 84 using the .prj when present. */
  export function parseZip(buffer: ArrayBuffer, whiteList?: string[]): Promise<Result>
  export default function getShapefile(base: string | ArrayBuffer, whiteList?: string[]): Promise<Result>
}
