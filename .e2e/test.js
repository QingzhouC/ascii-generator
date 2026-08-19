/* E2E test for ASCII Generator HTML export */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(__dirname, "out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const PORT = 8787;

function ffprobe(file) {
  const out = execSync(
    `ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate -show_entries format=duration,size -of json "${file}"`,
    { encoding: "utf8" }
  );
  return JSON.parse(out);
}

function fmt(bytes) {
  if (bytes == null) return "n/a";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

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

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"]
  });

  const report = {};

  try {
    /* ---------- PHASE 1: import video + adjust params + export ---------- */
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrs = [];
    page.on("console", m => { if (m.type() === "error") consoleErrs.push(m.text()); });
    page.on("pageerror", e => consoleErrs.push("PAGEERROR: " + e.message));

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });

    // Upload the test video via the file input
    const videoPath = path.join(__dirname, "test_source.mp4");
    const fi = await page.$("#file-input");
    await fi.setInputFiles(videoPath);

    // Wait for media ready (export button enabled)
    await page.waitForFunction(() => {
      const b = document.getElementById("btn-export");
      return b && !b.disabled;
    }, { timeout: 30000 });

    // Capture source video info from the page
    const srcInfo = await page.evaluate(() => {
      const v = document.getElementById("source-video");
      return { w: v.videoWidth, h: v.videoHeight, dur: v.duration, cols: columns, rows: rows };
    });
    report.source = { width: srcInfo.w, height: srcInfo.h, duration: srcInfo.dur, asciiCols: srcInfo.cols, asciiRows: srcInfo.rows };

    // Let it render a few frames
    await page.waitForTimeout(1500);

    // Adjust a set of non-default params (mutate the global config directly)
    await page.evaluate(() => {
      config.brightness = 120;
      config.contrast = 130;
      config.gamma = 1.2;
      config.invert = true;
      config.dithering = "bayer4x4";
      config.bgMode = "auto";
      config.waveThreshold = 0.15;
      config.charset = "@#%*+=-:. ";
      config.tonalSteps = 12;
      config.font = '"Courier New", monospace';
      config.fontSize = 13;
      config.cellWidth = 13;
      config.cellHeight = 15;
      config.colorMode = "source";
      config.charColor = "#ff3300";
      config.bgColor = "#000000";
      config.tint = "#102030";
      config.tintAmount = 20;
      config.smoothing = 0.88;
      config.depthLayers = 4;
      config.animType = "wave";
      config.animSpeed = 1.5;
      config.reveal = "center";
      config.fps = 30;
      config.loop = true;
    });
    await page.waitForTimeout(800);

    // Capture the config we set, for later comparison
    const expectedConfig = await page.evaluate(() => JSON.parse(JSON.stringify(config)));

    // Trigger export and capture the download
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.click("#btn-export")
    ]);
    const exportPath = path.join(OUT_DIR, download.suggestedFilename() || "ascii-art.html");
    await download.saveAs(exportPath);

    const exportSize = fs.statSync(exportPath).size;
    const exportHtml = fs.readFileSync(exportPath, "utf8");

    // Extract embedded media data URL
    const m = exportHtml.match(/src="(data:[^"]+)"/);
    const mediaDataUrl = m ? m[1] : null;
    let embeddedMime = null, embeddedB64 = null;
    if (mediaDataUrl) {
      const comma = mediaDataUrl.indexOf(",");
      embeddedMime = mediaDataUrl.slice(5, comma);
      embeddedB64 = mediaDataUrl.slice(comma + 1);
    }

    // Decode embedded media to a file for ffprobe
    let embeddedFile = null;
    if (embeddedB64) {
      embeddedFile = path.join(OUT_DIR, "embedded_media.bin");
      fs.writeFileSync(embeddedFile, Buffer.from(embeddedB64, "base64"));
    }

    // Check for external references (should be none)
    const extRefs = [];
    const re = /(src|href)\s*=\s*["'](http|\/\/|\.\/|\/)([^"']*)["']/g;
    let mm;
    while ((mm = re.exec(exportHtml)) !== null) extRefs.push(mm[0]);
    const hasScriptSrc = /<script[^>]+src=/.test(exportHtml);
    const hasLinkCss = /<link[^>]+stylesheet/.test(exportHtml);

    report.export = {
      htmlSize: exportSize,
      htmlSizePretty: fmt(exportSize),
      embeddedMime,
      embeddedMediaBytes: embeddedB64 ? Buffer.from(embeddedB64, "base64").length : null,
      embeddedMediaPretty: fmt(embeddedB64 ? Buffer.from(embeddedB64, "base64").length : null),
      b64StringLen: embeddedB64 ? embeddedB64.length : null,
      externalRefs: extRefs,
      hasScriptSrc, hasLinkCss,
      configMatches: JSON.stringify(expectedConfig) === JSON.stringify(embeddedConfig(exportHtml))
    };

    // ffprobe embedded media
    if (embeddedFile && fs.existsSync(embeddedFile) && fs.statSync(embeddedFile).size > 0) {
      try {
        const info = ffprobe(embeddedFile);
        const vs = (info.streams || []).find(s => s.codec_type === "video");
        const hasAudio = (info.streams || []).some(s => s.codec_type === "audio");
        report.export.embeddedVideo = {
          codec: vs ? vs.codec_name : null,
          width: vs ? vs.width : null,
          height: vs ? vs.height : null,
          fps: vs ? vs.r_frame_rate : null,
          duration: info.format ? info.format.duration : null,
          hasAudio
        };
      } catch (e) {
        report.export.embeddedVideo = { error: e.message };
      }
    }

    // Original video info
    const origInfo = ffprobe(videoPath);
    const origVs = (origInfo.streams || []).find(s => s.codec_type === "video");
    report.originalVideo = {
      width: origVs.width, height: origVs.height, fps: origVs.r_frame_rate,
      size: origInfo.format.size, sizePretty: fmt(origInfo.format.size),
      duration: origInfo.format.duration,
      hasAudio: (origInfo.streams || []).some(s => s.codec_type === "audio")
    };
    // What the OLD (pre-optimization) export would have been: full video base64 + template
    const origB64Len = Math.ceil(origInfo.format.size / 3) * 4;
    report.originalVideo.base64Len = origB64Len;
    report.originalVideo.base64Pretty = fmt(origB64Len);

    /* ---------- PHASE 2: open exported HTML standalone, offline ---------- */
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Block ALL sub-resource requests to prove offline self-containment.
    // Allow the main document (the file:// HTML) itself.
    await ctx2.route("**/*", route => {
      if (route.request().resourceType() === "document") return route.continue();
      return route.abort();
    });
    const page2 = await ctx2.newPage();
    const errs2 = [];
    page2.on("pageerror", e => errs2.push("PAGEERROR: " + e.message));

    const fileUrl = "file://" + exportPath;
    await page2.goto(fileUrl, { waitUntil: "load" });
    await page2.waitForTimeout(2500);

    const verify = await page2.evaluate(() => {
      const media = document.getElementById("media");
      const canvas = document.getElementById("canvas");
      const ctx = canvas.getContext("2d");
      // Sample canvas pixels to confirm ASCII is being drawn
      let nonBg = 0, total = 0;
      try {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4) {
          total++;
          // count pixels that are not the background color (bg is #000000)
          if (d[i] > 10 || d[i + 1] > 10 || d[i + 2] > 10) nonBg++;
        }
      } catch (e) { return { canvasError: e.message }; }
      return {
        mediaSrcIsData: media && String(media.src).indexOf("data:") === 0,
        mediaReadyState: media ? media.readyState : null,
        mediaWidth: media ? media.videoWidth : (media ? media.naturalWidth : null),
        mediaHeight: media ? media.videoHeight : (media ? media.naturalHeight : null),
        mediaPaused: media ? media.paused : null,
        mediaLoop: media ? media.loop : null,
        mediaMuted: media ? media.muted : null,
        canvasW: canvas.width, canvasH: canvas.height,
        nonBgPixels: nonBg, totalPixels: total,
        nonBgRatio: total ? (nonBg / total) : 0,
        configPresent: typeof config !== "undefined",
        configAnimType: typeof config !== "undefined" ? config.animType : null,
        configCharset: typeof config !== "undefined" ? config.charset : null,
        configBgColor: typeof config !== "undefined" ? config.bgColor : null
      };
    });
    report.standalone = { verify, pageErrors: errs2 };

    // Confirm it keeps playing (capture two frames, ensure canvas changes / media time advances)
    const t1 = await page2.evaluate(() => { const m = document.getElementById("media"); return m ? m.currentTime : -1; });
    await page2.waitForTimeout(1200);
    const t2 = await page2.evaluate(() => { const m = document.getElementById("media"); return m ? m.currentTime : -1; });
    report.standalone.playing = { t1, t2, advanced: t2 > t1 };

    // Console errors from phase 1 (ignore benign autoplay/media warnings)
    report.phase1ConsoleErrors = consoleErrs.filter(e =>
      !/autoplay|Autoplay|media|Media|not allowed|interrupted|Failed to load|ERR_ABORTED/i.test(e)
    );

    console.log("=== REPORT ===");
    console.log(JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  } catch (e) {
    console.error("TEST FAILED:", e);
    fs.writeFileSync(path.join(OUT_DIR, "error.txt"), e.stack || String(e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();

function embeddedConfig(html) {
  const m = html.match(/const config=(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}
