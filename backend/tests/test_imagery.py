"""Sentinel-2 construction check: pure detection on synthetic arrays (no network) + the route with fetching stubbed."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import imagery
from app.main import app
from tests.test_api import client, signed_in  # noqa: F401  (shared signed-in client fixture, cleans up its users)

N = 20
BLOCK = (slice(5, 10), slice(5, 10))
M_LON, M_LAT = 111320.0, 110574.0  # metres per degree at the equator (imagery.py uses the same)
GT = (0.0, 10 / M_LON, 0.0, 0.0, 0.0, -10 / M_LAT)  # 10 m pixels at lat 0


def stack(red, nir, swir, scl=4):
    full = lambda v: np.full((N, N), v, dtype=np.float32)
    return {"red": full(red), "nir": full(nir), "swir16": full(swir), "scl": np.full((N, N), scl, dtype=np.int16)}


def idx(s):
    return imagery.indices(s["red"], s["nir"], s["swir16"])


def test_vegetation_to_bare_is_flagged():
    before = stack(0.05, 0.4, 0.15)
    now = stack(0.05, 0.4, 0.15)
    for b, v in (("red", 0.2), ("nir", 0.25), ("swir16", 0.3)):
        now[b][BLOCK] = v
    m = imagery.detect(idx(before), idx(now))
    assert m[BLOCK].all() and m.sum() == 25


def test_stable_and_seasonal_identical_not_flagged():
    veg = stack(0.05, 0.4, 0.15)
    assert not imagery.detect(idx(veg), idx(veg)).any()
    bare = stack(0.2, 0.25, 0.3)
    assert not imagery.detect(idx(bare), idx(bare)).any()


def test_still_green_field_not_flagged():
    # real false alarm (farmland 72.85,33.20, Nov 2025→2026): SWIR up with the crop greener → NDBI "rise"
    before, now = stack(0.05, 0.4, 0.15), stack(0.04, 0.45, 0.3)
    assert not imagery.detect(idx(before), idx(now)).any()


def test_masked_pixels_ignored():
    cloudy, clear = stack(0.9, 0.9, 0.9), stack(0.05, 0.4, 0.15)
    cloudy["scl"][BLOCK] = 9
    c = imagery.composite([cloudy, clear])
    assert np.isclose(c["red"][BLOCK], 0.05).all()  # only the clear stack counts there
    allcloud = stack(0.2, 0.25, 0.3, scl=9)
    m = imagery.detect(idx(stack(0.05, 0.4, 0.15)), idx(imagery.composite([allcloud])))
    assert not m.any()


def test_reflectance_offset():
    assert np.isclose(imagery.reflectance(np.array([2000]), {"scale": 1e-4, "offset": -0.1})[0], 0.1)
    assert np.isclose(imagery.reflectance(np.array([2000]), None)[0], 0.2)
    assert np.isnan(imagery.reflectance(np.array([0]), None)[0])


def test_composite_merges_half_covering_items():
    a, b = stack(0.1, 0.3, 0.2), stack(0.1, 0.3, 0.2)
    for k in ("red", "nir", "swir16"):
        a[k][:, :10] = np.nan
        b[k][:, 10:] = np.nan
    a["scl"][:, :10] = 0
    b["scl"][:, 10:] = 0
    c = imagery.composite([a, b])
    assert all(np.isfinite(c[k]).all() for k in ("red", "nir", "swir16"))


def test_patches_min_area_and_tiny_site():
    site = np.ones((N, N), dtype=bool)
    m = np.zeros((N, N), dtype=bool)
    m[2:6, 2:6] = True  # 16 px = 1600 m²
    m[12:14, 12:14] = True  # 400 m²: below the minimum
    p = imagery.patches(m, site, GT)
    assert len(p) == 1 and p[0]["properties"]["area_m2"] == pytest.approx(1600, rel=0.05)
    assert p[0]["geometry"]["type"] == "Polygon"
    assert imagery.patches(np.ones((1, 1), bool), np.ones((1, 1), bool), GT) == []
    site[:, :4] = False  # the site edge cuts the block to 4×2 = 800 m²
    assert imagery.patches(m, site, GT) == []


SITE = {"type": "Polygon", "coordinates": [[[0, 0], [0.0018, 0], [0.0018, 0.0018], [0, 0.0018], [0, 0]]]}  # ≈200 m square


def fake_fetch(monkeypatch, now_scl=4, items=True):
    def scenes(bbox, start, end, timeout=20):
        if not items:
            return []
        when = "now" if start.year == 2026 else "before"
        return [{"id": when, "properties": {"datetime": f"{start.year}-11-10T05:59:42Z"}}]

    def read_stack(item, bbox, shape, deadline=None):
        s = {"red": np.full(shape, 0.05, np.float32), "nir": np.full(shape, 0.4, np.float32),
             "swir16": np.full(shape, 0.15, np.float32), "scl": np.full(shape, 4, np.int16)}
        if item["id"] == "now":
            s["red"][5:15, 5:15], s["nir"][5:15, 5:15], s["swir16"][5:15, 5:15] = 0.2, 0.25, 0.3
            s["scl"][:] = now_scl
        return s

    monkeypatch.setattr(imagery, "scenes", scenes)
    monkeypatch.setattr(imagery, "read_stack", read_stack)
    monkeypatch.setattr(imagery, "_today", lambda: imagery.date(2026, 11, 12))


def post(c, site=SITE):
    return c.post("/api/imagery/construction", json={"site": site})


def test_route_ok(client, monkeypatch):
    fake_fetch(monkeypatch)
    r = post(client)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "ok" and d["now"] == "2026-11-10" and d["before"] == "2025-11-10"
    assert len(d["patches"]["features"]) == 1 and d["patches"]["features"][0]["properties"]["area_m2"] > 5000
    assert "Copernicus Sentinel data 2026" in d["attribution"]


def test_route_no_clear_image(client, monkeypatch):
    fake_fetch(monkeypatch, now_scl=9)
    d = post(client).json()
    assert d["status"] == "no-clear-image" and d["patches"]["features"] == []


def test_route_no_items(client, monkeypatch):
    fake_fetch(monkeypatch, items=False)
    d = post(client).json()
    assert d["status"] == "no-clear-image" and d["patches"]["features"] == []


def test_route_too_big(client, monkeypatch):
    fake_fetch(monkeypatch)
    big = {"type": "Polygon", "coordinates": [[[0, 0], [0.054, 0], [0.054, 0.054], [0, 0.054], [0, 0]]]}  # ≈6 km square
    assert post(client, big).status_code == 422
    assert post(client, {"type": "Point", "coordinates": [0, 0]}).status_code == 422


def test_route_upstream_down(client, monkeypatch):
    def down(*_, **__):
        raise imagery.UpstreamError("Sentinel-2 catalogue unreachable")
    monkeypatch.setattr(imagery, "scenes", down)
    r = post(client)
    assert r.status_code == 502 and "unreachable" in r.json()["detail"]


def test_route_needs_session():
    with TestClient(app) as anon:
        assert post(anon).status_code == 401


def test_route_survives_one_unreadable_scene(client, monkeypatch):
    fake_fetch(monkeypatch)
    good_scenes, good_read = imagery.scenes, imagery.read_stack
    monkeypatch.setattr(imagery, "scenes", lambda b, s, e, timeout=20: good_scenes(b, s, e) + [{"id": "broken", "properties": {"datetime": "x"}}])

    def read(item, bbox, shape, deadline=None):
        if item["id"] == "broken":
            raise imagery.UpstreamError("Sentinel-2 image unreadable (truncated tile)")
        return good_read(item, bbox, shape, deadline)
    monkeypatch.setattr(imagery, "read_stack", read)
    d = post(client).json()
    assert d["status"] == "ok" and len(d["patches"]["features"]) == 1


def test_route_rejects_huge_grids_and_bad_shapes(client, monkeypatch):
    fake_fetch(monkeypatch)
    thin_l = {"type": "Polygon", "coordinates": [[[0, 0], [5, 0], [5, 0.0001], [0.0001, 0.0001], [0.0001, 5], [0, 5], [0, 0]]]}  # 12 km², 55k×55k px box
    bowtie = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}  # area 0, self-crossing
    flat = {"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0, 0], [0, 0]]]}  # zero area
    for site in (thin_l, bowtie, flat):
        assert post(client, site).status_code == 422, site


def test_budget_covers_the_catalogue_search(monkeypatch):
    seen = []
    def scenes(bbox, start, end, timeout=20):
        seen.append(timeout)
        return []
    monkeypatch.setattr(imagery, "scenes", scenes)
    imagery.construction(SITE)
    assert len(seen) == 2 and all(0 < t <= imagery.BUDGET_S for t in seen)


def test_busy_check_is_refused_not_queued(client, monkeypatch):
    fake_fetch(monkeypatch)
    held = [imagery.SLOTS.acquire(blocking=False) for _ in range(imagery.MAX_CONCURRENT)]
    try:
        r = post(client)
        assert r.status_code == 502 and "busy" in r.json()["detail"]
    finally:
        for h in held:
            if h:
                imagery.SLOTS.release()


def test_empty_site_mask_is_not_reported_as_no_change(monkeypatch):
    fake_fetch(monkeypatch)
    grid = imagery._grid
    def empty(site):
        bbox, shape, gt, mask = grid(site)
        return bbox, shape, gt, np.zeros_like(mask)
    monkeypatch.setattr(imagery, "_grid", empty)
    assert imagery.construction(SITE)["status"] == "no-clear-image"
