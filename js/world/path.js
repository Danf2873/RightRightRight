// Centerline generation: seeded sequence of corner elements (clothoid-ish transitions + constant
// radius arcs), explicit set pieces, curvature noise, and a self-proximity check with retries.
// Convention: heading h, direction = (sin h, -cos h), right = (cos h, sin h), dh/ds = curvature (+ = right).
import { mulberry32, vnoise1, wrapAngle, clamp } from './noise.js';

export const PATH_STEP = 2;
const D2R = Math.PI / 180;

const KINDS = {
  flat:    { R: [220, 420], A: [5, 22] },
  fast:    { R: [110, 220], A: [18, 55] },
  medium:  { R: [55, 110],  A: [30, 85] },
  slow:    { R: [28, 55],   A: [45, 110] },
  tight:   { R: [14, 28],   A: [70, 130] },
  sweeper: { R: [130, 260], A: [55, 140] },
  square:  { R: [12, 18],   A: [85, 95] },
  hairpin: { R: [12, 16],   A: [165, 190] },
};

function genOnce(cfg, seed) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const STEP = PATH_STEP;
  const segs = [];
  let covered = 0, ptr = 0, j = 0;
  let x = 0, z = 0, h = cfg.heading || 0;
  const h0 = h;
  const xs = [0], zs = [0];
  const pieces = [];
  const CS = 40, grid = new Map();
  const gkey = (cx, cz) => cx * 100003 + cz;
  function gadd(i) {
    const k = gkey(Math.floor(xs[i] / CS), Math.floor(zs[i] / CS));
    let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
  }
  function gremove(i) {
    const a = grid.get(gkey(Math.floor(xs[i] / CS), Math.floor(zs[i] / CS)));
    a.pop();
  }
  // worst separation ratio of point i vs earlier points
  function sepOf(i) {
    let worst = Infinity;
    const cx = Math.floor(xs[i] / CS), cz = Math.floor(zs[i] / CS);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const arr = grid.get(gkey(cx + a, cz + b));
      if (!arr) continue;
      for (let q = 0; q < arr.length; q++) {
        const jx = arr[q];
        if (jx >= i) continue;
        const arc = (i - jx) * STEP;
        if (arc < 60) continue;
        const dx = xs[i] - xs[jx], dz = zs[i] - zs[jx];
        const r = Math.sqrt(dx * dx + dz * dz) / (arc > 250 ? 40 : 18);
        if (r < worst) worst = r;
      }
    }
    return worst;
  }
  gadd(0);
  const noiseAmp = cfg.noiseAmp ?? 0.0022, noiseWave = cfg.noiseWave ?? 90, nSeed = (seed * 7 + 13) | 0;

  function kap(s) {
    while (ptr < segs.length - 1 && s > segs[ptr].s0 + segs[ptr].len) ptr++;
    const g = segs[ptr];
    const t = g.len > 0 ? clamp((s - g.s0) / g.len, 0, 1) : 0;
    return g.k0 + (g.k1 - g.k0) * t;
  }
  function advance() {
    while ((j + 1) * STEP <= covered + 1e-9) {
      const sm = (j + 0.5) * STEP;
      const k = kap(sm) + noiseAmp * vnoise1(sm / noiseWave, nSeed);
      const hm = h + k * STEP * 0.5;
      x += Math.sin(hm) * STEP; z -= Math.cos(hm) * STEP;
      h += k * STEP;
      j++; xs.push(x); zs.push(z); gadd(j);
    }
  }
  function push(len, k0, k1) {
    if (len <= 0) return;
    segs.push({ s0: covered, len, k0, k1 });
    covered += len;
    advance();
  }
  function corner(sign, angle, radius) {
    const k = 1 / radius;
    let Ls = clamp(0.5 * radius, 6, 40);
    if (k * Ls > angle) Ls = angle / k;
    const arc = (angle - k * Ls) / k;
    push(Ls, 0, sign * k);
    if (arc > 0.01) push(arc, sign * k, sign * k);
    push(Ls, sign * k, 0);
    return 2 * Ls + Math.max(0, arc);
  }
  function pickSign() {
    const off = x * Math.cos(h0) + z * Math.sin(h0);
    const hDes = h0 - clamp(off / 450, -1, 1) * 0.9;
    const d = wrapAngle(h - hDes);
    if (d > 1.4) return -1;
    if (d < -1.4) return 1;
    return rng() < 1 / (1 + Math.exp(d / 0.5)) ? 1 : -1;
  }
  function devSign() { // corrective sign if heading is off, else random
    const off = x * Math.cos(h0) + z * Math.sin(h0);
    const d = wrapAngle(h - (h0 - clamp(off / 450, -1, 1) * 0.9));
    if (Math.abs(d) > 0.6) return d > 0 ? -1 : 1;
    return rng() < 0.5 ? 1 : -1;
  }
  function simple(kind, sign) {
    const k = KINDS[kind];
    const r = R(k.R[0], k.R[1]);
    const a = R(k.A[0], k.A[1]) * D2R;
    const s0 = covered;
    const len = corner(sign, a, r);
    pieces.push({ type: kind, s: s0, len, dir: sign, radius: r, angle: a / D2R });
  }
  function chicane() {
    const n = rng() < 0.4 ? 3 : 2;
    let sign = pickSign();
    const firstSign = sign;
    const s0 = covered;
    for (let i = 0; i < n; i++) {
      corner(sign, R(25, 50) * D2R, R(35, 70));
      if (i < n - 1) push(R(6, 22), 0, 0);
      sign = -sign;
    }
    pieces.push({ type: 'chicane', s: s0, len: covered - s0, dir: firstSign, radius: 50, angle: 0 });
  }
  function tighten(opening) {
    const sign = pickSign();
    const r1 = R(70, 120), r2 = R(22, 40);
    const ra = opening ? r2 : r1, rb = opening ? r1 : r2;
    const ka = sign / ra, kb = sign / rb;
    const s0 = covered;
    const Ls = 14;
    push(Ls, 0, ka);
    push(R(30, 60), ka, ka);
    push(R(20, 40), ka, kb);
    push(R(35, 65), kb, kb);
    push(Ls, kb, 0);
    pieces.push({ type: opening ? 'opens' : 'tightens', s: s0, len: covered - s0, dir: sign, radius: r2, angle: 0 });
  }
  function hairpinChain() {
    let sign = devSign();
    simple('hairpin', sign);
    if (cfg.zig) {
      const chain = 1 + Math.floor(rng() * cfg.zig);
      for (let i = 0; i < chain; i++) {
        push(R(cfg.zigStraight?.[0] ?? 70, cfg.zigStraight?.[1] ?? 160), 0, 0);
        sign = -sign;
        simple('hairpin', sign);
      }
    }
  }

  // forced set pieces spaced through the stage
  const forced = [];
  for (const [kind, n] of Object.entries(cfg.sets || {})) for (let i = 0; i < n; i++) forced.push(kind);
  for (let i = forced.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [forced[i], forced[k]] = [forced[k], forced[i]]; }
  const usable = cfg.length - 300;
  const forcedAt = forced.map((_, i) => 130 + (i + 0.2 + 0.6 * rng()) * usable / forced.length);

  const mixKeys = Object.keys(cfg.mix), mixW = mixKeys.map(k => cfg.mix[k]);
  const mixSum = mixW.reduce((a, b) => a + b, 0);
  const st = cfg.straight || [40, 200];
  const link = cfg.linkProb ?? 0.35;
  let fi = 0, first = true;
  while (covered < cfg.length - 150) {
    const snap = { covered, ptr, j, x, z, h, segs: segs.length, pieces: pieces.length, fi, first };
    let tries = 0, ok = false;
    while (!ok) {
      let L = first ? 130 : rng() < link ? R(0, 25) : R(st[0], st[1]);
      if (tries > 3) L = Math.min(L, R(0, 20));
      first = false;
      push(L, 0, 0);
      const jBefore = j;
      let kind;
      if (fi < forced.length && covered >= forcedAt[fi]) kind = forced[fi++];
      else {
        let r = rng() * mixSum; kind = mixKeys[0];
        for (let i = 0; i < mixKeys.length; i++) { r -= mixW[i]; if (r <= 0) { kind = mixKeys[i]; break; } }
      }
      if (kind === 'hairpin') hairpinChain();
      else if (kind === 'chicane') chicane();
      else if (kind === 'tighten') tighten(false);
      else if (kind === 'open') tighten(true);
      else simple(kind, kind === 'square' ? devSign() : pickSign());
      let worst = Infinity;
      for (let i = jBefore - 1; i <= j; i++) { const w = sepOf(i); if (w < worst) worst = w; }
      ok = worst >= 1 || tries >= 14;
      if (!ok) {
        tries++;
        for (let i = j; i > snap.j; i--) gremove(i);
        xs.length = snap.j + 1; zs.length = snap.j + 1;
        segs.length = snap.segs; pieces.length = snap.pieces;
        covered = snap.covered; ptr = snap.ptr; j = snap.j; x = snap.x; z = snap.z; h = snap.h;
        fi = snap.fi; first = snap.first;
      }
    }
  }
  push(150, 0, 0);

  const n = xs.length;
  return { x: Float64Array.from(xs), z: Float64Array.from(zs), n, pieces };
}

/** Returns worst ratio (distance / required) over non-adjacent pairs. >= 1 is OK. Also min raw distance for far pairs. */
export function checkSeparation(px, pz, n, step = PATH_STEP) {
  const cs = 40;
  const grid = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(px[i] / cs), Math.floor(pz[i] / cs));
    let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
  }
  let worst = Infinity, minFar = Infinity;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(px[i] / cs), cz = Math.floor(pz[i] / cs);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const arr = grid.get(key(cx + a, cz + b));
      if (!arr) continue;
      for (let q = 0; q < arr.length; q++) {
        const jx = arr[q];
        if (jx <= i) continue;
        const arc = (jx - i) * step;
        if (arc < 60) continue;
        const dx = px[i] - px[jx], dz = pz[i] - pz[jx];
        const d = Math.sqrt(dx * dx + dz * dz);
        const req = arc > 250 ? 40 : 18;
        const r = d / req;
        if (r < worst) worst = r;
        if (arc > 250 && d < minFar) minFar = d;
      }
    }
  }
  return { worst, minFar };
}

export function generatePath(cfg, seed) {
  let best = null, bestScore = -Infinity;
  for (let t = 0; t < 40; t++) {
    const p = genOnce(cfg, (seed + t * 7919) | 0);
    const c = checkSeparation(p.x, p.z, p.n);
    p.attempts = t + 1; p.sepRatio = c.worst; p.minFar = c.minFar;
    if (c.worst >= 1) return p;
    if (c.worst > bestScore) { bestScore = c.worst; best = p; }
  }
  return best;
}
