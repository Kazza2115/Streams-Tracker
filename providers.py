"""Provider abstraction: one interface, swappable data sources.

The Flask app talks only to a StreamProvider and never knows which source is
behind it. That is what makes the phased plan (Spotify now, an aggregator
later) a one-line change instead of a rewrite.

Adding a data source = a new StreamProvider subclass returning a StreamResult.
Keep StreamResult's shape stable — the template depends on it. New fields may be
added (additive is fine); existing ones should not change meaning.
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TrackCount:
    """One track's contribution to a total. Also used as a 'stub' (play_count
    left None) while we still need to look the count up."""

    name: str
    artists: str                      # joined display string, e.g. "A, B"
    play_count: Optional[int]         # None when the count is unavailable
    track_id: str = ""
    album_id: Optional[str] = None


@dataclass
class StreamResult:
    """What every provider returns. The template depends on this shape."""

    entity_type: str                  # "playlist" | "album" | "artist"
    entity_name: str
    entity_id: str
    source: str                       # "mock" | "spotify" | "songstats"
    total_streams: Optional[int]      # sum of available counts; None if none
    tracks: list[TrackCount] = field(default_factory=list)
    tracks_counted: int = 0           # tracks with a real count
    tracks_missing: int = 0           # tracks whose count was unavailable
    partial: bool = False             # True when tracks_missing > 0
    notes: list[str] = field(default_factory=list)
    url: Optional[str] = None


def aggregate_tracks(
    *,
    entity_type: str,
    entity_name: str,
    entity_id: str,
    source: str,
    tracks: list[TrackCount],
    url: Optional[str] = None,
    extra_notes: Optional[list[str]] = None,
) -> StreamResult:
    """Sum per-track counts into a StreamResult, honestly flagging gaps.

    - total_streams is the sum of available counts, or None if *no* track had a
      count (so the UI says "unavailable" instead of a misleading 0).
    - partial is set when at least one track's count was missing.
    """
    counted = [t for t in tracks if t.play_count is not None]
    missing = [t for t in tracks if t.play_count is None]
    total = sum(t.play_count for t in counted) if counted else None

    notes = list(extra_notes or [])
    if missing:
        notes.append(
            f"{len(missing)} of {len(tracks)} track(s) had no available count "
            "and are excluded from the total."
        )

    return StreamResult(
        entity_type=entity_type,
        entity_name=entity_name,
        entity_id=entity_id,
        source=source,
        total_streams=total,
        tracks=tracks,
        tracks_counted=len(counted),
        tracks_missing=len(missing),
        partial=bool(missing),
        notes=notes,
        url=url,
    )


class StreamProvider(ABC):
    """The single interface the Flask app depends on."""

    name: str = "base"

    @abstractmethod
    def get_streams(self, entity_type: str, entity_id: str) -> StreamResult:
        """Return a StreamResult, or raise on hard failure (never fake a number)."""
        raise NotImplementedError


class MockProvider(StreamProvider):
    """Offline demo data — no network. Used for development, tests, and CI."""

    name = "mock"

    # A small, realistic playlist: a few tracks across two albums, plus one
    # track with no count (e.g. a local/unavailable item) to exercise the
    # partial-total path.
    _PLAYLIST_TRACKS = [
        TrackCount("Midnight City", "M83", 612_004_511, "t1", "alb_a"),
        TrackCount("Outro", "M83", 158_223_004, "t2", "alb_a"),
        TrackCount("Reckoner", "Radiohead", 142_991_233, "t3", "alb_b"),
        TrackCount("Nude", "Radiohead", 121_044_872, "t4", "alb_b"),
        TrackCount("Local Demo Take", "Unknown", None, "t5", None),
    ]

    def get_streams(self, entity_type: str, entity_id: str) -> StreamResult:
        if entity_type == "playlist":
            return aggregate_tracks(
                entity_type="playlist",
                entity_name="Roster Sampler (demo)",
                entity_id=entity_id,
                source=self.name,
                tracks=list(self._PLAYLIST_TRACKS),
                url=f"https://open.spotify.com/playlist/{entity_id}",
            )
        raise NotImplementedError(
            f"MockProvider only serves playlists in phase 1 (got {entity_type!r})."
        )


class SpotifyProvider(StreamProvider):
    """Real counts via Spotify's internal endpoint (fragile, unverified in CI).

    All endpoint access is delegated to spotify_client — this class only
    orchestrates: fetch playlist items, look up per-track play counts (batched
    by album to minimize calls), then aggregate.
    """

    name = "spotify"

    def __init__(self, client=None):
        # Lazy import so the mock path never needs the network stack, and so
        # tests can inject a fake client.
        if client is None:
            from spotify_client import SpotifyClient

            client = SpotifyClient.from_env()
        self.client = client

    def get_streams(self, entity_type: str, entity_id: str) -> StreamResult:
        if entity_type != "playlist":
            raise NotImplementedError(
                f"SpotifyProvider phase-1 supports playlists only (got {entity_type!r})."
            )
        playlist = self.client.fetch_playlist(entity_id)   # name + track stubs
        tracks = self._resolve_play_counts(playlist.tracks)
        return aggregate_tracks(
            entity_type="playlist",
            entity_name=playlist.name,
            entity_id=entity_id,
            source=self.name,
            tracks=tracks,
            url=f"https://open.spotify.com/playlist/{entity_id}",
        )

    def _resolve_play_counts(self, stubs: list[TrackCount]) -> list[TrackCount]:
        """Fill in play counts by fetching each distinct album exactly once."""
        album_ids = {s.album_id for s in stubs if s.album_id}
        counts: dict[str, int] = {}
        for album_id in album_ids:
            try:
                counts.update(self.client.album_play_counts(album_id))
            except Exception:
                # Leave those tracks uncounted rather than fail the whole total;
                # aggregate_tracks will mark the result partial.
                continue
        return [
            TrackCount(
                name=s.name,
                artists=s.artists,
                play_count=counts.get(s.track_id),
                track_id=s.track_id,
                album_id=s.album_id,
            )
            for s in stubs
        ]


class SongstatsProvider(StreamProvider):
    """Phase-2: real multi-platform totals via an aggregator API."""

    name = "songstats"

    def get_streams(self, entity_type: str, entity_id: str) -> StreamResult:
        raise NotImplementedError(
            "SongstatsProvider is a phase-2 stub. Set SOURCE=mock or SOURCE=spotify."
        )


def get_provider(source: Optional[str] = None) -> StreamProvider:
    """Factory: choose a provider from the SOURCE env var (default: mock)."""
    source = (source or os.getenv("SOURCE") or "mock").lower()
    if source == "mock":
        return MockProvider()
    if source == "spotify":
        return SpotifyProvider()
    if source == "songstats":
        return SongstatsProvider()
    raise ValueError(f"Unknown SOURCE {source!r} (expected mock|spotify|songstats).")
