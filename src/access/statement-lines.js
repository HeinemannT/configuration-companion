// Statement-to-JSON-line map for "JSON follows the selected statement".
// Ranges come from the parsed document (analyzePBAC), never from a text search,
// so two identical statements still map to their own lines.
import { analyzePBAC } from './pbac-document.js';

const lineAt = (starts, offset) => {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid; else high = mid - 1;
  }
  return low + 1;
};

/** Lines are 1-based and inclusive. Returns [] when the text does not parse. */
export function statementLines(text, analysis = analyzePBAC(text)) {
  if (analysis.value === undefined || !Array.isArray(analysis.value?.Statement)) return [];
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return analysis.value.Statement.map((_, index) => {
    const range = analysis.locations.get(JSON.stringify(['Statement', index]));
    return range ? { index, from: lineAt(starts, range.from), to: lineAt(starts, Math.max(range.from, range.to - 1)) } : null;
  });
}

/** First syntax problem as a line number and message, for the blocked Rules view. */
export function parseProblem(text) {
  try { JSON.parse(text); return null; } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = Number(/position (\d+)/.exec(message)?.[1]);
    const explicit = Number(/line (\d+)/.exec(message)?.[1]);
    let line = explicit || 1;
    if (!explicit && Number.isFinite(position)) line = text.slice(0, position).split('\n').length;
    // V8 reports the offending token; a missing comma is usually at the end of the previous line.
    return { line, message: message.replace(/^JSON\.parse: |^Unexpected token/, m => m.startsWith('JSON') ? '' : m) };
  }
}

/** The context panel is a drawer below this width, so the role page and rules keep their width.
 *  Same width as the drawer rule in access-workspace.css. */
export const CONTEXT_DRAWER_BELOW = 1000;
/** The lists (explorer) are a drawer below this width. Same width as access-workspace.css. */
export const EXPLORER_DRAWER_BELOW = 760;
/** JSON beside Rules needs room for both: the lists (about 250 px) plus two panes of about 540 px. */
export function besideFitsWidth(width, listsHidden) {
  return width - (listsHidden ? 0 : 250) >= 1080;
}
