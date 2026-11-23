import { describe, expect, it } from "vitest";
import { downInCamera, fitCenterLine, focalPx, leanBetween, plumbDirectionAt, rotateForScreen, Smoother, upInDevice } from "../src/geometry";
import { sampleModel, segment } from "../src/segment";

const W = 144, H = 256;

/** Synthetic scene: grey wall, green cone tree whose axis is tilted `deg` from vertical (+ = top to the right),
 *  with red/yellow "ornaments" and a bright light string that break up the outline. */
function scene(deg: number, opts: { ornaments?: boolean; color?: [number, number, number]; bg?: [number, number, number]; seed?: number } = {}) {
  const color = opts.color ?? [30, 120, 40], bg = opts.bg ?? [170, 165, 160];
  const px = new Uint8ClampedArray(W * H * 4);
  const t = (deg * Math.PI) / 180;
  const baseX = W / 2, baseY = 235, height = 190, halfBase = 45;
  let s = opts.seed ?? 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // coordinates in the tree's own frame: a along the axis (up), b across
    const dx = x - baseX, dy = baseY - y;
    const a = dx * Math.sin(t) + dy * Math.cos(t);
    const b = dx * Math.cos(t) - dy * Math.sin(t);
    let c = bg;
    if (a >= 0 && a <= height && Math.abs(b) <= halfBase * (1 - a / height)) {
      c = color;
      if (opts.ornaments && rnd() < 0.05) c = rnd() < 0.5 ? [220, 30, 30] : [255, 240, 120];
    }
    const i = (y * W + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
  return px;
}
const straightDown = { x: 0, y: 1, z: 0 };
const leanOf = (seg: ReturnType<typeof segment>, down = straightDown) => {
  expect(seg.ok).toBe(true);
  const g = plumbDirectionAt({ x: seg.fit!.x0, y: seg.fit!.y0 }, down, W, H);
  return leanBetween(g, seg.fit!.dir);
};

describe("tree outline and lean", () => {
  it("reads a straight tree as ~0 degrees", () => {
    expect(Math.abs(leanOf(segment(scene(0), W, H, { kind: "green" })))).toBeLessThan(0.4);
  });
  for (const d of [-6, -2, 1, 3, 8]) {
    it(`reads a tree leaning ${d} degrees (right is positive)`, () => {
      expect(leanOf(segment(scene(d), W, H, { kind: "green" }))).toBeCloseTo(d, 0);
    });
  }
  it("survives ornaments and lights that are not green", () => {
    for (const seed of [1, 2, 3]) {
      const l = leanOf(segment(scene(3, { ornaments: true, seed }), W, H, { kind: "green" }));
      expect(Math.abs(l - 3)).toBeLessThan(0.8);
    }
  });
  it("works for a non-green (white) tree by tapping its colour", () => {
    const px = scene(-4, { color: [235, 235, 245], bg: [60, 70, 60] });
    const model = sampleModel(px, W, H, W / 2, 200);
    expect(Math.abs(leanOf(segment(px, W, H, model)) + 4)).toBeLessThan(0.8);
  });
  it("says so when there is no tree", () => {
    const px = scene(0, { color: [170, 165, 160] });
    expect(segment(px, W, H, { kind: "green" }).ok).toBe(false);
  });
});

describe("plumb line from the sensors", () => {
  it("phone upright: plumb is straight down the screen (either sign convention)", () => {
    for (const s of [1, -1]) {
      const down = downInCamera(upInDevice({ x: 0, y: 9.81 * s, z: 0 }));
      const g = plumbDirectionAt({ x: W / 2, y: H / 2 }, down, W, H);
      expect(g.x).toBeCloseTo(0, 6);
    }
  });
  it("phone rolled 5 degrees clockwise: plumb tilts down-right on screen, so a true-vertical tree reads 0", () => {
    const a = (5 * Math.PI) / 180;
    const up = upInDevice({ x: -9.81 * Math.sin(a), y: 9.81 * Math.cos(a), z: 0 });
    const g = plumbDirectionAt({ x: W / 2, y: H / 2 }, downInCamera(up), W, H);
    expect((Math.atan2(g.x, g.y) * 180) / Math.PI).toBeCloseTo(5, 3);
  });
  it("landscape rotation maps back to the same world", () => {
    // portrait reading rotated by 90 deg of screen should give an upright plumb when the device is turned
    const g = 9.81;
    const deviceLandscape = { x: g, y: 0, z: 0 }; // device turned so its +x edge points up
    const down = downInCamera(rotateForScreen(upInDevice({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), 90));
    expect(down).toBeDefined();
    // with +x up and screen angle 90, screen "up" is device +x: plumb must be straight down on screen
    const u = rotateForScreen(deviceLandscape, 90);
    expect(u.x).toBeCloseTo(0, 6);
    expect(u.y).toBeCloseTo(g, 6);
  });
  it("tilted up/down: converging verticals still read 0 lean (true perspective check)", () => {
    const f = focalPx(W, H);
    for (const pitch of [-35, -15, 15, 35]) {
      const b = (pitch * Math.PI) / 180;
      const down = { x: 0, y: Math.cos(b), z: -Math.sin(b) }; // camera pitched by b
      // a vertical pole 0.8 m to the right, 4 m away (along camera forward), project two points
      const proj = (t: number) => {
        const X = 0.8 + t * down.x, Y = 0.2 + t * down.y, Z = 4 + t * down.z;
        return { x: (f * X) / Z + W / 2, y: (f * Y) / Z + H / 2 };
      };
      const p1 = proj(-0.3), p2 = proj(0.3);
      const dirx = p2.x - p1.x, diry = p2.y - p1.y, n = Math.hypot(dirx, diry);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const lean = leanBetween(plumbDirectionAt(mid, down, W, H), { x: dirx / n, y: diry / n });
      expect(Math.abs(lean)).toBeLessThan(0.15);
    }
  });
});

describe("smoothing and fitting", () => {
  it("median over 2 s ignores a spike", () => {
    const s = new Smoother(2000);
    for (let i = 0; i < 20; i++) s.push(i * 100, i === 10 ? 9 : 1.0);
    expect(s.median).toBeCloseTo(1.0);
  });
  it("forgets readings older than the window", () => {
    const s = new Smoother(2000);
    s.push(0, 5); for (let i = 1; i <= 30; i++) s.push(i * 100, 1);
    expect(s.median).toBe(1);
  });
  it("line fit shrugs off outlier rows", () => {
    const ys = Array.from({ length: 60 }, (_, i) => i), xs = ys.map((y) => 50 + 0.1 * y);
    xs[5] = 90; xs[40] = 5;
    const f = fitCenterLine(ys, xs)!;
    expect(f.dir.x / f.dir.y).toBeCloseTo(0.1, 2);
  });
});

import { findBend } from "../src/geometry";
describe("bend detection", () => {
  const mk = (bendAt: number, upperDeg: number, noise = 0.6) => {
    const ys: number[] = [], xs: number[] = []; let s = 3;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
    for (let y = 40; y <= 220; y++) {
      const up = Math.max(0, bendAt - y);               // distance above the bend (smaller y = higher)
      ys.push(y); xs.push(72 + Math.tan((upperDeg * Math.PI) / 180) * up + rnd() * noise * 2);
    }
    return { ys, xs };
  };
  it("finds a bend where the top section tilts", () => {
    const { ys, xs } = mk(120, 4);
    const b = findBend(ys, xs)!;
    expect(b).not.toBeNull();
    expect(Math.abs(b.y - 120)).toBeLessThan(14);
  });
  it("reports no bend for one straight lean", () => {
    const { ys, xs } = mk(120, 0);
    expect(findBend(ys, xs)).toBeNull();
    const t = mk(300, 3); // bend far below the tree: one straight line
    expect(findBend(t.ys, t.xs)).toBeNull();
  });
});
