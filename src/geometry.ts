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
