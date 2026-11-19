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
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  password text NOT NULL,
  role text NOT NULL CHECK (role IN ('planner', 'applicant')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
-- projects saved before accounts existed have no owner; the first user to save one claims it
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id int REFERENCES users(id) ON DELETE CASCADE;
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


USER_COLS = "id, username, name, role"


def _user(row) -> dict | None:
    return dict(zip(("id", "username", "name", "role"), row)) if row else None


def create_user(username: str, name: str, password_hash: str) -> dict | None:
    """The first account is a planner (bootstraps the office); later sign-ups are applicants. None if the name is taken."""
    with connect() as c, c.transaction():
        c.execute("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
        role = "applicant" if c.execute("SELECT 1 FROM users LIMIT 1").fetchone() else "planner"
        return _user(c.execute(
            f"INSERT INTO users (username, name, password, role) VALUES (%s, %s, %s, %s) ON CONFLICT (username) DO NOTHING RETURNING {USER_COLS}",
            (username, name, password_hash, role)).fetchone())


def user_with_password(username: str) -> tuple[dict, str] | None:
    with connect() as c:
        row = c.execute(f"SELECT {USER_COLS}, password FROM users WHERE username = %s", (username,)).fetchone()
    return (_user(row[:4]), row[4]) if row else None


def create_session(token_hash: str, user_id: int, days: int) -> None:
    with connect() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < now()")
        c.execute("INSERT INTO sessions VALUES (%s, %s, now() + make_interval(days => %s))", (token_hash, user_id, days))


def session_user(token_hash: str) -> dict | None:
    with connect() as c:
        return _user(c.execute(
            f"SELECT {', '.join('u.' + k for k in USER_COLS.split(', '))} FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = %s AND s.expires_at > now()", (token_hash,)).fetchone())


def delete_session(token_hash: str) -> None:
    with connect() as c:
        c.execute("DELETE FROM sessions WHERE token_hash = %s", (token_hash,))


def project_owner(pid: str) -> tuple[bool, int | None]:
    """(exists, owner_id)."""
    with connect() as c:
        row = c.execute("SELECT owner_id FROM projects WHERE id = %s", (pid,)).fetchone()
    return (row is not None, row[0] if row else None)


def list_projects(owner_id: int) -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT p.id, p.name, p.updated_at, count(f.id) FROM projects p LEFT JOIN features f ON f.project_id = p.id"
            " WHERE p.owner_id = %s OR p.owner_id IS NULL GROUP BY p.id ORDER BY p.updated_at DESC", (owner_id,)
        ).fetchall()
    return [{"id": r[0], "name": r[1], "updatedAt": r[2].isoformat(), "featureCount": r[3]} for r in rows]


def get_project(pid: str) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT data FROM projects WHERE id = %s", (pid,)).fetchone()
    return row[0] if row else None


def save_project(p: dict, owner_id: int) -> list[dict]:
    """Upserts the project and its feature mirror in one transaction. Returns PostGIS validity problems
    ([{id, reason}]) — reported, not rejected: the editor is the authority on what the user drew."""
    feats = list(p.get("features", {}).values())
    with connect() as c, c.transaction():
        c.execute(
            "INSERT INTO projects (id, name, data, updated_at, owner_id) VALUES (%s, %s, %s, %s, %s)"
            " ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,"
            " owner_id = EXCLUDED.owner_id",
            (p["id"], p.get("name", ""), Jsonb(p), p["updatedAt"], owner_id),
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
