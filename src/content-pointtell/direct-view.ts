/**
 * Point and tell: what can be staged without an AI. The marks that say enough on their own (a named tab, a sketched
 * widget with a name, an object moved with no words) are turned into the same operations an answer carries and judged
 * by the same code. Shown in the paste panel as "Ready without an answer". Nothing is written: staging opens Blueprint.
 */
import { NEW_TAB_NAME } from '../lib/point-tell/drafts';
import { answerText } from '../lib/point-tell/direct';
import { buildPayload } from '../lib/point-tell/payload';
import { stageAnswer, type PtStageResult } from '../lib/point-tell/stage';
import type { PtCopySnapshot } from '../lib/point-tell/types';
import { copyable } from './copy';
import { colorName, colorSets } from './service';
import { pt } from './state';

export interface DirectView { text: string; snapshot: PtCopySnapshot; result: PtStageResult }

let cache: { key: string; view: DirectView | null } | null = null;

/** The direct operations of the marks now, judged against the page now; null when there are none. */
export function directView(): DirectView | null {
  if (!pt.model) return null;
  const marks = copyable();
  const key = JSON.stringify([pt.rid, pt.scope, marks.map(m => [m.n, m.text, m.meaning, m.targets])]);
  if (cache?.key === key) return cache.view;
  const built = buildPayload({ model: pt.model, marks, colors: colorSets(), liveTabId: pt.scene?.liveTabId ?? null, scope: pt.scope, now: Date.now() });
  // A tab with no name yet is not staged on its own.
  const named = (built.snapshot.drafts ?? []).filter(d => d.name !== NEW_TAB_NAME);
  const snapshot = { ...built.snapshot, drafts: named };
  let view: DirectView | null = null;
  if (snapshot.direct?.length) {
    const result = stageAnswer(pt.model, snapshot, { operations: [], questions: [], cannot: [] }, { colorName });
    // Only the operations the marks said on their own: the merge also adds every drawn tab, so count from the direct list.
    if (result.ready > 0) view = { text: answerText(snapshot.direct), snapshot, result };
  }
  cache = { key, view };
  return view;
}

export function resetDirect(): void { cache = null; }
