// Road ribbon (vertex-coloured by surface), lane-line decals, skirts, water ribbons and bridge rails.
import * as THREE from 'three';
import { SURFACE_COLORS, BIOMES } from './biomes.js';
import { rgbOf, bake, box, mat } from './geo.js';
import { hash2, vnoise1 } from './noise.js';

const LOOSE = { gravel: 1, dirt: 1, sand: 1, snow: 1, mud: 1, ash: 1, grass: 1, ice: 0.4 };

export function buildRoad(W, q, group, disposables) {
  const { N, X, Z, Y, RX, RZ, HW, BANK } = W;
  const cols = q.cols;
  const nTop = cols;
  const per = cols + 2; // + two skirt-bottom verts
  const pos = new Float32Array(N * per * 3), col = new Float32Array(N * per * 3);
  const surfRgb = {};
  for (const k in SURFACE_COLORS) surfRgb[k] = rgbOf(SURFACE_COLORS[k]);
  const tmp = [0, 0, 0];
  const lats = new Float64Array(cols);
  const mul = new Float64Array(cols);
  for (let i = 0; i < N; i++) {
    const hw = HW[i], E = hw + 0.5;
    if (cols === 7) { lats.set([-E, -hw, -0.45 * hw, 0, 0.45 * hw, hw, E]); }
    else { lats.set([-E, -hw, 0, hw, E]); }
    const sname = W.surfNames[W.SURF[i]];
    const base = surfRgb[sname];
    const loose = LOOSE[sname] ?? 1;
    const verge = rgbOf(BIOMES[W.biomeNames[W.BIO[i]]].verge, tmp);
    const vr = verge[0], vg = verge[1], vb = verge[2];
    const wob = 0.96 + 0.08 * (vnoise1(i * 0.35, 5) * 0.5 + 0.5);
    for (let c = 0; c < cols; c++) {
      const l = lats[c];
      const p = (i * per + c) * 3;
      pos[p] = X[i] + RX[i] * l; pos[p + 2] = Z[i] + RZ[i] * l;
      const le = l < -E ? -E : l > E ? E : l;
      pos[p + 1] = Y[i] - le * BANK[i];
      let m, vm = 0;
      const al = Math.abs(l);
      if (al >= hw + 0.4) { m = 0.92; vm = 0.55; }
      else if (cols === 7 && (c === 2 || c === 4)) m = loose >= 1 ? 0.8 : 0.9;
      else if (cols === 7 && c === 3) m = loose >= 1 ? 1.06 : 1.0;
      else if (al >= hw - 0.01) m = 0.95;
      else m = loose >= 1 && cols === 5 ? 0.95 : 1;
      m *= wob;
      col[p] = (base[0] + (vr - base[0]) * vm) * m;
      col[p + 1] = (base[1] + (vg - base[1]) * vm) * m;
      col[p + 2] = (base[2] + (vb - base[2]) * vm) * m;
    }
    // skirt bottoms
    for (let s = 0; s < 2; s++) {
      const topC = s === 0 ? 0 : cols - 1;
      const p = (i * per + cols + s) * 3, pt = (i * per + topC) * 3;
      pos[p] = pos[pt]; pos[p + 1] = pos[pt + 1] - 0.9; pos[p + 2] = pos[pt + 2];
      col[p] = col[pt] * 0.55; col[p + 1] = col[pt + 1] * 0.5; col[p + 2] = col[pt + 2] * 0.45;
    }
  }
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const r0 = i * per, r1 = (i + 1) * per;
    for (let c = 0; c < cols - 1; c++) {
      const a = r0 + c, b = r0 + c + 1, d = r1 + c, e = r1 + c + 1;
      idx.push(a, b, e, a, e, d);
    }
    // left skirt (top = col 0, bottom = cols), right skirt (top = cols-1, bottom = cols+1)
    idx.push(r0, r1 + cols, r0 + cols, r0, r1, r1 + cols);
    idx.push(r0 + cols - 1, r0 + cols + 1, r1 + cols + 1, r0 + cols - 1, r1 + cols + 1, r1 + cols - 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(N * per > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  geo.computeVertexNormals();
  // split into ~200 m chunks for culling
  const out = [];
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  disposables.push(m);
  const chunkSamples = 100;
  const perQuad = (cols - 1) * 6 + 12;
  for (let s0 = 0; s0 < N - 1; s0 += chunkSamples) {
    const s1 = Math.min(N - 1, s0 + chunkSamples);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.attributes.position);
    g.setAttribute('color', geo.attributes.color);
    g.setAttribute('normal', geo.attributes.normal);
    g.setIndex(new THREE.BufferAttribute(geo.index.array.subarray(s0 * perQuad, s1 * perQuad), 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    disposables.push(g);
    out.push(mesh);
  }
  disposables.push(geo);

  // decals: tarmac edge lines + dashed centre line
  const dp = [], di = [];
  let dn = 0;
  const quad = (x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3) => {
    dp.push(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3);
    di.push(dn, dn + 1, dn + 2, dn, dn + 2, dn + 3);
    dn += 4;
  };
  const line = (i, l, wd) => { // returns [xL,y,zL,xR,y,zR] for sample i at lateral l
    const y = Y[i] - l * BANK[i] + 0.03;
    return [X[i] + RX[i] * (l - wd), y, Z[i] + RZ[i] * (l - wd), X[i] + RX[i] * (l + wd), y, Z[i] + RZ[i] * (l + wd)];
  };
  for (let i = 0; i < N - 1; i++) {
    const sn = W.surfNames[W.SURF[i]], sn2 = W.surfNames[W.SURF[i + 1]];
    if ((sn !== 'tarmac' && sn !== 'wet') || (sn2 !== 'tarmac' && sn2 !== 'wet')) continue;
    for (const sd of [-1, 1]) {
      const a = line(i, sd * (HW[i] - 0.3), 0.07), b = line(i + 1, sd * (HW[i + 1] - 0.3), 0.07);
      quad(a[0], a[1], a[2], a[3], a[4], a[5], b[3], b[4], b[5], b[0], b[1], b[2]);
    }
    if ((i % 5) < 2) {
      const a = line(i, 0, 0.09), b = line(i + 1, 0, 0.09);
      quad(a[0], a[1], a[2], a[3], a[4], a[5], b[3], b[4], b[5], b[0], b[1], b[2]);
    }
  }
  if (dn > 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dp), 3));
    g.setIndex(dn > 65000 ? new THREE.BufferAttribute(new Uint32Array(di), 1) : new THREE.BufferAttribute(new Uint16Array(di), 1));
    g.computeVertexNormals();
    // vertices are wound the same as the ribbon (up-facing)
    const dm = new THREE.MeshLambertMaterial({ color: 0xd9d9d2, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const mesh = new THREE.Mesh(g, dm);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(g, dm);
    out.push(mesh);
  }
  return out;
}

/** ribbon strip following the centerline at constant height */
function ribbonStrip(W, i0, i1, halfW, y) {
  const n = i1 - i0 + 1;
  const pos = new Float32Array(n * 6);
  const idx = [];
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    pos.set([W.X[i] - W.RX[i] * halfW, y, W.Z[i] - W.RZ[i] * halfW, W.X[i] + W.RX[i] * halfW, y, W.Z[i] + W.RZ[i] * halfW], k * 6);
    if (k < n - 1) idx.push(k * 2, k * 2 + 1, k * 2 + 3, k * 2, k * 2 + 3, k * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildWater(W, group, disposables) {
  const meshes = [];
  if (!W.waterFeats.length) return meshes;
  const m = new THREE.MeshLambertMaterial({ color: 0x3d7fa6, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
  disposables.push(m);
  for (const f of W.waterFeats) {
    const i0 = Math.max(0, f.i0), i1 = Math.min(W.N - 1, f.i1);
    const g = ribbonStrip(W, i0, i1, f.halfW, f.level);
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 2;
    group.add(mesh);
    disposables.push(g);
    meshes.push(mesh);
  }
  return meshes;
}

/** bridge rails + deck underside beam; returns collider circles to register */
export function buildBridges(W, group, disposables, addCollider) {
  const meshes = [];
  if (!W.bridges.length) return meshes;
  const parts = [];
  for (const b of W.bridges) {
    for (let i = b.i0; i <= b.i1; i++) {
      const a = Math.atan2(-W.DZ[i], W.DX[i]);
      for (const sd of [-1, 1]) {
        const l = sd * (W.HW[i] + 0.25);
        const x = W.X[i] + W.RX[i] * l, z = W.Z[i] + W.RZ[i] * l, y = W.Y[i] - l * W.BANK[i];
        parts.push({ g: box(2.05, 0.18, 0.2), color: 0xb9b6ae, m: mat(x, y + 0.85, z, 1, 1, 1, 0, a, 0) });
        parts.push({ g: box(2.05, 0.14, 0.18), color: 0xb9b6ae, m: mat(x, y + 0.45, z, 1, 1, 1, 0, a, 0) });
        if ((i - b.i0) % 2 === 0) {
          parts.push({ g: box(0.24, 1.0, 0.26), color: 0x8c8982, m: mat(x, y + 0.5, z, 1, 1, 1, 0, a, 0) });
          addCollider(x, z, 0.5, 'barrier');
        } else addCollider(x, z, 0.4, 'barrier');
      }
      if ((i - b.i0) % 2 === 0) { // under-deck beam
        const y = W.Y[i] - 0.6;
        parts.push({ g: box(W.HW[i] * 2 + 1.0, 0.7, 1.8), color: 0x6d6a64, m: mat(W.X[i], y, W.Z[i], 1, 1, 1, 0, a, 0) });
      }
    }
    // piers at both ends
    for (const i of [b.i0 + 1, b.i1 - 1]) {
      const a = Math.atan2(-W.DZ[i], W.DX[i]);
      const hh = W.Y[i] - (W.YREF[i] - 8);
      parts.push({ g: box(W.HW[i] * 2 - 1, hh, 1.4), color: 0x77746d, m: mat(W.X[i], W.Y[i] - 0.9 - hh / 2, W.Z[i], 1, 1, 1, 0, a, 0) });
    }
  }
  const g = bake(parts);
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true; mesh.receiveShadow = true;
  group.add(mesh);
  disposables.push(g, m);
  meshes.push(mesh);
  return meshes;
}
