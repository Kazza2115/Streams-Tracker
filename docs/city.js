/* Stream Consolidator — retro ISOMETRIC city demo (static, mock data).
 * Tracks are buildings; artists are grouped into DISTRICTS (an artist with
 * more than 4 tracks gets a named neighbourhood, the rest share "Downtown").
 * Avenues run between districts with cars; citizens stroll their own district.
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
const rand01 = k => (hashStr(k) % 1000) / 1000;            // deterministic 0..1

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

const BODY_COLORS = ["#5566a0", "#8a5a9e", "#a06a52", "#3f9e86", "#7d6fae", "#a08a4a", "#5f86b0", "#9e5a7a"];
const SHIRT_COLORS = ["#e85d75", "#f4a259", "#4ea1d3", "#7bc96f", "#c879e8", "#f6c945", "#ff8fb1", "#5ad1c7"];
const CAR_COLORS = ["#e74c4c", "#4ea1d3", "#f6c945", "#7bc96f", "#ee82c0", "#ffffff"];
const WIN_ON = "#ffd86b";
const BP = 1.5;          // building pitch inside a district
const AV = 2.0;          // avenue width between districts
const ZPAD = 0.7;        // sidewalk pad around a district
const DISTRICT_MIN = 5;  // > 4 tracks => the artist gets a named district

// ============================================================ the city
class CanvasCity {
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tip = tip;
    this.result = null;
    this.districts = []; this.buildings = []; this.trees = []; this.cars = []; this.walkers = []; this.signs = [];
    this.gMinX = -2; this.gMaxX = 6; this.gMinY = -2; this.gMaxY = 6;
    this.TW = 32; this.TH = 16; this.scale = 1; this.maxH = 120;
    this.originX = 0; this.originY = 0;
    this.camDX = 0; this.camTargetDX = 0;
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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.ctx.imageSmoothingEnabled = false;
    if (this.result) this.layout(); else this.layoutEmpty();
  }

  fit(maxTargetH) {
    const TW0 = 32, TH0 = 16;
    const widthTiles = (this.gMaxX - this.gMinY) - (this.gMinX - this.gMaxY);
    const heightTiles = (this.gMaxX + this.gMaxY) - (this.gMinX + this.gMinY);
    this.scale = Math.max(0.32, Math.min(1.15, Math.min(this.W * 0.96 / (widthTiles * TW0), this.H * 0.96 / (heightTiles * TH0 + maxTargetH))));
    this.TW = TW0 * this.scale; this.TH = TH0 * this.scale; this.maxH = maxTargetH * this.scale;
  }
  camera() {
    const contentLeft = (this.gMinX - this.gMaxY) * this.TW, contentW = ((this.gMaxX - this.gMinY) - (this.gMinX - this.gMaxY)) * this.TW;
    this.originX = (this.W - contentW) / 2 - contentLeft;
    let top = (this.gMinX + this.gMinY) * this.TH;
    for (const b of this.buildings) { const ty = (b.gx + b.gy) * this.TH - b.targetH; if (ty < top) top = ty; }
    const bottom = (this.gMaxX + this.gMaxY) * this.TH + 14 * this.scale;
    this.originY = (this.H - (bottom - top)) / 2 - top;
  }

  layoutEmpty() {
    this.districts = []; this.buildings = []; this.trees = []; this.cars = []; this.walkers = []; this.signs = [];
    this.gMinX = -2.5; this.gMaxX = 3.5; this.gMinY = -2.5; this.gMaxY = 3.5;
    this.vAv = [-1.5, 1.5]; this.hAv = [-1.5, 1.5];
    this.fit(70); this.camera();
  }

  layout() {
    const tracks = this.result.tracks;
    // group by artist (first-seen order)
    const byArtist = new Map();
    for (const t of tracks) { const a = t.artists || "Unknown"; (byArtist.get(a) || byArtist.set(a, []).get(a)).push(t); }

    const big = [...byArtist.entries()].filter(([, ts]) => ts.length >= DISTRICT_MIN).sort((a, b) => b[1].length - a[1].length);
    const smallTracks = [...byArtist.entries()].filter(([, ts]) => ts.length < DISTRICT_MIN).flatMap(([, ts]) => ts);

    const districtDefs = big.map(([artist, ts]) => ({ artist, tracks: ts, named: true }));
    if (smallTracks.length) districtDefs.push({ artist: "Downtown", tracks: smallTracks, named: false });

    // uniform zone size = largest district
    let zoneCols = 1, zoneRows = 1;
    for (const d of districtDefs) {
      const dc = Math.ceil(Math.sqrt(d.tracks.length)), dr = Math.ceil(d.tracks.length / dc);
      zoneCols = Math.max(zoneCols, dc); zoneRows = Math.max(zoneRows, dr);
    }
    const spanX = (zoneCols - 1) * BP, spanY = (zoneRows - 1) * BP;
    const stepX = spanX + 2 * ZPAD + AV, stepY = spanY + 2 * ZPAD + AV;
    const metaCols = Math.ceil(Math.sqrt(districtDefs.length));

    const maxC = Math.max(1, ...tracks.filter(t => t.play_count != null).map(t => t.play_count));
    this.districts = []; this.buildings = []; this.trees = []; this.signs = []; this.walkers = [];
    const artistDistrict = new Map();

    districtDefs.forEach((d, di) => {
      const mc = di % metaCols, mr = Math.floor(di / metaCols);
      const ox = mc * stepX, oy = mr * stepY;
      const tint = d.named ? `hsl(${hashStr(d.artist) % 360},26%,19%)` : "hsl(0,0%,16%)";
      const side = d.named ? `hsl(${hashStr(d.artist) % 360},18%,29%)` : "hsl(0,0%,26%)";
      const zone = { ox, oy, spanX, spanY };
      this.districts.push({ ...d, ox, oy, spanX, spanY, tint, side });
      artistDistrict.set(d.artist, zone);

      for (let k = 0; k < zoneCols * zoneRows; k++) {
        const lc = k % zoneCols, lr = Math.floor(k / zoneCols);
        const cx = ox + lc * BP, cy = oy + lr * BP;
        if (k < d.tracks.length) {
          const t = d.tracks[k];
          const jx = (rand01(t.name + "x") - 0.5) * 0.3, jy = (rand01(t.name + "y") - 0.5) * 0.3;
          const f = 0.34 + (hashStr(t.name + "f") % 13) / 100;
          this.buildings.push({
            track: t, gx: cx + jx, gy: cy + jy, f,
            ruin: t.play_count == null,
            pc: t.play_count, maxC,
            color: BODY_COLORS[hashStr(t.name) % BODY_COLORS.length],
            isTallest: false, start: this.buildings.length * 55, _poly: null,
          });
        } else {
          this.trees.push({ gx: cx + (rand01(d.artist + k + "tx") - 0.5) * 0.5, gy: cy + (rand01(d.artist + k + "ty") - 0.5) * 0.5, k: d.artist + k });
        }
      }
      // district sign at the front-centre of the zone
      this.signs.push({ gx: ox + spanX / 2, gy: oy + spanY + ZPAD + 0.05, text: d.named ? d.artist : "Downtown", named: d.named, tint: side });
    });

    // bounds + avenues (gaps between/around zones)
    const metaRows = Math.ceil(districtDefs.length / metaCols);
    this.vAv = []; for (let mc = -1; mc < metaCols; mc++) this.vAv.push(mc * stepX + spanX + ZPAD + AV / 2);
    this.hAv = []; for (let mr = -1; mr < metaRows; mr++) this.hAv.push(mr * stepY + spanY + ZPAD + AV / 2);
    this.gMinX = this.vAv[0] - AV / 2; this.gMaxX = this.vAv[this.vAv.length - 1] + AV / 2;
    this.gMinY = this.hAv[0] - AV / 2; this.gMaxY = this.hAv[this.hAv.length - 1] + AV / 2;

    this.fit(190);
    // finalize building heights now that scale is known
    const minH = 20 * this.scale, maxH = this.maxH;
    let tallest = null;
    for (const b of this.buildings) {
      b.targetH = b.ruin ? 24 * this.scale : minH + (maxH - minH) * Math.pow(b.pc / b.maxC, 0.6);
      if (!b.ruin && (!tallest || b.pc > tallest.pc)) tallest = b;
    }
    if (tallest) tallest.isTallest = true;
    this.buildings.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));

    // cars on every avenue
    this.cars = [];
    this.vAv.forEach((gx, i) => { for (let c = 0; c < 2; c++) this.cars.push(this._mkCar("v", gx, i + c)); });
    this.hAv.forEach((gy, i) => { for (let c = 0; c < 2; c++) this.cars.push(this._mkCar("h", gy, i + c + 7)); });

    // one citizen per artist, strolling their own district
    const seen = new Set();
    for (const t of tracks) {
      const a = t.artists || "Unknown";
      if (seen.has(a)) continue; seen.add(a);
      const zone = artistDistrict.get(a) || artistDistrict.get("Downtown");
      const named = byArtist.get(a).length >= DISTRICT_MIN;
      this.walkers.push({
        name: a, color: SHIRT_COLORS[hashStr(a) % SHIRT_COLORS.length], zone, labelled: !named,
        gx: zone.ox + Math.random() * zone.spanX, gy: zone.oy + Math.random() * zone.spanY,
        tgx: 0, tgy: 0, speed: 0.5 + Math.random() * 0.4, phase: Math.random() * 1000,
      });
      const w = this.walkers[this.walkers.length - 1]; this._newTarget(w);
    }

    this.camera();
  }

  _mkCar(axis, line, seed) {
    const span = axis === "v" ? [this.gMinY, this.gMaxY] : [this.gMinX, this.gMaxX];
    const dir = rand01("cdir" + seed) < 0.5 ? 1 : -1;
    return { axis, line: line + (dir > 0 ? 0.22 : -0.22), pos: span[0] + rand01("cpos" + seed) * (span[1] - span[0]),
      dir, speed: 1.1 + rand01("csp" + seed) * 1.0, color: CAR_COLORS[hashStr("car" + seed) % CAR_COLORS.length], gx: 0, gy: 0 };
  }
  _newTarget(w) { w.tgx = w.zone.ox + Math.random() * w.zone.spanX; w.tgy = w.zone.oy + Math.random() * w.zone.spanY; }

  onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    this.camTargetDX = (mx / this.W - 0.5) * 18 * this.scale;
    this.hover = null;
    for (let i = this.buildings.length - 1; i >= 0; i--) { const b = this.buildings[i]; if (b._poly && pointInPoly(mx, my, b._poly)) { this.hover = b; break; } }
    if (this.hover) {
      const t = this.hover.track;
      this.tip.innerHTML = `<strong>${esc(t.name)}</strong><br>${esc(t.artists)}<br>` +
        (t.play_count != null ? `${fmt(t.play_count)} streams` : `<span style="color:#ff8a8a">no count available</span>`);
      this.tip.style.display = "block"; this.tip.style.left = (e.clientX + 14) + "px"; this.tip.style.top = (e.clientY + 14) + "px";
    } else this.tip.style.display = "none";
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.camDX += (this.camTargetDX - this.camDX) * Math.min(1, dt * 6);
    this.draw(now, dt);
    requestAnimationFrame(t => this.loop(t));
  }

  // ---------- primitives ----------
  _quad(p, color) {
    const ctx = this.ctx; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); ctx.closePath(); ctx.fill();
  }
  _diamond(gx, gy, hx, hy, color) {
    this._quad([this.iso(gx, gy - hy), this.iso(gx + hx, gy), this.iso(gx, gy + hy), this.iso(gx - hx, gy)], color);
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
  _box(gx, gy, fx, fy, h, color) {
    const Nc = this.iso(gx - fx, gy - fy), Ec = this.iso(gx + fx, gy - fy), Sc = this.iso(gx + fx, gy + fy), Wc = this.iso(gx - fx, gy + fy);
    this._face(Ec, Sc, h, shade(color, 0.9)); this._face(Sc, Wc, h, shade(color, 0.66));
    this._quad([{ x: Nc.x, y: Nc.y - h }, { x: Ec.x, y: Ec.y - h }, { x: Sc.x, y: Sc.y - h }, { x: Wc.x, y: Wc.y - h }], shade(color, 1.3));
  }

  // ---------- frame ----------
  draw(now, dt) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#16123a"); sky.addColorStop(0.5, "#4a2a6b"); sky.addColorStop(1, "#ff7e5f");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.7)";
    for (let i = 0; i < 46; i++) { const sx = (i * 97) % W, sy = (i * 53) % (H * 0.4); if ((Math.floor(now / 600) + i) % 5 !== 0) ctx.fillRect(sx, sy, 2, 2); }
    const sunX = W * 0.84, sunY = H * 0.2;
    const gg = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, 64);
    gg.addColorStop(0, "#ffe39a"); gg.addColorStop(1, "rgba(255,126,95,0)");
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(sunX, sunY, 64, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffd06b"; ctx.beginPath(); ctx.arc(sunX, sunY, 26, 0, 7); ctx.fill();

    this._drawGround(now);

    // update movers
    for (const c of this.cars) this._stepCar(c, dt);
    for (const w of this.walkers) this._stepWalker(w, dt);

    // z-sorted scene
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

    if (!this.result) {
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.font = "bold 14px monospace"; ctx.textAlign = "center";
      ctx.fillText("Paste a playlist link to build the city ↑", W / 2, this.originY);
    }
  }

  _drawGround(now) {
    const N = this.iso(this.gMinX, this.gMinY), E = this.iso(this.gMaxX, this.gMinY), S = this.iso(this.gMaxX, this.gMaxY), Wp = this.iso(this.gMinX, this.gMaxY);
    const dz = 14 * this.scale;
    this._quad([Wp, S, { x: S.x, y: S.y + dz }, { x: Wp.x, y: Wp.y + dz }], "#13101d");
    this._quad([S, E, { x: E.x, y: E.y + dz }, { x: S.x, y: S.y + dz }], "#0b0913");
    this._quad([N, E, S, Wp], "#1a1726");                       // asphalt base = avenues
    // dashed avenue lines
    for (const gx of this.vAv) for (let gy = this.gMinY + 0.3; gy < this.gMaxY - 0.3; gy += 0.95) this._strip(gx, gy, gx, gy + 0.34, 0.05, "#d9b441");
    for (const gy of this.hAv) for (let gx = this.gMinX + 0.3; gx < this.gMaxX - 0.3; gx += 0.95) this._strip(gx, gy, gx + 0.34, gy, 0.05, "#d9b441");
    // district blocks (sidewalk + tinted lot) on top of asphalt
    for (const d of this.districts) {
      const cx = d.ox + d.spanX / 2, cy = d.oy + d.spanY / 2;
      this._diamond(cx, cy, d.spanX / 2 + ZPAD, d.spanY / 2 + ZPAD, d.side);          // sidewalk
      this._diamond(cx, cy, d.spanX / 2 + ZPAD - 0.18, d.spanY / 2 + ZPAD - 0.18, d.tint); // lot
    }
  }

  _drawBuilding(b, now) {
    const ctx = this.ctx;
    const p = Math.max(0, Math.min(1, (now - this.t0 - b.start) / 700));
    const h = b.targetH * (1 - Math.pow(1 - p, 3));
    const C = this.iso(b.gx, b.gy), hw = 2 * b.f * this.TW, hh = 2 * b.f * this.TH;
    const N = { x: C.x, y: C.y - hh }, Sp = { x: C.x, y: C.y + hh }, E = { x: C.x + hw, y: C.y }, Wp = { x: C.x - hw, y: C.y };
    b._poly = [E, Sp, Wp, { x: Wp.x, y: Wp.y - h }, { x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }];
    const col = b.color;
    if (b.ruin) {
      this._face(E, Sp, h, "#39323f"); this._face(Sp, Wp, h, "#2c2735");
      this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: Sp.x, y: Sp.y - h }, { x: Wp.x, y: Wp.y - h }], "#4a4358");
      this._faceWindows(E, Sp, h, "rr" + b.gx, now, "#f6c945"); this._faceWindows(Sp, Wp, h, "rl" + b.gy, now, "#c8a23a");
    } else {
      this._face(E, Sp, h, shade(col, 0.95)); this._face(Sp, Wp, h, shade(col, 0.66));
      this._quad([{ x: N.x, y: N.y - h }, { x: E.x, y: E.y - h }, { x: Sp.x, y: Sp.y - h }, { x: Wp.x, y: Wp.y - h }], shade(col, 1.35));
      this._faceWindows(E, Sp, h, b.track.name + "R", now, WIN_ON); this._faceWindows(Sp, Wp, h, b.track.name + "L", now, "#e9c45f");
    }
    if (this.hover === b) { ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2; ctx.beginPath(); b._poly.forEach((pt, i) => i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)); ctx.closePath(); ctx.stroke(); }
    if (b.isTallest && p > 0.9) {
      ctx.fillStyle = "#9aa"; ctx.fillRect(C.x - 1, C.y - h - 14 * this.scale, 2, 14 * this.scale);
      ctx.fillStyle = (Math.floor(now / 500) % 2) ? "#ff4d4d" : "#5a1f1f"; ctx.fillRect(C.x - 2, C.y - h - 16 * this.scale, 4, 4);
    }
    if (p > 0.85) { ctx.fillStyle = "#fff8e0"; ctx.font = `bold ${Math.round(10 * Math.max(0.8, this.scale))}px monospace`; ctx.textAlign = "center"; ctx.fillText(short(b.track.play_count), C.x, N.y - h - 6); }
  }

  _drawTree(t) {
    const ctx = this.ctx, g = this.iso(t.gx, t.gy), s = this.scale;
    ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.beginPath(); ctx.ellipse(g.x, g.y + 1, 7 * s, 3 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "#5b3b22"; ctx.fillRect(g.x - 1.5 * s, g.y - 9 * s, 3 * s, 9 * s);
    const green = (hashStr(t.k) % 2) ? "#3f8f54" : "#4fa463";
    ctx.fillStyle = green; ctx.beginPath(); ctx.arc(g.x, g.y - 12 * s, 7 * s, 0, 7); ctx.fill();
    ctx.fillStyle = shade(green === "#3f8f54" ? "#3f8f54" : "#4fa463", 1.2); ctx.beginPath(); ctx.arc(g.x - 2 * s, g.y - 14 * s, 4 * s, 0, 7); ctx.fill();
  }

  _drawCar(c) {
    const ctx = this.ctx;
    const fx = c.axis === "h" ? 0.42 : 0.2, fy = c.axis === "v" ? 0.42 : 0.2;
    this._box(c.gx, c.gy, fx, fy, 6 * this.scale, c.color);
    const g = this.iso(c.gx, c.gy); // headlights
    ctx.fillStyle = "#fff6c0"; ctx.fillRect(g.x - 1, g.y - 7 * this.scale, 2, 2);
  }

  _drawWalker(w, now) {
    const ctx = this.ctx, g = this.iso(w.gx, w.gy), s = Math.max(2, Math.round(2.6 * this.scale));
    const bob = Math.sin(now / 200 + w.phase) * 1.4;
    const x = Math.round(g.x - 3 * s), y = Math.round(g.y - 12 * s + bob), frame = Math.floor(now / 170 + w.phase) % 2;
    ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.beginPath(); ctx.ellipse(g.x, g.y + 1, 3 * s, 1.2 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "#2c2f48";
    if (frame === 0) { ctx.fillRect(x + s, y + 9 * s, 1.6 * s, 3 * s); ctx.fillRect(x + 3.4 * s, y + 9 * s, 1.6 * s, 3 * s); }
    else { ctx.fillRect(x + 0.5 * s, y + 9 * s, 1.6 * s, 3 * s); ctx.fillRect(x + 3.9 * s, y + 9 * s, 1.6 * s, 3 * s); }
    ctx.fillStyle = w.color; ctx.fillRect(x + s, y + 4 * s, 4 * s, 5 * s); ctx.fillRect(x, y + 4 * s, s, 4 * s); ctx.fillRect(x + 5 * s, y + 4 * s, s, 4 * s);
    ctx.fillStyle = "#f1c27d"; ctx.fillRect(x + s, y, 4 * s, 4 * s); ctx.fillStyle = "#3a2a1a"; ctx.fillRect(x + s, y, 4 * s, s);
    if (w.labelled && w.name) {
      ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; const tw = ctx.measureText(w.name).width;
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(g.x - tw / 2 - 3, y - 16, tw + 6, 13);
      ctx.fillStyle = "#fff"; ctx.fillText(w.name, g.x, y - 6);
    }
  }

  _drawSign(s) {
    const ctx = this.ctx, g = this.iso(s.gx, s.gy), sc = this.scale;
    ctx.fillStyle = "#23202f"; ctx.fillRect(g.x - 1.5, g.y - 22 * sc, 3, 22 * sc); // post
    ctx.font = `bold ${Math.round(11 * Math.max(0.85, sc))}px monospace`; ctx.textAlign = "center";
    const label = s.named ? "★ " + s.text : s.text, tw = ctx.measureText(label).width;
    ctx.fillStyle = s.named ? s.tint : "#3a3550"; ctx.fillRect(g.x - tw / 2 - 6, g.y - 36 * sc, tw + 12, 16 * sc);
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1; ctx.strokeRect(g.x - tw / 2 - 6, g.y - 36 * sc, tw + 12, 16 * sc);
    ctx.fillStyle = "#fff8e0"; ctx.fillText(label, g.x, g.y - 36 * sc + 12 * sc);
  }

  _stepCar(c, dt) {
    const span = c.axis === "v" ? [this.gMinY, this.gMaxY] : [this.gMinX, this.gMaxX];
    c.pos += c.dir * c.speed * dt;
    if (c.pos > span[1] + 0.5) c.pos = span[0] - 0.5; if (c.pos < span[0] - 0.5) c.pos = span[1] + 0.5;
    if (c.axis === "v") { c.gx = c.line; c.gy = c.pos; } else { c.gx = c.pos; c.gy = c.line; }
  }
  _stepWalker(w, dt) {
    const dx = w.tgx - w.gx, dy = w.tgy - w.gy, dist = Math.hypot(dx, dy);
    if (dist < 0.08) { this._newTarget(w); return; }
    w.gx += (dx / dist) * w.speed * dt; w.gy += (dy / dist) * w.speed * dt;
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
      city.result = result; city.t0 = performance.now(); city.layout();
      renderPanel(result, out);
    } catch (err) {
      city.result = null; city.layoutEmpty();
      out.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
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
