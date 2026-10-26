"""UrbanForge API: server project storage (PostGIS) and GDAL format conversion.
ponytail: no auth yet — the compose file binds the API to localhost; accounts/roles are the next Phase 6 slice."""
import os
import re
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from osgeo import gdal, osr
from pydantic import BaseModel, ConfigDict

from . import db, gdal_ops

MAX_UPLOAD = 200 * 1024 * 1024
RASTER_EXT = {".tif", ".tiff", ".geotiff", ".asc", ".hgt", ".img", ".dem", ".bil", ".vrt"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.migrate()
    yield


app = FastAPI(title="UrbanForge API", lifespan=lifespan)


class Project(BaseModel):
    """The editor's project JSON; only the fields the server relies on are checked, the rest is kept as-is."""
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    updatedAt: str
    layers: list[dict]
    features: dict[str, dict]


@app.get("/api/health")
def health():
    try:
        with db.connect() as c:
            c.execute("SELECT 1")
        ok = True
    except Exception:
        ok = False
    return {"ok": True, "db": ok, "gdal": gdal.__version__}


@app.get("/api/projects")
def list_projects():
    return db.list_projects()


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = db.get_project(pid)
    if p is None:
        raise HTTPException(404, "project not found")
    return p


@app.put("/api/projects/{pid}")
def put_project(pid: str, p: Project):
    if p.id != pid:
        raise HTTPException(422, "project id does not match the URL")
    for fid, f in p.features.items():
        props = f.get("properties") or {}
        if f.get("id") != fid or not isinstance(f.get("geometry"), dict) or not props.get("type") or not props.get("layerId"):
            raise HTTPException(422, f"feature {fid!r} is malformed")
    try:
        invalid = db.save_project(p.model_dump())
    except Exception as e:  # e.g. PostGIS rejects a geometry outright
        raise HTTPException(422, f"could not store project: {str(e).splitlines()[0]}")
    return {"updatedAt": p.updatedAt, "invalid": invalid}


@app.delete("/api/projects/{pid}", status_code=204)
def delete_project(pid: str):
    if not db.delete_project(pid):
        raise HTTPException(404, "project not found")


@app.post("/api/convert/import")
def convert_import(file: UploadFile, interval: float | None = Query(None, gt=0)):
    """Vector file → WGS 84 GeoJSON; raster DEM → contour lines (`interval` metres, auto when omitted)."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "upload" + ext)  # GDAL picks some drivers by extension; never the client's name
        size = 0
        with open(path, "wb") as out:
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "file larger than 200 MB")
                out.write(chunk)
        try:
            fc, notes = gdal_ops.dem_contours(path, interval) if ext in RASTER_EXT else gdal_ops.vector_to_geojson(path)
        except (ValueError, RuntimeError) as e:
            raise HTTPException(422, f"{file.filename}: {e}")
    return {"featureCollection": fc, "notes": notes}


@app.post("/api/convert/gpkg")
async def convert_gpkg(request: Request, srs: str = "EPSG:4326"):
    """GeoJSON FeatureCollection (WGS 84) → GeoPackage in `srs` (an EPSG code)."""
    try:  # EPSG codes only: free-form CRS input can make GDAL fetch URLs
        if not re.fullmatch(r"EPSG:\d{4,6}", srs):
            raise RuntimeError
        osr.SpatialReference().ImportFromEPSG(int(srs[5:]))
    except RuntimeError:
        raise HTTPException(422, f"unknown CRS {srs!r} (use EPSG:<code>)")
    fc = await request.json()
    if fc.get("type") != "FeatureCollection" or not isinstance(fc.get("features"), list):
        raise HTTPException(422, "expected a GeoJSON FeatureCollection")
    try:
        data = gdal_ops.geojson_to_gpkg(fc, srs)
    except RuntimeError as e:
        raise HTTPException(422, str(e))
    return Response(data, media_type="application/geopackage+sqlite3")
