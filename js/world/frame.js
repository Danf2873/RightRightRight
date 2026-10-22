// Local road lookup shared by terrain generation, scenery placement and the runtime queries.
// W holds typed arrays per centerline sample. All functions are allocation-free.

export function makeLocator(W) {
  const { X, Z, Y, YREF, HW, BANK, VALLEY, N } = W;
  const loc = { best: 0 };

  /** hill-climb from sample i to the locally nearest sample; loc.best = squared distance */
  function climb(x, z, i) {
    let dx = x - X[i], dz = z - Z[i];
    let best = dx * dx + dz * dz;
    for (let it = 0; it < 600; it++) {
      if (i + 1 < N) {
        dx = x - X[i + 1]; dz = z - Z[i + 1];
        const d = dx * dx + dz * dz;
        if (d < best) { best = d; i++; continue; }
      }
      if (i > 0) {
        dx = x - X[i - 1]; dz = z - Z[i - 1];
        const d = dx * dx + dz * dz;
        if (d < best) { best = d; i--; continue; }
      }
      break;
    }
    loc.best = best;
    return i;
  }

  /** Fill F with the closest-segment frame for point (x,z) given nearest sample i. */
  function frame(x, z, i, F) {
    let a, b;
    if (i < N - 1 && (i === 0 || (X[i + 1] - X[i]) * (x - X[i]) + (Z[i + 1] - Z[i]) * (z - Z[i]) > 0)) { a = i; b = i + 1; }
    else { a = i - 1; b = i; }
    const sx = X[b] - X[a], sz = Z[b] - Z[a];
    const l2 = sx * sx + sz * sz;
    let u = ((x - X[a]) * sx + (z - Z[a]) * sz) / l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const l = Math.sqrt(l2);
    const rx = -sz / l, rz = sx / l;
    F.a = a; F.u = u; F.rx = rx; F.rz = rz;
    F.lat = (x - (X[a] + sx * u)) * rx + (z - (Z[a] + sz * u)) * rz;
    F.slope = (Y[b] - Y[a]) / l;
    F.dx = sx / l; F.dz = sz / l;
    F.yc = Y[a] + (Y[b] - Y[a]) * u;
    F.yr = YREF[a] + (YREF[b] - YREF[a]) * u;
    F.hw = HW[a] + (HW[b] - HW[a]) * u;
    F.bank = BANK[a] + (BANK[b] - BANK[a]) * u;
    F.valley = VALLEY[a] + (VALLEY[b] - VALLEY[a]) * u;
    return F;
  }
  return { climb, frame, loc };
}

export function newFrame() {
  return { a: 0, u: 0, rx: 0, rz: 0, lat: 0, slope: 0, dx: 0, dz: 0, yc: 0, yr: 0, hw: 0, bank: 0, valley: 0 };
}
