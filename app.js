import { toCard, buildIndex, defaultFoil } from './recognize.js';
import { recognizeCard } from './ocr.js';
import { MotionTracker } from './motion.js';
import { toCsv } from './csv.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';
const STORE = 'rift-scan-v1';
const SAMPLE_W = 48, SAMPLE_H = 64; // motion frames
const SAMPLE_MS = 100;

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), viewport: $('viewport'), box: $('box'), flash: $('flash'), start: $('start'),
  status: $('status'), scan: $('scan'), auto: $('auto'), empty: $('empty'), meters: $('meters'), ocrText: $('ocrText'),
  last: $('last'), lastImg: $('lastImg'), lastName: $('lastName'), lastVariant: $('lastVariant'),
  lastFoil: $('lastFoil'), lastFoilWrap: $('lastFoilWrap'), undo: $('undo'), lastHow: $('lastHow'),
  search: $('search'), results: $('results'), list: $('list'), emptyList: $('emptyList'),
  total: $('total'), export: $('export'), clear: $('clear'),
};

const imageUrl = (vn) => `https://cdn.piltoverarchive.com/cards/${encodeURIComponent(vn)}.webp`;

// ---------- Card data ----------

let index;
async function loadCards() {
  const data = await (await fetch('cards.json')).json();
  index = buildIndex(data.cards.map(toCard));
}

// ---------- Collection ----------

// entries: key "variantNumber|0" or "|1" (foil) -> quantity
const collection = { entries: new Map(), last: null };

function entryKey(vn, foil) { return `${vn}|${foil ? 1 : 0}`; }

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ entries: [...collection.entries] }));
  } catch { /* private mode: collection lasts until the tab closes */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) collection.entries = new Map(JSON.parse(raw).entries);
  } catch { /* ignore */ }
}

function change(vn, foil, delta) {
  const k = entryKey(vn, foil);
  const q = (collection.entries.get(k) ?? 0) + delta;
  if (q > 0) collection.entries.set(k, q);
  else collection.entries.delete(k);
  save();
  renderList();
}

// Logs one copy and makes it the "last scanned" card, which can be corrected or undone.
function logCard(card, how, variants) {
  const foil = defaultFoil(card);
  change(card.variantNumber, foil, +1);
  collection.last = { vn: card.variantNumber, foil, how, variants };
  renderLast();
}

// ---------- Rendering ----------

function renderList() {
  const rows = [...collection.entries]
    .map(([k, qty]) => {
      const [vn, f] = k.split('|');
      return { card: index.byNumber.get(vn), foil: f === '1', qty };
    })
    .filter((r) => r.card)
    .sort((a, b) => a.card.variantNumber.localeCompare(b.card.variantNumber, 'en', { numeric: true }) || a.foil - b.foil);

  els.list.replaceChildren(...rows.map(({ card, foil, qty }) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="name"></div><div class="qty"><button aria-label="Remove one">−</button><span></span><button aria-label="Add one">+</button></div>`;
    const name = li.querySelector('.name');
    name.textContent = card.name;
    if (foil) name.insertAdjacentHTML('beforeend', '<span class="badge">foil</span>');
    const small = document.createElement('small');
    small.textContent = `${card.variantNumber} · ${card.variantLabel || card.variantType}`;
    name.append(small);
    li.querySelector('span').textContent = qty;
    const [minus, plus] = li.querySelectorAll('button');
    minus.onclick = () => change(card.variantNumber, foil, -1);
    plus.onclick = () => change(card.variantNumber, foil, +1);
    return li;
  }));
  const total = rows.reduce((n, r) => n + r.qty, 0);
  els.total.textContent = `${total} card${total === 1 ? '' : 's'}`;
  els.emptyList.hidden = rows.length > 0;
}

function renderLast() {
  const last = collection.last;
  els.last.hidden = !last;
  if (!last) return;
  const card = index.byNumber.get(last.vn);
  els.lastImg.src = imageUrl(card.variantNumber);
  els.lastImg.alt = card.name;
  els.lastName.textContent = card.name;
  els.lastHow.textContent = last.how;

  // Every printing of this card, plus anything else the scan matched.
  const options = new Map();
  for (const v of last.variants ?? []) options.set(v.variantNumber, v);
  for (const v of index.cards) if (v.name === card.name) options.set(v.variantNumber, v);
  els.lastVariant.replaceChildren(...[...options.values()].map((v) => {
    const o = document.createElement('option');
    o.value = v.variantNumber;
    o.textContent = `${v.variantNumber} · ${v.name === card.name ? v.variantLabel || v.variantType : v.name}`;
    o.selected = v.variantNumber === last.vn;
    return o;
  }));

  els.lastFoil.checked = last.foil;
  els.lastFoil.disabled = card.foilMode !== 'both';
  els.lastFoilWrap.title = card.foilMode === 'both' ? '' : card.foilMode === 'foil_only' ? 'Only printed in foil' : 'Not printed in foil';
}

els.lastVariant.onchange = () => {
  const last = collection.last;
  change(last.vn, last.foil, -1);
  const card = index.byNumber.get(els.lastVariant.value);
  last.vn = card.variantNumber;
  if (card.foilMode !== 'both') last.foil = defaultFoil(card);
  change(last.vn, last.foil, +1);
  renderLast();
};

els.lastFoil.onchange = () => {
  const last = collection.last;
  change(last.vn, last.foil, -1);
  last.foil = els.lastFoil.checked;
  change(last.vn, last.foil, +1);
};

els.undo.onclick = () => {
  const last = collection.last;
  if (!last) return;
  change(last.vn, last.foil, -1);
  collection.last = null;
  renderLast();
  setStatus('Removed the last card.');
};

// ---------- Manual add ----------

els.search.oninput = () => {
  const q = els.search.value.trim().toLowerCase();
  if (q.length < 2) return els.results.replaceChildren();
  const hits = index.cards
    .filter((c) => c.variantNumber.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q))
    .slice(0, 15);
  els.results.replaceChildren(...hits.map((c) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = '<span></span><span class="muted"></span>';
    b.children[0].textContent = c.name;
    b.children[1].textContent = `${c.variantNumber} · ${c.variantLabel || c.variantType}`;
    b.onclick = () => {
      logCard(c, 'Added by hand');
      els.search.value = '';
      els.results.replaceChildren();
      setStatus(`Added ${c.name}`, 'ok');
    };
    li.append(b);
    return li;
  }));
};

// ---------- Export / clear ----------

els.export.onclick = async () => {
  const rows = [...collection.entries].map(([k, qty]) => {
    const [vn, f] = k.split('|');
    return { card: index.byNumber.get(vn), foil: f === '1', qty };
  }).filter((r) => r.card);
  if (rows.length === 0) return setStatus('Nothing to export yet.', 'bad');
  const name = `riftbound-collection-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File([toCsv(rows)], name, { type: 'text/csv' });
  // On iPhone the share sheet can save straight to Files.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

els.clear.onclick = () => {
  if (!confirm('Remove every scanned card? Export first if you want to keep them.')) return;
  collection.entries.clear();
  collection.last = null;
  save();
  renderList();
  renderLast();
};

// ---------- Status and feedback ----------

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

let audio;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.15);
  } catch { /* no audio */ }
}

function flash(ok) {
  els.flash.className = `flash ${ok ? 'ok' : 'bad'}`;
  requestAnimationFrame(() => requestAnimationFrame(() => (els.flash.className = 'flash')));
}

// ---------- Camera, detection and reading ----------

let worker;
let workerReady;
const tracker = new MotionTracker();
const sampleCanvas = Object.assign(document.createElement('canvas'), { width: SAMPLE_W, height: SAMPLE_H });
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
let reading = false;

function makeCanvas(w, h) {
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// The scan box in video pixel coordinates (the video is shown with object-fit: cover).
function boxInVideo() {
  const v = els.video, vp = els.viewport.getBoundingClientRect(), b = els.box.getBoundingClientRect();
  const scale = Math.max(vp.width / v.videoWidth, vp.height / v.videoHeight);
  const offX = (vp.width - v.videoWidth * scale) / 2, offY = (vp.height - v.videoHeight * scale) / 2;
  return {
    x: (b.left - vp.left - offX) / scale,
    y: (b.top - vp.top - offY) / scale,
    w: b.width / scale,
    h: b.height / scale,
  };
}

function sampleFrame() {
  const r = boxInVideo();
  sampleCtx.drawImage(els.video, r.x, r.y, r.w, r.h, 0, 0, SAMPLE_W, SAMPLE_H);
  const d = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  const f = new Float32Array(SAMPLE_W * SAMPLE_H);
  for (let i = 0, p = 0; p < f.length; i += 4, p++) f[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return f;
}

function captureBox() {
  const r = boxInVideo();
  const c = makeCanvas(Math.round(r.w), Math.round(r.h));
  c.getContext('2d').drawImage(els.video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}

async function readCard() {
  if (reading) return;
  reading = true;
  els.box.className = 'box reading';
  setStatus('Reading…');
  try {
    await workerReady;
    const r = await recognizeCard(captureBox(), worker, index, makeCanvas);
    els.ocrText.textContent = r.text;
    if (r.status === 'ok') {
      const card = r.variants[0];
      logCard(card, r.method === 'number' ? `Read ${r.key}` : 'Matched by name', r.variants);
      setStatus(`Added ${card.name} (${card.variantNumber})`, 'ok');
      beep(true); flash(true);
    } else if (r.status === 'ambiguous') {
      setStatus(`Could be: ${r.names.join(' / ')}. Add it by hand below.`, 'bad');
      beep(false); flash(false);
    } else {
      setStatus('Couldn’t read that card. Try Scan now, or add it by hand.', 'bad');
      beep(false); flash(false);
    }
  } catch (e) {
    console.error(e);
    setStatus(`Reader error: ${e.message}`, 'bad');
  } finally {
    reading = false;
    els.box.className = 'box';
    tracker.scanDone();
  }
}

function loop() {
  if (els.video.readyState >= 2 && els.auto.checked && !reading) {
    const ev = tracker.update(sampleFrame(), performance.now());
    const s = tracker.stats;
    els.meters.textContent = `state ${tracker.state} · motion ${s.motion.toFixed(1)} · vs empty ${s.fromBackground.toFixed(1)} · vs last ${Number.isFinite(s.fromLast) ? s.fromLast.toFixed(1) : '–'}`;
    if (tracker.state === 'moving') els.box.className = 'box moving';
    else if (!reading) els.box.className = 'box';
    if (!worker) { if (document.body.dataset.reader !== 'failed') setStatus('Loading the card reader…'); }
    else if (tracker.state === 'calibrating') setStatus('Hold still with the box empty…');
    else if (tracker.state === 'empty' && !/^(Added|Could|Removed)/.test(els.status.textContent)) setStatus('Ready. Slide a card into the box.');
    if (ev === 'scan') readCard();
  }
  setTimeout(loop, SAMPLE_MS);
}

async function startCamera() {
  els.start.disabled = true;
  audio ??= new AudioContext(); // unlock audio during the tap
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    els.video.srcObject = stream;
    await els.video.play();
  } catch (e) {
    els.start.disabled = false;
    setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
      ? `Camera blocked: ${e.message}`
      : 'The camera needs HTTPS. Open this page from its https:// address.', 'bad');
    return;
  }
  els.start.hidden = true;
  els.scan.disabled = false;
  els.empty.disabled = false;
  tracker.reset();
  setStatus('Loading the card reader…');
  workerReady = import(TESSERACT).then(async (m) => {
    worker = await (m.default ?? m).createWorker('eng');
    document.body.dataset.reader = 'ready';
  });
  workerReady.catch((e) => {
    document.body.dataset.reader = 'failed';
    setStatus(`Couldn’t load the card reader: ${e.message}`, 'bad');
  });
  loop();
}

els.start.onclick = startCamera;
els.scan.onclick = () => readCard();
els.empty.onclick = () => { tracker.setBackground(sampleFrame()); setStatus('Ready. Slide a card into the box.'); };
els.auto.onchange = () => {
  tracker.reset();
  if (!els.auto.checked) setStatus('Auto-detect off. Tap Scan now for each card.');
};

// ---------- Start ----------

await loadCards();
load();
renderList();
