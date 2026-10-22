// weather.js — sky dome, lights, fog and camera-following particles per StageDef weather x timeOfDay.
import * as THREE from 'three';

// --- presets ---------------------------------------------------------------------------------
const TIME = {
  day:   { top: 0x2f76d2, horizon: 0xbfdcf2, hemiSky: 0xbfd9ff, hemiGround: 0x6b6a55, hemi: 1.0, sun: 0xfff2d6, sunI: 2.6, elev: 52, azim: 40,  exposure: 1.0,  tint: [1, 1, 1] },
  dawn:  { top: 0x4a5a9c, horizon: 0xffb48a, hemiSky: 0xffc9a0, hemiGround: 0x4a4a55, hemi: 0.75, sun: 0xffb27a, sunI: 2.0, elev: 11, azim: 100, exposure: 1.0,  tint: [1, 0.86, 0.8] },
  dusk:  { top: 0x2f2a66, horizon: 0xff8247, hemiSky: 0xff9a70, hemiGround: 0x3a3040, hemi: 0.6,  sun: 0xff7a3c, sunI: 1.7, elev: 8,  azim: 260, exposure: 1.0,  tint: [0.9, 0.68, 0.66] },
  night: { top: 0x01030a, horizon: 0x0a1430, hemiSky: 0x2a3d7a, hemiGround: 0x05060c, hemi: 0.32, sun: 0x7f9bff, sunI: 0.45, elev: 42, azim: 215, exposure: 1.15, tint: [0.06, 0.08, 0.15] },
};

// fog: color (for non-clear), visibility in meters (95% fog), overcast = how much the sky greys out,
// sunK/hemiK = light scaling, wind = base wind vector.
const WEATHER = {
  clear: { fogColor: null,     vis: 0,   overcast: 0,    sunK: 1,    hemiK: 1,    wind: [0, 0, 0] },
  fog:   { fogColor: 0xc8d0d4, vis: 100, overcast: 1,    sunK: 0.35, hemiK: 1.25, wind: [0.5, 0, 0.2] },
  rain:  { fogColor: 0x8e98a2, vis: 340, overcast: 0.75, sunK: 0.4,  hemiK: 1.15, wind: [1.5, 0, 0.5] },
  storm: { fogColor: 0x5c6670, vis: 210, overcast: 0.92, sunK: 0.22, hemiK: 1.0,  wind: [7, 0, 2.5] },
  snow:  { fogColor: 0xdfe6ee, vis: 240, overcast: 0.8,  sunK: 0.5,  hemiK: 1.3,  wind: [1.2, 0, 0.4] },
  dust:  { fogColor: 0xc9a46a, vis: 170, overcast: 0.65, sunK: 0.7,  hemiK: 1.1,  wind: [6, 0, 1.5] },
  ash:   { fogColor: 0x4a4038, vis: 120, overcast: 0.9,  sunK: 0.3,  hemiK: 1.0,  wind: [2, 0, 1] },
};

const COUNTS = {
  rain: { low: 700, medium: 1700, high: 3000 },
  storm: { low: 1400, medium: 3200, high: 5500 },
  snow: { low: 700, medium: 1800, high: 3500 },
  dust: { low: 400, medium: 900, high: 1600 },
  ash: { low: 400, medium: 1000, high: 1800 },
};

const DEG = Math.PI / 180;
const wrap = (d, half) => { const B = half * 2; return ((d + half) % B + B) % B - half; };

export function createEnvironment(scene, renderer, stageDef, quality = 'medium') {
  const tod = TIME[stageDef.timeOfDay] ? stageDef.timeOfDay : 'day';
  const wx = WEATHER[stageDef.weather] ? stageDef.weather : 'clear';
  const T = TIME[tod], W = WEATHER[wx];
  const q = COUNTS.rain[quality] ? quality : 'medium';
  const isNight = tod === 'night';
  const disposables = [];
  const added = [];

  // ---- colors ----
  const tint = new THREE.Color(T.tint[0], T.tint[1], T.tint[2]);
  const fogColor = new THREE.Color();
  if (W.fogColor === null) fogColor.set(T.horizon); else fogColor.set(W.fogColor).multiply(tint);
  const top = new THREE.Color(T.top);
  const horizon = new THREE.Color(T.horizon);
  const k = W.overcast;
  if (k > 0) {
    top.lerp(fogColor.clone().multiplyScalar(0.8), k);
    horizon.lerp(fogColor, Math.min(1, 0.35 + 0.65 * k));
  }

  // ---- background / fog ----
  scene.background = horizon.clone();
  if (W.vis > 0) scene.fog = new THREE.FogExp2(fogColor.getHex(), 1.73 / W.vis);
  else scene.fog = new THREE.Fog(fogColor.getHex(), 150, 1100);

  // ---- renderer ----
  if (renderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = T.exposure;
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = q !== 'low';
      if (q !== 'low') renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
  }

  // ---- sky ----
  const sky = new THREE.Group();
  sky.name = 'sky';
  const domeGeo = new THREE.SphereGeometry(1, 16, 10);
  {
    const pos = domeGeo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = y <= 0 ? 0 : Math.pow(Math.min(1, y), 0.55);
      c.copy(horizon).lerp(top, t);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    domeGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -1000; dome.frustumCulled = false;
  sky.add(dome);
  disposables.push(domeGeo, domeMat);

  const dir = new THREE.Vector3(
    Math.cos(T.elev * DEG) * Math.sin(T.azim * DEG), Math.sin(T.elev * DEG), -Math.cos(T.elev * DEG) * Math.cos(T.azim * DEG)).normalize();

  const disc = (radius, color, opacity, segs = 16) => {
    const g = new THREE.CircleGeometry(radius, segs);
    const m = new THREE.MeshBasicMaterial({ color, fog: false, depthWrite: false, transparent: opacity < 1, opacity, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(dir).multiplyScalar(0.92);
    mesh.lookAt(0, 0, 0);
    mesh.renderOrder = -998; mesh.frustumCulled = false;
    disposables.push(g, m);
    sky.add(mesh);
    return mesh;
  };
  if (isNight) {
    disc(0.03, 0xeef2ff, 1);
    const halo = disc(0.07, 0x8fa8ff, 0.14, 20);
    halo.renderOrder = -999;
    const n = q === 'low' ? 80 : q === 'medium' ? 180 : 320;
    const sp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // random upper hemisphere direction
      let x, y, z, l;
      do { x = Math.random() * 2 - 1; y = Math.random(); z = Math.random() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.05 || y < 0.05);
      l = Math.sqrt(l) / 0.95;
      sp[i * 3] = x / l; sp[i * 3 + 1] = y / l; sp[i * 3 + 2] = z / l;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const sm = new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false, depthWrite: false, transparent: true, opacity: 0.85 * (1 - k) });
    const stars = new THREE.Points(sg, sm);
    stars.renderOrder = -999; stars.frustumCulled = false;
    sky.add(stars);
    disposables.push(sg, sm);
  } else if (wx === 'clear') {
    disc(0.045, T.sun, 1);
    const halo = disc(0.11, T.sun, 0.18, 20);
    halo.renderOrder = -999;
  }
  scene.add(sky); added.push(sky);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemi * W.hemiK);
  hemi.name = 'envHemi';
  scene.add(hemi); added.push(hemi);
  const hemiBase = T.hemi * W.hemiK;

  const sun = new THREE.DirectionalLight(T.sun, T.sunI * W.sunK);
  sun.name = 'envSun';
  sun.position.copy(dir).multiplyScalar(150);
  const shadows = q !== 'low' && !isNight;
  sun.castShadow = shadows;
  if (shadows) {
    const sz = q === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(sz, sz);
    const sc = sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 400;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.35;
  }
  scene.add(sun); scene.add(sun.target); added.push(sun, sun.target);

  // ---- particles ----
  const wind = new THREE.Vector3(W.wind[0], W.wind[1], W.wind[2]);
  const baseWind = wind.clone();
  let fieldType = null, count = 0, P = null, V = null, PH = null, geo = null, pmat = null, pobj = null;
  let half = null;
  if (wx === 'rain' || wx === 'storm') fieldType = 'rain';
  else if (wx === 'snow') fieldType = 'snow';
  else if (wx === 'dust') fieldType = 'dust';
  else if (wx === 'ash') fieldType = 'ash';
  if (fieldType) {
    count = COUNTS[fieldType === 'rain' ? wx : fieldType][q];
    P = new Float32Array(count * 3);
    V = new Float32Array(count);
    PH = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      PH[i] = Math.random() * Math.PI * 2;
      V[i] = fieldType === 'rain' ? 11 + Math.random() * 6 : fieldType === 'snow' ? 1 + Math.random() * 1.3 : fieldType === 'ash' ? 0.5 + Math.random() * 0.8 : 0;
    }
    geo = new THREE.BufferGeometry();
    if (fieldType === 'rain') {
      half = [18, 12, 18];
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
      pmat = new THREE.LineBasicMaterial({ color: isNight ? 0x6f7fa0 : 0xb4c2d2, transparent: true, opacity: wx === 'storm' ? 0.5 : 0.38, depthWrite: false, fog: false });
      pobj = new THREE.LineSegments(geo, pmat);
    } else {
      half = fieldType === 'dust' ? [24, 7, 24] : [22, 12, 22];
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      const cfg = {
        snow: { color: 0xffffff, size: 0.16, opacity: 0.9 },
        dust: { color: 0xc9a46a, size: 0.35, opacity: 0.3 },
        ash: { color: isNight ? 0x70625a : 0x5a4e46, size: 0.17, opacity: 0.85 },
      }[fieldType];
      if (isNight && fieldType === 'snow') cfg.color = 0x9aa8c8;
      pmat = new THREE.PointsMaterial({ color: cfg.color, size: cfg.size, sizeAttenuation: true, transparent: true, opacity: cfg.opacity, depthWrite: false, fog: false });
      pobj = new THREE.Points(geo, pmat);
    }
    pobj.frustumCulled = false;
    pobj.renderOrder = 10;
    scene.add(pobj); added.push(pobj);
    disposables.push(geo, pmat);
  }
  let placed = false;

  // ---- lightning ----
  let flash = 0, nextFlash = 3 + Math.random() * 6, flashPhase = 0;
  let time = 0;
  let farScaled = false;

  function update(dt, camera, carPos) {
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    time += dt;
    const cam = camera.position;
    sky.position.copy(cam);
    if (!farScaled || (camera.far && Math.abs(sky.scale.x - Math.min(1500, camera.far * 0.9)) > 1)) {
      const s = Math.max(100, Math.min(1500, (camera.far || 1000) * 0.9));
      sky.scale.setScalar(s); farScaled = true;
    }

    // sun / shadow follow
    const cp = carPos || cam;
    sun.target.position.copy(cp);
    sun.position.copy(cp).addScaledVector(dir, 150);
    sun.target.updateMatrixWorld();

    // wind gusts
    const gust = 1 + 0.45 * Math.sin(time * 0.31) + 0.3 * Math.sin(time * 1.13 + 1.7) + 0.15 * Math.sin(time * 2.9);
    wind.copy(baseWind).multiplyScalar(Math.max(0.2, gust));

    // lightning
    if (wx === 'storm') {
      nextFlash -= dt;
      if (nextFlash <= 0 && flash <= 0.01) { flash = 1; flashPhase = 0; nextFlash = 4 + Math.random() * 9; }
      if (flash > 0) {
        flashPhase += dt;
        // double pulse
        const env = Math.exp(-flashPhase * 9) + (flashPhase > 0.16 ? 0.7 * Math.exp(-(flashPhase - 0.16) * 12) : 0);
        flash = env < 0.01 ? 0 : env;
      }
      hemi.intensity = hemiBase + flash * 3.2;
      domeMat.color.setScalar(1 + flash * 1.6);
    }

    if (!fieldType) return;
    const cx = cam.x, cy = cam.y + (fieldType === 'rain' ? 2 : 1), cz = cam.z;
    const hx = half[0], hy = half[1], hz = half[2];
    if (!placed) {
      for (let i = 0; i < count; i++) {
        P[i * 3] = cx + (Math.random() * 2 - 1) * hx;
        P[i * 3 + 1] = cy + (Math.random() * 2 - 1) * hy;
        P[i * 3 + 2] = cz + (Math.random() * 2 - 1) * hz;
      }
      placed = true;
    }
    if (fieldType === 'rain') {
      const arr = geo.attributes.position.array;
      const slant = wx === 'storm' ? 1.0 : 0.6;
      const wxv = wind.x * slant, wzv = wind.z * slant;
      for (let i = 0; i < count; i++) {
        const o = i * 3, vy = -V[i];
        let x = P[o] + wxv * dt, y = P[o + 1] + vy * dt, z = P[o + 2] + wzv * dt;
        x = cx + wrap(x - cx, hx); y = cy + wrap(y - cy, hy); z = cz + wrap(z - cz, hz);
        P[o] = x; P[o + 1] = y; P[o + 2] = z;
        const j = i * 6, st = 0.04;
        arr[j] = x; arr[j + 1] = y; arr[j + 2] = z;
        arr[j + 3] = x - wxv * st; arr[j + 4] = y - vy * st; arr[j + 5] = z - wzv * st;
      }
      geo.attributes.position.needsUpdate = true;
    } else {
      for (let i = 0; i < count; i++) {
        const o = i * 3, ph = PH[i];
        let x = P[o], y = P[o + 1], z = P[o + 2];
        if (fieldType === 'dust') {
          x += (wind.x * 1.2 + Math.sin(time * 0.8 + ph) * 0.8) * dt;
          z += (wind.z * 1.2 + Math.cos(time * 0.6 + ph) * 0.8) * dt;
          y += Math.sin(time * 0.5 + ph * 2) * 0.35 * dt;
        } else {
          const sw = fieldType === 'snow' ? 0.7 : 0.4;
          x += (wind.x + Math.sin(time * 0.9 + ph) * sw) * dt;
          z += (wind.z + Math.cos(time * 0.7 + ph * 1.3) * sw) * dt;
          y -= V[i] * dt;
        }
        P[o] = cx + wrap(x - cx, hx); P[o + 1] = cy + wrap(y - cy, hy); P[o + 2] = cz + wrap(z - cz, hz);
      }
      geo.attributes.position.needsUpdate = true;
    }
  }

  function dispose() {
    for (const o of added) scene.remove(o);
    for (const d of disposables) d.dispose();
    if (sun.shadow && sun.shadow.map) sun.shadow.map.dispose();
    hemi.dispose && hemi.dispose();
    sun.dispose && sun.dispose();
    scene.background = null;
    scene.fog = null;
    added.length = 0; disposables.length = 0;
  }

  return { sun, hemi, sky, wind, weather: wx, timeOfDay: tod, isNight, update, dispose };
}
