"""Runs inside the api container against the compose PostGIS: `docker compose run --rm api pytest -q`."""
import json
import uuid

import pytest
from fastapi.testclient import TestClient
from osgeo import gdal, ogr, osr

from app import gdal_ops
from app.main import app

UTM = 32642  # Karachi's UTM zone, a typical projected source CRS


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:  # runs the lifespan → schema migration
        yield c


def project(pid: str, features: dict) -> dict:
    return {"version": 1, "id": pid, "name": "Test", "crs": "EPSG:4326", "center": [67, 24.86], "zoom": 15, "basemap": "grey",
            "settings": {}, "layers": [{"id": "L1", "name": "Plots", "kind": "parcels", "visible": True, "locked": False, "opacity": 1}],
            "features": features, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-02T00:00:00Z"}


def feat(fid: str, coords, gtype="Polygon", ftype="plot") -> dict:
    return {"type": "Feature", "id": fid, "geometry": {"type": gtype, "coordinates": coords},
            "properties": {"id": fid, "type": ftype, "layerId": "L1", "name": fid, "attrs": {}}}


SQUARE = [[[67, 24.86], [67.001, 24.86], [67.001, 24.861], [67, 24.861], [67, 24.86]]]
BOWTIE = [[[67, 24.86], [67.001, 24.861], [67.001, 24.86], [67, 24.861], [67, 24.86]]]


def test_project_round_trip_and_validity_report(client):
    pid = "t-" + uuid.uuid4().hex[:8]
    r = client.put(f"/api/projects/{pid}", json=project(pid, {"a": feat("a", SQUARE), "b": feat("b", BOWTIE)}))
    assert r.status_code == 200, r.text
    assert [i["id"] for i in r.json()["invalid"]] == ["b"]  # self-intersection reported, project still stored
    assert client.get(f"/api/projects/{pid}").json()["features"]["a"]["geometry"]["coordinates"] == SQUARE
    row = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
    assert row["featureCount"] == 2 and row["name"] == "Test"
    # re-save replaces the PostGIS mirror rather than duplicating it
    client.put(f"/api/projects/{pid}", json=project(pid, {"a": feat("a", SQUARE)}))
    assert next(p for p in client.get("/api/projects").json() if p["id"] == pid)["featureCount"] == 1
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_saves_features_with_z(client):
    pid = "t-" + uuid.uuid4().hex[:8]
    line = [[67, 24.86, 12.5], [67.001, 24.861, 13]]
    r = client.put(f"/api/projects/{pid}", json=project(pid, {"c": feat("c", line, "LineString", "contour")}))
    assert r.status_code == 200, r.text
    assert client.get(f"/api/projects/{pid}").json()["features"]["c"]["geometry"]["coordinates"] == line  # Z kept in JSON
    client.delete(f"/api/projects/{pid}")


def test_rejects_mismatched_or_malformed_projects(client):
    assert client.put("/api/projects/x", json=project("y", {})).status_code == 422
    bad = feat("a", SQUARE)
    del bad["properties"]["layerId"]
    assert client.put("/api/projects/x", json=project("x", {"a": bad})).status_code == 422


def utm_gpkg(path: str) -> None:
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(UTM)
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(path)
    lyr = ds.CreateLayer("parcels", srs, ogr.wkbPolygon)
    lyr.CreateField(ogr.FieldDefn("landuse", ogr.OFTString))
    f = ogr.Feature(lyr.GetLayerDefn())
    f.SetField("landuse", "residential")
    f.SetGeometry(ogr.CreateGeometryFromWkt("POLYGON((300000 2750000,300100 2750000,300100 2750100,300000 2750100,300000 2750000))"))
    lyr.CreateFeature(f)
    ds = None


def test_geopackage_import_reprojects_to_wgs84(tmp_path, client):
    p = str(tmp_path / "in.gpkg")
    utm_gpkg(p)
    fc, notes = gdal_ops.vector_to_geojson(p)
    lon, lat = fc["features"][0]["geometry"]["coordinates"][0][0]
    assert 66.5 < lon < 67.5 and 24 < lat < 25.5  # UTM 42N easting 300 km: 200 km west of the 69°E central meridian ≈ 67.02°E
    assert fc["features"][0]["properties"] == {"landuse": "residential", "layer": "parcels"}
    assert "EPSG:32642" in notes[0]
    with open(p, "rb") as f:
        r = client.post("/api/convert/import", files={"file": ("site.gpkg", f)})
    assert r.status_code == 200 and len(r.json()["featureCollection"]["features"]) == 1


def test_dem_contours(tmp_path, client):
    p = str(tmp_path / "dem.tif")
    ds = gdal.GetDriverByName("GTiff").Create(p, 100, 100, 1, gdal.GDT_Float32)
    ds.SetGeoTransform((300000, 10, 0, 2751000, 0, -10))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(UTM)
    ds.SetProjection(srs.ExportToWkt())
    import array
    ds.GetRasterBand(1).WriteRaster(0, 0, 100, 100, array.array("f", [x * 1.0 for _ in range(100) for x in range(100)]).tobytes())
    ds = None  # a ramp rising 1 m per pixel eastward: 0–99 m
    fc, notes = gdal_ops.dem_contours(p, 10)
    elev = sorted({f["properties"]["elevation"] for f in fc["features"]})
    assert elev == [10, 20, 30, 40, 50, 60, 70, 80, 90]
    assert fc["features"][0]["properties"]["type"] == "contour"
    assert "0.0–99.0 m" in notes[0]
    with open(p, "rb") as f:
        r = client.post("/api/convert/import", files={"file": ("dem.tif", f)})
    assert r.status_code == 200 and r.json()["featureCollection"]["features"]


def test_nice_interval():
    assert gdal_ops.nice_interval(0, 100) == 5
    assert gdal_ops.nice_interval(0, 1000) == 50
    assert gdal_ops.nice_interval(12, 13) == 0.05


def test_gpkg_export_one_table_per_layer_in_target_crs(tmp_path, client):
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": SQUARE}, "properties": {"type": "plot", "layer": "Plots"}},
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[67, 24.86], [67.01, 24.86]]}, "properties": {"type": "road-local", "layer": "Road's network"}},
    ]}
    r = client.post(f"/api/convert/gpkg?srs=EPSG:{UTM}", content=json.dumps(fc))
    assert r.status_code == 200
    p = tmp_path / "out.gpkg"
    p.write_bytes(r.content)
    ds = ogr.Open(str(p))
    layers = {ds.GetLayer(i).GetName(): ds.GetLayer(i) for i in range(ds.GetLayerCount())}
    assert set(layers) == {"Plots", "Road's network"}
    assert layers["Plots"].GetSpatialRef().GetAuthorityCode(None) == str(UTM)
    assert layers["Plots"].GetFeatureCount() == 1
    assert client.post("/api/convert/gpkg?srs=http://evil", content=json.dumps(fc)).status_code == 422


def test_migrate_retries_while_db_starts(monkeypatch):
    from app import db
    calls = []
    real = db.connect

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise db.psycopg.OperationalError("the database system is starting up")
        return real()

    monkeypatch.setattr(db, "connect", flaky)
    db.migrate(wait=0)
    assert len(calls) == 3
