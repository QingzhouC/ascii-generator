/* E2E test: 导出 HTML 的鼠标交互（字符避让 + 空白拖尾 + 恢复） */
const { chromium } = require("playwright-core");
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(__dirname, "out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
const PORT = 8788;

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
          ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg"
        };
        res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function exportHtml(browser, sourceFile, outName) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
  const fi = await page.$("#file-input");
  await fi.setInputFiles(path.join(__dirname, sourceFile));
  await page.waitForFunction(() => {
    const b = document.getElementById("btn-export");
    return b && !b.disabled;
  }, { timeout: 30000 });
  await page.waitForTimeout(800);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }),
    page.click("#btn-export")
  ]);
  const outPath = path.join(OUT_DIR, outName);
  await download.saveAs(outPath);
  await page.close();
  return outPath;
}

const CHROME_PATH = "/Users/qingzhoucai/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"]
  });

  const report = {};
  let failed = 0;
  function check(name, ok, detail) {
    const item = { pass: !!ok };
    if (detail !== undefined) item.detail = detail;
    report[name] = item;
    if (!ok) { failed++; console.log("FAIL  " + name + (detail !== undefined ? " :: " + JSON.stringify(detail) : "")); }
    else console.log("PASS  " + name + (detail !== undefined ? " :: " + JSON.stringify(detail) : ""));
  }

  /* 在页面上按 60x60 网格扫描，返回每个区域的 ink（与白色背景的总色差） */
  const scanBoxes = (page) => page.evaluate(() => {
    const canvas = document.getElementById("canvas");
    const c = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const step = 60, size = 60;
    const list = [];
    for (let y = 60; y + size <= canvas.height / dpr - 60; y += step) {
      for (let x = 60; x + size <= canvas.width / dpr - 60; x += step) {
        const d = c.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), Math.floor(size * dpr), Math.floor(size * dpr)).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) ink += (255 - d[i]) + (255 - d[i + 1]) + (255 - d[i + 2]);
        list.push({ x, y, w: size, h: size, ink });
      }
    }
    list.sort((a, b) => b.ink - a.ink);
    return { dark: list[0], bright: list[list.length - 1] };
  });

  const ink = (page, box) => page.evaluate(({ x, y, w, h }) => {
    const canvas = document.getElementById("canvas");
    const c = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const d = c.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), Math.floor(w * dpr), Math.floor(h * dpr)).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (255 - d[i]) + (255 - d[i + 1]) + (255 - d[i + 2]);
    return s;
  }, box);

  try {
    /* ================= 图片导出：交互测试 ================= */
    const imgPath = await exportHtml(browser, "test_source.png", "interact-image.html");

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route("**/*", route => {
      if (route.request().resourceType() === "document") return route.continue();
      return route.abort();
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));

    await page.goto("file://" + imgPath, { waitUntil: "load" });
    await page.waitForTimeout(2500);

    check("imageExport.noPageErrors", errs.length === 0, errs);

    const boxes = await scanBoxes(page);
    report.imageBoxes = boxes;
    check("imageExport.boxesFound", !!boxes.dark && !!boxes.bright, boxes);

    const darkBox = boxes.dark, brightBox = boxes.bright;

    /* ---- 1. 拖尾测试：鼠标扫过空白区域，字符延迟浮现（ink 上升） ---- */
    const brightBefore = await ink(page, brightBox);
    const bcx = brightBox.x + brightBox.w / 2, bcy = brightBox.y + brightBox.h / 2;
    await page.mouse.move(bcx - 100, bcy);
    await page.mouse.move(bcx + 150, bcy, { steps: 12 });
    await page.waitForTimeout(200);
    const brightAfter = await ink(page, brightBox);
    check("imageExport.trailEffect", brightAfter > brightBefore * 1.5 && brightAfter - brightBefore > 4000,
      { before: brightBefore, after: brightAfter });

    /* 停止交互，让画面恢复（水波纹需要更长时间衰减） */
    await page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseleave")));
    await page.waitForTimeout(2500);

    /* ---- 2. 避让测试：鼠标悬停内容区，字符被推开/减淡（ink 下降） ---- */
    const darkBefore = await ink(page, darkBox);
    const dcx = darkBox.x + darkBox.w / 2, dcy = darkBox.y + darkBox.h / 2;
    await page.mouse.move(dcx, dcy);
    await page.waitForTimeout(700);
    const darkAfter = await ink(page, darkBox);
    check("imageExport.avoidEffect", darkAfter < darkBefore * 0.8,
      { before: darkBefore, after: darkAfter });

    /* ---- 3. 恢复测试：鼠标离开后画面复原（水波衰减需要更长时间） ---- */
    await page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseleave")));
    await page.waitForTimeout(3000);
    const darkRestored = await ink(page, darkBox);
    check("imageExport.restoreEffect", darkRestored > darkBefore * 0.85,
      { before: darkBefore, avoided: darkAfter, restored: darkRestored });

    await ctx.close();

    /* ================= 视频导出：交互测试 ================= */
    /* 暂停视频让画面静止，消除内容随时间变化对 ink 对比的干扰 */
    const vidPath = await exportHtml(browser, "test_source.mp4", "interact-video.html");
    const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await vctx.route("**/*", route => {
      if (route.request().resourceType() === "document") return route.continue();
      return route.abort();
    });
    const vpage = await vctx.newPage();
    const verrs = [];
    vpage.on("pageerror", e => verrs.push(e.message));
    await vpage.goto("file://" + vidPath, { waitUntil: "load" });
    await vpage.waitForTimeout(2000);

    check("videoExport.noPageErrors", verrs.length === 0, verrs);

    await vpage.evaluate(() => {
      const m = document.getElementById("media");
      if (m && m.pause) m.pause();
    });
    await vpage.waitForTimeout(1500);

    const vbox = await scanBoxes(vpage);
    check("videoExport.boxesFound", !!vbox.dark && !!vbox.bright, vbox);

    /* 拖尾：视频已暂停，扫过路径区域的像素变化只可能来自拖尾渲染。
       对角线扫过整个区域，覆盖所有字符行（视频管线为稀疏渲染） */
    const vcx = vbox.bright.x + vbox.bright.w / 2, vcy = vbox.bright.y + vbox.bright.h / 2;
    const vSnapBefore = await vpage.evaluate(({ x, y, w, h }) => {
      const canvas = document.getElementById("canvas");
      const c = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const d = c.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), Math.floor(w * dpr), Math.floor(h * dpr)).data;
      return Array.from(d);
    }, vbox.bright);
    await vpage.mouse.move(vbox.bright.x - 30, vbox.bright.y + 5);
    await vpage.mouse.move(vbox.bright.x + vbox.bright.w + 30, vbox.bright.y + vbox.bright.h - 5, { steps: 24 });
    await vpage.waitForTimeout(200);
    const vTrailState = await vpage.evaluate(({ x, y }) =>
      window.__dbg ? window.__dbg.trail(x, y) : -1, { x: vcx, y: vcy });
    const vChanged = await vpage.evaluate((args) => {
      const canvas = document.getElementById("canvas");
      const c = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const b = args.box;
      const d = c.getImageData(Math.floor(b.x * dpr), Math.floor(b.y * dpr), Math.floor(b.w * dpr), Math.floor(b.h * dpr)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - args.before[i]) > 15 ||
            Math.abs(d[i + 1] - args.before[i + 1]) > 15 ||
            Math.abs(d[i + 2] - args.before[i + 2]) > 15) n++;
      }
      return n;
    }, { box: vbox.bright, before: vSnapBefore });
    report.videoTrail = { trailState: vTrailState, changedPixels: vChanged };
    check("videoExport.trailEffect", vTrailState > 0.4 && vChanged > 200,
      { trailState: vTrailState, changedPixels: vChanged });

    /* 拖尾衰减：鼠标离开后 trail 衰减到接近 0（水波需更长时间） */
    await vpage.evaluate(() => document.dispatchEvent(new MouseEvent("mouseleave")));
    await vpage.waitForTimeout(3000);
    const vTrailDecayed = await vpage.evaluate(({ x, y }) =>
      window.__dbg ? window.__dbg.trail(x, y) : -1, { x: vcx, y: vcy });
    check("videoExport.trailDecay", vTrailDecayed >= 0 && vTrailDecayed < 0.05, vTrailDecayed);

    /* 避让：悬停内容区，ink 下降 */
    const vdarkBefore = await ink(vpage, vbox.dark);
    const vdcx = vbox.dark.x + vbox.dark.w / 2, vdcy = vbox.dark.y + vbox.dark.h / 2;
    await vpage.mouse.move(vdcx, vdcy);
    await vpage.waitForTimeout(700);
    const vdarkAfter = await ink(vpage, vbox.dark);
    check("videoExport.avoidEffect", vdarkAfter < vdarkBefore * 0.8,
      { before: vdarkBefore, after: vdarkAfter });

    await vctx.close();

    console.log("=== SUMMARY: " + (failed === 0 ? "ALL PASS" : failed + " FAILED") + " ===");
    fs.writeFileSync(path.join(OUT_DIR, "interact-report.json"), JSON.stringify(report, null, 2));
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error("TEST FAILED:", e);
    fs.writeFileSync(path.join(OUT_DIR, "interact-error.txt"), e.stack || String(e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
