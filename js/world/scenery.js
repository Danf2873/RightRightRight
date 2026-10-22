// Scenery: instanced low-poly props placed by biome, chunked (~256 m) for frustum culling, plus gates,
// signs, spectators, villages. Every solid object registers a collider circle through ctx.addCollider.
import * as THREE from 'three';
import { BIOMES } from './biomes.js';
import { bake, box, mat } from './geo.js';
import { gridHeight } from './terrain.js';
import { newFrame } from './frame.js';
import { clamp } from './noise.js';

const CH = 256;
const SHADOW_KINDS = new Set(['conifer', 'snowconifer', 'pine', 'deciduous', 'palm', 'cypress', 'dead', 'rock', 'house']);

function cone(r, h, seg, open = true) { return new THREE.ConeGeometry(r, h, seg, 1, open); }
function cyl(r0, r1, h, seg) { return new THREE.CylinderGeometry(r0, r1, h, seg, 1, false); }
function ico(r) { return new THREE.IcosahedronGeometry(r, 0); }

function makeGeometry(kind, color) {
  const P = [];
  switch (kind) {
    case 'conifer':
    case 'snowconifer': {
      const snow = kind === 'snowconifer';
      const c1 = snow ? 0x35553a : 0x2d4d2a, c2 = snow ? 0x426148 : 0x38612f, c3 = snow ? 0xe6eef2 : 0x42702f;
      P.push({ g: cyl(0.16, 0.22, 1.6, 4), color: 0x4f3a28, m: mat(0, 0.8, 0) });
      P.push({ g: cone(2.2, 3.0, 5), color: c1, m: mat(0, 2.5, 0, 1, 1, 1, 0, 0.3, 0) });
      P.push({ g: cone(1.7, 2.8, 5), color: c2, m: mat(0, 4.1, 0, 1, 1, 1, 0, 0.9, 0) });
      P.push({ g: cone(1.1, 2.5, 5), color: c3, m: mat(0, 5.6, 0, 1, 1, 1, 0, 0.1, 0) });
      break;
    }
    case 'pine':
      P.push({ g: cyl(0.14, 0.22, 4.2, 4), color: 0x5a4331, m: mat(0, 2.1, 0) });
      P.push({ g: ico(2.3), color: 0x3d5e2c, m: mat(0, 5.0, 0, 1.3, 0.55, 1.3), jit: 0.12 });
      break;
    case 'deciduous':
      P.push({ g: cyl(0.16, 0.26, 2.4, 4), color: 0x5a4331, m: mat(0, 1.2, 0) });
      P.push({ g: ico(2.0), color: 0x4f7a32, m: mat(0, 3.5, 0, 1, 0.9, 1), jit: 0.15 });
      P.push({ g: ico(1.3), color: 0x5d8a3a, m: mat(0.9, 4.3, 0.3), jit: 0.12 });
      break;
    case 'cypress':
      P.push({ g: cyl(0.12, 0.18, 1, 4), color: 0x4f3a28, m: mat(0, 0.5, 0) });
      P.push({ g: cone(0.95, 6.5, 5), color: 0x2c4a2a, m: mat(0, 4.0, 0) });
      break;
    case 'palm': {
      P.push({ g: cyl(0.12, 0.22, 6.4, 5), color: 0x7a6342, m: mat(0, 3.2, 0, 1, 1, 1, 0, 0, 0.06) });
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3;
        P.push({ g: cone(0.55, 3.0, 3), color: 0x3f7a35, m: mat(Math.cos(a) * 1.1, 6.4, Math.sin(a) * 1.1, 1, 1, 1, 0, -a, 1.25) });
      }
      break;
    }
    case 'dead':
      P.push({ g: cyl(0.1, 0.26, 4.2, 4), color: color || 0x5b4d40, m: mat(0, 2.1, 0) });
      P.push({ g: cyl(0.04, 0.1, 1.8, 3), color: color || 0x5b4d40, m: mat(0.5, 3.4, 0, 1, 1, 1, 0, 0, -0.9) });
      P.push({ g: cyl(0.04, 0.09, 1.5, 3), color: color || 0x5b4d40, m: mat(-0.4, 2.9, 0.2, 1, 1, 1, 0.5, 0, 0.8) });
      P.push({ g: cyl(0.03, 0.08, 1.2, 3), color: color || 0x5b4d40, m: mat(0, 3.9, -0.4, 1, 1, 1, -0.9, 0, 0.1) });
      break;
    case 'bush':
      P.push({ g: ico(0.85), color: color || 0x4b6a35, m: mat(0, 0.4, 0, 1.25, 0.75, 1.25), jit: 0.1 });
      break;
    case 'rock':
      P.push({ g: ico(1), color: color || 0x8a8a86, m: mat(0, 0.45, 0, 1, 0.72, 1), jit: 0.22 });
      break;
    case 'lavarock':
      P.push({ g: ico(1), color: 0x1a191d, m: mat(0, 0.45, 0, 1, 0.72, 1), jit: 0.22 });
      P.push({ g: ico(0.45), color: 0xe0541a, m: mat(0.15, 0.85, 0.1, 1, 0.6, 1), jit: 0.1 });
      break;
    case 'bank':
      P.push({ g: ico(1), color: 0xf1f5fa, m: mat(0, 0.2, 0, 2.0, 0.75, 1.2), jit: 0.1 });
      break;
    case 'house': {
      P.push({ g: box(7.2, 3.2, 5.6), color: color || 0xe6d9bd, m: mat(0, 1.6, 0) });
      const rf = cone(5.4, 2.0, 4, false); rf.rotateY(Math.PI / 4);
      P.push({ g: rf, color: 0xa4472e, m: mat(0, 4.2, 0, 1.0, 1, 0.78) });
      P.push({ g: box(0.9, 1.9, 0.12), color: 0x5a3b26, m: mat(1.2, 0.95, 2.82) });
      P.push({ g: box(1.0, 0.9, 0.12), color: 0x6b8ea8, m: mat(-1.6, 1.9, 2.82) });
      P.push({ g: box(0.8, 1.4, 0.8), color: 0x7d6b5a, m: mat(-2.4, 4.6, -1.2) });
      break;
    }
    case 'wall':
      P.push({ g: box(2.0, 0.95, 0.62), color: 0x9d968a, m: mat(0, 0.47, 0), jit: 0.02 });
      break;
    case 'fence':
      P.push({ g: box(0.12, 1.0, 0.12), color: 0x8b6f47, m: mat(-1.1, 0.5, 0) });
      P.push({ g: box(0.12, 1.0, 0.12), color: 0x8b6f47, m: mat(1.1, 0.5, 0) });
      P.push({ g: box(2.4, 0.09, 0.05), color: 0x9a7d52, m: mat(0, 0.8, 0) });
      P.push({ g: box(2.4, 0.09, 0.05), color: 0x9a7d52, m: mat(0, 0.45, 0) });
      break;
    case 'post':
      P.push({ g: box(0.13, 1.1, 0.13), color: 0xf0efe8, m: mat(0, 0.55, 0) });
      P.push({ g: box(0.14, 0.28, 0.14), color: 0xd03a2e, m: mat(0, 0.95, 0) });
      break;
    case 'chevron':
      P.push({ g: box(0.08, 1.9, 0.08), color: 0x555555, m: mat(0, 0.95, 0) });
      P.push({ g: box(1.15, 0.95, 0.05), color: 0xf2c200, m: mat(0, 1.65, 0) });
      P.push({ g: box(0.55, 0.13, 0.06), color: 0x151515, m: mat(-0.2, 1.8, 0.01, 1, 1, 1, 0, 0, -0.7) });
      P.push({ g: box(0.55, 0.13, 0.06), color: 0x151515, m: mat(-0.2, 1.5, 0.01, 1, 1, 1, 0, 0, 0.7) });
      break;
    case 'hay': {
      const g = cyl(0.72, 0.72, 1.3, 8); g.rotateZ(Math.PI / 2);
      P.push({ g, color: 0xc9a84c, m: mat(0, 0.72, 0) });
      break;
    }
    case 'spectator': {
      P.push({ g: new THREE.CapsuleGeometry(0.22, 0.85, 2, 5), color: 0xffffff, m: mat(0, 0.85, 0) });
      P.push({ g: ico(0.15), color: 0xe0b890, m: mat(0, 1.65, 0) });
      break;
    }
    case 'vine':
      P.push({ g: box(3.8, 0.95, 0.75), color: 0x5d7d33, m: mat(0, 0.5, 0), jit: 0.05 });
      break;
    default:
      P.push({ g: box(1, 1, 1), color: 0xff00ff });
  }
  const g = bake(P);
  g.computeBoundingSphere();
  return g;
}

const SPECT_COLORS = [0xd03030, 0x2f6fd0, 0xf0c020, 0x30a050, 0xffffff, 0xe07020, 0x8030b0, 0x20b0c0, 0x303030];

export function buildScenery(ctx) {
  const { W, q, rng, group, disposables, addCollider, grid, loc } = ctx;
  const Q = q.scenery;
  const F = newFrame();
  const geoCache = new Map();
  const buckets = new Map();
  const matCache = new Map();
  const bps = W.biomeNames.map(n => BIOMES[n]);
  const N = W.N;
  const tmpCol = new THREE.Color();

  function geoFor(kind, color) {
    const key = kind + '|' + (color || 0);
    let g = geoCache.get(key);
    if (!g) { g = makeGeometry(kind, color); geoCache.set(key, g); disposables.push(g); }
    return key;
  }
  function inst(kind, color, x, y, z, yaw, sx, sy, sz, tint) {
    const key = geoFor(kind, color);
    const bk = key + '@' + Math.floor(x / CH) + ',' + Math.floor(z / CH);
    let b = buckets.get(bk);
    if (!b) { b = { key, kind, data: [] }; buckets.set(bk, b); }
    b.data.push(x, y, z, yaw, sx, sy, sz, tint);
  }
  const tintV = (lo = 0.82, hi = 1.18) => lo + (hi - lo) * rng();

  function hGround(x, z) { return gridHeight(grid, x, z); }
  function slopeOK(x, z, h, maxD = 0.6) {
    const a = gridHeight(grid, x + 1.5, z), b = gridHeight(grid, x, z + 1.5);
    if (a !== a || b !== b) return false;
    return Math.abs(a - h) < maxD * 1.5 && Math.abs(b - h) < maxD * 1.5;
  }
  /** distance from the road edge (E = hw+0.5) to nearest road at x,z; hint = sample index */
  function edgeDist(x, z, hint) {
    let i = loc.climb(x, z, hint), b = loc.best;
    const gx = Math.floor((x - grid.x0) * grid.inv), gz = Math.floor((z - grid.z0) * grid.inv);
    if (gx >= 0 && gz >= 0 && gx < grid.nx && gz < grid.nz) {
      const gi = grid.IDX[gz * grid.nx + gx];
      if (gi >= 0) { const i2 = loc.climb(x, z, gi); if (loc.best < b) { i = i2; b = loc.best; } }
    }
    loc.frame(x, z, i, F);
    return Math.abs(F.lat) - (F.hw + 0.5);
  }
  /** position at sample i, lateral l (+right), along offset a */
  function pointAt(i, l, a, out) {
    out.x = W.X[i] + W.DX[i] * a + W.RX[i] * l;
    out.z = W.Z[i] + W.DZ[i] * a + W.RZ[i] * l;
    return out;
  }
  const P = { x: 0, z: 0 };
  const yawAlong = (i) => Math.atan2(-W.DZ[i], W.DX[i]);

  // ---- vegetation / rocks by biome ----------------------------------------------------------
  for (let i = 2; i < N - 2; i++) {
    const bp = bps[W.BIO[i]];
    const vil = W.VIL[i];
    const hwE = W.HW[i] + 0.5;
    const snowy = W.SNOW[i] > 0.6;
    const dTree = vil ? 0.3 : snowy && bp.trees[0][0] === 'conifer' ? 0.2 : 1;
    for (let sd = -1; sd <= 1; sd += 2) {
      // trees
      let e = bp.treeDens * 0.02 * Q * dTree;
      let n = Math.floor(e + rng());
      for (let k = 0; k < n; k++) {
        const lat = 1.7 + (bp.treeBand - 1.7) * Math.pow(rng(), 1.9);
        pointAt(i, sd * (hwE + lat), (rng() - 0.5) * 2, P);
        const h = hGround(P.x, P.z);
        if (h !== h) continue;
        if (edgeDist(P.x, P.z, i) < 1.6) continue;
        if (!slopeOK(P.x, P.z, h, 0.8)) continue;
        let r = rng() * bp.trees.reduce((a, t) => a + t[1], 0), kind = bp.trees[0][0];
        for (const t of bp.trees) { r -= t[1]; if (r <= 0) { kind = t[0]; break; } }
        const s = 0.75 + 0.7 * rng();
        inst(kind, 0, P.x, h - 0.1, P.z, rng() * 6.28, s, s * (0.9 + 0.3 * rng()), s, tintV());
        addCollider(P.x, P.z, 0.32 * s + 0.1, 'tree');
      }
      // rocks
      e = bp.rockDens * 0.02 * Q;
      n = Math.floor(e + rng());
      for (let k = 0; k < n; k++) {
        const lat = 1.8 + 50 * Math.pow(rng(), 2.2);
        pointAt(i, sd * (hwE + lat), (rng() - 0.5) * 2, P);
        const h = hGround(P.x, P.z);
        if (h !== h) continue;
        const s = (bp.lava || bp.side === 'canyon' ? 0.8 : 0.5) + (bp.side === 'canyon' ? 2.8 : 1.7) * Math.pow(rng(), 2.2);
        if (edgeDist(P.x, P.z, i) < 1.5 + s * 0.6) continue;
        const kind = bp.lava ? 'lavarock' : 'rock';
        inst(kind, bp.lava ? 0 : bp.rock, P.x, h - 0.15 * s, P.z, rng() * 6.28, s * (0.9 + 0.3 * rng()), s * (0.7 + 0.5 * rng()), s, tintV(0.85, 1.15));
        if (s > 0.9) addCollider(P.x, P.z, 0.8 * s, 'rock');
      }
      // bushes
      e = bp.bushDens * 0.02 * Q * (vil ? 0.3 : 1);
      n = Math.floor(e + rng());
      for (let k = 0; k < n; k++) {
        const lat = 1.2 + 30 * Math.pow(rng(), 1.8);
        pointAt(i, sd * (hwE + lat), (rng() - 0.5) * 2, P);
        const h = hGround(P.x, P.z);
        if (h !== h) continue;
        if (edgeDist(P.x, P.z, i) < 1.1) continue;
        const s = 0.7 + 0.9 * rng();
        const col = bp.heather ? (rng() < 0.6 ? 0x7d5a8a : 0x6d6a3d) : bp.trees[0][0] === 'dead' || bp.side === 'canyon' ? 0x8a7a4a : bp.ridged ? 0x2a2a2e : 0x4b6a35;
        inst('bush', col, P.x, h - 0.05, P.z, rng() * 6.28, s, s, s, tintV(0.85, 1.2));
      }
      // snow banks
      const sBank = bp.banks ? 0.9 : (W.surfNames[W.SURF[i]] === 'snow' || W.surfNames[W.SURF[i]] === 'ice') && W.SNOW[i] > 0.5 ? 0.55 : 0;
      if (sBank > 0 && i % 3 === 0 && rng() < sBank * Math.min(1, Q + 0.3)) {
        pointAt(i, sd * (hwE + 0.55 + rng() * 0.9), (rng() - 0.5) * 2, P);
        const h = hGround(P.x, P.z);
        if (h === h) {
          const s = 1.0 + 0.7 * rng();
          inst('bank', 0, P.x, h - 0.1, P.z, yawAlong(i) + (rng() - 0.5) * 0.4, s * 1.4, s * (1.0 + 0.5 * rng()), s, tintV(0.92, 1.05));
          addCollider(P.x, P.z, 1.0 * s, 'barrier');
        }
      }
    }
  }

  // ---- villages: houses and walls -----------------------------------------------------------
  const wallRun = (i0, i1, sd) => {
    for (let i = i0; i <= i1; i += 1) {
      for (let h = 0; h < 2; h++) {
        const a = h * 1.0 - 0.5;
        pointAt(i, sd * (W.HW[i] + 0.95), a * 2, P);
        const g = hGround(P.x, P.z);
        if (g !== g) continue;
        if (h === 0) inst('wall', 0, P.x, g - 0.15, P.z, yawAlong(i), 1, 1, 1, tintV(0.9, 1.1));
        addCollider(P.x, P.z, 0.55, 'wall');
      }
    }
  };
  for (const v of W.villages) {
    for (let sd = -1; sd <= 1; sd += 2) {
      let i = v.i0;
      while (i < v.i1) {
        if (rng() < 0.55) { // house
          const len = 4 + Math.floor(rng() * 4);
          const ic = Math.min(N - 3, i + 3);
          const lat = W.HW[ic] + 0.5 + 1.0 + 3.1 + rng() * 3.5;
          pointAt(ic, sd * lat, 0, P);
          const h = hGround(P.x, P.z);
          if (h === h && edgeDist(P.x, P.z, ic) > 3.3) {
            const yaw = yawAlong(ic);
            const hc = [0xe6d9bd, 0xd9c7a0, 0xeadfcb, 0xcfb99a, 0xd8a98c][Math.floor(rng() * 5)];
            inst('house', hc, P.x, h - 0.3, P.z, yaw + (sd > 0 ? Math.PI : 0), 1, 1 + rng() * 0.25, 1, tintV(0.9, 1.08));
            for (const a of [-2.1, 2.1]) {
              addCollider(P.x + W.DX[ic] * a, P.z + W.DZ[ic] * a, 3.0, 'house');
            }
          }
          i += len + 2 + Math.floor(rng() * 5);
        } else {
          const len = 6 + Math.floor(rng() * 14);
          wallRun(i, Math.min(v.i1, i + len), sd);
          i += len + 1;
        }
      }
    }
  }

  // ---- narrows: walls (or boulders) hugging the road ---------------------------------------------
  for (const f of W.narrows) {
    for (let sd = -1; sd <= 1; sd += 2) {
      if (bps[W.BIO[f.i0]].side === 'canyon' || !W.VIL[f.i0]) {
        const rocky = !(BIOMES[W.biomeNames[W.BIO[f.i0]]].vines || W.VIL[f.i0] || W.biomeNames[W.BIO[f.i0]] === 'coast' || W.biomeNames[W.BIO[f.i0]] === 'mud');
        if (rocky) {
          for (let i = f.i0 + 3; i < f.i1 - 3; i += 3) {
            pointAt(i, sd * (W.HW[i] + 0.5 + 1.0 + rng() * 0.6), 0, P);
            const g = hGround(P.x, P.z); if (g !== g) continue;
            const s = 1.0 + 0.8 * rng();
            inst('rock', bps[W.BIO[i]].rock, P.x, g - 0.2, P.z, rng() * 6.28, s, s * 0.9, s, tintV(0.85, 1.1));
            addCollider(P.x, P.z, 0.85 * s, 'rock');
          }
        } else wallRun(f.i0 + 2, f.i1 - 2, sd);
      }
    }
  }

  // ---- fences, hay, vines, farmhouses ---------------------------------------------------------
  for (let i = 4; i < N - 8; i++) {
    const bp = bps[W.BIO[i]];
    if (W.VIL[i]) continue;
    if (bp.fences && Q > 0.5 && rng() < 0.004 * Q) {
      const sd = rng() < 0.5 ? -1 : 1, len = 12 + Math.floor(rng() * 30);
      for (let k = 0; k < len && i + k * 2 < N - 4; k += 1) {
        const ii = i + k;
        if (ii % 1 !== 0) continue;
        pointAt(ii, sd * (W.HW[ii] + 0.5 + 2.4), 0, P);
        const g = hGround(P.x, P.z); if (g !== g) continue;
        inst('fence', 0, P.x, g - 0.05, P.z, yawAlong(ii), 1, 1, 1, tintV(0.9, 1.1));
      }
      i += len;
    }
    if (bp.vines && rng() < 0.012 * Q) {
      const sd = rng() < 0.5 ? -1 : 1, len = 15 + Math.floor(rng() * 30), rows = 3;
      for (let rrow = 0; rrow < rows; rrow++) {
        for (let k = 0; k < len; k += 2) {
          const ii = i + k; if (ii >= N - 4) break;
          pointAt(ii, sd * (W.HW[ii] + 0.5 + 8 + rrow * 3.2), 0, P);
          const g = hGround(P.x, P.z); if (g !== g) continue;
          if (edgeDist(P.x, P.z, ii) < 6) continue;
          inst('vine', 0, P.x, g - 0.05, P.z, yawAlong(ii), 1, 1, 1, tintV(0.85, 1.15));
        }
      }
      i += len;
    }
    if (rng() < 0.0035 * Q && (bp.fences || bp.vines || W.biomeNames[W.BIO[i]] === 'coast')) { // farmhouse
      const sd = rng() < 0.5 ? -1 : 1;
      pointAt(i, sd * (W.HW[i] + 0.5 + 12 + rng() * 25), 0, P);
      const g = hGround(P.x, P.z);
      if (g === g && edgeDist(P.x, P.z, i) > 9 && slopeOK(P.x, P.z, g, 0.5)) {
        inst('house', 0, P.x, g - 0.3, P.z, rng() * 6.28, 1, 1, 1, tintV(0.9, 1.05));
        addCollider(P.x - 1.5, P.z, 3.0, 'house'); addCollider(P.x + 1.5, P.z, 3.0, 'house');
      }
    }
  }

  // ---- set pieces: chevrons, hay bales, close rocks, spectators ----------------------------------
  const spectCluster = (iC, sd, count) => {
    const c = Math.max(3, Math.round(count * Math.min(1, 0.5 + Q * 0.5)));
    for (let k = 0; k < c; k++) {
      const ii = clamp(iC + Math.round((rng() - 0.5) * 12), 1, N - 2);
      pointAt(ii, sd * (W.HW[ii] + 0.5 + 3.2 + rng() * 6), 0, P);
      const g = hGround(P.x, P.z); if (g !== g) continue;
      if (edgeDist(P.x, P.z, ii) < 2.8) continue;
      const s = 0.92 + 0.18 * rng();
      tmpCol.setHex(SPECT_COLORS[Math.floor(rng() * SPECT_COLORS.length)]);
      const yaw = Math.atan2(-sd * W.RX[ii], -sd * W.RZ[ii]); // face the road
      inst('spectator', 0, P.x, g, P.z, yaw, s, s, s, tmpCol.getHex());
    }
  };
  for (const pc of W.pieces) {
    const iS = Math.round(pc.s / 2), iE = Math.min(N - 3, Math.round((pc.s + pc.len) / 2));
    if (iE <= iS + 2) continue;
    const outside = -pc.dir;
    const tight = pc.type === 'hairpin' || pc.type === 'square' || (pc.type === 'tight' && pc.radius < 22);
    if (tight) {
      const nCh = pc.type === 'hairpin' ? 5 : 3;
      for (let k = 0; k < nCh; k++) {
        const ii = Math.round(iS + (iE - iS) * (0.15 + 0.7 * k / (nCh - 1)));
        pointAt(ii, outside * (W.HW[ii] + 0.5 + 1.0), 0, P);
        const g = hGround(P.x, P.z); if (g !== g) continue;
        inst('chevron', 0, P.x, g, P.z, Math.atan2(-outside * W.RX[ii], -outside * W.RZ[ii]), 1, 1, 1, 1);
        addCollider(P.x, P.z, 0.2, 'post');
      }
      if (rng() < 0.65) spectCluster(Math.round((iS + iE) / 2), outside, 6 + Math.floor(rng() * 7));
    }
    if (pc.radius < 60 && pc.type !== 'chicane' && rng() < 0.6 * Math.min(1, Q + 0.2)) {
      const bpi = bps[W.BIO[iS]];
      // punishing rocks / bales on the outside of the corner and the inside apex
      const mid = Math.round((iS + iE) / 2);
      for (const sdd of [outside, -outside]) {
        const hay = bpi.hay && sdd === outside;
        const nObj = hay ? 3 : 1;
        for (let k = 0; k < nObj; k++) {
          const ii = clamp(mid + k * 2 - nObj + 1, 1, N - 2);
          pointAt(ii, sdd * (W.HW[ii] + 0.5 + 2.0 + rng() * 1.6), 0, P);
          const g = hGround(P.x, P.z); if (g !== g) continue;
          if (edgeDist(P.x, P.z, ii) < 1.5) continue;
          if (hay) { inst('hay', 0, P.x, g - 0.05, P.z, yawAlong(ii), 1, 1, 1, tintV(0.9, 1.1)); addCollider(P.x, P.z, 0.8, 'barrier'); }
          else {
            const s = 0.9 + 0.7 * rng();
            inst(bpi.lava ? 'lavarock' : 'rock', bpi.lava ? 0 : bpi.rock, P.x, g - 0.1, P.z, rng() * 6.28, s, s * 0.8, s, tintV(0.9, 1.1));
            addCollider(P.x, P.z, 0.8 * s, 'rock');
          }
        }
      }
    }
  }
  for (const f of ctx.features) {
    if (f.type === 'jump' || (f.type === 'crest' && rng() < 0.4)) {
      const ii = clamp(Math.round(f.dist / 2) + 6, 1, N - 2);
      spectCluster(ii, rng() < 0.5 ? -1 : 1, 7 + Math.floor(rng() * 6));
    }
  }

  // ---- roadside marker posts ----------------------------------------------------------------
  for (let i = 25; i < N - 10; i += 25) {
    if (W.VIL[i]) continue;
    const sd = (i / 25) % 2 === 0 ? 1 : -1;
    pointAt(i, sd * (W.HW[i] + 0.5 + 0.6), 0, P);
    const g = hGround(P.x, P.z); if (g !== g) continue;
    inst('post', 0, P.x, g, P.z, 0, 1, 1, 1, 1);
    addCollider(P.x, P.z, 0.15, 'post');
  }
  for (const fe of ctx.features) { // warning posts at features
    if (fe.type === 'caution' || fe.type === 'bridge') {
      for (const d of [fe.dist - 30, fe.dist - 20, fe.dist - 10]) {
        const ii = Math.round(d / 2); if (ii < 1) continue;
        pointAt(ii, (fe.side || 1) * (W.HW[ii] + 1.4), 0, P);
        const g = hGround(P.x, P.z); if (g !== g) continue;
        inst('post', 0, P.x, g, P.z, 0, 1, 1.0, 1, 1);
      }
    }
  }

  // ---- gates -------------------------------------------------------------------------------
  const gateMeshes = [];
  const gateMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  disposables.push(gateMat);
  function gate(dist, kind) {
    const i = clamp(Math.round(dist / 2), 1, N - 2);
    const hw = W.HW[i];
    const half = hw + 1.4;
    const parts = [];
    const pc = kind === 'start' ? 0x2fa34a : kind === 'finish' ? 0x202020 : 0xf0a500;
    for (const sd of [-1, 1]) parts.push({ g: box(0.45, 6.0, 0.45), color: 0x30343a, m: mat(sd * half, 3.0, 0) });
    parts.push({ g: box(half * 2 + 0.9, 1.1, 0.4), color: pc, m: mat(0, 5.6, 0) });
    if (kind === 'finish') {
      const nC = Math.round(half * 2 / 0.55);
      const cw = (half * 2) / nC;
      for (let r = 0; r < 2; r++) for (let c = 0; c < nC; c++) {
        parts.push({ g: box(cw, 0.55, 0.46), color: (r + c) % 2 ? 0xf5f5f5 : 0x111111, m: mat(-half + cw * (c + 0.5), 5.88 - r * 0.55, 0) });
      }
    } else {
      parts.push({ g: box(half * 2 - 0.4, 0.3, 0.46), color: kind === 'start' ? 0xffffff : 0x2a5ac8, m: mat(0, 5.6, 0) });
    }
    const g = bake(parts);
    const m = new THREE.Mesh(g, gateMat);
    m.position.set(W.X[i], W.Y[i] - 0.0, W.Z[i]);
    m.rotation.y = Math.atan2(-W.DX[i], -W.DZ[i]); // local +x -> road right
    m.castShadow = true;
    m.updateMatrixWorld(true);
    group.add(m);
    disposables.push(g);
    gateMeshes.push(m);
    for (const sd of [-1, 1]) addCollider(W.X[i] + W.RX[i] * sd * half, W.Z[i] + W.RZ[i] * sd * half, 0.35, 'post');
    return i;
  }
  const iStart = gate(ctx.startDist, 'start');
  gate(ctx.finishDist, 'finish');
  for (const s of ctx.splits) gate(s, 'split');
  spectCluster(iStart + 4, 1, 8); spectCluster(iStart + 6, -1, 8);
  spectCluster(Math.round(ctx.finishDist / 2) - 3, 1, 10); spectCluster(Math.round(ctx.finishDist / 2) + 4, -1, 10);

  // ---- ground stripes at gates (start/finish line decals) -------------------------------------
  const sp = [], si = [], sc = [];
  const stripe = (dist, color) => {
    const i = clamp(Math.round(dist / 2), 1, N - 2);
    const hw = W.HW[i];
    const v = [];
    for (const al of [-0.4, 0.4]) for (const l of [-hw, hw]) {
      v.push(W.X[i] + W.DX[i] * al + W.RX[i] * l, W.Y[i] + al * (W.Y[i + 1] - W.Y[i - 1]) / 4 - l * W.BANK[i] + 0.035, W.Z[i] + W.DZ[i] * al + W.RZ[i] * l);
    }
    const base = sp.length / 3;
    sp.push(...v);
    // order: (-a,-l) (-a,+l) (+a,-l) (+a,+l); rows ordered forward
    si.push(base, base + 1, base + 3, base, base + 3, base + 2);
    for (let k = 0; k < 4; k++) sc.push(color[0], color[1], color[2]);
  };
  stripe(ctx.startDist, [0.9, 0.9, 0.9]);
  stripe(ctx.finishDist, [0.9, 0.9, 0.9]);
  for (const s of ctx.splits) stripe(s, [0.9, 0.6, 0.05]);
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    g.setIndex(si);
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const mesh = new THREE.Mesh(g, m);
    group.add(mesh);
    disposables.push(g, m);
    gateMeshes.push(mesh);
  }

  // ---- build instanced meshes ---------------------------------------------------------------
  const meshes = [];
  const M4 = new THREE.Matrix4(), Qn = new THREE.Quaternion(), Pv = new THREE.Vector3(), Sv = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let triCount = 0;
  const shadows = ctx.quality !== 'low';
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  disposables.push(material);
  for (const b of buckets.values()) {
    const g = geoCache.get(b.key);
    const n = b.data.length / 8;
    const im = new THREE.InstancedMesh(g, material, n);
    const spect = b.kind === 'spectator';
    for (let k = 0; k < n; k++) {
      const d = k * 8;
      Pv.set(b.data[d], b.data[d + 1], b.data[d + 2]);
      Qn.setFromAxisAngle(up, b.data[d + 3]);
      Sv.set(b.data[d + 4], b.data[d + 5], b.data[d + 6]);
      M4.compose(Pv, Qn, Sv);
      im.setMatrixAt(k, M4);
      const t = b.data[d + 7];
      if (spect) col.setHex(t); else col.setRGB(t, t * 0.985, t * 0.97);
      im.setColorAt(k, col);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = shadows && SHADOW_KINDS.has(b.kind);
    im.receiveShadow = shadows && (b.kind === 'house' || b.kind === 'rock');
    group.add(im);
    meshes.push(im);
    triCount += n * (g.attributes.position.count / 3);
  }
  return { meshes, gateMeshes, triCount, instanceCount: [...buckets.values()].reduce((a, b) => a + b.data.length / 8, 0) };
}
