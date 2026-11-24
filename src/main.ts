import { downInCamera, leanBetween, plumbDirectionAt, rotateForScreen, Smoother, tiltDegrees, upInDevice, type Vec3 } from "./geometry";
import { FilesetResolver, InteractiveSegmenterLegacy } from "@mediapipe/tasks-vision";
import { analyzeMask, sampleModel, segment, type ColorModel, type Segmentation } from "./segment";
import { Sensors } from "./sensors";
import { Team, type ViewMsg } from "./session";
import { relativeTo, solveLean } from "./combine";

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

// Photos: saved automatically once the reading has held steady for a few seconds, and again after the
// tree is adjusted and settles on a new reading, so nobody has to touch the phone.
type Photo = { url: string; text: string; time: Date };
// Photos are kept on the phone (IndexedDB) so they survive closing the page. Nothing is uploaded.
const dbp: Promise<IDBDatabase | null> = new Promise((res) => {
  try {
    const rq = indexedDB.open("erection-correction", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("photos", { keyPath: "id" });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  } catch { res(null); }
});
async function dbSave(id: number, blob: Blob, text: string) {
  const db = await dbp; if (!db) return;
  try { db.transaction("photos", "readwrite").objectStore("photos").put({ id, blob, text }); } catch { /* storage full or blocked */ }
}
async function dbLoad() {
  const db = await dbp; if (!db) return;
  const rq = db.transaction("photos").objectStore("photos").getAll();
  rq.onsuccess = () => {
    const rows = (rq.result as { id: number; blob: Blob; text: string }[]).sort((a, b) => b.id - a.id);
    for (const r of rows) if (!photos.some((p) => p.time.getTime() === r.id)) photos.push({ url: URL.createObjectURL(r.blob), text: r.text, time: new Date(r.id) });
    photos.sort((a, b) => b.time.getTime() - a.time.getTime());
    $("photos").textContent = `Photos (${photos.length})`;
  };
}
async function dbDelete(id: number) {
  const db = await dbp; if (!db) return;
  try { db.transaction("photos", "readwrite").objectStore("photos").delete(id); } catch { /* ignore */ }
}
const photos: Photo[] = [];
let autoPhoto = true;
let steadySince = 0;
let lastShotDeg: number | null = null;
let lastShotAt = 0;
let lastHint = "";
let takePhotoSoon: { deg: number; label: string } | null = null;
function takePhoto(deg: number, label: string): void {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const c = document.createElement("canvas");
  c.width = vw; c.height = vh;
  const x = c.getContext("2d")!;
  x.drawImage(video, 0, 0, vw, vh);
  x.drawImage(overlay, 0, 0, vw, vh);
  const fs = Math.round(vw / 9);
  x.textAlign = "center"; x.lineJoin = "round";
  const say = (t: string, y: number, size: number, color: string) => {
    x.font = `800 ${size}px system-ui, sans-serif`; x.lineWidth = size / 6; x.strokeStyle = "rgba(0,0,0,.75)"; x.fillStyle = color;
    x.strokeText(t, vw / 2, y); x.fillText(t, vw / 2, y);
  };
  say(label, fs * 1.2, fs, Math.abs(deg) < 0.5 ? "#4cff8a" : Math.abs(deg) < 1.5 ? "#ffd84c" : "#ff6b5c");
  x.font = `600 ${Math.round(fs / 3)}px system-ui, sans-serif`; x.lineWidth = fs / 14;
  const small = Math.round(fs / 3);
  wrap(lastHint, vw * 0.92, x).forEach((ln, i) => say(ln, fs * 1.2 + small * 1.5 * (i + 1), small, "#fff"));
  c.toBlob((b) => {
    if (!b) return;
    const time = new Date(), text = `${label}${lastHint ? " · " + lastHint : ""}`;
    photos.unshift({ url: URL.createObjectURL(b), text, time });
    void dbSave(time.getTime(), b, text);
    $("photos").textContent = `Photos (${photos.length})`;
    flash(`Photo ${photos.length} saved`);
    renderGallery();
  }, "image/jpeg", 0.9);
}
function wrap(text: string, maxW: number, x: CanvasRenderingContext2D): string[] {
  const words = text.split(" "), lines: string[] = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (x.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}
function renderGallery() {
  const list = $("galleryList");
  list.innerHTML = "";
  if (!photos.length) { list.innerHTML = '<div class="empty">Nothing yet. Photos are taken by themselves when the reading holds steady for a few seconds.</div>'; return; }
  for (const p of photos) {
    const wrapEl = document.createElement("div");
    const cap = document.createElement("div"); cap.className = "cap"; cap.textContent = p.time.toLocaleTimeString() + " · " + p.text;
    const img = document.createElement("img"); img.src = p.url;
    const btn = document.createElement("button"); btn.textContent = "Save / share";
    btn.onclick = async () => {
      try {
        const blob = await (await fetch(p.url)).blob();
        const file = new File([blob], `erection-correction-${p.time.getTime()}.jpg`, { type: "image/jpeg" });
        if ((navigator as any).canShare?.({ files: [file] })) await (navigator as any).share({ files: [file] });
        else flash("Press and hold the picture, then choose Save to Photos");
      } catch { /* share cancelled */ }
    };
    const del = document.createElement("button"); del.textContent = "Delete"; del.style.marginLeft = "8px";
    del.onclick = () => { if (!confirm("Delete this photo from the phone?")) return; photos.splice(photos.indexOf(p), 1); void dbDelete(p.time.getTime()); $("photos").textContent = `Photos (${photos.length})`; renderGallery(); };
    wrapEl.append(cap, img, btn, del); list.append(wrapEl);
  }
}
void dbLoad();
$("photos").addEventListener("click", () => { renderGallery(); $("gallery").style.display = "flex"; });
$("closeGallery").addEventListener("click", () => { $("gallery").style.display = "none"; });
$("autoPhoto").addEventListener("click", () => { autoPhoto = !autoPhoto; $("autoPhoto").classList.toggle("on", autoPhoto); flash(autoPhoto ? "Photos will be taken by themselves" : "Automatic photos off"); });

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


// ---- Together: two or three phones combine into the tree's real 3D lean ----
const team = new Team();
const joinId = new URLSearchParams(location.hash.slice(1)).get("join");
if (joinId) $("joinNote").style.display = "block";
let bendFrac: number | null = null;
let lockedSince = 0, locked = false;
let teamLines: string[] = [], teamOk = false;
function ownView(): ViewMsg {
  const m = smoother.median;
  const alpha = m !== null && smoother.count >= 5 ? m : null;
  const bend = alpha !== null && (bendSeen.median ?? 0) > 0.5 && bendFrac !== null && bendLow.median !== null && bendUp.median !== null
    ? { frac: bendFrac, low: bendLow.median, up: bendUp.median } : null;
  return { k: "view", alpha, heading: sensors.headingFresh, bend };
}
const side = (v: number, pos: string, neg: string) => (Math.abs(v) < 0.05 ? "no" : Math.abs(v).toFixed(1) + "° " + (v > 0 ? pos : neg));
function hostCompute() {
  const me = ownView();
  const live = team.live();
  teamOk = false;
  if (!team.connected) { teamLines = ["Waiting for another phone to join"]; return; }
  type V = { alpha: number; heading: number; bend: ViewMsg["bend"] };
  const views: V[] = [];
  const notes: string[] = [];
  if (me.alpha !== null && me.heading !== null) views.push({ alpha: me.alpha, heading: me.heading, bend: me.bend });
  else notes.push(me.heading === null ? "This phone isn't giving a compass direction yet" : "This phone has no reading yet. Point it at the tree");
  for (const p of live) {
    if (p.view.alpha !== null && p.view.heading !== null) views.push({ alpha: p.view.alpha, heading: p.view.heading, bend: p.view.bend });
    else notes.push(`${p.name} ${p.view.heading === null ? "has no compass direction" : "has no reading yet"}`);
  }
  if (views.length < 2) { teamLines = notes.length ? notes : ["Waiting for a second reading"]; return; }
  const c = solveLean(views);
  if (!c.ok) { teamLines = [c.reason ?? "Can't combine yet", ...notes]; return; }
  teamOk = true;
  const rel = relativeTo(c, views[0].heading);
  const lines = [`Tree leans ${c.theta.toFixed(1)}°`, `${side(rel.right, "to the right", "to the left")} and ${side(rel.away, "away from", "toward")} the host phone`];
  const bv = views.filter((v) => v.bend);
  if (bv.length >= 2) {
    const lo = solveLean(bv.map((v) => ({ alpha: v.bend!.low, heading: v.heading })));
    const up = solveLean(bv.map((v) => ({ alpha: v.bend!.up, heading: v.heading })));
    const frac = bv.reduce((t, v) => t + v.bend!.frac, 0) / bv.length;
    if (lo.ok && up.ok) lines.push(`Bends about ${Math.round(frac * 100)}% of the way up: ${lo.theta.toFixed(1)}° below, ${up.theta.toFixed(1)}° above`);
  }
  if (c.spread < 55) lines.push("Tip: move a phone further around the tree (about a quarter turn) for a better reading");
  teamLines = [...lines, ...notes];
  // locked: under half a degree, held for 3 seconds
  const now = performance.now();
  if (c.theta < 0.5) {
    if (!lockedSince) lockedSince = now;
    if (!locked && now - lockedSince >= 3000) { locked = true; lastHint = lines.slice(0, 2).join(" · "); takePhoto(c.theta, `LOCKED ${c.theta.toFixed(1)}°`); }
  } else if (c.theta > 0.8) { lockedSince = 0; locked = false; }
}
function renderTeamBanner() {
  const el = $("team");
  let lines: string[] = [], isLocked = false, ok = false;
  if (team.role === "host") { lines = teamLines; isLocked = locked; ok = teamOk; }
  else if (team.role === "helper") {
    const r = team.hostResult;
    if (r && performance.now() - team.hostResultAt < 4000) { lines = r.lines; isLocked = r.locked; ok = r.ok; } else lines = [team.status || "Connecting..."];
  } else { el.style.display = "none"; return; }
  el.style.display = "block";
  el.textContent = "";
  const theta = ok ? parseFloat((lines[0] ?? "").replace(/[^0-9.]/g, "")) : NaN;
  const col = isLocked ? "#4cff8a" : isNaN(theta) ? "#fff" : theta < 0.5 ? "#4cff8a" : theta < 1.5 ? "#ffd84c" : "#ff6b5c";
  const add = (text: string, cls: string, color?: string) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; if (color) d.style.color = color; el.append(d); };
  if (isLocked) add("LOCKED ✓", "big", "#4cff8a");
  lines.forEach((l, i) => add(l, i === 0 ? "big" : "sm", i === 0 ? col : undefined));
}
const qrCanvas = document.createElement("canvas");
let qrFor = "";
function renderTeamPanel() {
  if ($("teamPanel").style.display !== "flex") return;
  const body = $("teamBody");
  body.textContent = "";
  const add = (tag: string, text: string, cls = "") => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; body.append(e); return e; };
  if (team.role === "none") {
    add("div", "Use two or three phones at once to get the tree's real lean in every direction, and where it bends.");
    add("div", "Put one phone on each of two sides of the tree, about a quarter turn apart, both pointed at the tree. Every phone needs this page open.");
    const b = add("button", "Host a session (this phone)") as HTMLButtonElement;
    b.onclick = async () => { try { await team.host(); } catch { /* status shows */ } renderTeamPanel(); };
    add("div", "To join someone else's session, scan the code on their phone with your camera.", "url");
    if (team.status) add("div", team.status);
    return;
  }
  if (team.role === "host") {
    if (team.joinUrl) {
      add("div", "Have the other phones scan this with their camera:");
      body.append(qrCanvas); if (qrFor !== team.joinUrl) { qrFor = team.joinUrl; void team.qr(qrCanvas); }
      add("div", team.joinUrl, "url");
      const sh = add("button", "Share the link instead") as HTMLButtonElement;
      sh.onclick = () => { if ((navigator as any).share) (navigator as any).share({ url: team.joinUrl, title: "Join my tree session" }).catch(() => {}); else navigator.clipboard?.writeText(team.joinUrl); flash("Link ready to paste"); };
    }
    add("div", team.status);
    const hd = sensors.headingFresh;
    add("div", `You (Phone 1): reading ${ownView().alpha?.toFixed(1) ?? "none yet"}°, compass ${hd === null ? "none" : Math.round(hd) + "°"}`, "phone");
    for (const p of team.live(8000)) add("div", `${p.name}: reading ${p.view.alpha?.toFixed(1) ?? "none yet"}°, compass ${p.view.heading === null ? "none" : Math.round(p.view.heading) + "°"}`, "phone");
    const st = add("button", "Stop the session") as HTMLButtonElement;
    st.onclick = () => { team.stop(); locked = false; lockedSince = 0; renderTeamPanel(); renderTeamBanner(); };
    return;
  }
  add("div", team.status);
  if (team.name) add("div", `You are ${team.name}. Point the camera at the tree from your side and hold the phone steady.`);
  const lv = add("button", "Leave") as HTMLButtonElement;
  lv.onclick = () => { team.stop(); renderTeamPanel(); renderTeamBanner(); };
}
team.onChange = () => { renderTeamPanel(); renderTeamBanner(); };
$("together").addEventListener("click", () => { $("teamPanel").style.display = "flex"; renderTeamPanel(); });
$("closeTeam").addEventListener("click", () => { $("teamPanel").style.display = "none"; });
let panelTick = 0;
setInterval(() => {
  if (team.role === "helper") team.send(ownView());
  else if (team.role === "host") { hostCompute(); team.broadcast({ k: "result", lines: teamLines, locked, ok: teamOk, phones: team.live().length + 1 }); }
  renderTeamBanner();
  if (++panelTick % 3 === 0 && team.role === "host") renderTeamPanel();
}, 300);

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
  if (joinId) team.join(joinId);
  if (!motionOk) hint("No motion sensor available. Lean is measured against the screen's up, not true plumb. Hold the phone very straight.", 8000);
  requestAnimationFrame(loop);
}

function flash(text: string) { msgEl.textContent = text; msgEl.style.display = "flex"; msgEl.style.background = "rgba(0,0,0,.35)"; setTimeout(() => { if (!busy) msgEl.style.display = "none"; }, 900); }
let hintTimer = 0;
function hint(t: string, ms = 0) { hintEl.textContent = t; lastHint = t; clearTimeout(hintTimer); if (ms) hintTimer = window.setTimeout(() => (hintEl.textContent = ""), ms); }

async function calibrate() {
  if (!sensors.active) { flash("No motion sensor to calibrate"); return; }
  busy = true;
  msgEl.style.background = "rgba(0,0,0,.8)"; msgEl.style.display = "flex";
  for (let i = 5; i > 0; i--) { msgEl.textContent = `Lay the phone flat on a table (on its back or face down, not on its edge). Starting in ${i}`; await sleep(1000); }
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
  if (takePhotoSoon) { const p = takePhotoSoon; takePhotoSoon = null; takePhoto(p.deg, p.label); }
}

function updateReadout(seg: Segmentation, gdown: Vec3 | null) {
  const m = smoother.median;
  if (m === null || smoother.count < 5) {
    steadySince = 0;
    degEl.textContent = "--"; dirEl.textContent = ""; degEl.style.color = "#fff";
    hint(seg.reason ?? "Reading...");
  } else {
    const a = Math.abs(m);
    degEl.textContent = a.toFixed(1) + "°";
    dirEl.textContent = a < 0.05 ? "straight" : m > 0 ? "leaning right →" : "← leaning left";
    degEl.style.color = a < 0.5 ? "#4cff8a" : a < 1.5 ? "#ffd84c" : "#ff6b5c";
    const steady = smoother.spread < 0.25 && smoother.count > 12;
    const now = performance.now();
    if (steady && seg.ok) { if (!steadySince) steadySince = now; } else steadySince = 0;
    const moved = lastShotDeg === null || Math.abs(m - lastShotDeg) >= 0.4;
    if (autoPhoto && steadySince && now - steadySince >= 3000 && moved && now - lastShotAt > 4000) {
      lastShotDeg = m; lastShotAt = now;
      takePhotoSoon = { deg: m, label: (a.toFixed(1) + "° ") + (a < 0.05 ? "straight" : m > 0 ? "leaning right" : "leaning left") };
    }
    const bent = bendSeen.count > 8 && (bendSeen.median ?? 0) > 0.5 && bendY.count > 4;
    if (!steady) hint("Settling... hold still");
    else if (bent) {
      bendFrac = Math.min(1, Math.max(0, (seg.bottom - (bendY.median ?? 0)) / Math.max(1, seg.bottom - seg.top)));
      const pct = Math.round(bendFrac * 100), lo = bendLow.median ?? 0, up = bendUp.median ?? 0;
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
