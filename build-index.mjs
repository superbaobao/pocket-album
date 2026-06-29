#!/usr/bin/env node
// build-index.mjs — scan a folder (e.g. a USB drive) of photos/videos,
// generate thumbnails, and emit a static gallery that runs by double-clicking index.html.
//
//   node build-index.mjs /path/to/usb
//
// Re-run any time you add files; it is incremental (skips already-thumbnailed images).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import exifReader from 'exif-reader';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif', '.tif', '.tiff', '.dng']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.ogv', '.3gp']);
// Formats most browsers can't display — we transcode a web-viewable JPEG for these.
// .dng (and other RAW) decode via macOS sips/ImageIO; add more RAW exts here the same way.
const NONWEB_EXT = new Set(['.heic', '.heif', '.tif', '.tiff', '.dng']);
// Everything we write lives under APP_DIR (except the entry page at the root).
// Leading underscore keeps it from being confused with the user's own photo folders.
const APP_DIR = '_pocketalbum';
const LEGACY_DIRS = ['viewer'];   // older app-dir names to skip while scanning + clean up
const ENTRY = '打开相册.html';   // the file the user double-clicks (Chinese so it's obvious)
const THUMB_DIR = APP_DIR + '/thumbs';
const WEB_DIR = APP_DIR + '/web';
// Files we write/own at the root — never index these as media.
const RESERVED = new Set([ENTRY, 'index.html', 'build-index.mjs', 'make-sample.mjs', 'package.json', 'package-lock.json']);
const THUMB_MAX = 480;       // longest edge, px
const CONCURRENCY = 6;

let HAS_SIPS = false;        // detected at startup (macOS); enables HEIC/TIFF support
let HAS_FFMPEG = false;      // ffmpeg present? (cross-platform video frame extraction)
let HAS_QL = false;          // qlmanage present? (macOS Quick Look video posters)

const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((a) => !a.startsWith('-'));
const flags = new Set(rawArgs.filter((a) => a.startsWith('-') && !a.includes('=')));
const opts = Object.fromEntries(rawArgs.filter((a) => a.startsWith('--') && a.includes('='))
  .map((a) => a.slice(2).split('=')));
const WEB_MAX = Math.max(640, parseInt(opts.web, 10) || 2560);  // --web=1600 to save space
const root = path.resolve(args[0] || '.');

function log(...a) { console.log(...a); }

function hashPath(rel) {
  return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
}

async function walk(dir, rel = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const name = e.name;
    if (name.startsWith('.')) continue;            // dotfiles/dirs
    if (name === 'node_modules') continue;
    if (rel === '' && (name === APP_DIR || LEGACY_DIRS.indexOf(name) >= 0)) continue;  // our own app folder
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (e.isDirectory()) {
      out.push(...(await walk(abs, relPath)));
    } else if (e.isFile()) {
      if (rel === '' && RESERVED.has(name)) continue;
      const ext = path.extname(name).toLowerCase();
      const type = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
      if (!type) continue;
      out.push({ abs, rel: relPath, name, ext, type });
    }
  }
  return out;
}

function exifDate(exifBuf) {
  try {
    const tags = exifReader(exifBuf);
    const d = tags?.Photo?.DateTimeOriginal || tags?.Image?.DateTime || tags?.Photo?.DateTimeDigitized;
    if (d instanceof Date && !isNaN(d)) return d.getTime();
  } catch { /* ignore */ }
  return null;
}

async function sipsConvert(src, outAbs, maxPx) {
  try {
    await execFileP('sips', ['-s', 'format', 'jpeg', '--resampleHeightWidthMax', String(maxPx),
      src, '--out', outAbs], { maxBuffer: 1 << 20 });
    return true;
  } catch { return false; }
}

async function mdlsDate(src) {                      // macOS Spotlight capture date
  try {
    const { stdout } = await execFileP('mdls', ['-raw', '-name', 'kMDItemContentCreationDate', src]);
    const t = Date.parse(stdout.trim());
    return isNaN(t) ? null : t;
  } catch { return null; }
}

async function makeThumb(src, outAbs) {
  try {
    await sharp(src, { failOn: 'none' })
      .rotate()                                    // auto-orient from EXIF
      .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(outAbs);
    return true;
  } catch { return false; }
}

async function processImage(file, id) {
  const thumbRel = `${THUMB_DIR}/${id}.webp`;
  const thumbAbs = path.join(root, thumbRel);
  let w = null, h = null, time = null, web = null;
  let readable = file.abs;                          // a source sharp can decode

  // HEIC/TIFF: most browsers can't display these — transcode a web-viewable JPEG via sips.
  if (NONWEB_EXT.has(file.ext) && HAS_SIPS) {
    const webRel = `${WEB_DIR}/${id}.jpg`;
    const webAbs = path.join(root, webRel);
    if (await sipsConvert(file.abs, webAbs, WEB_MAX)) { web = webRel; readable = webAbs; }
  }

  // dimensions + capture time
  try {
    const meta = await sharp(readable, { failOn: 'none' }).metadata();
    w = meta.width ?? null;
    h = meta.height ?? null;
    if (meta.orientation && meta.orientation >= 5 && w && h) [w, h] = [h, w];
    if (meta.exif) time = exifDate(meta.exif);
  } catch { /* keep going */ }
  if (time == null && HAS_SIPS) time = await mdlsDate(file.abs);

  // thumbnail (from the web JPEG when present, else the original)
  let thumbOk = await makeThumb(readable, thumbAbs);
  if (!thumbOk && readable !== file.abs) thumbOk = await makeThumb(file.abs, thumbAbs);
  if (!thumbOk) log(`  ! thumb failed: ${file.rel}`);

  return { w, h, time, thumb: thumbOk ? thumbRel : null, web };
}

// Extract a single representative frame from a video into an image file.
// Prefers ffmpeg (cross-platform, seeks ~1s in); falls back to qlmanage (macOS Quick Look).
// Returns the absolute path of the extracted frame, or null.
async function extractVideoFrame(src, outDir, id) {
  if (HAS_FFMPEG) {
    const out = path.join(outDir, `${id}.frame.jpg`);
    try {
      await execFileP('ffmpeg', ['-y', '-ss', '1', '-i', src, '-frames:v', '1',
        '-vf', `scale='min(${THUMB_MAX},iw)':-2`, '-q:v', '4', out], { maxBuffer: 1 << 20 });
      if (await fs.access(out).then(() => true).catch(() => false)) return out;
    } catch { /* fall through */ }
  }
  if (HAS_QL) {
    try {
      await execFileP('qlmanage', ['-t', '-s', String(THUMB_MAX), '-o', outDir, src], { maxBuffer: 1 << 20 });
      const png = path.join(outDir, path.basename(src) + '.png');   // qlmanage names it <file>.png
      if (await fs.access(png).then(() => true).catch(() => false)) return png;
    } catch { /* give up */ }
  }
  return null;
}

async function processVideo(file, id) {
  const thumbRel = `${THUMB_DIR}/${id}.webp`;
  const thumbAbs = path.join(root, thumbRel);
  const tmpDir = path.join(root, THUMB_DIR);
  let w = null, h = null, time = null;

  const frame = await extractVideoFrame(file.abs, tmpDir, id);
  let thumbOk = false;
  if (frame) {
    thumbOk = await makeThumb(frame, thumbAbs);
    if (thumbOk) {
      try { const m = await sharp(thumbAbs).metadata(); w = m.width ?? null; h = m.height ?? null; } catch { /* ratio optional */ }
    }
    await fs.unlink(frame).catch(() => {});
  }
  if (!thumbOk) log(`  ! video poster failed: ${file.rel}`);
  if (HAS_SIPS) time = await mdlsDate(file.abs);
  return { w, h, time, thumb: thumbOk ? thumbRel : null, web: null };
}

async function copyApp(targetRoot) {
  const appDir = path.join(__dirname, 'app');
  await fs.mkdir(path.join(targetRoot, APP_DIR), { recursive: true });
  // the entry page lives at the root (the thing you double-click); the rest under APP_DIR.
  await fs.copyFile(path.join(appDir, 'index.html'), path.join(targetRoot, ENTRY));
  await fs.unlink(path.join(targetRoot, 'index.html')).catch(() => {});   // clear stale default-named entry
  for (const f of ['app.css', 'app.js']) {
    await fs.copyFile(path.join(appDir, f), path.join(targetRoot, APP_DIR, f));
  }
}

async function main() {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(1);
  }

  // DEFAULT = update: refresh the gallery program only, never rescan photos.
  // Scanning (which generates thumbnails) only happens with an explicit --scan.
  if (!flags.has('--scan')) {
    const indexed = await fs.access(path.join(root, APP_DIR, 'media-index.js')).then(() => true).catch(() => false);
    await copyApp(root);
    if (!indexed) {
      log(`⚠ No media index in ${root} yet.`);
      log(`  First time / after adding photos, run a scan explicitly:`);
      log(`      node build-index.mjs "${root}" --scan`);
    } else {
      log(`✓ updated ${ENTRY} + ${APP_DIR}/app.js + ${APP_DIR}/app.css → ${root}`);
      log('  (app updated; photos NOT rescanned — use --scan to re-scan)');
    }
    return;
  }

  log(`Scanning: ${root}`);

  HAS_SIPS = await execFileP('sips', ['--help']).then(() => true).catch(() => false);
  HAS_FFMPEG = await execFileP('ffmpeg', ['-version']).then(() => true).catch(() => false);
  HAS_QL = process.platform === 'darwin'
    && await execFileP('which', ['qlmanage']).then(() => true).catch(() => false);

  const thumbDirAbs = path.join(root, THUMB_DIR);
  await fs.mkdir(thumbDirAbs, { recursive: true });
  await fs.mkdir(path.join(root, WEB_DIR), { recursive: true });

  // incremental cache: rel -> { mtime, size, w, h, time, thumb }
  const cacheAbs = path.join(thumbDirAbs, 'cache.json');
  let cache = {};
  if (!flags.has('--clean')) {
    try { cache = JSON.parse(await fs.readFile(cacheAbs, 'utf8')); } catch { cache = {}; }
  }

  const files = await walk(root);
  const nonWeb = files.filter((f) => NONWEB_EXT.has(f.ext)).length;
  const nVideo = files.filter((f) => f.type === 'video').length;
  log(`Found ${files.length} media files. Generating thumbnails…`);
  if (nVideo) {
    if (HAS_FFMPEG) log(`  ${nVideo} videos → poster frames via ffmpeg.`);
    else if (HAS_QL) log(`  ${nVideo} videos → poster frames via qlmanage (Quick Look).`);
    else log(`  ⚠ ${nVideo} videos found but neither 'ffmpeg' nor 'qlmanage' is available — install ffmpeg for video previews.`);
  }
  if (nonWeb) {
    if (HAS_SIPS) log(`  ${nonWeb} HEIC/TIFF will be transcoded to web-viewable JPEG (sips).`);
    else log(`  ⚠ ${nonWeb} HEIC/TIFF found but 'sips' is unavailable — these may not display in browsers.`);
  }

  const items = [];
  const newCache = {};
  let done = 0, reused = 0, made = 0;
  const usedThumbs = new Set();
  const usedWeb = new Set();

  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++];
      const st = await fs.stat(file.abs).catch(() => null);
      if (!st) continue;
      const sig = { mtime: Math.round(st.mtimeMs), size: st.size };
      const id = hashPath(file.rel);

      let rec;
      if (file.type === 'image') {
        const cached = cache[file.rel];
        const thumbExists = cached?.thumb
          && await fs.access(path.join(root, cached.thumb)).then(() => true).catch(() => false);
        const webOk = !cached?.web
          || await fs.access(path.join(root, cached.web)).then(() => true).catch(() => false);
        if (cached && cached.mtime === sig.mtime && cached.size === sig.size && thumbExists && webOk) {
          rec = { w: cached.w, h: cached.h, time: cached.time, thumb: cached.thumb, web: cached.web || null };
          reused++;
        } else {
          rec = await processImage(file, id);
          made++;
        }
        if (rec.thumb) usedThumbs.add(`${id}.webp`);
        if (rec.web) usedWeb.add(`${id}.jpg`);
      } else {
        // video: extract a poster frame (ffmpeg/qlmanage); the viewer falls back to in-browser grab if null
        const cached = cache[file.rel];
        const thumbExists = cached?.thumb
          && await fs.access(path.join(root, cached.thumb)).then(() => true).catch(() => false);
        if (cached && cached.mtime === sig.mtime && cached.size === sig.size && thumbExists) {
          rec = { w: cached.w, h: cached.h, time: cached.time, thumb: cached.thumb, web: null };
          reused++;
        } else {
          rec = await processVideo(file, id);
          made++;
        }
        if (rec.thumb) usedThumbs.add(`${id}.webp`);
      }
      const time = rec.time ?? sig.mtime;

      const item = {
        path: file.rel,
        name: file.name,
        dir: path.posix.dirname(file.rel.split(path.sep).join('/')),
        type: file.type,
        w: rec.w, h: rec.h,
        time,
        thumb: rec.thumb,
      };
      if (rec.web) item.web = rec.web;               // browser-viewable version (HEIC/TIFF)
      if (item.dir === '.') item.dir = '';
      items.push(item);
      newCache[file.rel] = { ...sig, w: rec.w, h: rec.h, time: rec.time, thumb: rec.thumb, web: rec.web || null };

      done++;
      if (done % 50 === 0) log(`  …${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // prune orphaned generated files
  let pruned = 0;
  for (const f of await fs.readdir(thumbDirAbs).catch(() => [])) {
    if (f.endsWith('.webp') && !usedThumbs.has(f)) {
      await fs.unlink(path.join(thumbDirAbs, f)).catch(() => {}); pruned++;
    }
  }
  for (const f of await fs.readdir(path.join(root, WEB_DIR)).catch(() => [])) {
    if (f.endsWith('.jpg') && !usedWeb.has(f)) {
      await fs.unlink(path.join(root, WEB_DIR, f)).catch(() => {}); pruned++;
    }
  }

  // stable sort: newest first
  items.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));

  // directory list (every folder that contains media, plus ancestors)
  const dirSet = new Set();
  for (const it of items) {
    let d = it.dir;
    while (d) { dirSet.add(d); d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ''; }
  }
  const dirs = [...dirSet].sort();

  const manifest = {
    generatedAt: Date.now(),
    root: path.basename(root),
    counts: {
      total: items.length,
      images: items.filter((i) => i.type === 'image').length,
      videos: items.filter((i) => i.type === 'video').length,
    },
    dirs,
    items,
  };

  await copyApp(root);
  await fs.writeFile(
    path.join(root, APP_DIR, 'media-index.js'),
    `// Auto-generated by build-index.mjs — do not edit.\nwindow.MEDIA_INDEX = ${JSON.stringify(manifest)};\n`,
  );
  await fs.writeFile(cacheAbs, JSON.stringify(newCache));

  log('');
  log(`✓ ${items.length} items  (${manifest.counts.images} images, ${manifest.counts.videos} videos)`);
  log(`  thumbnails: ${made} generated, ${reused} reused, ${pruned} pruned`);
  log(`  wrote ${ENTRY} → ${root}`);
  log(`  wrote app.js, app.css, media-index.js, thumbs/ → ${path.join(root, APP_DIR)}`);
  log('');
  log(`Open ${path.join(root, ENTRY)} in a browser.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
