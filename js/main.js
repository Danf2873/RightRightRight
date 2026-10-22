import * as THREE from 'three';
import { STAGES } from './stages.js';
import { buildTrack } from './track.js';
import { Vehicle } from './vehicle.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { createEnvironment } from './weather.js';
import { generateNotes, Codriver } from './pacenotes.js';
import { AudioEngine } from './audio.js';
import { Effects } from './effects.js';
import { Cockpit, EYE } from './cockpit.js';
import * as store from './storage.js';

const STEP = 1 / 120;
const MAX_STEPS = 12;
const RESET_PENALTY_MS = 5000;
// Camera modes, cycled with C / Y. Positions are in the car body frame (forward -Z, up +Y).
// fov is vertical degrees at standstill; speed adds a few degrees on top.
const CAMERAS = [
  { name: 'Cockpit', kind: 'cockpit', fov: 80, eye: new THREE.Vector3(0, 0, 0) },
  { name: 'Cockpit wide', kind: 'cockpit', fov: 110, eye: new THREE.Vector3(0, 0.02, 0.08) },
  { name: 'Hood', kind: 'mounted', fov: 82, pos: new THREE.Vector3(0, 0.5, -1.05) },
  { name: 'Bumper', kind: 'mounted', fov: 86, pos: new THREE.Vector3(0, 0.1, -2.2) },
  { name: 'Chase', kind: 'chase', fov: 75, dist: 6.2, height: 2.1 },
  { name: 'Far chase', kind: 'chase', fov: 72, dist: 9.5, height: 3.4 },
  { name: 'Fixed', kind: 'fixed', fov: 76, pos: new THREE.Vector3(0, 1.9, 6.2), look: new THREE.Vector3(0, 0.7, -4) },
];
const CAMERA_NAMES = CAMERAS.map((c) => c.name);

// ---------------------------------------------------------------- setup

const settings = store.loadSettings();
const save = () => store.saveSettings(settings);
settings.input.onChange = save;

const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const menuRoot = document.getElementById('menu');
const loadingEl = document.getElementById('loading');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 2500);

function applyPixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  const q = settings.graphics.quality;
  renderer.setPixelRatio(q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.25));
}

function resize() {
  applyPixelRatio();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const input = new Input(settings.input);
const hud = new HUD(hudRoot);
hud.hide();
const touch = new TouchControls(hudRoot, input);
const touchWanted = () => settings.touch === 'on' || (settings.touch !== 'off' && isTouchDevice());
const audio = new AudioEngine(settings.audio);
const vehicle = new Vehicle(scene, { color: 0xd8262b, quality: settings.graphics.quality });
if (!vehicle.mesh.parent) scene.add(vehicle.mesh);
vehicle.mesh.visible = false;
const cockpit = new Cockpit(vehicle);
let effects = new Effects(scene, settings.graphics.quality);

let audioStarted = false;
function startAudio() {
  if (audioStarted) return;
  audioStarted = true;
  audio.resume();
}
window.addEventListener('pointerdown', startAudio);
window.addEventListener('keydown', startAudio);

vehicle.onImpact = (strength) => {
  if (strength < 2) return;
  audio.impact(Math.min(1, strength / 20));
  input.rumble(Math.min(1, strength / 15), Math.min(1, strength / 10), 120 + strength * 15);
  if (strength > 12) shakeCamera(Math.min(1, strength / 30));
};

// ---------------------------------------------------------------- game state

const game = {
  state: 'menu',          // menu | loading | countdown | running | finished
  paused: false,
  stageIndex: 0,
  stage: null,
  track: null,
  env: null,
  notes: [],
  codriver: null,
  recce: false,
  timeMs: 0,
  penaltyMs: 0,
  countdown: 0,
  maxDist: 0,
  dist: 0,
  lateral: 0,
  nextSplit: 0,
  splitTimes: [],
  best: null,
  wrongWayTime: 0,
  troubleTime: 0,
  finishTimer: 0,
  ghostFrames: null,
  ghostRec: [],
  ghostRecTimer: 0,
  autopilot: false,
  resets: 0,
};

const projCache = {};
const proj = { dist: 0, lateral: 0, index: 0, width: 7 };
const samp = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), right: new THREE.Vector3(), width: 7, surface: 'gravel', curvature: 0 };
const samp2 = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), right: new THREE.Vector3(), width: 7, surface: 'gravel', curvature: 0 };
const groundCache = {};
const groundOut = { height: 0, nx: 0, ny: 1, nz: 0, surface: 'grass', onRoad: false, water: 0 };

// Input handed to the vehicle. Edge events are latched until the first physics step consumes them.
const drive = { steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, device: 'keyboard' };
let pendingShiftUp = false;
let pendingShiftDown = false;

// ---------------------------------------------------------------- ghost car

const ghost = (() => {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.28, depthWrite: false });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.6, 4.0), mat);
  body.position.y = -0.05;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.5, 2.0), mat);
  cabin.position.set(0, 0.5, 0.25);
  g.add(body, cabin);
  g.visible = false;
  scene.add(g);
  return g;
})();
const ghostQa = new THREE.Quaternion();
const ghostQb = new THREE.Quaternion();

function updateGhost() {
  const frames = game.ghostFrames;
  if (!frames || game.recce || game.state === 'menu') { ghost.visible = false; return null; }
  const t = game.timeMs / 1000 / store.GHOST_DT;
  const i = Math.min(frames.length - 1, Math.floor(t));
  const j = Math.min(frames.length - 1, i + 1);
  const a = frames[i], b = frames[j];
  const f = Math.min(1, t - i);
  ghost.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
  ghostQa.set(a[3], a[4], a[5], a[6]).normalize();
  ghostQb.set(b[3], b[4], b[5], b[6]).normalize();
  ghost.quaternion.slerpQuaternions(ghostQa, ghostQb, f);
  ghost.visible = game.state === 'running' || game.state === 'countdown';
  return ghost.position;
}

// ---------------------------------------------------------------- camera

const cam = { yaw: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), shake: 0, fov: 68, quat: new THREE.Quaternion(), sway: new THREE.Vector3() };
const fwd = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const fixedLook = new THREE.Vector3();
const cockpitPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.07);
const prevVel = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const accel = new THREE.Vector3();

function shakeCamera(amount) { cam.shake = Math.max(cam.shake, amount); }

function snapCamera() {
  cam.quat.copy(vehicle.quaternion).multiply(cockpitPitch);
  cam.sway.set(0, 0, 0);
  prevVel.copy(vehicle.velocity);
  fwd.set(0, 0, -1).applyQuaternion(vehicle.quaternion);
  cam.yaw = Math.atan2(fwd.x, -fwd.z);
  cam.pos.copy(vehicle.position).addScaledVector(fwd, -7).add(tmpV.set(0, 2.5, 0));
  cam.look.copy(vehicle.position);
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function updateCamera(dt) {
  const cfg = CAMERAS[settings.camera | 0] || CAMERAS[0];
  const kind = cfg.kind;
  fwd.set(0, 0, -1).applyQuaternion(vehicle.quaternion);
  const speed = vehicle.velocity.length();
  cockpit.setVisible(kind === 'cockpit');
  const near = kind === 'cockpit' ? 0.04 : 0.1;
  if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }

  if (kind === 'cockpit') {
    // Head is thrown against g-forces (in the car frame), then follows the body with light damping.
    if (dt > 0) accel.copy(vehicle.velocity).sub(prevVel).divideScalar(dt);
    prevVel.copy(vehicle.velocity);
    tmpQ.copy(vehicle.quaternion).invert();
    accel.applyQuaternion(tmpQ).clampLength(0, 30);
    tmpV.set(-accel.x * 0.004, -accel.y * 0.002, -accel.z * 0.004);
    cam.sway.lerp(tmpV, 1 - Math.exp(-8 * dt));
    camera.position.copy(EYE).add(cfg.eye).add(cam.sway).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    tmpQ.copy(vehicle.quaternion).multiply(cockpitPitch);
    cam.quat.slerp(tmpQ, 1 - Math.exp(-25 * dt));
    camera.quaternion.copy(cam.quat);
  } else if (kind === 'chase') {
    // Chase: follow body yaw with lag; slightly biased toward travel direction while sliding.
    let targetYaw = Math.atan2(fwd.x, -fwd.z);
    if (speed > 4) {
      const velYaw = Math.atan2(vehicle.velocity.x, -vehicle.velocity.z);
      if (vehicle.speed > 0) targetYaw += wrapAngle(velYaw - targetYaw) * 0.35;
    }
    cam.yaw += wrapAngle(targetYaw - cam.yaw) * (1 - Math.exp(-5 * dt));
    const { dist, height } = cfg;
    tmpV.set(Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    tmpV2.copy(vehicle.position).addScaledVector(tmpV, -dist);
    tmpV2.y = vehicle.position.y + height;
    if (game.track) {
      game.track.groundAt(tmpV2.x, tmpV2.z, groundCache, groundOut);
      if (Number.isFinite(groundOut.height)) tmpV2.y = Math.max(tmpV2.y, groundOut.height + 0.8);
    }
    cam.pos.lerp(tmpV2, 1 - Math.exp(-10 * dt));
    tmpV2.copy(vehicle.position).addScaledVector(tmpV, 4).add(tmpV.set(0, 0.9, 0));
    cam.look.lerp(tmpV2, 1 - Math.exp(-14 * dt));
    camera.position.copy(cam.pos);
    camera.up.copy(UP);
    camera.lookAt(cam.look);
  } else if (kind === 'fixed') {
    // Rigidly bolted behind the car: rolls, pitches and yaws exactly with the body.
    camera.position.copy(cfg.pos).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    fixedLook.copy(cfg.look).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    camera.up.copy(UP).applyQuaternion(vehicle.quaternion);
    camera.lookAt(fixedLook);
  } else {
    camera.position.copy(cfg.pos).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    camera.quaternion.copy(vehicle.quaternion);
  }

  if (cam.shake > 0.001) {
    const s = cam.shake * 0.25;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    cam.shake *= Math.exp(-6 * dt);
  }
  const targetFov = cfg.fov + Math.min(kind === 'cockpit' ? 6 : 10, speed * (kind === 'cockpit' ? 0.1 : 0.16));
  cam.fov += (targetFov - cam.fov) * (1 - Math.exp(-3 * dt));
  if (Math.abs(camera.fov - cam.fov) > 0.05) {
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- stage lifecycle

function setLoading(text) {
  if (text) {
    document.getElementById('loading-text').textContent = text;
    loadingEl.classList.remove('hidden');
  } else {
    loadingEl.classList.add('hidden');
  }
}

function unloadStage() {
  game.codriver?.stop();
  game.track?.dispose();
  game.env?.dispose();
  game.track = null;
  game.env = null;
  game.codriver = null;
}

async function loadStage(index, { recce = false } = {}) {
  game.state = 'loading';
  game.paused = false;
  showMenu(null);
  setLoading(`Building ${STAGES[index].name}…`);
  await new Promise((r) => setTimeout(r, 40)); // let the overlay paint before the heavy build
  unloadStage();
  effects.dispose();
  effects = new Effects(scene, settings.graphics.quality);

  const def = STAGES[index];
  game.stageIndex = index;
  game.stage = def;
  game.recce = recce;
  try {
    game.env = createEnvironment(scene, renderer, def, settings.graphics.quality);
    game.track = buildTrack(def, scene, settings.graphics.quality);
  } catch (err) {
    console.error(err);
    setLoading(null);
    game.state = 'menu';
    showStageSelect();
    return;
  }
  game.notes = generateNotes(game.track, settings.codriver.verbosity);
  game.codriver = new Codriver(game.notes, settings.codriver);
  game.codriver.onCall = (note) => { hud.showCall(note); cockpit.talk(); };
  hud.setTrack(game.track);
  vehicle.setLights(!!game.env.isNight || ['fog', 'storm', 'ash'].includes(def.weather));
  vehicle.setManualGearbox(settings.gearbox === 'manual');
  touch.setManual(settings.gearbox === 'manual');
  vehicle.mesh.visible = true;
  game.best = store.loadBest()[def.id] || null;
  game.ghostFrames = recce ? null : store.loadGhost(def.id);
  setLoading(null);
  startRun();
}

function startRun() {
  const t = game.track;
  vehicle.reset(t.startPos, t.startDir);
  game.pinX = vehicle.position.x;
  game.pinZ = vehicle.position.z;
  vehicle.syncVisuals();
  snapCamera();
  effects.clear();
  game.timeMs = 0;
  game.penaltyMs = 0;
  game.maxDist = t.startDist;
  game.dist = t.startDist;
  game.nextSplit = 0;
  game.splitTimes = [];
  game.wrongWayTime = 0;
  game.troubleTime = 0;
  game.finishTimer = 0;
  game.ghostRec = [];
  game.ghostRecTimer = 0;
  game.resets = 0;
  game.countdown = 3.999;
  game.lastCount = 4;
  game.state = 'countdown';
  game.paused = false;
  pendingShiftUp = pendingShiftDown = false;
  game.codriver.reset();
  audio.setPaused(false);
  hud.show();
  showMenu(null);
}

function resetToRoad(penalty) {
  const t = game.track;
  if (!t) return;
  const d = Math.max(t.startDist, Math.min(t.finishDist - 5, game.dist - 5));
  t.sampleAt(d, samp);
  vehicle.reset(tmpV.copy(samp.pos).addScaledVector(UP, 0.3), samp.dir);
  snapCamera();
  game.troubleTime = 0;
  game.wrongWayTime = 0;
  if (penalty && !game.recce && game.state === 'running') {
    game.penaltyMs += RESET_PENALTY_MS;
    hud.message(`RESET +${RESET_PENALTY_MS / 1000}s`, 1400);
  }
  game.resets++;
}

// ---------------------------------------------------------------- race logic

function buildDrive(inp) {
  drive.device = inp.device;
  drive.steer = inp.steer;
  drive.throttle = inp.throttle;
  drive.brake = inp.brake;
  drive.handbrake = inp.handbrake;
  if (game.autopilot) autopilot();
  // Held brake at standstill means "reverse" to the auto gearbox, so hold with the handbrake.
  if (game.state === 'countdown') {
    drive.throttle = 0;
    drive.brake = 0;
    drive.handbrake = 1;
  } else if (game.state === 'finished') {
    const moving = vehicle.speed > 2;
    drive.throttle = 0;
    drive.brake = moving ? 0.6 : 0;
    drive.handbrake = moving ? 0 : 1;
  }
  if (game.recce && vehicle.speed > 22) drive.throttle = 0;
}

// Test/demo driver: pure pursuit on the centerline with a curvature-based speed target.
function autopilot() {
  const t = game.track;
  if (!t) return;
  const v = Math.max(0, vehicle.speed);
  t.sampleAt(game.dist + Math.max(7, v * 0.75), samp2);
  tmpV.copy(samp2.pos).sub(vehicle.position);
  fwd.set(0, 0, -1).applyQuaternion(vehicle.quaternion);
  const right = tmpV2.set(1, 0, 0).applyQuaternion(vehicle.quaternion);
  const ang = Math.atan2(tmpV.dot(right), tmpV.dot(fwd));
  drive.steer = Math.max(-1, Math.min(1, ang * 2.2));
  let vmax = 55;
  for (let d = 0; d < 80 + v * 2; d += 6) {
    t.sampleAt(game.dist + d, samp2);
    const k = Math.abs(samp2.curvature) + 1e-4;
    const mu = { ice: 0.18, snow: 0.4, sand: 0.5, mud: 0.45, tarmac: 1.0, wet: 0.7 }[samp2.surface] ?? 0.65;
    const vc = Math.sqrt((mu * 9.81) / k) * 0.85 + d * 0.12;
    vmax = Math.min(vmax, vc);
  }
  drive.throttle = v < vmax ? 1 : 0;
  drive.brake = v > vmax + 2 ? Math.min(1, (v - vmax) / 8) : 0;
  drive.handbrake = 0;
}

function stepPhysics(dt) {
  game.acc = (game.acc || 0) + dt;
  let steps = 0;
  while (game.acc >= STEP && steps < MAX_STEPS) {
    drive.shiftUp = pendingShiftUp;
    drive.shiftDown = pendingShiftDown;
    pendingShiftUp = pendingShiftDown = false;
    vehicle.update(STEP, drive, game.track);
    if (game.state === 'countdown') {
      // Staged on the line: the car may settle on its springs but cannot creep or turn.
      vehicle.position.x = game.pinX;
      vehicle.position.z = game.pinZ;
      vehicle.velocity.x = 0;
      vehicle.velocity.z = 0;
      vehicle.angularVelocity.y = 0;
    }
    game.acc -= STEP;
    steps++;
    if (game.state === 'running') game.timeMs += STEP * 1000;
  }
  if (steps === MAX_STEPS) game.acc = 0; // falling behind: drop time rather than spiral
  vehicle.syncVisuals();
}

function updateRace(dt) {
  const t = game.track;
  const p = vehicle.position;
  t.project(p.x, p.z, projCache, proj);
  game.dist = proj.dist;
  game.lateral = proj.lateral;

  // Progress only advances in plausible increments so a projection jump can't skip the stage.
  if (proj.dist > game.maxDist && proj.dist - game.maxDist < 60 && Math.abs(proj.lateral) < proj.width * 0.5 + 25) {
    game.maxDist = proj.dist;
  }

  if (game.state === 'countdown') {
    game.countdown -= dt;
    const n = Math.ceil(game.countdown);
    if (n !== game.lastCount && n >= 1 && n <= 3) {
      hud.message(String(n), 800);
      audio.beep('countdown');
    }
    game.lastCount = n;
    if (game.countdown <= 0) {
      game.state = 'running';
      hud.message('GO!', 900);
      audio.beep('go');
    }
  }

  if (game.state === 'running') {
    // splits
    while (game.nextSplit < t.splits.length && game.maxDist >= t.splits[game.nextSplit]) {
      const i = game.nextSplit++;
      const time = game.timeMs + game.penaltyMs;
      game.splitTimes.push(time);
      const bestSplit = game.best?.splits?.[i];
      hud.showSplit(i, time, bestSplit != null ? time - bestSplit : null);
      audio.beep('split');
    }
    // finish
    if (game.maxDist >= t.finishDist) finishRun();

    // ghost recording
    game.ghostRecTimer += dt;
    while (game.ghostRecTimer >= store.GHOST_DT) {
      game.ghostRecTimer -= store.GHOST_DT;
      const q = vehicle.quaternion;
      game.ghostRec.push([p.x, p.y, p.z, q.x, q.y, q.z, q.w]);
    }
  }

  // wrong way
  t.sampleAt(proj.dist, samp);
  const along = vehicle.velocity.x * samp.dir.x + vehicle.velocity.z * samp.dir.z;
  game.wrongWayTime = along < -3 ? game.wrongWayTime + dt : 0;

  // auto recovery: far off the road, fell out of the world, or stuck on the roof
  const lost = Math.abs(proj.lateral) > 80 || p.y < samp.pos.y - 40 || !Number.isFinite(p.x);
  const stuck = vehicle.upsideDown && Math.abs(vehicle.speed) < 2;
  game.troubleTime = lost || stuck ? game.troubleTime + dt : 0;
  if (game.troubleTime > (lost ? 0.5 : 2.5) && game.state !== 'finished') resetToRoad(true);

  if (game.state === 'finished') {
    game.finishTimer += dt;
    if (game.finishTimer > 2.5 && !game.resultsShown) showResults();
  }

  game.codriver.update(Math.max(proj.dist, game.state === 'countdown' ? t.startDist : 0), Math.max(0, vehicle.speed));
}

function finishRun() {
  game.state = 'finished';
  game.finishTimer = 0;
  game.resultsShown = false;
  const total = game.timeMs + game.penaltyMs;
  hud.message('FINISH', 2200);
  audio.beep('finish');
  game.result = { total, record: false, prevBest: game.best?.timeMs ?? null };
  if (!game.recce) {
    const record = store.saveBest(game.stage.id, total, game.splitTimes);
    game.result.record = record;
    if (record) store.saveGhost(game.stage.id, game.ghostRec);
  }
}

// ---------------------------------------------------------------- main loop

let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, fps = 0;
const debugEl = document.createElement('pre');
debugEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:15;margin:0;padding:8px;font:12px/1.35 monospace;color:#cfe;background:rgba(0,0,0,.6);pointer-events:none;display:none';
document.body.appendChild(debugEl);
window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') { e.preventDefault(); debugEl.style.display = debugEl.style.display === 'none' ? 'block' : 'none'; }
});

let prevMenuSteer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

  const inStage = game.state === 'countdown' || game.state === 'running' || game.state === 'finished';
  touch.setVisible(inStage && !game.paused && touchWanted());
  const inp = input.update(dt, game.track ? vehicle.speed : 0);

  if (inStage && !game.paused) {
    if (inp.pause) pauseGame();
    else {
      if (inp.shiftUp) pendingShiftUp = true;
      if (inp.shiftDown) pendingShiftDown = true;
      if (inp.camera) settings.camera = ((settings.camera | 0) + 1) % CAMERA_NAMES.length, save(), hud.message(CAMERA_NAMES[settings.camera], 700);
      if (inp.repeatNote) game.codriver.repeatLast();
      if (inp.restart) { startRun(); }
      else if (inp.reset && game.state === 'running') resetToRoad(true);

      buildDrive(inp);
      stepPhysics(dt);
      updateRace(dt);
    }
  } else if (game.paused || game.state === 'menu') {
    menuNav(inp);
  }

  if (game.track) {
    updateCamera(dt);
    cockpit.update(game.paused ? 0 : dt, drive, settings.units);
    game.env?.update(dt, camera, vehicle.position);
    game.track.update?.(dt, camera);
    effects.update(game.paused ? 0 : dt, inStage && !game.paused ? vehicle : null);
    const gp = updateGhost();
    if (inStage) {
      fwd.set(0, 0, -1).applyQuaternion(vehicle.quaternion);
      hud.update({
        speedMs: Math.abs(vehicle.speed),
        rpm: vehicle.rpm,
        maxRpm: vehicle.maxRpm,
        gear: vehicle.gear,
        timeMs: game.timeMs,
        penaltyMs: game.penaltyMs,
        dist: game.maxDist,
        startDist: game.track.startDist,
        finishDist: game.track.finishDist,
        carX: vehicle.position.x,
        carZ: vehicle.position.z,
        carHeading: Math.atan2(-fwd.x, -fwd.z), // yaw about +Y: forward = (-sin h, 0, -cos h)
        ghostX: gp ? gp.x : undefined,
        ghostZ: gp ? gp.z : undefined,
        upcoming: game.codriver.upcoming(game.dist, 3),
        wrongWay: game.wrongWayTime > 1.2,
        units: settings.units,
        recce: game.recce,
      });
    }
    if (!game.paused) audio.update(dt, vehicle);
  } else {
    // Title backdrop: slow orbit over nothing — keep the canvas from being a black hole.
    renderer.setClearColor(0x1b2330);
  }

  if (debugEl.style.display !== 'none') {
    const w = vehicle.wheels || [];
    debugEl.textContent =
      `fps ${fps.toFixed(0)}  calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k\n` +
      `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  rpm ${vehicle.rpm?.toFixed(0)}  gear ${vehicle.gear}\n` +
      `dist ${game.dist.toFixed(0)} / ${game.track?.finishDist.toFixed(0)}  lat ${game.lateral.toFixed(1)}  device ${inp.device}\n` +
      w.map((x, i) => `${['FL', 'FR', 'RL', 'RR'][i]} ${x.contact ? x.surface : 'air'} sr ${x.slipRatio?.toFixed(2)} sa ${x.slipAngle?.toFixed(2)} load ${(x.load / 1000).toFixed(1)}k`).join('\n');
  }

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- menus

const fmtTime = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '--:--.--';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const c = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
};

let menuBack = null;

function showMenu(screen, back = null) {
  menuRoot.innerHTML = '';
  menuBack = back;
  if (!screen) { menuRoot.classList.add('hidden'); return; }
  menuRoot.classList.remove('hidden');
  menuRoot.classList.toggle('dim', !!game.track);
  menuRoot.append(screen);
  const first = screen.querySelector('[data-autofocus]') || screen.querySelector('button');
  first?.focus({ preventScroll: true });
}

function menuNav(inp) {
  if (menuRoot.classList.contains('hidden')) return;
  const items = [...menuRoot.querySelectorAll('button:not([disabled]), select, input')].filter((e) => e.offsetParent !== null);
  if (!items.length) return;
  let i = items.indexOf(document.activeElement);
  // Gamepad / wheel stick moves focus; keyboard uses Tab and arrows natively.
  if (inp.device !== 'keyboard') {
    const s = inp.steer;
    if (s > 0.6 && prevMenuSteer <= 0.6) items[(i + 1) % items.length].focus();
    if (s < -0.6 && prevMenuSteer >= -0.6) items[(i - 1 + items.length) % items.length].focus();
    prevMenuSteer = s;
    if (inp.confirm && document.activeElement?.click) document.activeElement.click();
  }
  if (inp.back && menuBack) menuBack();
  if (inp.pause && game.paused) resumeGame();
}

window.addEventListener('keydown', (e) => {
  if (menuRoot.classList.contains('hidden')) return;
  if (e.target.tagName === 'SELECT' || e.target.type === 'range' || e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  const items = [...menuRoot.querySelectorAll('button:not([disabled]), select, input')].filter((x) => x.offsetParent !== null);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
});

function showTitle() {
  game.state = 'menu';
  const screen = el('div', { class: 'screen' },
    el('div', { class: 'title-block' },
      el('h1', { class: 'logo', html: 'Right<span class="arrow">›</span><br>Right<span class="arrow">›</span><br>Right<span class="arrow">›</span>' }),
      el('div', { class: 'tagline' }, 'Low-poly rally · 12 stages · your codriver is listening'),
    ),
    el('div', { class: 'menu-col' },
      el('button', { class: 'btn primary', 'data-autofocus': '', onclick: () => showStageSelect() }, 'Select stage'),
      el('button', { class: 'btn', onclick: () => loadStage(Math.floor(Math.random() * STAGES.length)) }, 'Random stage'),
      el('button', { class: 'btn', onclick: () => showSettings(showTitle) }, 'Settings'),
      el('button', { class: 'btn', onclick: () => showControls(showTitle) }, 'Controls'),
    ),
  );
  showMenu(screen);
}

const SKY = { day: ['#5ea4e8', '#cfe6f7'], dawn: ['#6c6fae', '#f6b38d'], dusk: ['#4b3d78', '#f39a5b'], night: ['#0b1026', '#24305a'] };
const GROUND = {
  forest: '#2f5a32', coast: '#4f7a3c', alpine: '#7f8a8e', desert: '#c9a066', ice: '#cfdbe6', mud: '#5b4a33',
  snowforest: '#e3ecf2', vineyard: '#6c7f3a', canyon: '#a5603a', highland: '#5e6b45', volcanic: '#2b2726', mixed: '#5f6f48',
};

function stageArt(def, i) {
  const [top, bottom] = SKY[def.timeOfDay] || SKY.day;
  const g = GROUND[def.biome] || '#4a6a3a';
  // Deterministic ridge line per stage.
  let seed = (def.seed || i * 977) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let pts = '0,74 ';
  for (let x = 0; x <= 300; x += 30) pts += `${x},${26 + rnd() * 26} `;
  pts += '300,74';
  let pts2 = '0,74 ';
  for (let x = 0; x <= 300; x += 20) pts2 += `${x},${46 + rnd() * 16} `;
  pts2 += '300,74';
  return `<svg viewBox="0 0 300 74" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sky${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
    <rect width="300" height="74" fill="url(#sky${i})"/>
    <polygon points="${pts}" fill="${g}" opacity="0.55"/>
    <polygon points="${pts2}" fill="${g}"/>
  </svg>`;
}

function showStageSelect() {
  game.state = 'menu';
  game.paused = false;
  hud.hide();
  const best = store.loadBest();
  const recce = el('input', { type: 'checkbox', id: 'recce' });
  const grid = el('div', { class: 'stage-grid' });
  STAGES.forEach((def, i) => {
    const b = best[def.id];
    grid.append(el('button', { class: 'stage-card', onclick: () => loadStage(i, { recce: recce.checked }), ...(i === game.stageIndex ? { 'data-autofocus': '' } : {}) },
      el('div', { class: 'stage-art', html: stageArt(def, i) + `<div class="stage-num">${String(i + 1).padStart(2, '0')}</div>` }),
      el('div', { class: 'stage-body' },
        el('div', { class: 'stage-name' }, def.name),
        el('div', { class: 'stage-region' }, def.region),
        el('div', { class: 'stage-desc' }, def.description),
        el('div', { class: 'chips' },
          el('span', { class: 'chip diff' }, '●'.repeat(def.difficulty || 1) + '○'.repeat(5 - (def.difficulty || 1))),
          el('span', { class: 'chip' }, def.weather),
          el('span', { class: 'chip' }, def.timeOfDay),
          def.lengthKm ? el('span', { class: 'chip' }, `${def.lengthKm} km`) : null,
        ),
        el('div', { class: 'stage-best', html: `Best <b>${b ? fmtTime(b.timeMs) : '—'}</b>` }),
      ),
    ));
  });
  const screen = el('div', { class: 'screen' },
    el('div', { class: 'screen-head' },
      el('h2', {}, 'Select stage'),
      el('div', { class: 'row' },
        el('label', { class: 'row hint', for: 'recce' }, recce, 'Recce run (untimed, 80 km/h cap)'),
        el('button', { class: 'btn small', onclick: () => showTitle() }, 'Back'),
      ),
    ),
    grid,
  );
  showMenu(screen, showTitle);
}

function field(label, control, value) {
  return el('div', { class: 'field' }, el('label', {}, label), el('div', { class: 'row' }, control, value || null));
}

function slider(obj, key, min, max, step, fmt = (v) => v) {
  const val = el('span', { class: 'val' }, String(fmt(obj[key])));
  const s = el('input', { type: 'range', min, max, step, value: obj[key] });
  s.addEventListener('input', () => { obj[key] = parseFloat(s.value); val.textContent = fmt(obj[key]); save(); });
  return [s, val];
}

function select(obj, key, options, onChange) {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option', { value: v }, label);
    if (String(obj[key]) === String(v)) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => { obj[key] = s.value; save(); onChange?.(s.value); });
  return s;
}

function checkbox(obj, key, onChange) {
  const c = el('input', { type: 'checkbox' });
  c.checked = !!obj[key];
  c.addEventListener('change', () => { obj[key] = c.checked; save(); onChange?.(c.checked); });
  return c;
}

function showSettings(back, tab = 'controls') {
  const body = el('div', { class: 'settings-body panel' });
  const tabs = el('div', { class: 'tabs' });
  const TABS = [['controls', 'Controls'], ['codriver', 'Codriver'], ['audio', 'Audio'], ['game', 'Game & graphics']];
  const render = (name) => {
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    body.innerHTML = '';
    if (name === 'controls') {
      input.renderSettings(body);
    } else if (name === 'codriver') {
      const c = settings.codriver;
      const voiceSel = el('select');
      const fillVoices = () => {
        voiceSel.innerHTML = '';
        voiceSel.append(el('option', { value: '' }, 'Auto (English)'));
        for (const v of Codriver.voices()) {
          const o = el('option', { value: v.voiceURI }, `${v.name} (${v.lang})`);
          if (v.voiceURI === c.voiceURI) o.selected = true;
          voiceSel.append(o);
        }
      };
      fillVoices();
      if (window.speechSynthesis) speechSynthesis.onvoiceschanged = fillVoices;
      voiceSel.addEventListener('change', () => { c.voiceURI = voiceSel.value; save(); });
      body.append(
        field('Codriver', checkbox(c, 'enabled')),
        field('Calls', select(c, 'mode', [['voice', 'Voice + ribbon'], ['text', 'Ribbon only']])),
        field('Detail', select(c, 'verbosity', [['all', 'Every corner'], ['key', 'Key corners only']]), el('span', { class: 'val' }, 'applies on next stage')),
        field('Call-ahead time', ...slider(c, 'leadSeconds', 2, 9, 0.5, (v) => `${v}s`)),
        field('Voice', voiceSel),
        field('Speech rate', ...slider(c, 'rate', 0.7, 1.8, 0.05, (v) => `${v.toFixed(2)}x`)),
        field('Volume', ...slider(c, 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'btn small', onclick: () => { const cd = new Codriver([], c); cd.say('Left four tightens, into right two, don\'t cut. One hundred. Over crest.'); } }, 'Test voice')),
      );
    } else if (name === 'audio') {
      const a = settings.audio;
      const pct = (v) => `${Math.round(v * 100)}%`;
      body.append(
        field('Master', ...slider(a, 'master', 0, 1, 0.05, pct)),
        field('Engine', ...slider(a, 'engine', 0, 1, 0.05, pct)),
        field('Effects', ...slider(a, 'fx', 0, 1, 0.05, pct)),
      );
    } else {
      body.append(
        field('Graphics quality', select(settings.graphics, 'quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], applyPixelRatio), el('span', { class: 'val' }, 'scenery/shadows apply on next stage')),
        field('Gearbox', select(settings, 'gearbox', [['auto', 'Automatic'], ['manual', 'Manual (E / Q, bumpers, paddles)']], (v) => { vehicle.setManualGearbox(v === 'manual'); touch.setManual(v === 'manual'); })),
        field('Touch controls', select(settings, 'touch', [['auto', 'Auto (touch screens)'], ['on', 'Always on'], ['off', 'Off']])),
        field('Speed units', select(settings, 'units', [['kmh', 'km/h'], ['mph', 'mph']])),
        field('Camera', select(settings, 'camera', CAMERA_NAMES.map((n, i) => [i, n]), (v) => { settings.camera = parseInt(v, 10); save(); })),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'btn small', onclick: () => { try { localStorage.removeItem('rrr.best'); } catch { /* ignore */ } } }, 'Clear best times')),
      );
    }
  };
  for (const [id, label] of TABS) tabs.append(el('button', { class: 'tab', 'data-tab': id, onclick: () => render(id) }, label));
  const screen = el('div', { class: 'screen' },
    el('div', { class: 'screen-head' }, el('h2', {}, 'Settings'), el('button', { class: 'btn small', 'data-autofocus': '', onclick: back }, 'Back')),
    tabs,
    body,
  );
  showMenu(screen, back);
  render(tab);
}

function showControls(back) {
  const rows = [
    ['Steer', 'A / D  or  ← / →', 'Left stick', 'Wheel'],
    ['Throttle', 'W  or  ↑', 'RT', 'Throttle pedal'],
    ['Brake / reverse', 'S  or  ↓', 'LT', 'Brake pedal'],
    ['Handbrake', 'Space', 'A', 'Mapped button'],
    ['Shift up / down (manual)', 'E / Q', 'RB / LB', 'Paddles'],
    ['Camera', 'C', 'Y', 'Mapped'],
    ['Reset to road (+5s)', 'Backspace', 'Hold B', 'Mapped'],
    ['Restart stage', 'R', '—', '—'],
    ['Repeat pace note', 'N', 'Select', 'Mapped'],
    ['Pause', 'Esc / P', 'Start', 'Mapped'],
    ['Debug telemetry', 'F3', '—', '—'],
  ];
  const table = el('table', { class: 'results-table' },
    el('tr', {}, el('td', {}, ''), el('td', {}, 'Keyboard'), el('td', {}, 'Gamepad'), el('td', {}, 'Wheel')),
    ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, c)))),
  );
  const screen = el('div', { class: 'screen' },
    el('div', { class: 'screen-head' }, el('h2', {}, 'Controls'), el('div', { class: 'row' },
      el('button', { class: 'btn small', onclick: () => showSettings(() => showControls(back)) }, 'Configure'),
      el('button', { class: 'btn small', 'data-autofocus': '', onclick: back }, 'Back'))),
    el('div', { class: 'panel' }, table,
      el('p', { class: 'hint' }, 'Pace notes: 1 is the slowest corner, 6 is nearly flat. "Into" means the next corner comes straight after; numbers are metres to the next call.')),
  );
  showMenu(screen, back);
}

function pauseGame() {
  game.paused = true;
  audio.setPaused(true);
  game.codriver?.stop();
  showPause();
}

function resumeGame() {
  game.paused = false;
  audio.setPaused(false);
  last = performance.now();
  showMenu(null);
}

function showPause() {
  const screen = el('div', { class: 'screen' },
    el('div', { class: 'screen-head' }, el('h2', {}, 'Paused'), el('span', { class: 'hint' }, `${game.stage.name} · ${fmtTime(game.timeMs + game.penaltyMs)}`)),
    el('div', { class: 'menu-col' },
      el('button', { class: 'btn primary', 'data-autofocus': '', onclick: resumeGame }, 'Resume'),
      el('button', { class: 'btn', onclick: () => startRun() }, 'Restart stage'),
      el('button', { class: 'btn', onclick: () => { resetToRoad(true); resumeGame(); } }, 'Reset to road (+5s)'),
      el('button', { class: 'btn', onclick: () => showSettings(showPause) }, 'Settings'),
      el('button', { class: 'btn', onclick: () => quitToMenu() }, 'Quit to stage select'),
    ),
  );
  showMenu(screen, resumeGame);
}

function quitToMenu() {
  game.paused = false;
  audio.setPaused(true);
  game.codriver?.stop();
  vehicle.mesh.visible = false;
  ghost.visible = false;
  unloadStage();
  showStageSelect();
}

function showResults() {
  game.resultsShown = true;
  const r = game.result;
  const rows = game.splitTimes.map((t, i) => {
    const b = r.prevBest != null ? game.best?.splits?.[i] : null;
    const d = b != null ? t - b : null;
    return el('tr', {}, el('td', {}, `Split ${i + 1}`), el('td', {}, fmtTime(t)),
      el('td', { class: d == null ? '' : d < 0 ? 'faster' : 'slower' }, d == null ? '' : `${d < 0 ? '−' : '+'}${(Math.abs(d) / 1000).toFixed(2)}`));
  });
  const delta = r.prevBest != null ? r.total - r.prevBest : null;
  const next = (game.stageIndex + 1) % STAGES.length;
  const screen = el('div', { class: 'screen' },
    el('div', { class: 'screen-head' }, el('h2', {}, game.recce ? 'Recce complete' : r.record ? 'New stage record' : 'Stage complete'), el('span', { class: 'hint' }, game.stage.name)),
    el('div', { class: `results-time${r.record ? ' record' : ''}` }, fmtTime(r.total)),
    el('div', { class: 'panel' },
      el('table', { class: 'results-table' },
        ...rows,
        el('tr', {}, el('td', {}, 'Penalties'), el('td', {}, `${(game.penaltyMs / 1000).toFixed(1)}s`), el('td', {}, `${game.resets} reset${game.resets === 1 ? '' : 's'}`)),
        el('tr', {}, el('td', {}, 'Previous best'), el('td', {}, fmtTime(r.prevBest)),
          el('td', { class: delta == null ? '' : delta < 0 ? 'faster' : 'slower' }, delta == null ? '' : `${delta < 0 ? '−' : '+'}${(Math.abs(delta) / 1000).toFixed(2)}`)),
      ),
    ),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', 'data-autofocus': '', onclick: () => loadStage(next) }, `Next: ${STAGES[next].name}`),
      el('button', { class: 'btn', onclick: () => startRun() }, 'Retry'),
      el('button', { class: 'btn', onclick: () => quitToMenu() }, 'Stage select'),
    ),
  );
  showMenu(screen, quitToMenu);
}

// ---------------------------------------------------------------- boot

window.__game = {
  game, vehicle, settings, STAGES,
  get track() { return game.track; },
  loadStage,
  setAutopilot(on) { game.autopilot = !!on; },
  resetToRoad,
};

showTitle();
requestAnimationFrame(frame);
