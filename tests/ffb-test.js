// ffb-test.js - force feedback model checks. Run: node tests/ffb-test.js
import { FfbModel, ForceFeedback, defaultFfbSettings, lgConstantForce, lgRange } from '../js/ffb.js';

let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!ok) fails++; };

const wheel = (o = {}) => ({ contact: true, surface: 'tarmac', load: 3200, fy: 0, slip: 0, cdot: 0, fxT: 0, ...o });
const car = (front, o = {}) => ({ speed: 25, steerAngle: 0.05, wheels: [wheel(front), wheel(front), wheel(), wheel()], ...o });
const settle = (m, v, pos, n = 60) => { let f = 0; for (let i = 0; i < n; i++) f = m.update(1 / 60, v, pos); return f; };
const quiet = () => ({ ...defaultFfbSettings(), texture: 0 });

// cornering right: fronts push right (fy > 0), the wheel must want to return left
const fGrip = settle(new FfbModel(quiet()), car({ fy: 2800, slip: 0.4 }), 0.2);
check('aligning torque centres the wheel', fGrip < -0.3, fGrip.toFixed(3));
const fLimit = settle(new FfbModel(quiet()), car({ fy: 3000, slip: 1.2 }), 0.2);
check('wheel goes light past the grip peak', Math.abs(fLimit) < Math.abs(fGrip) * 0.6, `${fLimit.toFixed(3)} vs ${fGrip.toFixed(3)}`);
const mirror = settle(new FfbModel(quiet()), car({ fy: -2800, slip: 0.4 }, { steerAngle: -0.05 }), -0.2);
check('left/right symmetric', Math.abs(mirror + fGrip) < 1e-6, mirror.toFixed(3));

const air = settle(new FfbModel(quiet()), car({ contact: false, load: 0, fy: 0 }), 0.2);
check('airborne wheel goes slack', Math.abs(air) < 0.02, air.toFixed(3));

const lock = settle(new FfbModel(quiet()), car({}, { speed: 0, steerAngle: 0 }), 1.15);
check('soft lock pushes back past full lock', lock < -0.8, lock.toFixed(3));

// parked: turning the rim meets scrub friction opposing the motion
{
  const m = new FfbModel(quiet());
  const v = car({}, { speed: 0, steerAngle: 0 });
  let f = 0;
  for (let i = 0; i < 30; i++) f = m.update(1 / 60, v, i * 0.01);
  check('parked steering is heavy', f < -0.15, f.toFixed(3));
}

// texture: gravel buzzes much more than tarmac
{
  const rms = (surface) => {
    const m = new FfbModel(defaultFfbSettings());
    const v = car({ surface }, { steerAngle: 0, speed: 25 });
    let s = 0; for (let i = 0; i < 300; i++) { const f = m.update(1 / 60, v, 0); s += f * f; }
    return Math.sqrt(s / 300);
  };
  const g = rms('gravel'), t = rms('tarmac');
  check('gravel texture > tarmac', g > t * 4 && g > 0.02, `${g.toFixed(3)} vs ${t.toFixed(3)}`);
}

// impacts decay
{
  const m = new FfbModel(quiet());
  const v = car({}, { steerAngle: 0 });
  m.impact(12);
  let peak = 0; for (let i = 0; i < 6; i++) peak = Math.max(peak, Math.abs(m.update(1 / 60, v, 0)));
  for (let i = 0; i < 40; i++) m.update(1 / 60, v, 0);
  const after = Math.abs(m.update(1 / 60, v, 0));
  check('impact jolt then decays', peak > 0.3 && after < 0.02, `${peak.toFixed(3)} -> ${after.toFixed(3)}`);
}

// output never leaves -1..1
{
  const m = new FfbModel({ ...defaultFfbSettings(), gain: 1.5 });
  let ok = true;
  for (let i = 0; i < 200; i++) { const f = m.update(1 / 60, car({ fy: 9000, slip: 0.3, cdot: i % 2 ? 2 : -2 }), 3); if (!(Math.abs(f) <= 1)) ok = false; }
  check('output clamped', ok);
}

// ForceFeedback gating (no WebHID in node)
{
  const ff = new ForceFeedback(defaultFfbSettings());
  check('inactive device -> no force', ff.update(1 / 60, car({ fy: 2800, slip: 0.4 }), 0.2, false) === 0);
  const s = defaultFfbSettings(); s.invert = true;
  const ffi = new ForceFeedback(s);
  let f = 0; for (let i = 0; i < 60; i++) f = ffi.update(1 / 60, car({ fy: 2800, slip: 0.4 }), 0.2, true);
  check('invert flips direction', f > 0.3, f.toFixed(3));
  ff.stop(); ffi.stop();
}

// Logitech reports
{
  const b = (f) => lgConstantForce(f)[2];
  check('lg constant force bytes', b(0) === 0x80 && b(1) === 0xff && b(-1) === 0x01 && lgConstantForce(0)[0] === 0x11);
  const r = lgRange(900);
  check('lg range report', r[0] === 0xf8 && r[1] === 0x81 && r[2] === (900 & 0xff) && r[3] === 900 >> 8);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
if (typeof process !== 'undefined') process.exit(fails ? 1 : 0);
