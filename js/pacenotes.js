// pacenotes.js — pace note generation + Codriver (speech) for Right Right Right.
// No imports; safe to load in node (speechSynthesis is guarded).

const ON_K = 1 / 450;   // curvature that starts a corner
const OFF_K = 1 / 700;  // hysteresis: corner continues while above this
const MERGE_GAP = 8;    // merge same-direction corners separated by less than this (m)
const MIN_ANGLE = 0.06; // rad; ignore tiny kinks

const DIST_STEPS = [30, 50, 80, 100, 150, 200, 250, 300];
const INTO_GAP = 25;
const AND_GAP = 40;
const LONG_STRAIGHT = 500;

const MOD_ORDER = ['long', 'tightens', 'opens', 'dont-cut', 'over-crest', 'jump', 'bump', 'water', 'narrows', 'caution'];
const MOD_WORD = {
  long: 'long', tightens: 'tightens', opens: 'opens', 'dont-cut': "don't cut",
  'over-crest': 'over crest', jump: 'jump', bump: 'bump', water: 'water',
  narrows: 'narrows', caution: 'caution',
};
const MOD_ICON = { 'over-crest': 'crest' };

// how far before a corner's start a feature still counts as belonging to the corner
const FEATURE_PRE = { crest: 20, bump: 10, water: 15, narrows: 20, caution: 40, jump: 0 };
const FEATURE_MOD = { crest: 'over-crest', bump: 'bump', water: 'water', narrows: 'narrows', caution: 'caution', jump: 'jump' };
const FEATURE_TEXT = {
  crest: 'over crest', jump: 'jump', water: 'caution water', narrows: 'narrows',
  bridge: 'bridge', bump: 'bump', caution: 'caution',
};

const SURFACE_TEXT = {
  tarmac: 'onto tarmac', wet: 'careful, wet', gravel: 'onto gravel', dirt: 'onto dirt',
  sand: 'onto sand', snow: 'careful, snow', ice: 'careful, ice', mud: 'careful, mud',
  grass: 'onto grass', ash: 'onto ash',
};

function sevFromR(R) {
  if (R > 200) return 6;
  if (R > 120) return 5;
  if (R > 75) return 4;
  if (R > 45) return 3;
  if (R > 25) return 2;
  return 1;
}

export function roundDistance(gap) {
  if (gap >= LONG_STRAIGHT) return LONG_STRAIGHT;
  if (gap >= 300) return 300;
  let best = DIST_STEPS[0], bd = Infinity;
  for (const d of DIST_STEPS) {
    const e = Math.abs(d - gap);
    if (e < bd) { bd = e; best = d; }
  }
  return best;
}

function distWord(d) { return d >= LONG_STRAIGHT ? 'long straight' : String(d); }

// ---------------------------------------------------------------- corners

function detectCorners(samples, step) {
  const n = samples.length;
  const k = (i) => samples[i].curvature || 0;
  const regions = [];
  let i = 0;
  while (i < n) {
    const c = k(i);
    if (Math.abs(c) > ON_K) {
      const sign = Math.sign(c);
      const lo = regions.length ? regions[regions.length - 1].e + 1 : 0;
      let s = i;
      while (s - 1 >= lo && Math.sign(k(s - 1)) === sign && Math.abs(k(s - 1)) > OFF_K) s--;
      let e = i;
      while (e + 1 < n && Math.sign(k(e + 1)) === sign && Math.abs(k(e + 1)) > OFF_K) e++;
      regions.push({ s, e, sign });
      i = e + 1;
    } else i++;
  }
  const merged = [];
  for (const r of regions) {
    const p = merged[merged.length - 1];
    if (p && p.sign === r.sign && (r.s - p.e - 1) * step < MERGE_GAP) p.e = r.e;
    else merged.push({ ...r });
  }
  const out = [];
  for (const r of merged) {
    let maxK = 0, apex = r.s, angle = 0;
    const mid = (r.s + r.e + 1) >> 1;
    let maxK1 = 0, maxK2 = 0;
    for (let j = r.s; j <= r.e; j++) {
      const a = Math.abs(k(j));
      angle += a * step;
      if (a > maxK) { maxK = a; apex = j; }
      if (j < mid) { if (a > maxK1) maxK1 = a; } else if (a > maxK2) maxK2 = a;
    }
    if (angle < MIN_ANGLE || maxK <= 0) continue;
    if (!maxK1) maxK1 = maxK2;
    out.push({
      s: r.s, e: r.e, sign: r.sign, apex, angle,
      minR: 1 / maxK, r1: 1 / maxK1, r2: 1 / (maxK2 || maxK1),
      len: (r.e - r.s + 1) * step,
    });
  }
  return out;
}

function classify(c) {
  const deg = c.angle * 180 / Math.PI;
  const R = c.minR;
  const out = { severity: 1, tightens: false, opens: false };
  if (R < 18 && deg > 120) { out.severity = 'hairpin'; return out; }
  if (deg >= 75 && deg <= 110 && R < 22 && c.len < 45) { out.severity = 'square'; return out; }
  let sev = sevFromR(R);
  let adj = 0;
  if (deg < 15) adj = 2; else if (deg < 35) adj = 1;
  const s1 = sevFromR(c.r1), s2 = sevFromR(c.r2);
  if (c.len >= 30 && s2 <= s1 - 1 && c.r2 < 0.75 * c.r1) {
    out.tightens = true;
    sev = Math.min(s1, s2 + 2);
  } else if (c.len >= 30 && s2 >= s1 + 1 && c.r2 > 1.33 * c.r1) {
    out.opens = true;
  }
  out.severity = Math.max(1, Math.min(6, sev + adj));
  return out;
}

function insideBlocked(track, smp, dir) {
  if (typeof track.collidersNear !== 'function' || !smp) return false;
  try {
    const off = (smp.width || 7) / 2 + 1.5;
    const sg = dir === 'right' ? 1 : -1;
    const list = track.collidersNear(smp.x - smp.dirZ * off * sg, smp.z + smp.dirX * off * sg, 3);
    return !!(list && list.length);
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- generation

function sortMods(mods) {
  const set = new Set(mods);
  return MOD_ORDER.filter((m) => set.has(m));
}

export function generateNotes(track, verbosity = 'all') {
  const samples = track.samples || [];
  const step = track.step || 2;
  const startDist = track.startDist ?? 0;
  const finishDist = track.finishDist ?? track.length ?? (samples.length - 1) * step;
  const key = verbosity === 'key';
  const features = (track.features || [])
    .filter((f) => f.dist >= startDist && f.dist <= finishDist)
    .slice().sort((a, b) => a.dist - b.dist);

  // --- corners
  const corners = [];
  for (const c of detectCorners(samples, step)) {
    const sd = samples[c.s].dist ?? c.s * step;
    const ed = samples[c.e].dist ?? c.e * step;
    if (sd < startDist - 1 || sd >= finishDist) continue;
    const cl = classify(c);
    const dir = c.sign > 0 ? 'right' : 'left';
    const deg = c.angle * 180 / Math.PI;
    const mods = new Set();
    const numeric = typeof cl.severity === 'number';
    if (numeric && cl.severity >= 3 && cl.severity <= 5 && (c.len > 60 || deg > 110)) mods.add('long');
    if (cl.tightens) mods.add('tightens');
    if (cl.opens) mods.add('opens');
    corners.push({
      kind: 'corner', dir, severity: cl.severity, mods, dist: sd, endDist: ed + step,
      apex: c.apex, radius: c.minR, angle: deg,
    });
  }

  // --- merge features into corners, or make standalone notes
  const items = [...corners];
  for (const f of features) {
    let host = null;
    if (f.type !== 'bridge') {
      const pre = FEATURE_PRE[f.type] ?? 0;
      host = corners.find((c) => f.dist >= c.dist - pre && f.dist <= c.endDist);
    }
    if (host) {
      const m = FEATURE_MOD[f.type];
      if (m) host.mods.add(m);
      if (f.type === 'caution' || f.type === 'narrows') host.mods.add('dont-cut');
      continue;
    }
    if (key && (f.type === 'bump' || f.type === 'bridge' || f.type === 'narrows')) continue;
    const mods = [];
    if (FEATURE_MOD[f.type]) mods.push(FEATURE_MOD[f.type]);
    if (f.type === 'water') mods.push('caution');
    if (f.type === 'bridge') mods.push('bridge');
    items.push({
      kind: 'feature', dir: null, severity: null, mods: new Set(mods), dist: f.dist,
      endDist: f.dist + (f.len || 0), ftype: f.type,
    });
  }

  // --- finalize corner mods (dont-cut) and verbosity
  const kept = [];
  for (const it of items) {
    if (it.kind === 'corner') {
      const numeric = typeof it.severity === 'number';
      if (!numeric) it.mods.add('dont-cut');
      else if (it.severity <= 4 && insideBlocked(track, samples[it.apex], it.dir)) it.mods.add('dont-cut');
      if (key) {
        const keyMods = it.mods.has('jump') || it.mods.has('caution') || it.mods.has('over-crest');
        if (numeric && it.severity >= 5 && !keyMods) continue;
      }
    }
    kept.push(it);
  }

  // --- surface changes
  let prevSurf = null;
  const si0 = Math.max(0, Math.round(startDist / step));
  if (samples[si0]) prevSurf = samples[si0].surface;
  for (let i = si0 + 1; i < samples.length; i++) {
    const s = samples[i];
    const d = s.dist ?? i * step;
    if (d > finishDist) break;
    if (s.surface && s.surface !== prevSurf) {
      let stable = true;
      for (let j = 1; j <= 4 && i + j < samples.length; j++) if (samples[i + j].surface !== s.surface) { stable = false; break; }
      if (stable) {
        kept.push({ kind: 'surface', dir: null, severity: null, mods: new Set(), dist: d, endDist: d, surface: s.surface });
        prevSurf = s.surface;
      }
    }
  }

  kept.sort((a, b) => a.dist - b.dist || (a.kind === 'surface' ? -1 : 1));

  // --- finish item
  const last = kept[kept.length - 1];
  const finishText = last && last.kind === 'corner' && (typeof last.severity !== 'number' || last.severity <= 4)
    ? 'finish' : 'flat over finish';
  kept.push({ kind: 'finish', dir: null, severity: null, mods: new Set(), dist: finishDist, endDist: finishDist, ftext: finishText });

  // --- link + text
  const notes = [];
  for (let i = 0; i < kept.length; i++) {
    const it = kept[i];
    const next = kept[i + 1];
    const mods = sortMods([...it.mods]);
    if (it.kind === 'feature' && it.mods.has('bridge')) mods.push('bridge');
    let words = '';
    const icons = [];
    if (it.kind === 'corner') {
      const L = it.dir === 'left' ? 'L' : 'R';
      if (it.severity === 'hairpin') { words = `hairpin ${it.dir}`; icons.push(L + 'H'); }
      else if (it.severity === 'square') { words = `square ${it.dir}`; icons.push(L + 'S'); }
      else { words = `${it.dir} ${it.severity}`; icons.push(L + it.severity); }
      for (const m of mods) { words += ' ' + MOD_WORD[m]; icons.push(MOD_ICON[m] || m); }
    } else if (it.kind === 'feature') {
      words = FEATURE_TEXT[it.ftype] || it.ftype;
      icons.push(MOD_ICON[FEATURE_MOD[it.ftype]] || FEATURE_MOD[it.ftype] || it.ftype);
      if (it.mods.has('caution') && it.ftype === 'water') icons.push('caution');
    } else if (it.kind === 'surface') {
      words = SURFACE_TEXT[it.surface] || ('onto ' + it.surface);
      icons.push(it.surface);
    } else if (it.kind === 'finish') {
      words = it.ftext;
      icons.push('finish');
    }

    let distanceToNext = null;
    let text = words;
    if (next) {
      const gap = next.dist - it.endDist;
      if (gap < INTO_GAP) { mods.push('into'); icons.push('into'); text += ' into'; }
      else if (gap < AND_GAP) { mods.push('and'); icons.push('and'); text += ' and'; }
      else {
        distanceToNext = roundDistance(gap);
        icons.push(String(distanceToNext));
        text += ' ' + distWord(distanceToNext);
      }
    }
    notes.push({
      dist: it.dist, endDist: it.endDist, kind: it.kind, dir: it.dir, severity: it.severity,
      mods, distanceToNext, text, icons,
      ...(it.kind === 'corner' ? { radius: Math.round(it.radius), angle: Math.round(it.angle) } : {}),
    });
  }

  // --- start call: distance to the first thing
  const first = notes[0];
  if (first && first.dist - startDist >= AND_GAP) {
    const d = roundDistance(first.dist - startDist);
    notes.unshift({
      dist: startDist, endDist: startDist, kind: 'start', dir: null, severity: null,
      mods: [], distanceToNext: d, text: distWord(d), icons: [String(d)],
    });
  }
  return notes;
}

// ---------------------------------------------------------------- Codriver

const isChained = (n) => n.mods.includes('into') || n.mods.includes('and');

export class Codriver {
  constructor(notes, settings) {
    this.notes = notes || [];
    this.settings = settings || {};
    this.onCall = null;
    this.onSay = null;
    // injectable clock (ms) so tests can simulate time
    this.clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._voice = null;
    this._voiceKey = null;
    this.reset();
  }

  get _synth() {
    try { return globalThis.speechSynthesis || null; } catch (e) { return null; }
  }
  get _voiceMode() {
    return this.settings.mode !== 'text' && !!this._synth && typeof globalThis.SpeechSynthesisUtterance === 'function';
  }

  reset() {
    this.idx = 0;
    this.skipped = 0;
    this.last = null;      // last spoken group of notes
    this.lastText = '';
    this.busyUntil = 0;
    this._pending = 0;
    this._curDist = null;
    this._cancelSpeech();
  }

  _cancelSpeech() {
    const s = this._synth;
    if (s) { try { s.cancel(); } catch (e) { /* ignore */ } }
    this._pending = 0;
    this.busyUntil = 0;
    this._curDist = null;
  }

  stop() { this._cancelSpeech(); }

  static voices() {
    try {
      const s = globalThis.speechSynthesis;
      return s && s.getVoices ? s.getVoices() : [];
    } catch (e) { return []; }
  }

  _pickVoice() {
    const voices = Codriver.voices();
    if (!voices.length) return null;
    const uri = this.settings.voiceURI || '';
    const key = uri + '|' + voices.length;
    if (this._voiceKey === key) return this._voice;
    let best = null, bs = -1;
    for (const v of voices) {
      let sc = 0;
      if (uri && v.voiceURI === uri) sc = 1000;
      else {
        const lang = (v.lang || '').replace('_', '-').toLowerCase();
        if (lang === 'en-gb') sc = 30;
        else if (lang.startsWith('en-')) sc = 20;
        else if (lang === 'en') sc = 15;
        if (sc && /natural|google uk|daniel|premium|enhanced/i.test(v.name || '')) sc += 5;
        if (sc && v.localService) sc += 1;
      }
      if (sc > bs) { bs = sc; best = v; }
    }
    this._voiceKey = key;
    this._voice = bs > 0 ? best : null;
    return this._voice;
  }

  static estimateSeconds(text, rate = 1) {
    const words = text.trim().split(/\s+/).length;
    return (0.45 + words * 0.36) / Math.max(0.5, rate);
  }

  _busy(now) { return now < this.busyUntil; }

  _speak(text, rate) {
    const now = this.clock();
    const dur = Codriver.estimateSeconds(text, rate) * 1000;
    this.busyUntil = Math.max(this.busyUntil, now) + dur;
    if (!this._voiceMode) return;
    try {
      const u = new globalThis.SpeechSynthesisUtterance(text);
      const v = this._pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
      u.rate = rate;
      u.volume = this.settings.volume ?? 1;
      const done = () => {
        this._pending = Math.max(0, this._pending - 1);
        if (this._pending === 0) this.busyUntil = Math.min(this.busyUntil, this.clock());
      };
      u.onend = done;
      u.onerror = done;
      this._pending++;
      this._synth.speak(u);
    } catch (e) { /* ignore speech failures */ }
  }

  _baseRate(speedMs) {
    let r = this.settings.rate || 1.1;
    if (speedMs > 40) r += 0.1;   // flat out: talk a bit quicker
    return r;
  }

  _emit(group, rate, text) {
    this.last = group;
    this.lastText = text;
    this._curDist = group[group.length - 1].dist;
    this._speak(text, rate);
    if (this.onCall) for (const n of group) { try { this.onCall(n); } catch (e) { /* ignore */ } }
  }

  update(dist, speedMs) {
    if (this.settings.enabled === false) return;
    const notes = this.notes;
    const now = this.clock();
    const speed = Math.max(0, speedMs || 0);
    const lead = this.settings.leadSeconds ?? 5;
    const thr = Math.max(60, speed * lead);

    // current call is stale (we've driven > 30 m past what it described): cut it off
    if (this._curDist != null && this._busy(now) && dist - this._curDist > 30) this._cancelSpeech();

    // notes we already drove past without reading are dropped
    while (this.idx < notes.length && notes[this.idx].dist < dist - 10) { this.idx++; this.skipped++; }
    if (this.idx >= notes.length || this._busy(now)) return;
    if (notes[this.idx].dist - dist >= thr) return;

    const takeGroup = (from) => {
      const g = [notes[from]];
      let j = from;
      while (isChained(notes[j]) && j + 1 < notes.length) { j++; g.push(notes[j]); }
      return g;
    };
    const groupText = (g) => g.map((n) => n.text).join(' ');

    let rate = this._baseRate(speed);
    let group = takeGroup(this.idx);
    let text = groupText(group);
    let next = this.idx + group.length;
    // backlog: if the next call is due before we'd finish this one, merge into one quicker utterance
    let merged = false;
    while (next < notes.length && notes[next].dist - dist < thr) {
      const cumDur = Codriver.estimateSeconds(text, merged ? rate : rate * 1.25);
      const tNext = (notes[next].dist - dist) / Math.max(speed, 1);
      if (tNext - 1.5 >= cumDur) break;
      const g = takeGroup(next);
      group = group.concat(g);
      text = text + ', ' + groupText(g);
      next += g.length;
      if (!merged) { merged = true; rate = Math.min(2, rate * 1.25); }
    }
    this.idx = next;
    this._emit(group, rate, text);
  }

  upcoming(dist, n = 3) {
    const out = [];
    for (let i = this.idx; i < this.notes.length && out.length < n; i++) {
      const nt = this.notes[i];
      if ((nt.endDist ?? nt.dist) >= dist - 5) out.push(nt);
    }
    return out;
  }

  repeatLast() {
    if (!this.last) return;
    this._cancelSpeech();
    this._speak(this.lastText, this._baseRate(0));
    if (this.onCall) for (const n of this.last) { try { this.onCall(n); } catch (e) { /* ignore */ } }
  }

  say(text) {
    if (!text) return;
    if (this.onSay) { try { this.onSay(text); } catch (e) { /* ignore */ } }
    this._speak(String(text), this.settings.rate || 1.1);
  }
}
