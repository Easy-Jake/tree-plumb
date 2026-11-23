import { downInCamera, leanBetween, plumbDirectionAt, rotateForScreen, Smoother, tiltDegrees, upInDevice, type Vec3 } from "./geometry";
import { FilesetResolver, InteractiveSegmenterLegacy } from "@mediapipe/tasks-vision";
import { analyzeMask, sampleModel, segment, type ColorModel, type Segmentation } from "./segment";
import { Sensors } from "./sensors";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const overlay = $<HTMLCanvasElement>("overlay");
const octx = overlay.getContext("2d")!;
const degEl = $("deg"), dirEl = $("dir"), hintEl = $("hint"), statusEl = $("status"), msgEl = $("msg");

const sensors = new Sensors();
const smoother = new Smoother(2000);
const bendY = new Smoother(2500), bendLow = new Smoother(2500), bendUp = new Smoother(2500);
let bendSeen = new Smoother(2500); // 1 = a bend was found this frame, 0 = not
const small = document.createElement("canvas");
const sctx = small.getContext("2d", { willReadFrequently: true })!;

let model: ColorModel = { kind: "green" };
// Smart mode: a small on-phone model cuts out whatever is at the tapped point (starts at the middle of the picture).
// It copes with decorated trees, where plain colour matching does not.
let useModel = true;
let ml: InteractiveSegmenterLegacy | null = null;
let mlState: "loading" | "ready" | "failed" = "loading";
let mlBusy = false;
let mlSeg: Segmentation | null = null;
let aim = { x: 0.5, y: 0.58 };
const mlCanvas = document.createElement("canvas");
const mctx = mlCanvas.getContext("2d")!;
async function loadModel() {
  try {
    const fs = await FilesetResolver.forVisionTasks("wasm");
    ml = await InteractiveSegmenterLegacy.createFromOptions(fs, {
      baseOptions: { modelAssetPath: "models/magic_touch.tflite" },
      outputConfidenceMasks: true, outputCategoryMask: false,
    });
    mlState = "ready";
  } catch (e) { mlState = "failed"; useModel = false; syncModeButton(); }
}
function syncModeButton() { $("auto").textContent = useModel ? "Smart find" : "Green tree"; $("auto").classList.toggle("on", useModel); }
function runModel() {
  if (!ml || mlBusy || !video.videoWidth) return;
  mlBusy = true;
  const vw = video.videoWidth, vh = video.videoHeight, long = 448;
  const cw = vw >= vh ? long : Math.round((long * vw) / vh), ch = vw >= vh ? Math.round((long * vh) / vw) : long;
  if (mlCanvas.width !== cw || mlCanvas.height !== ch) { mlCanvas.width = cw; mlCanvas.height = ch; }
  mctx.drawImage(video, 0, 0, cw, ch);
  try {
    ml.segment(mlCanvas, { keypoint: { x: aim.x, y: aim.y } }, (r) => {
      try {
        const m = r.confidenceMasks?.[0];
        if (m) {
          const a = m.getAsFloat32Array(), w = m.width, h = m.height;
          const mask = new Uint8Array(w * h);
          let n = 0;
          for (let i = 0; i < a.length; i++) if (a[i] > 0.5) { mask[i] = 1; n++; }
          mlSeg = n ? analyzeMask(mask, n, w, h) : { w, h, mask, rows: [], fit: null, top: 0, bottom: 0, coverage: 0, ok: false, reason: "Nothing found there. Tap the tree" };
        }
      } finally { mlBusy = false; }
    });
  } catch { mlBusy = false; mlState = "failed"; useModel = false; syncModeButton(); }
}
let showMask = false;
let busy = false; // calibrating
let lastRgba: Uint8ClampedArray | null = null;
let aw = 0, ah = 0;
let lastFrameT = 0, fps = 0;

$("start").addEventListener("click", start);
$("cal").addEventListener("click", calibrate);
$("auto").addEventListener("click", () => {
  if (mlState === "failed") { flash("Smart find isn't available on this phone"); return; }
  useModel = !useModel; model = { kind: "green" }; mlSeg = null; smoother.clear(); syncModeButton();
  flash(useModel ? "Smart find: tap the tree if it picks the wrong thing" : "Looking for a green tree. Tap it to learn its colour");
});
syncModeButton();
loadModel();
$("maskBtn").addEventListener("click", () => { showMask = !showMask; $("maskBtn").classList.toggle("on", showMask); });
$("frame").addEventListener("click", (e) => {
  if (!lastRgba || !aw) return;
  const r = overlay.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * aw);
  const y = Math.round(((e.clientY - r.top) / r.height) * ah);
  smoother.clear();
  if (useModel) {
    aim = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    mlSeg = null;
    flash("Looking at what you tapped");
    return;
  }
  model = sampleModel(lastRgba, aw, ah, x, y);
  flash("Learned the tree's colour");
});

async function start() {
  const err = $("err");
  err.textContent = "";
  if (!window.isSecureContext) { err.textContent = "This page needs https:// to use the camera and motion sensors."; return; }
  if (!navigator.mediaDevices?.getUserMedia) { err.textContent = "This browser can't use the camera."; return; }
  // Motion permission first, while the tap is still fresh (iPhone requires this).
  let motionOk = false;
  try { motionOk = await sensors.start(); } catch { motionOk = false; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    err.textContent = "Couldn't open the camera. Allow camera access for this site and try again.";
    return;
  }
  $("splash").style.display = "none";
  if (!motionOk) hint("No motion sensor available. Lean is measured against the screen's up, not true plumb. Hold the phone very straight.", 8000);
  requestAnimationFrame(loop);
}

function flash(text: string) { msgEl.textContent = text; msgEl.style.display = "flex"; msgEl.style.background = "rgba(0,0,0,.35)"; setTimeout(() => { if (!busy) msgEl.style.display = "none"; }, 900); }
let hintTimer = 0;
function hint(t: string, ms = 0) { hintEl.textContent = t; clearTimeout(hintTimer); if (ms) hintTimer = window.setTimeout(() => (hintEl.textContent = ""), ms); }

async function calibrate() {
  if (!sensors.active) { flash("No motion sensor to calibrate"); return; }
  busy = true;
  msgEl.style.background = "rgba(0,0,0,.8)"; msgEl.style.display = "flex";
  for (let i = 5; i > 0; i--) { msgEl.textContent = `Lay the phone flat on a table, screen up. Starting in ${i}`; await sleep(1000); }
  msgEl.textContent = "Hold still...";
  const r = await sensors.calibrateFlat(2000);
  msgEl.textContent = r.message + "  Pick the phone back up.";
  await sleep(2500);
  busy = false; msgEl.style.display = "none";
  smoother.clear();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gravityDown(): Vec3 | null {
  if (!sensors.active || !sensors.accel || !sensors.fresh) return null;
  const up = upInDevice(sensors.accel, sensors.bias);
  const angle = (screen.orientation && screen.orientation.angle) || 0;
  return downInCamera(rotateForScreen(up, angle));
}

function loop(t: number) {
  requestAnimationFrame(loop);
  if (t - lastFrameT < 80 || !video.videoWidth || busy) return; // ~12 analyses per second
  fps = 0.8 * fps + 0.2 * (1000 / (t - lastFrameT));
  lastFrameT = t;

  const vw = video.videoWidth, vh = video.videoHeight;
  // keep the overlay exactly on top of the (letterboxed) video picture
  const fitScale = Math.min(innerWidth / vw, innerHeight / vh);
  const frame = $("frame");
  frame.style.width = Math.round(vw * fitScale) + "px";
  frame.style.height = Math.round(vh * fitScale) + "px";
  const long = 256;
  const na = vw >= vh ? [long, Math.round((long * vh) / vw)] : [Math.round((long * vw) / vh), long];
  if (na[0] !== aw || na[1] !== ah) { aw = na[0]; ah = na[1]; small.width = aw; small.height = ah; }
  sctx.drawImage(video, 0, 0, aw, ah);
  const img = sctx.getImageData(0, 0, aw, ah);
  lastRgba = img.data;
  let seg: Segmentation;
  if (useModel) {
    runModel();
    seg = mlSeg ?? { w: aw, h: ah, mask: new Uint8Array(0), rows: [], fit: null, top: 0, bottom: 0, coverage: 0, ok: false,
      reason: mlState === "loading" ? "Loading the tree finder (first time takes a moment)..." : "Looking for the tree..." };
  } else seg = segment(img.data, aw, ah, model);
  const sw = useModel && mlSeg ? mlSeg.w : aw, sh = useModel && mlSeg ? mlSeg.h : ah;

  const gdown = gravityDown();
  const down: Vec3 = gdown ?? { x: 0, y: 1, z: 0 };
  let lean: number | null = null;
  let plumbDir = { x: 0, y: 1 };
  if (seg.ok && seg.fit) {
    plumbDir = plumbDirectionAt({ x: seg.fit.x0, y: seg.fit.y0 }, down, sw, sh);
    lean = leanBetween(plumbDir, seg.fit.dir);
    smoother.push(t, lean);
    if (seg.bend) {
      bendSeen.push(t, 1);
      bendY.push(t, seg.bend.y);
      bendLow.push(t, leanBetween(plumbDir, seg.bend.lower));
      bendUp.push(t, leanBetween(plumbDir, seg.bend.upper));
    } else bendSeen.push(t, 0);
  } else {
    smoother.clear(); bendY.clear(); bendLow.clear(); bendUp.clear(); bendSeen.clear();
  }
  draw(seg, down);
  updateReadout(seg, gdown);
}

function updateReadout(seg: Segmentation, gdown: Vec3 | null) {
  const m = smoother.median;
  if (m === null || smoother.count < 5) {
    degEl.textContent = "--"; dirEl.textContent = ""; degEl.style.color = "#fff";
    hint(seg.reason ?? "Reading...");
  } else {
    const a = Math.abs(m);
    degEl.textContent = a.toFixed(1) + "°";
    dirEl.textContent = a < 0.05 ? "straight" : m > 0 ? "leaning right →" : "← leaning left";
    degEl.style.color = a < 0.5 ? "#4cff8a" : a < 1.5 ? "#ffd84c" : "#ff6b5c";
    const steady = smoother.spread < 0.25 && smoother.count > 12;
    const bent = bendSeen.count > 8 && (bendSeen.median ?? 0) > 0.5 && bendY.count > 4;
    if (!steady) hint("Settling... hold still");
    else if (bent) {
      const pct = Math.round(Math.min(1, Math.max(0, (seg.bottom - (bendY.median ?? 0)) / Math.max(1, seg.bottom - seg.top))) * 100), lo = bendLow.median ?? 0, up = bendUp.median ?? 0;
      const side = (v: number) => (Math.abs(v) < 0.05 ? "straight" : Math.abs(v).toFixed(1) + "° " + (v > 0 ? "right" : "left"));
      hint(`Bends about ${pct}% of the way up. Below it: ${side(lo)}. Above it: ${side(up)}. Seen from this side only.`);
    } else if (bendSeen.count > 8) hint("One smooth lean, no bend found. Seen from this side only.");
    else hint("Steady. As seen from this side only.");
  }
  const parts: string[] = [];
  if (gdown) {
    const up = upInDevice(sensors.accel!, sensors.bias);
    const t = tiltDegrees(up);
    parts.push(`phone tilt ${t.roll.toFixed(1)}° side, ${t.pitch.toFixed(0)}° up/down`);
    parts.push(sensors.calibratedAt ? "calibrated" : "not calibrated");
  } else parts.push("no sensor");
  parts.push(useModel ? "smart find" : model.kind === "green" ? "green mode" : "tapped colour");
  parts.push(fps.toFixed(0) + " fps");
  statusEl.textContent = parts.join(" · ");
}

function draw(seg: Segmentation, down: Vec3) {
  const r = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (overlay.width !== Math.round(r.width * dpr)) { overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr); }
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const gw = seg.w, gh = seg.h;
  const sx = W / gw, sy = H / gh;

  if (showMask && seg.mask) {
    octx.fillStyle = "rgba(60,255,120,0.35)";
    for (const row of seg.rows) octx.fillRect(row.left * sx, row.y * sy, (row.right - row.left) * sx, sy + 1);
  }
  octx.lineWidth = Math.max(2, 2 * dpr);
  // true plumb line: through the middle of the picture (or the tree), following gravity
  const px = seg.ok && seg.fit ? seg.fit.x0 : gw / 2, py = seg.ok && seg.fit ? seg.fit.y0 : gh / 2;
  const g = plumbDirectionAt({ x: px, y: py }, down, gw, gh);
  octx.strokeStyle = "rgba(90,200,255,0.95)";
  octx.setLineDash([10 * dpr, 6 * dpr]);
  line(px - g.x * gh * 2, py - g.y * gh * 2, px + g.x * gh * 2, py + g.y * gh * 2, sx, sy);
  octx.setLineDash([]);
  if (seg.ok && seg.fit && seg.bend && (bendSeen.median ?? 0) > 0.5 && bendY.median !== null) {
    // marker at the smoothed bend height
    const yb = bendY.median;
    const f = seg.fit, xb = f.x0 + (f.dir.x / f.dir.y) * (yb - f.y0);
    octx.strokeStyle = "rgba(255,70,200,0.95)"; octx.lineWidth = Math.max(3, 3 * dpr);
    line(xb - 40, yb, xb + 40, yb, sx, sy);
    octx.lineWidth = Math.max(2, 2 * dpr);
  }
  if (seg.ok && seg.fit) {
    const f = seg.fit, span = Math.max(1, seg.bottom - seg.top);
    const yTop = seg.top, yBot = seg.bottom;
    const xAt = (y: number) => f.x0 + (f.dir.x / f.dir.y) * (y - f.y0);
    octx.strokeStyle = "rgba(255,170,40,0.95)";
    line(xAt(yTop - span * 0.05), yTop - span * 0.05, xAt(yBot), yBot, sx, sy);
  }
}
function line(x1: number, y1: number, x2: number, y2: number, sx: number, sy: number) {
  octx.beginPath(); octx.moveTo(x1 * sx, y1 * sy); octx.lineTo(x2 * sx, y2 * sy); octx.stroke();
}
