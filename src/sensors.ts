import type { Vec3 } from "./geometry";

const BIAS_KEY = "treeplumb.bias.v1";

export class Sensors {
  /** Lightly smoothed accelerationIncludingGravity (raw, device axes). */
  accel: Vec3 | null = null;
  bias: Vec3 = { x: 0, y: 0, z: 0 };
  calibratedAt: number | null = null;
  active = false;
  /** Compass direction (degrees, clockwise from north) the back camera faces; null until known. */
  heading: number | null = null;
  private headingT = 0;
  private lastT = 0;
  private recent: Vec3[] = [];

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(BIAS_KEY) || "null");
      if (s && typeof s.x === "number") { this.bias = { x: s.x, y: s.y, z: s.z }; this.calibratedAt = s.t ?? null; }
    } catch { /* ignore */ }
  }

  /** Must be called from a tap on iPhone. Returns false if denied or unavailable. */
  async start(): Promise<boolean> {
    const DME = (window as any).DeviceMotionEvent;
    if (!DME) return false;
    const DOE = (window as any).DeviceOrientationEvent;
    if (typeof DME.requestPermission === "function") {
      // ask for both at once, while the tap is fresh (iPhone)
      const asks: Promise<string>[] = [DME.requestPermission()];
      if (DOE && typeof DOE.requestPermission === "function") asks.push(DOE.requestPermission().catch(() => "denied"));
      const [r] = await Promise.all(asks);
      if (r !== "granted") return false;
    }
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientationabsolute", this.onOrient as EventListener);
    window.addEventListener("deviceorientation", this.onOrient as EventListener);
    // wait briefly for a first real reading (desktop browsers fire one with nulls)
    await new Promise((res) => setTimeout(res, 700));
    this.active = this.accel !== null;
    return this.active;
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const v = { x: a.x, y: a.y, z: a.z };
    this.accel = this.accel ? lerp(this.accel, v, 0.25) : v; // light smoothing against hand shake
    this.recent.push(v);
    if (this.recent.length > 600) this.recent.shift();
    this.lastT = performance.now();
  };

  private onOrient = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading; // iPhone: already the direction the back camera faces when held upright
    } else if (e.alpha != null && e.beta != null && e.gamma != null && (e.absolute || e.type === "deviceorientationabsolute")) {
      // Android: work out where the back of the phone points from the three rotation angles
      const a = (e.alpha * Math.PI) / 180, b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
      const zx = Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g);
      const zy = Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g);
      h = ((Math.atan2(-zx, -zy) * 180) / Math.PI + 360) % 360;
    }
    if (h === null) return;
    if (this.heading === null || performance.now() - this.headingT > 2000) this.heading = h;
    else { const d = ((h - this.heading + 540) % 360) - 180; this.heading = (this.heading + d * 0.2 + 360) % 360; } // light smoothing around the circle
    this.headingT = performance.now();
  };
  get headingFresh(): number | null { return this.heading !== null && performance.now() - this.headingT < 2000 ? this.heading : null; }

  get fresh() { return this.accel !== null && performance.now() - this.lastT < 1000; }

  /**
   * Hold-still calibration: phone lying face up, flat, on a table. Gravity should then be
   * exactly along z, so any x/y reading is sensor offset. Takes about 2 s of readings.
   */
  async calibrateFlat(ms = 2000): Promise<{ ok: boolean; message: string }> {
    this.recent = [];
    await new Promise((r) => setTimeout(r, ms));
    const s = this.recent.slice();
    if (s.length < 10) return { ok: false, message: "No sensor readings came in." };
    const m = mean(s);
    const sd = Math.sqrt(s.reduce((t, v) => t + (v.x - m.x) ** 2 + (v.y - m.y) ** 2 + (v.z - m.z) ** 2, 0) / s.length);
    const g = Math.hypot(m.x, m.y, m.z);
    if (sd > 0.08) return { ok: false, message: "The phone moved. Lay it flat and keep still, then try again." };
    if (Math.abs(m.z) < g * 0.97) return { ok: false, message: "The phone isn't flat. Lay it flat on a table, screen facing up or down." };
    this.bias = { x: m.x, y: m.y, z: 0 };
    this.calibratedAt = Date.now();
    try { localStorage.setItem(BIAS_KEY, JSON.stringify({ ...this.bias, t: this.calibratedAt })); } catch { /* ignore */ }
    const tilt = (Math.atan2(Math.hypot(m.x, m.y), Math.abs(m.z)) * 180) / Math.PI;
    return { ok: true, message: `Calibrated. The offset was ${tilt.toFixed(2)}° (the table counts as level).` };
  }

  clearCalibration() {
    this.bias = { x: 0, y: 0, z: 0 }; this.calibratedAt = null;
    try { localStorage.removeItem(BIAS_KEY); } catch { /* ignore */ }
  }
}
function lerp(a: Vec3, b: Vec3, t: number): Vec3 { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }; }
function mean(s: Vec3[]): Vec3 { const n = s.length; return { x: s.reduce((t, v) => t + v.x, 0) / n, y: s.reduce((t, v) => t + v.y, 0) / n, z: s.reduce((t, v) => t + v.z, 0) / n }; }
