/**
 * Point and tell hands a pasted answer to Blueprint. Blueprint has just loaded the page; the answer is
 * judged again on that fresh model (the same pure code the paste panel used) and each note's operations
 * are pushed onto the history as one step, so the tray can group them by note and each note undoes on its
 * own. Nothing is written to BMP: the staged changes go through Blueprint's own Review and Confirm.
 */
import { showToast } from '../lib/toast';
import { parseAnswer } from '../lib/point-tell/parse-answer';
import { stageAnswer, type PtNoteReport } from '../lib/point-tell/stage';
import { takeStage } from '../lib/point-tell/store';
import { colorInfo } from './colors';
import { bp } from './state';

/** The notes whose staged changes are still in what is being applied: a note with an operation that touches an object still in the
 *  plan. A note whose changes were taken back (its row reverted, or Discard note) has none and stays a plain note. */
export function survivingNotes(reports: readonly PtNoteReport[] | null, planIds: ReadonlySet<string>): Set<number> {
  const out = new Set<number>();
  for (const r of reports ?? []) if (r.n && r.results.some(x => x.verdict === 'ok' && x.ids.some(id => planIds.has(id)))) out.add(r.n);
  return out;
}

/** Stage the waiting answer, if there is one for this page. Call right after a model has been loaded and before the first render. */
export function applyPendingStage(): void {
  if (!bp.history || !bp.baseline || !bp.loadedRid) return;
  const stash = takeStage(bp.loadedRid, Date.now());
  if (!stash) return;
  const parsed = parseAnswer(stash.answer);
  if (!parsed.ok) { showToast(`Blueprint: ${parsed.error}`, 'info'); return; }
  const result = stageAnswer(bp.history.present(), stash.snapshot, parsed.answer, { colorName: bid => colorInfo(bid)?.name });
  for (const step of result.steps) bp.history.push(step.model);
  bp.noteOrigins = new Map(Object.entries(result.origins));
  bp.noteReports = result.reports;
  bp.trayOpen = result.steps.length > 0;
  const dropped = Math.max(0, stash.ready - result.ready);
  const n = result.ready;
  if (dropped) showToast(`Blueprint: ${dropped} of the ${stash.ready} changes could not be staged, because the page is not as it was.`, 'info');
  else if (n) showToast(`Blueprint: staged ${n} change${n === 1 ? '' : 's'} from your notes. Nothing is written until you review and apply.`, 'info');
}
