// Standalone track viewer: pick a stage, orbit/zoom, scrub along the road, see the centerline coloured by curvature
// (red = turning right, blue = turning left, grey = straight). Query params: ?stage=<id>&quality=<q>&dist=<m>
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STAGES } from '../js/stages.js';
import { buildTrack } from '../js/track.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI * 0.499;
controls.enableDamping = true;

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a4030, 0.9);
const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 600 });
scene.add(hemi, sun, sun.target);

const SKY = { day: 0x9ec7ee, dawn: 0xf0b58a, dusk: 0xd98a5a, night: 0x0a1020 };
const FOG = { clear: 0.0006, fog: 0.006, rain: 0.002, snow: 0.0025, storm: 0.003, dust: 0.004, ash: 0.007 };

let track = null, lineObj = null, marker = null;

const stageSel = $('stage');
for (const s of STAGES) { const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.name} (${s.region})`; stageSel.appendChild(o); }
stageSel.value = params.get('stage') && STAGES.some(s => s.id === params.get('stage')) ? params.get('stage') : STAGES[0].id;
if (params.get('quality')) $('quality').value = params.get('quality');

function load() {
  if (track) { track.dispose(); track = null; }
  if (lineObj) { scene.remove(lineObj); lineObj.geometry.dispose(); lineObj.material.dispose(); lineObj = null; }
  if (marker) { scene.remove(marker); marker.geometry.dispose(); marker.material.dispose(); marker = null; }
  const def = STAGES.find(s => s.id === stageSel.value);
  const t0 = performance.now();
  track = buildTrack(def, scene, $('quality').value);
  const ms = performance.now() - t0;

  const sky = new THREE.Color(SKY[def.timeOfDay] ?? SKY.day);
  scene.background = sky;
  scene.fog = new THREE.FogExp2(sky, FOG[def.weather] ?? 0.001);
  const night = def.timeOfDay === 'night';
  hemi.intensity = night ? 0.25 : 0.9;
  sun.intensity = night ? 0.2 : def.timeOfDay === 'day' ? 2.2 : 1.3;
  sun.position.set(0.5, 0.8, 0.3);

  // centerline coloured by curvature
  const n = track.samples.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const s = track.samples[i];
    pos.set([s.x, s.y + 0.6, s.z], i * 3);
    const k = Math.max(-0.08, Math.min(0.08, s.curvature)) / 0.08;
    const a = Math.sqrt(Math.abs(k));
    c.setRGB(0.5, 0.5, 0.5);
    if (k > 0) c.lerp(new THREE.Color(1, 0.1, 0.05), a); else c.lerp(new THREE.Color(0.1, 0.3, 1), a);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  lineObj = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }));
  lineObj.renderOrder = 10;
  lineObj.visible = $('centerline').checked;
  scene.add(lineObj);

  marker = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
  scene.add(marker);

  const dist = $('dist');
  dist.max = String(track.length);
  const d0 = params.get('dist') ? +params.get('dist') : 0;
  dist.value = String(d0);
  overview(d0);
  updateInfo(ms);
  window.__ready = true;
}

const tmp = {}, out = { height: 0, nx: 0, ny: 0, nz: 0, surface: '', onRoad: false, water: 0 }, cache = {};
function updateInfo(ms) {
  const d = +$('dist').value;
  track.sampleAt(d, tmp);
  marker.position.copy(tmp.pos).y += 1;
  track.groundAt(tmp.pos.x, tmp.pos.z, cache, out);
  const counts = {};
  for (const f of track.features) counts[f.type] = (counts[f.type] || 0) + 1;
  const surfs = [...new Set(track.samples.map(s => s.surface))];
  const info = [
    `${track.def.name} - ${track.def.weather}/${track.def.timeOfDay}/${track.def.biome}`,
    `length ${track.length} m, ${track.samples.length} samples, ${track.pieces.length} set pieces`,
    `features ${JSON.stringify(counts)}`,
    `surfaces ${surfs.join(', ')}  offroad: ${track.offroadSurface}`,
    ms ? `built in ${ms.toFixed(0)} ms, colliders ${track.stats.colliders}, scenery tris ${track.stats.sceneryTris | 0}` : '',
    `@${d.toFixed(0)} m  surface ${tmp.surface}  width ${tmp.width.toFixed(1)}  curv ${tmp.curvature.toFixed(4)}`,
    `groundAt h=${out.height.toFixed(2)} (road y ${tmp.pos.y.toFixed(2)}) onRoad=${out.onRoad} water=${out.water.toFixed(2)}`,
  ];
  $('info').textContent = info.filter(Boolean).join('\n');
}

function overview(d = 0) {
  const s = track.samples;
  let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
  for (const p of s) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mnz = Math.min(mnz, p.z); mxz = Math.max(mxz, p.z); }
  const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2, r = Math.max(mxx - mnx, mxz - mnz);
  if (d > 0) { lookHere(); return; }
  controls.target.set(cx, 0, cz);
  camera.position.set(cx, r * 0.9, cz + r * 0.5);
  controls.update();
}
function lookHere() {
  track.sampleAt(+$('dist').value, tmp);
  controls.target.copy(tmp.pos);
  camera.position.copy(tmp.pos).addScaledVector(tmp.dir, -22).add(new THREE.Vector3(0, 9, 0));
  controls.update();
}

stageSel.onchange = () => { params.delete('dist'); load(); };
$('quality').onchange = () => { params.delete('dist'); load(); };
$('centerline').onchange = () => { if (lineObj) lineObj.visible = $('centerline').checked; };
$('dist').oninput = () => updateInfo(0);
$('goto').onclick = lookHere;
$('overview').onclick = () => overview(0);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

// WASD / QE fly the orbit target around (free-fly feel); shift = fast
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
const fwd = new THREE.Vector3(), rgt = new THREE.Vector3(), mv = new THREE.Vector3();
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  const sp = (keys.has('ShiftLeft') ? 300 : 60) * dt;
  camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  rgt.crossVectors(fwd, camera.up).normalize();
  mv.set(0, 0, 0);
  if (keys.has('KeyW')) mv.addScaledVector(fwd, sp);
  if (keys.has('KeyS')) mv.addScaledVector(fwd, -sp);
  if (keys.has('KeyD')) mv.addScaledVector(rgt, sp);
  if (keys.has('KeyA')) mv.addScaledVector(rgt, -sp);
  if (keys.has('KeyE')) mv.y += sp;
  if (keys.has('KeyQ')) mv.y -= sp;
  if (mv.lengthSq() > 0) { camera.position.add(mv); controls.target.add(mv); }
  controls.update();
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).add(new THREE.Vector3(120, 200, 80));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
load();
frame();
