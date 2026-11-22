// Finds the tree's outline in a small RGBA frame with plain colour matching: no
// downloads, no model, a few milliseconds per frame on a phone. Two modes:
//   "green":  anything green (a normal tree, real or artificial)
//   "sample": colours close to a patch the user tapped (flocked, white, blue trees)
import { fitCenterLine, type Fit } from "./geometry";

export type ColorModel =
  | { kind: "green" }
  | { kind: "sample"; y: number; cb: number; cr: number; tol: number };

export type Segmentation = {
  w: number; h: number;
  mask: Uint8Array;       // 1 = tree (largest blob only)
  rows: { y: number; left: number; right: number }[];
  fit: Fit | null;
  top: number; bottom: number; // blob extent (rows)
  coverage: number;       // fraction of the frame that is tree
  ok: boolean;
  reason?: string;
};

function ycc(r: number, g: number, b: number) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  };
}

export function sampleModel(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, cx: number, cy: number, tightness = 1): ColorModel {
  const r = 3;
  let n = 0, sy = 0, scb = 0, scr = 0;
  const vals: { y: number; cb: number; cr: number }[] = [];
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const i = (y * w + x) * 4;
      const c = ycc(rgba[i], rgba[i + 1], rgba[i + 2]);
      vals.push(c); sy += c.y; scb += c.cb; scr += c.cr; n++;
    }
  const m = { y: sy / n, cb: scb / n, cr: scr / n };
  let v = 0;
  for (const c of vals) v += (c.cb - m.cb) ** 2 + (c.cr - m.cr) ** 2 + 0.25 * (c.y - m.y) ** 2;
  const sd = Math.sqrt(v / n);
  return { kind: "sample", ...m, tol: (Math.max(10, sd * 3) + 12) * tightness };
}

function isTree(model: ColorModel, r: number, g: number, b: number): boolean {
  if (model.kind === "green") {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 25 || g < r * 1.05 || g < b * 1.05) return false;
    return (mx - mn) / mx > 0.22;
  }
  const c = ycc(r, g, b);
  const d = Math.sqrt((c.cb - model.cb) ** 2 + (c.cr - model.cr) ** 2 + 0.25 * (c.y - model.y) ** 2);
  return d < model.tol;
}

export function segment(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, model: ColorModel): Segmentation {
  const n = w * h;
  let raw: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = isTree(model, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) ? 1 : 0;

  raw = dilate(erode(raw, w, h), w, h); // opening: drops specks and hairline links

  // largest connected blob
  const label = new Int32Array(n);
  const stack: number[] = [];
  let best = 0, bestId = 0, id = 0;
  for (let s = 0; s < n; s++) {
    if (!raw[s] || label[s]) continue;
    id++; let size = 0; stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop()!; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && raw[p - 1] && !label[p - 1]) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && raw[p + 1] && !label[p + 1]) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && raw[p - w] && !label[p - w]) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && raw[p + w] && !label[p + w]) { label[p + w] = id; stack.push(p + w); }
    }
    if (size > best) { best = size; bestId = id; }
  }
  const mask = new Uint8Array(n);
  const blank = (reason: string): Segmentation => ({ w, h, mask, rows: [], fit: null, top: 0, bottom: 0, coverage: 0, ok: false, reason });
  if (!bestId) return blank("No tree-coloured area found");
  for (let i = 0; i < n; i++) mask[i] = label[i] === bestId ? 1 : 0;

  return analyzeMask(mask, best, w, h);
}

/** Outline, centre line and sanity checks for a finished tree mask (shared by colour and model modes). */
export function analyzeMask(mask: Uint8Array, best: number, w: number, h: number): Segmentation {
  const n = w * h;
  const blank = (reason: string): Segmentation => ({ w, h, mask, rows: [], fit: null, top: 0, bottom: 0, coverage: 0, ok: false, reason });
  // per-row outer edges: ornaments and lights inside the tree don't matter, only the outline
  const rows: Segmentation["rows"] = [];
  let top = h, bottom = -1;
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { rows.push({ y, left: l, right: r + 1 }); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  const coverage = best / n;
  const height = bottom - top + 1;
  if (height < h * 0.3) return { ...blank("Tree looks too small. Step closer, or tap it to pick its colour"), rows, top, bottom, coverage };
  if (coverage > 0.85) return { ...blank("Whole picture matches. Tap the tree to pick its colour"), rows, top, bottom, coverage };

  // ignore the tip and the stand/base; fit the axis through the rest
  const y0 = top + height * 0.1, y1 = bottom - height * 0.08;
  const ys: number[] = [], xs: number[] = [];
  for (const r of rows) if (r.y >= y0 && r.y <= y1 && r.right - r.left >= 3) { ys.push(r.y + 0.5); xs.push((r.left + r.right) / 2); }
  const fit = fitCenterLine(ys, xs);
  return { w, h, mask, rows, fit, top, bottom, coverage, ok: !!fit, reason: fit ? undefined : "Couldn't trace the centre line" };
}

function erode(a: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(a.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    o[p] = a[p] && a[p - 1] && a[p + 1] && a[p - w] && a[p + w] ? 1 : 0;
  }
  return o;
}
function dilate(a: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    o[p] = a[p] || (x > 0 && a[p - 1]) || (x < w - 1 && a[p + 1]) || (y > 0 && a[p - w]) || (y < h - 1 && a[p + w]) ? 1 : 0;
  }
  return o;
}
