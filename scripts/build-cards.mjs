// Builds cards.json from Piltover Archive's public card gallery.
// Run: node scripts/build-cards.mjs
// Re-run whenever a new set releases.

import { writeFileSync } from 'node:fs';

const BASE = 'https://piltoverarchive.com/cards?page=';

function extractVariants(html) {
  const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => JSON.parse(m[1]));
  const s = parts.join('');
  let best = [];
  for (const m of s.matchAll(/"variants":\[\{"id":"[0-9a-f-]{36}","variantNumber"/g)) {
    const start = m.index + '"variants":'.length;
    const arr = parseArrayAt(s, start);
    if (arr.length > best.length) best = arr;
  }
  return best;
}

// Parses the JSON array that starts at s[start] ('[').
function parseArrayAt(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('unterminated array');
}

const byNumber = new Map();
for (let page = 1; page < 100; page++) {
  const res = await fetch(BASE + page, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`);
  const variants = extractVariants(await res.text());
  if (variants.length === 0) break;
  for (const v of variants) byNumber.set(v.variantNumber, v);
  process.stdout.write(`page ${page}: ${variants.length}\n`);
  await new Promise((r) => setTimeout(r, 1000));
}

// Compact rows: [variantNumber, name, setName, setPrefix, rarity, variantType, variantLabel, foilMode]
const rows = [...byNumber.values()]
  .map((v) => [
    v.variantNumber,
    v.card.name,
    v.set.name,
    v.set.prefix,
    v.rarity ?? '',
    v.variantType ?? '',
    v.variantLabel ?? '',
    v.foilMode ?? 'both',
  ])
  .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));

writeFileSync(
  new URL('../cards.json', import.meta.url),
  JSON.stringify({ built: new Date().toISOString(), cards: rows }),
);
console.log(`wrote ${rows.length} variants`);
