/** Format whitespace only: keep literal spelling, key order and duplicate keys intact. */
export function jsonFormattingChanges(source) {
  try { JSON.parse(source); } catch { return null; }
  const changes = [];
  let end = 0, depth = 0, previous = '';
  const gap = (to, insert) => {
    if (source.slice(end, to) !== insert) changes.push({ from: end, to, insert });
  };
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)) {
    const token = match[0], closing = token === '}' || token === ']';
    if (closing) depth--;
    const empty = previous === '{' && token === '}' || previous === '[' && token === ']';
    const newline = !empty && (closing || previous === '{' || previous === '[' || previous === ',');
    gap(match.index, newline ? '\n' + '  '.repeat(depth) : previous === ':' ? ' ' : '');
    end = match.index + token.length;
    if (token === '{' || token === '[') depth++;
    previous = token;
  }
  gap(source.length, '');
  return changes;
}
