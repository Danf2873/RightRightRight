// touch.js — on-screen controls for phones and tablets. Each control holds an Input action
// (see Input.setVirtual), so touch goes through the same smoothing as the keyboard.

const STEER_ACTIONS = ['left', 'right'];

export function isTouchDevice() {
  try {
    return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints || 0) > 0;
  } catch (e) { return false; }
}

export class TouchControls {
  constructor(root, input) {
    this.input = input;
    this.root = document.createElement('div');
    this.root.className = 'tc-root';
    this.root.innerHTML = `
<div class="tc-steer"><div class="tc-btn tc-left" data-side="left">&#9664;</div><div class="tc-btn tc-right" data-side="right">&#9654;</div></div>
<div class="tc-pedals">
  <div class="tc-shift"><div class="tc-btn tc-small" data-act="shiftUp">+</div><div class="tc-btn tc-small" data-act="shiftDown">&minus;</div></div>
  <div class="tc-btn tc-hb" data-act="handbrake">HB</div>
  <div class="tc-btn tc-brake" data-act="brake">BRAKE</div>
  <div class="tc-btn tc-gas" data-act="throttle">GAS</div>
</div>
<div class="tc-menu">
  <div class="tc-btn tc-small" data-act="pause">&#10073;&#10073;</div>
  <div class="tc-btn tc-small" data-act="camera">CAM</div>
  <div class="tc-btn tc-small" data-act="repeatNote">NOTE</div>
  <div class="tc-btn tc-small" data-act="reset">RESET</div>
</div>`;
    root.appendChild(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    // buttons: an action is held while any pointer that started on it is still down
    for (const b of this.root.querySelectorAll('[data-act]')) {
      const act = b.dataset.act;
      const ids = new Set();
      const sync = () => { b.classList.toggle('tc-on', ids.size > 0); this.input.setVirtual(act, ids.size > 0); };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        ids.add(e.pointerId); sync();
      });
      const up = (e) => { if (ids.delete(e.pointerId)) sync(); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    }

    // steering: one zone, so a thumb can slide between left and right without lifting
    const zone = this.root.querySelector('.tc-steer');
    const left = zone.querySelector('.tc-left'), right = zone.querySelector('.tc-right');
    this._steerPtrs = new Map();
    const syncSteer = () => {
      let l = false, r = false;
      const rect = zone.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      for (const x of this._steerPtrs.values()) { if (x < mid) l = true; else r = true; }
      left.classList.toggle('tc-on', l); right.classList.toggle('tc-on', r);
      this.input.setVirtual('left', l); this.input.setVirtual('right', r);
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this._steerPtrs.set(e.pointerId, e.clientX); syncSteer();
    });
    zone.addEventListener('pointermove', (e) => {
      if (this._steerPtrs.has(e.pointerId)) { this._steerPtrs.set(e.pointerId, e.clientX); syncSteer(); }
    });
    const steerUp = (e) => { if (this._steerPtrs.delete(e.pointerId)) syncSteer(); };
    zone.addEventListener('pointerup', steerUp);
    zone.addEventListener('pointercancel', steerUp);
    zone.addEventListener('lostpointercapture', steerUp);

    this.setVisible(false);
  }

  /** Show the shift buttons only with the manual gearbox. */
  setManual(on) { this.root.classList.toggle('tc-manual', !!on); }

  setVisible(on) {
    on = !!on;
    if (this._visible === on) return;
    this._visible = on;
    this.root.style.display = on ? '' : 'none';
    document.body.classList.toggle('touch-ui', on);
    if (!on) this.releaseAll();
  }

  releaseAll() {
    this._steerPtrs.clear();
    for (const a of STEER_ACTIONS) this.input.setVirtual(a, false);
    for (const b of this.root.querySelectorAll('[data-act]')) this.input.setVirtual(b.dataset.act, false);
    for (const b of this.root.querySelectorAll('.tc-on')) b.classList.remove('tc-on');
  }
}
