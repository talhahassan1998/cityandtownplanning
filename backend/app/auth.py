"""Accounts and sessions. Passwords: stdlib scrypt with a per-user salt. Sessions: a random token in an
HttpOnly cookie; only its SHA-256 is stored, so a leaked table can't be replayed."""
import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict

from fastapi import HTTPException, Request, Response

from . import db

COOKIE = "uf_session"
SESSION_DAYS = 30
USERNAME = re.compile(r"[a-z0-9._-]{3,40}")
MAX_FAILS, FAIL_WINDOW = 5, 15 * 60
# ponytail: per-process failure counter; move to the db (or a proxy rate limit) when the API runs >1 worker
_fails: dict[str, list[float]] = defaultdict(list)


def hash_password(pw: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_password(pw: str, stored: str) -> bool:
    _, salt, _h = stored.split("$")
    return hmac.compare_digest(hash_password(pw, bytes.fromhex(salt)), stored)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(response: Response, request: Request, user_id: int, remember: bool) -> None:
    token = secrets.token_urlsafe(32)
    db.create_session(_token_hash(token), user_id, SESSION_DAYS)
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400 if remember else None, httponly=True,
                        samesite="lax", secure=request.url.scheme == "https", path="/api")


def end_session(request: Request, response: Response) -> None:
    if token := request.cookies.get(COOKIE):
        db.delete_session(_token_hash(token))
    response.delete_cookie(COOKIE, path="/api")


def current_user(request: Request) -> dict:
    """FastAPI dependency: the signed-in user, or 401."""
    token = request.cookies.get(COOKIE)
    user = db.session_user(_token_hash(token)) if token else None
    if not user:
        raise HTTPException(401, "Sign in required.")
    return user


def throttle(username: str) -> None:
    now = time.time()
    _fails[username] = [t for t in _fails[username] if now - t < FAIL_WINDOW]
    if len(_fails[username]) >= MAX_FAILS:
        raise HTTPException(429, "Too many failed sign-ins. Try again in 15 minutes.")


def failed(username: str) -> None:
    _fails[username].append(time.time())
