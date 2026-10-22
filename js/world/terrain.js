// Heightfield terrain around the road. The height grid is the single source of truth: meshes and
// physics queries (track.groundAt) both use it with the same triangulation.
//   cell (ix,iz): triangle A = v00,v11,v10 (used when fx >= fz), triangle B = v00,v01,v11 (fx < fz)
import * as THREE from 'three';
import { BIOMES } from './biomes.js';
import { fbm2, vnoise2, hash2, ss, clamp } from './noise.js';
import { newFrame } from './frame.js';
import { rgbOf } from './geo.js';

export const QUALITY = {
  low:    { cell: 10,  chunkCells: 20, blur: 3,  scenery: 0.35, cols: 5 },
  medium: { cell: 6,   chunkCells: 32, blur: 8,  scenery: 1.0,  cols: 7 },
  high:   { cell: 4.5, chunkCells: 44, blur: 13, scenery: 1.7,  cols: 7 },
};

const MARGIN = 150;

export function buildTerrainGrid(W, L, quality) {
  const q = QUALITY[quality] || QUALITY.medium;
  const c = q.cell, R = MARGIN + 1.5 * c;
  const { X, Z, N } = W;
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (let i = 0; i < N; i++) {
    if (X[i] < mnx) mnx = X[i]; if (X[i] > mxx) mxx = X[i];
    if (Z[i] < mnz) mnz = Z[i]; if (Z[i] > mxz) mxz = Z[i];
  }
  const x0 = Math.floor((mnx - R) / c) * c, z0 = Math.floor((mnz - R) / c) * c;
  const nx = Math.ceil((mxx + R - x0) / c) + 1, nz = Math.ceil((mxz + R - z0) / c) + 1;
  const V = nx * nz;
  const D2 = new Float32Array(V).fill(Infinity);
  const IDX = new Int16Array(V).fill(-1);

  function stamp(i, r) {
    const xi = X[i], zi = Z[i];
    const ix0 = Math.max(0, Math.floor((xi - r - x0) / c)), ix1 = Math.min(nx - 1, Math.ceil((xi + r - x0) / c));
    const iz0 = Math.max(0, Math.floor((zi - r - z0) / c)), iz1 = Math.min(nz - 1, Math.ceil((zi + r - z0) / c));
    const r2 = r * r;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = z0 + iz * c - zi, dz2 = dz * dz;
      let v = iz * nx + ix0;
      for (let ix = ix0; ix <= ix1; ix++, v++) {
        const dx = x0 + ix * c - xi;
        const d2 = dx * dx + dz2;
        if (d2 < D2[v] && d2 <= r2) { D2[v] = d2; IDX[v] = i; }
      }
    }
  }
  for (let i = 0; i < N; i++) {
    stamp(i, 40);
    if (i % 4 === 0) stamp(i, R);
  }

  const R2 = R * R;
  const act = new Uint8Array(V);
  for (let v = 0; v < V; v++) act[v] = D2[v] <= R2 ? 1 : 0;

  const bps = W.biomeNames.map(n => BIOMES[n]);
  const mExtra = 0.002 * c * c;
  const F = newFrame();
  const EDG = new Float32Array(V), NEAR = new Float32Array(V), FAR = new Float32Array(V), DR = new Float32Array(V);
  const DET = new Float32Array(V);
  const seed = W.seed | 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = iz * nx + ix;
      if (!act[v]) continue;
      const x = x0 + ix * c, z = z0 + iz * c;
      const i = L.climb(x, z, IDX[v]);
      IDX[v] = i;
      L.frame(x, z, i, F);
      const bp = bps[W.BIO[F.a]];
      const E = F.hw + 0.5;
      const lat = F.lat, al = lat < 0 ? -lat : lat;
      const dr = al - E;
      DR[v] = dr;
      const latc = lat < -E ? -E : lat > E ? E : lat;
      const yRoad = F.yc - latc * F.bank;
      // Verge sits nearly flush with the road (the road mesh's polygon offset hides overlaps),
      // easing into a shallow drainage dip rather than a kerb-like step.
      let near = yRoad - 0.06 - mExtra;
      if (dr > 0) near -= 0.12 * ss(0.5, 4, dr);
      if (F.valley > 0) near -= 7 * F.valley * ss(0.3, 4, dr);
      NEAR[v] = near;
      EDG[v] = yRoad;
      // structural far field (blurred later) + side walls / drop-offs
      let far = F.yr;
      const a = F.a;
      const wallEnv = lat > 0 ? W.WALLR[a] : W.WALLL[a];
      const dropEnv = lat > 0 ? W.DROPR[a] : W.DROPL[a];
      if (wallEnv > 0.001) {
        const t = dr - bp.wallStart;
        if (t > 0) far += wallEnv * bp.wallCap * Math.tanh(bp.wallSlope * t / bp.wallCap);
      }
      if (dropEnv > 0.001) {
        const t = dr - 1.5;
        if (t > 0) far -= dropEnv * bp.dropCap * Math.tanh(bp.dropSlope * t / bp.dropCap);
      }
      FAR[v] = far;
      // detail noise
      let n = fbm2(x / bp.wave, z / bp.wave, seed, 3);
      if (bp.ridged) n = (1 - Math.abs(n) * 2) * 0.9;
      const wd = 0.15 + 0.85 * ss(6, 50, dr);
      DET[v] = (n * bp.hill + vnoise2(x / 9, z / 9, seed + 5) * bp.micro) * wd;
    }
  }
  // blur the structural far field (active vertices only)
  let A = FAR, B = new Float32Array(V);
  for (let p = 0; p < q.blur; p++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const v = iz * nx + ix;
        if (!act[v]) continue;
        let s = A[v] * 4, w = 4;
        if (ix > 0 && act[v - 1]) { s += A[v - 1]; w += 1; }
        if (ix < nx - 1 && act[v + 1]) { s += A[v + 1]; w += 1; }
        if (iz > 0 && act[v - nx]) { s += A[v - nx]; w += 1; }
        if (iz < nz - 1 && act[v + nx]) { s += A[v + nx]; w += 1; }
        B[v] = s / w;
      }
    }
    const t = A; A = B; B = t;
  }
  const H = new Float32Array(V);
  const floorY = W.floorY;
  for (let v = 0; v < V; v++) {
    if (!act[v]) continue;
    const w = ss(3, 16, DR[v]);
    let far = A[v] + DET[v];
    if (far < floorY) far = floorY;
    let hv = NEAR[v] * (1 - w) + far * w;
    const dr = DR[v];
    if (dr < 3 * c) { // never let coarse triangles lift above the road near its edge
      const allow = EDG[v] - 0.06 - mExtra + 0.35 * Math.max(0, dr - 0.5 * c);
      if (hv > allow) hv = allow;
    }
    H[v] = hv;
  }
  // cell validity: all four vertices active
  const cnx = nx - 1, cnz = nz - 1;
  const OK = new Uint8Array(cnx * cnz);
  for (let iz = 0; iz < cnz; iz++) for (let ix = 0; ix < cnx; ix++) {
    const v = iz * nx + ix;
    OK[iz * cnx + ix] = act[v] && act[v + 1] && act[v + nx] && act[v + nx + 1] ? 1 : 0;
  }
  return { cell: c, inv: 1 / c, x0, z0, nx, nz, cnx, cnz, H, OK, IDX, DR, q, quality };
}

/** terrain height by the exact mesh triangulation; NaN if outside the built corridor */
export function gridHeight(g, x, z) {
  const gx = (x - g.x0) * g.inv, gz = (z - g.z0) * g.inv;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  if (ix < 0 || iz < 0 || ix >= g.cnx || iz >= g.cnz || !g.OK[iz * g.cnx + ix]) return NaN;
  const fx = gx - ix, fz = gz - iz;
  const v = iz * g.nx + ix, H = g.H;
  const h00 = H[v];
  if (fx >= fz) return h00 + (H[v + 1] - h00) * fx + (H[v + g.nx + 1] - H[v + 1]) * fz;
  return h00 + (H[v + g.nx + 1] - H[v + g.nx]) * fx + (H[v + g.nx] - h00) * fz;
}

export function buildTerrainMeshes(W, g, group, disposables) {
  const { cell: c, nx, nz, cnx, cnz, H, OK, DR } = g;
  const cc = g.q.chunkCells;
  const bps = W.biomeNames.map(n => BIOMES[n]);
  const pal = bps.map(b => ({
    g: b.ground.map(h => rgbOf(h)), rock: rgbOf(b.rock), steep: rgbOf(b.steep), verge: rgbOf(b.verge),
  }));
  const snowC = rgbOf(0xf0f5fb);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  disposables.push(mat);
  const seed = W.seed | 0;
  const tmp = [0, 0, 0];
  const meshes = [];

  const nchx = Math.ceil(cnx / cc), nchz = Math.ceil(cnz / cc);
  for (let chz = 0; chz < nchz; chz++) {
    for (let chx = 0; chx < nchx; chx++) {
      const ixa = chx * cc, ixb = Math.min(cnx, ixa + cc), iza = chz * cc, izb = Math.min(cnz, iza + cc);
      let count = 0;
      for (let iz = iza; iz < izb; iz++) for (let ix = ixa; ix < ixb; ix++) if (OK[iz * cnx + ix]) count++;
      if (!count) continue;
      const pos = new Float32Array(count * 18), nor = new Float32Array(count * 18), col = new Float32Array(count * 18);
      let o = 0;
      let minY = Infinity, maxY = -Infinity;
      for (let iz = iza; iz < izb; iz++) {
        for (let ix = ixa; ix < ixb; ix++) {
          if (!OK[iz * cnx + ix]) continue;
          const v = iz * nx + ix;
          const xa = g.x0 + ix * c, za = g.z0 + iz * c, xb = xa + c, zb = za + c;
          const h00 = H[v], h10 = H[v + 1], h01 = H[v + nx], h11 = H[v + nx + 1];
          if (h00 < minY) minY = h00; if (h00 > maxY) maxY = h00;
          if (h11 < minY) minY = h11; if (h11 > maxY) maxY = h11;
          if (h10 < minY) minY = h10; if (h10 > maxY) maxY = h10;
          if (h01 < minY) minY = h01; if (h01 > maxY) maxY = h01;
          const bi = W.BIO[g.IDX[v]];
          const p = pal[bi];
          const dr = Math.min(DR[v], DR[v + 1], DR[v + nx], DR[v + nx + 1]);
          const snow = W.SNOW[g.IDX[v]];
          for (let t = 0; t < 2; t++) {
            let ax, ay, az, bx, by, bz, cx, cy, cz;
            if (t === 0) { // A: v00, v11, v10
              ax = xa; ay = h00; az = za; bx = xb; by = h11; bz = zb; cx = xb; cy = h10; cz = za;
            } else { // B: v00, v01, v11
              ax = xa; ay = h00; az = za; bx = xa; by = h01; bz = zb; cx = xb; cy = h11; cz = zb;
            }
            const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
            let nx_ = uy * vz - uz * vy, ny_ = uz * vx - ux * vz, nz_ = ux * vy - uy * vx;
            const l = Math.hypot(nx_, ny_, nz_); nx_ /= l; ny_ /= l; nz_ /= l;
            // colour
            const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
            const n1 = (vnoise2(mx * 0.03, mz * 0.03, seed + 3) + 1) * 0.5;
            const n2 = (vnoise2(mx * 0.011, mz * 0.011, seed + 9) + 1) * 0.5;
            const jit = 0.93 + 0.14 * hash2(ix * 2 + t, iz, seed);
            const g0 = p.g[0], g1 = p.g[1], g2 = p.g[2];
            for (let k = 0; k < 3; k++) {
              let r = g0[k] + (g1[k] - g0[k]) * n1;
              r += (g2[k] - r) * (n2 > 0.62 ? (n2 - 0.62) * 2.6 : 0);
              tmp[k] = r;
            }
            const sl = clamp((0.84 - ny_) / 0.22, 0, 1);
            if (sl > 0) {
              const rc = hash2(ix, iz, seed + 1) > 0.5 ? p.rock : p.steep;
              for (let k = 0; k < 3; k++) tmp[k] += (rc[k] - tmp[k]) * sl;
            }
            if (snow > 0) {
              const sa = snow * (1 - sl * 0.55);
              for (let k = 0; k < 3; k++) tmp[k] += (snowC[k] - tmp[k]) * sa;
            }
            if (dr < 5) {
              const vm = clamp(1 - dr / 5, 0, 1) * 0.85;
              for (let k = 0; k < 3; k++) tmp[k] += (p.verge[k] - tmp[k]) * vm;
            }
            const base = o * 3;
            const pts = [ax, ay, az, bx, by, bz, cx, cy, cz];
            for (let k = 0; k < 3; k++) {
              pos[base + k * 3] = pts[k * 3]; pos[base + k * 3 + 1] = pts[k * 3 + 1]; pos[base + k * 3 + 2] = pts[k * 3 + 2];
              nor[base + k * 3] = nx_; nor[base + k * 3 + 1] = ny_; nor[base + k * 3 + 2] = nz_;
              col[base + k * 3] = tmp[0] * jit; col[base + k * 3 + 1] = tmp[1] * jit; col[base + k * 3 + 2] = tmp[2] * jit;
            }
            o += 3;
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      group.add(m);
      disposables.push(geo);
      meshes.push(m);
    }
  }
  return meshes;
}
