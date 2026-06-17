"""Flask UI: one input box → consolidated stream total.

The data source is chosen with the SOURCE env var (mock | spotify | songstats);
the app only ever talks to a StreamProvider.
"""
from __future__ import annotations

from flask import Flask, render_template, request

from parsing import ParseError, parse_spotify_input
from providers import get_provider

app = Flask(__name__)
_provider = None  # cached so the spotify client/token is reused across requests


def current_provider():
    global _provider
    if _provider is None:
        _provider = get_provider()
    return _provider


@app.template_filter("grouped")
def grouped(value):
    """Format ints with thousands separators; pass anything else through."""
    return f"{value:,}" if isinstance(value, int) else value


@app.route("/", methods=["GET", "POST"])
def index():
    result = error = None
    raw = ""
    if request.method == "POST":
        raw = request.form.get("link", "")
        try:
            entity_type, entity_id = parse_spotify_input(raw)
            result = current_provider().get_streams(entity_type, entity_id)
        except ParseError as e:
            error = str(e)
        except NotImplementedError as e:
            error = str(e)
        except Exception as e:  # provider/network failure — surface, don't crash
            error = f"Could not fetch counts: {e}"
    return render_template("index.html", result=result, error=error, raw=raw)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
