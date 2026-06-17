import app as app_module


def _client():
    app_module.app.config.update(TESTING=True)
    return app_module.app.test_client()


def test_get_home():
    resp = _client().get("/")
    assert resp.status_code == 200
    assert b"Stream Consolidator" in resp.data


def test_post_playlist_mock(monkeypatch):
    monkeypatch.setenv("SOURCE", "mock")
    app_module._provider = None  # force re-read of SOURCE
    resp = _client().post("/", data={"link": "spotify:playlist:abc"})
    assert resp.status_code == 200
    assert "Roster Sampler" in resp.get_data(as_text=True)


def test_post_bad_link(monkeypatch):
    monkeypatch.setenv("SOURCE", "mock")
    app_module._provider = None
    resp = _client().post("/", data={"link": "garbage"})
    assert resp.status_code == 200
    assert "Not a Spotify link" in resp.get_data(as_text=True)
