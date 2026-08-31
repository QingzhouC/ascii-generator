/* =========================================================
   ASCII 生成器
   支持：图像处理 / 背景识别 / 字符渲染 / 颜色 / 动画 / 导出
========================================================= */

const video = document.getElementById("source-video");
const image = document.getElementById("source-image");
const canvas = document.getElementById("ascii-canvas");
const ctx = canvas.getContext("2d");

const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

/* =========================================================
   配置
========================================================= */

const config = {
  /* 图像处理 */
  brightness: 100,
  contrast: 100,
  gamma: 1.0,
  invert: false,
  dithering: "none",

  /* 背景识别 */
  bgMode: "auto",
  whiteThreshold: 0.92,
  whiteDistance: 75,
  darkThreshold: 0.10,
  darkDistance: 75,

  /* 主体识别 */
  waveThreshold: 0.12,

  /* 字符渲染 */
  charset: ".:-=+*01#%@",
  tonalSteps: 10,
  font: '"Courier New", monospace',
  fontSize: 13,
  cellWidth: 13,
  cellHeight: 15,

  /* 颜色 */
  colorMode: "solid",
  charColor: "#005AEB",
  bgColor: "#ffffff",
  tint: "#000000",
  tintAmount: 0,

  /* 平滑与厚度 */
  smoothing: 0.88,
  depthLayers: 4,
  depthX: 1.1,
  depthY: 1.5,

  /* 动画 */
  animType: "none",
  animSpeed: 1.0,
  reveal: "none",

  /* 播放 */
  fps: 30,
  loop: true
};

const DEFAULTS = Object.assign({}, config);

/* 字符集预设（密度从高到低） */
const CHARSET_PRESETS = {
  standard: "@%#*+=-:.",
  block: "█▓▒░ ",
  braille: "⣿⣷⣾⣽⣤⣀⣠⣴⣶⣳⣂⣣⣢⡿⢟⢿⡿⢰⢠⢰⣐⣈⣠⡀⠐⠈⠄⠤⠴⠶⣀⡀⠁⠄⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤",
  minimal: "#.",
  dots: ".:-=+*#%@"
};

/* Bayer 4x4 抖动矩阵（归一化 0~1） */
const BAYER4x4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

/* =========================================================
   工具函数
========================================================= */

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16)
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* =========================================================
   Canvas 变量
========================================================= */

let width = 0, height = 0, columns = 0, rows = 0;

/* 分析数据 */
let smoothBody, previousBody, edgeMap, motionMap, waveMap, backgroundMask;
let srcR, srcG, srcB; /* 源色模式用 */
let srcL, imgShade, imgLevel; /* 图片专用管线用 */
let imgLut = null;

/* 媒体状态 */
let mediaType = null;
let mediaReady = false;
let mediaName = "";
let mediaUrl = "";
let mediaFile = null;
let mediaLoadTime = 0; /* 揭示效果用 */

/* =========================================================
   尺寸
========================================================= */

function resizeCanvas() {
  const container = document.getElementById("preview-container");
  const dpr = window.devicePixelRatio || 1;
  width = container.clientWidth;
  height = container.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  columns = Math.max(1, Math.ceil(width / config.cellWidth));
  rows = Math.max(1, Math.ceil(height / config.cellHeight));
  sourceCanvas.width = columns;
  sourceCanvas.height = rows;
  const size = columns * rows;
  smoothBody = new Float32Array(size);
  previousBody = new Float32Array(size);
  edgeMap = new Float32Array(size);
  motionMap = new Float32Array(size);
  waveMap = new Float32Array(size);
  backgroundMask = new Uint8Array(size);
  srcR = new Uint8ClampedArray(size);
  srcG = new Uint8ClampedArray(size);
  srcB = new Uint8ClampedArray(size);
  srcL = new Uint8ClampedArray(size);
  imgShade = new Uint8ClampedArray(size);
  imgLevel = new Float32Array(size);
}

function rebuildGrid() {
  resizeCanvas();
  if (smoothBody) {
    smoothBody.fill(0);
    previousBody.fill(0);
    edgeMap.fill(0);
    motionMap.fill(0);
    waveMap.fill(0);
    backgroundMask.fill(0);
    srcR.fill(0);
    srcG.fill(0);
    srcB.fill(0);
    srcL.fill(0);
    imgShade.fill(0);
    imgLevel.fill(0);
  }
}

resizeCanvas();

window.addEventListener("resize", () => {
  fitContainerToMedia();
  resizeCanvas();
});

/* =========================================================
   预览框自适应
========================================================= */

function fitContainerToMedia() {
  const container = document.getElementById("preview-container");
  const area = document.querySelector(".preview-area");
  if (!mediaReady || !mediaType) {
    container.style.width = "100%";
    container.style.height = "100%";
    return;
  }
  let vw = 0, vh = 0;
  if (mediaType === "video") {
    vw = video.videoWidth;
    vh = video.videoHeight;
  } else {
    vw = image.naturalWidth;
    vh = image.naturalHeight;
  }
  if (!vw || !vh) return;
  const style = getComputedStyle(area);
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  const padT = parseFloat(style.paddingTop) || 0;
  const padB = parseFloat(style.paddingBottom) || 0;
  const availW = area.clientWidth - padL - padR;
  const availH = area.clientHeight - padT - padB;
  const ratio = vw / vh;
  let w = availW, h = w / ratio;
  if (h > availH) { h = availH; w = h * ratio; }
  container.style.width = Math.floor(w) + "px";
  container.style.height = Math.floor(h) + "px";
}

/* =========================================================
   绘制源媒体到网格
========================================================= */

function drawCover() {
  let vw = 0, vh = 0, src = null;
  if (mediaType === "video") {
    vw = video.videoWidth;
    vh = video.videoHeight;
    src = video;
  } else if (mediaType === "image") {
    vw = image.naturalWidth;
    vh = image.naturalHeight;
    src = image;
  }
  if (!vw || !vh) return;
  sourceCtx.drawImage(src, 0, 0, vw, vh, 0, 0, columns, rows);
}

/* =========================================================
   图像处理：亮度 / 对比度 / 伽马 / 反转
   输入 0~255，输出 0~255
========================================================= */

function processPixel(v) {
  /* 亮度 */
  v = v * (config.brightness / 100);
  /* 对比度 */
  const c = config.contrast / 100;
  v = (v - 128) * c + 128;
  /* 伽马 */
  v = Math.pow(clamp(v / 255, 0, 1), 1 / config.gamma) * 255;
  /* 反转 */
  if (config.invert) v = 255 - v;
  return clamp(v, 0, 255);
}

/* =========================================================
   背景判断
========================================================= */

function isBackgroundPixel(r, g, b, dark) {
  const brightness = (r + g + b) / 3 / 255;
  if (dark) {
    const darkDistance = Math.sqrt(r * r + g * g + b * b);
    return brightness < config.darkThreshold && darkDistance < config.darkDistance;
  }
  const whiteDistance = Math.sqrt(
    Math.pow(255 - r, 2) + Math.pow(255 - g, 2) + Math.pow(255 - b, 2)
  );
  return brightness > config.whiteThreshold && whiteDistance < config.whiteDistance;
}

/* =========================================================
   抖动
========================================================= */

function bayerThreshold(x, y) {
  return (BAYER4x4[y % 4][x % 4] + 0.5) / 16;
}

/* =========================================================
   分析
========================================================= */

function analyse() {
  drawCover();
  const imageData = sourceCtx.getImageData(0, 0, columns, rows);
  const pixels = imageData.data;

  /* 判断背景类型 */
  let dark = false;
  if (config.bgMode === "black") {
    dark = true;
  } else if (config.bgMode === "white") {
    dark = false;
  } else {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }
    const avg = sum / (pixels.length / 4) / 255;
    dark = avg < 0.5;
  }

  /* STEP 1 背景 + 主体 */
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const index = y * columns + x;
      const pi = index * 4;
      const r = pixels[pi];
      const g = pixels[pi + 1];
      const b = pixels[pi + 2];

      /* 存储源色（供源色模式用） */
      srcR[index] = r;
      srcG[index] = g;
      srcB[index] = b;

      const isBg = isBackgroundPixel(r, g, b, dark);
      backgroundMask[index] = isBg ? 1 : 0;

      if (isBg) {
        smoothBody[index] *= 0.70;
        edgeMap[index] *= 0.65;
        motionMap[index] *= 0.65;
        waveMap[index] *= 0.68;
        continue;
      }

      /* 图像处理 */
      const pr = processPixel(r);
      const pg = processPixel(g);
      const pb = processPixel(b);
      const luminance = (pr * 0.299 + pg * 0.587 + pb * 0.114) / 255;

      let body = dark ? luminance : 1 - luminance;
      body = Math.pow(body, 0.72);

      smoothBody[index] = smoothBody[index] * config.smoothing + body * (1 - config.smoothing);
    }
  }

  /* STEP 2 边缘 */
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < columns - 1; x++) {
      const index = y * columns + x;
      if (backgroundMask[index]) { edgeMap[index] *= 0.65; continue; }
      const left = smoothBody[y * columns + x - 1];
      const right = smoothBody[y * columns + x + 1];
      const top = smoothBody[(y - 1) * columns + x];
      const bottom = smoothBody[(y + 1) * columns + x];
      const gx = right - left;
      const gy = bottom - top;
      const edge = Math.sqrt(gx * gx + gy * gy);
      edgeMap[index] = edgeMap[index] * 0.72 + Math.min(edge * 4.5, 1) * 0.28;
    }
  }

  /* STEP 3 运动 */
  for (let i = 0; i < smoothBody.length; i++) {
    if (backgroundMask[i]) { motionMap[i] *= 0.65; previousBody[i] = smoothBody[i]; continue; }
    const motion = Math.abs(smoothBody[i] - previousBody[i]);
    motionMap[i] = motionMap[i] * 0.84 + Math.min(motion * 10, 1) * 0.16;
    previousBody[i] = smoothBody[i];
  }

  /* STEP 4 合成 */
  for (let i = 0; i < waveMap.length; i++) {
    if (backgroundMask[i]) {
      waveMap[i] *= 0.65;
      if (waveMap[i] < 0.02) waveMap[i] = 0;
      continue;
    }
    const body = smoothBody[i];
    const edge = edgeMap[i];
    const motion = motionMap[i];
    let value = body * 0.60 + edge * 0.33 + motion * 0.07;
    value = Math.pow(value, 0.82);
    value = Math.min(value, 1);
    if (value < config.waveThreshold * 0.7) value = 0;
    waveMap[i] = waveMap[i] * 0.78 + value * 0.22;
  }

  /* STEP 5 抖动（Floyd-Steinberg 需要独立 pass） */
  if (config.dithering === "floydsteinberg") {
    floydSteinberg();
  }
}

/* Floyd-Steinberg 抖动：对 waveMap 做误差扩散 */
function floydSteinberg() {
  const size = columns * rows;
  const buf = new Float32Array(waveMap);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      if (backgroundMask[i]) continue;
      const oldVal = buf[i];
      const newVal = oldVal >= 0.5 ? 1 : 0;
      const err = oldVal - newVal;
      buf[i] = newVal;
      if (x + 1 < columns) buf[i + 1] += err * 7 / 16;
      if (y + 1 < rows) {
        if (x - 1 >= 0) buf[i + columns - 1] += err * 3 / 16;
        buf[i + columns] += err * 5 / 16;
        if (x + 1 < columns) buf[i + columns + 1] += err * 1 / 16;
      }
    }
  }
  for (let i = 0; i < size; i++) {
    if (!backgroundMask[i]) waveMap[i] = buf[i];
  }
}

/* =========================================================
   图片专用渲染管线
   针对静态图片优化：直方图拉伸拉满明暗对比、
   全覆盖字符映射（不再稀疏）、浮雕光影增强层次、
   支持抖动算法。视频仍走原有 wave 管线，互不影响。
========================================================= */

function buildImageLut() {
  const hist = new Uint32Array(256);
  for (let i = 0; i < srcL.length; i++) hist[srcL[i]]++;
  /* 1% 截断的直方图拉伸，把有效亮度范围拉满 0~255 */
  let lo = 0, hi = 255;
  const total = srcL.length;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(clamp((v - lo) / range, 0, 1) * 255);
  imgLut = lut;
}

function imageAnalyse() {
  drawCover();
  const id = sourceCtx.getImageData(0, 0, columns, rows);
  const px = id.data;
  for (let i = 0; i < columns * rows; i++) {
    const pi = i * 4;
    srcR[i] = px[pi]; srcG[i] = px[pi + 1]; srcB[i] = px[pi + 2];
  }
  buildImageLut();
  for (let i = 0; i < srcL.length; i++) {
    srcL[i] = imgLut[processPixel((srcR[i] * 0.299 + srcG[i] * 0.587 + srcB[i] * 0.114) | 0)];
  }
  /* 浮雕光影：模拟左上光源，增强立体层次 */
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      const l = x > 0 ? srcL[i - 1] : srcL[i];
      const r = x < columns - 1 ? srcL[i + 1] : srcL[i];
      const t = y > 0 ? srcL[i - columns] : srcL[i];
      const b = y < rows - 1 ? srcL[i + columns] : srcL[i];
      const shade = (l + t) * 0.5 - (r + b) * 0.5;
      imgShade[i] = clamp(srcL[i] + shade * 1.6, 0, 255);
    }
  }
  /* 抖动 pass：输出 darkness 0~1（1=最暗） */
  const steps = Math.max(2, config.tonalSteps);
  const size = columns * rows;
  if (config.dithering === "floydsteinberg") {
    const buf = new Float32Array(size);
    for (let i = 0; i < size; i++) buf[i] = 1 - imgShade[i] / 255;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = y * columns + x;
        const old = buf[i];
        const q = Math.round(old * (steps - 1)) / (steps - 1);
        const err = old - q;
        buf[i] = q;
        if (x + 1 < columns) buf[i + 1] += err * 7 / 16;
        if (y + 1 < rows) {
          if (x - 1 >= 0) buf[i + columns - 1] += err * 3 / 16;
          buf[i + columns] += err * 5 / 16;
          if (x + 1 < columns) buf[i + columns + 1] += err * 1 / 16;
        }
      }
    }
    for (let i = 0; i < size; i++) imgLevel[i] = buf[i];
  } else {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = y * columns + x;
        let dark = 1 - imgShade[i] / 255;
        if (config.dithering === "bayer4x4") dark = clamp(dark + (bayerThreshold(x, y) - 0.5) / steps, 0, 1);
        imgLevel[i] = Math.round(dark * (steps - 1)) / (steps - 1);
      }
    }
  }
}

/* 图片字符映射：全覆盖，暗→重字符，亮→轻字符 */
function getImageCharacter(darkness, x, y) {
  const chars = config.charset;
  if (!chars) return ".";
  const idx = Math.min(chars.length - 1, Math.max(0, Math.round(darkness * (chars.length - 1))));
  return chars[idx];
}

/* 图片专用绘制：每个网格单元都绘制一个字符（全覆盖，明暗即层次） */
function drawImageAscii(time) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = config.bgColor;
  ctx.fillRect(0, 0, width, height);

  ctx.font = config.fontSize + "px " + config.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const solidColor = hexToRgb(config.charColor);
  const tintColor = hexToRgb(config.tint);
  const tintAmt = config.tintAmount / 100;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      const darkness = imgLevel[i];

      const revealAlpha = getRevealAlpha(x, y, time);
      if (revealAlpha <= 0) continue;
      const anim = getAnimEffect(x, y, 1 - darkness, time);
      if (anim.opacityMul <= 0) continue;

      const char = anim.charOverride || getImageCharacter(darkness, x, y);

      let cr, cg, cb;
      if (config.colorMode === "source") {
        cr = srcR[i]; cg = srcG[i]; cb = srcB[i];
      } else {
        cr = solidColor.r; cg = solidColor.g; cb = solidColor.b;
      }
      if (tintAmt > 0) {
        cr = lerp(cr, tintColor.r, tintAmt);
        cg = lerp(cg, tintColor.g, tintAmt);
        cb = lerp(cb, tintColor.b, tintAmt);
      }

      /* 逐字符透明度：暗部浓、亮部淡，形成连续明暗层次 */
      const baseOpacity = 0.16 + darkness * 0.84;
      const opacity = baseOpacity * anim.opacityMul * revealAlpha;
      if (opacity < 0.01) continue;

      const bx = x * config.cellWidth + config.cellWidth / 2 + anim.offsetX;
      const by = y * config.cellHeight + config.cellHeight / 2 + anim.offsetY;
      ctx.fillStyle = "rgba(" + Math.round(cr) + "," + Math.round(cg) + "," + Math.round(cb) + "," + opacity.toFixed(3) + ")";
      ctx.fillText(char, bx, by);
    }
  }
}

/* =========================================================
   获取 Wave 值
========================================================= */

function getWaveValue(x, y) {
  if (x < 0 || x >= columns || y < 0 || y >= rows) return 0;
  return waveMap[y * columns + x];
}

/* =========================================================
   稳定哈希
========================================================= */

function stableHash(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/* =========================================================
   字符选择（含色调步长 + 抖动）
========================================================= */

function getCharacter(strength, x, y) {
  const chars = config.charset;
  if (!chars) return ".";

  /* 抖动偏移 */
  let ditherOffset = 0;
  if (config.dithering === "bayer4x4") {
    ditherOffset = (bayerThreshold(x, y) - 0.5) * 0.15;
  }

  let normalized = (strength + ditherOffset - config.waveThreshold) / (0.78 - config.waveThreshold);
  normalized = clamp(normalized, 0, 1);
  normalized = Math.pow(normalized, 0.68);

  /* 色调步长：量化到离散级别 */
  const steps = config.tonalSteps;
  const quantized = Math.round(normalized * (steps - 1)) / (steps - 1);

  const idx = Math.min(chars.length - 1, Math.floor(quantized * chars.length));
  return chars[idx];
}

/* =========================================================
   动画效果计算
   返回 { opacityMul, offsetX, offsetY, charOverride }
========================================================= */

function getAnimEffect(x, y, strength, time) {
  const t = time * config.animSpeed;
  const type = config.animType;

  if (type === "none") return { opacityMul: 1, offsetX: 0, offsetY: 0, charOverride: null };

  if (type === "fadein") {
    /* 淡入：整体透明度随时间从 0 到 1，2 秒完成 */
    const fade = clamp(t / 2, 0, 1);
    return { opacityMul: fade, offsetX: 0, offsetY: 0, charOverride: null };
  }

  if (type === "scanline") {
    /* 扫描线：一条亮带从上到下循环 */
    const scanY = (t * 0.3) % 1;
    const dist = Math.abs(y / rows - scanY);
    const band = Math.max(0, 1 - dist * 8);
    return { opacityMul: 0.3 + band * 0.7, offsetX: 0, offsetY: 0, charOverride: null };
  }

  if (type === "flicker") {
    /* 闪烁：随机抖动透明度 */
    const flicker = 0.7 + 0.3 * Math.sin(t * 15 + x * 0.5 + y * 0.3);
    return { opacityMul: flicker, offsetX: 0, offsetY: 0, charOverride: null };
  }

  if (type === "wave") {
    /* 波浪：Y 轴正弦偏移 */
    const waveY = Math.sin(x * 0.1 + t * 2) * 3;
    return { opacityMul: 1, offsetX: 0, offsetY: waveY, charOverride: null };
  }

  if (type === "glitch") {
    /* 故障：随机水平偏移 + 偶尔换字符 */
    const glitchSeed = Math.floor(t * 5);
    const h = stableHash(glitchSeed, y);
    let offsetX = 0;
    let charOverride = null;
    if (h > 0.92) {
      offsetX = (h - 0.92) * 40 * (stableHash(glitchSeed, x) - 0.5) * 2;
      if (stableHash(glitchSeed + 1, x) > 0.8) {
        const chars = config.charset;
        charOverride = chars[Math.floor(stableHash(glitchSeed + 2, y) * chars.length)];
      }
    }
    return { opacityMul: 1, offsetX, offsetY: 0, charOverride };
  }

  return { opacityMul: 1, offsetX: 0, offsetY: 0, charOverride: null };
}

/* =========================================================
   揭示效果
   返回 0~1 的可见度
========================================================= */

function getRevealAlpha(x, y, time) {
  const type = config.reveal;
  if (type === "none") return 1;

  const elapsed = (time - mediaLoadTime) * config.animSpeed;
  const progress = clamp(elapsed / 2, 0, 1); /* 2 秒完成揭示 */

  const nx = x / columns;
  const ny = y / rows;

  if (type === "center") {
    const dist = Math.sqrt(Math.pow(nx - 0.5, 2) + Math.pow(ny - 0.5, 2)) * 2;
    return clamp(progress * 1.5 - dist * 0.5, 0, 1);
  }

  if (type === "top") {
    return clamp(progress * 1.2 - ny * 0.2, 0, 1);
  }

  if (type === "edges") {
    const distFromEdge = Math.min(nx, 1 - nx, ny, 1 - ny) * 2;
    return clamp(progress * 1.5 - distFromEdge * 0.5, 0, 1);
  }

  return 1;
}

/* =========================================================
   绘制 ASCII
========================================================= */

function drawAscii(time) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = config.bgColor;
  ctx.fillRect(0, 0, width, height);

  ctx.font = config.fontSize + "px " + config.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const solidColor = hexToRgb(config.charColor);
  const tintColor = hexToRgb(config.tint);
  const tintAmt = config.tintAmount / 100;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const index = y * columns + x;

      if (backgroundMask[index] && waveMap[index] < config.waveThreshold) continue;

      const strength = waveMap[index];
      if (strength < config.waveThreshold) continue;

      /* 揭示效果 */
      const revealAlpha = getRevealAlpha(x, y, time);
      if (revealAlpha <= 0) continue;

      /* 动画效果 */
      const anim = getAnimEffect(x, y, strength, time);
      if (anim.opacityMul <= 0) continue;

      const left = getWaveValue(x - 1, y);
      const right = getWaveValue(x + 1, y);
      const top = getWaveValue(x, y - 1);
      const bottom = getWaveValue(x, y + 1);

      const localDiff = (
        Math.abs(strength - left) +
        Math.abs(strength - right) +
        Math.abs(strength - top) +
        Math.abs(strength - bottom)
      ) / 4;

      let density = 0.14 + Math.pow(strength, 0.65) * 0.82;
      density += localDiff * 0.32;
      density = Math.min(density, 1);

      const hash = stableHash(x, y);
      if (hash > density) continue;

      const char = anim.charOverride || getCharacter(strength, x, y);

      const baseX = x * config.cellWidth + config.cellWidth / 2;
      const baseY = y * config.cellHeight + config.cellHeight / 2;

      const gradientX = right - left;
      const gradientY = bottom - top;
      const normStrength = clamp(strength, 0, 1);
      const depthCount = Math.max(1, Math.round(1 + normStrength * (config.depthLayers - 1)));

      /* 计算颜色 */
      let cr, cg, cb;
      if (config.colorMode === "source") {
        cr = srcR[index];
        cg = srcG[index];
        cb = srcB[index];
      } else {
        cr = solidColor.r;
        cg = solidColor.g;
        cb = solidColor.b;
      }

      /* 色调叠加 */
      if (tintAmt > 0) {
        cr = lerp(cr, tintColor.r, tintAmt);
        cg = lerp(cg, tintColor.g, tintAmt);
        cb = lerp(cb, tintColor.b, tintAmt);
      }

      for (let layer = depthCount - 1; layer >= 0; layer--) {
        const depth = layer / Math.max(depthCount - 1, 1);
        const offsetX = gradientX * layer * config.depthX * 7 + anim.offsetX;
        const offsetY = layer * config.depthY + gradientY * layer * 4 + anim.offsetY;

        const baseOpacity = Math.min(0.14 + Math.pow(strength, 0.62) * 0.95, 1);
        const opacity = baseOpacity * (1 - depth * 0.58) * anim.opacityMul * revealAlpha;

        if (opacity < 0.01) continue;

        ctx.fillStyle = "rgba(" + Math.round(cr) + "," + Math.round(cg) + "," + Math.round(cb) + "," + opacity.toFixed(3) + ")";
        ctx.fillText(char, baseX + offsetX, baseY + offsetY);
      }
    }
  }
}

/* =========================================================
   动画循环
========================================================= */

let rafId = null;
let lastFrameTime = 0;
let running = false;
let startTime = 0;

function frame(timestamp) {
  if (!running) return;
  if (!startTime) startTime = timestamp;

  const frameInterval = 1000 / config.fps;
  if (timestamp - lastFrameTime >= frameInterval) {
    lastFrameTime = timestamp;
    if (mediaReady) {
      analyse();
      drawAscii((timestamp - startTime) / 1000);
    }
  }
  rafId = requestAnimationFrame(frame);
}

function startLoop() {
  if (running) return;
  running = true;
  lastFrameTime = 0;
  startTime = 0;
  rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  running = false;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function renderStatic() {
  if (!mediaReady) return;
  if (mediaType === "image") {
    imageAnalyse();
    /* 静态图：揭示效果用 100 秒让 progress=1 */
    drawImageAscii(100);
    return;
  }
  for (let i = 0; i < 12; i++) analyse();
  /* 静态图：揭示效果用 100 秒让 progress=1 */
  drawAscii(100);
}

/* =========================================================
   媒体加载
========================================================= */

function setPlaceholder(show) {
  document.getElementById("preview-placeholder").classList.toggle("hidden", !show);
}

function clearMedia() {
  stopLoop();
  mediaType = null;
  mediaReady = false;
  mediaUrl = "";
  mediaFile = null;
  mediaName = "";
  video.pause();
  video.removeAttribute("src");
  video.load();
  image.removeAttribute("src");
  document.getElementById("file-info").classList.add("hidden");
  document.getElementById("btn-export").disabled = true;
  document.getElementById("btn-replay").disabled = true;
  document.getElementById("btn-record").disabled = true;
  document.getElementById("btn-download-image").disabled = true;
  const container = document.getElementById("preview-container");
  container.style.width = "100%";
  container.style.height = "100%";
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = config.bgColor;
  ctx.fillRect(0, 0, width, height);
  setPlaceholder(true);
}

function loadFile(file) {
  if (!file) return;
  const isVideo = file.type.startsWith("video");
  const isImage = file.type.startsWith("image");
  if (!isVideo && !isImage) {
    alert("请选择图片或视频文件");
    return;
  }
  clearMedia();
  mediaFile = file;
  mediaName = file.name;
  mediaUrl = URL.createObjectURL(file);
  document.getElementById("file-name").textContent = file.name;
  document.getElementById("file-info").classList.remove("hidden");

  if (isVideo) {
    mediaType = "video";
    video.src = mediaUrl;
    video.loop = config.loop;
    video.addEventListener("loadeddata", onVideoReady, { once: true });
    video.play().catch(() => {});
  } else {
    mediaType = "image";
    image.src = mediaUrl;
    image.addEventListener("load", onImageReady, { once: true });
  }
}

function onVideoReady() {
  mediaReady = true;
  mediaLoadTime = 0;
  fitContainerToMedia();
  rebuildGrid();
  setPlaceholder(false);
  document.getElementById("btn-export").disabled = false;
  document.getElementById("btn-replay").disabled = false;
  document.getElementById("btn-record").disabled = false;
  document.getElementById("btn-download-image").disabled = true;
  startLoop();
}

function onImageReady() {
  mediaReady = true;
  mediaLoadTime = 0;
  /* 图片默认使用源色，让明暗层次更直观（用户仍可手动切换） */
  config.colorMode = "source";
  const cm = document.getElementById("ctrl-color-mode");
  if (cm) cm.value = "source";
  fitContainerToMedia();
  rebuildGrid();
  setPlaceholder(false);
  document.getElementById("btn-export").disabled = false;
  document.getElementById("btn-replay").disabled = true;
  document.getElementById("btn-record").disabled = true;
  document.getElementById("btn-download-image").disabled = false;
  renderStatic();
}

function replay() {
  if (mediaType === "video") {
    video.currentTime = 0;
    video.play().catch(() => {});
    mediaLoadTime = 0;
    startTime = 0;
  } else if (mediaType === "image") {
    mediaLoadTime = 0;
    renderStatic();
  }
}

/* =========================================================
   导出独立 HTML
========================================================= */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/*
  根据当前 ASCII 网格计算导出视频的合适分辨率。
  ASCII 实际只采样 columns × rows 个像素，
  导出视频取约 2 倍采样分辨率以保证效果，
  并限制上限避免过大。
*/
function computeTargetSize() {
  const scale = 2;
  let w = Math.round(columns * scale);
  let h = Math.round(rows * scale);
  w = Math.max(2, w - (w % 2));
  h = Math.max(2, h - (h % 2));
  const maxDim = 1280;
  if (w > maxDim || h > maxDim) {
    const r = Math.min(maxDim / w, maxDim / h);
    w = Math.max(2, Math.round((w * r) / 2) * 2);
    h = Math.max(2, Math.round((h * r) / 2) * 2);
  }
  return { w, h };
}

/*
  在浏览器端把视频重编码为轻量版本：
  - 分辨率降到 ASCII 采样需求（略高）
  - 彻底去除音频（只录 canvas 画面流）
  - 帧率用当前 ASCII 渲染帧率
  - 按分辨率估算码率
  返回 { blob, targetW, targetH, fps, mime }，失败返回 null。
*/
async function optimizeVideo(onProgress) {
  if (!video.videoWidth || !video.duration) return null;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
  const mime = pickMime();
  if (!mime) return null;

  const target = computeTargetSize();
  const targetW = target.w;
  const targetH = target.h;
  const fps = config.fps;
  const bitrate = Math.min(
    Math.max(targetW * targetH * fps * 0.12, 200000),
    2500000
  );

  const oc = document.createElement("canvas");
  oc.width = targetW;
  oc.height = targetH;
  const octx = oc.getContext("2d");

  const stream = oc.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: bitrate
  });
  const chunks = [];
  recorder.ondataavailable = e => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise(r => { recorder.onstop = r; });

  const duration = Math.min(video.duration, 30);
  const savedLoop = video.loop;
  const savedTime = video.currentTime;

  try {
    video.pause();
    video.loop = false;
    video.currentTime = 0;
    await new Promise(r => {
      const h = () => { video.removeEventListener("seeked", h); r(); };
      video.addEventListener("seeked", h);
      setTimeout(r, 1200);
    });

    recorder.start(100);

    await new Promise(resolve => {
      let raf = null;
      const tick = () => {
        octx.drawImage(video, 0, 0, targetW, targetH);
        if (onProgress) onProgress(Math.min(video.currentTime / duration, 1));
        if (video.ended) { resolve(); return; }
        raf = requestAnimationFrame(tick);
      };
      video.onended = () => {
        if (raf) cancelAnimationFrame(raf);
        resolve();
      };
      setTimeout(() => {
        if (raf) cancelAnimationFrame(raf);
        resolve();
      }, (duration + 6) * 1000);
      video.play().then(() => {
        raf = requestAnimationFrame(tick);
      }).catch(() => resolve());
    });

    await new Promise(r => setTimeout(r, 250));
    if (recorder.state === "recording") recorder.stop();
    await stopped;
  } finally {
    stream.getTracks().forEach(t => t.stop());
    video.loop = savedLoop;
    try { video.currentTime = savedTime; } catch (e) {}
  }

  if (!chunks.length) return null;
  const blob = new Blob(chunks, { type: mime });
  return { blob, targetW, targetH, fps, mime };
}

/*
  把图片降采样到 ASCII 采样需求分辨率并重新编码。
  返回 dataURL，失败返回 null。
*/
function optimizeImage() {
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  if (!iw || !ih) return null;
  const scale = 2;
  let w = Math.round(columns * scale);
  let h = Math.round(rows * scale);
  const maxDim = 1600;
  if (w > maxDim || h > maxDim) {
    const r = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * r);
    h = Math.round(h * r);
  }
  const oc = document.createElement("canvas");
  oc.width = w;
  oc.height = h;
  const octx = oc.getContext("2d");
  octx.drawImage(image, 0, 0, w, h);
  const isPng = mediaFile.type === "image/png";
  return isPng
    ? oc.toDataURL("image/png")
    : oc.toDataURL("image/jpeg", 0.85);
}

/*
  轻量 minify：只删 HTML 注释、合并多余空行。
  不碰 <script> 里的 base64 数据，避免破坏。
*/
function minifyHtml(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/\n\s*\n/g, "\n");
  return html;
}

async function exportCode() {
  if (!mediaReady) return;
  const btn = document.getElementById("btn-export");
  const origText = btn.textContent;
  btn.disabled = true;
  let mediaData, mediaMime;
  try {
    if (mediaType === "video") {
      btn.textContent = "优化视频 0%";
      const result = await optimizeVideo(p => {
        btn.textContent = "优化视频 " + Math.round(p * 100) + "%";
      });
      if (result) {
        mediaData = await blobToDataUrl(result.blob);
        mediaMime = result.mime;
      } else {
        mediaData = await fileToBase64(mediaFile);
        mediaMime = mediaFile.type;
      }
    } else {
      btn.textContent = "优化图片…";
      const dataUrl = optimizeImage();
      if (dataUrl) {
        mediaData = dataUrl;
        mediaMime = mediaFile.type;
      } else {
        mediaData = await fileToBase64(mediaFile);
        mediaMime = mediaFile.type;
      }
    }
    btn.textContent = "生成 HTML…";
    const html = minifyHtml(buildExportHtml(mediaData, mediaMime));
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ascii-art.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Export failed:", err);
    alert("导出失败：" + err.message);
  } finally {
    btn.textContent = origText;
    btn.disabled = !mediaReady;
  }
}

function buildExportHtml(mediaData, mediaMime) {
  const isVideo = mediaMime.startsWith("video");
  const isImage = mediaMime.startsWith("image");
  const mediaTag = isVideo
    ? `<video id="media" src="${mediaData}" autoplay muted loop playsinline></video>`
    : `<img id="media" src="${mediaData}">`;
  const cfg = JSON.stringify(config);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ASCII</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{background:${config.bgColor}}
#canvas{position:fixed;top:0;left:0;width:100%;height:100%}
#media{position:fixed;width:1px;height:1px;opacity:0;pointer-events:none}
</style>
</head>
<body>
${mediaTag}
<canvas id="canvas"></canvas>
<script>
(function(){
const config=${cfg};
const CHARSET_PRESETS=${JSON.stringify(CHARSET_PRESETS)};
const BAYER4x4=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
const media=document.getElementById("media");
const canvas=document.getElementById("canvas");
const ctx=canvas.getContext("2d");
const sourceCanvas=document.createElement("canvas");
const sourceCtx=sourceCanvas.getContext("2d",{willReadFrequently:true});
let width=0,height=0,columns=0,rows=0;
let smoothBody,previousBody,edgeMap,motionMap,waveMap,backgroundMask,srcR,srcG,srcB,srcL,imgShade,imgLevel,imgLut;
function hexToRgb(h){h=h.replace("#","");return{r:parseInt(h.substring(0,2),16),g:parseInt(h.substring(2,4),16),b:parseInt(h.substring(4,6),16)}}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v))}
function lerp(a,b,t){return a+(b-a)*t}
function resizeCanvas(){
const dpr=window.devicePixelRatio||1;
width=window.innerWidth;height=window.innerHeight;
canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
canvas.style.width=width+"px";canvas.style.height=height+"px";
ctx.setTransform(dpr,0,0,dpr,0,0);
columns=Math.max(1,Math.ceil(width/config.cellWidth));
rows=Math.max(1,Math.ceil(height/config.cellHeight));
sourceCanvas.width=columns;sourceCanvas.height=rows;
const s=columns*rows;
smoothBody=new Float32Array(s);previousBody=new Float32Array(s);
edgeMap=new Float32Array(s);motionMap=new Float32Array(s);waveMap=new Float32Array(s);
backgroundMask=new Uint8Array(s);srcR=new Uint8ClampedArray(s);srcG=new Uint8ClampedArray(s);srcB=new Uint8ClampedArray(s);srcL=new Uint8ClampedArray(s);imgShade=new Uint8ClampedArray(s);imgLevel=new Float32Array(s);
}
function buildImageLut(){
const hist=new Uint32Array(256);
for(let i=0;i<srcL.length;i++)hist[srcL[i]]++;
let lo=0,hi=255;const total=srcL.length;let acc=0;
for(let v=0;v<256;v++){acc+=hist[v];if(acc>=total*0.01){lo=v;break}}
acc=0;
for(let v=255;v>=0;v--){acc+=hist[v];if(acc>=total*0.01){hi=v;break}}
const range=Math.max(1,hi-lo);
const lut=new Uint8ClampedArray(256);
for(let v=0;v<256;v++)lut[v]=Math.round(clamp((v-lo)/range,0,1)*255);
imgLut=lut;
}
function imageAnalyse(){
drawCover();
const id=sourceCtx.getImageData(0,0,columns,rows);
const px=id.data;
for(let i=0;i<columns*rows;i++){const pi=i*4;srcR[i]=px[pi];srcG[i]=px[pi+1];srcB[i]=px[pi+2]}
buildImageLut();
for(let i=0;i<srcL.length;i++)srcL[i]=imgLut[processPixel((srcR[i]*0.299+srcG[i]*0.587+srcB[i]*0.114)|0)];
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;
const l=x>0?srcL[i-1]:srcL[i],r=x<columns-1?srcL[i+1]:srcL[i],t=y>0?srcL[i-columns]:srcL[i],b=y<rows-1?srcL[i+columns]:srcL[i];
const shade=(l+t)*0.5-(r+b)*0.5;
imgShade[i]=clamp(srcL[i]+shade*1.6,0,255);
}}
const steps=Math.max(2,config.tonalSteps);const size=columns*rows;
if(config.dithering==="floydsteinberg"){
const buf=new Float32Array(size);
for(let i=0;i<size;i++)buf[i]=1-imgShade[i]/255;
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;const old=buf[i];const q=Math.round(old*(steps-1))/(steps-1);const err=old-q;buf[i]=q;
if(x+1<columns)buf[i+1]+=err*7/16;
if(y+1<rows){if(x-1>=0)buf[i+columns-1]+=err*3/16;buf[i+columns]+=err*5/16;if(x+1<columns)buf[i+columns+1]+=err*1/16}
}}
for(let i=0;i<size;i++)imgLevel[i]=buf[i];
}else{
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;let dark=1-imgShade[i]/255;
if(config.dithering==="bayer4x4")dark=clamp(dark+(bayerThreshold(x,y)-0.5)/steps,0,1);
imgLevel[i]=Math.round(dark*(steps-1))/(steps-1);
}}
}
}
function getImageCharacter(darkness){
const chars=config.charset;if(!chars)return".";
return chars[Math.min(chars.length-1,Math.max(0,Math.round(darkness*(chars.length-1))))];
}
function drawImageAscii(time){
ctx.clearRect(0,0,width,height);
ctx.fillStyle=config.bgColor;ctx.fillRect(0,0,width,height);
ctx.font=config.fontSize+"px "+config.font;
ctx.textAlign="center";ctx.textBaseline="middle";
const sc=hexToRgb(config.charColor);
const tc=hexToRgb(config.tint);
const ta=config.tintAmount/100;
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;
const darkness=imgLevel[i];
const ra=getRevealAlpha(x,y,time);if(ra<=0)continue;
const anim=getAnimEffect(x,y,1-darkness,time);if(anim.opacityMul<=0)continue;
const char=anim.charOverride||getImageCharacter(darkness);
let cr,cg,cb;
if(config.colorMode==="source"){cr=srcR[i];cg=srcG[i];cb=srcB[i]}
else{cr=sc.r;cg=sc.g;cb=sc.b}
if(ta>0){cr=lerp(cr,tc.r,ta);cg=lerp(cg,tc.g,ta);cb=lerp(cb,tc.b,ta)}
const bo=0.16+darkness*0.84;
const op=bo*anim.opacityMul*ra;
if(op<0.01)continue;
const bx=x*config.cellWidth+config.cellWidth/2+anim.offsetX;
const by=y*config.cellHeight+config.cellHeight/2+anim.offsetY;
ctx.fillStyle="rgba("+Math.round(cr)+","+Math.round(cg)+","+Math.round(cb)+","+op.toFixed(3)+")";
ctx.fillText(char,bx,by);
}}
}
function drawCover(){
const vw=media.videoWidth||media.naturalWidth;
const vh=media.videoHeight||media.naturalHeight;
if(!vw||!vh)return;
sourceCtx.drawImage(media,0,0,vw,vh,0,0,columns,rows);
}
function processPixel(v){
v=v*(config.brightness/100);
const c=config.contrast/100;v=(v-128)*c+128;
v=Math.pow(clamp(v/255,0,1),1/config.gamma)*255;
if(config.invert)v=255-v;
return clamp(v,0,255);
}
function isBackgroundPixel(r,g,b,dark){
const br=(r+g+b)/3/255;
if(dark){const dd=Math.sqrt(r*r+g*g+b*b);return br<config.darkThreshold&&dd<config.darkDistance}
const wd=Math.sqrt(Math.pow(255-r,2)+Math.pow(255-g,2)+Math.pow(255-b,2));
return br>config.whiteThreshold&&wd<config.whiteDistance;
}
function bayerThreshold(x,y){return(BAYER4x4[y%4][x%4]+0.5)/16}
function floydSteinberg(){
const s=columns*rows;const buf=new Float32Array(waveMap);
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;if(backgroundMask[i])continue;
const old=buf[i];const nw=old>=0.5?1:0;const err=old-nw;buf[i]=nw;
if(x+1<columns)buf[i+1]+=err*7/16;
if(y+1<rows){if(x-1>=0)buf[i+columns-1]+=err*3/16;buf[i+columns]+=err*5/16;if(x+1<columns)buf[i+columns+1]+=err*1/16}
}}
for(let i=0;i<s;i++){if(!backgroundMask[i])waveMap[i]=buf[i]}
}
function analyse(){
drawCover();
const id=sourceCtx.getImageData(0,0,columns,rows);
const px=id.data;
let dark=false;
if(config.bgMode==="black")dark=true;
else if(config.bgMode==="white")dark=false;
else{let sum=0;for(let i=0;i<px.length;i+=4)sum+=px[i]*0.299+px[i+1]*0.587+px[i+2]*0.114;dark=sum/(px.length/4)/255<0.5}
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;const pi=i*4;
const r=px[pi],g=px[pi+1],b=px[pi+2];
srcR[i]=r;srcG[i]=g;srcB[i]=b;
const isBg=isBackgroundPixel(r,g,b,dark);
backgroundMask[i]=isBg?1:0;
if(isBg){smoothBody[i]*=0.7;edgeMap[i]*=0.65;motionMap[i]*=0.65;waveMap[i]*=0.68;continue}
const pr=processPixel(r),pg=processPixel(g),pb=processPixel(b);
const lum=(pr*0.299+pg*0.587+pb*0.114)/255;
let body=dark?lum:1-lum;body=Math.pow(body,0.72);
smoothBody[i]=smoothBody[i]*config.smoothing+body*(1-config.smoothing);
}}
for(let y=1;y<rows-1;y++){for(let x=1;x<columns-1;x++){
const i=y*columns+x;if(backgroundMask[i]){edgeMap[i]*=0.65;continue}
const l=smoothBody[y*columns+x-1],r2=smoothBody[y*columns+x+1];
const t=smoothBody[(y-1)*columns+x],b2=smoothBody[(y+1)*columns+x];
const gx=r2-l,gy=b2-t;const edge=Math.sqrt(gx*gx+gy*gy);
edgeMap[i]=edgeMap[i]*0.72+Math.min(edge*4.5,1)*0.28;
}}
for(let i=0;i<smoothBody.length;i++){
if(backgroundMask[i]){motionMap[i]*=0.65;previousBody[i]=smoothBody[i];continue}
const m=Math.abs(smoothBody[i]-previousBody[i]);
motionMap[i]=motionMap[i]*0.84+Math.min(m*10,1)*0.16;
previousBody[i]=smoothBody[i];
}
for(let i=0;i<waveMap.length;i++){
if(backgroundMask[i]){waveMap[i]*=0.65;if(waveMap[i]<0.02)waveMap[i]=0;continue}
const body=smoothBody[i],edge=edgeMap[i],motion=motionMap[i];
let v=body*0.6+edge*0.33+motion*0.07;v=Math.pow(v,0.82);v=Math.min(v,1);
if(v<config.waveThreshold*0.7)v=0;
waveMap[i]=waveMap[i]*0.78+v*0.22;
}
if(config.dithering==="floydsteinberg")floydSteinberg();
}
function getWaveValue(x,y){if(x<0||x>=columns||y<0||y>=rows)return 0;return waveMap[y*columns+x]}
function stableHash(x,y){const v=Math.sin(x*12.9898+y*78.233)*43758.5453;return v-Math.floor(v)}
function getCharacter(strength,x,y){
const chars=config.charset;if(!chars)return".";
let d=0;if(config.dithering==="bayer4x4")d=(bayerThreshold(x,y)-0.5)*0.15;
let n=(strength+d-config.waveThreshold)/(0.78-config.waveThreshold);
n=clamp(n,0,1);n=Math.pow(n,0.68);
const steps=config.tonalSteps;
const q=Math.round(n*(steps-1))/(steps-1);
return chars[Math.min(chars.length-1,Math.floor(q*chars.length))];
}
function getAnimEffect(x,y,strength,time){
const t=time*config.animSpeed;const type=config.animType;
if(type==="none")return{opacityMul:1,offsetX:0,offsetY:0,charOverride:null};
if(type==="fadein"){return{opacityMul:clamp(t/2,0,1),offsetX:0,offsetY:0,charOverride:null}}
if(type==="scanline"){const sy=(t*0.3)%1;const dist=Math.abs(y/rows-sy);const band=Math.max(0,1-dist*8);return{opacityMul:0.3+band*0.7,offsetX:0,offsetY:0,charOverride:null}}
if(type==="flicker"){return{opacityMul:0.7+0.3*Math.sin(t*15+x*0.5+y*0.3),offsetX:0,offsetY:0,charOverride:null}}
if(type==="wave"){return{opacityMul:1,offsetX:0,offsetY:Math.sin(x*0.1+t*2)*3,charOverride:null}}
if(type==="glitch"){
const gs=Math.floor(t*5);const h=stableHash(gs,y);
let ox=0,co=null;
if(h>0.92){ox=(h-0.92)*40*(stableHash(gs,x)-0.5)*2;if(stableHash(gs+1,x)>0.8){const chars=config.charset;co=chars[Math.floor(stableHash(gs+2,y)*chars.length)]}}
return{opacityMul:1,offsetX:ox,offsetY:0,charOverride:co}
}
return{opacityMul:1,offsetX:0,offsetY:0,charOverride:null};
}
function getRevealAlpha(x,y,time){
const type=config.reveal;if(type==="none")return 1;
const elapsed=(time-0)*config.animSpeed;
const progress=clamp(elapsed/2,0,1);
const nx=x/columns,ny=y/rows;
if(type==="center"){const d=Math.sqrt(Math.pow(nx-0.5,2)+Math.pow(ny-0.5,2))*2;return clamp(progress*1.5-d*0.5,0,1)}
if(type==="top"){return clamp(progress*1.2-ny*0.2,0,1)}
if(type==="edges"){const d=Math.min(nx,1-nx,ny,1-ny)*2;return clamp(progress*1.5-d*0.5,0,1)}
return 1;
}
function drawAscii(time){
ctx.clearRect(0,0,width,height);
ctx.fillStyle=config.bgColor;ctx.fillRect(0,0,width,height);
ctx.font=config.fontSize+"px "+config.font;
ctx.textAlign="center";ctx.textBaseline="middle";
const sc=hexToRgb(config.charColor);
const tc=hexToRgb(config.tint);
const ta=config.tintAmount/100;
for(let y=0;y<rows;y++){for(let x=0;x<columns;x++){
const i=y*columns+x;
if(backgroundMask[i]&&waveMap[i]<config.waveThreshold)continue;
const strength=waveMap[i];
if(strength<config.waveThreshold)continue;
const ra=getRevealAlpha(x,y,time);if(ra<=0)continue;
const anim=getAnimEffect(x,y,strength,time);if(anim.opacityMul<=0)continue;
const l=getWaveValue(x-1,y),r2=getWaveValue(x+1,y),t=getWaveValue(x,y-1),b2=getWaveValue(x,y+1);
const ld=(Math.abs(strength-l)+Math.abs(strength-r2)+Math.abs(strength-t)+Math.abs(strength-b2))/4;
let density=0.14+Math.pow(strength,0.65)*0.82+ld*0.32;density=Math.min(density,1);
const hash=stableHash(x,y);if(hash>density)continue;
const char=anim.charOverride||getCharacter(strength,x,y);
const bx=x*config.cellWidth+config.cellWidth/2;
const by=y*config.cellHeight+config.cellHeight/2;
const gx=r2-l,gy=b2-t;
const ns=clamp(strength,0,1);
const dc=Math.max(1,Math.round(1+ns*(config.depthLayers-1)));
let cr,cg,cb;
if(config.colorMode==="source"){cr=srcR[i];cg=srcG[i];cb=srcB[i]}
else{cr=sc.r;cg=sc.g;cb=sc.b}
if(ta>0){cr=lerp(cr,tc.r,ta);cg=lerp(cg,tc.g,ta);cb=lerp(cb,tc.b,ta)}
for(let layer=dc-1;layer>=0;layer--){
const depth=layer/Math.max(dc-1,1);
const ox=gx*layer*config.depthX*7+anim.offsetX;
const oy=layer*config.depthY+gy*layer*4+anim.offsetY;
const bo=Math.min(0.14+Math.pow(strength,0.62)*0.95,1);
const op=bo*(1-depth*0.58)*anim.opacityMul*ra;
if(op<0.01)continue;
ctx.fillStyle="rgba("+Math.round(cr)+","+Math.round(cg)+","+Math.round(cb)+","+op.toFixed(3)+")";
ctx.fillText(char,bx+ox,by+oy);
}
}}
}
resizeCanvas();
window.addEventListener("resize",resizeCanvas);
let lastFrameTime=0,startTime=0;
const frameInterval=1000/config.fps;
function frame(ts){
if(!startTime)startTime=ts;
if(ts-lastFrameTime>=frameInterval){lastFrameTime=ts;analyse();drawAscii((ts-startTime)/1000)}
requestAnimationFrame(frame);
}
function start(){
if(${isImage}){imageAnalyse();drawImageAscii(100);return}
requestAnimationFrame(frame);
}
if(${isVideo}){media.addEventListener("loadeddata",start,{once:true});media.play().catch(function(){})}
else{media.addEventListener("load",start,{once:true})}
})();
<\/script>
</body>
</html>`;
}

/* =========================================================
   下载视频
========================================================= */

let recording = false;

function pickMime() {
  const candidates = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (let i = 0; i < candidates.length; i++) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return "";
}

function recordVideo() {
  if (recording || !mediaReady || mediaType !== "video") return;
  if (!window.MediaRecorder || !canvas.captureStream) {
    alert("当前浏览器不支持录制视频（需要 Chrome / Edge / Firefox）");
    return;
  }
  const btn = document.getElementById("btn-record");
  const duration = parseInt(document.getElementById("ctrl-record-dur").value, 10) || 5;
  const mime = pickMime();
  const stream = canvas.captureStream(config.fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8000000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime || "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = mime.indexOf("mp4") >= 0 ? "ascii-art.mp4" : "ascii-art.webm";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    stream.getTracks().forEach(t => t.stop());
    recording = false;
    btn.textContent = "⬇ 下载视频";
    btn.disabled = !mediaReady || mediaType !== "video";
  };
  recording = true;
  btn.textContent = "⏺ 录制中 " + duration + "s…";
  btn.disabled = true;
  video.play().catch(() => {});
  recorder.start(100);
  setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, duration * 1000);
}

/* =========================================================
   导出图片
========================================================= */

function exportImage() {
  if (!mediaReady || mediaType !== "image") return;
  renderStatic();
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = "ascii-art.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* =========================================================
   UI 绑定
========================================================= */

function bindRange(ctrlId, valId, key, isInt) {
  const ctrl = document.getElementById(ctrlId);
  const val = document.getElementById(valId);
  ctrl.addEventListener("input", () => {
    let v = parseFloat(ctrl.value);
    if (isInt) v = Math.round(v);
    config[key] = v;
    val.textContent = ctrl.value;
    if (key === "cellWidth" || key === "cellHeight") rebuildGrid();
    if (mediaType === "image" && mediaReady) renderStatic();
  });
}

function bindSelect(ctrlId, key) {
  const ctrl = document.getElementById(ctrlId);
  ctrl.addEventListener("change", () => {
    config[key] = ctrl.value;
    if (mediaType === "image" && mediaReady) renderStatic();
  });
}

function bindControls() {
  /* 图像处理 */
  bindRange("ctrl-brightness", "val-brightness", "brightness", true);
  bindRange("ctrl-contrast", "val-contrast", "contrast", true);
  bindRange("ctrl-gamma", "val-gamma", "gamma", false);

  const invert = document.getElementById("ctrl-invert");
  invert.addEventListener("change", () => {
    config.invert = invert.checked;
    if (mediaType === "image" && mediaReady) renderStatic();
  });

  bindSelect("ctrl-dithering", "dithering");

  /* 背景 */
  bindSelect("ctrl-bg-mode", "bgMode");
  bindRange("ctrl-white-threshold", "val-white-threshold", "whiteThreshold", false);
  bindRange("ctrl-white-distance", "val-white-distance", "whiteDistance", true);
  bindRange("ctrl-dark-threshold", "val-dark-threshold", "darkThreshold", false);
  bindRange("ctrl-dark-distance", "val-dark-distance", "darkDistance", true);

  /* 主体 */
  bindRange("ctrl-wave-threshold", "val-wave-threshold", "waveThreshold", false);

  /* 字符 */
  const presetSel = document.getElementById("ctrl-charset-preset");
  const charsetInput = document.getElementById("ctrl-charset");
  presetSel.addEventListener("change", () => {
    const p = presetSel.value;
    if (p === "custom") return;
    const preset = CHARSET_PRESETS[p];
    if (preset) {
      charsetInput.value = preset;
      config.charset = preset;
      if (mediaType === "image" && mediaReady) renderStatic();
    }
  });
  charsetInput.addEventListener("input", () => {
    config.charset = charsetInput.value;
    presetSel.value = "custom";
    if (mediaType === "image" && mediaReady) renderStatic();
  });
  bindRange("ctrl-tonal-steps", "val-tonal-steps", "tonalSteps", true);
  bindSelect("ctrl-font", "font");
  bindRange("ctrl-font-size", "val-font-size", "fontSize", true);
  bindRange("ctrl-cell-w", "val-cell-w", "cellWidth", true);
  bindRange("ctrl-cell-h", "val-cell-h", "cellHeight", true);

  /* 颜色 */
  bindSelect("ctrl-color-mode", "colorMode");
  document.getElementById("ctrl-char-color").addEventListener("input", e => {
    config.charColor = e.target.value;
    if (mediaType === "image" && mediaReady) renderStatic();
  });
  document.getElementById("ctrl-bg-color").addEventListener("input", e => {
    config.bgColor = e.target.value;
    if (mediaType === "image" && mediaReady) renderStatic();
  });
  document.getElementById("ctrl-tint").addEventListener("input", e => {
    config.tint = e.target.value;
    if (mediaType === "image" && mediaReady) renderStatic();
  });
  bindRange("ctrl-tint-amount", "val-tint-amount", "tintAmount", true);

  /* 平滑与厚度 */
  bindRange("ctrl-smoothing", "val-smoothing", "smoothing", false);
  bindRange("ctrl-depth-layers", "val-depth-layers", "depthLayers", true);
  bindRange("ctrl-depth-x", "val-depth-x", "depthX", false);
  bindRange("ctrl-depth-y", "val-depth-y", "depthY", false);

  /* 动画 */
  bindSelect("ctrl-anim-type", "animType");
  bindRange("ctrl-anim-speed", "val-anim-speed", "animSpeed", false);
  bindSelect("ctrl-reveal", "reveal");

  /* 播放 */
  bindRange("ctrl-fps", "val-fps", "fps", true);
  const loop = document.getElementById("ctrl-loop");
  loop.addEventListener("change", () => {
    config.loop = loop.checked;
    video.loop = config.loop;
  });

  /* 按钮 */
  document.getElementById("btn-replay").addEventListener("click", replay);
  document.getElementById("btn-export").addEventListener("click", exportCode);
  document.getElementById("btn-clear").addEventListener("click", clearMedia);
  document.getElementById("btn-reset").addEventListener("click", resetDefaults);
  document.getElementById("btn-record").addEventListener("click", recordVideo);
  document.getElementById("btn-download-image").addEventListener("click", exportImage);

  /* 录制时长 */
  const recDur = document.getElementById("ctrl-record-dur");
  const recDurVal = document.getElementById("val-record-dur");
  recDur.addEventListener("change", () => { recDurVal.textContent = recDur.value; });
}

/* =========================================================
   文件拖拽
========================================================= */

function bindFileInput() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
}

/* =========================================================
   恢复默认
========================================================= */

function resetDefaults() {
  Object.assign(config, DEFAULTS);

  const ranges = [
    ["ctrl-brightness", "val-brightness", "brightness"],
    ["ctrl-contrast", "val-contrast", "contrast"],
    ["ctrl-gamma", "val-gamma", "gamma"],
    ["ctrl-white-threshold", "val-white-threshold", "whiteThreshold"],
    ["ctrl-white-distance", "val-white-distance", "whiteDistance"],
    ["ctrl-dark-threshold", "val-dark-threshold", "darkThreshold"],
    ["ctrl-dark-distance", "val-dark-distance", "darkDistance"],
    ["ctrl-wave-threshold", "val-wave-threshold", "waveThreshold"],
    ["ctrl-tonal-steps", "val-tonal-steps", "tonalSteps"],
    ["ctrl-font-size", "val-font-size", "fontSize"],
    ["ctrl-cell-w", "val-cell-w", "cellWidth"],
    ["ctrl-cell-h", "val-cell-h", "cellHeight"],
    ["ctrl-tint-amount", "val-tint-amount", "tintAmount"],
    ["ctrl-smoothing", "val-smoothing", "smoothing"],
    ["ctrl-depth-layers", "val-depth-layers", "depthLayers"],
    ["ctrl-depth-x", "val-depth-x", "depthX"],
    ["ctrl-depth-y", "val-depth-y", "depthY"],
    ["ctrl-anim-speed", "val-anim-speed", "animSpeed"],
    ["ctrl-fps", "val-fps", "fps"]
  ];

  for (let i = 0; i < ranges.length; i++) {
    const ctrl = document.getElementById(ranges[i][0]);
    const val = document.getElementById(ranges[i][1]);
    if (ctrl) ctrl.value = config[ranges[i][2]];
    if (val) val.textContent = config[ranges[i][2]];
  }

  document.getElementById("ctrl-invert").checked = config.invert;
  document.getElementById("ctrl-dithering").value = config.dithering;
  document.getElementById("ctrl-bg-mode").value = config.bgMode;
  document.getElementById("ctrl-charset-preset").value = "custom";
  document.getElementById("ctrl-charset").value = config.charset;
  document.getElementById("ctrl-font").value = config.font;
  document.getElementById("ctrl-color-mode").value = config.colorMode;
  document.getElementById("ctrl-char-color").value = config.charColor;
  document.getElementById("ctrl-bg-color").value = config.bgColor;
  document.getElementById("ctrl-tint").value = config.tint;
  document.getElementById("ctrl-anim-type").value = config.animType;
  document.getElementById("ctrl-reveal").value = config.reveal;
  document.getElementById("ctrl-loop").checked = config.loop;
  video.loop = config.loop;

  rebuildGrid();
  if (mediaType === "image" && mediaReady) renderStatic();
}

/* =========================================================
   Tooltip
========================================================= */

function initTooltips() {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);

  function findTipTarget(el) {
    let node = el;
    while (node && node !== document) {
      if (node.hasAttribute && node.hasAttribute("data-tip")) return node;
      node = node.parentElement;
    }
    return null;
  }

  function positionTip(x, y) {
    const pad = 14;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x + pad, top = y + pad;
    if (left + tw > vw - 8) left = x - tw - pad;
    if (top + th > vh - 8) top = y - th - pad;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  document.addEventListener("mouseover", e => {
    const target = findTipTarget(e.target);
    if (!target) return;
    const text = target.getAttribute("data-tip");
    if (!text) return;
    tip.textContent = text;
    positionTip(e.clientX, e.clientY);
    tip.classList.add("show");
  });

  document.addEventListener("mousemove", e => {
    if (!tip.classList.contains("show")) return;
    positionTip(e.clientX, e.clientY);
  });

  document.addEventListener("mouseout", e => {
    const target = findTipTarget(e.target);
    if (!target) return;
    const related = findTipTarget(e.relatedTarget);
    if (related === target) return;
    tip.classList.remove("show");
  });
}

/* =========================================================
   Init
========================================================= */

bindControls();
bindFileInput();
initTooltips();

ctx.fillStyle = config.bgColor;
ctx.fillRect(0, 0, width, height);
