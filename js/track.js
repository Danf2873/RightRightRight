// buildTrack(stageDef, scene, quality) -> Track   (see docs/CONTRACTS.md)
// Orchestrates path generation, elevation, features, terrain, road ribbon, scenery and the runtime queries.
import * as THREE from 'three';
import { generatePath, PATH_STEP } from './world/path.js';
import { BIOMES } from './world/biomes.js';
import { mulberry32, fbm1, ss, clamp, wrapAngle } from './world/noise.js';
import { makeLocator, newFrame } from './world/frame.js';
import { QUALITY, buildTerrainGrid, buildTerrainMeshes } from './world/terrain.js';
import { buildRoad, buildWater, buildBridges } from './world/road.js';
import { buildScenery } from './world/scenery.js';

const SURF_NAMES = ['tarmac', 'wet', 'gravel', 'dirt', 'sand', 'snow', 'ice', 'mud', 'grass', 'ash'];
const STEP = PATH_STEP;

function catmull(pts, f) {
  const n = pts.length;
  if (f <= pts[0][0]) return pts[0][1];
  if (f >= pts[n - 1][0]) return pts[n - 1][1];
  let k = 0;
  while (k < n - 2 && f > pts[k + 1][0]) k++;
  const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(n - 1, k + 2)];
  const t = (f - p1[0]) / (p2[0] - p1[0]);
  const m1 = (p2[1] - p0[1]) / Math.max(1e-6, p2[0] - p0[0]) * (p2[0] - p1[0]);
  const m2 = (p3[1] - p1[1]) / Math.max(1e-6, p3[0] - p1[0]) * (p2[0] - p1[0]);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}
const plat = (d, d0, d1, ramp) => ss(d0 - ramp, d0, d) * (1 - ss(d1, d1 + ramp, d));

function boxSmooth(arr, r) {
  const n = arr.length, out = new Float32Array(n);
  let s = 0;
  const get = (i) => arr[clamp(i, 0, n - 1)];
  for (let k = -r; k <= r; k++) s += get(k);
  for (let i = 0; i < n; i++) {
    out[i] = s / (2 * r + 1);
    s += get(i + r + 1) - get(i - r);
  }
  return out;
}

export function buildTrack(def, scene, quality = 'medium') {
  const q = QUALITY[quality] || QUALITY.medium;
  const cfg = def.gen;
  const rng = mulberry32((def.seed * 2654435761) ^ 0x9e3779b9);
  const disposables = [];
  const group = new THREE.Group();
  group.name = 'track-' + def.id;

  // ---------------------------------------------------------------- centerline
  const P = generatePath(cfg, def.seed);
  const N = P.n;
  const length = (N - 1) * STEP;
  const X = P.x, Z = P.z;
  const sh = new Float64Array(N - 1);
  for (let k = 0; k < N - 1; k++) sh[k] = Math.atan2(X[k + 1] - X[k], -(Z[k + 1] - Z[k]));
  const rawK = new Float32Array(N);
  const DX = new Float64Array(N), DZ = new Float64Array(N), RX = new Float64Array(N), RZ = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = sh[Math.max(0, i - 1)], b = sh[Math.min(N - 2, i)];
    const hd = a + 0.5 * wrapAngle(b - a);
    DX[i] = Math.sin(hd); DZ[i] = -Math.cos(hd); RX[i] = -DZ[i]; RZ[i] = DX[i];
    rawK[i] = i > 0 && i < N - 1 ? wrapAngle(sh[i] - sh[i - 1]) / STEP : 0;
  }
  const CURV = boxSmooth(rawK, 2);

  // ---------------------------------------------------------------- elevation
  const elev = cfg.elev;
  const prof = new Float64Array(N), noiseY = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = i * STEP;
    prof[i] = catmull(elev.profile, s / length);
    noiseY[i] = elev.hills[0] * fbm1(s / elev.hills[1], def.seed + 100, 3) + elev.hills2[0] * fbm1(s / elev.hills2[1], def.seed + 200, 2);
  }
  let nScale = 1;
  const base = new Float64Array(N);
  for (let it = 0; it < 6; it++) {
    let gmax = 0;
    for (let i = 0; i < N; i++) {
      base[i] = prof[i] + noiseY[i] * nScale;
      if (i > 0) gmax = Math.max(gmax, Math.abs(base[i] - base[i - 1]) / STEP);
    }
    if (gmax <= 0.085) break;
    nScale *= Math.max(0.3, 0.085 / gmax);
  }

  // ---------------------------------------------------------------- features
  const startDist = 40, finishDist = length - 40;
  const splits = [0.25, 0.5, 0.75].map(f => Math.round((startDist + (finishDist - startDist) * f) / STEP) * STEP);
  const occupied = [];
  const free = (a, b) => { for (const o of occupied) if (a < o[1] && b > o[0]) return false; return true; };
  const feats = []; // internal records
  const kmaxOver = (d0, d1) => {
    let m = 0;
    for (let i = Math.max(0, Math.floor(d0 / STEP)); i <= Math.min(N - 1, Math.ceil(d1 / STEP)); i++) m = Math.max(m, Math.abs(CURV[i]));
    return m;
  };
  const meanK = (d0, d1) => {
    let s = 0, n = 0;
    for (let i = Math.max(0, Math.floor(d0 / STEP)); i <= Math.min(N - 1, Math.ceil(d1 / STEP)); i++) { s += CURV[i]; n++; }
    return n ? s / n : 0;
  };
  const SPEC = { // [len range, extent before, extent after, kmax, pad]
    bridge:  { len: [26, 38], pre: 10, post: 10, kmax: 0.005, pad: 50 },
    water:   { len: [16, 26], pre: 10, post: 10, kmax: 0.006, pad: 40 },
    jump:    { len: [0, 0], pre: 60, post: 90, kmax: 0.0035, pad: 0 },
    narrows: { len: [50, 110], pre: 0, post: 0, kmax: 0.05, pad: 30 },
    caution: { len: [80, 180], pre: 0, post: 0, kmax: 1, pad: 30, bendy: true },
    crest:   { len: [0, 0], pre: 35, post: 35, kmax: 0.01, pad: 20 },
    bump:    { len: [0, 0], pre: 6, post: 6, kmax: 0.02, pad: 25 },
  };
  function place(type, forceAt) {
    const sp = SPEC[type];
    const len = sp.len[0] + (sp.len[1] - sp.len[0]) * rng();
    const lo = 170 + sp.pre, hi = length - 170 - len - sp.post;
    for (let t = 0; t < 400; t++) {
      let d = forceAt != null ? forceAt : lo + (hi - lo) * rng();
      d = Math.round(d / STEP) * STEP;
      if (d < lo || d > hi) { if (forceAt != null) { d = clamp(d, lo, hi); } else continue; }
      const a = d - sp.pre - sp.pad, b = d + len + sp.post + sp.pad;
      if (!free(a, b)) continue;
      if (forceAt == null && kmaxOver(d - sp.pre, d + len + sp.post) > sp.kmax * (t < 200 ? 1 : t < 320 ? 1.8 : 3)) continue;
      if (sp.bendy && t < 250 && Math.abs(meanK(d, d + len)) < 0.004) continue;
      occupied.push([a, b]);
      const rec = { type, dist: d, len };
      if (type === 'caution') {
        const mk = meanK(d, d + len);
        rec.side = Math.abs(mk) < 1e-4 ? (rng() < 0.5 ? 1 : -1) : (mk > 0 ? -1 : 1); // outside of the bend
      }
      if (type === 'jump') rec.H = 1.5 + rng();
      if (type === 'crest') { rec.H = 1.3 + 1.0 * rng(); rec.sig = 9 + 5 * rng(); }
      if (type === 'bump') { rec.H = 0.14 + 0.14 * rng(); }
      feats.push(rec);
      return rec;
    }
    return null;
  }
  const order = ['bridge', 'water', 'jump', 'narrows', 'caution', 'crest', 'bump'];
  // villages first so narrows can be forced into them
  const villages = (cfg.villages || []).map(([a, b]) => ({ i0: Math.round(a * length / STEP), i1: Math.round(b * length / STEP) }));
  for (const v of villages) {
    const mid = (v.i0 + v.i1) / 2 * STEP;
    place('narrows', mid - 30);
  }
  for (const t of order) {
    const n = (cfg.features && cfg.features[t]) || 0;
    for (let k = 0; k < n; k++) place(t);
  }
  feats.sort((a, b) => a.dist - b.dist);

  // ---------------------------------------------------------------- per-sample arrays
  const Y = new Float64Array(N), YREF = new Float64Array(N);
  const WIDTH = new Float32Array(N);
  const VALLEY = new Float32Array(N), DROPEX_L = new Float32Array(N), DROPEX_R = new Float32Array(N);
  const WL = new Float32Array(N);
  const waterFeats = [], bridges = [], narrowsList = [];
  for (let i = 0; i < N; i++) YREF[i] = base[i];
  for (const f of feats) { // flatten pads for bridge / water
    if (f.type !== 'bridge' && f.type !== 'water') continue;
    const c = Math.round((f.dist + f.len / 2) / STEP);
    const anchor = base[clamp(c, 0, N - 1)];
    f.anchor = anchor;
    const ramp = f.type === 'bridge' ? 30 : 25;
    for (let i = 0; i < N; i++) {
      const e = plat(i * STEP, f.dist, f.dist + f.len, ramp);
      if (e > 0) YREF[i] = YREF[i] + (anchor - YREF[i]) * e;
    }
  }
  for (let i = 0; i < N; i++) Y[i] = YREF[i];
  const wBase = new Float32Array(N);
  for (let i = 0; i < N; i++) wBase[i] = clamp(cfg.width + 0.7 * fbm1(i * STEP / 130, def.seed + 300, 2), 5.6, 9);
  for (let i = 0; i < N; i++) WIDTH[i] = wBase[i];
  const smooth01 = (u) => u * u * (3 - 2 * u);
  for (const f of feats) {
    const i0 = Math.max(0, Math.floor((f.dist - 120) / STEP)), i1 = Math.min(N - 1, Math.ceil((f.dist + f.len + 140) / STEP));
    for (let i = i0; i <= i1; i++) {
      const s = i * STEP, t = s - f.dist;
      switch (f.type) {
        case 'jump': {
          let j = 0;
          const Dd = f.H + 0.9;
          if (t >= -18 && t < 0) j = f.H * Math.pow((t + 18) / 18, 1.4);
          else if (t >= 0 && t < 22) j = f.H - Dd * smooth01(t / 22);
          else if (t >= 22 && t < 70) j = -0.9 * (1 - smooth01((t - 22) / 48));
          Y[i] += j; break;
        }
        case 'crest': Y[i] += f.H * Math.exp(-(t / f.sig) * (t / f.sig)); break;
        case 'bump': Y[i] += f.H * Math.exp(-(t / 2) * (t / 2)); break;
        case 'water': {
          const u = t / f.len;
          if (u > -0.05 && u < 1.05) Y[i] -= 0.7 * smooth01(clamp(u / 0.3, 0, 1)) * (1 - smooth01(clamp((u - 0.7) / 0.3, 0, 1)));
          break;
        }
        case 'bridge': VALLEY[i] = Math.max(VALLEY[i], plat(s, f.dist, f.dist + f.len, 8)); break;
        case 'narrows': {
          const e = plat(s, f.dist, f.dist + f.len, 10);
          if (e > 0) WIDTH[i] = WIDTH[i] + (5 - WIDTH[i]) * e;
          break;
        }
        case 'caution': {
          const e = plat(s, f.dist, f.dist + f.len, 25);
          if (f.side > 0) DROPEX_R[i] = Math.max(DROPEX_R[i], e); else DROPEX_L[i] = Math.max(DROPEX_L[i], e);
          break;
        }
      }
    }
    const ia = Math.round(f.dist / STEP), ib = Math.round((f.dist + f.len) / STEP);
    if (f.type === 'water') {
      f.level = f.anchor - 0.3;
      for (let i = Math.max(0, ia - 1); i <= Math.min(N - 1, ib + 1); i++) WL[i] = f.level;
      waterFeats.push({ i0: ia - 3, i1: ib + 3, level: f.level, halfW: 16 });
    } else if (f.type === 'bridge') {
      bridges.push({ i0: ia, i1: ib });
      waterFeats.push({ i0: ia - 6, i1: ib + 6, level: f.anchor - 7.0, halfW: 16, deco: true });
    } else if (f.type === 'narrows') narrowsList.push({ i0: ia, i1: ib });
  }
  const HW = new Float32Array(N);
  for (let i = 0; i < N; i++) HW[i] = WIDTH[i] / 2;
  const BANK = new Float32Array(N);
  for (let i = 0; i < N; i++) BANK[i] = clamp(CURV[i] * 3, -0.05, 0.05);

  // surfaces
  const SURF = new Uint8Array(N);
  {
    const zs = cfg.surfaces;
    for (let i = 0; i < N; i++) {
      const f = i * STEP / length;
      let k = 0;
      while (k < zs.length - 1 && f >= zs[k + 1][0]) k++;
      SURF[i] = SURF_NAMES.indexOf(zs[k][1]);
    }
  }
  // biomes
  const biomeNames = [];
  const BIO = new Uint8Array(N);
  {
    const bz = cfg.biomes || [[0, def.biome === 'mixed' ? 'forest' : def.biome]];
    for (const [, b] of bz) if (!biomeNames.includes(b)) biomeNames.push(b);
    for (let i = 0; i < N; i++) {
      const f = i * STEP / length;
      let k = 0;
      while (k < bz.length - 1 && f >= bz[k + 1][0]) k++;
      BIO[i] = biomeNames.indexOf(bz[k][1]);
    }
  }
  const bps = biomeNames.map(n => BIOMES[n]);
  // snow amount (terrain tint / snowbanks)
  let SNOW = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const sn = SURF_NAMES[SURF[i]];
    SNOW[i] = bps[BIO[i]].snow ? 1 : (sn === 'snow' || sn === 'ice') ? 1 : 0;
  }
  SNOW = boxSmooth(SNOW, 40);
  // side walls / drop-offs
  const wl = new Float32Array(N), wr = new Float32Array(N), dl = new Float32Array(N), dr = new Float32Array(N);
  {
    const hair = P.pieces.filter(p => p.type === 'hairpin').map(p => (p.s + p.len / 2) / STEP);
    let hp = 0, parity = 1;
    for (let i = 0; i < N; i++) {
      while (hp < hair.length && i >= hair[hp]) { parity = -parity; hp++; }
      const mode = bps[BIO[i]].side;
      if (mode === 'zig') {
        const dropAmt = clamp(0.55 + 0.7 * fbm1(i * STEP / 150, def.seed + 400, 2), 0, 1);
        if (parity > 0) { wr[i] = 1; dl[i] = dropAmt; } else { wl[i] = 1; dr[i] = dropAmt; }
      } else if (mode === 'sea') {
        const f = i * STEP / length;
        let sd = 1;
        if (cfg.sea) for (const [a, b, s] of cfg.sea) if (f >= a && f < b) sd = s;
        if (sd > 0) { dr[i] = 1; wl[i] = 0.6; } else { dl[i] = 1; wr[i] = 0.6; }
      } else if (mode === 'canyon') { wl[i] = 1; wr[i] = 1; }
    }
  }
  const WALLL = boxSmooth(wl, 25), WALLR = boxSmooth(wr, 25), DROPL = boxSmooth(dl, 25), DROPR = boxSmooth(dr, 25);
  for (let i = 0; i < N; i++) { DROPL[i] = Math.max(DROPL[i], DROPEX_L[i]); DROPR[i] = Math.max(DROPR[i], DROPEX_R[i]); }

  const VIL = new Uint8Array(N);
  for (const v of villages) for (let i = v.i0; i <= v.i1 && i < N; i++) VIL[i] = 1;

  // sea
  let seaY = null;
  let floorY = -1e9;
  if (def.biome === 'coast') {
    let mn = Infinity;
    for (let i = 0; i < N; i++) mn = Math.min(mn, YREF[i]);
    seaY = mn - 12;
    floorY = seaY - 5;
  }

  const W = {
    N, step: STEP, X, Z, Y, YREF, DX, DZ, RX, RZ, HW, BANK, VALLEY, WALLL, WALLR, DROPL, DROPR,
    BIO, SNOW, SURF, WL, VIL, surfNames: SURF_NAMES, biomeNames, floorY, seed: def.seed,
    waterFeats, bridges, narrows: narrowsList, villages, pieces: P.pieces,
  };

  // ---------------------------------------------------------------- terrain + meshes
  const L = makeLocator(W);
  const grid = buildTerrainGrid(W, L, quality);
  buildTerrainMeshes(W, grid, group, disposables);
  const roadMeshes = buildRoad(W, q, group, disposables);

  // colliders (spatial hash, 16 m cells)
  const HC = 16, hashMap = new Map();
  let colliderCount = 0;
  const hkey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
  function addCollider(x, z, r, kind) {
    const k = hkey(Math.floor(x / HC), Math.floor(z / HC));
    let a = hashMap.get(k); if (!a) hashMap.set(k, a = []);
    a.push({ x, z, r, kind });
    colliderCount++;
  }
  buildWater(W, group, disposables);
  buildBridges(W, group, disposables, addCollider);
  const pubFeatures = feats.map(f => (f.len > 0 ? { dist: f.dist, type: f.type, len: f.len } : { dist: f.dist, type: f.type }));
  const sc = buildScenery({
    W, q, quality, rng, group, disposables, addCollider, grid, loc: L, features: feats, pieces: P.pieces,
    startDist, finishDist, splits,
  });
  if (seaY !== null) {
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < N; i++) { mnx = Math.min(mnx, X[i]); mxx = Math.max(mxx, X[i]); mnz = Math.min(mnz, Z[i]); mxz = Math.max(mxz, Z[i]); }
    const g = new THREE.PlaneGeometry(mxx - mnx + 1200, mxz - mnz + 1200);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshLambertMaterial({ color: 0x2b6f9c, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set((mnx + mxx) / 2, seaY, (mnz + mxz) / 2);
    mesh.renderOrder = 1;
    group.add(mesh);
    disposables.push(g, m);
  }
  scene.add(group);

  // ---------------------------------------------------------------- public sample objects
  const samples = new Array(N);
  for (let i = 0; i < N; i++) {
    samples[i] = {
      x: X[i], y: Y[i], z: Z[i], dist: i * STEP, dirX: DX[i], dirZ: DZ[i], curvature: CURV[i],
      width: WIDTH[i], surface: SURF_NAMES[SURF[i]], bank: BANK[i],
    };
  }
  const offNames = bps.map(b => b.offroad);
  const mainOff = def.biome === 'mixed' ? 'grass' : offNames[0];

  // ---------------------------------------------------------------- runtime queries
  const F = newFrame();
  const { climb, frame, loc } = L;
  const { x0, z0, inv, nx: gnx, nz: gnz, cnx, cnz, H, OK, IDX, cell } = grid;
  const GH = H, GOK = OK, GIDX = IDX;

  function gridIdxAt(x, z) {
    const gx = Math.round((x - x0) * inv), gz = Math.round((z - z0) * inv);
    if (gx < 0 || gz < 0 || gx >= gnx || gz >= gnz) return -1;
    return GIDX[gz * gnx + gx];
  }
  function seedIndex(x, z) {
    const gi = gridIdxAt(x, z);
    if (gi >= 0) return gi;
    let best = Infinity, bi = 0;
    for (let i = 0; i < N; i += 8) {
      const dx = x - X[i], dz = z - Z[i], d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  }
  function locate(x, z, cache) {
    let i = cache.i;
    if (!(i >= 0 && i < N)) i = seedIndex(x, z);
    i = climb(x, z, i);
    frame(x, z, i, F);
    const lat = F.lat;
    if ((lat > F.hw + 0.5 || lat < -F.hw - 0.5) && loc.best > 4) {
      const gi = gridIdxAt(x, z);
      if (gi >= 0 && (gi > i + 6 || gi < i - 6)) {
        const b1 = loc.best;
        const i2 = climb(x, z, gi);
        if (loc.best < b1) { i = i2; frame(x, z, i, F); }
      }
    }
    cache.i = i;
    return i;
  }

  function groundAt(x, z, cache, out) {
    locate(x, z, cache);
    const lat = F.lat, E = F.hw + 0.5, a = F.a;
    if (lat <= E && lat >= -E) {
      const h = F.yc - lat * F.bank;
      const gxn = F.slope * F.dx - F.bank * F.rx, gzn = F.slope * F.dz - F.bank * F.rz;
      const il = 1 / Math.sqrt(gxn * gxn + gzn * gzn + 1);
      out.height = h; out.nx = -gxn * il; out.ny = il; out.nz = -gzn * il;
      out.surface = SURF_NAMES[SURF[F.u < 0.5 ? a : a + 1]];
      out.onRoad = true;
      const wl = WL[a];
      out.water = wl > 0 ? clamp((wl - h) / 0.35, 0, 1) : 0;
      return out;
    }
    out.onRoad = false;
    out.surface = offNames[BIO[a]];
    const gx = (x - x0) * inv, gz = (z - z0) * inv;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    if (ix < 0 || iz < 0 || ix >= cnx || iz >= cnz || GOK[iz * cnx + ix] === 0) {
      out.height = F.yr - 3; out.nx = 0; out.ny = 1; out.nz = 0; out.water = 0;
      return out;
    }
    const fx = gx - ix, fz = gz - iz;
    const v = iz * gnx + ix;
    const h00 = GH[v];
    let dhx, dhz, h;
    if (fx >= fz) {
      const h10 = GH[v + 1], h11 = GH[v + gnx + 1];
      dhx = (h10 - h00) * inv; dhz = (h11 - h10) * inv;
      h = h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    } else {
      const h01 = GH[v + gnx], h11 = GH[v + gnx + 1];
      dhx = (h11 - h01) * inv; dhz = (h01 - h00) * inv;
      h = h00 + (h11 - h01) * fx + (h01 - h00) * fz;
    }
    const il = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1);
    out.height = h; out.nx = -dhx * il; out.ny = il; out.nz = -dhz * il;
    let w = 0;
    if (seaY !== null && h < seaY) w = 1;
    else {
      const wl = WL[a];
      if (wl > 0 && lat < 20 && lat > -20) w = clamp((wl - h) / 0.35, 0, 1);
    }
    out.water = w;
    return out;
  }

  function project(x, z, cache, out) {
    const i = locate(x, z, cache);
    out.dist = (F.a + F.u) * STEP;
    out.lateral = F.lat;
    out.index = F.u < 0.5 ? F.a : F.a + 1;
    out.width = F.hw * 2;
    return out;
  }

  function sampleAt(dist, out) {
    if (!out.pos) out.pos = new THREE.Vector3();
    if (!out.dir) out.dir = new THREE.Vector3();
    if (!out.right) out.right = new THREE.Vector3();
    let s = dist / STEP;
    if (s < 0) s = 0; else if (s > N - 1) s = N - 1;
    let i = Math.floor(s); if (i > N - 2) i = N - 2;
    const u = s - i, j = i + 1;
    out.pos.set(X[i] + (X[j] - X[i]) * u, Y[i] + (Y[j] - Y[i]) * u, Z[i] + (Z[j] - Z[i]) * u);
    let dx = DX[i] + (DX[j] - DX[i]) * u, dz = DZ[i] + (DZ[j] - DZ[i]) * u;
    const l = Math.sqrt(dx * dx + dz * dz) || 1; dx /= l; dz /= l;
    out.dir.set(dx, 0, dz);
    out.right.set(-dz, 0, dx);
    out.width = WIDTH[i] + (WIDTH[j] - WIDTH[i]) * u;
    out.surface = SURF_NAMES[SURF[u < 0.5 ? i : j]];
    out.curvature = CURV[i] + (CURV[j] - CURV[i]) * u;
    return out;
  }

  const nearList = [];
  function collidersNear(x, z, radius) {
    nearList.length = 0;
    const r = radius + 3.6;
    const ca = Math.floor((x - r) / HC), cb = Math.floor((x + r) / HC);
    const za = Math.floor((z - r) / HC), zb = Math.floor((z + r) / HC);
    for (let cx = ca; cx <= cb; cx++) for (let cz = za; cz <= zb; cz++) {
      const arr = hashMap.get(hkey(cx, cz));
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const c = arr[k];
        const dx = c.x - x, dz = c.z - z, rr = radius + c.r;
        if (dx * dx + dz * dz <= rr * rr) nearList.push(c);
      }
    }
    return nearList;
  }

  const startIdx = clamp(Math.round(startDist / STEP), 0, N - 1);
  const startPos = new THREE.Vector3(X[startIdx], Y[startIdx], Z[startIdx]);
  const startDir = new THREE.Vector3(DX[startIdx], 0, DZ[startIdx]);

  let disposed = false;
  const track = {
    def, step: STEP, samples, length, startDist, finishDist, splits, features: pubFeatures,
    startPos, startDir, offroadSurface: mainOff,
    groundAt, project, sampleAt, collidersNear,
    update(dt, camera) { /* static world: nothing to animate */ },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group.clear();
      hashMap.clear();
    },
    // extras (not in the contract)
    seaY, pieces: P.pieces, gen: { attempts: P.attempts, sepRatio: P.sepRatio, minFar: P.minFar },
    stats: { colliders: colliderCount, sceneryTris: sc.triCount, sceneryInstances: sc.instanceCount, grid: { cell, w: gnx, h: gnz } },
    group, world: W,
  };
  return track;
}
