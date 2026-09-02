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

    /* 图片导出默认开启定格流动感 */
    const imgFlow = await page.evaluate(() => window.__dbg.flow());
    check("imageExport.flowActive", imgFlow === true, imgFlow);

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

    /* 移动不产生水波：波纹仅在点击时出现。
       关闭环境涟漪并清零波场后扫过，波场应保持零 */
    await page.evaluate(() => window.__dbg.setFlow(false));
    await page.evaluate(() => window.__dbg.resetWaves());
    await page.mouse.move(200, 300);
    await page.mouse.move(1000, 500, { steps: 20 });
    await page.waitForTimeout(300);
    const moveWave = await page.evaluate(() => {
      const dbg = window.__dbg;
      const g = dbg.grid();
      let sum = 0, n = 0;
      for (let y = 0; y < g.r; y++) {
        for (let x = 0; x < g.c; x++) { sum += Math.abs(dbg.wave(x, y)); n++; }
      }
      return n ? sum / n : 0;
    });
    check("imageExport.moveNoWave", moveWave < 0.01, moveWave);

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

    /* ---- 4. 点击水滴测试：弹坑剖面 + 次级涟漪扩散 ---- */
    const clickWave = await page.evaluate(async () => {
      const cx = 500, cy = 400;
      window.dispatchEvent(new MouseEvent("mousedown", { clientX: cx, clientY: cy }));
      const dbg = window.__dbg;
      const g = dbg.grid();
      /* 弹坑剖面：点击瞬间中心深凹（负值），外缘隆起（正值水圈） */
      const center = dbg.wave(Math.floor(cx / g.cw), Math.floor(cy / g.ch));
      const rim = dbg.wave(Math.floor(cx / g.cw) + 4, Math.floor(cy / g.ch));
      const sample = (px, py) => {
        const ix = Math.floor(px / g.cw), iy = Math.floor(py / g.ch);
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) { for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx, y = iy + dy;
          if (x < 0 || x >= g.c || y < 0 || y >= g.r) continue;
          sum += Math.abs(dbg.wave(x, y)); n++;
        }}
        return n ? sum / n : 0;
      };
      /* 等待 500ms：主涟漪扩散出去，次级小水珠（+160ms/+320ms）也已落下 */
      await new Promise(r => setTimeout(r, 500));
      const near = sample(cx, cy);
      const far = sample(cx + g.cw * 10, cy);
      return { center, rim, near, far };
    });
    check("imageExport.clickWave.crater", clickWave.center < -0.5 && clickWave.rim > 0,
      { center: clickWave.center, rim: clickWave.rim });
    check("imageExport.clickWave.spread", clickWave.near > 0.05 || clickWave.far > 0.05,
      { near: clickWave.near, far: clickWave.far });

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

    /* ================= 单次播放 + 定格流动感测试 ================= */
    const ogenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ogenPage = await ogenCtx.newPage();
    await ogenPage.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
    /* 取消循环播放 → 导出的 HTML 只播放一次 */
    await ogenPage.evaluate(() => {
      const loop = document.getElementById("ctrl-loop");
      loop.checked = false;
      loop.dispatchEvent(new Event("change"));
    });
    const ofi = await ogenPage.$("#file-input");
    await ofi.setInputFiles(path.join(__dirname, "test_source.mp4"));
    await ogenPage.waitForFunction(() => {
      const b = document.getElementById("btn-export");
      return b && !b.disabled;
    }, { timeout: 30000 });
    await ogenPage.waitForTimeout(800);
    const [odl] = await Promise.all([
      ogenPage.waitForEvent("download", { timeout: 120000 }),
      ogenPage.click("#btn-export")
    ]);
    const oncePath = path.join(OUT_DIR, "interact-video-once.html");
    await odl.saveAs(oncePath);
    await ogenCtx.close();

    const onceCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await onceCtx.route("**/*", route =>
      route.request().resourceType() === "document" ? route.continue() : route.abort());
    const oncePage = await onceCtx.newPage();
    const onceErrs = [];
    oncePage.on("pageerror", e => onceErrs.push(e.message));
    await oncePage.goto("file://" + oncePath, { waitUntil: "load" });
    await oncePage.waitForTimeout(1500);

    /* 视频 loop 属性应关闭 */
    const onceInfo = await oncePage.evaluate(() => {
      const m = document.getElementById("media");
      return { loop: m.loop, duration: m.duration };
    });
    check("onceExport.noLoop", onceInfo.loop === false, onceInfo);

    /* 等待播放结束，定格流动感应激活 */
    await oncePage.waitForFunction(() => {
      const m = document.getElementById("media");
      return m.ended;
    }, { timeout: 30000 }).catch(() => {});
    const flowOn = await oncePage.evaluate(() => window.__dbg.flow());
    check("onceExport.flowActive", flowOn === true, flowOn);

    /* 定格画面仍在流动：两帧画面存在像素差异（字符漂移+环境涟漪） */
    const flowMotion = await oncePage.evaluate(async () => {
      const canvas = document.getElementById("canvas");
      const c = canvas.getContext("2d");
      const snap = () => c.getImageData(0, 0, canvas.width, canvas.height).data;
      const a = snap();
      await new Promise(r => setTimeout(r, 400));
      const b = snap();
      let diff = 0;
      for (let i = 0; i < b.length; i += 40) { if (Math.abs(a[i] - b[i]) > 12) diff++; }
      return diff;
    });
    check("onceExport.flowMotion", flowMotion > 20, flowMotion);
    check("onceExport.noPageErrors", onceErrs.length === 0, onceErrs);
    await onceCtx.close();

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
