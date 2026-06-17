"""The ONLY module that talks to Spotify's internal web-player endpoint.

Everything here is undocumented and fragile by design (see CLAUDE.md). All the
volatile constants live at the top, so when Spotify ships a change this is the
single place to update.

As of this version Spotify uses **pathfinder v2**: requests are HTTP **POST** to
`/pathfinder/v2/query` with a JSON body carrying `operationName`, `variables`
and `extensions.persistedQuery.sha256Hash` (the older v1 put these in the URL
query string). Auth is a bearer token derived from the `sp_dc` cookie, and v2
often also wants a `client-token` header.

Everything volatile is overridable via env vars so you can adjust without code
edits after capturing a real request (DevTools → Network → a `pathfinder/v2/query`
request → **Payload** tab):
  - SP_DC                     the sp_dc cookie (required)
  - SP_HASH_FETCH_PLAYLIST    persisted-query sha256 for the playlist op
  - SP_HASH_GET_ALBUM         persisted-query sha256 for the album op
  - SP_OP_FETCH_PLAYLIST      operation name (default "fetchPlaylist")
  - SP_OP_GET_ALBUM           operation name (default "getAlbum")
  - SP_CLIENT_TOKEN           value for the client-token header (if required)
  - SP_TOKEN_URL / SP_PATHFINDER_URL  override endpoints if they move

If pathfinder returns HTTP 400, a hash/op name has rotated — recapture and update.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import struct
import time
from email.utils import parsedate_to_datetime
from dataclasses import dataclass
from typing import Optional

import requests

# --- Volatile constants (override via env) ----------------------------------
TOKEN_URL = os.getenv("SP_TOKEN_URL", "https://open.spotify.com/api/token")
TOKEN_PARAMS = {"reason": "transport", "productType": "web-player"}
PATHFINDER_URL = os.getenv("SP_PATHFINDER_URL", "https://api-partner.spotify.com/pathfinder/v2/query")
# Automatic auth: exchange the sp_dc cookie for a token (TOTP) and grant a
# client-token. All version-specific bits are env-overridable (they rotate).
CLIENTTOKEN_URL = os.getenv("SP_CLIENTTOKEN_URL", "https://clienttoken.spotify.com/v1/clienttoken")
CLIENT_ID = os.getenv("SP_CLIENT_ID", "d8a5ed958d274c2e8ee717e6a4b0971d")
CLIENT_VERSION = os.getenv("SP_CLIENT_VERSION", "1.2.93.309.ga193fd34")
# TOTP secrets rotate often (a version "expires" after a few weeks). Fetch the
# community-maintained list at runtime so we auto-update, with the latest known
# values baked in as a fallback. Override one via SP_TOTP_VER + SP_TOTP_CIPHER;
# change the source via SP_SECRETS_URL.
SECRETS_URL = os.getenv("SP_SECRETS_URL", "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/main/secrets/secretDict.json")
_BAKED_TOTP = [
    ("61", "44,55,47,42,70,40,34,114,76,74,50,111,120,97,75,76,94,102,43,69,49,120,118,80,64,78"),
    ("60", "79,109,69,123,90,65,46,74,94,34,58,48,70,71,92,85,122,63,91,64,87,87"),
    ("59", "123,105,79,70,110,59,52,125,60,49,80,70,89,75,80,86,63,53,123,37,117,49,52,93,77,62,47,86,48,104,68,72"),
]
_remote_cache = {"ts": 0.0, "candidates": None}
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
)
# Operation name -> persisted-query hash. Both rotate; set via env. Defaults
# below are real values captured from the web player (not secrets).
OPERATIONS = {
    "fetchPlaylist": os.getenv("SP_OP_FETCH_PLAYLIST", "fetchPlaylistContents"),
    "getAlbum": os.getenv("SP_OP_GET_ALBUM", "getAlbum"),
}
QUERY_HASHES = {
    "fetchPlaylist": os.getenv("SP_HASH_FETCH_PLAYLIST", "a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4"),
    "getAlbum": os.getenv("SP_HASH_GET_ALBUM", "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10"),
}
LOCALE = os.getenv("SP_LOCALE", "")
PLAYLIST_PAGE_SIZE = 50
ALBUM_PAGE_SIZE = 50
MAX_TRACKS = int(os.getenv("SP_MAX_TRACKS", "12000"))   # pagination safety cap
# ---------------------------------------------------------------------------


class SpotifyError(RuntimeError):
    """Any failure talking to the internal endpoint. Message is user-facing."""


@dataclass
class PlaylistData:
    name: str
    tracks: list  # list[TrackCount] stubs, play_count left None


class SpotifyClient:
    def __init__(self, sp_dc: str = "", hashes: Optional[dict] = None, client_token: str = "", access_token: str = ""):
        if not sp_dc and not access_token:
            raise SpotifyError(
                "Set SP_DC (sp_dc cookie) or SP_ACCESS_TOKEN (a captured bearer token)."
            )
        self._sp_dc = sp_dc
        self._hashes = {**QUERY_HASHES, **(hashes or {})}
        self._ct_manual = client_token       # SP_CLIENT_TOKEN override (else auto-granted)
        self._static_token = access_token     # SP_ACCESS_TOKEN override (else auto via TOTP)
        self._token: Optional[str] = None
        self._token_expiry_ms: int = 0
        self._ct_value: Optional[str] = None
        self._ct_expiry: float = 0.0
        self._session = requests.Session()
        self._session.headers.update(
            {"User-Agent": USER_AGENT, "App-Platform": "WebPlayer", "Accept": "application/json"}
        )

    @classmethod
    def from_env(cls) -> "SpotifyClient":
        return cls(
            sp_dc=os.getenv("SP_DC", ""),
            client_token=os.getenv("SP_CLIENT_TOKEN", ""),
            access_token=os.getenv("SP_ACCESS_TOKEN", ""),
        )

    # --- auth ---------------------------------------------------------------
    def _access_token(self) -> str:
        if self._static_token:           # manual SP_ACCESS_TOKEN override (expires ~1h)
            return self._static_token
        now_ms = int(time.time() * 1000)
        if self._token and now_ms < self._token_expiry_ms - 30_000:
            return self._token
        if not self._sp_dc:
            raise SpotifyError("Need SP_DC (cookie) to auto-generate a token, or set SP_ACCESS_TOKEN.")
        got = self._token_via_totp() or self._token_from_homepage()
        if not got:
            raise SpotifyError(
                "Could not mint an access token automatically (homepage + TOTP both failed; "
                "the sp_dc cookie may be expired/invalid, the IP may be blocked, or the TOTP "
                "secret rotated). Set SP_ACCESS_TOKEN (+ SP_CLIENT_TOKEN) as a fallback."
            )
        self._token, self._token_expiry_ms = got
        return self._token

    def _token_from_homepage(self):
        """Read the bootstrap access token from the web player HTML (no TOTP)."""
        try:
            r = self._session.get("https://open.spotify.com/", headers={"Cookie": f"sp_dc={self._sp_dc}"}, timeout=15)
        except requests.RequestException:
            return None
        if r.status_code != 200:
            return None
        m = re.search(r'"accessToken":"([^"]+)"', r.text)
        if not m:
            return None
        exp = re.search(r'"accessTokenExpirationTimestampMs":(\d+)', r.text)
        return m.group(1), int(exp.group(1)) if exp else int(time.time() * 1000) + 3_000_000

    def _server_time(self) -> int:
        """Spotify validates the TOTP against its server clock — read it from the
        Date header rather than trusting the local clock."""
        try:
            r = self._session.head("https://open.spotify.com/", timeout=10)
            d = r.headers.get("Date")
            if d:
                return int(parsedate_to_datetime(d).timestamp())
        except Exception:
            pass
        return int(time.time())

    def _token_via_totp(self):
        """Mint an access token via get_access_token with a computed TOTP."""
        st = self._server_time()
        for ver, cipher in _totp_candidates():
            try:
                otp = _totp(_totp_secret(cipher), st)
            except Exception:
                continue
            for reason in ("transport", "init"):
                params = {"reason": reason, "productType": "web-player",
                          "totp": otp, "totpServer": otp, "totpVer": ver}
                try:
                    r = self._session.get(TOKEN_URL, params=params,
                                          headers={"Cookie": f"sp_dc={self._sp_dc}", "Referer": "https://open.spotify.com/"},
                                          timeout=15)
                except requests.RequestException:
                    continue
                if r.status_code != 200:
                    continue
                data = r.json()
                if data.get("isAnonymous", True) or not data.get("accessToken"):
                    continue
                return data["accessToken"], int(data.get("accessTokenExpirationTimestampMs", int(time.time() * 1000) + 3_000_000))
        return None

    def diagnose(self) -> dict:
        """Report each auth step's status (no secrets) so failures are visible."""
        rep = {
            "sp_dc_set": bool(self._sp_dc),
            "manual_access_token": bool(self._static_token),
            "manual_client_token": bool(self._ct_manual),
            "token_url": TOKEN_URL,
        }
        try:
            h = self._session.head("https://open.spotify.com/", timeout=10)
            rep["homepage_head_status"] = h.status_code
            rep["server_date"] = h.headers.get("Date")
        except Exception as e:
            rep["homepage_head_error"] = repr(e)
        ver, cipher = _totp_candidates()[0]
        try:
            otp = _totp(_totp_secret(cipher), self._server_time())
            r = self._session.get(
                TOKEN_URL,
                params={"reason": "transport", "productType": "web-player", "totp": otp, "totpServer": otp, "totpVer": ver},
                headers={"Cookie": f"sp_dc={self._sp_dc}", "Referer": "https://open.spotify.com/"},
                timeout=15,
            )
            rep["token_status"] = r.status_code
            rep["token_content_type"] = r.headers.get("Content-Type")
            snippet = re.sub(r'"accessToken":"[^"]*"', '"accessToken":"<redacted>"', r.text[:300])
            rep["token_body_snippet"] = snippet
            try:
                j = r.json()
                rep["token_isAnonymous"] = j.get("isAnonymous")
                rep["token_has_accessToken"] = bool(j.get("accessToken"))
            except Exception:
                pass
        except Exception as e:
            rep["token_error"] = repr(e)
        try:
            rep["client_token_granted"] = bool(self._client_token())
        except Exception as e:
            rep["client_token_error"] = repr(e)
        return rep

    def _client_token(self) -> str:
        if self._ct_manual:              # manual SP_CLIENT_TOKEN override
            return self._ct_manual
        now = time.time()
        if self._ct_value and now < self._ct_expiry - 60:
            return self._ct_value
        body = {
            "client_data": {
                "client_version": CLIENT_VERSION, "client_id": CLIENT_ID,
                "js_sdk_data": {"device_brand": "unknown", "device_model": "unknown",
                                "os": "windows", "os_version": "NT 10.0", "device_id": "", "device_type": "computer"},
            }
        }
        try:
            r = self._session.post(CLIENTTOKEN_URL, json=body, headers={"Accept": "application/json"}, timeout=15)
            gt = (r.json() or {}).get("granted_token") or {}
            tok = gt.get("token")
            if tok:
                self._ct_value = tok
                self._ct_expiry = now + (gt.get("refresh_after_seconds") or 1200)
                return tok
        except requests.RequestException:
            pass
        return ""   # fall through; pathfinder will surface a clear 401/403 if it was required

    # --- pathfinder v2 (POST) ----------------------------------------------
    def _query(self, op_key: str, variables: dict) -> dict:
        sha = self._hashes.get(op_key)
        if not sha:
            raise SpotifyError(
                f"No persisted-query hash for {op_key!r}. Capture it from a "
                f"pathfinder/v2 request's Payload and set SP_HASH_{_env_suffix(op_key)}."
            )
        body = {
            "variables": variables,
            "operationName": OPERATIONS.get(op_key, op_key),
            "extensions": {"persistedQuery": {"version": 1, "sha256Hash": sha}},
        }
        tok = self._access_token().strip()
        if tok.lower().startswith("bearer "):
            tok = tok[7:].strip()           # tolerate a pasted "Bearer …" value
        headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "Accept-Language": "en"}
        ct = self._client_token()
        if ct:
            headers["client-token"] = ct.strip()
        try:
            r = self._session.post(PATHFINDER_URL, data=json.dumps(body), headers=headers, timeout=25)
        except requests.RequestException as e:
            raise SpotifyError(f"Pathfinder request failed: {e}") from e
        if r.status_code == 400:
            raise SpotifyError(
                f"Pathfinder HTTP 400 for {op_key!r} — the persisted-query hash or "
                "operation name has likely rotated. Recapture and update the env vars."
            )
        if r.status_code in (401, 403):
            raise SpotifyError(
                f"Pathfinder HTTP {r.status_code} — auth rejected. The bearer token has "
                "likely expired (re-capture a fresh SP_ACCESS_TOKEN), or SP_CLIENT_TOKEN "
                "is missing/invalid. Re-capture both and test within a few minutes."
            )
        if r.status_code != 200:
            raise SpotifyError(f"Pathfinder returned HTTP {r.status_code} for {op_key!r}.")
        payload = r.json()
        if payload.get("errors"):
            raise SpotifyError(f"Pathfinder error for {op_key!r}: {payload['errors']}")
        return payload.get("data", {})

    # --- high-level reads ---------------------------------------------------
    def fetch_playlist(self, playlist_id: str) -> PlaylistData:
        """Return the playlist name + tracks, paginated. fetchPlaylistContents
        already carries each track's `playcount`, so no album lookup is needed."""
        from providers import TrackCount  # local import avoids an import cycle

        uri = f"spotify:playlist:{playlist_id}"
        name = ""
        tracks: list = []
        offset = 0
        while True:
            data = self._query("fetchPlaylist", {"uri": uri, "offset": offset, "limit": PLAYLIST_PAGE_SIZE, "includeEpisodeContentRatingsV2": True})
            pl = data.get("playlistV2") or data.get("playlist") or {}
            name = name or (pl.get("name") or "Playlist")
            content = pl.get("content") or {}
            items = content.get("items") or []
            for it in items:
                td = (((it or {}).get("itemV2") or {}).get("data")) or {}
                if td.get("__typename") not in (None, "Track"):
                    continue  # skip episodes / local / unavailable items
                artists = ", ".join(
                    a.get("profile", {}).get("name", "")
                    for a in (td.get("artists") or {}).get("items", [])
                ) or "Unknown"
                try:
                    play_count = int(td.get("playcount"))
                except (TypeError, ValueError):
                    play_count = None          # count unavailable -> excluded, flagged partial
                tracks.append(
                    TrackCount(
                        name=td.get("name", "Unknown"), artists=artists, play_count=play_count,
                        track_id=_id_from_uri(td.get("uri", "")),
                        album_id=_id_from_uri((td.get("albumOfTrack") or {}).get("uri", "")) or None,
                    )
                )
            offset += PLAYLIST_PAGE_SIZE
            if not items or len(items) < PLAYLIST_PAGE_SIZE or offset >= MAX_TRACKS:
                break  # short page => last page; MAX_TRACKS is a safety cap
        return PlaylistData(name=name, tracks=tracks)

    def fetch_album(self, album_id: str) -> PlaylistData:
        """Return the album name + tracks (with play counts), paginated."""
        from providers import TrackCount  # local import avoids an import cycle

        uri = f"spotify:album:{album_id}"
        name = ""
        tracks: list = []
        offset = 0
        while True:
            data = self._query("getAlbum", {"uri": uri, "locale": LOCALE, "offset": offset, "limit": ALBUM_PAGE_SIZE})
            album = data.get("albumUnion") or data.get("album") or {}
            name = name or (album.get("name") or "Album")
            tv = album.get("tracksV2") or album.get("tracks") or {}
            items = tv.get("items") or []
            for it in items:
                tr = (it or {}).get("track") or {}
                artists = ", ".join(
                    a.get("profile", {}).get("name", "")
                    for a in (tr.get("artists") or {}).get("items", [])
                ) or "Unknown"
                try:
                    play_count = int(tr.get("playcount"))
                except (TypeError, ValueError):
                    play_count = None
                tracks.append(
                    TrackCount(
                        name=tr.get("name", "Unknown"), artists=artists, play_count=play_count,
                        track_id=_id_from_uri(tr.get("uri", "")), album_id=album_id,
                    )
                )
            offset += ALBUM_PAGE_SIZE
            if not items or len(items) < ALBUM_PAGE_SIZE:
                break
        return PlaylistData(name=name, tracks=tracks)


def _totp_candidates():
    """Newest-first list of (version, cipher_csv). Env override > maintained
    remote (cached 6h) > baked fallback."""
    if os.getenv("SP_TOTP_VER") and os.getenv("SP_TOTP_CIPHER"):
        return [(os.getenv("SP_TOTP_VER"), os.getenv("SP_TOTP_CIPHER"))]
    now = time.time()
    if _remote_cache["candidates"] and now - _remote_cache["ts"] < 21_600:
        return _remote_cache["candidates"]
    try:
        data = requests.get(SECRETS_URL, timeout=10).json()
        cands = sorted(
            ((str(k), ",".join(str(n) for n in v)) for k, v in data.items() if v),
            key=lambda kv: int(kv[0]), reverse=True,
        )
        if cands:
            _remote_cache["candidates"] = cands
            _remote_cache["ts"] = now
            return cands
    except Exception:
        pass
    return _remote_cache["candidates"] or _BAKED_TOTP


def _totp_secret(cipher_str: str) -> str:
    """Derive the web player's TOTP secret (base32) from a cipher array string."""
    cipher = [int(x) for x in cipher_str.split(",") if x.strip()]
    transformed = [b ^ ((i % 33) + 9) for i, b in enumerate(cipher)]
    data = "".join(str(t) for t in transformed).encode("utf-8")
    return base64.b32encode(data).decode().rstrip("=")


def _totp(secret_b32: str, for_time: int) -> str:
    """RFC-6238 TOTP (SHA1, 30s, 6 digits) over the given unix time."""
    pad = "=" * ((8 - len(secret_b32) % 8) % 8)
    key = base64.b32decode(secret_b32 + pad)
    counter = struct.pack(">Q", int(for_time) // 30)
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def _id_from_uri(uri: str) -> str:
    return uri.rsplit(":", 1)[-1] if uri else ""


def _env_suffix(operation: str) -> str:
    """fetchPlaylist -> FETCH_PLAYLIST (for the SP_HASH_* env var name)."""
    out = []
    for ch in operation:
        out.append("_" + ch if ch.isupper() else ch.upper())
    return "".join(out)
