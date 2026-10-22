// vehicle.js - rigid-body rally car: suspension, tyres, drivetrain, collisions + low-poly mesh.
//
// Frame: car forward = -Z, right = +X, up = +Y. Steering/curvature + = right.
// Position is the centre of mass. Everything per-step is allocation free.

import * as THREE from 'three';
import { SURFACES, tireForces } from './tires.js';

// ============================================================================================
// TUNING CONSTANTS (the ones that matter most for feel are marked *)
// ============================================================================================
const G = 9.81;
const MASS = 1250;
const I_PITCH = 1930;          // about local X
const I_YAW = 2090;            // about local Y
const I_ROLL = 650;            // about local Z

const MAX_SUBSTEP = 1 / 100;

// --- geometry
const WHEEL_R = 0.32;
const WHEEL_X = 0.78;
const Z_FRONT = -1.25;
const Z_REAR = 1.35;
const MOUNT_Y = -0.05;         // suspension mount height relative to COM
const TRAVEL = 0.25;
const MAXLEN = TRAVEL + WHEEL_R;
const STATIC_C = TRAVEL / 3;   // static sag
const STATIC_LEN = MAXLEN - STATIC_C;
const COM_H = STATIC_LEN + MOUNT_Y; // COM height above flat ground at rest (0.537)
const WHEELBASE = Z_REAR - Z_FRONT;
const TRACK_W = WHEEL_X * 2;

// --- suspension  *
const K_F = 38000, K_R = 34000;        // N/m per wheel
const BUMP_F = 4200, BUMP_R = 3800;    // N s/m compression damping
const REB_F = 6400, REB_R = 5800;      // N s/m rebound damping
const ARB_F = 20000, ARB_R = 15000;    // anti-roll bar N/m (per unit compression difference)
const BUMP_ZONE = 0.04;                // bump stop engages in last 4 cm of travel
const K_BUMPSTOP = 260000;
const C_BUMPSTOP = 9000;
const MAX_SUSP_FORCE = 70000;

// --- tyres  *
const SIGMA_X = 0.22;                  // longitudinal relaxation length (m)
const SIGMA_Y = 0.26;                  // lateral relaxation length (m)
const FRONT_GRIP = 1.0;                // axle grip scales (oversteer/understeer balance)
const REAR_GRIP = 1.05;
const LOWV_DAMP_X = 7000;              // low speed damping (N s/m at 3000 N load)
const LOWV_DAMP_Y = 9000;
const WHEEL_I = 1.8;                   // wheel + hub + brake inertia (kg m^2)
const MAX_WHEEL_W = 420;

// --- engine / drivetrain  *
const IDLE_RPM = 900;
const REDLINE = 7500;
const LAUNCH_RPM = 3300;               // clutch slip rev target at full throttle from standstill
const TORQUE_PEAK = 345;               // Nm
const ENGINE_INERTIA = 0.28;
const DRIVE_EFF = 0.92;
const GEARS = [3.45, 2.30, 1.70, 1.36, 1.12, 0.93];
const REV_GEAR = 5.0;
const FINAL_DRIVE = 5.0;
const FRONT_SPLIT = 0.40;
const LSD_K = 0.035;                   // per rad/s speed difference
const LSD_MAX = 0.3;
const TRACTION_CONTROL = 0.8;          // 0..1 how strongly drive torque is cut when a tyre spins past its peak slip
const TC_BAND = 0.12;
const UPSHIFT_RPM = 7000;
const DOWNSHIFT_RPM = 3500;
const SHIFT_TIME = 0.2;
const ENGINE_BRAKE0 = 18, ENGINE_BRAKE1 = 0.011;
const TORQUE_RPM = [0, 900, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8200];
const TORQUE_MUL = [0.35, 0.5, 0.62, 0.8, 0.93, 1.0, 0.98, 0.9, 0.78, 0.55];

// --- brakes
const BRAKE_TOTAL = 4400;              // Nm summed over 4 wheels
const BRAKE_BIAS_F = 0.60;
const HANDBRAKE_TORQUE = 3200;         // per rear wheel, locks them
const ABS_BAND = 0.1;
const ABS_SPEED = 3;                   // ABS only above this speed (m/s)

// --- steering  *
const STEER_MAX = 32 * Math.PI / 180;
const STEER_SPEED_FULL = 41.7;         // m/s at which lock is reduced to STEER_MIN_FACTOR
const STEER_MIN_FACTOR = 0.4;
const DRIFT_ASSIST = 0.5;              // fraction of body slip angle auto-countersteered

// --- aero / resistance
const AIR_RHO = 1.2;
const CDA = 0.80;
const CLA = 0.35;                      // downforce area
const WATER_DRAG = 50;                 // N s/m per wheel per unit water

// --- body contact (rollover)
const BODY_K = 90000;
const BODY_C = 8000;
const BODY_MU = 0.65;
const BODY_TANG = 5000;
// local points: x, y, z, isRoof(1 = upper body point, triggers impact sounds)
const BODY_PTS = [
  [-0.88, -0.30, -2.0, 0], [0.88, -0.30, -2.0, 0], [-0.88, -0.30, 2.0, 0], [0.88, -0.30, 2.0, 0],
  [-0.88, 0.30, -2.0, 1], [0.88, 0.30, -2.0, 1], [-0.88, 0.30, 2.0, 1], [0.88, 0.30, 2.0, 1],
  [-0.75, 0.86, -0.15, 1], [0.75, 0.86, -0.15, 1], [-0.75, 0.88, 1.1, 1], [0.75, 0.88, 1.1, 1],
];

// --- obstacle collisions
const CIRCLE_Z = [-1.3, 0, 1.3];
const CIRCLE_R = 0.95;
const RESTITUTION = 0.2;
const COLL_FRICTION = 0.3;

// --- airborne
const AIR_PITCH_GAIN = 0.9;
const AIR_ROLL_GAIN = 1.2;
const AIR_DAMP = 650;

// ============================================================================================
// helpers + scratch (module level: no allocations in update)
// ============================================================================================
const V3 = THREE.Vector3;
const _fw = new V3(), _up = new V3(), _rt = new V3();
const _t1 = new V3(), _t2 = new V3(), _wf = new V3();
const _wb = new V3(), _tb = new V3();
const _qi = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _axis = new V3();
const _tf = { fx: 0, fy: 0, mu: 1, s: 0 };
const _gb = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'tarmac', onRoad: true, water: 0 };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function torqueCurve(rpm) {
  if (rpm <= 0) return TORQUE_MUL[0];
  const n = TORQUE_RPM.length;
  if (rpm >= TORQUE_RPM[n - 1]) return TORQUE_MUL[n - 1];
  let i = 1;
  while (i < n - 1 && rpm > TORQUE_RPM[i]) i++;
  const t = (rpm - TORQUE_RPM[i - 1]) / (TORQUE_RPM[i] - TORQUE_RPM[i - 1]);
  return TORQUE_MUL[i - 1] + (TORQUE_MUL[i] - TORQUE_MUL[i - 1]) * t;
}

function makeWheel(x, z, front) {
  return {
    // contract fields
    contact: false, surface: 'tarmac', slipRatio: 0, slipAngle: 0, load: 0, compression: 0, water: 0,
    // internal
    x, y: MOUNT_Y, z, front, isRight: x > 0,
    omega: 0, spin: 0, ux: 0, uy: 0, c: 0, cdot: 0, steer: 0, onRoad: true,
    fxT: 0, kxImp: 0, vr: 0,
    cache: {},
    g: { height: 0, nx: 0, ny: 1, nz: 0, surface: 'tarmac', onRoad: true, water: 0 },
    cp: new V3(), n: new V3(0, 1, 0), fg: new V3(), rg: new V3(), rc: new V3(), rm: new V3(),
  };
}

// ============================================================================================
export class Vehicle {
  constructor(scene, opts = { color: 0xd8262b, quality: 'medium' }) {
    const o = Object.assign({ color: 0xd8262b, quality: 'medium' }, opts || {});
    this.quality = o.quality;

    this.mesh = new THREE.Group();
    this.mesh.name = 'rally-car';

    this.position = new V3(0, COM_H, 0);
    this.quaternion = new THREE.Quaternion();
    this.velocity = new V3();
    this.angularVelocity = new V3();
    this.speed = 0;
    this.rpm = IDLE_RPM;
    this.maxRpm = REDLINE;
    this.gear = 1;
    this.throttle = 0;
    this.airborne = false;
    this.upsideDown = false;
    this.onImpact = null;

    this.wheels = [
      makeWheel(-WHEEL_X, Z_FRONT, true), makeWheel(WHEEL_X, Z_FRONT, true),
      makeWheel(-WHEEL_X, Z_REAR, false), makeWheel(WHEEL_X, Z_REAR, false),
    ];

    // extra read-only-ish state
    this.steerAngle = 0;          // average front wheel angle (rad, + = right)
    this.manual = false;
    this.lateralG = 0; this.longG = 0;
    this.bodyContact = false;     // roof/body touching the ground

    // internal state
    this._fx = 0; this._fy = 0; this._fz = 0; this._tx = 0; this._ty = 0; this._tz = 0;
    this._tdrv = new Float64Array(4);
    this._tbrk = new Float64Array(4);
    this._shiftTimer = 0;
    this._shiftCool = 0;
    this._revTimer = 0;
    this._limiter = false;
    this._wheelRpm = 0;
    this._lock = 0;
    this._reflect = 0;
    this._ceiling = REDLINE;
    this._airTime = 0;
    this._flipTimer = 0;
    this._sideTimer = 0;
    this._pending = false;
    this._pendPos = new V3();
    this._pendDir = new V3(0, 0, -1);
    this._collCool = 0;
    this._groundCool = 0;
    this._bodyCache = BODY_PTS.map(() => ({}));
    this._comCache = {};
    this._lastGoodPos = new V3(0, COM_H, 0);
    this._lastGoodQ = new THREE.Quaternion();
    this._nanLogged = false;
    this._prevVel = new V3();

    this._buildMesh(o);
    if (scene) scene.add(this.mesh);
    this.reset(new V3(0, 0, 0), new V3(0, 0, -1));
  }

  // ------------------------------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------------------------------
  setManualGearbox(on) {
    this.manual = !!on;
    if (!this.manual && this.gear === 0) this.gear = 1;
  }

  /** Place the car on the ground at `pos` facing `dir` (zero velocity). */
  reset(pos, dir) {
    this._pendPos.copy(pos);
    this._pendDir.set(dir.x, 0, dir.z);
    if (this._pendDir.lengthSq() < 1e-8) this._pendDir.set(0, 0, -1);
    this._pendDir.normalize();
    this._pending = true;

    const yaw = Math.atan2(-this._pendDir.x, -this._pendDir.z);
    this.quaternion.setFromAxisAngle(_axis.set(0, 1, 0), yaw);
    this.position.set(pos.x, pos.y + COM_H, pos.z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.speed = 0;
    this.rpm = IDLE_RPM;
    this.gear = 1;
    this.throttle = 0;
    this.airborne = false;
    this.upsideDown = false;
    this.bodyContact = false;
    this._shiftTimer = 0; this._shiftCool = 0; this._revTimer = 0; this._limiter = false;
    this._wheelRpm = 0; this._lock = 0; this._airTime = 0; this._flipTimer = 0; this._sideTimer = 0;
    this._collCool = 0; this._groundCool = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.omega = 0; w.ux = 0; w.uy = 0; w.contact = false; w.slipRatio = 0; w.slipAngle = 0;
      w.load = 0; w.compression = 0; w.water = 0; w.c = 0; w.steer = 0;
      w.cache = {};
    }
    for (let i = 0; i < this._bodyCache.length; i++) this._bodyCache[i] = {};
    this._comCache = {};
    this._lastGoodPos.copy(this.position);
    this._lastGoodQ.copy(this.quaternion);
    this._prevVel.set(0, 0, 0);
  }

  setLights(on) {
    const L = this._lights;
    if (!L) return;
    L.on = !!on;
    L.spots[0].visible = L.spots[1].visible = !!on;
    L.headMat.emissiveIntensity = on ? 2.2 : 0.15;
    L.podMat.emissiveIntensity = on ? 2.0 : 0.1;
    L.tailMat.emissiveIntensity = on ? 1.6 : 0.5;
  }

  /** Advance physics by dt seconds (normally one 1/120 s step). */
  update(dt, input, track) {
    if (!(dt > 0)) return;
    let n = 1, h = dt;
    if (dt > MAX_SUBSTEP) { n = Math.ceil(dt / MAX_SUBSTEP); h = dt / n; }
    for (let i = 0; i < n; i++) this._step(h, input || EMPTY_INPUT, track, i === 0);
  }

  // ------------------------------------------------------------------------------------------
  // one physics step
  // ------------------------------------------------------------------------------------------
  _addF(ax, ay, az, rx, ry, rz) {
    this._fx += ax; this._fy += ay; this._fz += az;
    this._tx += ry * az - rz * ay;
    this._ty += rz * ax - rx * az;
    this._tz += rx * ay - ry * ax;
  }

  _step(h, input, track, first) {
    const pos = this.position, vel = this.velocity, w = this.angularVelocity, q = this.quaternion;
    const wh = this.wheels;

    if (this._pending) this._align(track);

    _fw.set(0, 0, -1).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    _rt.set(1, 0, 0).applyQuaternion(q);
    const vF = vel.x * _fw.x + vel.y * _fw.y + vel.z * _fw.z;
    this.speed = vF;
    const absV = Math.abs(vF);

    // ---- driver input
    let thr = clamp01(input.throttle || 0);
    let brk = clamp01(input.brake || 0);
    const hb = clamp01(input.handbrake || 0);
    const steerIn = clamp(input.steer || 0, -1, 1);

    // ---- gearbox + pedals
    this._gearLogic(h, thr, brk, input, first, vF);
    const gear = this.gear;
    let drive = thr, brakeIn = brk;
    if (gear < 0 && !this.manual) { drive = brk; brakeIn = thr; }
    if (!this.manual && absV < 0.8 && drive < 0.05 && brakeIn < 0.05 && hb < 0.05) brakeIn = 0.5; // auto hold

    // ---- steering
    const lockF = 1 - (1 - STEER_MIN_FACTOR) * sstep(0, STEER_SPEED_FULL, absV);
    let delta = steerIn * STEER_MAX * lockF;
    if (absV > 4) {
      // body slip angle based gentle counter-steer assist (keyboard friendliness)
      const vLat = vel.x * _rt.x + vel.y * _rt.y + vel.z * _rt.z;
      const beta = Math.atan2(vLat, Math.max(absV, 1)) * (vF >= 0 ? 1 : -1);
      delta += clamp(beta, -0.6, 0.6) * DRIFT_ASSIST * (1 - hb * 0.5);
    }
    delta = clamp(delta, -STEER_MAX, STEER_MAX);
    this.steerAngle = delta;
    {
      const tn = Math.tan(delta);
      const dIn = Math.atan2(WHEELBASE * tn, WHEELBASE - 0.5 * TRACK_W * Math.abs(tn) * 1.0);
      const dOut = Math.atan2(WHEELBASE * tn, WHEELBASE + 0.5 * TRACK_W * Math.abs(tn) * 1.0);
      // right turn (delta>0): right wheel inner
      wh[0].steer = delta >= 0 ? dOut : dIn;
      wh[1].steer = delta >= 0 ? dIn : dOut;
      wh[2].steer = 0; wh[3].steer = 0;
    }

    // ---- reset force accumulators
    this._fx = 0; this._fy = -MASS * G; this._fz = 0;
    this._tx = 0; this._ty = 0; this._tz = 0;

    // ---- pass A: geometry
    const wx = w.x, wy = w.y, wz = w.z;
    let contacts = 0;
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      const rm = W.rm.set(W.x, W.y, W.z).applyQuaternion(q);
      const px = pos.x + rm.x, py = pos.y + rm.y, pz = pos.z + rm.z;
      const qx = px - _up.x * STATIC_LEN, qz = pz - _up.z * STATIC_LEN;
      const g = track.groundAt(qx, qz, W.cache, W.g);
      W.contact = false;
      W.c = 0;
      W.surface = g.surface;
      W.water = g.water || 0;
      W.onRoad = g.onRoad;
      const dn = -(_up.x * g.nx + _up.y * g.ny + _up.z * g.nz);
      if (dn > -0.15) continue;
      let t = ((qx - px) * g.nx + (g.height - py) * g.ny + (qz - pz) * g.nz) / dn;
      if (t > MAXLEN) continue;
      let c = MAXLEN - t;
      if (c > MAXLEN + 0.3) { c = MAXLEN + 0.3; t = -0.3; }
      W.contact = true;
      W.c = c;
      contacts++;
      W.n.set(g.nx, g.ny, g.nz);
      W.cp.set(px - _up.x * t, py - _up.y * t, pz - _up.z * t);
      W.rc.set(W.cp.x - pos.x, W.cp.y - pos.y, W.cp.z - pos.z);
      // suspension speed
      const vmx = vel.x + (wy * rm.z - wz * rm.y);
      const vmy = vel.y + (wz * rm.x - wx * rm.z);
      const vmz = vel.z + (wx * rm.y - wy * rm.x);
      W.cdot = (vmx * g.nx + vmy * g.ny + vmz * g.nz) / dn;
    }
    this.airborne = contacts === 0;
    if (this.airborne) this._airTime += h; else this._airTime = 0;

    // ---- drivetrain torques
    this._drivetrain(h, drive, brakeIn, hb, vF);

    // ---- pass B: forces
    let maxComp = 0;
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      if (!W.contact) {
        W.load = 0; W.compression = 0; W.slipRatio = 0; W.slipAngle = 0;
        W.fxT = 0; W.kxImp = 0; W.ux = 0; W.uy = 0;
        continue;
      }
      const front = W.front;
      const c = W.c;
      const cdot = W.cdot;
      let F = (front ? K_F : K_R) * c + (cdot > 0 ? (front ? BUMP_F : BUMP_R) : (front ? REB_F : REB_R)) * cdot;
      const cb = c - (TRAVEL - BUMP_ZONE);
      if (cb > 0) F += K_BUMPSTOP * cb + (cdot > 0 ? C_BUMPSTOP * cdot : 0);
      // anti-roll bar
      const other = wh[i ^ 1];
      F += (front ? ARB_F : ARB_R) * (c - (other.contact ? other.c : 0));
      if (F < 0) F = 0; else if (F > MAX_SUSP_FORCE) F = MAX_SUSP_FORCE;
      W.load = F;
      W.compression = clamp01(c / TRAVEL);
      if (W.compression > maxComp) maxComp = W.compression;

      const n = W.n;
      const rc = W.rc;
      this._addF(n.x * F, n.y * F, n.z * F, rc.x, rc.y, rc.z);

      // ---- tyre
      const S = SURFACES[W.surface] || SURFACES.tarmac;
      const sd = W.steer;
      _wf.set(Math.sin(sd), 0, -Math.cos(sd)).applyQuaternion(q);
      const dotn = _wf.x * n.x + _wf.y * n.y + _wf.z * n.z;
      const fg = W.fg.set(_wf.x - n.x * dotn, _wf.y - n.y * dotn, _wf.z - n.z * dotn);
      fg.normalize();
      const rg = W.rg.set(fg.y * n.z - fg.z * n.y, fg.z * n.x - fg.x * n.z, fg.x * n.y - fg.y * n.x);

      const vpx = vel.x + (wy * rc.z - wz * rc.y);
      const vpy = vel.y + (wz * rc.x - wx * rc.z);
      const vpz = vel.z + (wx * rc.y - wy * rc.x);
      const vl = vpx * fg.x + vpy * fg.y + vpz * fg.z;
      const vt = vpx * rg.x + vpy * rg.y + vpz * rg.z;
      const Rw = W.omega * WHEEL_R;
      const sv = Rw - vl;
      const vr = Math.max(Math.sqrt(vl * vl + vt * vt), Math.abs(Rw));
      W.vr = vr;

      const kappa = clamp(W.ux / SIGMA_X, -1.5, 1.5);
      const alpha = Math.atan(W.uy / SIGMA_Y);
      tireForces(kappa, alpha, F, W.surface, _tf);
      const gs = front ? FRONT_GRIP : REAR_GRIP;
      let fx = _tf.fx * gs, fy = _tf.fy * gs;
      const mu = _tf.mu * gs;
      // low speed damping blend
      const b = 1 - sstep(0.8, 3.5, vr);
      if (b > 0) {
        const ds = F / 3000 * b;
        fx += LOWV_DAMP_X * ds * sv;
        fy -= LOWV_DAMP_Y * ds * vt;
      }
      const lim = mu * F;
      const fm = Math.sqrt(fx * fx + fy * fy);
      if (fm > lim && fm > 1e-6) { const k = lim / fm; fx *= k; fy *= k; }
      W.fxT = fx;
      // implicit stiffness for wheel spin integration
      const kx0 = mu * F * S.CB / (S.kPeak * SIGMA_X);
      const ratio = Math.abs(fx) / (Math.abs(W.ux) + 1e-5);
      W.kxImp = Math.min(kx0, ratio);

      W.slipRatio = kappa;
      W.slipAngle = alpha;

      // rolling resistance + surface drag (against longitudinal motion)
      const xr = vl / 0.4;
      const sg = xr / (1 + Math.abs(xr));
      const roll = (S.rolling + S.rolling2 * Math.abs(vl)) * F * sg;
      let fl = fx - roll;
      let ft = fy;
      // water drag
      if (W.water > 0) {
        const wd = WATER_DRAG * W.water;
        fl -= wd * vl * (1 + Math.abs(vl) * 0.05);
        ft -= wd * vt * 0.5;
      }
      const Fwx = fg.x * fl + rg.x * ft;
      const Fwy = fg.y * fl + rg.y * ft;
      const Fwz = fg.z * fl + rg.z * ft;
      this._addF(Fwx, Fwy, Fwz, rc.x, rc.y, rc.z);
    }

    // ---- aero
    {
      const sp = vel.length();
      const dragK = 0.5 * AIR_RHO * CDA * sp;
      this._fx -= dragK * vel.x; this._fy -= dragK * vel.y; this._fz -= dragK * vel.z;
      const down = 0.5 * AIR_RHO * CLA * sp * sp;
      this._fx -= _up.x * down; this._fy -= _up.y * down; this._fz -= _up.z * down;
    }

    // ---- body / roof vs ground
    this.bodyContact = false;
    if (maxComp > 0.8 || _up.y < 0.92 || contacts < 4) this._bodyGround(h, track);

    // ---- airborne stabilisation
    if (this._airTime > 0.12) {
      const sp = vel.length();
      if (sp > 8) {
        // pitch: nose follows velocity vector
        const ix = vel.x / sp, iy = vel.y / sp, iz = vel.z / sp;
        const ex = _fw.y * iz - _fw.z * iy, ey = _fw.z * ix - _fw.x * iz, ez = _fw.x * iy - _fw.y * ix;
        // project error onto the car's right axis (pitch only)
        const ep = ex * _rt.x + ey * _rt.y + ez * _rt.z;
        this._tx += _rt.x * ep * I_PITCH * AIR_PITCH_GAIN;
        this._ty += _rt.y * ep * I_PITCH * AIR_PITCH_GAIN;
        this._tz += _rt.z * ep * I_PITCH * AIR_PITCH_GAIN;
      }
      // roll: up towards world up
      const rex = _up.y * 0 - _up.z * 1, rez = _up.x * 1 - _up.y * 0; // up x Y
      const rl = rex * _fw.x + rez * _fw.z;
      this._tx += _fw.x * rl * I_ROLL * AIR_ROLL_GAIN;
      this._ty += _fw.y * rl * I_ROLL * AIR_ROLL_GAIN;
      this._tz += _fw.z * rl * I_ROLL * AIR_ROLL_GAIN;
      this._tx -= w.x * AIR_DAMP; this._ty -= w.y * AIR_DAMP * 0.5; this._tz -= w.z * AIR_DAMP;
    }

    // ---- wheel spin integration (implicit tyre coupling + brake lock clamp)
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      const I = WHEEL_I + this._lock * this._reflect;
      const T = this._tdrv[i] - W.fxT * WHEEL_R * (W.contact ? 1 : 0);
      let kd = 0;
      if (W.contact) kd = h * h * WHEEL_R * WHEEL_R * W.kxImp / (1 + h * W.vr / SIGMA_X);
      let om = W.omega + h * T / (I + kd);
      const tb = this._tbrk[i];
      if (tb > 0) {
        const dw = tb * h / WHEEL_I; // brake acts on the wheel itself
        if (Math.abs(om) <= dw) om = 0; else om -= om > 0 ? dw : -dw;
      }
      om = clamp(om, -MAX_WHEEL_W, MAX_WHEEL_W);
      W.omega = om;
      W.spin += om * h;
      if (W.spin > 1e4 || W.spin < -1e4) W.spin %= (Math.PI * 2);
    }

    // ---- integrate linear
    const ih = h / MASS;
    vel.x += this._fx * ih; vel.y += this._fy * ih; vel.z += this._fz * ih;

    // ---- integrate angular (body frame, with gyroscopic term)
    _qi.copy(q).invert();
    _wb.copy(w).applyQuaternion(_qi);
    _tb.set(this._tx, this._ty, this._tz).applyQuaternion(_qi);
    {
      const bx = _wb.x, by = _wb.y, bz = _wb.z;
      _wb.x += h * (_tb.x - by * bz * (I_ROLL - I_YAW)) / I_PITCH;
      _wb.y += h * (_tb.y - bz * bx * (I_PITCH - I_ROLL)) / I_YAW;
      _wb.z += h * (_tb.z - bx * by * (I_YAW - I_PITCH)) / I_ROLL;
    }
    w.copy(_wb).applyQuaternion(q);

    // ---- update tyre deflection states with the new velocities
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      if (!W.contact) continue;
      const rc = W.rc, fg = W.fg, rg = W.rg;
      const vpx = vel.x + (w.y * rc.z - w.z * rc.y);
      const vpy = vel.y + (w.z * rc.x - w.x * rc.z);
      const vpz = vel.z + (w.x * rc.y - w.y * rc.x);
      const vl = vpx * fg.x + vpy * fg.y + vpz * fg.z;
      const vt = vpx * rg.x + vpy * rg.y + vpz * rg.z;
      const Rw = W.omega * WHEEL_R;
      const vr = Math.max(Math.sqrt(vl * vl + vt * vt), Math.abs(Rw));
      W.ux = clamp((W.ux + h * (Rw - vl)) / (1 + h * vr / SIGMA_X), -1.6 * SIGMA_X, 1.6 * SIGMA_X);
      W.uy = clamp((W.uy + h * vt) / (1 + h * vr / SIGMA_Y), -4 * SIGMA_Y, 4 * SIGMA_Y);
    }

    // ---- integrate position + orientation
    pos.x += vel.x * h; pos.y += vel.y * h; pos.z += vel.z * h;
    {
      const ang = w.length() * h;
      if (ang > 1e-10) {
        _axis.copy(w).normalize();
        _dq.setFromAxisAngle(_axis, ang);
        q.premultiply(_dq).normalize();
      }
    }

    // ---- obstacles
    if (this._collCool > 0) this._collCool -= h;
    if (this._groundCool > 0) this._groundCool -= h;
    this._collide(track);

    // ---- flip / stuck state
    {
      _up.set(0, 1, 0).applyQuaternion(q);
      if (_up.y < -0.1) this._flipTimer += h; else this._flipTimer = 0;
      if (_up.y < 0.35 && vel.length() < 1.5) this._sideTimer += h; else this._sideTimer = 0;
      this.upsideDown = this._flipTimer > 1 || this._sideTimer > 2.5;
    }

    // ---- accelerations for telemetry (low-passed)
    {
      const ax = (vel.x - this._prevVel.x) / h, az = (vel.z - this._prevVel.z) / h;
      _fw.set(0, 0, -1).applyQuaternion(q);
      _rt.set(1, 0, 0).applyQuaternion(q);
      this.longG += ((ax * _fw.x + az * _fw.z) / G - this.longG) * 0.1;
      this.lateralG += ((ax * _rt.x + az * _rt.z) / G - this.lateralG) * 0.1;
      this._prevVel.copy(vel);
    }

    // ---- NaN guard
    const sum = pos.x + pos.y + pos.z + vel.x + vel.y + vel.z + w.x + w.y + w.z + q.x + q.y + q.z + q.w;
    if (!Number.isFinite(sum)) {
      if (!this._nanLogged) { this._nanLogged = true; console.warn('[vehicle] non-finite state detected; resetting velocities'); }
      pos.copy(this._lastGoodPos); q.copy(this._lastGoodQ);
      vel.set(0, 0, 0); w.set(0, 0, 0);
      this._prevVel.set(0, 0, 0);
      for (let i = 0; i < 4; i++) { const W = wh[i]; W.omega = 0; W.ux = 0; W.uy = 0; }
      this.rpm = IDLE_RPM;
    } else {
      this._lastGoodPos.copy(pos); this._lastGoodQ.copy(q);
    }
  }

  // ------------------------------------------------------------------------------------------
  _align(track) {
    this._pending = false;
    const p = this._pendPos;
    const g = track.groundAt(p.x, p.z, this.wheels[0].cache, _gb);
    _t1.set(g.nx, g.ny, g.nz);
    if (_t1.lengthSq() < 0.5) _t1.set(0, 1, 0);
    _t1.normalize();
    const yaw = Math.atan2(-this._pendDir.x, -this._pendDir.z);
    _q2.setFromAxisAngle(_axis.set(0, 1, 0), yaw);
    _dq.setFromUnitVectors(_axis.set(0, 1, 0), _t1);
    this.quaternion.copy(_dq).multiply(_q2).normalize();
    // honour a spawn clearly above the ground (e.g. drops), otherwise snap to static ride height
    const h0 = g.height;
    const lift = (p.y > h0 + 0.8) ? (p.y - h0) : 0;
    this.position.set(p.x + _t1.x * COM_H, h0 + _t1.y * COM_H + lift, p.z + _t1.z * COM_H);
    this._lastGoodPos.copy(this.position);
    this._lastGoodQ.copy(this.quaternion);
  }

  // ------------------------------------------------------------------------------------------
  _gearLogic(h, thr, brk, input, first, vF) {
    if (this._shiftTimer > 0) this._shiftTimer -= h;
    if (this._shiftCool > 0) this._shiftCool -= h;
    const rpm = this._wheelRpm;
    if (this.manual) {
      if (first && this._shiftTimer <= 0) {
        if (input.shiftUp && this.gear < 6) { this.gear++; this._shiftTimer = SHIFT_TIME * 0.7; }
        else if (input.shiftDown && this.gear > -1) { this.gear--; this._shiftTimer = SHIFT_TIME * 0.7; }
      }
      return;
    }
    // automatic
    if (this.gear >= 0) {
      if (this.gear === 0) this.gear = 1;
      if (brk > 0.1 && thr < 0.1 && vF < 1.0) {
        this._revTimer += h;
        if (this._revTimer > 0.2) { this.gear = -1; this._revTimer = 0; this._shiftTimer = 0.15; }
      } else this._revTimer = 0;
      if (this._shiftTimer <= 0 && this._shiftCool <= 0 && this.gear >= 1) {
        const g = this.gear;
        if (rpm > Math.min(UPSHIFT_RPM, this._ceiling - 450) && g < 6) {
          this.gear = g + 1; this._shiftTimer = SHIFT_TIME; this._shiftCool = 0.5;
        } else if (g > 1) {
          const down = thr > 0.7 ? 4000 : DOWNSHIFT_RPM;
          if (rpm < down && rpm * GEARS[g - 2] / GEARS[g - 1] < 6300) {
            this.gear = g - 1; this._shiftTimer = SHIFT_TIME * 0.6; this._shiftCool = 0.4;
          }
        }
      }
    } else {
      if (thr > 0.1 && brk < 0.5 && vF > -1.5) {
        this._revTimer += h;
        if (this._revTimer > 0.1) { this.gear = 1; this._revTimer = 0; this._shiftTimer = 0.15; }
      } else this._revTimer = 0;
    }
  }

  // ------------------------------------------------------------------------------------------
  _drivetrain(h, drive, brakeIn, hb, vF) {
    const wh = this.wheels;
    const gear = this.gear;
    const gr = gear > 0 ? GEARS[gear - 1] : gear < 0 ? REV_GEAR : 0;
    const ratio = gr * FINAL_DRIVE;
    const dsign = gear < 0 ? -1 : 1;
    const shifting = this._shiftTimer > 0;

    // wheel-derived engine speed
    const avgW = (wh[0].omega + wh[1].omega + wh[2].omega + wh[3].omega) * 0.25;
    const wheelRpm = Math.max(0, avgW * dsign) * ratio * 9.5493;
    this._wheelRpm = wheelRpm;

    // engine speed
    let rpm = this.rpm;
    let target;
    if (ratio === 0) {
      target = IDLE_RPM + (REDLINE - IDLE_RPM) * 0.95 * drive;
    } else {
      const floor = IDLE_RPM + (LAUNCH_RPM - IDLE_RPM) * drive;
      target = shifting ? Math.max(wheelRpm, IDLE_RPM) : Math.max(wheelRpm, floor);
    }
    if (ratio !== 0 && !shifting && wheelRpm >= target - 1) rpm = wheelRpm;           // locked
    else rpm += (target - rpm) * Math.min(1, h * (target > rpm ? 22 : 9));
    if (rpm < IDLE_RPM) rpm = IDLE_RPM;
    if (rpm > REDLINE + 600) rpm = REDLINE + 600;
    this.rpm = rpm;

    // rev limiter
    const ceiling = REDLINE;
    this._ceiling = ceiling;
    if (rpm >= ceiling) this._limiter = true; else if (rpm < ceiling - 250) this._limiter = false;

    const floorRpm = IDLE_RPM + (LAUNCH_RPM - IDLE_RPM) * drive;
    const lock = (ratio === 0 || shifting) ? 0 : clamp((wheelRpm - floorRpm) / 250 + 1, 0, 1);
    this._lock = lock;
    this._reflect = ENGINE_INERTIA * ratio * ratio * 0.25;

    let thrEff = (this._limiter || shifting || ratio === 0) ? 0 : drive;
    this.throttle = thrEff;

    let Te = thrEff * TORQUE_PEAK * torqueCurve(rpm);
    if (!shifting && ratio !== 0) {
      const eb = (ENGINE_BRAKE0 + ENGINE_BRAKE1 * rpm) * lock;
      Te -= (1 - thrEff) * eb * (this._limiter ? 1.5 : 1);
      if (rpm > REDLINE + 150) Te -= 80 * lock;
    }
    const Tw = Te * ratio * DRIVE_EFF * dsign;

    const Tf = Tw * FRONT_SPLIT, Tr = Tw * (1 - FRONT_SPLIT);
    let sL = 0.5 + clamp((wh[1].omega - wh[0].omega) * dsign * LSD_K, -LSD_MAX, LSD_MAX);
    this._tdrv[0] = Tf * sL; this._tdrv[1] = Tf * (1 - sL);
    sL = 0.5 + clamp((wh[3].omega - wh[2].omega) * dsign * LSD_K, -LSD_MAX, LSD_MAX);
    this._tdrv[2] = Tr * sL; this._tdrv[3] = Tr * (1 - sL);
    // traction control: cut torque on wheels spinning well past the peak slip
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      if (!W.contact) continue;
      const S = SURFACES[W.surface] || SURFACES.tarmac;
      const excess = W.slipRatio * dsign - S.kPeak * 1.25;
      if (excess > 0) {
        const f = clamp(1 - excess / TC_BAND, 0.1, 1);
        this._tdrv[i] *= 1 - TRACTION_CONTROL * (1 - f);
      }
    }

    // brakes
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      let tb = 0;
      if (brakeIn > 0) {
        tb = brakeIn * BRAKE_TOTAL * (W.front ? BRAKE_BIAS_F : 1 - BRAKE_BIAS_F) * 0.5;
        if (W.contact && Math.abs(vF) > ABS_SPEED) {
          const S = SURFACES[W.surface] || SURFACES.tarmac;
          const bs = -W.slipRatio * (vF >= 0 ? 1 : -1);
          const lim = S.kPeak * 1.25;
          if (bs > lim) tb *= clamp(1 - (bs - lim) / (ABS_BAND), 0, 1);
        }
      }
      if (!W.front && hb > 0) tb += hb * HANDBRAKE_TORQUE;
      this._tbrk[i] = tb;
    }
  }

  // ------------------------------------------------------------------------------------------
  _bodyGround(h, track) {
    const pos = this.position, vel = this.velocity, w = this.angularVelocity, q = this.quaternion;
    for (let i = 0; i < BODY_PTS.length; i++) {
      const P = BODY_PTS[i];
      _t1.set(P[0], P[1], P[2]).applyQuaternion(q);
      const px = pos.x + _t1.x, py = pos.y + _t1.y, pz = pos.z + _t1.z;
      const g = track.groundAt(px, pz, this._bodyCache[i], _gb);
      const pen = (g.height - py) * g.ny;
      if (pen <= 0) continue;
      this.bodyContact = true;
      const rx = _t1.x, ry = _t1.y, rz = _t1.z;
      const vpx = vel.x + (w.y * rz - w.z * ry);
      const vpy = vel.y + (w.z * rx - w.x * rz);
      const vpz = vel.z + (w.x * ry - w.y * rx);
      const vn = vpx * g.nx + vpy * g.ny + vpz * g.nz;
      let Fn = BODY_K * Math.min(pen, 0.5) + (vn < 0 ? -BODY_C * vn : 0);
      if (Fn > 160000) Fn = 160000;
      if (Fn < 0) Fn = 0;
      const tx = vpx - g.nx * vn, ty = vpy - g.ny * vn, tz = vpz - g.nz * vn;
      const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
      let Ft = Math.min(BODY_MU * Fn, BODY_TANG * tm);
      let fx = g.nx * Fn, fy = g.ny * Fn, fz = g.nz * Fn;
      if (tm > 1e-6) { const k = Ft / tm; fx -= tx * k; fy -= ty * k; fz -= tz * k; }
      this._addF(fx, fy, fz, rx, ry, rz);
      if (P[3] === 1 && vn < -5 && this._groundCool <= 0) {
        this._groundCool = 0.4;
        if (this.onImpact) this.onImpact(-vn, 'ground');
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  _collide(track) {
    const list = track.collidersNear ? track.collidersNear(this.position.x, this.position.z, 4) : null;
    if (!list || list.length === 0) return;
    const pos = this.position, vel = this.velocity, w = this.angularVelocity, q = this.quaternion;
    _fw.set(0, 0, -1).applyQuaternion(q);
    // keep the footprint horizontal
    const fl = Math.sqrt(_fw.x * _fw.x + _fw.z * _fw.z) || 1;
    const fx = _fw.x / fl, fz = _fw.z / fl;
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      for (let j = 0; j < 3; j++) {
        const cx = pos.x + fx * -CIRCLE_Z[j], cz = pos.z + fz * -CIRCLE_Z[j];
        let dx = cx - c.x, dz = cz - c.z;
        const rs = CIRCLE_R + c.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rs * rs) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-5) { dx = -fx; dz = -fz; d = 1e-5; }
        const nx = dx / (d < 1e-5 ? 1 : d), nz = dz / (d < 1e-5 ? 1 : d);
        const pen = rs - d;
        // position correction
        const corr = Math.min(pen, 0.35) * 0.9;
        pos.x += nx * corr; pos.z += nz * corr;
        // contact point relative to COM (horizontal)
        const px = c.x + nx * c.r, pz = c.z + nz * c.r;
        const rx = px - pos.x, rz = pz - pos.z;
        const vpx = vel.x + w.y * rz;
        const vpz = vel.z - w.y * rx;
        const vn = vpx * nx + vpz * nz;
        if (vn >= 0) continue;
        const rxn = rz * nx - rx * nz;
        const kinv = 1 / MASS + rxn * rxn / I_YAW;
        const e = -vn > 1.5 ? RESTITUTION : 0;
        const jn = -(1 + e) * vn / kinv;
        vel.x += nx * jn / MASS; vel.z += nz * jn / MASS;
        w.y += rxn * jn / I_YAW;
        // tangential friction impulse
        const tx = -nz, tz = nx;
        const vt = vpx * tx + vpz * tz;
        const rxt = rz * tx - rx * tz;
        const ktinv = 1 / MASS + rxt * rxt / I_YAW;
        const jt = clamp(-vt / ktinv, -COLL_FRICTION * jn, COLL_FRICTION * jn);
        vel.x += tx * jt / MASS; vel.z += tz * jt / MASS;
        w.y += rxt * jt / I_YAW;

        const impact = -vn;
        if (impact > 1.5 && this._collCool <= 0) {
          this._collCool = 0.25;
          if (this.onImpact) this.onImpact(impact, c.kind);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // visuals
  // ------------------------------------------------------------------------------------------
  syncVisuals() {
    const m = this.mesh;
    m.position.copy(this.position);
    m.quaternion.copy(this.quaternion);
    const wv = this._wheelViz;
    if (wv) {
      for (let i = 0; i < 4; i++) {
        const W = this.wheels[i];
        const v = wv[i];
        const c = W.contact ? W.c : 0;
        const drop = TRAVEL - Math.min(c, TRAVEL + 0.05);
        v.pivot.position.set(W.x + (W.isRight ? 0.04 : -0.04), W.y - drop, W.z);
        v.pivot.rotation.y = -W.steer;
        v.spin.rotation.x = -(W.spin % (Math.PI * 2));
      }
    }
    // brake lights
    if (this._lights && !this._lights.on && this._lights.tailMat) {
      this._lights.tailMat.emissiveIntensity = 0.5;
    }
  }

  _buildMesh(o) {
    const cast = this.quality !== 'low';
    const baseColor = new THREE.Color(o.color);
    const livery = new THREE.Color(0xf2f2f2);
    const hsl = {};
    baseColor.getHSL(hsl);
    if (hsl.l > 0.75) livery.set(0x1a1a22);

    const mk = (color, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, flatShading: true, roughness: 0.55, metalness: 0.15 }, extra || {}));
    const bodyMat = mk(baseColor.clone());
    const liveryMat = mk(livery, { roughness: 0.6, metalness: 0.05 });
    const glassMat = mk(0x141b24, { roughness: 0.15, metalness: 0.6 });
    const darkMat = mk(0x1b1b1e, { roughness: 0.8, metalness: 0.1 });
    const whiteMat = mk(0xf4f4f0, { roughness: 0.7, metalness: 0 });
    const headMat = mk(0xfff4d0, { emissive: new THREE.Color(0xfff0c0), emissiveIntensity: 0.15 });
    const podMat = mk(0xfff4d0, { emissive: new THREE.Color(0xffe9a8), emissiveIntensity: 0.1 });
    const tailMat = mk(0x801010, { emissive: new THREE.Color(0xff1010), emissiveIntensity: 0.5 });
    const rubberMat = mk(0x151517, { roughness: 0.95, metalness: 0 });
    const rimMat = mk(0xc9ccd1, { roughness: 0.4, metalness: 0.7 });

    const mats = { body: new MeshBuilder(), livery: new MeshBuilder(), glass: new MeshBuilder(), dark: new MeshBuilder(),
      white: new MeshBuilder(), head: new MeshBuilder(), pod: new MeshBuilder(), tail: new MeshBuilder() };
    const B = mats;

    // main hull: side profile [z, y]
    B.body.addPrism([[-2.02, -0.28], [-2.10, 0.00], [-1.95, 0.165], [-0.80, 0.30], [1.80, 0.34], [2.04, 0.20], [2.02, -0.28]], 0.88);
    // cabin (windows) + roof
    B.glass.addPrism([[-0.80, 0.29], [-0.14, 0.84], [1.04, 0.86], [1.66, 0.33]], 0.76);
    B.body.addBox(1.52, 0.06, 1.18, 0, 0.885, 0.45);
    B.body.addBox(0.1, 0.5, 0.12, -0.77, 0.6, 0.35); B.body.addBox(0.1, 0.5, 0.12, 0.77, 0.6, 0.35);
    B.body.addBox(0.1, 0.52, 0.1, -0.74, 0.6, 1.25, -0.5); B.body.addBox(0.1, 0.52, 0.1, 0.74, 0.6, 1.25, -0.5);
    // fenders / arches flares
    B.body.addBox(0.12, 0.2, 0.9, -0.9, -0.02, Z_FRONT); B.body.addBox(0.12, 0.2, 0.9, 0.9, -0.02, Z_FRONT);
    B.body.addBox(0.12, 0.2, 0.9, -0.9, -0.02, Z_REAR); B.body.addBox(0.12, 0.2, 0.9, 0.9, -0.02, Z_REAR);
    // livery: bonnet stripe, roof stripe, side bands
    B.livery.addPrism([[-1.93, 0.176], [-0.80, 0.314], [-0.80, 0.302], [-1.93, 0.164]], 0.26);
    B.livery.addBox(0.5, 0.012, 1.18, 0, 0.92, 0.45);
    B.livery.addBox(0.012, 0.13, 3.2, -0.885, -0.05, 0.0); B.livery.addBox(0.012, 0.13, 3.2, 0.885, -0.05, 0.0);
    // rear wing
    B.livery.addBox(1.5, 0.04, 0.34, 0, 0.82, 1.98);
    B.dark.addBox(0.04, 0.32, 0.12, -0.5, 0.64, 1.96); B.dark.addBox(0.04, 0.32, 0.12, 0.5, 0.64, 1.96);
    B.livery.addBox(0.04, 0.16, 0.36, -0.76, 0.84, 1.98); B.livery.addBox(0.04, 0.16, 0.36, 0.76, 0.84, 1.98);
    // roof vent
    B.dark.addBox(0.34, 0.08, 0.42, 0, 0.96, 0.15);
    // mud flaps
    B.dark.addBox(0.02, 0.22, 0.26, -0.9, -0.2, Z_REAR + 0.5); B.dark.addBox(0.02, 0.22, 0.26, 0.9, -0.2, Z_REAR + 0.5);
    B.dark.addBox(0.02, 0.2, 0.22, -0.9, -0.2, Z_FRONT + 0.5); B.dark.addBox(0.02, 0.2, 0.22, 0.9, -0.2, Z_FRONT + 0.5);
    // undertray / diffuser
    B.dark.addBox(1.6, 0.05, 3.6, 0, -0.29, 0);
    // front light pod + lamps
    B.dark.addBox(0.98, 0.12, 0.2, 0, 0.255, -1.72);
    for (let i = 0; i < 4; i++) B.pod.addBox(0.17, 0.12, 0.06, -0.36 + i * 0.24, 0.255, -1.835);
    // headlights, tail lights, plates
    B.head.addBox(0.3, 0.1, 0.05, -0.6, 0.06, -2.1); B.head.addBox(0.3, 0.1, 0.05, 0.6, 0.06, -2.1);
    B.tail.addBox(0.34, 0.1, 0.05, -0.62, 0.12, 2.06); B.tail.addBox(0.34, 0.1, 0.05, 0.62, 0.12, 2.06);
    B.white.addBox(0.5, 0.12, 0.03, 0, -0.1, -2.17);
    B.white.addBox(0.5, 0.12, 0.03, 0, 0.0, 2.08);
    B.white.addBox(0.012, 0.3, 0.3, -0.89, 0.12, 0.2); B.white.addBox(0.012, 0.3, 0.3, 0.89, 0.12, 0.2);

    const addMesh = (builder, mat, name) => {
      const mesh = builder.build(mat);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = false;
      this.mesh.add(mesh);
      return mesh;
    };
    addMesh(B.body, bodyMat, 'body');
    addMesh(B.livery, liveryMat, 'livery');
    addMesh(B.glass, glassMat, 'glass');
    addMesh(B.dark, darkMat, 'dark');
    addMesh(B.white, whiteMat, 'white');
    addMesh(B.head, headMat, 'headlights');
    addMesh(B.pod, podMat, 'pod');
    addMesh(B.tail, tailMat, 'taillights');

    // front bumper / splitter
    const bGeo = new THREE.BoxGeometry(1.72, 0.14, 0.2);
    const bumper = new THREE.Mesh(bGeo, darkMat);
    bumper.position.set(0, -0.2, -2.06);
    bumper.castShadow = cast;
    this.mesh.add(bumper);

    // wheels
    this._wheelViz = [];
    const tireGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.24, 10).rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.26, 10).rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.28, 0.07, 0.36);
    const spokeGeo2 = new THREE.BoxGeometry(0.28, 0.36, 0.07);
    for (let i = 0; i < 4; i++) {
      const W = this.wheels[i];
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, rubberMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      const s1 = new THREE.Mesh(spokeGeo, darkMat);
      const s2 = new THREE.Mesh(spokeGeo2, darkMat);
      tire.castShadow = cast; rim.castShadow = false;
      spin.add(tire, rim, s1, s2);
      pivot.add(spin);
      pivot.position.set(W.x, W.y - (TRAVEL - STATIC_C), W.z);
      this.mesh.add(pivot);
      this._wheelViz.push({ pivot, spin });
    }

    // lights
    const spots = [];
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff2d6, 120, 110, 0.42, 0.6, 1.2);
      s.position.set(i === 0 ? -0.6 : 0.6, 0.1, -2.1);
      s.target.position.set(i === 0 ? -0.9 : 0.9, -0.5, -32);
      s.castShadow = false;
      s.visible = false;
      this.mesh.add(s);
      this.mesh.add(s.target);
      spots.push(s);
    }
    this._lights = { spots, headMat, podMat, tailMat, on: false };
    this.setLights(false);
  }
}

const EMPTY_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false };

// ============================================================================================
// tiny geometry merger so the whole body is a handful of draw calls
// ============================================================================================
class MeshBuilder {
  constructor() { this.pos = []; }

  _push(x, y, z) { this.pos.push(x, y, z); }

  addBox(w, h, d, x, y, z, rotX = 0) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    if (rotX) g.rotateX(rotX);
    g.translate(x, y, z);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) this._push(p.getX(i), p.getY(i), p.getZ(i));
    g.dispose();
  }

  /** Extrude a convex-ish [z, y] side profile across x in [-hw, hw]. */
  addPrism(pts, hw) {
    const n = pts.length;
    let cz = 0, cy = 0;
    for (const p of pts) { cz += p[0]; cy += p[1]; }
    cz /= n; cy /= n;
    const tri = (a, b, c) => {
      // orient outward relative to solid centre (0, cy, cz)
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3 - cy, mz = (a[2] + b[2] + c[2]) / 3 - cz;
      if (nx * mx + ny * my + nz * mz < 0) { const t = b; b = c; c = t; }
      this._push(a[0], a[1], a[2]); this._push(b[0], b[1], b[2]); this._push(c[0], c[1], c[2]);
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      for (const sx of [-hw, hw]) tri([sx, cy, cz], [sx, pts[i][1], pts[i][0]], [sx, pts[j][1], pts[j][0]]);
      const a = [-hw, pts[i][1], pts[i][0]], b = [hw, pts[i][1], pts[i][0]];
      const c = [hw, pts[j][1], pts[j][0]], d = [-hw, pts[j][1], pts[j][0]];
      tri(a, b, c); tri(a, c, d);
    }
  }

  build(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    return new THREE.Mesh(g, material);
  }
}
