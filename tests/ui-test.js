// Standalone UI test page driver: input monitor, HUD with fake data, weather preview.
import * as THREE from 'three';
import { Input } from '../js/input.js';
import { HUD } from '../js/hud.js';
import { createEnvironment } from '../js/weather.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- input
const settings = { input: {}, onChange() { try { localStorage.setItem('rrr.ui-test.input', JSON.stringify(settings.input)); } catch (e) { /* ignore */ } } };
try { Object.assign(settings.input, JSON.parse(localStorage.getItem('rrr.ui-test.input') || '{}')); } catch (e) { /* ignore */ }
settings.input.onChange = () => settings.onChange();
const input = new Input(settings.input);
input.renderSettings($('settings'));

const barDefs = [['steer', true], ['throttle', false], ['brake', false], ['handbrake', false]];
const bars = {};
for (const [name, centered] of barDefs) {
  const d = document.createElement('div');
  d.className = 'bar' + (centered ? ' c' : '');
  d.innerHTML = `<b>${name}</b><i></i>`;
  $('bars').appendChild(d);
  bars[name] = [d.querySelector('i'), centered];
}
const EDGES = ['shiftUp', 'shiftDown', 'reset', 'restart', 'camera', 'pause', 'repeatNote', 'confirm', 'back'];
const evLines = [];
function logEdges(st, t) {
  for (const e of EDGES) {
    if (st[e]) {
      evLines.unshift(`${t.toFixed(2).padStart(8)}  ${e.padEnd(11)} (${st.device})`);
      if (evLines.length > 10) evLines.pop();
      $('events').textContent = evLines.join('\n');
    }
  }
}

// ---------------------------------------------------------------- fake track + HUD
const hud = new HUD($('hud'));
function buildFakeTrack() {
  const pts = [];
  const N = 2000;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 1 + 0.28 * Math.cos(3 * a) + 0.1 * Math.sin(5 * a);
    pts.push([380 * r * Math.cos(a), 240 * r * Math.sin(a)]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];
  const step = 2;
  const samples = [];
  let j = 0;
  for (let d = 0; d < length; d += step) {
    while (cum[j + 1] < d) j++;
    const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const x = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, z = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
    samples.push({ x, y: 0, z, dist: samples.length * step, width: 7 });
  }
  return { samples, step, length, startDist: 20, finishDist: samples.length * step - 20, splits: [length * 0.3, length * 0.55, length * 0.8] };
}
const track = buildFakeTrack();
hud.setTrack(track);

const NOTES = [
  { icons: ['L4', 'tightens', 'into', 'R2'], dir: 'left', severity: 4, mods: ['tightens'], text: 'left 4 tightens into right 2' },
  { icons: ['R6'], dir: 'right', severity: 6, mods: [], text: 'right 6' },
  { icons: ['L1', 'dont-cut'], dir: 'left', severity: 1, mods: ['dont-cut'], text: "left 1 don't cut" },
  { icons: ['R3', 'long'], dir: 'right', severity: 3, mods: ['long'], text: 'right 3 long' },
  { icons: ['LH'], dir: 'left', severity: 'hairpin', mods: [], text: 'left hairpin' },
  { icons: ['RS', 'caution'], dir: 'right', severity: 'square', mods: ['caution'], text: 'square right caution' },
  { icons: ['jump'], kind: 'feature', dir: null, severity: null, mods: ['jump'], text: 'jump' },
  { icons: ['crest', 'water'], kind: 'feature', dir: null, severity: null, mods: ['over-crest', 'water'], text: 'over crest, water' },
  { icons: ['weird-token'], kind: 'surface', dir: null, severity: null, mods: [], text: 'gravel to tarmac' },
  { icons: [], kind: 'corner', dir: 'left', severity: 5, mods: ['opens'], text: 'left 5 opens' },
];
const notes = [];
for (let i = 0; i < 40; i++) {
  const base = NOTES[i % NOTES.length];
  notes.push(Object.assign({}, base, { dist: track.startDist + 60 + i * 55, distanceToNext: 100 }));
}

const sim = { dist: track.startDist, t: 0, speed: 30, gear: 2, rpm: 3000, damage: 0, wrong: false, mph: false, called: -1 };
function stepSim(dt) {
  sim.t += dt;
  const kmh = 80 + 70 * Math.sin(sim.t * 0.5);
  sim.speed = kmh / 3.6;
  sim.dist += sim.speed * dt;
  if (sim.dist > track.finishDist) { sim.dist = track.startDist; sim.t = 0; sim.damage = 0; }
  sim.gear = Math.max(1, Math.min(6, 1 + Math.floor(kmh / 30)));
  const gearTop = sim.gear * 30;
  sim.rpm = 2000 + 6300 * ((kmh - (sim.gear - 1) * 30) / 30);
  sim.rpm = Math.max(1000, Math.min(8500, sim.rpm));
  sim.damage = Math.min(1, sim.damage + dt * 0.01);
  void gearTop;
}
function sampleAt(dist) {
  const i = Math.min(track.samples.length - 2, Math.max(0, Math.floor(dist / track.step)));
  const a = track.samples[i], b = track.samples[i + 1];
  return { x: a.x, z: a.z, dx: b.x - a.x, dz: b.z - a.z };
}
function hudState() {
  const s = sampleAt(sim.dist);
  const g = sampleAt(Math.max(track.startDist, sim.dist - 60));
  const upcoming = [];
  for (const n of notes) if (n.dist > sim.dist - 10 && upcoming.length < 3) upcoming.push(n);
  return {
    speedMs: sim.speed, rpm: sim.rpm, maxRpm: 8500, gear: sim.gear, timeMs: sim.t * 1000, penaltyMs: sim.t > 10 ? 5000 : 0,
    damage: sim.damage, dist: sim.dist, startDist: track.startDist, finishDist: track.finishDist,
    carX: s.x, carZ: s.z, carHeading: Math.atan2(-s.dx, -s.dz), ghostX: g.x, ghostZ: g.z,
    upcoming, wrongWay: sim.wrong, units: sim.mph ? 'mph' : 'kmh',
  };
}
$('b-call').onclick = () => hud.showCall(notes[(sim.called = (sim.called + 1) % notes.length)]);
$('b-split').onclick = () => hud.showSplit(Math.floor(Math.random() * 3), 62000 + Math.random() * 3000, Math.random() < 0.15 ? null : (Math.random() - 0.5) * 4000);
$('b-msg').onclick = () => hud.message(['3', '2', '1', 'GO!', 'FINISH', 'PENALTY +5s'][Math.floor(Math.random() * 6)], 1500);
$('b-ww').onclick = () => { sim.wrong = !sim.wrong; };
$('b-units').onclick = () => { sim.mph = !sim.mph; };

// ---------------------------------------------------------------- three scene
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshLambertMaterial({ color: 0x6a7a55, flatShading: true }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);
const cubeMat = new THREE.MeshLambertMaterial({ color: 0xd8262b, flatShading: true });
for (let i = 0; i < 12; i++) {
  const s = 1 + (i % 3);
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 1.5, s), cubeMat);
  const a = (i / 12) * Math.PI * 2, r = 6 + (i % 4) * 9;
  m.position.set(Math.cos(a) * r, s * 0.75, Math.sin(a) * r);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
}
let env = null;
const WEATHERS = ['clear', 'fog', 'rain', 'snow', 'storm', 'dust', 'ash'];
const TIMES = ['day', 'dawn', 'dusk', 'night'];
for (const [id, list] of [['s-weather', WEATHERS], ['s-time', TIMES], ['s-quality', ['low', 'medium', 'high']]]) {
  for (const v of list) { const o = document.createElement('option'); o.value = o.textContent = v; $(id).appendChild(o); }
}
$('s-quality').value = 'medium';
function rebuildEnv() {
  if (env) env.dispose();
  env = createEnvironment(scene, renderer, { weather: $('s-weather').value, timeOfDay: $('s-time').value }, $('s-quality').value);
  ground.material.needsUpdate = true;
  cubeMat.needsUpdate = true;
}
for (const id of ['s-weather', 's-time', 's-quality']) $(id).addEventListener('change', rebuildEnv);
rebuildEnv();

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop
let last = performance.now(), clock = 0;
const carPos = new THREE.Vector3();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now; clock += dt;
  const st = input.update(dt, sim.speed);
  $('dev').textContent = st.device;
  for (const [name, centered] of barDefs) {
    const [el] = bars[name];
    const v = st[name];
    if (centered) { el.style.left = (v < 0 ? 50 + v * 50 : 50) + '%'; el.style.width = Math.abs(v) * 50 + '%'; }
    else { el.style.left = '0'; el.style.width = (v * 100) + '%'; }
  }
  logEdges(st, clock);

  stepSim(dt);
  hud.update(hudState());

  const a = clock * 0.15;
  carPos.set(Math.cos(clock * 0.2) * 3, 0, 0);
  camera.position.set(Math.cos(a) * 16, 4.5, Math.sin(a) * 16);
  camera.lookAt(0, 1.5, 0);
  env.update(dt, camera, carPos);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
