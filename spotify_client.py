"""The ONLY module that talks to Spotify's internal web-player endpoint.

Everything here is undocumented and fragile by design (see CLAUDE.md). All the
volatile constants live at the top, so when Spotify ships a change this is the
single place to update.

Auth: derived from your logged-in web session's `sp_dc` cookie (read from the
SP_DC env var — never hardcode or commit it). The cookie is exchanged for a
short-lived bearer token, which is then sent to the pathfinder GraphQL endpoint.

Persisted-query hashes ROTATE. If pathfinder starts returning HTTP 400, capture
fresh hashes from the web player (DevTools → Network → filter "pathfinder" →
read extensions.persistedQuery.sha256Hash for each operation) and update
QUERY_HASHES below, or pass them via the SP_HASH_* env vars.

NOTE: the response-shape parsing here follows the current web-player schema but
is UNVERIFIED against live Spotify in this sandbox. Adjust _parse_* helpers
after a real capture if a field has moved.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Optional

import requests

# --- Volatile constants -----------------------------------------------------
TOKEN_URL = "https://open.spotify.com/get_access_token"
TOKEN_PARAMS = {"reason": "transport", "productType": "web-player"}
PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
)
# Persisted-query SHA-256 hashes. These rotate; override via the SP_HASH_* env
# vars without editing code. Empty => the client raises a clear, actionable error.
QUERY_HASHES = {
    "fetchPlaylist": os.getenv("SP_HASH_FETCH_PLAYLIST", ""),
    "getAlbum": os.getenv("SP_HASH_GET_ALBUM", ""),
}
PLAYLIST_PAGE_SIZE = 100
ALBUM_PAGE_SIZE = 50
# ---------------------------------------------------------------------------


class SpotifyError(RuntimeError):
    """Any failure talking to the internal endpoint. Message is user-facing."""


@dataclass
class PlaylistData:
    name: str
    tracks: list  # list[TrackCount] stubs, play_count left None


class SpotifyClient:
    def __init__(self, sp_dc: str, hashes: Optional[dict] = None):
        if not sp_dc:
            raise SpotifyError(
                "Missing SP_DC cookie. Set the SP_DC env var to your web "
                "session's sp_dc cookie value."
            )
        self._sp_dc = sp_dc
        self._hashes = {**QUERY_HASHES, **(hashes or {})}
        self._token: Optional[str] = None
        self._token_expiry_ms: int = 0
        self._session = requests.Session()
        self._session.headers.update(
            {"User-Agent": USER_AGENT, "App-Platform": "WebPlayer", "Accept": "application/json"}
        )

    @classmethod
    def from_env(cls) -> "SpotifyClient":
        return cls(sp_dc=os.getenv("SP_DC", ""))

    # --- auth ---------------------------------------------------------------
    def _access_token(self) -> str:
        now_ms = int(time.time() * 1000)
        if self._token and now_ms < self._token_expiry_ms - 30_000:
            return self._token
        try:
            r = self._session.get(
                TOKEN_URL,
                params=TOKEN_PARAMS,
                headers={"Cookie": f"sp_dc={self._sp_dc}"},
                timeout=15,
            )
        except requests.RequestException as e:
            raise SpotifyError(f"Could not reach Spotify token endpoint: {e}") from e
        if r.status_code != 200:
            raise SpotifyError(
                f"Token endpoint returned HTTP {r.status_code}; the sp_dc cookie "
                "may be invalid or expired."
            )
        data = r.json()
        if data.get("isAnonymous", True) or not data.get("accessToken"):
            raise SpotifyError(
                "Spotify treated the session as anonymous — the sp_dc cookie is "
                "invalid or expired. Grab a fresh one while logged in."
            )
        self._token = data["accessToken"]
        self._token_expiry_ms = int(
            data.get("accessTokenExpirationTimestampMs", now_ms + 3_000_000)
        )
        return self._token

    # --- pathfinder ---------------------------------------------------------
    def _query(self, operation: str, variables: dict) -> dict:
        sha = self._hashes.get(operation)
        if not sha:
            raise SpotifyError(
                f"No persisted-query hash for {operation!r}. Capture it from the "
                f"web player and set SP_HASH_{_env_suffix(operation)} "
                "(see this module's docstring)."
            )
        params = {
            "operationName": operation,
            "variables": json.dumps(variables, separators=(",", ":")),
            "extensions": json.dumps(
                {"persistedQuery": {"version": 1, "sha256Hash": sha}},
                separators=(",", ":"),
            ),
        }
        try:
            r = self._session.get(
                PATHFINDER_URL,
                params=params,
                headers={"Authorization": f"Bearer {self._access_token()}"},
                timeout=20,
            )
        except requests.RequestException as e:
            raise SpotifyError(f"Pathfinder request failed: {e}") from e
        if r.status_code == 400:
            raise SpotifyError(
                f"Pathfinder returned HTTP 400 for {operation!r} — the persisted-"
                "query hash has likely rotated. Update QUERY_HASHES / SP_HASH_*."
            )
        if r.status_code == 401:
            raise SpotifyError("Pathfinder returned HTTP 401 — token rejected.")
        if r.status_code != 200:
            raise SpotifyError(
                f"Pathfinder returned HTTP {r.status_code} for {operation!r}."
            )
        payload = r.json()
        if payload.get("errors"):
            raise SpotifyError(f"Pathfinder error for {operation!r}: {payload['errors']}")
        return payload.get("data", {})

    # --- high-level reads ---------------------------------------------------
    def fetch_playlist(self, playlist_id: str) -> PlaylistData:
        """Return the playlist name + track stubs (no counts yet), paginated."""
        from providers import TrackCount  # local import avoids an import cycle

        uri = f"spotify:playlist:{playlist_id}"
        name = ""
        stubs: list = []
        offset = 0
        while True:
            data = self._query(
                "fetchPlaylist",
                {"uri": uri, "offset": offset, "limit": PLAYLIST_PAGE_SIZE},
            )
            pl = data.get("playlistV2") or {}
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
                stubs.append(
                    TrackCount(
                        name=td.get("name", "Unknown"),
                        artists=artists,
                        play_count=None,
                        track_id=_id_from_uri(td.get("uri", "")),
                        album_id=_id_from_uri((td.get("albumOfTrack") or {}).get("uri", ""))
                        or None,
                    )
                )
            total = content.get("totalCount") or 0
            offset += PLAYLIST_PAGE_SIZE
            if not items or offset >= total:
                break
        return PlaylistData(name=name, tracks=stubs)

    def album_play_counts(self, album_id: str) -> dict:
        """Map track_id -> play_count for every track on an album, paginated."""
        uri = f"spotify:album:{album_id}"
        counts: dict[str, int] = {}
        offset = 0
        while True:
            data = self._query(
                "getAlbum",
                {"uri": uri, "locale": "", "offset": offset, "limit": ALBUM_PAGE_SIZE},
            )
            album = data.get("albumUnion") or {}
            tracks = album.get("tracks") or {}
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
            total = tracks.get("totalCount") or 0
            offset += ALBUM_PAGE_SIZE
            if not items or offset >= total:
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
