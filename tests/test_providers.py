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
    """Stands in for SpotifyClient; the playlist already carries play counts."""

    def fetch_playlist(self, playlist_id):
        return PlaylistData(
            name="Test PL",
            tracks=[
                TrackCount("a", "X", 100, "t1", "al1"),
                TrackCount("b", "X", 200, "t2", "al1"),
                TrackCount("c", "Y", None, "t3", "al2"),  # missing count -> partial
            ],
        )


def test_spotify_provider_aggregates_playlist():
    r = SpotifyProvider(client=_FakeClient()).get_streams("playlist", "pid")
    assert r.total_streams == 300
    assert r.tracks_counted == 2
    assert r.tracks_missing == 1
    assert r.partial is True


def test_spotify_provider_rejects_non_playlist():
    import pytest

    with pytest.raises(NotImplementedError):
        SpotifyProvider(client=_FakeClient()).get_streams("album", "x")
