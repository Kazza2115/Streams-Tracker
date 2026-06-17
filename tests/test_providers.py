from providers import MockProvider, SpotifyProvider, TrackCount, aggregate_tracks
from spotify_client import PlaylistData


def test_aggregate_sums_and_flags_partial():
    tracks = [
        TrackCount("a", "X", 100, "t1", "al1"),
        TrackCount("b", "X", 50, "t2", "al1"),
        TrackCount("c", "Y", None, "t3", "al2"),
    ]
    r = aggregate_tracks(
        entity_type="playlist", entity_name="P", entity_id="pid", source="test", tracks=tracks
    )
    assert r.total_streams == 150
    assert r.tracks_counted == 2
    assert r.tracks_missing == 1
    assert r.partial is True
    assert r.notes  # explains the exclusion


def test_aggregate_all_missing_returns_none():
    tracks = [TrackCount("a", "X", None, "t1")]
    r = aggregate_tracks(
        entity_type="playlist", entity_name="P", entity_id="pid", source="test", tracks=tracks
    )
    assert r.total_streams is None
    assert r.partial is True


def test_mock_playlist():
    r = MockProvider().get_streams("playlist", "anyid")
    assert r.entity_type == "playlist"
    assert r.total_streams is not None
    assert r.tracks_missing == 1  # one demo track has no count
    assert r.partial is True


class _FakeClient:
    """Stands in for SpotifyClient so we can test orchestration offline."""

    def __init__(self):
        self.album_calls = []

    def fetch_playlist(self, playlist_id):
        return PlaylistData(
            name="Test PL",
            tracks=[
                TrackCount("a", "X", None, "t1", "al1"),
                TrackCount("b", "X", None, "t2", "al1"),  # same album as t1
                TrackCount("c", "Y", None, "t3", "al2"),
            ],
        )

    def album_play_counts(self, album_id):
        self.album_calls.append(album_id)
        return {"al1": {"t1": 100, "t2": 200}, "al2": {"t3": 5}}[album_id]


def test_spotify_provider_dedupes_albums_and_aggregates():
    fake = _FakeClient()
    r = SpotifyProvider(client=fake).get_streams("playlist", "pid")
    assert r.total_streams == 305
    assert r.tracks_missing == 0
    # Two distinct albums -> two album fetches, not three (dedupe by album).
    assert sorted(fake.album_calls) == ["al1", "al2"]


def test_spotify_provider_rejects_non_playlist():
    import pytest

    with pytest.raises(NotImplementedError):
        SpotifyProvider(client=_FakeClient()).get_streams("album", "x")
