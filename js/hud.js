// hud.js — rally-TV style HUD built from DOM + SVG + canvas. Styles: css/hud.css (prefix hud-).
// Assumption: state.carHeading is the car's yaw about +Y (THREE rotation.y), so with the car local
// frame forward = -Z the world forward vector is (-sin h, -cos h) in (x, z).

const SVGNS = 'http://www.w3.org/2000/svg';

function fmtTime(ms) {
  if (!(ms > 0)) ms = 0;
  const cs = Math.floor(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- pace note glyphs ---------------------------------------------------------------------
const SEV_TURN = { 1: [110, 10], 2: [85, 12], 3: [65, 15], 4: [45, 20], 5: [28, 30], 6: [14, 50] };
const SEV_COLOR = { 1: '#ff3b3b', 2: '#ff6a2a', 3: '#ff9d1c', 4: '#ffd21c', 5: '#c5e82a', 6: '#5ee06a', hairpin: '#ff1f6a', square: '#ff4fd8' };

/** Inline SVG for a corner arrow. dir 'left'|'right', sev 1..6|'hairpin'|'square'. */
export function cornerGlyph(dir, sev, small) {
  let d, ex, ey, hd;
  if (sev === 'square') {
    d = 'M32 60 L32 30 L48 30'; ex = 48; ey = 30; hd = 0;
  } else {
    let theta, r;
    if (sev === 'hairpin') { theta = 170; r = 9; } else { const t = SEV_TURN[sev] || SEV_TURN[4]; theta = t[0]; r = t[1]; }
    const cx = 32 + r, cy = 44;
    const a1 = (180 + theta) * Math.PI / 180;
    ex = cx + r * Math.cos(a1); ey = cy + r * Math.sin(a1);
    hd = -90 + theta;
    const large = theta > 180 ? 1 : 0;
    d = `M32 60 L32 44 A ${r} ${r} 0 ${large} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }
  const col = SEV_COLOR[sev] || '#ffffff';
  const flip = dir === 'left' ? ' transform="translate(64 0) scale(-1 1)"' : '';
  return `<svg class="hud-glyph${small ? ' hud-glyph-s' : ''}" viewBox="0 0 64 64"><g${flip}>` +
    `<path d="${d}" fill="none" stroke="#000" stroke-width="11" stroke-linejoin="round" opacity=".55"/>` +
    `<path d="${d}" fill="none" stroke="${col}" stroke-width="7" stroke-linejoin="round"/>` +
    `<g transform="translate(${ex.toFixed(1)} ${ey.toFixed(1)}) rotate(${hd})"><polygon points="-3,-11 13,0 -3,11" fill="${col}" stroke="#000" stroke-opacity=".55" stroke-width="2"/></g>` +
    `</g></svg>`;
}

const MOD_INFO = {
  tightens: ['TIGHTENS', 'warn'], opens: ['OPENS', 'ok'], long: ['LONG', 'info'], 'dont-cut': ["DON'T CUT", 'bad'],
  'over-crest': ['CREST', 'info'], crest: ['CREST', 'info'], jump: ['JUMP', 'bad'], water: ['WATER', 'info'],
  caution: ['CAUTION', 'bad'], narrows: ['NARROWS', 'warn'], bump: ['BUMP', 'warn'], into: ['INTO', 'link'],
  'keep-in': ['KEEP IN', 'info'], 'keep-out': ['KEEP OUT', 'info'],
};

const CORNER_RE = /^(l|r|left|right)[-_ ]?(\d|h|hp|hairpin|sq|s|square|u)?$/i;

/** Parse a note into {corners:[{dir,sev}], mods:[], label}. Tolerant of unknown icon tokens. */
export function parseNote(note) {
  const corners = [];
  const mods = [];
  const add = (m) => { if (MOD_INFO[m] && !mods.includes(m)) mods.push(m); };
  const toks = Array.isArray(note.icons) ? note.icons : [];
  for (const raw of toks) {
    const t = String(raw).trim();
    const m = CORNER_RE.exec(t);
    if (m) {
      const dir = /^l/i.test(m[1]) ? 'left' : 'right';
      const q = (m[2] || '').toLowerCase();
      let sev = null;
      if (/^[1-6]$/.test(q)) sev = +q;
      else if (q === 'h' || q === 'hp' || q === 'hairpin' || q === 'u') sev = 'hairpin';
      else if (q === 'sq' || q === 's' || q === 'square') sev = 'square';
      corners.push({ dir, sev });
    } else add(t.toLowerCase());
  }
  if (!corners.length && (note.dir === 'left' || note.dir === 'right') && note.severity != null) {
    corners.push({ dir: note.dir, sev: note.severity });
  }
  const mm = Array.isArray(note.mods) ? note.mods : [];
  if (!toks.length) for (const x of mm) add(x);
  else for (const x of mm) if (x === 'long' || x === 'dont-cut' || x === 'caution' || x === 'jump' || x === 'water' || x === 'over-crest') add(x);
  return { corners, mods };
}

function noteHTML(note, small) {
  const p = parseNote(note);
  let html = '';
  const valid = p.corners.filter((c) => c.sev != null || true);
  if (valid.length) {
    html += '<div class="hud-glyphs">';
    valid.forEach((c, i) => {
      if (i > 0) html += '<span class="hud-into">&rsaquo;</span>';
      const label = c.sev === 'hairpin' ? 'H' : c.sev === 'square' ? 'SQ' : (c.sev == null ? '' : c.sev);
      html += `<div class="hud-gl${i > 0 ? ' hud-gl2' : ''}">${cornerGlyph(c.dir, c.sev, small || i > 0)}<span class="hud-sev">${label}</span></div>`;
    });
    html += '</div>';
  }
  if (p.mods.length) {
    html += '<div class="hud-mods">';
    for (const m of p.mods) { const mi = MOD_INFO[m]; html += `<span class="hud-mod hud-mod-${mi[1]}">${esc(mi[0])}</span>`; }
    html += '</div>';
  }
  if (!valid.length && !p.mods.length) {
    html += `<div class="hud-notetext">${esc((note.text || note.kind || '').toUpperCase())}</div>`;
  } else if (!valid.length && note.text && note.kind !== 'corner') {
    html += `<div class="hud-notetext hud-notetext-s">${esc(note.text.toUpperCase())}</div>`;
  }
  return html;
}

// ---- tachometer geometry ------------------------------------------------------------------
const TACH_R = 80;
function tachPt(f, r = TACH_R) {
  const a = (135 + 270 * f) * Math.PI / 180;
  return [100 + r * Math.cos(a), 100 + r * Math.sin(a)];
}
function tachArc(f0, f1, r = TACH_R) {
  const [x0, y0] = tachPt(f0, r), [x1, y1] = tachPt(f1, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${(f1 - f0) * 270 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const MAP_SIZE = 200;       // canvas pixels
const MAP_VIEW_PPM = 0.42;  // minimap pixels per meter (shows ~240 m radius)

export class HUD {
  constructor(root) {
    this.root = root;
    this.doc = root.ownerDocument || document;
    this.track = null;
    this._last = {};
    this._mapT = 0;
    this._mapImg = null;
    this._msgTimer = null; this._splitTimer = null; this._callTimer = null;
    this._slots = [];
    this._tickMax = 0;
    this._build();
  }

  _build() {
    const r = this.root;
    r.classList.add('hud-root');
    r.innerHTML = `
<div class="hud-tl">
  <div class="hud-progress"><div class="hud-prog-track"><div class="hud-prog-fill"></div><div class="hud-prog-splits"></div><div class="hud-prog-car"></div></div>
    <div class="hud-prog-labels"><span>START</span><span>FINISH</span></div></div>
</div>
<div class="hud-tc">
  <div class="hud-timer"><span class="hud-time">00:00.00</span><span class="hud-pen"></span></div>
  <div class="hud-split"></div>
</div>
<div class="hud-tr"><canvas class="hud-map" width="${MAP_SIZE}" height="${MAP_SIZE}"></canvas></div>
<div class="hud-br">
  <div class="hud-tach">
    <svg viewBox="0 0 200 200">
      <path class="hud-tach-bg" d="${tachArc(0, 1)}"/>
      <path class="hud-tach-red" d="${tachArc(0.86, 1)}"/>
      <path class="hud-tach-fill" d="${tachArc(0, 1)}" pathLength="1000" stroke-dasharray="0 1000"/>
      <g class="hud-tach-ticks"></g>
    </svg>
    <div class="hud-shiftlight"></div>
    <div class="hud-gear">N</div>
    <div class="hud-speedbox"><span class="hud-speed">0</span><span class="hud-unit">km/h</span></div>
  </div>
</div>
<div class="hud-bc">
  <div class="hud-call"></div>
  <div class="hud-notes"></div>
</div>
<div class="hud-msg"></div>
<div class="hud-wrong">WRONG WAY</div>`;
    const q = (s) => r.querySelector(s);
    this.el = {
      progFill: q('.hud-prog-fill'), progSplits: q('.hud-prog-splits'), progCar: q('.hud-prog-car'),
      time: q('.hud-time'), pen: q('.hud-pen'), split: q('.hud-split'),
      map: q('.hud-map'),
      tachFill: q('.hud-tach-fill'), ticks: q('.hud-tach-ticks'), shift: q('.hud-shiftlight'), gear: q('.hud-gear'),
      speed: q('.hud-speed'), unit: q('.hud-unit'), tach: q('.hud-tach'),
      call: q('.hud-call'), notes: q('.hud-notes'), msg: q('.hud-msg'), wrong: q('.hud-wrong'),
    };
    this.mapCtx = this.el.map.getContext ? this.el.map.getContext('2d') : null;
    for (let i = 0; i < 3; i++) {
      const d = this.doc.createElement('div');
      d.className = 'hud-note hud-note-' + i;
      d.style.display = 'none';
      this.el.notes.appendChild(d);
      this._slots.push({ el: d, note: null, dist: -1 });
    }
    this._setTicks(8000);
  }

  show() { this.root.style.display = ''; }
  hide() { this.root.style.display = 'none'; }

  _setTicks(maxRpm) {
    this._tickMax = maxRpm;
    let s = '';
    const step = maxRpm > 12000 ? 2000 : 1000;
    for (let v = 0; v <= maxRpm + 1; v += step) {
      const f = v / maxRpm;
      const [x0, y0] = tachPt(f, 70), [x1, y1] = tachPt(f, 78), [tx, ty] = tachPt(f, 58);
      s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="hud-tick"/>` +
        `<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" class="hud-ticktxt" text-anchor="middle">${v / 1000}</text>`;
    }
    this.el.ticks.innerHTML = s;
  }

  setTrack(track) {
    this.track = track;
    this._mapImg = null;
    this.el.progSplits.innerHTML = '';
    if (!track) return;
    this._startDist = track.startDist; this._finishDist = track.finishDist;
    const span = (track.finishDist - track.startDist) || 1;
    for (const d of track.splits || []) {
      const m = this.doc.createElement('i');
      m.style.left = (100 * (d - track.startDist) / span).toFixed(2) + '%';
      this.el.progSplits.appendChild(m);
    }
    this._prerenderMap(track);
    this._mapT = 0;
  }

  _prerenderMap(track) {
    const S = track.samples;
    if (!S || !S.length || !this.doc.createElement) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z; if (s.z > maxZ) maxZ = s.z;
    }
    const pad = 30;
    minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
    const w = maxX - minX, hh = maxZ - minZ;
    const ppm = Math.min(MAP_VIEW_PPM * 1.5, 2048 / Math.max(w, hh));
    const cv = this.doc.createElement('canvas');
    cv.width = Math.max(2, Math.ceil(w * ppm)); cv.height = Math.max(2, Math.ceil(hh * ppm));
    const c = cv.getContext('2d');
    if (!c) return;
    c.lineJoin = 'round'; c.lineCap = 'round';
    const path = () => {
      c.beginPath();
      for (let i = 0; i < S.length; i++) {
        const x = (S[i].x - minX) * ppm, y = (S[i].z - minZ) * ppm;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
    };
    path(); c.strokeStyle = 'rgba(0,0,0,0.85)'; c.lineWidth = 7; c.stroke();
    path(); c.strokeStyle = '#f4f4f4'; c.lineWidth = 3.5; c.stroke();
    this._mapImg = { cv, minX, minZ, w, h: hh, ppm };
  }

  // --- per-frame ---------------------------------------------------------------------------
  update(st) {
    const L = this._last, el = this.el;
    // speed
    const mph = st.units === 'mph';
    const spd = Math.round(Math.abs(st.speedMs) * (mph ? 2.23694 : 3.6));
    if (spd !== L.spd) { L.spd = spd; el.speed.textContent = spd; }
    if (mph !== L.mph) { L.mph = mph; el.unit.textContent = mph ? 'mph' : 'km/h'; }
    // gear
    const g = st.gear;
    if (g !== L.gear) { L.gear = g; el.gear.textContent = g < 0 ? 'R' : g === 0 ? 'N' : String(g); }
    // rpm
    const maxRpm = st.maxRpm || 8000;
    if (maxRpm !== this._tickMax) this._setTicks(maxRpm);
    const f = Math.max(0, Math.min(1, st.rpm / maxRpm));
    const fq = Math.round(f * 200);
    if (fq !== L.fq) {
      L.fq = fq;
      el.tachFill.setAttribute('stroke-dasharray', (fq * 5) + ' 1000');
      const red = f > 0.86;
      if (red !== L.red) { L.red = red; el.tach.classList.toggle('hud-redline', red); }
      const sh = f > 0.93;
      if (sh !== L.sh) { L.sh = sh; el.shift.classList.toggle('hud-on', sh); }
    }
    // timer
    const tt = fmtTime(st.timeMs);
    if (tt !== L.tt) { L.tt = tt; el.time.textContent = tt; }
    const pen = st.penaltyMs > 0 ? '+' + (st.penaltyMs / 1000).toFixed(1) + 's' : '';
    if (pen !== L.pen) { L.pen = pen; el.pen.textContent = pen; }
    // progress
    const span = (st.finishDist - st.startDist) || 1;
    const pr = Math.round(Math.max(0, Math.min(1, (st.dist - st.startDist) / span)) * 1000);
    if (pr !== L.pr) { L.pr = pr; const p = (pr / 10) + '%'; el.progCar.style.left = p; el.progFill.style.width = p; }
    // wrong way
    const ww = !!st.wrongWay;
    if (ww !== L.ww) { L.ww = ww; el.wrong.classList.toggle('hud-on', ww); }
    // notes
    this._updateNotes(st);
    // minimap (~20 fps)
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._mapT >= 50) { this._mapT = now; this._drawMap(st); }
  }

  _updateNotes(st) {
    const up = st.upcoming || [];
    for (let i = 0; i < 3; i++) {
      const slot = this._slots[i], n = up[i] || null;
      if (n !== slot.note) {
        slot.note = n; slot.dist = -1;
        if (!n) slot.el.style.display = 'none';
        else {
          slot.el.style.display = '';
          slot.el.innerHTML = noteHTML(n, false) + '<div class="hud-notedist"></div>';
          slot.distEl = slot.el.lastChild;
        }
      }
      if (n && typeof n.dist === 'number') {
        const dd = Math.max(0, Math.round((n.dist - st.dist) / 10) * 10);
        if (dd !== slot.dist) { slot.dist = dd; slot.distEl.textContent = dd + ' m'; }
      }
    }
  }

  _drawMap(st) {
    const c = this.mapCtx;
    if (!c) return;
    const W = MAP_SIZE, cx = W / 2, cy = W * 0.62;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, W);
    c.save();
    c.beginPath(); c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); c.clip();
    c.fillStyle = 'rgba(10,14,22,0.55)'; c.fillRect(0, 0, W, W);
    const h = st.carHeading || 0, ch = Math.cos(h), sh = Math.sin(h), s = MAP_VIEW_PPM;
    c.setTransform(ch * s, sh * s, -sh * s, ch * s, cx, cy);
    c.translate(-st.carX, -st.carZ);
    const m = this._mapImg;
    if (m) c.drawImage(m.cv, m.minX, m.minZ, m.w, m.h);
    const t = this.track;
    if (t && t.samples && t.samples.length) {
      const mk = (d, col, r) => {
        const i = Math.max(0, Math.min(t.samples.length - 1, Math.round(d / t.step)));
        const sp = t.samples[i];
        c.beginPath(); c.arc(sp.x, sp.z, r / s, 0, Math.PI * 2); c.fillStyle = col; c.fill();
        c.lineWidth = 1.5 / s; c.strokeStyle = '#000'; c.stroke();
      };
      for (const d of t.splits || []) mk(d, '#ffd21c', 4);
      mk(t.startDist, '#3ddc6a', 5.5);
      mk(t.finishDist, '#ff3b3b', 5.5);
    }
    if (st.ghostX !== undefined && st.ghostZ !== undefined) {
      c.beginPath(); c.arc(st.ghostX, st.ghostZ, 5 / s, 0, Math.PI * 2);
      c.fillStyle = 'rgba(120,200,255,0.9)'; c.fill(); c.lineWidth = 1.5 / s; c.strokeStyle = '#000'; c.stroke();
    }
    c.restore();
    // car marker (always pointing up)
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath(); c.moveTo(cx, cy - 9); c.lineTo(cx + 6, cy + 7); c.lineTo(cx, cy + 3); c.lineTo(cx - 6, cy + 7); c.closePath();
    c.fillStyle = '#ff2d2d'; c.fill(); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
    c.beginPath(); c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.85)'; c.stroke();
  }

  // --- events ------------------------------------------------------------------------------
  _restartAnim(e, cls) { e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls); }

  showCall(note) {
    if (!note) return;
    const el = this.el.call;
    el.innerHTML = noteHTML(note, false) + (note.text ? `<div class="hud-calltext">${esc(note.text)}</div>` : '');
    el.classList.add('hud-on');
    this._restartAnim(el, 'hud-pop');
    const s0 = this._slots[0].el;
    this._restartAnim(s0, 'hud-pop');
    clearTimeout(this._callTimer);
    this._callTimer = setTimeout(() => el.classList.remove('hud-on', 'hud-pop'), 2200);
  }

  showSplit(index, timeMs, deltaMs) {
    const el = this.el.split;
    let d = '';
    if (deltaMs !== null && deltaMs !== undefined) {
      const v = deltaMs / 1000;
      d = `<span class="hud-delta ${v <= 0 ? 'hud-fast' : 'hud-slow'}">${v <= 0 ? '-' : '+'}${Math.abs(v).toFixed(2)}</span>`;
    }
    el.innerHTML = `<span class="hud-splitlbl">SPLIT ${index + 1}</span><span class="hud-splittime">${fmtTime(timeMs)}</span>${d}`;
    el.classList.add('hud-on');
    this._restartAnim(el, 'hud-pop');
    clearTimeout(this._splitTimer);
    this._splitTimer = setTimeout(() => el.classList.remove('hud-on'), 4000);
  }

  message(text, ms = 1500) {
    const el = this.el.msg;
    el.textContent = text;
    el.classList.add('hud-on');
    this._restartAnim(el, 'hud-msg-anim');
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => el.classList.remove('hud-on', 'hud-msg-anim'), ms);
  }
}
