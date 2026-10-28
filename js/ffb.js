// ffb.js — steering wheel force feedback for Right Right Right.
//
// Two halves:
//   FfbModel     pure, allocation-free: turns vehicle state into one signed steering force
//                (-1..1, + = pushes the wheel rim to the RIGHT). Testable in node.
//   ForceFeedback owns the model plus an output backend. The Gamepad API cannot drive wheel
//                motors, so output goes through WebHID. Implemented: Logitech "classic" protocol
//                (G25 / G27 / G29 / G923 PlayStation / DFGT / DFP / DF-EX). Other wheels fall back
//                to the gamepad vibration actuator (road texture + impacts only) if they have one.
//
// The force is built the way a real rack feels:
//   * self-aligning torque  front lateral force x (mechanical + pneumatic trail). Pneumatic trail
//                           collapses as the tyre approaches its peak slip, so the wheel goes light
//                           just before the front washes out, and follows the slide when drifting.
//   * weight jacking        caster lift: a small centring spring proportional to front load.
//   * scrub / friction      heavy at standstill (tyres scrubbing), fading out with speed.
//   * damping               rack + column damping against wheel rim velocity.
//   * kickback              suspension velocity difference left/right (bumps, ruts) and
//                           longitudinal force difference x scrub radius (one wheel on grass, ice).
//   * road texture          surface-dependent noise scaled by speed and load (gravel buzz, tarmac hum).
//   * impacts               decaying jolts from collisions / heavy landings.
//   * soft lock             spring wall past the configured rotation.
// Airborne the tyres carry no force, so the wheel goes slack apart from damping.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// --- model constants (rack in Nm, normalised by TORQUE_REF)
const TORQUE_REF = 340;        // Nm of total kingpin torque that maps to full force at gain 1
const MECH_TRAIL = 0.020;      // m, caster trail (keeps weight while sliding)
const PNEU_TRAIL = 0.045;      // m, pneumatic trail at zero slip
const PNEU_MIN = -0.15;        // pneumatic trail fraction past the peak (slightly negative = light)
const SCRUB_RADIUS = 0.012;    // m, longitudinal force lever about the kingpin
const JACK_K = 0.011;          // Nm per N of front load per rad of steer
const SCRUB_FRICTION = 0.22;   // normalised friction at standstill and 3500 N front load
const BUMP_K = 0.28;           // normalised force per m/s of left/right suspension speed difference
const STEER_MAX = 32 * Math.PI / 180; // matches vehicle.js, for impacts on the rim scale
const REF_LOAD = 3200;         // N, nominal front wheel load
const SOFTLOCK_K = 6;          // normalised force per unit of overtravel past lock

// roughness 0..1 of the road surface felt through the rim
export const SURFACE_TEXTURE = {
  tarmac: 0.05, wet: 0.05, gravel: 0.55, dirt: 0.4, sand: 0.25, snow: 0.18,
  ice: 0.04, mud: 0.22, grass: 0.35, ash: 0.4,
};

export function defaultFfbSettings() {
  return {
    enabled: true,
    gain: 0.75,       // overall strength
    minForce: 0,      // deadband compensation for gear / belt wheels (0..0.2)
    damping: 0.35,    // rim damping
    texture: 0.5,     // road surface feel
    impacts: 0.7,     // collision / landing jolts
    softLock: true,
    invert: false,    // flip direction if the wheel pushes the wrong way
  };
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------
export class FfbModel {
  constructor(settings) {
    this.s = settings || defaultFfbSettings();
    this.force = 0;       // last output (after gain, before invert)
    this.clipping = 0;    // 0..1, smoothed fraction of time the output hits the rail
    // individual components (normalised, before gain) for the debug readout
    this.parts = { align: 0, jack: 0, friction: 0, damping: 0, kick: 0, texture: 0, impact: 0, lock: 0 };
    this._pos = 0; this._vel = 0; this._havePos = false;
    this._align = 0;
    this._nL = 0; this._nR = 0; this._seed = 12345;
    this._imp = []; // {a, t, f}
  }

  reset() {
    this._havePos = false; this._vel = 0; this._align = 0; this._imp.length = 0;
    this.force = 0; this.clipping = 0;
  }

  _rand() { // xorshift, deterministic for tests
    let x = this._seed | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._seed = x;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  }

  /** Queue a jolt; strength in m/s of impact speed (as vehicle.onImpact reports it). */
  impact(strength) {
    if (!(strength > 1.5)) return;
    if (this._imp.length > 6) this._imp.shift();
    this._imp.push({ a: Math.min(1, strength / 12) * (this._rand() < 0 ? -1 : 1), t: 0, f: 7 + (this._rand() + 1) * 2.5 });
  }

  /**
   * One update.
   * @param dt       seconds
   * @param v        vehicle (wheels[0]=FL, wheels[1]=FR with fy/slip/load/contact/surface/cdot/fxT,
   *                 speed, steerAngle) or null when not driving (menus / pause).
   * @param rimPos   wheel position in units of the used lock (+-1 = full lock, beyond = overtravel)
   * @returns        signed force -1..1, + = push rim right (settings.invert NOT applied)
   */
  update(dt, v, rimPos) {
    const s = this.s, P = this.parts;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    // rim velocity (units of lock per second), filtered
    if (!Number.isFinite(rimPos)) rimPos = 0;
    if (this._havePos) {
      const raw = (rimPos - this._pos) / dt;
      this._vel += (raw - this._vel) * Math.min(1, dt * 30);
    }
    this._pos = rimPos; this._havePos = true;
    const vel = this._vel;

    let align = 0, jack = 0, friction = 0, kick = 0, tex = 0;
    let speed = 0;
    if (v && v.wheels) {
      const L = v.wheels[0], R = v.wheels[1];
      speed = Math.abs(v.speed || 0);
      const lowFade = sstep(0.3, 2.5, speed);
      // self-aligning torque per front wheel
      let mz = 0, load = 0;
      for (let i = 0; i < 2; i++) {
        const W = v.wheels[i];
        if (!W.contact) continue;
        load += W.load;
        const sl = W.slip || 0;
        const tp = PNEU_TRAIL * clamp(1 - sl, PNEU_MIN, 1);
        mz += -(W.fy || 0) * (MECH_TRAIL + tp);
      }
      if (v.speed < 0) mz *= 0.5; // reversing: caster works backwards, keep it tame
      align = mz / TORQUE_REF * lowFade;
      // smooth physics sub-step noise (~30 Hz)
      this._align += (align - this._align) * Math.min(1, dt * 190);
      align = this._align;
      jack = -JACK_K * load * (v.steerAngle || 0) / TORQUE_REF;
      // scrub friction against rim motion, strong when parked
      const lf = load / (2 * REF_LOAD);
      friction = -SCRUB_FRICTION * lf * (1 - sstep(0, 5, speed)) * Math.tanh(vel / 0.15);
      // kickback
      if (L.contact && R.contact) {
        const dc = (L.cdot || 0) - (R.cdot || 0);
        kick = -BUMP_K * clamp(dc, -2, 2) * sstep(1, 8, speed);
        kick += SCRUB_RADIUS * ((L.fxT || 0) - (R.fxT || 0)) / TORQUE_REF;
      }
      // road texture: band-limited noise per wheel, steering feels the difference
      const k = Math.min(1, dt * (20 + speed * 1.5));
      this._nL += (this._rand() - this._nL) * k;
      this._nR += (this._rand() - this._nR) * k;
      const sp = sstep(1, 20, speed) * (0.6 + 0.4 * sstep(20, 40, speed));
      const ampL = L.contact ? (SURFACE_TEXTURE[L.surface] ?? 0.2) * L.load / REF_LOAD : 0;
      const ampR = R.contact ? (SURFACE_TEXTURE[R.surface] ?? 0.2) * R.load / REF_LOAD : 0;
      tex = 0.18 * sp * (this._nL * ampL - this._nR * ampR);
    } else {
      // menus / pause: gentle centring so the wheel is not dead
      jack = -0.15 * clamp(rimPos, -1, 1);
    }
    tex *= s.texture * 2;
    kick *= 0.5 + s.texture;

    // impacts
    let imp = 0;
    for (let i = this._imp.length - 1; i >= 0; i--) {
      const I = this._imp[i];
      I.t += dt;
      if (I.t > 0.5) { this._imp.splice(i, 1); continue; }
      imp += I.a * Math.exp(-I.t / 0.09) * Math.cos(2 * Math.PI * I.f * I.t);
    }
    imp *= s.impacts;

    // damping: some always, more at speed (rack + tyre)
    const damping = -s.damping * 0.12 * (0.6 + 0.4 * sstep(0, 25, speed)) * vel;

    let lock = 0;
    if (s.softLock) {
      const over = Math.abs(rimPos) - 1;
      if (over > 0) lock = -Math.sign(rimPos) * Math.min(1, over * SOFTLOCK_K) - 0.1 * vel;
    }

    P.align = align; P.jack = jack; P.friction = friction; P.damping = damping;
    P.kick = kick; P.texture = tex; P.impact = imp; P.lock = lock;

    let f = (align + jack + friction + kick + tex + imp) * s.gain * 1.25 + damping;
    // soft clip so peaks round off instead of flat-topping
    const a = Math.abs(f);
    if (a > 0.85) f = Math.sign(f) * (0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15));
    this.clipping += ((a > 0.95 ? 1 : 0) - this.clipping) * Math.min(1, dt * 2);
    f += lock; // lock is never scaled by gain: the wall must stay a wall
    f = clamp(f, -1, 1);
    if (s.minForce > 0 && Math.abs(f) > 0.003) f = Math.sign(f) * (s.minForce + (1 - s.minForce) * Math.abs(f));
    this.force = f;
    return f;
  }
}

// ---------------------------------------------------------------------------------------------
// Logitech classic protocol (as used by the Linux hid-logitech / lg4ff driver)
// ---------------------------------------------------------------------------------------------
export const LOGITECH_VENDOR = 0x046d;
// product id -> { name, range: supports the 0xf8 0x81 rotation command }
export const LOGITECH_WHEELS = {
  0xc294: { name: 'Driving Force / compat mode', range: false },
  0xc298: { name: 'Driving Force Pro', range: false },
  0xc299: { name: 'G25', range: true },
  0xc29a: { name: 'Driving Force GT', range: true },
  0xc29b: { name: 'G27', range: true },
  0xc24f: { name: 'G29', range: true },
  0xc266: { name: 'G923 (PlayStation)', range: true },
  0xc267: { name: 'G923 (PlayStation)', range: true },
};

/** 7 byte report: constant force in slot 1, f -1..1 (+ = right). */
export function lgConstantForce(f, out = new Uint8Array(7)) {
  const b = Math.round(0x80 + clamp(f, -1, 1) * 0x7f);
  out[0] = 0x11; out[1] = 0x08; out[2] = b; out[3] = 0x80; out[4] = 0; out[5] = 0; out[6] = 0;
  return out;
}
export const lgStop = () => Uint8Array.of(0x13, 0, 0, 0, 0, 0, 0);
export const lgAutocenterOff = () => Uint8Array.of(0xf5, 0, 0, 0, 0, 0, 0);
export function lgRange(deg) {
  const r = clamp(Math.round(deg), 40, 900);
  return Uint8Array.of(0xf8, 0x81, r & 0xff, r >> 8, 0, 0, 0);
}

class LogitechBackend {
  constructor(device) {
    this.device = device;
    this.info = LOGITECH_WHEELS[device.productId] || { name: device.productName, range: false };
    this.name = 'Logitech ' + this.info.name;
    this._buf = new Uint8Array(7);
    this._busy = false;
    this._sent = -1;
    this._want = 0x80;
    this._range = 0;
    this.error = '';
  }

  async open(rotation) {
    if (!this.device.opened) await this.device.open();
    await this._send(lgAutocenterOff());
    await this.setRange(rotation);
    await this._send(lgConstantForce(0));
  }

  async setRange(deg) {
    if (!this.info.range) return;
    const r = clamp(Math.round(deg), 40, 900);
    if (r === this._range) return;
    this._range = r;
    await this._send(lgRange(r));
  }

  _send(data) {
    return this.device.sendReport(0, data).catch((e) => { this.error = String(e && e.message || e); });
  }

  /** Non-blocking: sends the latest value whenever the previous report has gone out. */
  set(f) {
    this._want = Math.round(0x80 + clamp(f, -1, 1) * 0x7f);
    this._pump();
  }

  _pump() {
    if (this._busy || this._want === this._sent || !this.device.opened) return;
    const b = this._want;
    this._busy = true;
    lgConstantForce(0, this._buf);
    this._buf[2] = b;
    this.device.sendReport(0, this._buf).then(() => { this._sent = b; }, (e) => { this.error = String(e && e.message || e); })
      .finally(() => { this._busy = false; this._pump(); });
  }

  stop() {
    this._want = 0x80; this._sent = 0x80;
    if (this.device.opened) { this._send(lgConstantForce(0)); this._send(lgStop()); }
  }

  async close() {
    this.stop();
    try { await this.device.close(); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------------------------
// ForceFeedback: model + backend + settings UI
// ---------------------------------------------------------------------------------------------
const hidApi = () => (typeof navigator !== 'undefined' && navigator.hid) || null;

export class ForceFeedback {
  /** @param settings  the `ffb` sub-object of input settings (mutable, defaults filled by caller) */
  constructor(settings) {
    this.settings = settings;
    this.model = new FfbModel(settings);
    this.backend = null;
    this.status = hidApi() ? 'No force feedback wheel connected.' : 'Force feedback needs WebHID (Chrome / Edge).';
    this._lastUpdate = 0;
    this._watch = null;
    this._rumbleT = 0;
    this._suspended = false;
    this._attach();
    this._autoConnect();
  }

  get connected() { return !!this.backend; }

  _attach() {
    const hid = hidApi();
    if (hid && hid.addEventListener) {
      hid.addEventListener('disconnect', (e) => {
        if (this.backend && e.device === this.backend.device) { this.backend = null; this.status = 'Wheel disconnected.'; }
      });
      hid.addEventListener('connect', () => this._autoConnect());
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      // a constant force keeps playing on the wheel until replaced: never leave one behind
      const off = () => { this._suspended = true; this.stop(); };
      const on = () => { this._suspended = false; };
      window.addEventListener('blur', off);
      window.addEventListener('focus', on);
      window.addEventListener('pagehide', off);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) off(); else on(); });
    }
  }

  async _autoConnect() {
    const hid = hidApi();
    if (!hid || this.backend) return;
    try {
      const list = await hid.getDevices();
      const d = list.find((x) => x.vendorId === LOGITECH_VENDOR && LOGITECH_WHEELS[x.productId]);
      if (d) await this._use(d);
    } catch (e) { /* not permitted */ }
  }

  /** Must be called from a user gesture (button click). */
  async connect() {
    const hid = hidApi();
    if (!hid) { this.status = 'WebHID is not available in this browser.'; return false; }
    try {
      const filters = Object.keys(LOGITECH_WHEELS).map((p) => ({ vendorId: LOGITECH_VENDOR, productId: +p }));
      const [d] = await hid.requestDevice({ filters });
      if (!d) { this.status = 'No wheel selected.'; return false; }
      await this._use(d);
      return true;
    } catch (e) {
      this.status = 'Could not open wheel: ' + (e && e.message || e);
      return false;
    }
  }

  async _use(device) {
    const b = new LogitechBackend(device);
    try {
      await b.open(this.rotation || 540);
      this.backend = b;
      this.model.reset();
      this.status = `${b.name}: force feedback active.`;
    } catch (e) {
      this.status = `${b.name}: could not open (${e && e.message || e}). Close other apps using the wheel.`;
    }
  }

  async disconnect() {
    const b = this.backend; this.backend = null;
    if (b) await b.close();
    this.status = 'Force feedback disconnected.';
  }

  /** Physical rotation to program into the wheel (degrees lock-to-lock). */
  setRotation(deg) {
    this.rotation = deg;
    if (this.backend) this.backend.setRange(deg);
  }

  impact(strength) { if (this.settings.enabled) this.model.impact(strength); }

  /**
   * Call once per frame.
   * @param vehicle  the Vehicle while driving, null in menus / pause
   * @param rimPos   wheel rim position in units of the used lock (input.wheelPosition)
   * @param active   whether the wheel is the active input device
   */
  update(dt, vehicle, rimPos, active, pad) {
    const s = this.settings;
    this._lastUpdate = Date.now();
    this._armWatchdog();
    if (!s.enabled || !active || this._suspended) {
      if (this.backend) this.backend.set(0);
      this.model.force = 0;
      return 0;
    }
    let f = this.model.update(dt, vehicle, rimPos);
    if (s.invert) f = -f;
    if (this.backend) this.backend.set(f);
    else if (pad && vehicle) this._rumble(dt, pad);
    return f;
  }

  // wheels without a WebHID backend: feel the road through the rumble motors if there are any
  _rumble(dt, pad) {
    this._rumbleT -= dt;
    if (this._rumbleT > 0) return;
    this._rumbleT = 0.1;
    const P = this.model.parts;
    const act = pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    const weak = clamp(Math.abs(P.texture) * 3 + Math.abs(P.kick), 0, 1);
    const strong = clamp(Math.abs(P.impact), 0, 1);
    if (weak < 0.02 && strong < 0.02) return;
    try { act.playEffect('dual-rumble', { startDelay: 0, duration: 120, weakMagnitude: weak, strongMagnitude: strong }); } catch (e) { /* ignore */ }
  }

  _armWatchdog() {
    if (this._watch || typeof setTimeout === 'undefined') return;
    // frames stopped (tab throttled, breakpoint, long load): release the wheel
    this._watch = setTimeout(() => {
      this._watch = null;
      if (Date.now() - this._lastUpdate > 250) { if (this.backend) this.backend.stop(); } else this._armWatchdog();
    }, 300);
  }

  stop() { if (this.backend) this.backend.stop(); this.model.reset(); }

  /** Play a short test push. dir = +1 right / -1 left. */
  test(dir) {
    if (!this.backend) return;
    const f = (this.settings.invert ? -dir : dir) * 0.5;
    this.backend.set(f);
    setTimeout(() => this.backend && this.backend.set(0), 400);
  }

  // --- settings UI ------------------------------------------------------------------------
  renderSettings(parent, h, slider, onChange) {
    const doc = parent.ownerDocument || document;
    const S = this.settings;
    const box = h(doc, 'fieldset', { class: 'inp-box' }, [h(doc, 'legend', {}, 'Force feedback')]);
    const row = h(doc, 'div', { class: 'inp-row' }, [h(doc, 'label', {}, 'Enabled')]);
    const en = h(doc, 'input', { type: 'checkbox' }); en.checked = !!S.enabled;
    en.addEventListener('change', () => { S.enabled = en.checked; if (!en.checked) this.stop(); onChange(); });
    row.appendChild(en); box.appendChild(row);
    const msg = h(doc, 'div', { class: 'inp-cal-msg' }, this.status);
    const bar = h(doc, 'div', { class: 'inp-cal-bar' });
    const bConn = h(doc, 'button', { type: 'button' }, 'Connect wheel for force feedback');
    const bDisc = h(doc, 'button', { type: 'button' }, 'Disconnect');
    const bL = h(doc, 'button', { type: 'button' }, 'Test left');
    const bR = h(doc, 'button', { type: 'button' }, 'Test right');
    bar.append(bConn, bDisc, bL, bR);
    const sync = () => {
      msg.textContent = this.status;
      bConn.style.display = this.backend ? 'none' : '';
      bDisc.style.display = bL.style.display = bR.style.display = this.backend ? '' : 'none';
    };
    bConn.addEventListener('click', async () => { msg.textContent = 'Choose your wheel in the browser dialog...'; await this.connect(); sync(); });
    bDisc.addEventListener('click', async () => { await this.disconnect(); sync(); });
    bL.addEventListener('click', () => this.test(-1));
    bR.addEventListener('click', () => this.test(1));
    box.append(msg, bar);
    const f2 = (v) => (+v).toFixed(2);
    slider(box, 'Overall strength', S, 'gain', 0, 1.5, 0.05, f2);
    slider(box, 'Road feel (surface texture, bumps)', S, 'texture', 0, 1, 0.05, f2);
    slider(box, 'Impacts', S, 'impacts', 0, 1, 0.05, f2);
    slider(box, 'Damping', S, 'damping', 0, 1, 0.05, f2);
    slider(box, 'Minimum force (deadband compensation)', S, 'minForce', 0, 0.2, 0.01, f2);
    const chk = (label, key) => {
      const r = h(doc, 'div', { class: 'inp-row' }, [h(doc, 'label', {}, label)]);
      const c = h(doc, 'input', { type: 'checkbox' }); c.checked = !!S[key];
      c.addEventListener('change', () => { S[key] = c.checked; onChange(); });
      r.appendChild(c); box.appendChild(r);
    };
    chk('Soft lock at wheel rotation', 'softLock');
    chk('Invert force direction', 'invert');
    const live = h(doc, 'div', { class: 'inp-live' }, '');
    box.appendChild(live);
    parent.appendChild(box);
    sync();
    return () => { // called by the input UI timer
      if (msg.textContent !== this.status && !msg.textContent.startsWith('Choose')) sync();
      const m = this.model;
      live.textContent = `force ${(S.invert ? -m.force : m.force).toFixed(2)}${m.clipping > 0.2 ? '  CLIPPING - lower strength' : ''}` +
        (this.backend && this.backend.error ? `  | ${this.backend.error}` : '');
    };
  }
}
