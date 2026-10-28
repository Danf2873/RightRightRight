// input.js — keyboard / gamepad / steering wheel input for Right Right Right.
// Contract: docs/CONTRACTS.md (input.js). The InputState object returned by update() is REUSED
// every frame (no allocation); copy values if you need to keep them.

import { ForceFeedback, defaultFfbSettings } from './ffb.js';

const WHEEL_RE = /wheel|g29|g920|g923|t300|t150|tmx|fanatec|csl|moza|simucube|logitech.*racing|thrustmaster/i;
const EDGES = ['shiftUp', 'shiftDown', 'reset', 'restart', 'camera', 'pause', 'repeatNote', 'confirm', 'back'];
const KEY_ACTIONS = ['left', 'right', 'throttle', 'brake', 'handbrake', ...EDGES];
const RESET_HOLD_S = 0.6;

export const DEFAULT_KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  handbrake: ['Space'],
  shiftUp: ['KeyE'],
  shiftDown: ['KeyQ'],
  camera: ['KeyC'],
  reset: ['Backspace'],
  restart: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  repeatNote: ['KeyN'],
  confirm: ['Enter'],
  back: ['Escape'],
};

const ACTION_LABELS = {
  left: 'Steer left', right: 'Steer right', throttle: 'Throttle', brake: 'Brake / reverse',
  handbrake: 'Handbrake', shiftUp: 'Shift up', shiftDown: 'Shift down', camera: 'Change camera',
  reset: 'Reset to road', restart: 'Restart stage', pause: 'Pause', repeatNote: 'Repeat pace note',
  confirm: 'Confirm', back: 'Back',
};

/** Default value of settings.input (also what is filled in for missing fields). */
export function defaultInputSettings() {
  const axis = (a, invert = false, min = -1, max = 1) => ({ axis: a, invert, min, max });
  const keys = {};
  for (const k in DEFAULT_KEYS) keys[k] = DEFAULT_KEYS[k].slice();
  return {
    device: 'auto', // 'auto' | 'keyboard' | 'gamepad' | 'wheel'
    keys,
    keyboard: { lockTimeStanding: 0.12, lockTimeFast: 0.35, fastKmh: 150, returnFactor: 2.2, pedalTime: 0.08 },
    gamepad: { deadzone: 0.08, linearity: 1.4, sensitivity: 1 },
    wheel: {
      rotation: 540,        // degrees of wheel rotation used (full lock = +-rotation/2)
      deviceRotation: 900,  // the wheel's physical lock-to-lock (axis +-1 = +-deviceRotation/2)
      linearity: 1,         // response exponent, 1 = linear
      deadzone: 0.005,
      calibrated: false,
      profile: '',          // id of the pad the default profile was applied for
      steer: axis(0),
      throttle: axis(2, true),
      brake: axis(3, true),
      clutch: axis(-1, true), // -1 = unused; when bound it acts as handbrake
      // button indices, -1 = unbound
      buttons: { shiftUp: 4, shiftDown: 5, handbrake: -1, camera: 3, reset: 2, pause: 9, repeatNote: 8, confirm: 0, back: 1 },
    },
    ffb: defaultFfbSettings(),
  };
}

function fillDefaults(target, def) {
  for (const k in def) {
    const d = def[k];
    if (target[k] === undefined || target[k] === null) {
      target[k] = Array.isArray(d) ? d.slice() : (d && typeof d === 'object') ? fillDefaults({}, d) : d;
    } else if (d && typeof d === 'object' && !Array.isArray(d) && typeof target[k] === 'object') {
      fillDefaults(target[k], d);
    }
  }
  return target;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function isWheelPad(p) {
  if (!p) return false;
  if (WHEEL_RE.test(p.id || '')) return true;
  return p.mapping !== 'standard' && (p.axes ? p.axes.length : 0) >= 3;
}

/** Wheel profile defaults by pad id. Returns a partial wheel settings patch. */
export function wheelProfileFor(id) {
  const a = (axis, invert, min = -1, max = 1) => ({ axis, invert, min, max });
  if (/g29|g920|g923|logitech.*(racing|wheel)|driving force/i.test(id || '')) {
    return { steer: a(0, false), throttle: a(2, true), brake: a(3, true), clutch: a(-1, true),
      buttons: { shiftUp: 4, shiftDown: 5, handbrake: -1, camera: 3, reset: 2, pause: 9, repeatNote: 8, confirm: 0, back: 1 } };
  }
  // generic fallback
  return { steer: a(0, false), throttle: a(1, false), brake: a(2, false), clutch: a(-1, false),
    buttons: { shiftUp: 5, shiftDown: 4, handbrake: -1, camera: 3, reset: 2, pause: 9, repeatNote: 8, confirm: 0, back: 1 } };
}

/** Normalised pedal 0..1 from a raw axis value using {min,max,invert}. */
export function pedalValue(raw, cfg) {
  const span = cfg.max - cfg.min;
  let n = span ? (raw - cfg.min) / span : 0;
  n = clamp(n, 0, 1);
  if (cfg.invert) n = 1 - n;
  return n < 0.02 ? 0 : (n - 0.02) / 0.98;
}

/** Signed -1..1 from a raw axis (min..max range mapped to -1..1; invert flips). */
export function signedValue(raw, cfg) {
  const span = cfg.max - cfg.min;
  let n = span ? ((raw - cfg.min) / span) * 2 - 1 : 0;
  n = clamp(n, -1, 1);
  return cfg.invert ? -n : n;
}

// ---------------------------------------------------------------------------------------------
// Wheel calibration (pure logic, UI-independent so it is testable)
// ---------------------------------------------------------------------------------------------
export const CAL_STEPS = [
  { id: 'steerLeft', kind: 'axis', text: 'Turn the wheel fully LEFT and hold' },
  { id: 'steerRight', kind: 'axis', text: 'Turn the wheel fully RIGHT and hold' },
  { id: 'throttle', kind: 'axis', text: 'Press the THROTTLE pedal fully' },
  { id: 'brake', kind: 'axis', text: 'Press the BRAKE pedal fully' },
  { id: 'clutch', kind: 'axis', optional: true, text: 'Press the CLUTCH pedal (used as handbrake) - or skip' },
  { id: 'shiftUp', kind: 'button', text: 'Press the SHIFT UP button / paddle' },
  { id: 'shiftDown', kind: 'button', text: 'Press the SHIFT DOWN button / paddle' },
  { id: 'handbrake', kind: 'button', optional: true, text: 'Press the HANDBRAKE button - or skip' },
];

export class WheelCalibrator {
  constructor(wheelSettings) {
    this.w = wheelSettings;
    this.step = null;
    this.tmp = {};
  }

  begin(step, pad) {
    this.step = step;
    const n = pad ? pad.axes.length : 0;
    this.base = [];
    this.lo = [];
    this.hi = [];
    for (let i = 0; i < n; i++) { const v = pad.axes[i]; this.base.push(v); this.lo.push(v); this.hi.push(v); }
    this.prevBtn = [];
    if (pad) for (let i = 0; i < pad.buttons.length; i++) this.prevBtn.push(!!pad.buttons[i].pressed);
    this.hold = 0;
    this.best = -1;
    this.bestDelta = 0;
  }

  /** Feed a pad snapshot. Returns true when the step has been detected and applied. */
  feed(pad, dt) {
    if (!pad || !this.step) return false;
    const s = this.step;
    if (s.kind === 'button') {
      for (let i = 0; i < pad.buttons.length; i++) {
        const p = !!pad.buttons[i].pressed;
        if (p && !this.prevBtn[i]) { this.w.buttons[s.id] = i; return true; }
        this.prevBtn[i] = p;
      }
      return false;
    }
    const fixed = (s.id === 'steerRight') ? this.tmp.steerAxis : -1;
    let best = -1, bestD = 0;
    for (let i = 0; i < pad.axes.length && i < this.base.length; i++) {
      const v = pad.axes[i];
      if (Math.abs(v) > 1.5) continue; // hat-switch style axes
      if (v < this.lo[i]) this.lo[i] = v;
      if (v > this.hi[i]) this.hi[i] = v;
      if (fixed >= 0 && i !== fixed) continue;
      const d = Math.abs(v - this.base[i]);
      if (d > bestD) { bestD = d; best = i; }
    }
    this.best = best;
    this.bestDelta = bestD;
    if (best >= 0 && bestD >= 0.5) this.hold += dt; else this.hold = 0;
    if (this.hold < 0.35) return false;
    this._apply(best);
    return true;
  }

  _farthest(i) {
    const b = this.base[i];
    return (this.hi[i] - b) > (b - this.lo[i]) ? this.hi[i] : this.lo[i];
  }

  _apply(i) {
    const w = this.w;
    const s = this.step;
    const ext = this._farthest(i);
    const base = this.base[i];
    if (s.id === 'steerLeft') { this.tmp.steerAxis = i; this.tmp.left = ext; return; }
    if (s.id === 'steerRight') {
      const L = this.tmp.left, R = ext;
      const lo = Math.min(L, R), hi = Math.max(L, R);
      w.steer = { axis: i, invert: L > R, min: Math.abs(lo + 1) < 0.1 ? -1 : lo, max: Math.abs(hi - 1) < 0.1 ? 1 : hi };
      return;
    }
    // pedal
    let min, max;
    if (Math.abs(base) < 1e-3 && Math.abs(ext) > 0.9) { min = -1; max = 1; } // pedal reading 0 until first touched
    else { min = Math.min(base, ext); max = Math.max(base, ext); }
    const invert = ext < base;
    const cfg = { axis: i, invert, min, max };
    if (s.id === 'brake' && w.throttle.axis === i) {
      // combined pedals on one axis: throttle one way, brake the other
      w.brake = { axis: i, invert: !w.throttle.invert, min: w.throttle.min, max: w.throttle.max };
      return;
    }
    w[s.id] = cfg;
  }

  /** Call once after the sequence is finished. */
  finish() { this.w.calibrated = true; this.step = null; }
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------
export class Input {
  constructor(settings) {
    this.settings = settings || {};
    fillDefaults(this.settings, defaultInputSettings());
    this.state = {
      steer: 0, throttle: 0, brake: 0, handbrake: 0,
      shiftUp: false, shiftDown: false, reset: false, restart: false, camera: false,
      pause: false, repeatNote: false, confirm: false, back: false, device: 'keyboard',
    };
    this._active = 'keyboard';
    this._down = Object.create(null);
    this._pending = {};
    for (const a of EDGES) this._pending[a] = false;
    this._kbActivity = false;
    this._codeMap = new Map();
    this._rebuildKeyMap();
    // smoothed keyboard values
    this._ks = 0; this._kt = 0; this._kb = 0;
    // pads
    this._gp = null; this._wh = null;
    this._prevG = new Array(32).fill(false); this._curG = new Array(32).fill(false);
    this._prevW = new Array(32).fill(false); this._curW = new Array(32).fill(false);
    this._gKey = ''; this._wKey = '';
    this._gPrevAx = null; this._wPrevAx = null; // for activity detection
    this._seen = {};   // wheel axes that have ever left exactly 0
    this._bHold = 0; this._bFired = false; this._bDown = false;
    this._edgeG = {}; this._edgeW = {};
    for (const a of EDGES) { this._edgeG[a] = false; this._edgeW[a] = false; }
    this._lastAnalog = { g: [0, 0, 0, 0], w: [0, 0, 0, 0] };
    this._ui = null;
    this._capture = null;
    this._listeners = [];
    this._attach();
    this.wheelPosition = 0; // rim position in units of the used lock, NOT clamped (soft lock)
    this.ffb = new ForceFeedback(this.settings.ffb);
    this.ffb.setRotation(this.settings.wheel.deviceRotation);
  }

  get activeDevice() { return this._active; }

  /** Drive the wheel's force feedback; call once per frame after physics. vehicle = null off-stage. */
  updateFfb(dt, vehicle) {
    const active = this._active === 'wheel' && !!this._wh;
    return this.ffb.update(dt, vehicle, this.wheelPosition, active, this._wh);
  }

  _attach() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const add = (t, f) => { window.addEventListener(t, f); this._listeners.push([t, f]); };
    add('keydown', (e) => this._onKeyDown(e));
    add('keyup', (e) => this._onKeyUp(e));
    add('blur', () => this._clearKeys());
    add('gamepadconnected', () => this._resetPads());
    add('gamepaddisconnected', () => this._resetPads());
  }

  dispose() {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      for (const [t, f] of this._listeners) window.removeEventListener(t, f);
    }
    this._listeners.length = 0;
    this._stopUiTimer();
    this.ffb.stop();
  }

  _resetPads() {
    this._gKey = ''; this._wKey = ''; this._gPrevAx = null; this._wPrevAx = null; this._seen = {};
    this._prevG.fill(false); this._prevW.fill(false);
    this._bDown = false; this._bHold = 0; this._bFired = false;
  }

  _clearKeys() { this._down = Object.create(null); }

  _rebuildKeyMap() {
    this._codeMap.clear();
    const keys = this.settings.keys;
    for (const a of KEY_ACTIONS) {
      for (const c of keys[a] || []) {
        let l = this._codeMap.get(c);
        if (!l) { l = []; this._codeMap.set(c, l); }
        l.push(a);
      }
    }
  }

  // --- keyboard ---------------------------------------------------------------------------
  _typingTarget(e) {
    const t = e && e.target;
    if (!t || !t.tagName) return false;
    const n = t.tagName;
    if (n === 'TEXTAREA' || n === 'SELECT') return true;
    if (n === 'INPUT') return /^(text|number|search|password|email|url)$/i.test(t.type || 'text');
    return false;
  }

  _onKeyDown(e) {
    if (this._capture) { // rebinding
      e.preventDefault && e.preventDefault();
      const cb = this._capture; this._capture = null;
      cb(e.code);
      return;
    }
    if (this._typingTarget(e)) return;
    const acts = this._codeMap.get(e.code);
    if (!acts) return;
    if (e.preventDefault) e.preventDefault();
    if (e.repeat || this._down[e.code]) return;
    this._down[e.code] = true;
    this._kbActivity = true;
    for (const a of acts) if (this._pending[a] !== undefined) this._pending[a] = true;
  }

  _onKeyUp(e) {
    if (this._down[e.code]) {
      this._down[e.code] = false;
      if (this._codeMap.has(e.code) && e.preventDefault) e.preventDefault();
    }
  }

  _anyDown(action) {
    const l = this.settings.keys[action];
    if (!l) return false;
    for (let i = 0; i < l.length; i++) if (this._down[l[i]]) return true;
    return false;
  }

  _approach(cur, target, maxStep) {
    if (cur < target) return Math.min(target, cur + maxStep);
    return Math.max(target, cur - maxStep);
  }

  _updateKeyboard(dt, speedMs) {
    const kb = this.settings.keyboard;
    const l = this._anyDown('left'), r = this._anyDown('right');
    const target = (r ? 1 : 0) - (l ? 1 : 0);
    const kmh = Math.abs(speedMs) * 3.6;
    const f = clamp(kmh / kb.fastKmh, 0, 1);
    const lockTime = kb.lockTimeStanding + (kb.lockTimeFast - kb.lockTimeStanding) * f;
    let rate = 1 / lockTime;
    const cur = this._ks;
    if (target === 0 || (cur !== 0 && Math.sign(cur) !== Math.sign(target))) rate *= kb.returnFactor;
    this._ks = this._approach(cur, target, rate * dt);
    const pr = dt / kb.pedalTime;
    this._kt = this._approach(this._kt, this._anyDown('throttle') ? 1 : 0, pr);
    this._kb = this._approach(this._kb, this._anyDown('brake') ? 1 : 0, pr);
  }

  // --- pads -------------------------------------------------------------------------------
  _pollPads() {
    this._gp = null; this._wh = null;
    let list = null;
    try { if (typeof navigator !== 'undefined' && navigator.getGamepads) list = navigator.getGamepads(); } catch (e) { list = null; }
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.connected === false) continue;
      if (isWheelPad(p)) { if (!this._wh) this._wh = p; }
      else if (p.mapping === 'standard') { if (!this._gp) this._gp = p; }
    }
    const gk = this._gp ? this._gp.index + this._gp.id : '';
    if (gk !== this._gKey) { this._gKey = gk; this._gPrevAx = null; this._prevG.fill(false); this._bDown = false; }
    const wk = this._wh ? this._wh.index + this._wh.id : '';
    if (wk !== this._wKey) {
      this._wKey = wk; this._wPrevAx = null; this._seen = {}; this._prevW.fill(false);
      if (this._wh) {
        const w = this.settings.wheel;
        if (!w.calibrated && w.profile !== this._wh.id) {
          const prof = wheelProfileFor(this._wh.id);
          w.steer = prof.steer; w.throttle = prof.throttle; w.brake = prof.brake; w.clutch = prof.clutch;
          w.buttons = prof.buttons; w.profile = this._wh.id;
        }
      }
    }
  }

  _scan(p, prev, cur) {
    let any = false;
    const n = Math.min(32, p.buttons.length);
    for (let i = 0; i < 32; i++) cur[i] = i < n ? !!p.buttons[i].pressed : false;
    for (let i = 0; i < 32; i++) if (cur[i] && !prev[i]) any = true;
    return any;
  }

  _readGamepad(dt, out) {
    const p = this._gp, g = this.settings.gamepad;
    for (const a of EDGES) this._edgeG[a] = false;
    if (!p) { out[0] = out[1] = out[2] = out[3] = 0; return false; }
    const anyEdge = this._scan(p, this._prevG, this._curG);
    const cur = this._curG, prev = this._prevG, e = this._edgeG;
    let x = p.axes[0] || 0;
    const dz = clamp(g.deadzone, 0, 0.9);
    const ax = Math.abs(x);
    let s = ax <= dz ? 0 : Math.pow((ax - dz) / (1 - dz), Math.max(0.1, g.linearity));
    s = clamp(s * g.sensitivity, 0, 1) * Math.sign(x);
    const rt = p.buttons[7] ? p.buttons[7].value : 0;
    const lt = p.buttons[6] ? p.buttons[6].value : 0;
    out[0] = s; out[1] = rt; out[2] = lt;
    out[3] = (cur[0] || cur[2]) ? 1 : 0;
    e.confirm = cur[0] && !prev[0];
    e.shiftUp = cur[5] && !prev[5];
    e.shiftDown = cur[4] && !prev[4];
    e.camera = cur[3] && !prev[3];
    e.pause = cur[9] && !prev[9];
    e.repeatNote = cur[8] && !prev[8];
    // B: tap = back, hold 0.6 s = reset
    if (cur[1]) {
      if (!this._bDown) { this._bDown = true; this._bHold = 0; this._bFired = false; }
      this._bHold += dt;
      if (!this._bFired && this._bHold >= RESET_HOLD_S) { this._bFired = true; e.reset = true; }
    } else if (this._bDown) {
      this._bDown = false;
      if (!this._bFired) e.back = true;
    }
    let act = anyEdge;
    const pa = this._gPrevAx;
    if (pa) {
      if (Math.abs(x - pa[0]) > 0.03 || Math.abs(rt - pa[1]) > 0.03 || Math.abs(lt - pa[2]) > 0.03) act = true;
    } else this._gPrevAx = [0, 0, 0];
    this._gPrevAx[0] = x; this._gPrevAx[1] = rt; this._gPrevAx[2] = lt;
    for (let i = 0; i < 32; i++) prev[i] = cur[i];
    return act;
  }

  _axisRaw(p, a) { return a >= 0 && a < p.axes.length ? p.axes[a] : 0; }

  _pedal(p, cfg) {
    if (cfg.axis < 0 || cfg.axis >= p.axes.length) return 0;
    const raw = p.axes[cfg.axis];
    if (!this._seen[cfg.axis]) { if (raw === 0) return 0; this._seen[cfg.axis] = true; }
    return pedalValue(raw, cfg);
  }

  _readWheel(dt, out) {
    const p = this._wh, w = this.settings.wheel;
    for (const a of EDGES) this._edgeW[a] = false;
    if (!p) { out[0] = out[1] = out[2] = out[3] = 0; return false; }
    const anyEdge = this._scan(p, this._prevW, this._curW);
    const cur = this._curW, prev = this._prevW, e = this._edgeW;
    // steer
    const rawS = this._axisRaw(p, w.steer.axis);
    let n = signedValue(rawS, w.steer);
    n *= (w.deviceRotation || 900) / Math.max(30, w.rotation);
    this.wheelPosition = n;
    const ad = Math.abs(n);
    n = ad <= w.deadzone ? 0 : Math.pow(clamp((ad - w.deadzone) / (1 - w.deadzone), 0, 1), Math.max(0.1, w.linearity)) * Math.sign(n);
    out[0] = n;
    // pedals
    let th, br;
    if (w.throttle.axis >= 0 && w.throttle.axis === w.brake.axis) {
      const raw = this._axisRaw(p, w.throttle.axis);
      if (!this._seen[w.throttle.axis] && raw === 0) { th = 0; br = 0; }
      else {
        this._seen[w.throttle.axis] = true;
        const v = signedValue(raw, w.throttle);
        th = v > 0.02 ? v : 0; br = v < -0.02 ? -v : 0;
      }
    } else { th = this._pedal(p, w.throttle); br = this._pedal(p, w.brake); }
    out[1] = th; out[2] = br;
    const cl = w.clutch.axis >= 0 ? this._pedal(p, w.clutch) : 0;
    const bt = w.buttons;
    const btn = (i) => i >= 0 && i < 32 && cur[i];
    out[3] = (btn(bt.handbrake) || cl > 0.5) ? (btn(bt.handbrake) ? 1 : cl) : 0;
    const edge = (i) => i >= 0 && i < 32 && cur[i] && !prev[i];
    for (const a of EDGES) if (bt[a] !== undefined) e[a] = edge(bt[a]);
    let act = anyEdge;
    const pa = this._wPrevAx;
    if (pa) {
      if (Math.abs(rawS - pa[0]) > 0.01 || Math.abs(th - pa[1]) > 0.03 || Math.abs(br - pa[2]) > 0.03) act = true;
    } else this._wPrevAx = [0, 0, 0];
    this._wPrevAx[0] = rawS; this._wPrevAx[1] = th; this._wPrevAx[2] = br;
    for (let i = 0; i < 32; i++) prev[i] = cur[i];
    return act;
  }

  /** Poll all devices; returns the (reused) InputState. */
  update(dt, speedMs = 0) {
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    this._pollPads();
    this._updateKeyboard(dt, speedMs);
    const ga = this._readGamepad(dt, this._lastAnalog.g);
    const wa = this._readWheel(dt, this._lastAnalog.w);
    const mode = this.settings.device || 'auto';
    const kbAct = this._kbActivity;
    this._kbActivity = false;

    if (mode === 'auto') {
      // later checks win if several devices moved in the same frame (wheel > gamepad > keyboard)
      if (kbAct) this._active = 'keyboard';
      if (ga) this._active = 'gamepad';
      if (wa) this._active = 'wheel';
      if (this._active === 'wheel' && !this._wh) this._active = this._gp ? 'gamepad' : 'keyboard';
      if (this._active === 'gamepad' && !this._gp) this._active = this._wh ? 'wheel' : 'keyboard';
    } else {
      this._active = mode;
    }
    const dev = this._active, s = this.state;
    if (dev === 'wheel') {
      const a = this._lastAnalog.w;
      s.steer = a[0]; s.throttle = a[1]; s.brake = a[2]; s.handbrake = a[3];
    } else if (dev === 'gamepad') {
      const a = this._lastAnalog.g;
      s.steer = a[0]; s.throttle = a[1]; s.brake = a[2]; s.handbrake = a[3];
    } else {
      s.steer = this._ks; s.throttle = this._kt; s.brake = this._kb;
      s.handbrake = this._anyDown('handbrake') ? 1 : 0;
    }
    s.device = dev;
    const auto = mode === 'auto';
    for (const a of EDGES) {
      let v = false;
      if (auto || mode === 'keyboard') v = v || this._pending[a];
      if (auto || mode === 'gamepad') v = v || this._edgeG[a];
      if (auto || mode === 'wheel') v = v || this._edgeW[a];
      s[a] = v;
      this._pending[a] = false;
    }
    return s;
  }

  /** Vibrate the gamepad (strong/weak 0..1, ms). No-op if unsupported. */
  rumble(strong, weak, ms) {
    const p = this._gp || this._wh;
    if (!p) return;
    try {
      const act = p.vibrationActuator;
      if (act && act.playEffect) {
        act.playEffect('dual-rumble', { startDelay: 0, duration: ms, weakMagnitude: clamp(weak, 0, 1), strongMagnitude: clamp(strong, 0, 1) });
      } else if (p.hapticActuators && p.hapticActuators[0] && p.hapticActuators[0].pulse) {
        p.hapticActuators[0].pulse(clamp(Math.max(strong, weak), 0, 1), ms);
      }
    } catch (e) { /* ignore */ }
  }

  // --- settings UI ------------------------------------------------------------------------
  _changed() { try { this.settings.onChange && this.settings.onChange(); } catch (e) { /* ignore */ } }

  _stopUiTimer() {
    if (this._ui && this._ui.timer) { clearInterval(this._ui.timer); this._ui.timer = null; }
  }

  renderSettings(container) {
    const doc = container.ownerDocument || document;
    this._stopUiTimer();
    injectStyle(doc);
    while (container.firstChild) container.removeChild(container.firstChild);
    const S = this.settings;
    const ui = this._ui = { timer: null, connected: false, cal: null };
    const root = h(doc, 'div', { class: 'inp-root' });
    container.appendChild(root);

    // device
    const devRow = h(doc, 'div', { class: 'inp-row' }, [h(doc, 'label', {}, 'Input device')]);
    const sel = h(doc, 'select', {});
    for (const [v, t] of [['auto', 'Auto (last used)'], ['keyboard', 'Keyboard'], ['gamepad', 'Gamepad'], ['wheel', 'Steering wheel']]) {
      const o = h(doc, 'option', { value: v }, t); if (S.device === v) o.selected = true; sel.appendChild(o);
    }
    sel.addEventListener('change', () => { S.device = sel.value; this._changed(); });
    devRow.appendChild(sel);
    root.appendChild(devRow);
    const live = h(doc, 'div', { class: 'inp-live' }, '');
    root.appendChild(live);

    const slider = (parent, label, obj, key, min, max, step, fmt) => {
      const row = h(doc, 'div', { class: 'inp-row' }, [h(doc, 'label', {}, label)]);
      const inp = h(doc, 'input', { type: 'range', min, max, step });
      inp.value = obj[key];
      const val = h(doc, 'span', { class: 'inp-val' }, fmt(obj[key]));
      inp.addEventListener('input', () => { obj[key] = parseFloat(inp.value); val.textContent = fmt(obj[key]); this._changed(); });
      row.appendChild(inp); row.appendChild(val); parent.appendChild(row);
    };
    const f2 = (v) => (+v).toFixed(2), f0 = (v) => Math.round(v) + '';

    const gpBox = h(doc, 'fieldset', { class: 'inp-box' }, [h(doc, 'legend', {}, 'Gamepad')]);
    slider(gpBox, 'Stick deadzone', S.gamepad, 'deadzone', 0, 0.4, 0.01, f2);
    slider(gpBox, 'Steering linearity (curve)', S.gamepad, 'linearity', 0.6, 2.5, 0.05, f2);
    slider(gpBox, 'Steering sensitivity', S.gamepad, 'sensitivity', 0.5, 1.5, 0.05, f2);
    root.appendChild(gpBox);

    const kbBox = h(doc, 'fieldset', { class: 'inp-box' }, [h(doc, 'legend', {}, 'Keyboard')]);
    slider(kbBox, 'Steer speed, standing (s to full lock)', S.keyboard, 'lockTimeStanding', 0.05, 0.5, 0.01, f2);
    slider(kbBox, 'Steer speed, fast (s to full lock)', S.keyboard, 'lockTimeFast', 0.1, 0.9, 0.01, f2);
    const tbl = h(doc, 'table', { class: 'inp-keys' });
    const renderKeys = () => {
      while (tbl.firstChild) tbl.removeChild(tbl.firstChild);
      for (const a of KEY_ACTIONS) {
        const tr = h(doc, 'tr', {});
        tr.appendChild(h(doc, 'td', {}, ACTION_LABELS[a]));
        tr.appendChild(h(doc, 'td', { class: 'inp-keycell' }, (S.keys[a] || []).map(prettyKey).join('  /  ') || '-'));
        const td = h(doc, 'td', {});
        const bind = (add) => (ev) => {
          const b = ev.currentTarget; b.textContent = 'Press key...';
          this._capture = (code) => {
            if (code !== 'Escape' || !add) {
              if (add) { if (!S.keys[a].includes(code)) S.keys[a].push(code); } else S.keys[a] = [code];
              this._rebuildKeyMap(); this._changed();
            }
            renderKeys();
          };
        };
        const bSet = h(doc, 'button', { type: 'button' }, 'Set'); bSet.addEventListener('click', bind(false));
        const bAdd = h(doc, 'button', { type: 'button' }, 'Add'); bAdd.addEventListener('click', bind(true));
        const bRst = h(doc, 'button', { type: 'button' }, 'Default');
        bRst.addEventListener('click', () => { S.keys[a] = DEFAULT_KEYS[a].slice(); this._capture = null; this._rebuildKeyMap(); this._changed(); renderKeys(); });
        td.appendChild(bSet); td.appendChild(bAdd); td.appendChild(bRst);
        tr.appendChild(td); tbl.appendChild(tr);
      }
    };
    renderKeys();
    kbBox.appendChild(tbl);
    root.appendChild(kbBox);

    // wheel
    const wBox = h(doc, 'fieldset', { class: 'inp-box' }, [h(doc, 'legend', {}, 'Steering wheel')]);
    slider(wBox, 'Wheel rotation used (deg)', S.wheel, 'rotation', 180, 1080, 10, f0);
    slider(wBox, "Wheel's full rotation (deg)", S.wheel, 'deviceRotation', 180, 1080, 10, f0);
    wBox.lastChild.querySelector('input').addEventListener('input', () => this.ffb.setRotation(S.wheel.deviceRotation));
    slider(wBox, 'Steering linearity', S.wheel, 'linearity', 0.6, 2, 0.05, f2);
    const msg = h(doc, 'div', { class: 'inp-cal-msg' }, S.wheel.calibrated ? 'Calibrated.' : 'Using default profile. Calibrate for best results.');
    const bar = h(doc, 'div', { class: 'inp-cal-bar' });
    const bStart = h(doc, 'button', { type: 'button' }, 'Calibrate wheel');
    const bSkip = h(doc, 'button', { type: 'button', style: 'display:none' }, 'Skip');
    const bCancel = h(doc, 'button', { type: 'button', style: 'display:none' }, 'Cancel');
    const bReset = h(doc, 'button', { type: 'button' }, 'Reset wheel to defaults');
    bar.append(bStart, bSkip, bCancel, bReset);
    wBox.append(msg, bar);
    const binds = h(doc, 'div', { class: 'inp-binds' });
    wBox.appendChild(binds);
    root.appendChild(wBox);
    const ffbTick = this.ffb.renderSettings(root, h, slider, () => this._changed());

    const showBinds = () => {
      const w = S.wheel;
      const ax = (c) => (c.axis < 0 ? 'unbound' : `axis ${c.axis}${c.invert ? ' inv' : ''} [${(+c.min).toFixed(2)}..${(+c.max).toFixed(2)}]`);
      binds.textContent = `Steer: ${ax(w.steer)} | Throttle: ${ax(w.throttle)} | Brake: ${ax(w.brake)} | Clutch: ${ax(w.clutch)} | Buttons: ` +
        Object.keys(w.buttons).map((k) => `${k}=${w.buttons[k] < 0 ? '-' : w.buttons[k]}`).join(' ');
    };
    showBinds();

    const endCal = (text) => {
      ui.cal = null; bSkip.style.display = bCancel.style.display = 'none'; bStart.style.display = '';
      msg.textContent = text; showBinds();
    };
    const beginStep = (idx) => {
      const c = ui.cal; c.idx = idx;
      const step = CAL_STEPS[idx];
      c.cal.begin(step, this._calPad());
      msg.textContent = `Step ${idx + 1}/${CAL_STEPS.length}: ${step.text}`;
      bSkip.style.display = '';
    };
    const nextStep = () => {
      const c = ui.cal; if (!c) return;
      if (c.idx + 1 >= CAL_STEPS.length) { c.cal.finish(); this._changed(); endCal('Calibration complete.'); return; }
      this._changed(); showBinds(); beginStep(c.idx + 1);
    };
    bStart.addEventListener('click', () => {
      ui.cal = { cal: new WheelCalibrator(S.wheel), idx: 0 };
      bStart.style.display = 'none'; bCancel.style.display = '';
      beginStep(0);
    });
    bSkip.addEventListener('click', nextStep);
    bCancel.addEventListener('click', () => endCal('Calibration cancelled.'));
    bReset.addEventListener('click', () => {
      const d = defaultInputSettings().wheel; const id = this._wh ? this._wh.id : '';
      Object.assign(S.wheel, d);
      if (id) { const pr = wheelProfileFor(id); Object.assign(S.wheel, pr, { profile: id }); }
      this._seen = {}; this._changed(); endCal('Wheel reset to defaults.');
    });

    // live readout + calibration polling
    let last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    ui.timer = setInterval(() => {
      if (container.isConnected) ui.connected = true;
      else if (ui.connected) { this._stopUiTimer(); return; }
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dt = Math.min(0.2, (now - last) / 1000); last = now;
      const st = this.state;
      const pads = [];
      if (this._gp) pads.push('Gamepad: ' + this._gp.id);
      if (this._wh) pads.push('Wheel: ' + this._wh.id);
      ffbTick();
      live.textContent = `Active: ${st.device} | steer ${st.steer.toFixed(2)} thr ${st.throttle.toFixed(2)} brk ${st.brake.toFixed(2)} hb ${st.handbrake.toFixed(2)} | ` +
        (pads.length ? pads.join(' ; ') : 'no gamepad/wheel detected (press a button on it)');
      if (ui.cal) {
        const pad = this._calPad();
        if (!pad) { msg.textContent = 'No wheel detected - press a button on it to wake it up.'; return; }
        if (ui.cal.cal.feed(pad, dt)) nextStep();
      }
    }, 50);
  }

  /** Pad used for calibration: the detected wheel, else any connected pad with axes. */
  _calPad() {
    if (this._wh) return this._wh;
    let list = null;
    try { list = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { /* none */ }
    if (list) for (let i = 0; i < list.length; i++) if (list[i] && list[i].connected !== false && list[i].axes.length) return list[i];
    return null;
  }
}

function prettyKey(code) {
  return code.replace(/^Key/, '').replace(/^Arrow/, '').replace(/^Digit/, '');
}

function h(doc, tag, props = {}, children) {
  const e = doc.createElement(tag);
  for (const k in props) {
    if (k === 'class') e.className = props[k];
    else e.setAttribute(k, props[k]);
  }
  if (typeof children === 'string') e.textContent = children;
  else if (Array.isArray(children)) for (const c of children) e.appendChild(c);
  return e;
}

function injectStyle(doc) {
  if (doc.getElementById('inp-style')) return;
  const st = doc.createElement('style');
  st.id = 'inp-style';
  st.textContent = `
.inp-root{font:14px/1.4 system-ui,sans-serif;color:#eee}
.inp-row{display:flex;align-items:center;gap:10px;margin:6px 0}
.inp-row label{flex:0 0 260px}
.inp-row input[type=range]{flex:1;max-width:260px}
.inp-val{min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
.inp-box{border:1px solid #556;border-radius:6px;margin:10px 0;padding:6px 12px}
.inp-live,.inp-binds{font:12px monospace;opacity:.8;margin:6px 0;word-break:break-word}
.inp-keys{border-collapse:collapse;width:100%}
.inp-keys td{padding:2px 6px;border-bottom:1px solid #334}
.inp-keycell{font-family:monospace;color:#ffd24a}
.inp-cal-msg{margin:8px 0;font-weight:600;color:#ffd24a}
.inp-cal-bar button,.inp-keys button{margin-right:6px;cursor:pointer}
`;
  (doc.head || doc.documentElement).appendChild(st);
}
