import * as THREE from 'three';

// Driver's-eye interior: dashboard with live gauges, steering wheel, roll cage, sequential shifter,
// hydraulic handbrake lever, codriver in the right seat. Parented to vehicle.mesh, shown only in
// cockpit camera. Coordinates are the car body frame (origin = COM, forward -Z, right +X, up +Y),
// matching the hull in vehicle.js (windscreen base z -0.80 / y 0.29, roof y 0.885).

export const EYE = new THREE.Vector3(-0.36, 0.63, 0.30); // left-hand drive

const WHEEL_POS = new THREE.Vector3(-0.36, 0.44, -0.22);
const STEERING_RATIO = 13; // wheel turns this many times the road-wheel angle

const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, metalness: 0.05, ...extra });

// Box stretched between two points (for pillars and cage tubes).
function strut(a, b, thick, material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(thick, thick, len), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
  return m;
}

export class Cockpit {
  constructor(vehicle) {
    this.vehicle = vehicle;
    this.group = new THREE.Group();
    this.group.visible = false;
    vehicle.mesh.add(this.group);

    const dash = mat(0x1d1f23);
    const trim = mat(0x2b2e33);
    const cage = mat(0xc9ccd1, { roughness: 0.4, metalness: 0.6 });
    const red = mat(0xd8262b);
    const black = mat(0x0f0f11);
    const alcantara = mat(0x26282c, { roughness: 1 });
    const suit = mat(0x1f4fa8);
    const helmet = mat(0xf2f2f2, { roughness: 0.4 });
    const g = this.group;
    const add = (m) => { g.add(m); return m; };

    // dashboard: main slab + slanted top + centre console
    const dashTop = add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.42), dash));
    dashTop.position.set(0, 0.36, -0.62);
    dashTop.rotation.x = 0.12;
    const dashFace = add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, 0.06), dash));
    dashFace.position.set(0, 0.22, -0.42);
    // cabin floor sits just above the hull's top face (y 0.34) so the paint never shows inside
    const floor = add(new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.02, 2.3), mat(0x18191c, { roughness: 1 })));
    floor.position.set(0, 0.35, 0.4);
    const console = add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.5), trim));
    console.position.set(0, 0.4, -0.3);
    // switch panel on the console
    for (let i = 0; i < 6; i++) {
      const sw = add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.03), i % 3 === 0 ? red : black));
      sw.position.set(-0.08 + (i % 3) * 0.08, 0.455, -0.42 + Math.floor(i / 3) * 0.06);
    }

    // instrument binnacle with a canvas-drawn display
    const hood = add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.16), dash));
    hood.position.set(EYE.x, 0.45, -0.5);
    hood.rotation.x = 0.25;
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (this.canvas) {
      this.canvas.width = 256;
      this.canvas.height = 112;
      this.ctx = this.canvas.getContext('2d');
      this.tex = new THREE.CanvasTexture(this.canvas);
      this.tex.colorSpace = THREE.SRGBColorSpace;
      const screen = add(new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.14),
        new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false })));
      screen.position.set(EYE.x, 0.385, -0.44);
      screen.rotation.x = -0.32;
    }

    // inner door cards and window sills (hide the culled hull from inside)
    for (const s of [-1, 1]) {
      const door = add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 2.1), trim));
      door.position.set(s * 0.8, 0.05, 0.25);
      const sill = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 2.0), dash));
      sill.position.set(s * 0.76, 0.31, 0.3);
    }
    // roof liner + windscreen header
    const liner = add(new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.03, 1.25), alcantara));
    liner.position.set(0, 0.855, 0.45);
    const header = add(new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.08, 0.12), dash));
    header.position.set(0, 0.82, -0.17);
    // rear-view mirror
    const mirror = add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 0.02), black));
    mirror.position.set(0, 0.76, -0.2);

    // A-pillars along the windscreen edges
    for (const s of [-1, 1]) {
      add(strut(new THREE.Vector3(s * 0.72, 0.30, -0.80), new THREE.Vector3(s * 0.70, 0.84, -0.16), 0.08, dash));
    }
    // roll cage: front hoop following the A-pillars, main hoop behind seats, roof diagonals, door bars
    const t = 0.04;
    const fl = new THREE.Vector3(-0.66, 0.28, -0.72), fr = new THREE.Vector3(0.66, 0.28, -0.72);
    const ftl = new THREE.Vector3(-0.64, 0.80, -0.14), ftr = new THREE.Vector3(0.64, 0.80, -0.14);
    const ml = new THREE.Vector3(-0.68, -0.2, 0.75), mr = new THREE.Vector3(0.68, -0.2, 0.75);
    const mtl = new THREE.Vector3(-0.64, 0.80, 0.75), mtr = new THREE.Vector3(0.64, 0.80, 0.75);
    for (const [a, b] of [[fl, ftl], [fr, ftr], [ftl, ftr], [ftl, mtl], [ftr, mtr], [ml, mtl], [mr, mtr], [mtl, mtr], [ftl, mtr],
      [new THREE.Vector3(-0.7, -0.15, -0.6), new THREE.Vector3(-0.7, 0.2, 0.7)], [new THREE.Vector3(0.7, -0.15, -0.6), new THREE.Vector3(0.7, 0.2, 0.7)],
      [new THREE.Vector3(-0.7, 0.22, -0.6), new THREE.Vector3(-0.7, -0.15, 0.7)], [new THREE.Vector3(0.7, 0.22, -0.6), new THREE.Vector3(0.7, -0.15, 0.7)]]) {
      add(strut(a, b, t, cage));
    }

    // steering column + wheel (suede rim, 3 spokes, top marker)
    add(strut(new THREE.Vector3(EYE.x, 0.32, -0.55), WHEEL_POS, 0.05, black));
    this.wheel = new THREE.Group();
    this.wheel.position.copy(WHEEL_POS);
    this.wheel.rotation.x = -0.32;
    g.add(this.wheel);
    this.wheelSpin = new THREE.Group();
    this.wheel.add(this.wheelSpin);
    this.wheelSpin.add(new THREE.Mesh(new THREE.TorusGeometry(0.175, 0.022, 6, 16), alcantara));
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.05), mat(0xffcc00));
    marker.position.set(0, 0.175, 0);
    this.wheelSpin.add(marker);
    for (const ang of [Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.02), trim);
      sp.position.set(Math.cos(ang) * 0.085, Math.sin(ang) * 0.085, 0.005);
      sp.rotation.z = ang;
      this.wheelSpin.add(sp);
    }
    this.wheelSpin.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 8).rotateX(Math.PI / 2), red));

    // sequential shifter (tilts on gear change) + hydraulic handbrake (pulls back with input)
    this.shifter = new THREE.Group();
    this.shifter.position.set(-0.06, 0.44, -0.2);
    g.add(this.shifter);
    const sStick = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.025), cage);
    sStick.position.y = 0.08;
    const sKnob = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.04), black);
    sKnob.position.y = 0.17;
    this.shifter.add(sStick, sKnob);

    this.handbrake = new THREE.Group();
    this.handbrake.position.set(-0.06, 0.36, -0.02);
    g.add(this.handbrake);
    const hStick = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.22, 0.025), cage);
    hStick.position.y = 0.11;
    const hGrip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.07, 0.035), red);
    hGrip.position.y = 0.21;
    this.handbrake.add(hStick, hGrip);
    this.handbrake.rotation.x = -0.35; // leaning forward = released

    // seats (codriver side visible in peripheral vision) and the codriver with pace-note book
    const seat = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.12), black));
    seat.position.set(0.36, 0.6, 0.62);
    seat.rotation.x = 0.15;
    const torso = add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.26), suit));
    torso.position.set(0.36, 0.42, 0.42);
    this.codriverHead = new THREE.Group();
    this.codriverHead.position.set(0.36, 0.71, 0.42);
    g.add(this.codriverHead);
    const helm = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), helmet);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.04), mat(0x1a2533, { roughness: 0.2, metalness: 0.5 }));
    visor.position.set(0, 0.01, -0.13);
    this.codriverHead.add(helm, visor);
    const book = add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.16), mat(0xf4f1e6)));
    book.position.set(0.36, 0.45, 0.18);
    book.rotation.x = 0.7;
    for (const s of [-1, 1]) {
      add(strut(new THREE.Vector3(0.36 + s * 0.2, 0.6, 0.4), new THREE.Vector3(0.36 + s * 0.1, 0.46, 0.2), 0.07, suit));
    }

    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

    this._gear = null;
    this._shiftKick = 0;
    this._hb = 0;
    this._drawTimer = 0;
    this._talk = 0;
  }

  setVisible(v) { this.group.visible = v; }

  // Codriver nods while reading a call.
  talk() { this._talk = 0.9; }

  update(dt, input, units) {
    if (!this.group.visible) return;
    const v = this.vehicle;
    this.wheelSpin.rotation.z = -(v.steerAngle || 0) * STEERING_RATIO;

    if (this._gear !== null && v.gear !== this._gear) this._shiftKick = v.gear > this._gear ? 1 : -1;
    this._gear = v.gear;
    this._shiftKick *= Math.exp(-12 * dt);
    this.shifter.rotation.x = this._shiftKick * 0.35;

    const hbTarget = input ? input.handbrake : 0;
    this._hb += (hbTarget - this._hb) * (1 - Math.exp(-25 * dt));
    this.handbrake.rotation.x = -0.35 + this._hb * 0.75;

    this._talk = Math.max(0, this._talk - dt);
    this.codriverHead.rotation.x = 0.35 + Math.sin(this._talk * 18) * 0.06 * Math.min(1, this._talk * 3);

    this._drawTimer -= dt;
    if (this.ctx && this._drawTimer <= 0) {
      this._drawTimer = 1 / 20;
      this.draw(units);
    }
  }

  draw(units) {
    const v = this.vehicle;
    const c = this.ctx;
    const W = 256, H = 112;
    c.fillStyle = '#07090c';
    c.fillRect(0, 0, W, H);
    const frac = Math.max(0, Math.min(1, (v.rpm || 0) / (v.maxRpm || 7500)));
    // shift lights
    const n = 10;
    for (let i = 0; i < n; i++) {
      const on = frac > 0.55 + (i / n) * 0.42;
      c.fillStyle = on ? (i < 4 ? '#35c26b' : i < 8 ? '#ffcc00' : '#ff3b2e') : '#1a1d22';
      c.fillRect(18 + i * 22, 6, 16, 8);
    }
    // rpm bar
    c.fillStyle = '#1a1d22';
    c.fillRect(14, 22, 228, 14);
    c.fillStyle = frac > 0.9 ? '#ff3b2e' : '#ffcc00';
    c.fillRect(14, 22, 228 * frac, 14);
    // gear + speed
    const gear = v.gear < 0 ? 'R' : v.gear === 0 ? 'N' : String(v.gear);
    c.fillStyle = '#ffffff';
    c.font = 'bold 62px "Barlow Condensed", Arial Narrow, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillText(gear, 128, 104);
    const sp = Math.abs(v.speed || 0) * (units === 'mph' ? 2.23694 : 3.6);
    c.font = 'bold 40px "Barlow Condensed", Arial Narrow, sans-serif';
    c.textAlign = 'right';
    c.fillText(String(Math.round(sp)), 238, 98);
    c.font = '14px Barlow, sans-serif';
    c.fillStyle = '#9aa4b2';
    c.fillText(units === 'mph' ? 'MPH' : 'KM/H', 238, 58);
    c.textAlign = 'left';
    c.fillText(`${Math.round(v.rpm || 0)} RPM`, 16, 58);
    const dmg = v.damage || 0;
    c.fillStyle = dmg < 0.3 ? '#35c26b' : dmg < 0.65 ? '#ffcc00' : '#ff3b2e';
    c.fillText(`DMG ${Math.round(dmg * 100)}%`, 16, 98);
    this.tex.needsUpdate = true;
  }
}
