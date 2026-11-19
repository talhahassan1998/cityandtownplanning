"""UrbanForge API: accounts, server project storage (PostGIS) and GDAL format conversion.
Every route except /health and /auth needs a signed-in user; projects are private to their owner."""
import os
import re
import tempfile
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import Response
from osgeo import gdal, osr
from pydantic import BaseModel, ConfigDict, Field

from . import auth, db, gdal_ops, imagery

MAX_UPLOAD = 200 * 1024 * 1024
RASTER_EXT = {".tif", ".tiff", ".geotiff", ".asc", ".hgt", ".img", ".dem", ".bil", ".vrt"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.migrate()
    yield


app = FastAPI(title="UrbanForge API", lifespan=lifespan)
User = Depends(auth.current_user)


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


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=1, max_length=200)
    remember: bool = False


class Registration(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=200)


@app.post("/api/auth/register", status_code=201)
def register(body: Registration, request: Request, response: Response):
    username = body.username.strip().lower()
    if not auth.USERNAME.fullmatch(username):
        raise HTTPException(422, "Usernames use 3–40 letters, digits, dots, dashes or underscores.")
    user = db.create_user(username, body.name.strip(), auth.hash_password(body.password))
    if not user:
        raise HTTPException(409, "That username is taken.")
    auth.start_session(response, request, user["id"], remember=False)
    return user


@app.post("/api/auth/login")
def login(body: Credentials, request: Request, response: Response):
    username = body.username.strip().lower()
    auth.throttle(username)
    found = db.user_with_password(username)
    if not found or not auth.check_password(body.password, found[1]):
        auth.failed(username)
        raise HTTPException(401, "Wrong username or password.")
    auth.start_session(response, request, found[0]["id"], body.remember)
    return found[0]


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response):
    auth.end_session(request, response)


@app.get("/api/auth/me")
def me(user: dict = User):
    return user


def owned(pid: str, user: dict) -> bool:
    """True if the project exists. Someone else's project answers 404, not 403, so ids don't leak."""
    exists, owner = db.project_owner(pid)
    if exists and owner not in (None, user["id"]):
        raise HTTPException(404, "project not found")
    return exists


@app.get("/api/projects")
def list_projects(user: dict = User):
    return db.list_projects(user["id"])


@app.get("/api/projects/{pid}")
def get_project(pid: str, user: dict = User):
    if not owned(pid, user):
        raise HTTPException(404, "project not found")
    return db.get_project(pid)


@app.put("/api/projects/{pid}")
def put_project(pid: str, p: Project, user: dict = User):
    if p.id != pid:
        raise HTTPException(422, "project id does not match the URL")
    owned(pid, user)
    for fid, f in p.features.items():
        props = f.get("properties") or {}
        if f.get("id") != fid or not isinstance(f.get("geometry"), dict) or not props.get("type") or not props.get("layerId"):
            raise HTTPException(422, f"feature {fid!r} is malformed")
    try:
        invalid = db.save_project(p.model_dump(), user["id"])
    except Exception as e:  # e.g. PostGIS rejects a geometry outright
        raise HTTPException(422, f"could not store project: {str(e).splitlines()[0]}")
    return {"updatedAt": p.updatedAt, "invalid": invalid}


@app.delete("/api/projects/{pid}", status_code=204)
def delete_project(pid: str, user: dict = User):
    if not owned(pid, user) or not db.delete_project(pid):
        raise HTTPException(404, "project not found")


@app.post("/api/convert/import")
def convert_import(file: UploadFile, interval: float | None = Query(None, gt=0), _: dict = User):
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
async def convert_gpkg(request: Request, srs: str = "EPSG:4326", _: dict = User):
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


class ConstructionRequest(BaseModel):
    site: dict


@app.post("/api/imagery/construction")
def imagery_construction(body: ConstructionRequest, _: dict = User):
    """Possible recent construction on the site from Sentinel-2 (now vs a year ago). A warning aid, never proof."""
    if body.site.get("type") != "Polygon":
        raise HTTPException(422, "site must be a GeoJSON Polygon")
    try:
        problem = imagery.site_problem(body.site)
    except (RuntimeError, AttributeError):
        problem = "invalid site polygon"
    if problem:
        raise HTTPException(422, problem)
    try:
        return imagery.construction(body.site)
    except imagery.UpstreamError as e:
        raise HTTPException(502, str(e))
