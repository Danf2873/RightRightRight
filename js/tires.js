// tires.js - surface grip table + simplified Pacejka "magic formula" tyre model.
//
// tireForces(slipRatio, slipAngle, load, surfaceId, out) -> out
//   slipRatio : longitudinal slip, +ve = wheel driving the ground forward (accelerating), -ve = braking.
//               Roughly -1..1 (1 = pure wheelspin, -1 = locked wheel).
//   slipAngle : rad, +ve = contact patch is moving to the wheel's RIGHT relative to its heading.
//   load      : normal load in N.
//   out.fx    : force on the tyre along wheel forward  (+ve = pushes car forward)
//   out.fy    : force on the tyre along wheel right    (opposes slip: slipAngle>0 -> fy<0)
//   out.mu    : effective friction coefficient at this load (after load sensitivity)
//   out.s     : normalised combined slip (1 = at the peak of the curve)
//
// Combined slip uses a friction-ellipse style normalisation: the longitudinal and lateral slips
// are divided by their own peak-slip values, combined into one scalar and passed through a single
// magic-formula curve, so the force direction follows the slip vector.

const N_REF = 3000;      // reference tyre load (N) at which `grip` applies
const LOAD_SENS = 0.12;  // fractional drop of mu per +100% of load

// grip      peak friction coefficient at N_REF
// C, E      magic formula shape (C: <1.2 flat/progressive, ~1.4 sharper peak; E curvature)
// kPeak     slip ratio at which the peak occurs
// aPeak     slip angle (rad) at which the peak occurs
// rolling   rolling resistance coefficient; rolling2 extra per m/s
// color     ground colour (for decals/particles)  dust: particle colour  dustAmount 0..1 (0 = none)
export const SURFACES = {
  tarmac: { grip: 1.12, C: 1.45, E: -0.2, kPeak: 0.11, aPeak: 0.11, rolling: 0.013, rolling2: 0.00005, color: 0x3a3a3e, dust: 0xa0a0a0, dustAmount: 0.0 },
  wet:    { grip: 0.78, C: 1.38, E: -0.1, kPeak: 0.12, aPeak: 0.13, rolling: 0.016, rolling2: 0.00010, color: 0x2c2f35, dust: 0xb8c4cc, dustAmount: 0.1 },
  gravel: { grip: 0.72, C: 1.16, E: 0.0,  kPeak: 0.20, aPeak: 0.22, rolling: 0.030, rolling2: 0.00040, color: 0x8c8579, dust: 0xc9bfa8, dustAmount: 0.8 },
  dirt:   { grip: 0.82, C: 1.20, E: 0.0,  kPeak: 0.17, aPeak: 0.20, rolling: 0.024, rolling2: 0.00030, color: 0x7a5a3a, dust: 0xa4825a, dustAmount: 0.7 },
  sand:   { grip: 0.62, C: 1.10, E: 0.0,  kPeak: 0.25, aPeak: 0.30, rolling: 0.075, rolling2: 0.00100, color: 0xd9c28a, dust: 0xe6d3a0, dustAmount: 1.0 },
  snow:   { grip: 0.38, C: 1.14, E: 0.0,  kPeak: 0.20, aPeak: 0.24, rolling: 0.036, rolling2: 0.00040, color: 0xe8eef2, dust: 0xffffff, dustAmount: 0.6 },
  ice:    { grip: 0.18, C: 1.25, E: 0.0,  kPeak: 0.12, aPeak: 0.14, rolling: 0.010, rolling2: 0.00002, color: 0xbfe0f0, dust: 0xe0f3fb, dustAmount: 0.1 },
  mud:    { grip: 0.50, C: 1.10, E: 0.0,  kPeak: 0.25, aPeak: 0.30, rolling: 0.090, rolling2: 0.00120, color: 0x4a3524, dust: 0x5a4230, dustAmount: 0.5 },
  grass:  { grip: 0.55, C: 1.12, E: 0.0,  kPeak: 0.22, aPeak: 0.26, rolling: 0.060, rolling2: 0.00060, color: 0x4f7a34, dust: 0x6b8f45, dustAmount: 0.2 },
  ash:    { grip: 0.55, C: 1.15, E: 0.0,  kPeak: 0.22, aPeak: 0.26, rolling: 0.050, rolling2: 0.00060, color: 0x4a4846, dust: 0x7a7774, dustAmount: 0.9 },
};

// Derive B so the curve peaks exactly at normalised slip s = 1, and CB (initial slope).
for (const id in SURFACES) {
  const S = SURFACES[id];
  const xp = Math.tan(Math.PI / (2 * S.C));
  let B = xp;
  for (let i = 0; i < 30; i++) B = (xp - S.E * Math.atan(B)) / (1 - S.E);
  S.B = B;
  S.CB = S.C * B;
}

export const TIRE_REF_LOAD = N_REF;

export function getSurface(id) {
  return SURFACES[id] || SURFACES.tarmac;
}

/** Friction coefficient available at `load` newtons on a surface (load sensitivity applied). */
export function muAtLoad(load, surfaceId) {
  const S = SURFACES[surfaceId] || SURFACES.tarmac;
  let k = 1 - LOAD_SENS * (load / N_REF - 1);
  if (k < 0.6) k = 0.6; else if (k > 1.25) k = 1.25;
  return S.grip * k;
}

export function tireForces(slipRatio, slipAngle, load, surfaceId, out) {
  const S = SURFACES[surfaceId] || SURFACES.tarmac;
  const N = load > 0 ? load : 0;
  let k = 1 - LOAD_SENS * (N / N_REF - 1);
  if (k < 0.6) k = 0.6; else if (k > 1.25) k = 1.25;
  const mu = S.grip * k;

  const sx = slipRatio / S.kPeak;
  const sy = slipAngle / S.aPeak;
  const s = Math.sqrt(sx * sx + sy * sy);

  let g; // f(s)/s
  if (s < 1e-4) {
    g = S.CB;
  } else {
    const bs = S.B * s;
    const x = bs - S.E * (bs - Math.atan(bs));
    g = Math.sin(S.C * Math.atan(x)) / s;
  }
  const F = mu * N * g;
  out.fx = F * sx;
  out.fy = -F * sy;
  out.mu = mu;
  out.s = s;
  return out;
}
