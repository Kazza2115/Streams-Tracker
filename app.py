"""Flask UI + JSON API: paste one Spotify link, get the consolidated play-count
total back, rendered as an isometric city.

The data source is chosen with the SOURCE env var (mock | spotify | songstats);
the app only ever talks to a StreamProvider. The browser never touches Spotify —
it calls our /api/streams endpoint, which runs the provider server-side.
"""
from __future__ import annotations

import os
from dataclasses import asdict

from flask import Flask, jsonify, render_template, request, send_from_directory

from parsing import ParseError, parse_spotify_input
from providers import get_provider

app = Flask(__name__)
_provider = None  # cached so the Spotify client/token is reused across requests


def current_provider():
    global _provider
    if _provider is None:
        _provider = get_provider()
    return _provider


@app.route("/")
def index():
    return render_template("index.html", source=(os.getenv("SOURCE") or "mock").lower())


@app.route("/city.js")
def city_js():
    # One canonical renderer, shared with the static GitHub Pages demo.
    return send_from_directory(os.path.join(app.root_path, "docs"), "city.js")


@app.route("/api/streams")
def api_streams():
    """Return a StreamResult as JSON for the given Spotify link, or an error.

    Never fabricates numbers: on failure it returns an `error` message and a
    non-200 status so the UI can say so.
    """
    raw = request.args.get("link", "")
    try:
        entity_type, entity_id = parse_spotify_input(raw)
    except ParseError as e:
        return jsonify(error=str(e)), 400
    try:
        result = current_provider().get_streams(entity_type, entity_id)
    except NotImplementedError as e:
        return jsonify(error=str(e)), 400
    except Exception as e:  # provider / network failure — surface, don't crash
        return jsonify(error=f"Could not fetch counts: {e}"), 502
    return jsonify(asdict(result))


if __name__ == "__main__":
    app.run(debug=True, port=5000)
