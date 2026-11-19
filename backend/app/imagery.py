"""Possible recent construction from Sentinel-2 L2A (Element84 Earth Search, public COGs, no key).

Compares a cloud-masked median composite of the site over the last 60 days with the same 60 days one year
earlier (same season, so crops don't read as construction) and flags 10 m pixels where vegetation turned to
bare soil or the built-up index jumped. A warning aid only: always "possible", never proof.
"""
import json
import math
import threading
import time
import urllib.request
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date, timedelta

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()

M_LON, M_LAT = 111320.0, 110574.0  # metres per degree (lon at the equator, lat), as frame() in geo.ts
# ponytail: hand-set thresholds and minimum patch size; tune on real sites (or learn them) if false alarms bite
NDVI_DROP = 0.2
BSI_RISE = 0.05
NDBI_RISE = 0.15
NOW_NDVI_MAX = 0.3  # construction ground isn't green: a pixel still vegetated now is never flagged
MIN_M2 = 1000
MASK_SCL = {0, 1, 3, 8, 9, 10, 11}  # no data, saturated, cloud shadow, cloud (medium/high), cirrus, snow


def reflectance(dn: np.ndarray, band_meta: dict | None) -> np.ndarray:
    """Digital numbers → surface reflectance with the item's own scale/offset (baseline ≥ 04.00 adds −0.1); 0 = no data."""
    scale = (band_meta or {}).get("scale", 1e-4)
    offset = (band_meta or {}).get("offset", 0.0)
    out = dn.astype(np.float32) * scale + offset
    out[dn == 0] = np.nan
    return out


def _ratio(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return (a - b) / (a + b)


def indices(red: np.ndarray, nir: np.ndarray, swir: np.ndarray) -> dict[str, np.ndarray]:
    return {"ndvi": _ratio(nir, red), "ndbi": _ratio(swir, nir), "bsi": _ratio(swir + red, nir)}


def composite(stacks: list[dict[str, np.ndarray]]) -> dict[str, np.ndarray]:
    """Per-pixel median over the scenes, ignoring cloud/shadow/snow/no-data pixels (NaN where none is clear)."""
    out = {}
    for band in ("red", "nir", "swir16"):
        layers = []
        for s in stacks:
            v = s[band].astype(np.float32).copy()
            v[np.isin(s["scl"], list(MASK_SCL))] = np.nan
            layers.append(v)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels stay NaN
            out[band] = np.nanmedian(np.stack(layers), axis=0)
    return out


def detect(before: dict, now: dict) -> np.ndarray:
    """Pixels that turned from vegetation to bare soil, or became clearly more built-up. NaN anywhere → False."""
    with np.errstate(invalid="ignore"):
        cleared = (before["ndvi"] - now["ndvi"] > NDVI_DROP) & (now["bsi"] - before["bsi"] > BSI_RISE)
        built = now["ndbi"] - before["ndbi"] > NDBI_RISE
        bare = now["ndvi"] < NOW_NDVI_MAX
    return np.nan_to_num((cleared | built) & bare, nan=False).astype(bool)


def patches(mask: np.ndarray, site_mask: np.ndarray, gt: tuple, min_m2: float = MIN_M2) -> list[dict]:
    """Connected (8-way) flagged pixels inside the site → GeoJSON Polygon features with `area_m2`, small ones dropped."""
    flag = (mask & site_mask).astype(np.uint8)
    if not flag.any():
        return []
    h, w = flag.shape
    ras = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Byte)
    ras.SetGeoTransform(gt)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    ras.SetProjection(srs.ExportToWkt())
    band = ras.GetRasterBand(1)
    band.WriteArray(flag)
    ds = ogr.GetDriverByName("Memory").CreateDataSource("p")
    layer = ds.CreateLayer("p", srs, ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn("v", ogr.OFTInteger))
    gdal.Polygonize(band, band, layer, 0, ["8CONNECTED=8"])  # band as its own mask: only flagged pixels
    out = []
    for f in layer:
        g = f.GetGeometryRef()
        lat = g.Centroid().GetY()
        area = g.Area() * M_LON * math.cos(math.radians(lat)) * M_LAT
        if area >= min_m2:
            out.append({"type": "Feature", "geometry": json.loads(g.ExportToJson()), "properties": {"area_m2": round(area)}})
    return out


STAC = "https://earth-search.aws.element84.com/v1/search"
WINDOW = timedelta(days=60)
MAX_ITEMS = 6
BUDGET_S = 60  # whole check, both windows
MAX_SITE_M2 = 25e6
MAX_PIXELS = int(MAX_SITE_M2 / 100)  # the grid is the site's bounding box at 10 m: a thin or self-crossing polygon must not blow it up
MAX_CONCURRENT = 2  # checks at once; more are refused so they never starve the API's shared worker threads (saves, sign-in)
SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT)
MIN_VALID = 0.5  # share of site pixels that must be clear in each composite
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")  # don't list the bucket per COG
gdal.SetConfigOption("GDAL_HTTP_TIMEOUT", "20")
gdal.SetConfigOption("GDAL_HTTP_MAX_RETRY", "2")  # S3 occasionally truncates a range read
gdal.SetConfigOption("GDAL_HTTP_RETRY_DELAY", "1")


class UpstreamError(Exception):
    """Sentinel-2 catalogue or imagery unreachable / too slow."""


def _today() -> date:
    return date.today()


def _ogr(site: dict) -> ogr.Geometry:
    return ogr.CreateGeometryFromJson(json.dumps(site))


def _dims(g: ogr.Geometry) -> tuple[int, int]:
    """(h, w) of the ~10 m grid over the geometry's bounding box."""
    w0, e0, s0, n0 = g.GetEnvelope()
    w = max(1, math.ceil((e0 - w0) * M_LON * math.cos(math.radians((s0 + n0) / 2)) / 10))
    return max(1, math.ceil((n0 - s0) * M_LAT / 10)), w


def site_problem(site: dict) -> str | None:
    """Why the site can't be checked (shown to the user), or None."""
    g = _ogr(site)
    if g is None or not g.IsValid():
        return "invalid site polygon (self-crossing or broken)"
    area = g.Area() * M_LON * math.cos(math.radians(g.Centroid().GetY())) * M_LAT
    if area <= 0:
        return "site has no area"
    h, w = _dims(g)
    if area > MAX_SITE_M2 or h * w > MAX_PIXELS:
        return f"site (or its bounding box) larger than {MAX_SITE_M2 / 1e6:g} km² — check a smaller area"
    return None


def scenes(bbox: list[float], start: date, end: date, timeout: float = 20) -> list[dict]:
    """Sentinel-2 L2A items over `bbox` between the dates, newest first."""
    body = {"collections": ["sentinel-2-l2a"], "bbox": bbox, "datetime": f"{start.isoformat()}T00:00:00Z/{end.isoformat()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": 40}}, "limit": MAX_ITEMS, "sortby": [{"field": "properties.datetime", "direction": "desc"}]}
    req = urllib.request.Request(STAC, json.dumps(body).encode(), {"Content-Type": "application/json", "User-Agent": "urbanforge"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)["features"]
    except (OSError, ValueError, KeyError) as e:
        raise UpstreamError(f"Sentinel-2 catalogue unreachable ({e})")


def read_stack(item: dict, bbox: list[float], shape: tuple[int, int], deadline: float | None = None) -> dict[str, np.ndarray]:
    """The item's red/nir/swir16 (reflectance) and scl (scene class) warped onto the site grid."""
    h, w = shape
    out = {}
    for band in ("red", "nir", "swir16", "scl"):
        if deadline is not None and time.monotonic() > deadline:  # a straggler stops between bands instead of reading on
            raise UpstreamError("Sentinel-2 imagery took too long")
        asset = item["assets"][band]
        dst = f"/vsimem/{uuid.uuid4().hex}.tif"
        try:
            ds = gdal.Warp(dst, "/vsicurl/" + asset["href"], outputBounds=bbox, outputBoundsSRS="EPSG:4326",
                           dstSRS="EPSG:4326", width=w, height=h, resampleAlg="near")
            a = ds.ReadAsArray()
            ds = None
        except RuntimeError as e:
            raise UpstreamError(f"Sentinel-2 image unreadable ({e})")
        finally:
            gdal.Unlink(dst)
        out[band] = a.astype(np.int16) if band == "scl" else reflectance(a, (asset.get("raster:bands") or [None])[0])
    return out


def _grid(site: dict) -> tuple[list[float], tuple[int, int], tuple, np.ndarray]:
    """bbox, (h, w) at ~10 m, geotransform and the site's pixel mask."""
    w0, e0, s0, n0 = _ogr(site).GetEnvelope()
    h, w = _dims(_ogr(site))
    gt = (w0, (e0 - w0) / w, 0.0, n0, 0.0, -(n0 - s0) / h)
    ras = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Byte)
    ras.SetGeoTransform(gt)
    vec = ogr.GetDriverByName("Memory").CreateDataSource("s")
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)  # lon, lat like the raster
    ras.SetProjection(srs.ExportToWkt())
    layer = vec.CreateLayer("s", srs, ogr.wkbPolygon)
    f = ogr.Feature(layer.GetLayerDefn())
    f.SetGeometry(_ogr(site))
    layer.CreateFeature(f)
    gdal.RasterizeLayer(ras, [1], layer, burn_values=[1], options=["ALL_TOUCHED=TRUE"])
    return [w0, s0, e0, n0], (h, w), gt, ras.ReadAsArray().astype(bool)


def construction(site: dict) -> dict:
    """Possible construction on `site` (GeoJSON Polygon, already passed `site_problem`): now (last 60 days) vs the
    same weeks a year earlier. Raises UpstreamError when busy, unreachable or over `BUDGET_S`."""
    if not SLOTS.acquire(blocking=False):
        raise UpstreamError("imagery check busy — try again shortly")
    try:
        return _construction(site, time.monotonic() + BUDGET_S)
    finally:
        SLOTS.release()


def _construction(site: dict, deadline: float) -> dict:
    left = lambda: max(1.0, deadline - time.monotonic())
    bbox, shape, gt, site_mask = _grid(site)
    today = _today()
    windows = {"now": (today - WINDOW, today), "before": (today - timedelta(days=365) - WINDOW, today - timedelta(days=365))}
    items = {k: scenes(bbox, *v, timeout=left()) for k, v in windows.items()}
    dates = {k: (v[0]["properties"]["datetime"][:10] if v else None) for k, v in items.items()}
    empty = {"type": "FeatureCollection", "features": []}
    result = {"status": "no-clear-image", "now": dates["now"], "before": dates["before"], "patches": empty,
              "attribution": f"Contains modified Copernicus Sentinel data {(dates['now'] or str(today))[:4]}"}
    if not items["now"] or not items["before"] or not site_mask.any():  # no pixel of the site: unchecked, never "no change"
        return result
    pool = ThreadPoolExecutor(2 * MAX_ITEMS)
    futures = {k: [pool.submit(read_stack, it, bbox, shape, deadline) for it in v] for k, v in items.items()}
    stacks: dict[str, list] = {k: [] for k in futures}
    try:
        for k, fs in futures.items():
            for f in fs:
                try:
                    stacks[k].append(f.result(timeout=max(0.1, deadline - time.monotonic())))
                except UpstreamError as e:  # one truncated/unreadable scene: the others still make a composite
                    failed = e
            if not stacks[k]:
                raise failed
    except FutureTimeout:
        raise UpstreamError(f"Sentinel-2 imagery took longer than {BUDGET_S} s")
    finally:
        pool.shutdown(wait=False, cancel_futures=True)  # don't hold the request for stragglers
    comp = {k: composite(v) for k, v in stacks.items()}
    for c in comp.values():
        valid = np.isfinite(c["red"]) & np.isfinite(c["nir"]) & np.isfinite(c["swir16"]) & site_mask
        if valid.sum() < MIN_VALID * site_mask.sum():
            return result
    mask = detect(indices(comp["before"]["red"], comp["before"]["nir"], comp["before"]["swir16"]),
                  indices(comp["now"]["red"], comp["now"]["nir"], comp["now"]["swir16"]))
    return {**result, "status": "ok", "patches": {"type": "FeatureCollection", "features": patches(mask, site_mask, gt)}}
