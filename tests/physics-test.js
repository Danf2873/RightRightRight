// physics-test.js - fake tracks for exercising vehicle.js (works in the browser and in node).
// Every track implements the subset of the Track contract the vehicle uses:
//   groundAt(x, z, cache, out), collidersNear(x, z, r)

/**
 * Generic heightfield track.
 * @param {object} o
 *   surface   surface id (or fn(x,z) -> id)
 *   height    fn(x,z) -> y   (default flat 0)
 *   colliders array of {x,z,r,kind}
 *   water     fn(x,z) -> 0..1 (optional)
 */
export function makeTrack(o = {}) {
  const surface = o.surface || 'tarmac';
  const hf = o.height || (() => 0);
  const colliders = o.colliders || [];
  const waterFn = o.water || null;
  const near = [];
  const E = 0.15;
  return {
    offroadSurface: 'grass',
    groundAt(x, z, cache, out) {
      const h = hf(x, z);
      const hx = hf(x + E, z) - hf(x - E, z);
      const hz = hf(x, z + E) - hf(x, z - E);
      // normal = (-dh/dx, 1, -dh/dz) normalised
      const gx = -hx / (2 * E), gz = -hz / (2 * E);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      out.height = h;
      out.nx = gx * inv; out.ny = inv; out.nz = gz * inv;
      out.surface = typeof surface === 'function' ? surface(x, z) : surface;
      out.onRoad = true;
      out.water = waterFn ? waterFn(x, z) : 0;
      return out;
    },
    collidersNear(x, z, r) {
      near.length = 0;
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        const dx = c.x - x, dz = c.z - z, rr = r + c.r;
        if (dx * dx + dz * dz < rr * rr) near.push(c);
      }
      return near;
    },
  };
}

export const flatTrack = (surface = 'tarmac') => makeTrack({ surface });

/** Constant slope rising towards -Z by `deg` degrees. */
export const slopeTrack = (deg, surface = 'tarmac') =>
  makeTrack({ surface, height: (x, z) => -z * Math.tan(deg * Math.PI / 180) });

/** Flat road with a launch ramp: starts at z = -zStart, rises `rise` m over `len` m, then drops off. */
export function rampTrack({ zStart = 60, len = 10, rise = 1.0, surface = 'tarmac' } = {}) {
  return makeTrack({
    surface,
    height: (x, z) => {
      const d = -z - zStart;
      if (d <= 0) return 0;
      if (d >= len) return 0;
      // smooth ramp: linear with slightly eased entry
      const t = d / len;
      return rise * (t * t * (1.6 - 0.6 * t));
    },
  });
}

/** Washboard / bumpy ground. */
export const bumpyTrack = (amp = 0.06, surface = 'gravel') =>
  makeTrack({ surface, height: (x, z) => amp * (Math.sin(z * 1.3) * Math.cos(x * 0.9) + 0.5 * Math.sin(z * 3.1 + x)) });

/** A raised platform: ground is `drop` m higher for z > -zEdge so we can drop the car off it. */
export const dropTrack = (drop = 1.5, zEdge = 0, surface = 'tarmac') =>
  makeTrack({ surface, height: (x, z) => (z > -zEdge ? drop : 0) });

/** Demo course for the browser page: mixed surfaces, bumps, ramp and some scenery circles. */
export function demoTrack() {
  const colliders = [];
  let s = 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 70; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    colliders.push({ x: side * (14 + rnd() * 60), z: -rnd() * 700 + 100, r: 0.4 + rnd() * 0.6, kind: 'tree' });
  }
  for (let i = 0; i < 12; i++) colliders.push({ x: (rnd() - 0.5) * 20, z: -40 - i * 55, r: 0.9 + rnd() * 0.8, kind: 'rock' });
  colliders.push({ x: -6, z: -20, r: 0.3, kind: 'post' }, { x: 6, z: -20, r: 0.3, kind: 'post' });
  const surfaceAt = (x, z) => {
    if (z > -150) return 'tarmac';
    if (z > -300) return 'gravel';
    if (z > -380) return 'wet';
    if (z > -460) return 'snow';
    if (z > -540) return 'ice';
    if (z > -620) return 'mud';
    return 'sand';
  };
  const height = (x, z) => {
    let y = 0;
    // ramp near z=-110
    let d = -z - 110;
    if (d > 0 && d < 12) { const t = d / 12; y += 1.4 * t * t * (1.6 - 0.6 * t); }
    // bumpy section on gravel
    if (z < -170 && z > -260) y += 0.07 * (Math.sin(z * 1.1) * Math.cos(x * 0.7) + 0.5 * Math.sin(z * 2.7 + x));
    // hill
    y += 3.0 * Math.exp(-(((x - 8) * (x - 8)) / 600 + ((z + 330) * (z + 330)) / 2500));
    return y;
  };
  const t = makeTrack({ surface: surfaceAt, height, colliders });
  return t;
}
