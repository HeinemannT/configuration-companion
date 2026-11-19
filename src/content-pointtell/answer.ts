/**
 * Point and tell: a pasted answer. It is read, the page is read again (so the answer is judged against
 * the page as it is now), and every operation is checked against what the copy showed. Nothing here
 * changes the page or BMP; staging is a separate, explicit step.
 */
import { pageSignature } from '../lib/point-tell/outline';
import { parseAnswer } from '../lib/point-tell/parse-answer';
import { stageAnswer } from '../lib/point-tell/stage';
import { loadCopy } from '../lib/point-tell/store';
import { closeEditor, hooks, marksKey } from './marks';
import { holdReading } from './mascot';
import { colorName, fetchModel } from './service';
import { pt } from './state';

export const COPY_FIRST = 'Copy the notes first.';
export const CHANGED = 'The page changed after you copied.';
export const NOT_REREAD = 'The page could not be read again, so the answer is checked against the page as it was when you turned Point and tell on.';

export function openSheet(): void {
  if (pt.editor) closeEditor(false);
  pt.listOpen = false;
  pt.sheet = 'paste';
  hooks.render();
}

export function closeSheet(): void {
  if (!pt.sheet) return;
  pt.sheet = null;
  pt.answer = null;
  hooks.render();
}

/** Read the pasted text, read the page again, judge each operation. */
export async function receivePaste(text: string): Promise<void> {
  const snapshot = loadCopy(marksKey());
  if (!snapshot) { pt.answer = { text }; hooks.render(); return; }
  const parsed = parseAnswer(text);
  if (!parsed.ok) { pt.answer = { text, error: parsed.error }; hooks.render(); return; }
  const gen = pt.gen;
  pt.answer = { text, busy: true };
  hooks.render();
  const done = holdReading();
  // On the paper page there is no page to read again: the answer is judged against the empty page it stands for.
  const res = pt.page ? null : await fetchModel(pt.rid, snapshot.scope).finally(done);
  if (pt.page) done();
  if (!pt.active || pt.gen !== gen || !pt.sheet) return;
  let banner: string | undefined;
  if (res?.ok && res.model) {
    pt.model = res.model;
    if (res.ctx) pt.ctx = res.ctx;
    hooks.remeasure();
    if (pageSignature(res.model) !== snapshot.sig) banner = CHANGED;
  } else if (!pt.page) banner = NOT_REREAD;
  if (!pt.model) { pt.answer = { text, error: NOT_REREAD }; hooks.render(); return; }
  const result = stageAnswer(pt.model, snapshot, parsed.answer, { colorName });
  pt.answer = { text, answer: parsed.answer, snapshot, result, ...(banner ? { banner } : {}) };
  hooks.render();
}
