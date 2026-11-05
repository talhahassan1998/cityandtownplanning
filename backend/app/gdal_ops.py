"""GDAL/OGR conversions. All output GeoJSON is WGS 84 (lon/lat), the editor's only CRS."""
import json
import math
import uuid

from osgeo import gdal, ogr, osr

gdal.UseExceptions()

WGS84 = "EPSG:4326"
MAX_DEM_PX = 2048  # longer DEM sides are resampled first, so contouring stays interactive


def _tmp(ext: str) -> str:
    return f"/vsimem/{uuid.uuid4().hex}{ext}"


def _read(path: str) -> bytes:
    f = gdal.VSIFOpenL(path, "rb")
    try:
        gdal.VSIFSeekL(f, 0, 2)
        n = gdal.VSIFTellL(f)
        gdal.VSIFSeekL(f, 0, 0)
        return bytes(gdal.VSIFReadL(1, n, f))
    finally:
        gdal.VSIFCloseL(f)


def _to_geojson(src, layer: str | None = None, src_srs: str | None = None) -> list[dict]:
    out = _tmp(".geojson")
    try:
        gdal.VectorTranslate(out, src, format="GeoJSON", dstSRS=WGS84, reproject=True, srcSRS=src_srs,
                             layers=[layer] if layer else None, layerCreationOptions=["RFC7946=YES"])
        return json.loads(_read(out))["features"]
    finally:
        gdal.Unlink(out)


def vector_to_geojson(path: str) -> tuple[dict, list[str]]:
    """Any OGR-readable vector file (GeoPackage, FlatGeobuf, GML, MapInfo, GPX…), every layer,
    reprojected to WGS 84. Each feature gets `layer` = its source layer name (a classifier hint)."""
    ds = gdal.OpenEx(path, gdal.OF_VECTOR)
    if ds is None or ds.GetLayerCount() == 0:
        raise ValueError("no vector layers found")
    feats, notes = [], []
    for i in range(ds.GetLayerCount()):
        lyr = ds.GetLayerByIndex(i)
        name = lyr.GetName()
        srs = None
        if lyr.GetSpatialRef() is None:
            ext = lyr.GetExtent() if lyr.GetFeatureCount() else (0, 0, 0, 0)
            if not (-180 <= ext[0] <= 180 and -90 <= ext[2] <= 90):
                notes.append(f"layer “{name}” has no CRS and is not lon/lat — skipped")
                continue
            srs = WGS84
            notes.append(f"layer “{name}” has no CRS — assumed WGS 84")
        else:
            notes.append(f"layer “{name}”: {lyr.GetFeatureCount()} features from {_srs_name(lyr.GetSpatialRef())}")
        for f in _to_geojson(ds, name, srs):
            f["properties"] = {**(f.get("properties") or {}), "layer": name}
            feats.append(f)
    return {"type": "FeatureCollection", "features": feats}, notes


def _srs_name(srs: osr.SpatialReference) -> str:
    code = srs.GetAuthorityCode(None)
    return f"EPSG:{code}" if code else srs.GetName()


def nice_interval(lo: float, hi: float, levels: int = 20) -> float:
    """Round contour interval (1, 2, 5 × 10^n) giving about `levels` contours over [lo, hi]."""
    span = max(hi - lo, 1e-6) / levels
    mag = 10 ** math.floor(math.log10(span))
    return next(m * mag for m in (1, 2, 5, 10) if m * mag >= span)


def dem_contours(path: str, interval: float | None = None) -> tuple[dict, list[str]]:
    """Contour lines from a GeoTIFF / DEM (band 1) as WGS 84 GeoJSON lines {type: 'contour', elevation}."""
    src = gdal.Open(path)
    if src is None or src.RasterCount == 0:
        raise ValueError("not a raster")
    if not src.GetProjection():
        raise ValueError("raster has no CRS / georeferencing — cannot place it on the map")
    notes = []
    if max(src.RasterXSize, src.RasterYSize) > MAX_DEM_PX:
        k = MAX_DEM_PX / max(src.RasterXSize, src.RasterYSize)
        tmp = _tmp(".tif")
        src = gdal.Translate(tmp, src, width=round(src.RasterXSize * k), height=round(src.RasterYSize * k), resampleAlg="average")
        notes.append(f"resampled to {src.RasterXSize}×{src.RasterYSize} px for contouring")
    band = src.GetRasterBand(1)
    lo, hi = band.ComputeRasterMinMax(False)
    step = interval or nice_interval(lo, hi)
    srs = osr.SpatialReference(wkt=src.GetProjection())
    mem = ogr.GetDriverByName("Memory").CreateDataSource("c")
    lyr = mem.CreateLayer("contours", srs, ogr.wkbLineString)
    lyr.CreateField(ogr.FieldDefn("elevation", ogr.OFTReal))
    nodata = band.GetNoDataValue()
    gdal.ContourGenerateEx(band, lyr, options=[f"LEVEL_INTERVAL={step}", "ELEV_FIELD=elevation"] + ([f"NODATA={nodata}"] if nodata is not None else []))
    # a level equal to the min/max only traces the raster's edge
    feats = [f for f in _to_geojson(mem) if lo < f["properties"]["elevation"] < hi]
    for f in feats:
        f["properties"] = {"type": "contour", "name": f"Contour {f['properties']['elevation']:g} m", "elevation": f["properties"]["elevation"]}
    notes.insert(0, f"DEM {_srs_name(srs)}, elevation {lo:.1f}–{hi:.1f} m, contours every {step:g} m ({len(feats)} lines)")
    return {"type": "FeatureCollection", "features": feats}, notes


def geojson_to_gpkg(fc: dict, srs: str = WGS84) -> bytes:
    """GeoPackage with one table per plan layer (the `layer` property), reprojected to `srs`."""
    src, out = _tmp(".geojson"), _tmp(".gpkg")
    try:
        gdal.FileFromMemBuffer(src, json.dumps(fc).encode())
        names = sorted({str((f.get("properties") or {}).get("layer") or "plan") for f in fc["features"]}) or ["plan"]
        for i, name in enumerate(names):
            where = f"layer = '{name.replace(chr(39), chr(39) * 2)}'" if name != "plan" else "layer IS NULL OR layer = 'plan'"
            gdal.VectorTranslate(out, src, format="GPKG", srcSRS=WGS84, dstSRS=srs, reproject=True, layerName=name, where=where,
                                 accessMode="update" if i else None)
        return _read(out)
    finally:
        gdal.Unlink(src)
        gdal.Unlink(out)
