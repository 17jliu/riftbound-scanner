// Reads a card from an image of it with Tesseract.
// src: a canvas holding the card, roughly filling it (the scan box).
// makeCanvas(w, h): returns a new canvas (DOM in the browser, @napi-rs/canvas in tests).

import { parseCollectorNumber, matchName, variantsForName } from './recognize.js';

// Crops a region (fractions of src), scales it to targetWidth, and turns it into
// high-contrast dark-on-light grayscale, which Tesseract reads best.
// rotate: 0, or 90 to turn text that reads bottom-to-top into left-to-right.
// binarize: threshold to pure black and white (Otsu), which strips busy art behind text.
export function prepare(src, region, targetWidth, makeCanvas, rotate = 0, binarize = false) {
  const sx = region.x * src.width, sy = region.y * src.height;
  const sw = region.w * src.width, sh = region.h * src.height;
  const long = rotate ? sh : sw, short = rotate ? sw : sh;
  const scale = targetWidth / long;
  const w = Math.round(long * scale), h = Math.round(short * scale);
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (rotate) {
    // Rotate the crop 90° clockwise: its bottom edge becomes the left edge.
    ctx.translate(w, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, h, w);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g;
    hist[g | 0]++;
    sum += g;
  }
  // Card text is white on a dark border; invert when the region is mostly dark.
  const invert = sum / gray.length < 128;
  // Stretch contrast between the 2nd and 98th percentiles.
  const lo = percentile(hist, gray.length, 0.02), hi = percentile(hist, gray.length, 0.98);
  const range = Math.max(1, hi - lo);
  const cut = binarize ? otsu(hist, gray.length) : -1;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = ((gray[p] - lo) / range) * 255;
    v = Math.max(0, Math.min(255, v));
    if (binarize) v = gray[p] > cut ? 255 : 0;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function otsu(hist, n) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, cut = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; cut = t; }
  }
  return cut;
}

function percentile(hist, n, q) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= n * q) return i;
  }
  return 255;
}

// Collector number: bottom-left corner. Generous so a card that's a bit off-center still fits.
const NUMBER_REGION = { x: 0, y: 0.84, w: 0.66, h: 0.16 };
// Just the number line, for a binarized retry.
const NUMBER_LINE = { x: 0, y: 0.9, w: 0.5, h: 0.1 };
// Name: the band under the art (lower on some alternate arts, so it's tall).
const NAME_REGION = { x: 0, y: 0.42, w: 1, h: 0.44 };
// Battlefields are printed sideways: the number runs up the right edge from the bottom.
const BATTLEFIELD_REGION = { x: 0.84, y: 0.3, w: 0.16, h: 0.7 };

function words(page) {
  const out = [];
  for (const b of page.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    const height = l.bbox.y1 - l.bbox.y0;
    for (const w of l.words) if (w.confidence > 30) out.push({ text: w.text, height });
  }
  return out;
}

// Returns { status: 'ok' | 'ambiguous' | 'none', method, key, variants, names, text }.
export async function recognizeCard(src, worker, index, makeCanvas) {
  const texts = [];
  const read = async (region, psm, { rotate = 0, blocks = false, binarize = false } = {}) => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const width = region === NAME_REGION ? 1200 : region === NUMBER_LINE ? 1000 : 1400;
    const r = await worker.recognize(prepare(src, region, width, makeCanvas, rotate, binarize), {}, { text: true, blocks });
    texts.push(r.data.text);
    return r.data;
  };
  const numberHit = (page) => {
    const hit = parseCollectorNumber(page.text, index);
    return hit && { status: 'ok', method: 'number', key: hit.key, variants: hit.variants, text: page.text };
  };

  let hit =
    numberHit(await read(NUMBER_REGION, '6')) ||
    numberHit(await read(NUMBER_REGION, '11')) ||
    numberHit(await read(NUMBER_LINE, '11', { binarize: true }));
  if (hit) return hit;

  const name = await read(NAME_REGION, '3', { blocks: true });
  // The number sometimes shows up here when the card sits high in the box.
  if ((hit = numberHit(name))) return hit;
  const names = matchName(words(name), index);
  if (names.length === 1) return { status: 'ok', method: 'name', variants: variantsForName(names[0], index), names, text: name.text };

  if ((hit = numberHit(await read(BATTLEFIELD_REGION, '6', { rotate: 90 })))) return hit;

  const text = texts.join('\n');
  if (names.length > 1) return { status: 'ambiguous', method: 'name', names, text };
  return { status: 'none', text };
}
