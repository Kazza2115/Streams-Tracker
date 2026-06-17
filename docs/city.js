/* Stream Consolidator — retro ISOMETRIC pixel-city demo (static, mock data).
 * Each track -> an extruded building on its own block (height = play count).
 * Roads run between the blocks; each distinct artist -> a citizen walking them.
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

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

const BODY_COLORS = ["#5566a0", "#8a5a9e", "#a06a52", "#3f9e86", "#7d6fae", "#a08a4a", "#5f86b0"];
const SHIRT_COLORS = ["#e85d75", "#f4a259", "#4ea1d3", "#7bc96f", "#c879e8", "#f6c945", "#ff8fb1", "#5ad1c7"];
const WIN_ON = "#ffd86b";
const PITCH = 2;              // tile units between adjacent building centers (1 building + 1 road)

// ============================================================ the isometric city
class CanvasCity {
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tip = tip;
    this.result = null;
    this.buildings = [];
    this.walkers = [];
    this.ambient = [];
    this.nodes = [];
    this.cols = 3; this.rows = 3;
    this.gMin = -1.6; this.gMaxX = 4.4; this.gMaxY = 4.4;
    this.TW = 32; this.TH = 16; this.scale = 1; this.maxH = 120;
    this.originX = 0; this.originY = 0;
    this.camDX = 0; this.camTargetDX = 0;
    this.t0 = 0;
    this.last = performance.now();
    this.hover = null;

    this.resize();
    this.ambient = [0, 1, 2, 3].map(() => this._mkWalker("", "#8f8fae"));
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener("mousemove", e => this.onMove(e));
    canvas.addEventListener("mouseleave", () => { this.hover = null; this.camTargetDX = 0; this.tip.style.display = "none"; });
    requestAnimationFrame(t => this.loop(t));
  }

  iso(gx, gy) { return { x: this.originX + (gx - gy) * this.TW + this.camDX, y: this.originY + (gx + gy) * this.TH }; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = this.canvas.clientWidth;
    this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    if (this.result) this.layout(); else this.emptyLayout();
    this._rebindWalkers();
  }

  _setBounds(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.gMin = -1.6;
    this.gMaxX = (cols - 1) * PITCH + 1.6;
    this.gMaxY = (rows - 1) * PITCH + 1.6;
    this._buildNodes();
  }

  _buildNodes() {
    this.nodes = [];
    for (let iy = 0; iy <= this.rows; iy++)
      for (let ix = 0; ix <= this.cols; ix++)
        this.nodes.push({ gx: ix * PITCH - 1, gy: iy * PITCH - 1 }); // road centers at odd tiles
  }
  _neighbors(i) {
    const nC = this.cols + 1, ix = i % nC, iy = (i / nC) | 0, out = [];
    if (ix > 0) out.push(i - 1); if (ix < this.cols) out.push(i + 1);
    if (iy > 0) out.push(i - nC); if (iy < this.rows) out.push(i + nC);
    return out;
  }
  _randNeighbor(i) { const nb = this._neighbors(i); return nb.length ? nb[(Math.random() * nb.length) | 0] : i; }

  fit(maxTargetH) {
    const TW0 = 32, TH0 = 16;
    const span = this.gMaxX + this.gMaxY - 2 * this.gMin;
    this.scale = Math.max(0.3, Math.min(1.2, Math.min(this.W * 0.95 / (span * TW0), this.H * 0.95 / (span * TH0 + maxTargetH))));
    this.TW = TW0 * this.scale; this.TH = TH0 * this.scale; this.maxH = maxTargetH * this.scale;
  }

  _camera(buildings) {
    const contentLeft = (this.gMin - this.gMaxY) * this.TW, contentW = (this.gMaxX + this.gMaxY - 2 * this.gMin) * this.TW;
    this.originX = (this.W - contentW) / 2 - contentLeft;
    let top = 2 * this.gMin * this.TH;
    for (const b of buildings) { const ty = (b.gx + b.gy) * this.TH - b.targetH; if (ty < top) top = ty; }
    const bottom = (this.gMaxX + this.gMaxY) * this.TH + 14 * this.scale;
    this.originY = (this.H - (bottom - top)) / 2 - top;
  }

  emptyLayout() { this._setBounds(3, 3); this.fit(70); this.buildings = []; this._camera([]); }

  layout() {
    const n = this.result.tracks.length;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    this._setBounds(cols, rows);
    this.fit(190);
    const minHpx = 20 * this.scale, maxHpx = this.maxH;
    const counted = this.result.tracks.filter(t => t.play_count != null).map(t => t.play_count);
    const maxC = counted.length ? Math.max(...counted) : 1;
    this.buildings = this.result.tracks.map((t, i) => {
      const gx = (i % cols) * PITCH, gy = ((i / cols) | 0) * PITCH;
      const ruin = t.play_count == null;
      const targetH = ruin ? 24 * this.scale : minHpx + (maxHpx - minHpx) * Math.pow(t.play_count / maxC, 0.62);
      return { track: t, gx, gy, targetH, ruin, isTallest: !ruin && t.play_count === maxC, start: i * 80, _poly: null };
    }).sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
    this._camera(this.buildings);
  }

  _mkWalker(name, color) {
    const from = (Math.random() * this.nodes.length) | 0;
    return { name, color, from, to: this._randNeighbor(from), t: 0, speed: 0.32 + Math.random() * 0.4, lane: (Math.random() < 0.5 ? 1 : -1) * 0.16, phase: Math.random() * 1000, _gx: 0, _gy: 0 };
  }
  _rebindWalkers() {
    for (const w of [...this.ambient, ...this.walkers]) {
      if (w.from >= this.nodes.length) w.from = (Math.random() * this.nodes.length) | 0;
      if (!this._neighbors(w.from).includes(w.to)) { w.to = this._randNeighbor(w.from); w.t = 0; }
    }
  }

  populate(result) {
    this.result = result;
    this.t0 = performance.now();
    this.layout();
    const seen = new Set();
    this.walkers = [];
    for (const t of result.tracks) {
      const a = t.artists || "Unknown";
      if (seen.has(a)) continue;
      seen.add(a);
      this.walkers.push(this._mkWalker(a, SHIRT_COLORS[hashStr(a) % SHIRT_COLORS.length]));
    }
  }

  onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    this.camTargetDX = (mx / this.W - 0.5) * 18 * this.scale;
    this.hover = null;
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      if (b._poly && pointInPoly(mx, my, b._poly)) { this.hover = b; break; }
    }
    if (this.hover) {
      const t = this.hover.track;
      this.tip.innerHTML = `<strong>${esc(t.name)}</strong><br>${esc(t.artists)}<br>` +
        (t.play_count != null ? `${fmt(t.play_count)} streams` : `<span style="color:#ff8a8a">no count available</span>`);
      this.tip.style.display = "block";
      this.tip.style.left = (e.clientX + 14) + "px";
      this.tip.style.top = (e.clientY + 14) + "px";
    } else { this.tip.style.display = "none"; }
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.camDX += (this.camTargetDX - this.camDX) * Math.min(1, dt * 6);
    this.draw(now, dt);
    requestAnimationFrame(t => this.loop(t));
  }

  // ---------- low-level ----------
  _quad(p, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath(); ctx.fill();
  }
  _face(A, B, h, color) { this._quad([A, B, { x: B.x, y: B.y - h }, { x: A.x, y: A.y - h }], color); }
  _faceWindows(A, B, h, key, now, color) {
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const cols = Math.max(1, Math.min(5, Math.floor(len / (11 * this.scale))));
    const rows = Math.max(1, Math.min(12, Math.floor(h / (13 * this.scale))));
    const pt = (fu, fv) => ({ x: A.x + (B.x - A.x) * fu, y: A.y + (B.y - A.y) * fu - h * fv });
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const on = hashStr(key + c + "x" + r) % 5 !== 0 && ((r * cols + c) % 13 !== Math.floor(now / 950) % 13);
      const fu0 = (c + 0.22) / cols, fu1 = (c + 0.78) / cols, fv0 = (r + 0.18) / rows, fv1 = (r + 0.72) / rows;
      this._quad([pt(fu0, fv0), pt(fu1, fv0), pt(fu1, fv1), pt(fu0, fv1)], on ? color : "rgba(20,16,32,.55)");
    }
  }
  _strip(ax, ay, bx, by, hw, color) {
    const p = ax === bx
      ? [this.iso(ax - hw, ay), this.iso(ax + hw, ay), this.iso(bx + hw, by), this.iso(bx - hw, by)]
      : [this.iso(ax, ay - hw), this.iso(bx, by - hw), this.iso(bx, by + hw), this.iso(ax, ay + hw)];
    this._quad(p, color);
  }

  // ---------- drawing ----------
  draw(now, dt) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#16123a"); sky.addColorStop(0.5, "#4a2a6b"); sky.addColorStop(1, "#ff7e5f");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.7)";
    for (let i = 0; i < 46; i++) { const sx = (i * 97) % W, sy = (i * 53) % (H * 0.42); if ((Math.floor(now / 600) + i) % 5 !== 0) ctx.fillRect(sx, sy, 2, 2); }
    const sunX = W * 0.82, sunY = H * 0.22;
    const gg = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, 64);
    gg.addColorStop(0, "#ffe39a"); gg.addColorStop(1, "rgba(255,126,95,0)");
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(sunX, sunY, 64, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffd06b"; ctx.beginPath(); ctx.arc(sunX, sunY, 28, 0, 7); ctx.fill();

    this._drawGround();

    // update walkers, then z-sort everything by depth (gx+gy) for correct occlusion
    for (const w of this.ambient) this._stepWalker(w, dt);
    for (const w of this.walkers) this._stepWalker(w, dt);
    const items = [];
    for (const b of this.buildings) items.push({ d: b.gx + b.gy + 0.001, kind: "b", ref: b });
    for (const w of this.ambient) items.push({ d: w._gx + w._gy, kind: "w", ref: w, lbl: false });
    for (const w of this.walkers) items.push({ d: w._gx + w._gy, kind: "w", ref: w, lbl: true });
    items.sort((a, b) => a.d - b.d);
    for (const it of items) it.kind === "b" ? this._drawBuilding(it.ref, now) : this._drawWalker(it.ref, now, it.lbl);

    if (!this.result) {
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.font = "bold 14px monospace"; ctx.textAlign = "center";
      ctx.fillText("Paste a playlist link to build the city ↑", W / 2, this.originY);
    }
  }

  _drawGround() {
    const N = this.iso(this.gMin, this.gMin), E = this.iso(this.gMaxX, this.gMin), S = this.iso(this.gMaxX, this.gMaxY), Wp = this.iso(this.gMin, this.gMaxY);
    const dz = 14 * this.scale;
    this._quad([Wp, S, { x: S.x, y: S.y + dz }, { x: Wp.x, y: Wp.y + dz }], "#15111f");
    this._quad([S, E, { x: E.x, y: E.y + dz }, { x: S.x, y: S.y + dz }], "#0d0a15");
    this._quad([N, E, S, Wp], "#2b2840");                       // base pavement
    for (const b of this.buildings) {                          // lighter lot under each building
      const o = 0.7;
      this._quad([this.iso(b.gx - o, b.gy - o), this.iso(b.gx + o, b.gy - o), this.iso(b.gx + o, b.gy + o), this.iso(b.gx - o, b.gy + o)], "#34304d");
    }
    // roads along the gaps (odd tile lines), then dashed center lines
    for (let ix = 0; ix <= this.cols; ix++) this._strip(ix * PITCH - 1, this.gMin, ix * PITCH - 1, this.gMaxY, 0.45, "#171426");
    for (let iy = 0; iy <= this.rows; iy++) this._strip(this.gMin, iy * PITCH - 1, this.gMaxX, iy * PITCH - 1, 0.45, "#171426");
    for (let ix = 0; ix <= this.cols; ix++) for (let gy = this.gMin + 0.25; gy < this.gMaxY - 0.3; gy += 0.95)
      this._strip(ix * PITCH - 1, gy, ix * PITCH - 1, gy + 0.36, 0.05, "#e8c24a");
    for (let iy = 0; iy <= this.rows; iy++) for (let gx = this.gMin + 0.25; gx < this.gMaxX - 0.3; gx += 0.95)
      this._strip(gx, iy * PITCH - 1, gx + 0.36, iy * PITCH - 1, 0.05, "#e8c24a");
  }

  _drawBuilding(b, now) {
    const ctx = this.ctx;
    const p = Math.max(0, Math.min(1, (now - this.t0 - b.start) / 750));
    const h = b.targetH * (1 - Math.pow(1 - p, 3));
    const C = this.iso(b.gx, b.gy), hw = 0.84 * this.TW, hh = 0.84 * this.TH;
    const N = { x: C.x, y: C.y - hh }, S = { x: C.x, y: C.y + hh }, E = { x: C.x + hw, y: C.y }, Wp = { x: C.x - hw, y: C.y };
    b._poly = [E, S, Wp, { x: Wp.x, y: Wp.y - h }, { x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }];
    const col = BODY_COLORS[hashStr(b.track.name) % BODY_COLORS.length];

    if (b.ruin) {
      this._face(E, S, h, "#39323f"); this._face(S, Wp, h, "#2c2735");
      this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: S.x, y: S.y - h }, { x: Wp.x, y: Wp.y - h }], "#4a4358");
      this._faceWindows(E, S, h, "ruinR" + b.gx, now, "#f6c945");
      this._faceWindows(S, Wp, h, "ruinL" + b.gy, now, "#c8a23a");
    } else {
      this._face(E, S, h, shade(col, 0.95));
      this._face(S, Wp, h, shade(col, 0.66));
      this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: S.x, y: S.y - h }, { x: Wp.x, y: Wp.y - h }], shade(col, 1.35));
      this._faceWindows(E, S, h, b.track.name + "R", now, WIN_ON);
      this._faceWindows(S, Wp, h, b.track.name + "L", now, "#e9c45f");
    }

    if (this.hover === b) {
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); b._poly.forEach((pt, i) => i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)); ctx.closePath(); ctx.stroke();
    }
    if (b.isTallest && p > 0.9) {
      ctx.fillStyle = "#9aa"; ctx.fillRect(C.x - 1, C.y - h - 14 * this.scale, 2, 14 * this.scale);
      ctx.fillStyle = (Math.floor(now / 500) % 2) ? "#ff4d4d" : "#5a1f1f"; ctx.fillRect(C.x - 2, C.y - h - 16 * this.scale, 4, 4);
    }
    if (p > 0.85) {
      ctx.fillStyle = "#fff8e0"; ctx.font = `bold ${Math.round(10 * Math.max(0.8, this.scale))}px monospace`; ctx.textAlign = "center";
      ctx.fillText(short(b.track.play_count), C.x, N.y - h - 6);
    }
  }

  _stepWalker(w, dt) {
    w.t += w.speed * dt;
    while (w.t >= 1) {
      w.t -= 1; const prev = w.from; w.from = w.to;
      let nb = this._neighbors(w.from).filter(n => n !== prev);
      if (!nb.length) nb = this._neighbors(w.from);
      w.to = nb[(Math.random() * nb.length) | 0];
    }
    const a = this.nodes[w.from], b = this.nodes[w.to];
    if (!a || !b) { w._gx = 0; w._gy = 0; return; }
    let gx = a.gx + (b.gx - a.gx) * w.t, gy = a.gy + (b.gy - a.gy) * w.t;
    if (a.gx === b.gx) gx += w.lane; else gy += w.lane;   // keep to one side of the road
    w._gx = gx; w._gy = gy;
  }

  _drawWalker(w, now, labelled) {
    const ctx = this.ctx, g = this.iso(w._gx, w._gy);
    const s = Math.max(2, Math.round(3 * this.scale));
    const bob = Math.sin(now / 200 + w.phase) * 1.5;
    const x = Math.round(g.x - 3 * s), y = Math.round(g.y - 12 * s + bob);
    const frame = Math.floor(now / 170 + w.phase) % 2;
    ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.beginPath(); ctx.ellipse(g.x, g.y + 1, 3.2 * s, 1.3 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "#2c2f48";
    if (frame === 0) { ctx.fillRect(x + 1 * s, y + 9 * s, 1.6 * s, 3 * s); ctx.fillRect(x + 3.4 * s, y + 9 * s, 1.6 * s, 3 * s); }
    else { ctx.fillRect(x + 0.5 * s, y + 9 * s, 1.6 * s, 3 * s); ctx.fillRect(x + 3.9 * s, y + 9 * s, 1.6 * s, 3 * s); }
    ctx.fillStyle = w.color;
    ctx.fillRect(x + 1 * s, y + 4 * s, 4 * s, 5 * s); ctx.fillRect(x, y + 4 * s, 1 * s, 4 * s); ctx.fillRect(x + 5 * s, y + 4 * s, 1 * s, 4 * s);
    ctx.fillStyle = "#f1c27d"; ctx.fillRect(x + 1 * s, y, 4 * s, 4 * s);
    ctx.fillStyle = "#3a2a1a"; ctx.fillRect(x + 1 * s, y, 4 * s, 1 * s);
    if (labelled && w.name) {
      ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
      const tw = ctx.measureText(w.name).width;
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(g.x - tw / 2 - 3, y - 16, tw + 6, 13);
      ctx.fillStyle = "#fff"; ctx.fillText(w.name, g.x, y - 6);
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
