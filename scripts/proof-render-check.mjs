#!/usr/bin/env node
/**
 * Render web/proof.html in a real browser and prove the viewer draws.
 *
 * Why this exists: the deep-zoom viewer shipped blank. Every part of it had
 * been reasoned about -- the wiring, the fallback, the 1:1 arithmetic -- and
 * none of it had been looked at, because OpenSeadragon was loaded from a public
 * CDN that the build environment cannot reach. The library is vendored now
 * (web/vendor/openseadragon), so the page can be rendered here, and this script
 * is what does the looking.
 *
 * It asserts the one thing a human would have caught in a second: that pixels
 * end up on the canvas. A viewer that loads the descriptor, knows the image
 * size and reports a zoom percentage while drawing nothing passes every check
 * short of reading the canvas back, which is exactly how the bug escaped.
 *
 * Usage:
 *   npm i -D playwright                       # not a dependency of the app
 *   aws s3 cp --recursive s3://sb-<env>-dzi-<account>/<ORDER>/ <tiles>/<ORDER>/
 *   node scripts/proof-render-check.mjs --tiles <tiles> --order <ORDER>
 *
 * Exits non-zero on the first failure so CI can run it unattended.
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const PORT = 8770;

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const TILES = arg('tiles');
const ORDER = arg('order', 'S00000');
const ITEM = arg('item', '1');
if (!TILES) {
  console.error('need --tiles <dir containing <ORDER>/...dzi and _files/>');
  process.exit(2);
}

// Chromium is preinstalled in the build image; a developer machine uses whatever
// playwright downloaded.
const LAUNCH = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
  ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }
  : {};

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.dzi': 'application/xml', '.txt': 'text/plain',
};

// Shaped exactly like src/functions/proof-approval/core.mjs proofFiles().
const proof = (itemNo) => {
  const prefix = `cdn/${ORDER}/${itemNo}-1v1.tif`;
  return {
    itemNo,
    name: `item ${itemNo}`,
    review: `${prefix}_review.jpg`,
    thumbnail: `${prefix}_thumbnail.jpg`,
    dzi: `${prefix}.dzi`,
  };
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/proof') {
    const two = url.searchParams.get('t') === 'two';
    const proofs = two ? [proof(ITEM), { ...proof(ITEM), itemNo: 2 }] : [proof(ITEM)];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ orderName: ORDER, status: 'pending', proofs }));
  }
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ apiBase: `http://127.0.0.1:${PORT}`, cdnBase: 'cdn' }));
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/proof.html' : url.pathname);
  const file = rel.startsWith('/cdn/')
    ? path.join(TILES, rel.slice(5))
    : path.join(WEB, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/** Read the composited canvas back. Presence proves nothing; ink proves it. */
const inkOnCanvas = () => {
  const c = document.querySelector('.osd canvas');
  if (!c) return { canvas: false };
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  t.getContext('2d').drawImage(c, 0, 0);
  const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
  let min = 255, max = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (d[i + 3] > 0) { n++; if (v < min) min = v; if (v > max) max = v; }
  }
  return { canvas: true, size: `${c.width}x${c.height}`, samples: n, min, max, drawn: n > 0 && max > min };
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : '!!  '}${name}${detail ? '   ' + detail : ''}`);
};

async function open(page, query = 'fake') {
  await page.goto(`http://127.0.0.1:${PORT}/proof.html?t=${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
}

await new Promise((r) => server.listen(PORT, r));
try {
  // 1:1 has to hold on a retina screen too -- that is the whole point of the
  // feature, and the arithmetic divides by devicePixelRatio.
  for (const dpr of [1, 2]) {
    const browser = await chromium.launch(LAUNCH);
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 }, deviceScaleFactor: dpr });
    await open(page);

    const ink = await page.evaluate(inkOnCanvas);
    check(`dpr ${dpr}: viewer draws pixels`, ink.drawn === true, JSON.stringify(ink));

    await page.evaluate(() => document.querySelector('.zoombar button.primary').click());
    await page.waitForTimeout(2000);
    const pct = (await page.textContent('.pct')).trim();
    check(`dpr ${dpr}: 100% button reaches 1:1`, /\b100%\s*$/.test(pct), pct);

    await browser.close();
  }

  // Without the library the page must still show the proof and still approve.
  {
    const browser = await chromium.launch(LAUNCH);
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
    await page.route('**/openseadragon.min.js', (r) => r.abort());
    await open(page);
    const flat = await page.locator('.proof img').count();
    const bars = await page.locator('.zoombar').count();
    const approve = await page.locator('#approve').count();
    check('no library: falls back to the flat image', flat === 1 && bars === 0 && approve === 1,
      `img=${flat} zoombar=${bars} approve=${approve}`);
    await browser.close();
  }

  // Unreadable tiles must swap the picture back in, not leave an empty box.
  {
    const browser = await chromium.launch(LAUNCH);
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
    await page.route('**/*.dzi', (r) => r.fulfill({ status: 404, body: 'gone' }));
    await open(page);
    await page.waitForTimeout(1500);
    const img = await page.locator('.viewer img').count();
    check('missing tiles: falls back inside the viewer', img === 1, `img=${img}`);
    await browser.close();
  }

  // Only the first item opens by itself; the rest wait behind a thumbnail.
  {
    const browser = await chromium.launch(LAUNCH);
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
    await open(page, 'two');
    const before = await page.evaluate(() => [...document.querySelectorAll('.viewer')]
      .map((v) => (v.querySelector('canvas') ? 'open' : 'thumb')));
    await page.locator('.proof').nth(1).locator('.viewer').click();
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => [...document.querySelectorAll('.viewer')]
      .map((v) => (v.querySelector('canvas') ? 'open' : 'thumb')));
    check('multi-item: second opens on click',
      before.join(',') === 'open,thumb' && after.join(',') === 'open,open',
      `${before.join(',')} -> ${after.join(',')}`);
    await browser.close();
  }
} finally {
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
