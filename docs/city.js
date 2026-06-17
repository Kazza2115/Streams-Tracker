/* Stream Consolidator — retro pixel-city demo (static, mock data).
 * Each track -> a building (height scales with play count).
 * Each distinct artist -> a little walking pixel character.
 * Mirrors parsing.py / providers.py logic, client-side only. */

// ============================================================ ported logic
const VALID_TYPES = new Set(["playlist", "album", "artist", "track"]);
const cleanId = v => v.split("?")[0].split("#")[0];

function parseSpotifyInput(raw) {
  if (!raw || !raw.trim()) throw new Error("Empty input — paste a Spotify link or URI.");
  let text = raw.trim();
  if (text.startsWith("spotify:")) {
    const p = text.split(":");
    if (p.length >= 3 && VALID_TYPES.has(p[1]) && p[2]) return { type: p[1], id: cleanId(p[2]) };
    throw new Error("Unrecognized Spotify URI: " + raw);
  }
  if (text.includes("open.spotify.com")) {
    if (!text.includes("://")) text = "https://" + text;
    let path;
    try { path = new URL(text).pathname; } catch (e) { throw new Error("Unrecognized Spotify URL: " + raw); }
    let seg = path.split("/").filter(Boolean);
    if (seg.length && seg[0].startsWith("intl-")) seg = seg.slice(1);
    if (seg.length >= 2 && VALID_TYPES.has(seg[0]) && seg[1]) return { type: seg[0], id: cleanId(seg[1]) };
    throw new Error("Unrecognized Spotify URL: " + raw);
  }
  throw new Error("Not a Spotify link or URI. Expected https://open.spotify.com/playlist/… or spotify:playlist:…");
}

// Same sample playlist as providers.MockProvider (kept in sync).
const MOCK_TRACKS = [
  { name: "One Dance", artists: "Drake", play_count: 2950000000 },
  { name: "The Less I Know the Better", artists: "Tame Impala", play_count: 2100000000 },
  { name: "Midnight City", artists: "M83", play_count: 612004511 },
  { name: "Outro", artists: "M83", play_count: 158223004 },
  { name: "Reckoner", artists: "Radiohead", play_count: 142991233 },
  { name: "Nude", artists: "Radiohead", play_count: 121044872 },
  { name: "Local Demo Take", artists: "Unknown", play_count: null },
];

function aggregate(name, type, source, tracks) {
  const counted = tracks.filter(t => t.play_count != null);
  const missing = tracks.filter(t => t.play_count == null);
  const total = counted.length ? counted.reduce((s, t) => s + t.play_count, 0) : null;
  const notes = [];
  if (missing.length) notes.push(`${missing.length} of ${tracks.length} track(s) had no available count and are excluded from the total.`);
  return {
    entity_name: name, entity_type: type, source, total_streams: total, tracks,
    tracks_counted: counted.length, tracks_missing: missing.length,
    partial: missing.length > 0, notes,
  };
}

function getStreams(type, id) {
  if (type === "playlist") return aggregate("Roster Sampler (demo)", "playlist", "mock", MOCK_TRACKS.slice());
  throw new Error(`Demo only serves playlists in phase 1 (got ${type}).`);
}

// ============================================================ helpers
const fmt = n => Number(n).toLocaleString("en-US");
function short(n) {
  if (n == null) return "n/a";
  if (n >= 1e9) return +(n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return +(n / 1e3).toFixed(0) + "K";
  return "" + n;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// retro palettes
const BODY_COLORS = ["#3b4a6b", "#5b3a64", "#6b4a3b", "#356b5a", "#574b6b", "#6b5b3b", "#4b5b6b"];
const SHIRT_COLORS = ["#e85d75", "#f4a259", "#4ea1d3", "#7bc96f", "#c879e8", "#f6c945", "#ff8fb1", "#5ad1c7"];
const WIN_ON = "#ffd86b", WIN_OFF = "#241f33";

// ============================================================ the city
class CanvasCity {
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tip = tip;
    this.result = null;
    this.buildings = [];
    this.walkers = [];
    this.ambient = [];
    this.t0 = 0;
    this.last = performance.now();
    this.hover = null;

    this.resize();
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener("mousemove", e => this.onMove(e));
    canvas.addEventListener("mouseleave", () => { this.hover = null; this.tip.style.display = "none"; });

    // a few grey townsfolk so the town feels alive before any search
    this.ambient = [0, 1, 2].map(i => this._mkWalker("", "#8a8aa0", i * 90));

    requestAnimationFrame(t => this.loop(t));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = this.canvas.clientWidth;
    this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.groundY = this.H - 58;     // buildings sit here; street is below
    if (this.result) this.layout();
  }

  _mkWalker(name, color, phase) {
    return {
      name, color,
      x: Math.random() * (this.W || 600),
      dir: Math.random() < 0.5 ? -1 : 1,
      speed: 16 + Math.random() * 16,
      phase: phase || Math.random() * 1000,
    };
  }

  populate(result) {
    this.result = result;
    this.t0 = performance.now();
    // one walker per distinct artist
    const seen = new Set();
    this.walkers = [];
    for (const t of result.tracks) {
      const a = t.artists || "Unknown";
      if (seen.has(a)) continue;
      seen.add(a);
      this.walkers.push(this._mkWalker(a, SHIRT_COLORS[hashStr(a) % SHIRT_COLORS.length], 0));
    }
    this.layout();
  }

  layout() {
    const minH = 34, maxH = this.groundY - 22;
    const counted = this.result.tracks.filter(t => t.play_count != null).map(t => t.play_count);
    const maxC = counted.length ? Math.max(...counted) : 1;

    const n = this.result.tracks.length;
    const margin = 14, gap = 8;
    const bw = Math.max(20, Math.min(86, (this.W - 2 * margin - gap * (n - 1)) / n));
    const totalW = bw * n + gap * (n - 1);
    let x = Math.max(margin, (this.W - totalW) / 2);

    this.buildings = this.result.tracks.map((t, i) => {
      const ruin = t.play_count == null;
      const targetH = ruin ? 28 : minH + (maxH - minH) * Math.pow(t.play_count / maxC, 0.62);
      const cols = Math.max(1, Math.floor((bw - 8) / 9));
      const rows = Math.max(1, Math.floor((targetH - 12) / 12));
      const lit = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) lit.push(hashStr(t.name + ":" + c + "x" + r) % 5 !== 0);
      const b = {
        track: t, x, w: bw, targetH, ruin, cols, rows, lit,
        color: BODY_COLORS[hashStr(t.name) % BODY_COLORS.length],
        isTallest: !ruin && t.play_count === maxC,
        start: i * 70,
      };
      x += bw + gap;
      return b;
    });
  }

  onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    this.hover = null;
    for (const b of this.buildings) {
      const h = b._h || 0;
      if (mx >= b.x && mx <= b.x + b.w && my <= this.groundY && my >= this.groundY - h) { this.hover = b; break; }
    }
    if (this.hover) {
      const t = this.hover.track;
      this.tip.innerHTML = `<strong>${esc(t.name)}</strong><br>${esc(t.artists)}<br>` +
        (t.play_count != null ? `${fmt(t.play_count)} streams` : `<span style="color:#ff8a8a">no count available</span>`);
      this.tip.style.display = "block";
      this.tip.style.left = (e.clientX + 14) + "px";
      this.tip.style.top = (e.clientY + 14) + "px";
    } else {
      this.tip.style.display = "none";
    }
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.draw(now, dt);
    requestAnimationFrame(t => this.loop(t));
  }

  // ---------- drawing ----------
  draw(now, dt) {
    const ctx = this.ctx, W = this.W, H = this.H;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, this.groundY);
    sky.addColorStop(0, "#16123a");
    sky.addColorStop(0.55, "#4a2a6b");
    sky.addColorStop(1, "#ff7e5f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, this.groundY);
    // stars
    ctx.fillStyle = "rgba(255,255,255,.7)";
    for (let i = 0; i < 40; i++) {
      const sx = (i * 97) % W, sy = (i * 53) % (this.groundY * 0.5);
      if ((Math.floor(now / 600) + i) % 5 !== 0) ctx.fillRect(sx, sy, 2, 2);
    }
    // sun
    const sunY = this.groundY - 46, sunX = W * 0.78;
    const g = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, 60);
    g.addColorStop(0, "#ffe39a"); g.addColorStop(1, "rgba(255,126,95,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sunX, sunY, 60, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffd06b"; ctx.beginPath(); ctx.arc(sunX, sunY, 30, 0, 7); ctx.fill();
    ctx.fillStyle = sky; // retro sun stripes (cut lines)
    for (let i = 0; i < 4; i++) ctx.fillRect(sunX - 32, sunY + 6 + i * 7, 64, 3);

    // distant silhouette skyline (parallax depth)
    ctx.fillStyle = "rgba(20,12,40,.55)";
    for (let i = 0; i < Math.ceil(W / 46) + 1; i++) {
      const bh = 30 + ((i * 137) % 60);
      ctx.fillRect(i * 46 - 10, this.groundY - bh, 38, bh);
    }

    // ground / street
    ctx.fillStyle = "#241f33"; ctx.fillRect(0, this.groundY, W, H - this.groundY);
    ctx.fillStyle = "#15111f"; ctx.fillRect(0, this.groundY, W, 4);
    ctx.fillStyle = "#3a3550"; // dashed road line
    for (let x = 0; x < W; x += 26) ctx.fillRect(x, this.groundY + (H - this.groundY) / 2, 14, 2);

    // buildings
    for (const b of this.buildings) {
      const p = Math.max(0, Math.min(1, (now - this.t0 - b.start) / 700));
      const ease = 1 - Math.pow(1 - p, 3);
      const h = b.targetH * ease;
      b._h = h;
      const topY = this.groundY - h;
      // body
      ctx.fillStyle = b.ruin ? "#39323f" : b.color;
      ctx.fillRect(Math.round(b.x), Math.round(topY), Math.round(b.w), Math.round(h));
      // outline
      ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(Math.round(b.x), Math.round(topY), 2, Math.round(h));
      if (this.hover === b) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(b.x + 1, topY + 1, b.w - 2, h - 2); }
      if (b.ruin) {
        // construction stripes for the "no count" building
        ctx.fillStyle = "#f6c945";
        for (let s = 0; s < h; s += 10) ctx.fillRect(b.x + 2, topY + s, b.w - 4, 3);
        ctx.fillStyle = "#241f33"; ctx.font = "bold 12px monospace"; ctx.textAlign = "center";
        ctx.fillText("?", b.x + b.w / 2, topY + h - 6);
      } else {
        // windows grid
        const padX = (b.w - b.cols * 9) / 2;
        for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) {
          const idx = r * b.cols + c;
          const on = b.lit[idx] && (idx % 11 !== Math.floor(now / 900) % 11); // occasional flicker
          ctx.fillStyle = on ? WIN_ON : WIN_OFF;
          ctx.fillRect(Math.round(b.x + padX + c * 9 + 2), Math.round(topY + 8 + r * 12), 5, 7);
        }
      }
      // antenna + blink for the tallest
      if (b.isTallest && h > b.targetH - 2) {
        const cx = Math.round(b.x + b.w / 2);
        ctx.fillStyle = "#9aa"; ctx.fillRect(cx, topY - 12, 2, 12);
        ctx.fillStyle = (Math.floor(now / 500) % 2) ? "#ff4d4d" : "#5a1f1f";
        ctx.fillRect(cx - 1, topY - 14, 4, 4);
      }
      // short stream label above building
      if (p > 0.85) {
        ctx.fillStyle = "#fff8e0"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
        ctx.fillText(short(b.track.play_count), b.x + b.w / 2, topY - (b.isTallest ? 18 : 4));
      }
    }

    // walkers (ambient first, then artists in front)
    for (const w of this.ambient) this._drawWalker(ctx, w, now, dt, false);
    for (const w of this.walkers) this._drawWalker(ctx, w, now, dt, true);

    // empty-state prompt
    if (!this.result) {
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.font = "bold 14px monospace"; ctx.textAlign = "center";
      ctx.fillText("Paste a playlist link to populate the city ↑", W / 2, this.groundY - 30);
    }
  }

  _drawWalker(ctx, w, now, dt, labelled) {
    w.x += w.dir * w.speed * dt;
    if (w.x < -16) w.x = this.W + 16;
    if (w.x > this.W + 16) w.x = -16;
    const s = 3;
    const feetY = this.H - 12;
    const top = feetY - 12 * s;
    const bob = Math.sin(now / 200 + w.phase) * 1.5;
    const x = Math.round(w.x), y = Math.round(top + bob);
    const frame = Math.floor(now / 170 + w.phase) % 2;
    // legs (pants)
    ctx.fillStyle = "#2c2f48";
    if (frame === 0) { ctx.fillRect(x + 1 * s, y + 9 * s, 1.6 * s, 3 * s); ctx.fillRect(x + 3.4 * s, y + 9 * s, 1.6 * s, 3 * s); }
    else { ctx.fillRect(x + 0.5 * s, y + 9 * s, 1.6 * s, 3 * s); ctx.fillRect(x + 3.9 * s, y + 9 * s, 1.6 * s, 3 * s); }
    // body (shirt) + arms
    ctx.fillStyle = w.color;
    ctx.fillRect(x + 1 * s, y + 4 * s, 4 * s, 5 * s);
    ctx.fillRect(x + 0 * s, y + 4 * s, 1 * s, 4 * s);
    ctx.fillRect(x + 5 * s, y + 4 * s, 1 * s, 4 * s);
    // head + hair
    ctx.fillStyle = "#f1c27d"; ctx.fillRect(x + 1 * s, y, 4 * s, 4 * s);
    ctx.fillStyle = "#3a2a1a"; ctx.fillRect(x + 1 * s, y, 4 * s, 1 * s);
    // name label
    if (labelled && w.name) {
      ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
      const tw = ctx.measureText(w.name).width;
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(x + 3 * s - tw / 2 - 3, y - 16, tw + 6, 13);
      ctx.fillStyle = "#fff"; ctx.fillText(w.name, x + 3 * s, y - 6);
    }
  }
}

// ============================================================ wiring
document.addEventListener("DOMContentLoaded", () => {
  const city = new CanvasCity(document.getElementById("city"), document.getElementById("tip"));
  const input = document.getElementById("link");
  const out = document.getElementById("out");

  function run() {
    try {
      const { type, id } = parseSpotifyInput(input.value);
      const result = getStreams(type, id);
      city.populate(result);
      renderPanel(result, out);
    } catch (err) {
      city.result = null; city.buildings = []; city.walkers = [];
      out.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  }

  document.getElementById("form").addEventListener("submit", e => { e.preventDefault(); run(); });
  document.querySelectorAll("[data-fill]").forEach(a =>
    a.addEventListener("click", e => { e.preventDefault(); input.value = a.getAttribute("data-fill"); run(); }));
});

function renderPanel(r, out) {
  const rows = r.tracks
    .slice()
    .sort((a, b) => (b.play_count || -1) - (a.play_count || -1))
    .map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.artists)}</td>
       <td class="num">${t.play_count != null ? fmt(t.play_count) : '<span class="na">n/a</span>'}</td></tr>`).join("");
  out.innerHTML = `
    <div class="scoreboard">
      <div class="sb-label">TOTAL STREAMS</div>
      <div class="sb-total">${r.total_streams != null ? fmt(r.total_streams) : "—"}</div>
      <div class="sb-sub">${r.tracks_counted} counted${r.tracks_missing ? " · " + r.tracks_missing + " n/a" : ""} · source: ${esc(r.source)}</div>
    </div>
    ${r.notes.map(n => `<div class="note">${esc(n)}</div>`).join("")}
    <p class="muted">Combined all-time play count of the tracks — not the streams generated by the playlist itself.</p>
    <details><summary>Show track table</summary>
      <table><thead><tr><th>Track</th><th>Artist</th><th class="num">Plays</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`;
}
