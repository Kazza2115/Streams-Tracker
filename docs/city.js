/* Stream Consolidator — isometric LOW-POLY city demo (static, mock data).
 * Tracks are buildings; artists are grouped into DISTRICTS (an artist with
 * more than 4 tracks gets a themed neighbourhood, the rest share "Downtown").
 * Each district has a deterministic theme (palette + roof style) derived from
 * the artist name. Mirrors parsing.py / providers.py logic, client-side only. */

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

const MOCK_TRACKS = [
  { name: "One Dance", artists: "Drake", play_count: 2950000000 },
  { name: "God's Plan", artists: "Drake", play_count: 2300000000 },
  { name: "Hotline Bling", artists: "Drake", play_count: 1600000000 },
  { name: "Passionfruit", artists: "Drake", play_count: 1150000000 },
  { name: "Nice For What", artists: "Drake", play_count: 1050000000 },
  { name: "Started From the Bottom", artists: "Drake", play_count: 720000000 },
  { name: "Creep", artists: "Radiohead", play_count: 1250000000 },
  { name: "Karma Police", artists: "Radiohead", play_count: 920000000 },
  { name: "No Surprises", artists: "Radiohead", play_count: 880000000 },
  { name: "Reckoner", artists: "Radiohead", play_count: 142991233 },
  { name: "Nude", artists: "Radiohead", play_count: 121044872 },
  { name: "The Less I Know the Better", artists: "Tame Impala", play_count: 2100000000 },
  { name: "Midnight City", artists: "M83", play_count: 612004511 },
  { name: "Local Demo Take", artists: "Unknown", play_count: null },
];

function aggregate(name, type, source, tracks) {
  const counted = tracks.filter(t => t.play_count != null);
  const missing = tracks.filter(t => t.play_count == null);
  const total = counted.length ? counted.reduce((s, t) => s + t.play_count, 0) : null;
  const notes = [];
  if (missing.length) notes.push(`${missing.length} of ${tracks.length} track(s) had no available count and are excluded from the total.`);
  return { entity_name: name, entity_type: type, source, total_streams: total, tracks,
    tracks_counted: counted.length, tracks_missing: missing.length, partial: missing.length > 0, notes };
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
const rand01 = k => (hashStr(k) % 1000) / 1000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const HSL = (h, s, l) => `hsl(${((h % 360) + 360) % 360},${clamp(s, 0, 100)}%,${clamp(l, 0, 100)}%)`;
const colHSL = (c, dl = 0, ds = 0) => HSL(c[0], c[1] + ds, c[2] + dl);     // c = [h,s,l]
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.min(255, ((n >> 16) & 255) * f | 0)},${Math.min(255, ((n >> 8) & 255) * f | 0)},${Math.min(255, (n & 255) * f | 0)})`;
}
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

const CAR_COLORS = ["#e35d5d", "#5aa7e0", "#f3c64b", "#74c98a", "#d98ad0", "#f2f2f2", "#7d8bd6"];
const BP = 1.5, AV = 2.0, ZPAD = 0.7, DISTRICT_MIN = 5;

// deterministic theme per artist: palette + roof style
function themeFor(artist, named) {
  if (!named) return { lot: [220, 12, 30], side: [220, 8, 50], accent: [45, 85, 60], style: -1,
    colors: [[220, 14, 62], [212, 16, 54], [228, 12, 68], [206, 10, 60]] };
  const h = hashStr(artist) % 360;
  return {
    lot: [h, 28, 30], side: [h, 16, 50], accent: [(h + 180) % 360, 72, 62], style: hashStr(artist + "s") % 4,
    colors: [[h, 42, 60], [(h + 24) % 360, 40, 52], [(h + 336) % 360, 38, 66], [h, 30, 70]],
  };
}

// ============================================================ the city
class CanvasCity {
  constructor(canvas, tip) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.tip = tip;
    this.result = null;
    this.districts = []; this.buildings = []; this.trees = []; this.cars = []; this.walkers = []; this.signs = [];
    this.gMinX = -2; this.gMaxX = 6; this.gMinY = -2; this.gMaxY = 6;
    this.TW = 32; this.TH = 16; this.scale = 1; this.maxH = 120;
    this.originX = 0; this.originY = 0; this.camDX = 0; this.camTargetDX = 0;
    this.t0 = 0; this.last = performance.now(); this.hover = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener("mousemove", e => this.onMove(e));
    canvas.addEventListener("mouseleave", () => { this.hover = null; this.camTargetDX = 0; this.tip.style.display = "none"; });
    requestAnimationFrame(t => this.loop(t));
  }

  iso(gx, gy) { return { x: this.originX + (gx - gy) * this.TW + this.camDX, y: this.originY + (gx + gy) * this.TH }; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = this.canvas.clientWidth; this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.ctx.imageSmoothingEnabled = true;
    if (this.result) this.layout(); else this.layoutEmpty();
  }

  fit(maxTargetH) {
    const TW0 = 32, TH0 = 16;
    const widthTiles = (this.gMaxX - this.gMinY) - (this.gMinX - this.gMaxY);
    const heightTiles = (this.gMaxX + this.gMaxY) - (this.gMinX + this.gMinY);
    this.scale = clamp(Math.min(this.W * 0.96 / (widthTiles * TW0), this.H * 0.96 / (heightTiles * TH0 + maxTargetH)), 0.32, 1.15);
    this.TW = TW0 * this.scale; this.TH = TH0 * this.scale; this.maxH = maxTargetH * this.scale;
  }
  camera() {
    const contentLeft = (this.gMinX - this.gMaxY) * this.TW, contentW = ((this.gMaxX - this.gMinY) - (this.gMinX - this.gMaxY)) * this.TW;
    this.originX = (this.W - contentW) / 2 - contentLeft;
    let top = (this.gMinX + this.gMinY) * this.TH;
    for (const b of this.buildings) { const ty = (b.gx + b.gy) * this.TH - b.targetH - 20 * this.scale; if (ty < top) top = ty; }
    const bottom = (this.gMaxX + this.gMaxY) * this.TH + 14 * this.scale;
    this.originY = (this.H - (bottom - top)) / 2 - top;
  }

  layoutEmpty() {
    this.districts = []; this.buildings = []; this.trees = []; this.walkers = []; this.signs = [];
    this.gMinX = -2.5; this.gMaxX = 3.5; this.gMinY = -2.5; this.gMaxY = 3.5;
    this.vAv = [-1.5, 1.5]; this.hAv = [-1.5, 1.5];
    this._buildCarGraph(); this._spawnCars(2);
    this.fit(70); this.camera();
  }

  layout() {
    const tracks = this.result.tracks;
    const byArtist = new Map();
    for (const t of tracks) { const a = t.artists || "Unknown"; (byArtist.get(a) || byArtist.set(a, []).get(a)).push(t); }
    const big = [...byArtist.entries()].filter(([, ts]) => ts.length >= DISTRICT_MIN).sort((a, b) => b[1].length - a[1].length);
    const smallTracks = [...byArtist.entries()].filter(([, ts]) => ts.length < DISTRICT_MIN).flatMap(([, ts]) => ts);
    const defs = big.map(([artist, ts]) => ({ artist, tracks: ts, named: true }));
    if (smallTracks.length) defs.push({ artist: "Downtown", tracks: smallTracks, named: false });

    let zoneCols = 1, zoneRows = 1;
    for (const d of defs) { const dc = Math.ceil(Math.sqrt(d.tracks.length)); zoneCols = Math.max(zoneCols, dc); zoneRows = Math.max(zoneRows, Math.ceil(d.tracks.length / dc)); }
    const spanX = (zoneCols - 1) * BP, spanY = (zoneRows - 1) * BP;
    const stepX = spanX + 2 * ZPAD + AV, stepY = spanY + 2 * ZPAD + AV;
    const metaCols = Math.ceil(Math.sqrt(defs.length)), metaRows = Math.ceil(defs.length / metaCols);

    const maxC = Math.max(1, ...tracks.filter(t => t.play_count != null).map(t => t.play_count));
    this.districts = []; this.buildings = []; this.trees = []; this.signs = []; this.walkers = [];
    const artistZone = new Map();

    defs.forEach((d, di) => {
      const mc = di % metaCols, mr = Math.floor(di / metaCols);
      const ox = mc * stepX, oy = mr * stepY;
      const theme = themeFor(d.artist, d.named);
      const zone = { ox, oy, spanX, spanY };
      this.districts.push({ ...d, ox, oy, spanX, spanY, theme });
      artistZone.set(d.artist, zone);
      for (let k = 0; k < zoneCols * zoneRows; k++) {
        const lc = k % zoneCols, lr = Math.floor(k / zoneCols), cx = ox + lc * BP, cy = oy + lr * BP;
        if (k < d.tracks.length) {
          const t = d.tracks[k];
          const jx = (rand01(t.name + "x") - 0.5) * 0.28, jy = (rand01(t.name + "y") - 0.5) * 0.28;
          this.buildings.push({
            track: t, gx: cx + jx, gy: cy + jy, f: 0.5 + (hashStr(t.name + "f") % 14) / 100,
            ruin: t.play_count == null, pc: t.play_count, maxC,
            col: theme.colors[hashStr(t.name) % theme.colors.length],
            accent: theme.accent, style: theme.style < 0 ? hashStr(t.name) % 4 : theme.style,
            isTallest: false, start: this.buildings.length * 55, _poly: null,
          });
        } else {
          this.trees.push({ gx: cx + (rand01(d.artist + k + "x") - 0.5) * 0.5, gy: cy + (rand01(d.artist + k + "y") - 0.5) * 0.5, k: d.artist + k });
        }
      }
      this.signs.push({ gx: ox + spanX / 2, gy: oy + spanY + ZPAD + 0.05, text: d.named ? d.artist : "Downtown", named: d.named, accent: theme.accent });
    });

    this.vAv = []; for (let mc = -1; mc < metaCols; mc++) this.vAv.push(mc * stepX + spanX + ZPAD + AV / 2);
    this.hAv = []; for (let mr = -1; mr < metaRows; mr++) this.hAv.push(mr * stepY + spanY + ZPAD + AV / 2);
    this.gMinX = this.vAv[0] - AV / 2; this.gMaxX = this.vAv[this.vAv.length - 1] + AV / 2;
    this.gMinY = this.hAv[0] - AV / 2; this.gMaxY = this.hAv[this.hAv.length - 1] + AV / 2;

    this.fit(190);
    const minH = 22 * this.scale, maxH = this.maxH;
    let tallest = null;
    for (const b of this.buildings) {
      b.targetH = b.ruin ? 24 * this.scale : minH + (maxH - minH) * Math.pow(b.pc / b.maxC, 0.62);
      if (!b.ruin && (!tallest || b.pc > tallest.pc)) tallest = b;
    }
    if (tallest) tallest.isTallest = true;
    this.buildings.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));

    this._buildCarGraph();
    this._spawnCars(Math.max(2, Math.min(4, this.vAv.length + this.hAv.length - 3)));

    const seen = new Set();
    for (const t of tracks) {
      const a = t.artists || "Unknown"; if (seen.has(a)) continue; seen.add(a);
      const zone = artistZone.get(a) || artistZone.get("Downtown");
      this.walkers.push({ name: a, color: theme_color(a), zone, labelled: byArtist.get(a).length < DISTRICT_MIN,
        gx: zone.ox + Math.random() * zone.spanX, gy: zone.oy + Math.random() * zone.spanY, tgx: 0, tgy: 0, speed: 0.45 + Math.random() * 0.35, phase: Math.random() * 1000 });
      this._newTarget(this.walkers[this.walkers.length - 1]);
    }
    this.camera();
  }

  // ---- car road graph ----
  _buildCarGraph() {
    this.carCols = this.vAv.length; this.carNodes = [];
    for (let j = 0; j < this.hAv.length; j++) for (let i = 0; i < this.vAv.length; i++) this.carNodes.push({ gx: this.vAv[i], gy: this.hAv[j] });
  }
  _carNeighbors(idx) {
    const C = this.carCols, i = idx % C, j = (idx / C) | 0, out = [];
    if (i > 0) out.push(idx - 1); if (i < C - 1) out.push(idx + 1);
    if (j > 0) out.push(idx - C); if (j < this.hAv.length - 1) out.push(idx + C);
    return out;
  }
  _spawnCars(count) {
    this.cars = []; const n = this.carNodes ? this.carNodes.length : 0; if (n < 2) return;
    for (let k = 0; k < count; k++) {
      const from = (Math.random() * n) | 0, nb = this._carNeighbors(from); if (!nb.length) continue;
      this.cars.push({ from, to: nb[(Math.random() * nb.length) | 0], t: Math.random(), speed: 0.5 + Math.random() * 0.3,
        color: CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0], axis: "h", gx: 0, gy: 0, wait: 0 });
    }
  }
  _newTarget(w) { w.tgx = w.zone.ox + Math.random() * w.zone.spanX; w.tgy = w.zone.oy + Math.random() * w.zone.spanY; }

  onMove(e) {
    const r = this.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    this.camTargetDX = (mx / this.W - 0.5) * 18 * this.scale;
    this.hover = null;
    for (let i = this.buildings.length - 1; i >= 0; i--) { const b = this.buildings[i]; if (b._poly && pointInPoly(mx, my, b._poly)) { this.hover = b; break; } }
    if (this.hover) {
      const t = this.hover.track;
      this.tip.innerHTML = `<strong>${esc(t.name)}</strong><br>${esc(t.artists)}<br>` + (t.play_count != null ? `${fmt(t.play_count)} streams` : `<span style="color:#e0556a">no count available</span>`);
      this.tip.style.display = "block"; this.tip.style.left = (e.clientX + 14) + "px"; this.tip.style.top = (e.clientY + 14) + "px";
    } else this.tip.style.display = "none";
  }
  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.camDX += (this.camTargetDX - this.camDX) * Math.min(1, dt * 6);
    this.draw(now, dt); requestAnimationFrame(t => this.loop(t));
  }

  // ---- primitives ----
  _quad(p, color) { const c = this.ctx; c.fillStyle = color; c.beginPath(); c.moveTo(p[0].x, p[0].y); for (let i = 1; i < p.length; i++) c.lineTo(p[i].x, p[i].y); c.closePath(); c.fill(); }
  _tri(a, b, d, color) { this._quad([a, b, d], color); }
  _diamond(gx, gy, hx, hy, color) { this._quad([this.iso(gx, gy - hy), this.iso(gx + hx, gy), this.iso(gx, gy + hy), this.iso(gx - hx, gy)], color); }
  _face(A, B, h, color) { this._quad([A, B, { x: B.x, y: B.y - h }, { x: A.x, y: A.y - h }], color); }
  _glass(A, B, h, key, base) {
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const cols = Math.max(1, Math.min(4, Math.floor(len / (13 * this.scale)))), rows = Math.max(1, Math.min(9, Math.floor(h / (15 * this.scale))));
    const pt = (fu, fv) => ({ x: A.x + (B.x - A.x) * fu, y: A.y + (B.y - A.y) * fu - h * fv });
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const lit = hashStr(key + c + "x" + r) % 4 === 0;
      const fu0 = (c + 0.24) / cols, fu1 = (c + 0.76) / cols, fv0 = (r + 0.22) / rows, fv1 = (r + 0.74) / rows;
      this._quad([pt(fu0, fv0), pt(fu1, fv0), pt(fu1, fv1), pt(fu0, fv1)], lit ? colHSL(base, 20, -10) : colHSL(base, -16));
    }
  }
  _strip(ax, ay, bx, by, hw, color) {
    const p = ax === bx ? [this.iso(ax - hw, ay), this.iso(ax + hw, ay), this.iso(bx + hw, by), this.iso(bx - hw, by)]
      : [this.iso(ax, ay - hw), this.iso(bx, by - hw), this.iso(bx, by + hw), this.iso(ax, ay + hw)];
    this._quad(p, color);
  }
  _box(gx, gy, fx, fy, h, color) {
    const N = this.iso(gx - fx, gy - fy), E = this.iso(gx + fx, gy - fy), S = this.iso(gx + fx, gy + fy), W = this.iso(gx - fx, gy + fy);
    this._face(E, S, h, shade(color, 0.9)); this._face(S, W, h, shade(color, 0.66));
    this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: S.x, y: S.y - h }, { x: W.x, y: W.y - h }], shade(color, 1.25));
  }
  _boxAt(gx, gy, fx, fy, baseH, h, base) {
    const lift = p => ({ x: p.x, y: p.y - baseH });
    const N = lift(this.iso(gx - fx, gy - fy)), E = lift(this.iso(gx + fx, gy - fy)), S = lift(this.iso(gx + fx, gy + fy)), W = lift(this.iso(gx - fx, gy + fy));
    this._face(E, S, h, colHSL(base, -6)); this._face(S, W, h, colHSL(base, -16));
    this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: S.x, y: S.y - h }, { x: W.x, y: W.y - h }], colHSL(base, 8));
  }

  // ---- frame ----
  draw(now, dt) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#8ec9f0"); sky.addColorStop(0.6, "#bfe3f2"); sky.addColorStop(1, "#fbe6c6");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    const sunX = W * 0.82, sunY = H * 0.2;
    const gg = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, 70);
    gg.addColorStop(0, "rgba(255,247,214,.95)"); gg.addColorStop(1, "rgba(255,247,214,0)");
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(sunX, sunY, 70, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff4cf"; ctx.beginPath(); ctx.arc(sunX, sunY, 24, 0, 7); ctx.fill();
    this._clouds(now);

    this._drawGround();
    for (const c of this.cars) this._stepCar(c, dt);
    for (const w of this.walkers) this._stepWalker(w, dt);

    const items = [];
    for (const b of this.buildings) items.push({ d: b.gx + b.gy + 0.002, k: "b", r: b });
    for (const t of this.trees) items.push({ d: t.gx + t.gy + 0.001, k: "t", r: t });
    for (const c of this.cars) items.push({ d: c.gx + c.gy, k: "c", r: c });
    for (const w of this.walkers) items.push({ d: w.gx + w.gy + 0.003, k: "w", r: w });
    for (const s of this.signs) items.push({ d: s.gx + s.gy + 0.5, k: "s", r: s });
    items.sort((a, b) => a.d - b.d);
    for (const it of items) {
      if (it.k === "b") this._drawBuilding(it.r, now);
      else if (it.k === "t") this._drawTree(it.r);
      else if (it.k === "c") this._drawCar(it.r);
      else if (it.k === "w") this._drawWalker(it.r, now);
      else this._drawSign(it.r);
    }
    if (!this.result) { ctx.fillStyle = "rgba(30,40,60,.9)"; ctx.font = "600 15px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.fillText("Paste a playlist link to build the city ↑", W / 2, this.originY); }
  }

  _clouds(now) {
    const ctx = this.ctx; ctx.fillStyle = "rgba(255,255,255,.85)";
    for (let i = 0; i < 4; i++) {
      const baseX = (i * 260 + now * (0.006 + i * 0.002)) % (this.W + 220) - 110, y = 40 + (i % 2) * 34 + i * 8;
      for (const [dx, dy, r] of [[0, 0, 16], [16, 4, 13], [-15, 5, 12], [4, -6, 11]]) { ctx.beginPath(); ctx.arc(baseX + dx, y + dy, r, 0, 7); ctx.fill(); }
    }
  }

  _drawGround() {
    const N = this.iso(this.gMinX, this.gMinY), E = this.iso(this.gMaxX, this.gMinY), S = this.iso(this.gMaxX, this.gMaxY), Wp = this.iso(this.gMinX, this.gMaxY), dz = 14 * this.scale;
    this._quad([Wp, S, { x: S.x, y: S.y + dz }, { x: Wp.x, y: Wp.y + dz }], "#4a5360");
    this._quad([S, E, { x: E.x, y: E.y + dz }, { x: S.x, y: S.y + dz }], "#3a424d");
    this._quad([N, E, S, Wp], "#6f7889");                          // road base
    for (const gx of this.vAv) for (let gy = this.gMinY + 0.3; gy < this.gMaxY - 0.3; gy += 0.95) this._strip(gx, gy, gx, gy + 0.34, 0.05, "#f4cf57");
    for (const gy of this.hAv) for (let gx = this.gMinX + 0.3; gx < this.gMaxX - 0.3; gx += 0.95) this._strip(gx, gy, gx + 0.34, gy, 0.05, "#f4cf57");
    for (const d of this.districts) {
      const cx = d.ox + d.spanX / 2, cy = d.oy + d.spanY / 2;
      this._diamond(cx, cy, d.spanX / 2 + ZPAD, d.spanY / 2 + ZPAD, colHSL(d.theme.side));
      this._diamond(cx, cy, d.spanX / 2 + ZPAD - 0.16, d.spanY / 2 + ZPAD - 0.16, colHSL(d.theme.lot));
    }
  }

  _drawBuilding(b, now) {
    const ctx = this.ctx;
    const p = Math.max(0, Math.min(1, (now - this.t0 - b.start) / 700));
    const h = b.targetH * (1 - Math.pow(1 - p, 3));
    const C = this.iso(b.gx, b.gy), hw = b.f * this.TW, hh = b.f * this.TH;
    const N = { x: C.x, y: C.y - hh }, Sp = { x: C.x, y: C.y + hh }, E = { x: C.x + hw, y: C.y }, Wp = { x: C.x - hw, y: C.y };
    b._poly = [E, Sp, Wp, { x: Wp.x, y: Wp.y - h }, { x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }];
    // soft shadow
    this._diamond(b.gx + 0.14, b.gy + 0.14, b.f * 1.05, b.f * 1.05, "rgba(20,28,40,.16)");
    if (b.ruin) {
      this._face(E, Sp, h, "#7c7f88"); this._face(Sp, Wp, h, "#62656e");
      this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: Sp.x, y: Sp.y - h }, { x: Wp.x, y: Wp.y - h }], "#9a9da6");
      this._glass(E, Sp, h, "rr" + b.gx, [45, 60, 55]); this._glass(Sp, Wp, h, "rl" + b.gy, [45, 50, 48]);
    } else {
      this._face(E, Sp, h, colHSL(b.col, -6)); this._face(Sp, Wp, h, colHSL(b.col, -16));
      this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: Sp.x, y: Sp.y - h }, { x: Wp.x, y: Wp.y - h }], colHSL(b.col, 9));
      this._glass(E, Sp, h, b.track.name + "R", b.col); this._glass(Sp, Wp, h, b.track.name + "L", b.col);
      if (p > 0.92) this._roof(b, C, N, E, Sp, Wp, h);
    }
    if (this.hover === b) { ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.lineWidth = 2; ctx.beginPath(); b._poly.forEach((pt, i) => i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)); ctx.closePath(); ctx.stroke(); }
    if (b.isTallest && p > 0.92) { ctx.strokeStyle = colHSL(b.accent); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(C.x, C.y - h); ctx.lineTo(C.x, C.y - h - 16 * this.scale); ctx.stroke(); ctx.fillStyle = colHSL(b.accent, (Math.floor(now / 500) % 2) ? 10 : -25); ctx.beginPath(); ctx.arc(C.x, C.y - h - 18 * this.scale, 3, 0, 7); ctx.fill(); }
    if (p > 0.85) { ctx.fillStyle = "#1d2740"; ctx.font = `700 ${Math.round(10 * Math.max(0.85, this.scale))}px system-ui,sans-serif`; ctx.textAlign = "center"; ctx.fillText(short(b.track.play_count), C.x, N.y - h - 6); }
  }

  _roof(b, C, N, E, Sp, Wp, h) {
    const Nt = { x: N.x, y: N.y - h }, Et = { x: E.x, y: E.y - h }, St = { x: Sp.x, y: Sp.y - h }, Wt = { x: Wp.x, y: Wp.y - h };
    if (b.style === 1) {                                   // pyramid / tent roof
      const rh = 14 * this.scale + b.f * 16, apex = { x: C.x, y: C.y - h - rh };
      this._tri(Nt, Et, apex, colHSL(b.col, 2)); this._tri(Wt, Nt, apex, colHSL(b.col, -2));
      this._tri(Et, St, apex, colHSL(b.col, -10)); this._tri(St, Wt, apex, colHSL(b.col, -20));
    } else if (b.style === 2) {                            // single setback
      this._boxAt(b.gx, b.gy, b.f * 0.6, b.f * 0.6, h, 16 * this.scale, b.col);
    } else if (b.style === 3) {                            // two-step ziggurat
      this._boxAt(b.gx, b.gy, b.f * 0.66, b.f * 0.66, h, 12 * this.scale, b.col);
      this._boxAt(b.gx, b.gy, b.f * 0.36, b.f * 0.36, h + 12 * this.scale, 12 * this.scale, b.col);
    } else {                                               // flat: accent parapet + rooftop unit
      this._boxAt(b.gx - b.f * 0.4, b.gy - b.f * 0.4, b.f * 0.22, b.f * 0.22, h, 7 * this.scale, b.col);
    }
  }

  _drawTree(t) {
    const ctx = this.ctx, g = this.iso(t.gx, t.gy), s = this.scale;
    ctx.fillStyle = "rgba(20,28,40,.18)"; ctx.beginPath(); ctx.ellipse(g.x, g.y + 1, 7 * s, 3 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "#7a5230"; ctx.fillRect(g.x - 1.6 * s, g.y - 9 * s, 3.2 * s, 9 * s);
    const a = (hashStr(t.k) % 2) ? [128, 42, 42] : [142, 40, 38];   // low-poly conifer (stacked triangles)
    for (let i = 0; i < 3; i++) {
      const baseY = g.y - 6 * s - i * 7 * s, w = (9 - i * 2.2) * s;
      this._triXY(g.x, baseY - 9 * s, g.x - w, baseY, g.x + w, baseY, colHSL(a, -4 - i * 2));
      this._triXY(g.x, baseY - 9 * s, g.x - w, baseY, g.x, baseY, colHSL(a, 6 - i * 2)); // lit left facet
    }
  }
  _triXY(ax, ay, bx, by, cx, cy, color) { const c = this.ctx; c.fillStyle = color; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(cx, cy); c.closePath(); c.fill(); }

  _drawCar(c) {
    const fx = c.axis === "h" ? 0.4 : 0.2, fy = c.axis === "v" ? 0.4 : 0.2;
    this._box(c.gx, c.gy, fx, fy, 6 * this.scale, c.color);
    this._boxAt(c.gx, c.gy, fx * 0.6, fy * 0.6, 6 * this.scale, 4 * this.scale, [205, 30, 78]); // windshield/cabin
  }

  _drawWalker(w, now) {
    const ctx = this.ctx, g = this.iso(w.gx, w.gy), s = Math.max(2, 2.6 * this.scale), bob = Math.sin(now / 220 + w.phase) * 1.3;
    const cx = g.x, top = g.y - 11 * s + bob;
    ctx.fillStyle = "rgba(20,28,40,.22)"; ctx.beginPath(); ctx.ellipse(cx, g.y + 1, 3 * s, 1.2 * s, 0, 0, 7); ctx.fill();
    const swing = Math.sin(now / 150 + w.phase) * 1.4 * s;
    ctx.strokeStyle = "#2c3350"; ctx.lineWidth = 1.6 * s; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx, top + 6 * s); ctx.lineTo(cx - swing, g.y); ctx.moveTo(cx, top + 6 * s); ctx.lineTo(cx + swing, g.y); ctx.stroke();
    ctx.fillStyle = w.color; ctx.beginPath(); ctx.moveTo(cx - 2.4 * s, top + 6 * s); ctx.lineTo(cx + 2.4 * s, top + 6 * s); ctx.lineTo(cx + 1.7 * s, top); ctx.lineTo(cx - 1.7 * s, top); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#f1c79a"; ctx.beginPath(); ctx.arc(cx, top - 2 * s, 2.1 * s, 0, 7); ctx.fill();
    if (w.labelled && w.name) {
      ctx.font = "600 10px system-ui,sans-serif"; ctx.textAlign = "center"; const tw = ctx.measureText(w.name).width;
      ctx.fillStyle = "rgba(20,28,40,.62)"; this._rr(cx - tw / 2 - 4, top - 16 * s, tw + 8, 13, 3); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillText(w.name, cx, top - 16 * s + 9.5);
    }
  }
  _rr(x, y, w, h, r) { const c = this.ctx; c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  _drawSign(s) {
    const ctx = this.ctx, g = this.iso(s.gx, s.gy), sc = this.scale;
    ctx.fillStyle = "#39404d"; ctx.fillRect(g.x - 1.5, g.y - 22 * sc, 3, 22 * sc);
    ctx.font = `700 ${Math.round(11 * Math.max(0.9, sc))}px system-ui,sans-serif`; ctx.textAlign = "center";
    const label = s.named ? "♪ " + s.text : s.text, tw = ctx.measureText(label).width;
    ctx.fillStyle = s.named ? colHSL(s.accent, -8) : "#52596a"; this._rr(g.x - tw / 2 - 7, g.y - 37 * sc, tw + 14, 17 * sc, 4); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.fillText(label, g.x, g.y - 37 * sc + 12 * sc);
  }

  _stepCar(c, dt) {
    if (c.wait > 0) { c.wait -= dt; return; }
    let A = this.carNodes[c.from], B = this.carNodes[c.to]; if (!A || !B) return;
    c.t += c.speed * dt / Math.max(0.6, Math.hypot(B.gx - A.gx, B.gy - A.gy));
    if (c.t >= 1) {
      c.t = 0; const prev = c.from; c.from = c.to;
      const cur = this.carNodes[c.from], pv = this.carNodes[prev], dx = Math.sign(cur.gx - pv.gx), dy = Math.sign(cur.gy - pv.gy);
      let straight = -1; const turns = [];
      for (const nb of this._carNeighbors(c.from)) { if (nb === prev) continue; const nn = this.carNodes[nb]; if (Math.sign(nn.gx - cur.gx) === dx && Math.sign(nn.gy - cur.gy) === dy) straight = nb; else turns.push(nb); }
      let next; if (straight >= 0 && Math.random() < 0.65) next = straight; else if (turns.length) next = turns[(Math.random() * turns.length) | 0]; else next = straight >= 0 ? straight : prev;
      if (next !== straight && Math.random() < 0.5) c.wait = 0.4 + Math.random() * 0.6;
      c.to = next; A = this.carNodes[c.from]; B = this.carNodes[c.to];
    }
    let gx = A.gx + (B.gx - A.gx) * c.t, gy = A.gy + (B.gy - A.gy) * c.t;
    const dvx = B.gx - A.gx, dvy = B.gy - A.gy, LANE = 0.16;
    if (Math.abs(dvx) >= Math.abs(dvy)) { c.axis = "h"; gy += dvx > 0 ? LANE : -LANE; } else { c.axis = "v"; gx += dvy > 0 ? -LANE : LANE; }
    c.gx = gx; c.gy = gy;
  }
  _stepWalker(w, dt) {
    const dx = w.tgx - w.gx, dy = w.tgy - w.gy, dist = Math.hypot(dx, dy);
    if (dist < 0.08) { this._newTarget(w); return; }
    w.gx += (dx / dist) * w.speed * dt; w.gy += (dy / dist) * w.speed * dt;
  }
}

function theme_color(artist) { return colHSL([hashStr(artist) % 360, 55, 60]); }

// ============================================================ wiring
document.addEventListener("DOMContentLoaded", () => {
  const city = new CanvasCity(document.getElementById("city"), document.getElementById("tip"));
  const input = document.getElementById("link"), out = document.getElementById("out");
  function run() {
    try {
      const { type, id } = parseSpotifyInput(input.value);
      const result = getStreams(type, id);
      city.result = result; city.t0 = performance.now(); city.layout();
      renderPanel(result, out);
    } catch (err) { city.result = null; city.layoutEmpty(); out.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  }
  document.getElementById("form").addEventListener("submit", e => { e.preventDefault(); run(); });
  document.querySelectorAll("[data-fill]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); input.value = a.getAttribute("data-fill"); run(); }));
});

function renderPanel(r, out) {
  const rows = r.tracks.slice().sort((a, b) => (b.play_count || -1) - (a.play_count || -1))
    .map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.artists)}</td><td class="num">${t.play_count != null ? fmt(t.play_count) : '<span class="na">n/a</span>'}</td></tr>`).join("");
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
