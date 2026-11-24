// Combines what two or three phones each see into the tree's real 3D lean.
//
// Each phone looks at the tree from a different side and can only see the sideways part of the lean:
// how far the top is displaced to the right of the picture. If the tree's lean on the ground is the
// flat vector L (east, north) with length tan(theta), a phone facing compass heading h has "right"
// direction r = (cos h, -sin h), and sees  tan(alpha) = L . r.
// Two phones facing different ways give two such equations; three or more are solved by least squares.

export type View = { alpha: number; heading: number }; // alpha: degrees, + = top leans right; heading: compass degrees the camera faces

export type Combined = {
  ok: boolean;
  reason?: string;
  theta: number;        // total lean in degrees
  east: number; north: number; // lean vector, as tan(angle)
  compass: number;      // direction the top leans toward, degrees from north (magnetic)
  spread: number;       // widest angle between any two phones, degrees (0..180)
};

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Smallest angle between two headings, 0..180. */
export function headingGap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

export function solveLean(views: View[]): Combined {
  const fail = (reason: string, spread = 0): Combined => ({ ok: false, reason, theta: 0, east: 0, north: 0, compass: 0, spread });
  if (views.length < 2) return fail("Need a second phone");
  let spread = 0;
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) spread = Math.max(spread, Math.min(headingGap(views[i].heading, views[j].heading), 180));
  // a pair of views is only good when they look from clearly different sides (not 0 and not 180 apart)
  let good = false;
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
    const g = headingGap(views[i].heading, views[j].heading);
    if (g >= 35 && g <= 145) good = true;
  }
  if (!good) return fail("The phones are too close to the same line of sight. Move one a good way around the tree (about a quarter turn).", spread);
  // normal equations for [Lx, Ly]
  let a = 0, b = 0, c = 0, p = 0, q = 0;
  for (const v of views) {
    const rx = Math.cos(rad(v.heading)), ry = -Math.sin(rad(v.heading));
    const t = Math.tan(rad(v.alpha));
    a += rx * rx; b += rx * ry; c += ry * ry; p += rx * t; q += ry * t;
  }
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-6) return fail("The phones are too close to the same line of sight.", spread);
  const east = (c * p - b * q) / det, north = (a * q - b * p) / det;
  const theta = deg(Math.atan(Math.hypot(east, north)));
  const compass = (deg(Math.atan2(east, north)) + 360) % 360;
  return { ok: true, theta, east, north, compass, spread };
}

/** The same lean, split relative to one phone's view: how far to its right, and how far away from it. */
export function relativeTo(c: Combined, heading: number): { right: number; away: number } {
  const h = rad(heading);
  const right = c.east * Math.cos(h) - c.north * Math.sin(h);
  const away = c.east * Math.sin(h) + c.north * Math.cos(h);
  return { right: deg(Math.atan(right)), away: deg(Math.atan(away)) };
}

const NAMES = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
export function compassWord(h: number): string { return NAMES[Math.round((((h % 360) + 360) % 360) / 45) % 8]; }
