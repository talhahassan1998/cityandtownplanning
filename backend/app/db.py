"""PostGIS storage. The project JSON (see src/model.ts `Project`) is the contract and is stored whole;
its features are mirrored into a PostGIS table so the server can validate and later query geometry."""
import json
import os
import time

import psycopg
from psycopg.types.json import Jsonb

DSN = os.environ.get("DATABASE_URL", "postgresql://urbanforge:urbanforge@db:5432/urbanforge")

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS features (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  type text NOT NULL,
  layer_id text NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS features_geom_idx ON features USING gist (geom);
"""


def connect() -> psycopg.Connection:
    return psycopg.connect(DSN)


def migrate(attempts: int = 30, wait: float = 1.0) -> None:
    """Creates the schema, retrying while Postgres starts: Docker's restart policy starts the api with the db
    after a reboot, ignoring compose's depends_on, and the api exits if the db isn't accepting connections yet."""
    for i in range(attempts):
        try:
            with connect() as c:
                c.execute(SCHEMA)
            return
        except psycopg.OperationalError:
            if i == attempts - 1:
                raise
            time.sleep(wait)


def list_projects() -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT p.id, p.name, p.updated_at, count(f.id) FROM projects p LEFT JOIN features f ON f.project_id = p.id"
            " GROUP BY p.id ORDER BY p.updated_at DESC"
        ).fetchall()
    return [{"id": r[0], "name": r[1], "updatedAt": r[2].isoformat(), "featureCount": r[3]} for r in rows]


def get_project(pid: str) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT data FROM projects WHERE id = %s", (pid,)).fetchone()
    return row[0] if row else None


def save_project(p: dict) -> list[dict]:
    """Upserts the project and its feature mirror in one transaction. Returns PostGIS validity problems
    ([{id, reason}]) — reported, not rejected: the editor is the authority on what the user drew."""
    feats = list(p.get("features", {}).values())
    with connect() as c, c.transaction():
        c.execute(
            "INSERT INTO projects (id, name, data, updated_at) VALUES (%s, %s, %s, %s)"
            " ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at",
            (p["id"], p.get("name", ""), Jsonb(p), p["updatedAt"]),
        )
        c.execute("DELETE FROM features WHERE project_id = %s", (p["id"],))
        # ponytail: full rewrite of the mirror per save; per-feature upserts when collaboration needs them
        # Force2D: imported/contour features can carry Z; the column is 2D and Z stays in the project JSON
        with c.cursor() as cur:
            cur.executemany(
                "INSERT INTO features (project_id, id, type, layer_id, geom) VALUES (%s, %s, %s, %s, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)))",
                [(p["id"], f["id"], f["properties"]["type"], f["properties"]["layerId"], json.dumps(f["geometry"])) for f in feats],
            )
        rows = c.execute(
            "SELECT id, ST_IsValidReason(geom) FROM features WHERE project_id = %s AND NOT ST_IsValid(geom)", (p["id"],)
        ).fetchall()
    return [{"id": r[0], "reason": r[1]} for r in rows]


def delete_project(pid: str) -> bool:
    with connect() as c:
        return c.execute("DELETE FROM projects WHERE id = %s", (pid,)).rowcount > 0
