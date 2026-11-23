// Real-photo check: plays a photo of a decorated tree as the fake camera and screenshots what the app finds.
import { chromium } from "playwright-core";
import { startServer } from "../serve.mjs";
const vid = process.argv[2], out = process.argv[3] || "real-shot.png";
const server = await startServer(5192);
const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${vid}`] });
const page = await (await browser.newContext({ permissions: ["camera"], viewport: { width: 390, height: 780 } })).newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => console.log("console:", m.text()));
await page.addInitScript(() => {
  window.DeviceMotionEvent = class extends Event {};
  setInterval(() => { const e = new Event("devicemotion"); e.accelerationIncludingGravity = { x: 0, y: 9.81, z: 0.3 }; window.dispatchEvent(e); }, 16);
});
await page.goto("http://127.0.0.1:5192/");
await page.click("#start");
await page.waitForFunction(() => document.getElementById("splash").style.display === "none", null, { timeout: 15000 });
await page.click("#maskBtn");
await page.waitForTimeout(15000);
console.log("deg:", await page.textContent("#deg"), await page.textContent("#dir"), "|", await page.textContent("#hint"), "|", await page.textContent("#status"));
console.log("photos button:", await page.textContent("#photos"));
await page.click("#photos");
await page.waitForTimeout(500);
await page.screenshot({ path: out });
await browser.close(); server.close();
