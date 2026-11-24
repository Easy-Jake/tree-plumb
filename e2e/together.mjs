// Two phones, two different sides of a tree that really leans 3 degrees toward compass 30.
// Phone 1 faces north, phone 2 faces east. Each sees only its own sideways part of the lean.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { PeerServer } from "peer";
import { startServer } from "../serve.mjs";

const THETA = 3, PHI = 30;
const see = (h) => {
  const L = Math.tan((THETA * Math.PI) / 180), lx = L * Math.sin((PHI * Math.PI) / 180), ly = L * Math.cos((PHI * Math.PI) / 180);
  return (Math.atan(lx * Math.cos((h * Math.PI) / 180) + ly * -Math.sin((h * Math.PI) / 180)) * 180) / Math.PI;
};
const VW = 360, VH = 640;
function y4m(deg, file) {
  const t = (deg * Math.PI) / 180, baseX = VW / 2, baseY = 590, height = 480, halfBase = 120;
  const Y = Buffer.alloc(VW * VH), U = Buffer.alloc((VW * VH) / 4), V = Buffer.alloc((VW * VH) / 4);
  const rgbAt = (x, y) => {
    const dx = x - baseX, dy = baseY - y, a = dx * Math.sin(t) + dy * Math.cos(t), b = dx * Math.cos(t) - dy * Math.sin(t);
    return a >= 0 && a <= height && Math.abs(b) <= halfBase * (1 - a / height) ? [30, 120, 40] : [170, 165, 160];
  };
  for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
    const [r, g, b] = rgbAt(x, y);
    Y[y * VW + x] = Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b);
    if (!(x & 1) && !(y & 1)) { const i = (y >> 1) * (VW >> 1) + (x >> 1); U[i] = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b); V[i] = Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b); }
  }
  const frames = []; for (let i = 0; i < 10; i++) frames.push(Buffer.from("FRAME\n"), Y, U, V);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${VW} H${VH} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "together-"));
const broker = PeerServer({ port: 9000, path: "/" });
const web = await startServer(5194);
async function phone(heading, alpha) {
  const vid = path.join(tmp, `p${heading}.y4m`); y4m(alpha, vid);
  const b = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${vid}`] });
  const page = await (await b.newContext({ permissions: ["camera"], viewport: { width: 390, height: 780 } })).newPage();
  page.on("pageerror", (e) => console.log(`[phone ${heading}] pageerror`, String(e)));
  await page.addInitScript((h) => {
    window.DeviceMotionEvent = class extends Event {};
    setInterval(() => {
      const m = new Event("devicemotion"); m.accelerationIncludingGravity = { x: 0, y: 9.81, z: 0.3 }; window.dispatchEvent(m);
      const o = new Event("deviceorientation"); o.webkitCompassHeading = h; window.dispatchEvent(o);
    }, 30);
  }, heading);
  return { b, page };
}
const a1 = Math.round(see(0) * 100) / 100, a2 = Math.round(see(90) * 100) / 100;
console.log(`true lean ${THETA} deg toward ${PHI}; phone 1 (facing 0) sees ${a1}, phone 2 (facing 90) sees ${a2}`);
const A = await phone(0, a1), B = await phone(90, a2);
const base = "http://127.0.0.1:5194/" + (process.env.CLOUD ? "" : "?broker=127.0.0.1:9000");
await A.page.goto(base);
await A.page.click("#start");
await A.page.waitForFunction(() => document.getElementById("splash").style.display === "none", null, { timeout: 15000 });
await A.page.click("#together");
await A.page.click("#teamBody button");
await A.page.waitForSelector("#teamBody .url", { timeout: 20000 });
const url = await A.page.evaluate(() => [...document.querySelectorAll("#teamBody .url")].map((e) => e.textContent).find((t) => t.includes("#join=")));
console.log("join link:", url);
await B.page.goto(url);
await B.page.click("#start");
await B.page.waitForFunction(() => document.getElementById("splash").style.display === "none", null, { timeout: 15000 });
await A.page.click("#closeTeam");
await A.page.waitForTimeout(15000);
console.log("host sees:", JSON.stringify(await A.page.evaluate(() => document.getElementById("team").innerText)));
console.log("helper sees:", JSON.stringify(await B.page.evaluate(() => document.getElementById("team").innerText)));
await A.page.screenshot({ path: path.join(tmp, "host.png") });
await B.page.screenshot({ path: path.join(tmp, "helper.png") });
console.log("screenshots in", tmp);
await A.b.close(); await B.b.close(); web.close(); broker.close?.();
process.exit(0);
