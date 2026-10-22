// audio.js — fully synthesized WebAudio engine/tire/wind/impact sounds. No files.
// Becomes a silent no-op if AudioContext is unavailable (node, old browsers).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const LOOSE = {
  // filter freq, base gain, grain rate multiplier
  gravel: { f: 1800, g: 1.0, r: 1.0 },
  dirt:   { f: 1200, g: 0.8, r: 0.8 },
  sand:   { f: 900,  g: 0.6, r: 0.7 },
  snow:   { f: 700,  g: 0.5, r: 0.6 },
  mud:    { f: 500,  g: 0.8, r: 0.5 },
  grass:  { f: 800,  g: 0.4, r: 0.6 },
  ash:    { f: 1000, g: 0.5, r: 0.7 },
  ice:    { f: 2500, g: 0.2, r: 1.2 },
};

function makeDriveCurve(amount) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

export class AudioEngine {
  constructor(settings) {
    this.settings = settings || { master: 0.8, engine: 0.7, fx: 0.8 };
    this.ctx = null;
    this.enabled = false;
    this.paused = false;
    this._prevGear = null;
    this._prevAirborne = false;
    this._prevThrottle = 0;
    this._lastVy = 0;
    this._turbo = 0;
    this._t = 0;
    this._limiterPhase = 0;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this._build();
      this.enabled = true;
    } catch (e) {
      this.enabled = false;
      this.ctx = null;
    }
  }

  // ------------------------------------------------------------ graph
  _noiseBuffer(seconds, kind) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (kind === 'grain') {
      // sparse decaying clicks: crunch of stones
      let env = 0;
      for (let i = 0; i < len; i++) {
        if (Math.random() < 0.012) env = 0.4 + Math.random() * 0.6;
        d[i] = (Math.random() * 2 - 1) * env;
        env *= 0.9;
      }
    } else if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  _loopNoise(buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start();
    return s;
  }

  _build() {
    const ctx = this.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.out.connect(comp);
    comp.connect(ctx.destination);

    this.pauseGain = ctx.createGain();
    this.pauseGain.gain.value = 1;
    this.pauseGain.connect(this.out);
    this.engineBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.engineBus.connect(this.pauseGain);
    this.fxBus.connect(this.pauseGain);

    this.whiteBuf = this._noiseBuffer(2, 'white');
    this.brownBuf = this._noiseBuffer(2, 'brown');
    this.grainBuf = this._noiseBuffer(2, 'grain');

    // ---- engine
    this.engShift = ctx.createGain();   // gear-change dips
    this.engLimiter = ctx.createGain(); // rev limiter stutter
    this.engGain = ctx.createGain();    // load volume
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engFilter.Q.value = 1.2;
    this.engShaper = ctx.createWaveShaper();
    this.engShaper.curve = makeDriveCurve(2.5);
    this.engMix = ctx.createGain();
    this.engMix.gain.value = 0.5;
    this.engMix.connect(this.engShaper);
    this.engShaper.connect(this.engFilter);
    this.engFilter.connect(this.engLimiter);
    this.engLimiter.connect(this.engShift);
    this.engShift.connect(this.engGain);
    this.engGain.connect(this.engineBus);

    const mk = (type, gain, mult, detune) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engMix);
      o.start();
      return { o, mult };
    };
    this.oscs = [
      mk('sawtooth', 0.55, 1, 0),
      mk('square', 0.3, 1, 7),
      mk('sawtooth', 0.4, 0.5, -5),
      mk('triangle', 0.25, 2, 3),
    ];
    // mechanical / intake noise
    this.engNoise = this._loopNoise(this.whiteBuf);
    this.engNoiseBp = ctx.createBiquadFilter();
    this.engNoiseBp.type = 'bandpass';
    this.engNoiseBp.frequency.value = 800;
    this.engNoiseBp.Q.value = 0.7;
    this.engNoiseGain = ctx.createGain();
    this.engNoiseGain.gain.value = 0.05;
    this.engNoise.connect(this.engNoiseBp);
    this.engNoiseBp.connect(this.engNoiseGain);
    this.engNoiseGain.connect(this.engShift);

    // turbo whistle
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 1500;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain);
    this.turboGain.connect(this.engineBus);
    this.turboOsc.start();

    // ---- tires
    this.squealSrc = this._loopNoise(this.whiteBuf);
    this.squealBp = ctx.createBiquadFilter();
    this.squealBp.type = 'bandpass';
    this.squealBp.frequency.value = 1900;
    this.squealBp.Q.value = 7;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealSrc.connect(this.squealBp);
    this.squealBp.connect(this.squealGain);
    this.squealGain.connect(this.fxBus);

    this.looseSrc = this._loopNoise(this.grainBuf);
    this.looseLp = ctx.createBiquadFilter();
    this.looseLp.type = 'lowpass';
    this.looseLp.frequency.value = 1500;
    this.looseGain = ctx.createGain();
    this.looseGain.gain.value = 0;
    this.looseSrc.connect(this.looseLp);
    this.looseLp.connect(this.looseGain);
    this.looseGain.connect(this.fxBus);

    // road rumble (tarmac hum)
    this.rumbleSrc = this._loopNoise(this.brownBuf);
    this.rumbleLp = ctx.createBiquadFilter();
    this.rumbleLp.type = 'lowpass';
    this.rumbleLp.frequency.value = 200;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSrc.connect(this.rumbleLp);
    this.rumbleLp.connect(this.rumbleGain);
    this.rumbleGain.connect(this.fxBus);

    // water
    this.waterSrc = this._loopNoise(this.whiteBuf);
    this.waterBp = ctx.createBiquadFilter();
    this.waterBp.type = 'bandpass';
    this.waterBp.frequency.value = 1400;
    this.waterBp.Q.value = 0.6;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this.waterSrc.connect(this.waterBp);
    this.waterBp.connect(this.waterGain);
    this.waterGain.connect(this.fxBus);

    // wind
    this.windSrc = this._loopNoise(this.brownBuf);
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass';
    this.windBp.frequency.value = 400;
    this.windBp.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windBp);
    this.windBp.connect(this.windGain);
    this.windGain.connect(this.fxBus);

    this._applyBuses(0.001);
  }

  _applyBuses(tau = 0.05) {
    if (!this.enabled) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(clamp(s.master ?? 0.8, 0, 1.5), t, tau);
    this.engineBus.gain.setTargetAtTime(clamp(s.engine ?? 0.7, 0, 1.5), t, tau);
    this.fxBus.gain.setTargetAtTime(clamp(s.fx ?? 0.8, 0, 1.5), t, tau);
  }

  _set(param, v, tau = 0.06) {
    param.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  // ------------------------------------------------------------ public API
  resume() {
    if (!this.enabled) return;
    try {
      if (this.ctx.state !== 'running') this.ctx.resume();
    } catch (e) { /* ignore */ }
  }

  setPaused(p) {
    this.paused = !!p;
    if (!this.enabled) return;
    this._set(this.pauseGain.gain, this.paused ? 0 : 1, 0.04);
  }

  update(dt, vehicle) {
    if (!this.enabled || !vehicle) return;
    this._t += dt;
    this._applyBuses(0.05);
    const t = this.ctx.currentTime;

    // ---- engine
    const maxRpm = vehicle.maxRpm || 7500;
    const rpm = clamp(vehicle.rpm || 900, 300, maxRpm * 1.05);
    const rpmN = clamp(rpm / maxRpm, 0, 1.05);
    const thr = clamp(vehicle.throttle || 0, 0, 1);
    const f = (rpm / 60) * 2; // 4-cyl firing frequency
    for (const { o, mult } of this.oscs) o.frequency.setTargetAtTime(f * mult, t, 0.03);
    const cutoff = 450 + rpmN * 1400 + thr * 2600;
    this._set(this.engFilter.frequency, cutoff, 0.05);
    const load = 0.32 + 0.5 * thr + 0.15 * rpmN;
    this._set(this.engGain.gain, load, 0.06);
    this._set(this.engNoiseGain.gain, 0.03 + 0.12 * thr * rpmN, 0.08);
    this._set(this.engNoiseBp.frequency, 500 + rpmN * 1500, 0.1);

    // rev limiter stutter
    const limiting = rpmN > 0.985 && thr > 0.5;
    if (limiting) {
      this._limiterPhase += dt * 28;
      const cut = Math.floor(this._limiterPhase) % 2 === 0 ? 1 : 0.15;
      this._set(this.engLimiter.gain, cut, 0.004);
    } else {
      this._set(this.engLimiter.gain, 1, 0.02);
    }

    // gear change pop
    const gear = vehicle.gear;
    if (this._prevGear !== null && gear !== this._prevGear && gear !== undefined) this._shiftPop(thr, rpmN);
    this._prevGear = gear;

    // turbo
    const target = thr * rpmN * rpmN;
    this._turbo += (target - this._turbo) * clamp(dt * (target > this._turbo ? 2.5 : 4), 0, 1);
    this._set(this.turboOsc.frequency, 1400 + this._turbo * 2800, 0.05);
    this._set(this.turboGain.gain, this._turbo * 0.05, 0.08);
    if (this._prevThrottle > 0.6 && thr < 0.2 && this._turbo > 0.25) this._blowOff(this._turbo);
    this._prevThrottle = thr;

    // ---- tires & surfaces
    const wheels = vehicle.wheels || [];
    let squeal = 0, looseLevel = 0, looseF = 0, looseR = 0, looseN = 0, water = 0, contactN = 0, tarmacN = 0;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (!w || !w.contact) continue;
      contactN++;
      water += w.water || 0;
      const sr = (w.slipRatio || 0) / 0.2;
      const sa = (w.slipAngle || 0) / 0.15;
      const norm = Math.sqrt(sr * sr + sa * sa);
      if (w.surface === 'tarmac' || w.surface === 'wet') {
        tarmacN++;
        squeal = Math.max(squeal, clamp((norm - 0.8) / 1.2, 0, 1));
      } else {
        const L = LOOSE[w.surface];
        if (L) {
          looseN++;
          looseLevel += L.g;
          looseF += L.f;
          looseR += L.r;
          squeal = Math.max(squeal, clamp((norm - 1.2) / 2, 0, 0.35) * (w.surface === 'ice' ? 1 : 0.3));
        }
      }
    }
    const speed = Math.abs(vehicle.speed || 0);
    const speedN = clamp(speed / 50, 0, 1.2);
    const wet = wheels.some((w) => w && w.surface === 'wet');
    this._set(this.squealGain.gain, squeal * 0.22, 0.04);
    this._set(this.squealBp.frequency, (wet ? 2300 : 1800) + squeal * 500 + Math.sin(this._t * 9) * 60, 0.05);

    if (looseN > 0) {
      const avgG = looseLevel / looseN, avgF = looseF / looseN, avgR = looseR / looseN;
      const slipBoost = 1 + squeal * 0.8;
      this._set(this.looseGain.gain, clamp(speedN, 0, 1) * avgG * 0.5 * (looseN / 4 + 0.5) * slipBoost, 0.08);
      this._set(this.looseLp.frequency, avgF, 0.1);
      this.looseSrc.playbackRate.setTargetAtTime(0.4 + speedN * 1.6 * avgR, t, 0.08);
    } else {
      this._set(this.looseGain.gain, 0, 0.08);
    }
    // tarmac road hum
    this._set(this.rumbleGain.gain, (tarmacN / 4) * speedN * 0.25, 0.1);
    this._set(this.rumbleLp.frequency, 120 + speedN * 250, 0.1);

    // water splash
    const waterAvg = contactN ? water / contactN : 0;
    this._set(this.waterGain.gain, clamp(waterAvg, 0, 1) * clamp(speedN * 1.3, 0, 1) * 0.45, 0.06);
    this._set(this.waterBp.frequency, 900 + speedN * 1200, 0.1);

    // wind
    const air = vehicle.airborne ? 1.15 : 1;
    this._set(this.windGain.gain, Math.pow(speedN, 1.6) * 0.5 * air, 0.12);
    this._set(this.windBp.frequency, 300 + speedN * 1100, 0.12);

    // landing
    const airborne = !!vehicle.airborne;
    if (airborne) {
      const vy = vehicle.velocity ? vehicle.velocity.y : 0;
      this._lastVy = vy;
    }
    if (this._prevAirborne && !airborne) {
      const s = clamp((-this._lastVy || 4) / 10, 0.15, 1);
      this._landing(s);
    }
    this._prevAirborne = airborne;
  }

  // ------------------------------------------------------------ one-shots
  _noiseBurst(o) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.frequency.setValueAtTime(o.freq, t0);
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + o.dur);
    f.Q.value = o.q || 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f); f.connect(g); g.connect(o.dest || this.fxBus);
    src.start(t0, Math.random());
    src.stop(t0 + o.dur + 0.05);
  }

  _tone(o) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.endFreq) osc.frequency.exponentialRampToValueAtTime(o.endFreq, t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack || 0.005));
    if (o.hold) g.gain.setValueAtTime(o.gain, t0 + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g); g.connect(o.dest || this.fxBus);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }

  _shiftPop(thr, rpmN) {
    const g = this.engShift.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.25, t + 0.02);
    g.linearRampToValueAtTime(1, t + 0.12);
    if (thr > 0.3 && rpmN > 0.4) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        this._noiseBurst({
          type: 'bandpass', freq: 600 + Math.random() * 600, q: 1.2, dur: 0.05 + Math.random() * 0.04,
          gain: 0.25 + Math.random() * 0.2, delay: 0.03 + i * (0.05 + Math.random() * 0.05), dest: this.engineBus,
        });
      }
    }
  }

  _blowOff(level) {
    this._noiseBurst({
      type: 'highpass', freq: 2500, sweepTo: 5000, q: 0.5, dur: 0.35 + level * 0.25,
      gain: 0.12 + level * 0.2, attack: 0.01, dest: this.engineBus,
    });
  }

  _landing(s) {
    this._tone({ freq: 90, endFreq: 35, dur: 0.3, gain: 0.7 * s, type: 'sine' });
    this._noiseBurst({ type: 'lowpass', freq: 900, sweepTo: 150, dur: 0.25, gain: 0.5 * s });
  }

  impact(strength = 8) {
    if (!this.enabled) return;
    this.resume();
    const s = clamp(strength / 12, 0.1, 1);
    this._noiseBurst({ type: 'bandpass', freq: 1800, sweepTo: 300, q: 0.6, dur: 0.35 + s * 0.3, gain: 0.8 * s });
    this._noiseBurst({ type: 'lowpass', freq: 600, sweepTo: 80, dur: 0.5, gain: 0.7 * s });
    this._tone({ freq: 110, endFreq: 38, dur: 0.45, gain: 0.9 * s, type: 'sine' });
    if (s > 0.35) {
      for (let i = 0; i < 3; i++) {
        this._tone({
          freq: 700 + Math.random() * 1500, dur: 0.12 + Math.random() * 0.15, gain: 0.12 * s,
          type: 'square', delay: Math.random() * 0.1,
        });
      }
    }
  }

  beep(kind = 'ui') {
    if (!this.enabled) return;
    this.resume();
    const ui = kind === 'ui';
    // ui beeps bypass the pause mute so menus can click while paused
    const dest = ui ? this.out : this.fxBus;
    const v = ui ? 0.25 : 0.4;
    switch (kind) {
      case 'countdown':
        this._tone({ freq: 440, dur: 0.22, gain: v, type: 'square', hold: 0.12, dest });
        break;
      case 'go':
        this._tone({ freq: 880, dur: 0.6, gain: v, type: 'square', hold: 0.4, dest });
        this._tone({ freq: 1320, dur: 0.6, gain: v * 0.4, type: 'sine', hold: 0.4, dest });
        break;
      case 'split':
        this._tone({ freq: 660, dur: 0.14, gain: v, type: 'triangle', dest });
        this._tone({ freq: 990, dur: 0.22, gain: v, type: 'triangle', delay: 0.12, dest });
        break;
      case 'finish':
        [523, 659, 784, 1047].forEach((fr, i) =>
          this._tone({ freq: fr, dur: i === 3 ? 0.7 : 0.18, gain: v, type: 'triangle', delay: i * 0.14, dest }));
        break;
      default:
        this._tone({ freq: 1000, dur: 0.06, gain: v, type: 'sine', dest });
    }
  }
}
