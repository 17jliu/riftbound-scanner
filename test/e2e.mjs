// End-to-end check: renders a fake camera video of cards sliding into the scan box,
// feeds it to Chrome as the webcam, and checks what the app logged.
// Run: node test/e2e.mjs   (needs Google Chrome, ffmpeg, and card images in test/.cache from ocr-eval)

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'test/.cache/e2e');
mkdirSync(out, { recursive: true });

const W = 720, H = 960, FPS = 10;
// Scan box: 90% of the height, centered, card-shaped (matches styles.css).
const boxH = H * 0.9, boxW = boxH * (63 / 88);
const cardH = boxH * 0.93, cardW = cardH * (63 / 88);

// Timeline: [card or null, seconds at rest]; each card slides in from the right over 0.6 s.
const script = [
  [null, 2],
  ['OGN-002', 3],
  [null, 1.5],
  ['OGN-042', 3],
  ['OGN-143', 3], // slides straight over the previous card
  [null, 1.5],
  ['OGN-002', 3], // same card again after an empty box: counts twice
  [null, 2],
];
const expected = { 'OGN-002|0': 2, 'OGN-042|0': 1, 'OGN-143|0': 1 };

const images = {};
for (const [vn] of script) if (vn && !images[vn]) images[vn] = await loadImage(readFileSync(join(root, 'test/.cache', `${vn}.webp`)));

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
function table() {
  ctx.fillStyle = '#5b4a38';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let y = 0; y < H; y += 18) ctx.fillRect(0, y, W, 6); // wood grain
}
function drawCard(vn, dx) {
  ctx.save();
  ctx.translate(W / 2 + dx, H / 2);
  ctx.rotate(0.01);
  ctx.drawImage(images[vn], -cardW / 2, -cardH / 2, cardW, cardH);
  ctx.restore();
}

// Frames as raw yuv420p piped into ffmpeg to make a .y4m for Chrome's fake camera.
const video = join(out, 'cards.y4m');
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-pix_fmt', 'yuv420p', video]);
const frame = () => ff.stdin.write(Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer));

let under = null; // card resting in the box
for (const [vn, rest] of script) {
  if (vn) {
    for (let i = 0; i <= 6; i++) { table(); if (under) drawCard(under, 0); drawCard(vn, W * (1 - i / 6)); frame(); }
    under = vn;
  } else if (under) {
    for (let i = 0; i <= 6; i++) { table(); drawCard(under, -W * (i / 6)); frame(); }
    under = null;
  }
  for (let i = 0; i < rest * FPS; i++) { table(); if (under) drawCard(under, 0); frame(); }
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
const seconds = script.reduce((s, [, r]) => s + r + 0.7, 0);
console.log(`video: ${video} (${seconds.toFixed(0)} s)`);

// Static server for the app.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  try { res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p)); }
  catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const log = [];
page.on('console', (m) => log.push(m.text()));
await page.goto(`http://localhost:${port}/`);
await page.click('#start');
// Wait for the reader to load before the video's first card matters: Chrome loops the file,
// so watch status lines and stop after one full pass.
const statuses = [];
const t0 = Date.now();
await page.waitForFunction(() => document.body.dataset.reader, null, { timeout: 60000 });
const loadMs = Date.now() - t0;
console.log(`reader loaded in ${loadMs} ms`);
// Restart the tracker and collection at a known point: reload clears nothing, so clear storage and wait for loop start.
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click('#start');
await page.waitForFunction(() => document.body.dataset.reader, null, { timeout: 60000 });
const start = Date.now();
let lastStatus = '';
while (Date.now() - start < (seconds + 4) * 1000) {
  const s = await page.textContent('#status');
  if (s !== lastStatus) { statuses.push(`${((Date.now() - start) / 1000).toFixed(1)}s ${s}`); lastStatus = s; }
  await page.waitForTimeout(150);
}
const got = await page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('rift-scan-v1') ?? '{"entries":[]}').entries));
await page.screenshot({ path: join(out, 'screenshot.png'), fullPage: true });
await browser.close();
server.close();

console.log(statuses.join('\n'));
if (log.some((l) => /error/i.test(l))) console.log('console:', log.filter((l) => /error/i.test(l)).join('\n'));
console.log('got     ', got);
console.log('expected', expected);
// Chrome's fake camera loops the video, so the watch window can catch one card of the next pass.
const extra = Object.entries(expected).reduce((n, [k, want]) => n + ((got[k] ?? 0) - want), 0);
const ok = Object.entries(expected).every(([k, n]) => (got[k] ?? 0) >= n) && extra <= 1 && Object.keys(got).every((k) => k in expected);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
