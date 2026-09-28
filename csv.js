// CSV in Piltover Archive's collection export format, so it can be imported back.

export const HEADER =
  'Variant Number,Card Name,Set,Set Prefix,Rarity,Variant Type,Variant Label,Foil,Quantity,Language,Condition,Grading Company,Grading Value,Grading Label,Notes';

function field(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rows: [{ card, foil, qty }]
export function toCsv(rows) {
  const lines = rows
    .filter((r) => r.qty > 0)
    .slice()
    .sort((a, b) => a.card.variantNumber.localeCompare(b.card.variantNumber, 'en', { numeric: true }) || Number(a.foil) - Number(b.foil))
    .map(({ card: c, foil, qty }) =>
      [c.variantNumber, c.name, c.setName, c.setPrefix, c.rarity, c.variantType, c.variantLabel, foil, qty, 'English', '', '', '', '', '']
        .map(field)
        .join(','),
    );
  return [HEADER, ...lines].join('\n') + '\n';
}
