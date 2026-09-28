// Evaluates OCR on real card images made to look like camera shots.
// Run: node test/ocr-eval.mjs [count]   (downloads images to test/.cache)
// Not part of `npm test`: it's slow and needs the network.

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { toCard, buildIndex } from '../recognize.js';
import { recognizeCard } from '../ocr.js';

const data = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url)));
const index = buildIndex(data.cards.map(toCard));
const cache = new URL('./.cache/', import.meta.url);
mkdirSync(cache, { recursive: true });

const count = Number(process.argv[2] ?? 30);
// Deterministic spread over the whole list, plus a few known tricky ones.
const picks = ['OGN-002', 'OGN-041a', 'UNL-229', 'OGS-021', 'OGN-042', 'OGN-119a'];
const step = Math.floor(index.cards.length / count);
for (let i = 0; i < index.cards.length && picks.length < count + 6; i += step) picks.push(index.cards[i].variantNumber);

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Card drawn into a 3:4 box like the phone's scan box: ~88% fill, small offset and tilt, soft focus, noise.
function cameraShot(img) {
  const boxW = 860, boxH = 1200; // scan box in a 1080p portrait frame
  const c = createCanvas(boxW, boxH);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6b5a45'; // table
  ctx.fillRect(0, 0, boxW, boxH);
  const fill = 0.86 + rand() * 0.08;
  const w = boxW * fill, h = w * (88 / 63);
  ctx.save();
  ctx.translate(boxW / 2 + (rand() - 0.5) * 30, boxH / 2 + (rand() - 0.5) * 30);
  ctx.rotate((rand() - 0.5) * 0.06);
  ctx.filter = 'blur(0.8px)';
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  const id = ctx.getImageData(0, 0, boxW, boxH);
  const bright = 0.8 + rand() * 0.3;
  for (let i = 0; i < id.data.length; i += 4) {
    const n = (rand() - 0.5) * 18;
    for (let k = 0; k < 3; k++) id.data[i + k] = Math.max(0, Math.min(255, id.data[i + k] * bright + n));
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

const tess = await createWorker('eng');
// The browser worker takes a canvas; in Node it needs encoded image bytes.
const worker = {
  setParameters: (p) => tess.setParameters(p),
  recognize: (canvas, opts, out) => tess.recognize(canvas.toBuffer('image/png'), opts, out),
  terminate: () => tess.terminate(),
};
let ok = 0, byName = 0, wrong = 0, none = 0;
const t0 = Date.now();
for (const vn of picks) {
  const file = new URL(encodeURIComponent(vn) + '.webp', cache);
  if (!existsSync(file)) {
    const res = await fetch(`https://cdn.piltoverarchive.com/cards/${encodeURIComponent(vn)}.webp`);
    if (!res.ok) { console.log(vn, 'no image'); continue; }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const img = await loadImage(readFileSync(file));
  const shot = cameraShot(img);
  const r = await recognizeCard(shot, worker, index, createCanvas);
  const got = r.variants?.map((v) => v.variantNumber) ?? [];
  const card = index.byNumber.get(vn);
  const correct = got.includes(vn) || (r.method === 'name' && r.names?.includes(card.name));
  if (r.status === 'none') none++;
  else if (correct) { ok++; if (r.method === 'name') byName++; }
  else wrong++;
  console.log(`${correct ? 'ok  ' : r.status === 'none' ? 'NONE' : 'BAD '} ${vn.padEnd(16)} ${r.method ?? '-'} -> ${got[0] ?? r.names?.join('|') ?? ''}${correct ? '' : '   text: ' + JSON.stringify(r.text.slice(0, 120))}`);
}
await worker.terminate();
console.log(`\n${ok}/${picks.length} correct (${byName} by name), ${wrong} wrong, ${none} unread, ${((Date.now() - t0) / picks.length).toFixed(0)} ms/card`);
