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

import json
import os
import time
from dataclasses import dataclass
from typing import Optional

import requests

# --- Volatile constants (override via env) ----------------------------------
TOKEN_URL = os.getenv("SP_TOKEN_URL", "https://open.spotify.com/get_access_token")
TOKEN_PARAMS = {"reason": "transport", "productType": "web-player"}
PATHFINDER_URL = os.getenv("SP_PATHFINDER_URL", "https://api-partner.spotify.com/pathfinder/v2/query")
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
        self._client_token = client_token
        self._static_token = access_token  # if set, used directly (e.g. a captured token)
        self._token: Optional[str] = None
        self._token_expiry_ms: int = 0
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
        if self._static_token:           # a directly-supplied bearer token (expires ~1h)
            return self._static_token
        now_ms = int(time.time() * 1000)
        if self._token and now_ms < self._token_expiry_ms - 30_000:
            return self._token
        try:
            r = self._session.get(
                TOKEN_URL, params=TOKEN_PARAMS,
                headers={"Cookie": f"sp_dc={self._sp_dc}"}, timeout=15,
            )
        except requests.RequestException as e:
            raise SpotifyError(f"Could not reach Spotify token endpoint: {e}") from e
        if r.status_code != 200:
            raise SpotifyError(
                f"Token endpoint returned HTTP {r.status_code}; the sp_dc cookie "
                "may be invalid/expired, or the token now requires a TOTP param."
            )
        data = r.json()
        if data.get("isAnonymous", True) or not data.get("accessToken"):
            raise SpotifyError(
                "Spotify treated the session as anonymous — the sp_dc cookie is "
                "invalid/expired, or a TOTP is now required for the token."
            )
        self._token = data["accessToken"]
        self._token_expiry_ms = int(data.get("accessTokenExpirationTimestampMs", now_ms + 3_000_000))
        return self._token

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
        if self._client_token:
            headers["client-token"] = self._client_token.strip()
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
            if not items or len(items) < PLAYLIST_PAGE_SIZE:
                break  # short page => last page (works without relying on totalCount)
        return PlaylistData(name=name, tracks=tracks)

    def album_play_counts(self, album_id: str) -> dict:
        """Map track_id -> play_count for every track on an album, paginated."""
        uri = f"spotify:album:{album_id}"
        counts: dict[str, int] = {}
        offset = 0
        while True:
            data = self._query("getAlbum", {"uri": uri, "locale": LOCALE, "offset": offset, "limit": ALBUM_PAGE_SIZE})
            album = data.get("albumUnion") or data.get("album") or {}
            tracks = album.get("tracksV2") or album.get("tracks") or {}
            items = tracks.get("items") or []
            for it in items:
                tr = (it or {}).get("track") or {}
                tid = _id_from_uri(tr.get("uri", ""))
                pc = tr.get("playcount")
                if tid and pc is not None:
                    try:
                        counts[tid] = int(pc)
                    except (TypeError, ValueError):
                        pass
            offset += ALBUM_PAGE_SIZE
            if not items or len(items) < ALBUM_PAGE_SIZE:
                break
        return counts


def _id_from_uri(uri: str) -> str:
    return uri.rsplit(":", 1)[-1] if uri else ""


def _env_suffix(operation: str) -> str:
    """fetchPlaylist -> FETCH_PLAYLIST (for the SP_HASH_* env var name)."""
    out = []
    for ch in operation:
        out.append("_" + ch if ch.isupper() else ch.upper())
    return "".join(out)
