// Photos should still be there after the page is closed and reopened.
import { chromium } from "playwright-core";
import { startServer } from "../serve.mjs";
const vid = process.argv[2];
const server = await startServer(5193);
const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${vid}`] });
const ctx = await browser.newContext({ permissions: ["camera"], viewport: { width: 390, height: 780 } });
const open = async () => {
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.DeviceMotionEvent = class extends Event {}; setInterval(() => { const e = new Event("devicemotion"); e.accelerationIncludingGravity = { x: 0, y: 9.81, z: 0.3 }; window.dispatchEvent(e); }, 16); });
  await page.goto("http://127.0.0.1:5193/");
  return page;
};
let page = await open();
await page.click("#start");
await page.waitForFunction(() => document.getElementById("splash").style.display === "none", null, { timeout: 15000 });
await page.waitForTimeout(15000);
console.log("before close:", await page.textContent("#photos"));
await page.close();
page = await open();
await page.waitForTimeout(1500);
console.log("after reopening:", await page.textContent("#photos"));
await browser.close(); server.close();
