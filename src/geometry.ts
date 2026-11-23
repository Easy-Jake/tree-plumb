// Pure geometry: gravity from the phone's sensors -> where "straight down"
// points in the camera image -> how far a line in the image leans from it.

export type Vec3 = { x: number; y: number; z: number };
export type Vec2 = { x: number; y: number };

/** Assumed angle the longer side of the camera image spans. Phone main cameras are ~60-68. */
export const ASSUMED_LONG_SIDE_FOV_DEG = 65;

export function focalPx(w: number, h: number, fovDeg = ASSUMED_LONG_SIDE_FOV_DEG): number {
  return (Math.max(w, h) / 2) / Math.tan((fovDeg * Math.PI) / 360);
}

/**
 * Convert the raw "accelerationIncludingGravity" reading (device axes: x right,
 * y toward top edge, z out of the screen) into the *up* direction in the same axes.
 * Browsers disagree on the sign (iPhone vs Android), so we assume the phone is held
 * roughly upright (its long axis near vertical) and flip so that y is positive.
 */
export function upInDevice(a: Vec3, bias: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const v = { x: a.x - bias.x, y: a.y - bias.y, z: a.z - bias.z };
  const s = v.y < 0 ? -1 : 1;
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/** Rotate device-axes x/y into the screen's current orientation (0, 90, 180, 270). */
export function rotateForScreen(v: Vec3, angle: number): Vec3 {
  switch (((angle % 360) + 360) % 360) {
    case 90: return { x: -v.y, y: v.x, z: v.z };
    case 180: return { x: -v.x, y: -v.y, z: v.z };
    case 270: return { x: v.y, y: -v.x, z: v.z };
    default: return v;
  }
}

/** Direction of gravity (down) in camera axes: x right, y down, z forward (away from user). */
export function downInCamera(up: Vec3): Vec3 {
  // device (x right, y up, z toward user) -> camera (x right, y down, z forward)
  // down_device = -up; camera = (dx, -dy, -dz)
  return { x: -up.x, y: up.y, z: up.z };
}

/**
 * Image direction (unit, pointing "down" the picture) that a true vertical line has
 * at pixel p. With the phone tilted up or down, verticals converge toward a
 * vanishing point, so the correct plumb direction depends on where you look.
 */
export function plumbDirectionAt(p: Vec2, down: Vec3, w: number, h: number, f = focalPx(w, h)): Vec2 {
  const qx = (p.x - w / 2) / f;
  const qy = (p.y - h / 2) / f;
  let gx = down.x - qx * down.z;
  let gy = down.y - qy * down.z;
  const n = Math.hypot(gx, gy) || 1;
  gx /= n; gy /= n;
  if (gy < 0) { gx = -gx; gy = -gy; }
  return { x: gx, y: gy };
}

/** Phone roll/pitch in degrees, for display. */
export function tiltDegrees(up: Vec3): { roll: number; pitch: number } {
  return {
    roll: (Math.atan2(up.x, up.y) * 180) / Math.PI,
    pitch: (Math.atan2(up.z, Math.hypot(up.x, up.y)) * 180) / Math.PI,
  };
}

/** Signed angle in degrees from direction g to direction u (both pointing down the image).
 *  Positive = u's top end leans to the right of g's. */
export function leanBetween(g: Vec2, u: Vec2): number {
  const cross = g.x * u.y - g.y * u.x;
  const dot = g.x * u.x + g.y * u.y;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

export type Fit = { x0: number; y0: number; dir: Vec2; used: number };

/**
 * Robust straight-line fit x = a + b*y through row midpoints (trims outliers twice).
 * Returns the line's mean point and its direction pointing down the image.
 */
export function fitCenterLine(ys: number[], xs: number[]): Fit | null {
  let idx = ys.map((_, i) => i);
  if (idx.length < 6) return null;
  let a = 0, b = 0;
  for (let pass = 0; pass < 3; pass++) {
    const n = idx.length;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const i of idx) { sy += ys[i]; sx += xs[i]; syy += ys[i] * ys[i]; sxy += ys[i] * xs[i]; }
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-9) return null;
    b = (n * sxy - sx * sy) / den;
    a = (sx - b * sy) / n;
    if (pass === 2) break;
    const res = idx.map((i) => Math.abs(xs[i] - (a + b * ys[i])));
    const sorted = [...res].sort((p, q) => p - q);
    const mad = sorted[Math.floor(sorted.length / 2)] || 0;
    const lim = Math.max(1.5, 2.5 * 1.4826 * mad);
    const keep = idx.filter((i) => Math.abs(xs[i] - (a + b * ys[i])) <= lim);
    if (keep.length < 6) break;
    idx = keep;
  }
  let my = 0;
  for (const i of idx) my += ys[i];
  my /= idx.length;
  const n = Math.hypot(b, 1);
  return { x0: a + b * my, y0: my, dir: { x: b / n, y: 1 / n }, used: idx.length };
}

/** Rolling-window smoother: median of the last `windowMs` of readings, plus spread. */
export class Smoother {
  private pts: { t: number; v: number }[] = [];
  constructor(private windowMs = 2000) {}
  push(t: number, v: number) {
    this.pts.push({ t, v });
    while (this.pts.length && t - this.pts[0].t > this.windowMs) this.pts.shift();
  }
  clear() { this.pts = []; }
  get count() { return this.pts.length; }
  get median(): number | null {
    if (!this.pts.length) return null;
    return med(this.pts.map((p) => p.v));
  }
  /** Median absolute deviation: how jumpy the readings are, in the same units. */
  get spread(): number {
    const m = this.median;
    if (m === null) return 0;
    return med(this.pts.map((p) => Math.abs(p.v - m)));
  }
}
function med(a: number[]): number {
  const s = [...a].sort((p, q) => p - q);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export type Bend = {
  y: number;            // image row where the centre line changes direction
  fracUp: number;       // how far up the tree that is: 0 = bottom, 1 = top
  lower: Vec2;          // centre line direction below the bend (pointing down the image)
  upper: Vec2;          // centre line direction above the bend
  gain: number;         // how much better two pieces fit than one (0..1)
};

/**
 * Looks for one place where the tree's centre line changes direction (a section that isn't seated).
 * Fits a continuous two-piece line x = a + b*y + c*max(0, y - yb) for each candidate yb and keeps the best.
 * Returns null when one straight line is about as good, or the change in direction is tiny.
 */
export function findBend(ys: number[], xs: number[], minAngleDeg = 2.0): Bend | null {
  const n = ys.length;
  if (n < 30) return null;
  // light median filter so single odd rows (a branch tip, a person) don't make a fake bend
  const sx = xs.map((_, i) => med(xs.slice(Math.max(0, i - 2), Math.min(n, i + 3))));
  const y0 = ys[0], y1 = ys[n - 1], span = y1 - y0;
  if (span < 20) return null;
  const sse = (yb: number | null): { sse: number; b: number; c: number } | null => {
    // normal equations for [1, y, hinge]
    const k = yb === null ? 2 : 3;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const r = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const row = yb === null ? [1, ys[i] - y0] : [1, ys[i] - y0, Math.max(0, ys[i] - yb)];
      for (let p = 0; p < k; p++) { r[p] += row[p] * sx[i]; for (let q = 0; q < k; q++) A[p][q] += row[p] * row[q]; }
    }
    const sol = solve(A, r);
    if (!sol) return null;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const row = yb === null ? [1, ys[i] - y0] : [1, ys[i] - y0, Math.max(0, ys[i] - yb)];
      const d = sx[i] - row.reduce((s, v, p) => s + v * sol[p], 0);
      e += d * d;
    }
    return { sse: e, b: sol[1], c: yb === null ? 0 : sol[2] };
  };
  const one = sse(null);
  if (!one || one.sse < 1e-6) return null;
  let best: { yb: number; sse: number; b: number; c: number } | null = null;
  for (let f = 0.25; f <= 0.7501; f += 0.025) { // keep both pieces long enough to mean something; the bottom is mostly skirt and wide lower branches
    const yb = y0 + span * f;
    const s = sse(yb);
    if (s && (!best || s.sse < best.sse)) best = { yb, ...s };
  }
  if (!best) return null;
  const gain = 1 - best.sse / one.sse;
  const upperSlope = best.b, lowerSlope = best.b + best.c;
  const angle = Math.abs(Math.atan(lowerSlope) - Math.atan(upperSlope)) * 180 / Math.PI;
  if (gain < 0.5 || angle < minAngleDeg) return null;
  const nv = (s: number): Vec2 => { const m = Math.hypot(s, 1); return { x: s / m, y: 1 / m }; };
  return { y: best.yb, fracUp: 1 - (best.yb - y0) / span, lower: nv(lowerSlope), upper: nv(upperSlope), gain };
}

function solve(A: number[][], r: number[]): number[] | null {
  const k = r.length;
  const M = A.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let i = c + 1; i < k; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = 0; i < k; i++) if (i !== c) { const f = M[i][c] / M[c][c]; for (let j = c; j <= k; j++) M[i][j] -= f * M[c][j]; }
  }
  return M.map((row, i) => row[k] / row[i]);
}
