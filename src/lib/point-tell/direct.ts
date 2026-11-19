/**
 * Point and tell: what the marks say on their own. A few marks are complete without an AI: a tab drawn and named,
 * a sketched widget with a name, an object moved with no words. They become the same operations an answer would
 * carry and go through the same judge (stage.ts), so nothing is staged that an answer could not stage.
 * Everything else (a change, a crossed-out object, ink not understood, any mark whose words are a sentence) is
 * for the AI. "Crossed out" is never staged directly: the words and the context say what it means.
 */
import { addTypes } from './vocabulary';
import { draftTabs, isPageMark, NEW_TAB_NAME } from './drafts';
import type { RefTable } from './refs';
import type { PtMark, PtOp, PtPlace, PtRawPlace } from './types';

/** A widget's name as words typed for it: one line, 1 to 60 characters, at most 8 words, not a sentence (no closing mark, no comma or colon). */
export function isName(text: string, max = 60): boolean {
  const t = text.trim();
  return t.length >= 1 && t.length <= max && !/[\r\n]/.test(t) && !/[.?!]$/.test(t) && !/[,;:]/.test(t) && t.split(/\s+/).length <= 8;
}

function rawPlace(refs: RefTable, p: PtPlace): PtRawPlace | null {
  const key = 'before' in p ? 'before' : 'after' in p ? 'after' : 'into';
  const id = (p as Record<string, string>)[key];
  const ref = refs.byId.get(id)?.ref;
  return ref ? { [key]: ref } : null;
}

/** The operations the marks say on their own, in the order of the marks. `refs` is the table of the model with the drawn tabs in it. */
export function directOps(marks: readonly PtMark[], refs: RefTable): PtOp[] {
  const drafts = new Map(draftTabs(marks).map(d => [d.id, d]));
  const out: PtOp[] = [];
  for (const m of marks) {
    const mean = m.meaning;
    if (!mean || m.staged) continue;
    const words = m.text.trim();
    if (mean.kind === 'add' && mean.tab) {
      const d = drafts.get(`draft:${m.n}`);
      const place = rawPlace(refs, mean.place);
      if (!d || !place || !words || words === NEW_TAB_NAME || words.length > 120) continue;
      out.push({ notes: [m.n], op: 'add', type: 'Tab', name: words, place, as: d.ref });
    } else if (mean.kind === 'add' && !mean.page && mean.widget && words && isName(words)) {
      const type = (mean.types ?? []).find(t => addTypes().includes(t));
      const place = rawPlace(refs, mean.place);
      if (!type || !place) continue;
      out.push({ notes: [m.n], op: 'add', type, name: words, place, ...(mean.columns ? { properties: { columns: mean.columns } } : {}) });
    } else if (mean.kind === 'move' && m.targets.length === 1 && !words) {
      const ref = refs.byId.get(m.targets[0])?.ref;
      const to = rawPlace(refs, mean.to);
      if (ref && to) out.push({ notes: [m.n], op: 'move', ref, to });
    }
  }
  return out;
}

/** The operations as the text of an answer (what the stash carries to Blueprint). */
export function answerText(ops: readonly PtOp[]): string {
  const rows = ops.map(o => ({
    note: o.notes[0], op: o.op,
    ...(o.ref ? { ref: o.ref } : {}), ...(o.type ? { type: o.type } : {}), ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.place ? { place: o.place } : {}), ...(o.to ? { to: o.to } : {}), ...(o.properties ? { properties: o.properties } : {}), ...(o.as ? { as: o.as } : {}),
  }));
  return JSON.stringify({ operations: rows });
}

/** Whether a mark is the kind that wants the page created first (a drawn page). */
export const wantsPage = (m: PtMark): boolean => isPageMark(m);
