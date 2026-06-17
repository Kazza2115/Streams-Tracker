import app as app_module


def _client():
    app_module.app.config.update(TESTING=True)
    return app_module.app.test_client()


def test_index_serves_city(monkeypatch):
    monkeypatch.setenv("SOURCE", "mock")
    app_module._provider = None
    r = _client().get("/")
    assert r.status_code == 200
    assert b'id="city"' in r.data           # the canvas the renderer draws into


def test_city_js_served():
    r = _client().get("/city.js")
    assert r.status_code == 200
    assert b"CanvasCity" in r.data


def test_api_mock_playlist(monkeypatch):
    monkeypatch.setenv("SOURCE", "mock")
    app_module._provider = None
    r = _client().get("/api/streams?link=spotify:playlist:abc")
    assert r.status_code == 200
    d = r.get_json()
    assert d["entity_type"] == "playlist"
    assert d["total_streams"] is not None
    assert d["tracks_missing"] == 1
    assert isinstance(d["tracks"], list) and d["tracks"][0]["name"]


def test_api_bad_link(monkeypatch):
    monkeypatch.setenv("SOURCE", "mock")
    app_module._provider = None
    r = _client().get("/api/streams?link=garbage")
    assert r.status_code == 400
    assert "error" in r.get_json()
