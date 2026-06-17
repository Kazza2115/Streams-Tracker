import pytest

from parsing import ParseError, parse_spotify_input


@pytest.mark.parametrize(
    "raw,expected",
    [
        (
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
            ("playlist", "37i9dQZF1DXcBWIGoYBM5M"),
        ),
        (
            "https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc",
            ("playlist", "37i9dQZF1DXcBWIGoYBM5M"),
        ),
        ("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", ("playlist", "37i9dQZF1DXcBWIGoYBM5M")),
        ("open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3", ("album", "1DFixLWuPkv3KT3TnV35m3")),
        ("  spotify:artist:0OdUWJ0sBjDrqHygGUXeCF  ", ("artist", "0OdUWJ0sBjDrqHygGUXeCF")),
    ],
)
def test_parse_ok(raw, expected):
    assert parse_spotify_input(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "https://example.com/x", "just some text", "spotify:weird:123", "spotify:playlist:"],
)
def test_parse_rejects(raw):
    with pytest.raises(ParseError):
        parse_spotify_input(raw)
