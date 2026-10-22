// Deterministic RNG + value noise helpers (no dependencies).

export function mulberry32(a) {
  a = a | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(ix, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** smooth value noise in [-1,1] */
export function vnoise2(x, z, seed = 0) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

export function vnoise1(x, seed = 0) {
  const ix = Math.floor(x);
  const f = x - ix;
  const u = f * f * (3 - 2 * f);
  const a = hash2(ix, 7, seed), b = hash2(ix + 1, 7, seed);
  return (a + (b - a) * u) * 2 - 1;
}

export function fbm2(x, z, seed = 0, oct = 3) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise2(x * f, z * f, seed + i * 31);
    n += a; a *= 0.5; f *= 2.03;
  }
  return s / n;
}

export function fbm1(x, seed = 0, oct = 3) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise1(x * f, seed + i * 17);
    n += a; a *= 0.5; f *= 2.1;
  }
  return s / n;
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
/** smoothstep between edges a<b */
export function ss(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}
export function wrapAngle(a) {
  const TAU = Math.PI * 2;
  a = a % TAU;
  if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU;
  return a;
}
