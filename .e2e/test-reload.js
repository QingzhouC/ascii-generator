/* Repro: 清除后重载视频 + 单次播放结束后切回循环 */
const { chromium } = require("playwright-core");
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_DIR = path.resolve(__dirname, "..");
const PORT = 8790;

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const fp = path.join(APP_DIR, p);
      if (!fp.startsWith(APP_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        const ext = path.extname(fp).toLowerCase();
        const types = {
          ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
          ".mp4": "video/mp4", ".png": "image/png"
        };
        res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

const CHROME_PATH = "/Users/qingzhoucai/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    args: ["--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });

  /* --- 场景A：载入 → 清除 → 再载入 --- */
  let fi = await page.$("#file-input");
  await fi.setInputFiles(path.join(__dirname, "test_source.mp4"));
  await page.waitForFunction(() => !document.getElementById("btn-export").disabled, { timeout: 30000 });
  console.log("A1 first load OK");

  await page.click("#btn-clear");
  await page.waitForTimeout(300);
  console.log("A2 cleared, export disabled =", await page.evaluate(() => document.getElementById("btn-export").disabled));

  fi = await page.$("#file-input");
  await fi.setInputFiles(path.join(__dirname, "test_source.mp4"));
  let ok = true;
  try {
    await page.waitForFunction(() => !document.getElementById("btn-export").disabled, { timeout: 10000 });
  } catch (e) { ok = false; }
  console.log("A3 reload after clear:", ok ? "OK" : "FAIL");
  console.log("A3 video state:", await page.evaluate(() => {
    const v = document.getElementById("source-video");
    return { readyState: v.readyState, error: v.error ? v.error.code : null, hasSrc: !!v.getAttribute("src") };
  }));

  /* --- 场景B：单次播放结束 → 切回循环 → 应重新播放 --- */
  await page.evaluate(() => {
    const loop = document.getElementById("ctrl-loop");
    loop.checked = false;
    loop.dispatchEvent(new Event("change"));
  });
  await page.evaluate(() => {
    const v = document.getElementById("source-video");
    v.currentTime = Math.max(0, v.duration - 0.3);
  });
  await page.waitForFunction(() => document.getElementById("source-video").ended, { timeout: 15000 }).catch(() => {});
  console.log("B1 ended =", await page.evaluate(() => document.getElementById("source-video").ended));

  await page.evaluate(() => {
    const loop = document.getElementById("ctrl-loop");
    loop.checked = true;
    loop.dispatchEvent(new Event("change"));
  });
  await page.waitForTimeout(1200);
  const t1 = await page.evaluate(() => document.getElementById("source-video").currentTime);
  await page.waitForTimeout(1000);
  const t2 = await page.evaluate(() => document.getElementById("source-video").currentTime);
  console.log("B2 after re-enable loop: t1 =", t1, "t2 =", t2, "advancing =", t2 > t1);

  console.log("page errors:", errs);
  await browser.close();
  server.close();
})();
