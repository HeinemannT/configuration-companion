const normalized = value => String(value).replace(/^(role|user|ListPropertySetItem):|^(resource|new|reversed)\./, '').toLowerCase();
function score(query, value, fuzzy = true) {
  const text = normalized(value);
  if (!query || text === query) return 0;
  if (text.startsWith(query)) return 1;
  if (text.includes(query)) return 2;
  if (!fuzzy) return Infinity;
  let previous = -1, gaps = 0;
  for (const char of query) {
    const next = text.indexOf(char, previous + 1);
    if (next < 0) return Infinity;
    gaps += next - previous - 1; previous = next;
  }
  return 3 + gaps / 100;
}
/** Rank before limiting so an exact late catalogue match is not lost. */
export function rankCompletions(rows, query, limit = 80) {
  const q = normalized(query);
  return rows.map(row => ({ row, score: Math.min(score(q, row.value), ...[row.detail, row.search].filter(v => v !== undefined && v !== '').map(v => score(q, v, false))) }))
    .filter(result => Number.isFinite(result.score)).sort((a, b) => a.score - b.score).slice(0, limit).map(result => result.row);
}
