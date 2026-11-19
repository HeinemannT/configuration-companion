/**
 * Point and tell: stage a pasted answer in Blueprint. The page leaves Point and tell, Blueprint opens on this
 * tab, loads the page and stages what the answer asked for; the user reviews and applies there. What is
 * handed over is only the answer's text and the copy's snapshot (the page's storage, read once); the
 * notes behind the staged changes are flagged, so an apply can settle them.
 */
import { sendFireForget } from '../lib/messaging';
import type { PtStageResult } from '../lib/point-tell/stage';
import type { PtCopySnapshot } from '../lib/point-tell/types';
import { recordStaged, stashStage } from '../lib/point-tell/store';
import { pt } from './state';

/** What is handed to Blueprint: the answer's text (or the direct operations as one), the copy's snapshot and what was judged ready. */
export interface StageInput { text: string; snapshot: PtCopySnapshot; result: PtStageResult }

export function stageInBlueprint(leave: () => void): void {
  const a = pt.answer;
  if (!a?.result || !a.snapshot) return;
  stageInput({ text: a.text, snapshot: a.snapshot, result: a.result }, leave);
}

export function stageInput(a: StageInput, leave: () => void): void {
  if (a.result.ready === 0) return;
  const rid = pt.rid;
  const applied: number[] = [];
  const kept: number[] = [];
  for (const r of a.result.reports) {
    if (!r.n || !r.results.some(x => x.verdict === 'ok')) continue;
    const leftovers = r.results.some(x => x.verdict !== 'ok') || r.questions.length > 0 || r.cannot.length > 0;
    (leftovers ? kept : applied).push(r.n);
  }
  recordStaged(rid, { applied, kept });
  stashStage(rid, { answer: a.text, snapshot: a.snapshot, ready: a.result.ready }, Date.now());
  leave();
  sendFireForget({ type: 'POINT_TELL_STAGE' });
}
