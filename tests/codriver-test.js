// Shared by tests/codriver.html (UI) and node verification scripts (no DOM needed).
import { generateNotes, Codriver } from '../js/pacenotes.js';
import { AudioEngine } from '../js/audio.js';

const D = Math.PI / 180;

// Hand-made synthetic track. Positive curvature = right.
export function makeFakeTrack() {
  const step = 2;
  const k = [];
  const straight = (len) => { for (let i = 0; i < len / step; i++) k.push(0); };
  const arc = (deg, R, dir) => {
    const len = (deg * D) * R;
    for (let i = 0; i < Math.max(1, Math.round(len / step)); i++) k.push(dir / R);
  };
  const marks = {};
  const mark = (name) => { marks[name] = k.length * step; };

  straight(140);
  mark('flatRight'); arc(20, 300, +1);
  straight(150);
  mark('left4'); arc(60, 100, -1);
  straight(120);
  mark('hairpin'); arc(180, 15, +1);
  straight(100);
  mark('square'); arc(90, 12, -1);
  straight(100);
  mark('crest'); straight(60);
  mark('jump'); straight(100);
  mark('chicane'); arc(40, 60, -1); arc(45, 60, +1);
  straight(70);
  mark('tighten'); arc(40, 110, +1); arc(70, 35, +1);
  straight(100);
  mark('water'); straight(120);
  mark('surface'); straight(60);
  mark('longRight'); arc(150, 70, +1);
  straight(60);
  mark('crestCorner'); arc(50, 80, -1);
  straight(250);
  const n = k.length;

  // smooth curvature (moving average, 5 samples)
  const ks = k.map((_, i) => {
    let s = 0, c = 0;
    for (let j = -2; j <= 2; j++) if (k[i + j] !== undefined) { s += k[i + j]; c++; }
    return s / c;
  });

  const samples = [];
  let x = 0, z = 0, th = 0;
  const surfaceAt = (d) => (d >= marks.surface ? 'gravel' : 'tarmac');
  for (let i = 0; i < n; i++) {
    const dirX = Math.sin(th), dirZ = -Math.cos(th);
    samples.push({
      x, y: 0, z, dist: i * step, dirX, dirZ, curvature: ks[i], width: 7,
      surface: surfaceAt(i * step), bank: 0,
    });
    th += ks[i] * step;
    x += dirX * step; z += dirZ * step;
  }
  const features = [
    { dist: marks.crest, type: 'crest' },
    { dist: marks.jump, type: 'jump' },
    { dist: marks.water, type: 'water', len: 20 },
    { dist: marks.crestCorner + 20, type: 'crest' },
  ];
  return {
    step, samples, length: n * step, startDist: 20, finishDist: n * step - 20,
    splits: [], features, marks,
  };
}

// ------------------------------------------------------------------ UI
if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const track = makeFakeTrack();
  const settings = { enabled: true, verbosity: 'all', leadSeconds: 5, voiceURI: '', rate: 1.1, volume: 1, mode: 'voice' };
  const audioSettings = { master: 0.8, engine: 0.7, fx: 0.8 };
  let notes = generateNotes(track, 'all');
  let driver = new Codriver(notes, settings);
  const audio = new AudioEngine(audioSettings);

  const log = (s) => { const el = $('log'); el.textContent = s + '\n' + el.textContent.slice(0, 3000); };
  const hook = () => { driver.onCall = (n) => log(`@${driver._lastDist?.toFixed(0)}m  ${n.text}   [${n.icons.join(' ')}]`); };

  function renderNotes() {
    $('notes').textContent = notes.map((n) =>
      `${String(Math.round(n.dist)).padStart(5)}  ${n.kind.padEnd(8)} ${n.text.padEnd(40)} [${n.icons.join(' ')}]`).join('\n');
  }
  function rebuild() {
    settings.verbosity = $('verb').value;
    notes = generateNotes(track, settings.verbosity);
    driver.stop();
    driver = new Codriver(notes, settings);
    hook(); renderNotes();
  }
  renderNotes(); hook();

  $('verb').onchange = rebuild;
  $('mode').onchange = () => { settings.mode = $('mode').value; };
  const voiceSel = $('voice');
  const fillVoices = () => {
    voiceSel.replaceChildren(new Option('(auto)', ''),
      ...Codriver.voices().map((v) => new Option(`${v.name} ${v.lang}`, v.voiceURI)));
  };
  fillVoices();
  if (globalThis.speechSynthesis) globalThis.speechSynthesis.onvoiceschanged = fillVoices;
  voiceSel.onchange = () => { settings.voiceURI = voiceSel.value; };

  let dist = track.startDist, playing = false, last = performance.now();
  const veh = {
    rpm: 3000, maxRpm: 7500, gear: 2, throttle: 0.5, speed: 20, airborne: false,
    velocity: { y: 0 },
    wheels: [0, 1, 2, 3].map(() => ({ contact: true, surface: 'tarmac', slipRatio: 0, slipAngle: 0, load: 3000, water: 0 })),
  };
  const val = (id) => parseFloat($(id).value);

  $('start').onclick = () => { audio.resume(); };
  $('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Drive'; audio.resume(); };
  $('restart').onclick = () => { dist = track.startDist; driver.reset(); };
  $('repeat').onclick = () => driver.repeatLast();
  $('dist').max = track.length;
  $('dist').oninput = () => { dist = val('dist'); };

  const surf = () => $('surf').value;
  $('impact').onclick = () => audio.impact(val('impStr'));
  document.querySelectorAll('[data-beep]').forEach((b) => { b.onclick = () => audio.beep(b.dataset.beep); });
  $('pause').onchange = () => audio.setPaused($('pause').checked);
  $('airborne').onchange = () => { veh.airborne = $('airborne').checked; };
  $('master').oninput = () => { audioSettings.master = val('master'); };
  $('engv').oninput = () => { audioSettings.engine = val('engv'); };
  $('fxv').oninput = () => { audioSettings.fx = val('fxv'); };

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const spd = val('speed');
    if (playing) {
      dist += spd * dt;
      if (dist > track.length) { dist = track.startDist; driver.reset(); }
    }
    driver._lastDist = dist;
    $('dist').value = dist;
    driver.update(dist, spd);
    $('info').textContent = `dist ${dist.toFixed(0)} m  speed ${(spd * 3.6).toFixed(0)} km/h  next: ` +
      driver.upcoming(dist, 3).map((n) => n.text).join(' | ');

    veh.rpm = val('rpm'); veh.throttle = val('thr'); veh.speed = spd;
    const s = val('slip');
    for (const w of veh.wheels) {
      w.surface = surf(); w.slipRatio = s * 0.3; w.slipAngle = s * 0.2; w.water = val('water');
    }
    const g = Math.max(1, Math.min(6, 1 + Math.floor(veh.rpm / 1500)));
    veh.gear = $('autogear').checked ? g : veh.gear;
    audio.update(dt, veh);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
