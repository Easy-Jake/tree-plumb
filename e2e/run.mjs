// End-to-end check in real Chrome: a fake camera plays a synthetic tilted tree, fake motion
// events stand in for the phone's sensors, and we read the number the app puts on screen.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer } from "../serve.mjs";

const VW = 360, VH = 640;
function y4m(deg, file) {
  const t = (deg * Math.PI) / 180, baseX = VW / 2, baseY = 590, height = 480, halfBase = 120;
  let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const Y = Buffer.alloc(VW * VH), U = Buffer.alloc((VW * VH) / 4), V = Buffer.alloc((VW * VH) / 4);
  const rgbAt = (x, y) => {
    const dx = x - baseX, dy = baseY - y, a = dx * Math.sin(t) + dy * Math.cos(t), b = dx * Math.cos(t) - dy * Math.sin(t);
    if (a >= 0 && a <= height && Math.abs(b) <= halfBase * (1 - a / height)) {
      if (rnd() < 0.04) return [230, 40, 40];
      return [30, 120, 40];
    }
    return [170, 165, 160];
  };
  for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
    const [r, g, b] = rgbAt(x, y);
    Y[y * VW + x] = Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b);
    if (!(x & 1) && !(y & 1)) {
      const i = (y >> 1) * (VW >> 1) + (x >> 1);
      U[i] = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b);
      V[i] = Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b);
    }
  }
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push(Buffer.from("FRAME\n"), Y, U, V);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${VW} H${VH} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
}

const server = await startServer(5191);
const url = "http://127.0.0.1:5191/";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "treeplumb-"));
let failed = 0;

async function trial(name, treeDeg, rollDeg, expected, tol = 0.8) {
  const vid = path.join(tmp, `tree${treeDeg}.y4m`);
  y4m(treeDeg, vid);
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${vid}`],
  });
  const page = await (await browser.newContext({ permissions: ["camera"], viewport: { width: 390, height: 780 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((roll) => {
    // pretend to be a phone held upright, rolled `roll` degrees clockwise, giving off sensor readings
    const a = (roll * Math.PI) / 180;
    window.DeviceMotionEvent = class extends Event {};
    setInterval(() => {
      const e = new Event("devicemotion");
      e.accelerationIncludingGravity = { x: -9.81 * Math.sin(a) + (Math.random() - 0.5) * 0.04, y: 9.81 * Math.cos(a) + (Math.random() - 0.5) * 0.04, z: 0.3 };
      window.dispatchEvent(e);
    }, 16);
  }, rollDeg);
  await page.goto(url);
  await page.click("#start");
  await page.waitForFunction(() => document.getElementById("splash").style.display === "none", null, { timeout: 15000 });
  await page.waitForTimeout(4000);
  const txt = await page.textContent("#deg");
  const dir = await page.textContent("#dir");
  const status = await page.textContent("#status");
  if (name === "first") await page.screenshot({ path: path.join(tmp, "shot.png") });
  await browser.close();
  const got = parseFloat(txt) * (/left/.test(dir) ? -1 : 1);
  const ok = Math.abs(got - expected) <= tol && errors.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: tree ${treeDeg}deg, phone rolled ${rollDeg}deg -> shows "${txt} ${dir}" (expected ~${expected}); ${status}${errors.length ? " ERRORS " + errors : ""}`);
}

await trial("first", 3, 0, 3);
await trial("leaning left", -4, 0, -4);
await trial("phone rolled corrects", 3, 2, 5);
server.close();
console.log(failed ? `${failed} FAILED` : "all end-to-end checks passed");
if (fs.existsSync(path.join(tmp, "shot.png"))) console.log("screenshot:", path.join(tmp, "shot.png"));
process.exit(failed ? 1 : 0);
