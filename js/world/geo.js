// Small geometry helpers: bake vertex-coloured, flat-shaded merged geometry from parts.
import * as THREE from 'three';
import { hash2 } from './noise.js';

const _c = new THREE.Color();
export function rgbOf(hex, out = [0, 0, 0]) {
  _c.setHex(hex); out[0] = _c.r; out[1] = _c.g; out[2] = _c.b; return out;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
export function mat(x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  _e.set(rx, ry, rz); _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.clone(), new THREE.Vector3(sx, sy, sz));
}

/** parts: [{ g: BufferGeometry, color: hex, m?: Matrix4, jit?: number }] -> flat BufferGeometry (position, normal, color) */
export function bake(parts) {
  const prep = [];
  let nv = 0;
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
    if (p.m) g.applyMatrix4(p.m);
    prep.push({ g, p });
    nv += g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  let o = 0;
  const rgb = [0, 0, 0];
  for (const { g, p } of prep) {
    const a = g.attributes.position.array;
    const cnt = g.attributes.position.count;
    rgbOf(p.color, rgb);
    for (let i = 0; i < cnt; i++) {
      let x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      if (p.jit) {
        const kx = Math.round(x * 50), ky = Math.round(y * 50), kz = Math.round(z * 50);
        x += (hash2(kx, ky, 11) - 0.5) * 2 * p.jit;
        y += (hash2(ky, kz, 23) - 0.5) * 2 * p.jit;
        z += (hash2(kz, kx, 37) - 0.5) * 2 * p.jit;
      }
      pos[(o + i) * 3] = x; pos[(o + i) * 3 + 1] = y; pos[(o + i) * 3 + 2] = z;
      col[(o + i) * 3] = rgb[0]; col[(o + i) * 3 + 1] = rgb[1]; col[(o + i) * 3 + 2] = rgb[2];
    }
    o += cnt;
    g.dispose();
  }
  for (let t = 0; t < nv; t += 3) {
    const ax = pos[t * 3], ay = pos[t * 3 + 1], az = pos[t * 3 + 2];
    const ux = pos[t * 3 + 3] - ax, uy = pos[t * 3 + 4] - ay, uz = pos[t * 3 + 5] - az;
    const vx = pos[t * 3 + 6] - ax, vy = pos[t * 3 + 7] - ay, vz = pos[t * 3 + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) { nor[(t + k) * 3] = nx; nor[(t + k) * 3 + 1] = ny; nor[(t + k) * 3 + 2] = nz; }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
