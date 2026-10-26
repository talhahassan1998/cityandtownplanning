/**
 * Elevation and ground imagery from XYZ web-mercator tiles.
 * Elevation: AWS Terrain Tiles ("terrarium" PNG encoding), public and keyless — sources include
 * SRTM, GMTED2010, ETOPO1, NED and others; resolution ≈ 30 m in most places. Attribution required.
 */
export const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
export const TERRAIN_ATTRIBUTION = 'Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1, NED and others)'

/** Terrarium encoding: metres = R×256 + G + B/256 − 32768. */
export const terrariumHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768

/** Fractional global tile coordinates of a point at zoom `z`. */
export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z, rad = (lat * Math.PI) / 180
  return [((lng + 180) / 360) * n, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n]
}

export interface TileRange { z: number; x0: number; y0: number; cols: number; rows: number }

/** The most detailed tile range (zoom ≤ maxZoom) covering `bounds` [w, s, e, n] with at most `maxTiles` tiles. */
export function tilesFor(bounds: [number, number, number, number], maxTiles = 36, maxZoom = 15): TileRange {
  for (let z = maxZoom; z > 0; z--) {
    const [x0f, y0f] = lngLatToTile(bounds[0], bounds[3], z), [x1f, y1f] = lngLatToTile(bounds[2], bounds[1], z)
    const x0 = Math.floor(x0f), y0 = Math.floor(y0f), cols = Math.floor(x1f) - x0 + 1, rows = Math.floor(y1f) - y0 + 1
    if (cols * rows <= maxTiles) return { z, x0, y0, cols, rows }
  }
  return { z: 0, x0: 0, y0: 0, cols: 1, rows: 1 }
}

/** UV (0–1, v up) of a point within a tile mosaic, for texturing. */
export function mosaicUV(r: TileRange, lng: number, lat: number): [number, number] {
  const [tx, ty] = lngLatToTile(lng, lat, r.z)
  return [(tx - r.x0) / r.cols, 1 - (ty - r.y0) / r.rows]
}

export interface Elevation { at(lng: number, lat: number): number; min: number; max: number }

/** Bilinear sampler over a decoded mosaic (row-major, (cols·256) × (rows·256) metres). */
export function mosaicSampler(r: TileRange, data: Float32Array): Elevation {
  const W = r.cols * 256, H = r.rows * 256
  let min = Infinity, max = -Infinity
  for (const v of data) { if (v < min) min = v; if (v > max) max = v }
  const px = (i: number, j: number) => data[Math.max(0, Math.min(H - 1, j)) * W + Math.max(0, Math.min(W - 1, i))]
  return {
    min, max,
    at(lng, lat) {
      const [tx, ty] = lngLatToTile(lng, lat, r.z)
      const x = (tx - r.x0) * 256 - 0.5, y = (ty - r.y0) * 256 - 0.5
      const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j
      return (px(i, j) * (1 - fx) + px(i + 1, j) * fx) * (1 - fy) + (px(i, j + 1) * (1 - fx) + px(i + 1, j + 1) * fx) * fy
    },
  }
}

const tileUrl = (tpl: string, z: number, x: number, y: number) => tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))

/** Draws a tile range into one canvas. Tiles that fail to load are left blank (and counted). */
export async function loadMosaic(tpl: string, r: TileRange): Promise<{ canvas: HTMLCanvasElement; failed: number }> {
  const canvas = document.createElement('canvas')
  canvas.width = r.cols * 256; canvas.height = r.rows * 256
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  let failed = 0
  await Promise.all(Array.from({ length: r.cols * r.rows }, (_, k) => new Promise<void>((done) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { ctx.drawImage(img, (k % r.cols) * 256, Math.floor(k / r.cols) * 256); done() }
    img.onerror = () => { failed++; done() }
    img.src = tileUrl(tpl, r.z, r.x0 + (k % r.cols), r.y0 + Math.floor(k / r.cols))
  })))
  return { canvas, failed }
}

/** Fetches and decodes elevation for `bounds`. Throws if no tile could be loaded. */
export async function loadElevation(bounds: [number, number, number, number]): Promise<Elevation> {
  const r = tilesFor(bounds, 36, 15)
  const { canvas, failed } = await loadMosaic(TERRAIN_URL, r)
  if (failed === r.cols * r.rows) throw new Error('elevation tiles unavailable')
  const px = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const data = new Float32Array(canvas.width * canvas.height)
  let low = Infinity
  for (let i = 0; i < data.length; i++) {
    // transparent pixels come from tiles that failed to load; they'd decode as −32768 m
    data[i] = px[i * 4 + 3] === 0 ? NaN : terrariumHeight(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])
    if (data[i] < low) low = data[i]
  }
  if (failed) for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i])) data[i] = low
  return mosaicSampler(r, data)
}
