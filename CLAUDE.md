# CLAUDE.md — Stream Consolidator

## What this is
A tool for a music manager who works with several artists. Paste one Spotify link
(album / artist / playlist) into a single box and get the **consolidated play-count
total** back. The end goal is cross-platform stream consolidation for *any* artist —
not only ones whose Spotify-for-Artists dashboards we control — so we can analyze our
own roster and benchmark others.

## The constraint that shapes every decision
Stream counts are not freely available, and this is *the* reason the project is built
the way it is:
- **Spotify's official Web API never returns real counts** — only a 0–100 "popularity"
  score. The real per-track play counts exist only in the web player, served by
  Spotify's internal "pathfinder" GraphQL endpoint. We read that endpoint directly.
  It is undocumented and fragile.
- **Apple Music publishes no counts at all.** A genuine cross-platform total is
  therefore impossible by scraping; it needs a data aggregator (Songstats / Chartmetric).
- So the plan is phased: **phase 1 = Spotify only** (validate the product cheaply via
  the internal endpoint); **phase 2 = swap to an aggregator API** for real multi-platform
  numbers, once the manager likes the app.

## Architecture — do not break this
One interface, swappable data sources. The Flask app talks **only** to `StreamProvider`
and never knows which source is behind it. That is what makes the phased plan a one-line
change instead of a rewrite.
- `providers.py` — the `StreamProvider` interface, the `StreamResult`/`TrackCount`
  dataclasses, and `aggregate_tracks` (the shared, pure summing logic).
  Implementations: `MockProvider` (offline demo data), `SpotifyProvider` (real),
  `SongstatsProvider` (phase-2 stub).
- `spotify_client.py` — the **only** file that touches Spotify's internal endpoint. All
  volatile constants (token URL, pathfinder URL, persisted-query hashes) live at the top.
- `parsing.py` — Spotify URL/URI → `(entity_type, entity_id)`, network-free.
- `app.py` — Flask: serves the city UI and a `/api/streams` JSON endpoint (the
  browser calls the API; the provider runs server-side — a browser cannot reach
  Spotify). Source is chosen with the `SOURCE` env var (`mock` | `spotify` | `songstats`).
- `docs/` — static GitHub Pages demo (mock only) + `docs/city.js`, the isometric
  low-poly city renderer shared by the Flask app and the Pages demo.

Adding a data source = a new `StreamProvider` subclass that returns a `StreamResult`.
Keep `StreamResult`'s shape stable — the template depends on it (additive fields are OK).

## What "playlist total" means (phase-1 scope)
Spotify exposes **no** playlist-level stream counter. The obtainable number is the
**sum of each track's all-time play count**. Playlist items carry no count, so
`SpotifyProvider` fetches the playlist's tracks, then resolves counts by **fetching each
distinct album once** (`getAlbum` returns per-track `playcount`) — fewer calls on the
fragile endpoint, and album-sibling counts come for free. Tracks whose count can't be
resolved are excluded and the result is flagged `partial`.

## Current state
- **Works and tested** (offline, via `MockProvider` + a fake Spotify client): URL/URI
  parsing, the provider abstraction, playlist aggregation (incl. partial totals and
  album-dedupe orchestration), the Flask request flow, the `/api/streams` JSON
  endpoint, the city UI, and error handling. `pytest -q`.
- **End-to-end wired:** the isometric-city frontend fetches `/api/streams`, so
  running `SOURCE=spotify` with a valid `SP_DC` + hashes maps a real playlist.
  The visualization is offline-proven via mock; only the live Spotify fetch is
  unverified (next bullet).
- **Implemented but not verified against live Spotify:** `SpotifyProvider` playlist path
  and `spotify_client`. Spotify moved to **pathfinder v2** (HTTP POST, body carries
  `operationName`/`variables`/`sha256Hash`); the client now POSTs to v2 and supports an
  optional `client-token` header. Needs `SP_DC` + current hashes (`SP_HASH_FETCH_PLAYLIST`,
  `SP_HASH_GET_ALBUM`), possibly `SP_CLIENT_TOKEN` and `SP_OP_*` (op names), all overridable
  via env. Token exchange may now require a TOTP param. Response-shape parsing is best-effort
  and may need adjustment after a live capture.
- **Not done yet:** album & artist entities, and `SongstatsProvider` (phase-2 stub,
  raises `NotImplementedError`).

## Run / test
```bash
pip install -r requirements.txt
SOURCE=mock python app.py                       # offline demo, no network
SOURCE=spotify SP_DC="<sp_dc cookie>" \
  SP_HASH_FETCH_PLAYLIST="<hash>" SP_HASH_GET_ALBUM="<hash>" python app.py
pytest -q                                        # offline test suite
```
Test offline against `MockProvider`. Do not assume network access to Spotify (CI won't
have it, and the dev sandbox doesn't either).

## Guardrails
- **Never hardcode or commit** `SP_DC` or any API key. Read them from the environment only.
- The Spotify path is against Spotify's ToS and can break without warning. Treat failures
  as expected: surface clear, specific errors, never crash silently. If pathfinder calls
  start returning 400, the persisted-query hashes have rotated — update `QUERY_HASHES`.
- **Never fabricate or silently estimate** stream numbers. If a count isn't available,
  return `None` and say so in the UI. The whole point is trustworthy figures.
- Keep this file and `README.md` in sync when the architecture changes.
