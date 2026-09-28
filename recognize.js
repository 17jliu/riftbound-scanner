// Card lookup and OCR-text matching. Pure functions: no DOM, no Tesseract.
// Shared by the browser app and the Node tests.

export const COLS = ['variantNumber', 'name', 'setName', 'setPrefix', 'rarity', 'variantType', 'variantLabel', 'foilMode'];

export function toCard(row) {
  const c = {};
  COLS.forEach((k, i) => (c[k] = row[i]));
  return c;
}

// The number as printed on the card: "OGN-041a" for OGN-041a, OGN-257-Release and UNL-229* -> base part.
export function printedKey(variantNumber) {
  const m = variantNumber.match(/^([A-Z]+)-([A-Z]{0,2}\d+[a-z]?)/);
  return m ? `${m[1]}-${m[2]}` : variantNumber;
}

export function buildIndex(cards) {
  const byKey = new Map();
  const byNumber = new Map();
  const prefixes = new Set();
  for (const c of cards) {
    byNumber.set(c.variantNumber, c);
    const key = printedKey(c.variantNumber);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
    prefixes.add(key.split('-')[0]);
  }
  // Put the variant whose number equals the printed key first (plain, unsigned, non-promo).
  for (const [key, list] of byKey) {
    list.sort((a, b) => (a.variantNumber === key ? -1 : b.variantNumber === key ? 1 : 0));
  }
  const names = [...new Set(cards.map((c) => c.name))];
  return { cards, byKey, byNumber, prefixes, names };
}

const DIGIT_FIX = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', i: '1', '|': '1', L: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', T: '7' };

function fixDigits(s) {
  return s.replace(/[OoQDIli|LSsBZzGT]/g, (ch) => DIGIT_FIX[ch]);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function fixPrefix(raw, prefixes) {
  const p = raw.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
  if (prefixes.has(p)) return p;
  const close = [...prefixes].filter((x) => x.length === p.length && editDistance(x, p) <= 1);
  return close.length === 1 ? close[0] : null;
}

// Finds a collector number like "OGN • 041a/298" in OCR text.
// Returns { key, variants } or null.
export function parseCollectorNumber(text, index) {
  const re = /([A-Za-z0-9]{3})\s*[•·.,:;\-*°o~+]?\s*([A-Z]{0,2}[0-9OoQDIli|LSsBZzGT]{1,3})\s?([a-c])?\s?([*°'’"])?\s*[\/|]\s*([0-9OoQDIli|LSsBZzGT]{2,3})/g;
  for (const m of text.matchAll(re)) {
    const prefix = fixPrefix(m[1], index.prefixes);
    if (!prefix) continue;
    const suffix = m[3] ?? '';
    const signed = Boolean(m[4]);
    // Read leading letters both as a prefix (R01, SP1) and as misread digits (O21 -> 021).
    const letters = m[2].match(/^[A-Z]{1,2}(?=[0-9])/)?.[0] ?? '';
    const readings = [['', fixDigits(m[2])]];
    if (letters) readings.push([letters, fixDigits(m[2].slice(letters.length))]);
    for (const [lead, digits] of readings) {
      if (!/^\d+$/.test(digits)) continue;
      // Card numbers are always 3 digits; a shorter read dropped a digit, so padding it would guess.
      if (!lead && digits.length !== 3) continue;
      const num = digits;
      for (const key of [`${prefix}-${lead}${num}${suffix}`, `${prefix}-${lead}${num}`]) {
        if (!index.byKey.has(key)) continue;
        let variants = index.byKey.get(key);
        // A star after the number marks a signed printing ("234*/219").
        if (signed) variants = [...variants].sort((a, b) => Number(b.variantNumber.endsWith('*')) - Number(a.variantNumber.endsWith('*')));
        return { key, variants };
      }
    }
  }
  return null;
}

function normWord(w) {
  return w.toLowerCase().normalize('NFKD').replace(/[^a-z0-9']/g, '').replace(/'/g, '');
}

function wordsIn(set, words) {
  return words.every((w) => {
    if (set.has(w)) return true;
    if (w.length < 5) return false;
    const maxD = w.length >= 8 ? 2 : 1;
    for (const x of set) if (editDistance(x, w) <= maxD) return true;
    return false;
  });
}

// Matches a card name from OCR word boxes of the name area.
// words: [{ text, height }]. The title is the tallest text; rules text is smaller.
// Returns the list of matching names, best first (empty if none).
export function matchName(words, index) {
  const clean = words.map((w) => ({ t: normWord(w.text), h: w.height })).filter((w) => w.t.length >= 2);
  if (clean.length === 0) return [];
  const maxH = Math.max(...clean.map((w) => w.h));
  const title = new Set(clean.filter((w) => w.h >= 0.7 * maxH).map((w) => w.t));
  const all = new Set(clean.map((w) => w.t));

  const hits = [];
  for (const name of index.names) {
    const [a, b = ''] = name.split(',').map((s) => s.split(/[\s-]+/).map(normWord).filter(Boolean));
    const segB = b || [];
    const ok = (wordsIn(title, a) && wordsIn(all, segB)) || (segB.length > 0 && wordsIn(title, segB) && wordsIn(all, a));
    if (ok) hits.push({ name, len: a.length + segB.length });
  }
  // A longer full match beats a shorter one ("Stand United" over "Stand").
  hits.sort((x, y) => y.len - x.len);
  const top = hits.length ? hits[0].len : 0;
  return hits.filter((h) => h.len === top).map((h) => h.name);
}

// The variant to log for a name match: the plain printing of that card.
export function variantsForName(name, index) {
  return index.cards
    .filter((c) => c.name === name)
    .sort((a, b) => (a.variantType === 'Standard' ? -1 : 0) - (b.variantType === 'Standard' ? -1 : 0) || a.variantNumber.localeCompare(b.variantNumber, 'en', { numeric: true }));
}

export function defaultFoil(card) {
  return card.foilMode === 'foil_only';
}
