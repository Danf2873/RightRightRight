import * as THREE from 'three';
import { SURFACES } from './tires.js';

// Wheel dust / snow / spray particles: one fixed pool of points, recycled ring-buffer style.

const MAX = 900;
const LOOSE = new Set(['gravel', 'dirt', 'sand', 'snow', 'mud', 'grass', 'ash']);

const tmpColor = new THREE.Color();
const tmpVec = new THREE.Vector3();
const wheelOffsets = [
  new THREE.Vector3(-0.78, -0.35, -1.25),
  new THREE.Vector3(0.78, -0.35, -1.25),
  new THREE.Vector3(-0.78, -0.35, 1.25),
  new THREE.Vector3(0.78, -0.35, 1.25),
];

function dustColor(surface) {
  const s = SURFACES[surface];
  if (!s) return 0xb8a88a;
  if (typeof s.dust === 'number') return s.dust;
  if (typeof s.dust === 'string') return s.dust;
  return s.color ?? 0xb8a88a;
}

export class Effects {
  constructor(scene, quality = 'medium') {
    this.scene = scene;
    this.max = quality === 'low' ? 300 : quality === 'high' ? MAX : 600;
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.next = 0;
    this.spawnAcc = [0, 0, 0, 0];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    this.mat = new THREE.PointsMaterial({
      size: 0.9,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    for (let i = 0; i < this.max; i++) this.pos[i * 3 + 1] = -9999;
    scene.add(this.points);
  }

  clear() {
    this.life.fill(0);
    for (let i = 0; i < this.max; i++) this.pos[i * 3 + 1] = -9999;
    this.geo.attributes.position.needsUpdate = true;
  }

  spawn(x, y, z, vx, vy, vz, color, life) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    tmpColor.set(color);
    const shade = 0.85 + Math.random() * 0.3;
    this.col[i * 3] = tmpColor.r * shade; this.col[i * 3 + 1] = tmpColor.g * shade; this.col[i * 3 + 2] = tmpColor.b * shade;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt, vehicle) {
    if (vehicle && dt > 0) this.emit(dt, vehicle);
    const p = this.pos, v = this.vel;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { p[i * 3 + 1] = -9999; continue; }
      const drag = Math.exp(-2.2 * dt);
      v[i * 3] *= drag; v[i * 3 + 2] *= drag;
      v[i * 3 + 1] = v[i * 3 + 1] * drag + 0.6 * dt; // dust rises slowly
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  emit(dt, vehicle) {
    const speed = Math.abs(vehicle.speed);
    const wheels = vehicle.wheels || [];
    for (let w = 0; w < wheels.length && w < 4; w++) {
      const wh = wheels[w];
      if (!wh || !wh.contact) continue;
      const loose = LOOSE.has(wh.surface);
      const slip = Math.min(1, Math.abs(wh.slipRatio || 0) * 2 + Math.abs(wh.slipAngle || 0) * 2);
      const water = wh.water || 0;
      let rate = 0;
      if (loose) rate = speed * 0.9 + slip * 60;
      else if (wh.surface === 'wet') rate = speed * 0.5;
      else rate = slip > 0.5 ? slip * 25 : 0; // tarmac tyre smoke
      if (water > 0) rate += speed * 3;
      if (rate <= 0) continue;
      this.spawnAcc[w] += rate * dt;
      if (this.spawnAcc[w] < 1) continue;
      const color = water > 0 ? 0xdfe8f0 : loose ? dustColor(wh.surface) : 0xdddddd;
      tmpVec.copy(wheelOffsets[w]).applyQuaternion(vehicle.quaternion).add(vehicle.position);
      while (this.spawnAcc[w] >= 1) {
        this.spawnAcc[w] -= 1;
        const spread = 1.2;
        this.spawn(
          tmpVec.x + (Math.random() - 0.5) * 0.4,
          tmpVec.y + Math.random() * 0.2,
          tmpVec.z + (Math.random() - 0.5) * 0.4,
          -vehicle.velocity.x * 0.25 + (Math.random() - 0.5) * spread,
          0.6 + Math.random() * (water > 0 ? 2.5 : 1.2),
          -vehicle.velocity.z * 0.25 + (Math.random() - 0.5) * spread,
          color,
          water > 0 ? 0.6 : loose ? 1.4 + Math.random() : 0.9,
        );
      }
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
  }
}
