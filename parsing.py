"""Parse Spotify URLs and URIs into (entity_type, entity_id).

Pure and network-free. The Flask layer calls this before handing the result to
a provider, so that providers never have to think about input formats.
"""
from __future__ import annotations

from urllib.parse import urlparse

# Entity types we know how to *parse*. Whether a given provider can serve them
# is a separate question (phase 1 only serves playlists).
VALID_TYPES = {"playlist", "album", "artist", "track"}


class ParseError(ValueError):
    """Raised when input is not a recognizable Spotify link or URI."""


def parse_spotify_input(raw: str) -> tuple[str, str]:
    """Return (entity_type, entity_id) for a Spotify URL or URI.

    Accepts, for example:
      - https://open.spotify.com/playlist/37i9dQ...            (web URL)
      - https://open.spotify.com/intl-fr/playlist/37i9dQ...    (localized URL)
      - open.spotify.com/album/...                             (scheme optional)
      - spotify:playlist:37i9dQ...                             (URI)

    Bare ids are rejected on purpose: an id alone has no type.
    Raises ParseError on anything unrecognized.
    """
    if not raw or not raw.strip():
        raise ParseError("Empty input — paste a Spotify link or URI.")
    text = raw.strip()

    # URI form: spotify:playlist:ID
    if text.startswith("spotify:"):
        parts = text.split(":")
        if len(parts) >= 3 and parts[1] in VALID_TYPES and parts[2]:
            return parts[1], _clean_id(parts[2])
        raise ParseError(f"Unrecognized Spotify URI: {raw!r}")

    # URL form
    if "open.spotify.com" in text:
        if "://" not in text:  # tolerate a missing scheme
            text = "https://" + text
        path = urlparse(text).path.strip("/")
        segments = [s for s in path.split("/") if s]
        # Drop a leading locale segment such as "intl-fr".
        if segments and segments[0].startswith("intl-"):
            segments = segments[1:]
        if len(segments) >= 2 and segments[0] in VALID_TYPES and segments[1]:
            return segments[0], _clean_id(segments[1])
        raise ParseError(f"Unrecognized Spotify URL: {raw!r}")

    raise ParseError(
        "Not a Spotify link or URI. Expected something like "
        "https://open.spotify.com/playlist/… or spotify:playlist:…"
    )


def _clean_id(value: str) -> str:
    """Strip any query string or fragment clinging to an id."""
    for sep in ("?", "#"):
        value = value.split(sep, 1)[0]
    return value
