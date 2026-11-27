/**
 * How far a read of the Atlas model is, and how the page says it. The service
 * worker reports a step with a count where one is known (handlers/atlas.ts,
 * ATLAS_PROGRESS); the page words it. Everything here is pure.
 *
 *  1. properties: the reference properties and the types they are on (one script);
 *  2. held: per type, what its references hold and how many objects fill them;
 *  3. counts: the objects of the types that are only referenced.
 */

export type AtlasReadStep = 'properties' | 'held' | 'counts';

export interface AtlasReadProgress {
  step: AtlasReadStep;
  /** Types done in this step, of `total`. Both 0 where the step has no count. */
  done: number;
  total: number;
  /** When the read started (worker clock, ms). */
  startedAt: number;
}

const STEPS: readonly AtlasReadStep[] = ['properties', 'held', 'counts'];
const STEP_TEXT: Record<AtlasReadStep, string> = {
  properties: 'Reference properties',
  held: 'What the references hold',
  counts: 'Objects per type',
};
/** The share of the whole read each step takes, measured on Steadfast: step 2 is most of it. */
const WEIGHT: Record<AtlasReadStep, [number, number]> = { properties: [0, 0.08], held: [0.08, 0.88], counts: [0.88, 1] };

const num = (n: number) => n.toLocaleString('en-US');

/** How much of the whole read is done, 0 to 1. */
export function progressShare(p: AtlasReadProgress): number {
  const [a, b] = WEIGHT[p.step];
  const inStep = p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;
  return a + (b - a) * inStep;
}

/** "Step 2 of 3: What the references hold, 12 of 140 types". */
export function progressLine(p: AtlasReadProgress): string {
  const step = `Step ${STEPS.indexOf(p.step) + 1} of ${STEPS.length}: ${STEP_TEXT[p.step]}`;
  return p.total > 0 ? `${step}, ${num(p.done)} of ${num(p.total)} ${p.total === 1 ? 'type' : 'types'}` : step;
}

/** "0.4 s", "6.2 s", "42 s", "2 min 5 s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** "284 types, 1,912 references, read in 6.2 s"; without a time, the counts only. */
export function readSummary(types: number, references: number, readMs?: number | null): string {
  const counts = `${num(types)} ${types === 1 ? 'type' : 'types'}, ${num(references)} ${references === 1 ? 'reference' : 'references'}`;
  return readMs != null ? `${counts}, read in ${elapsedText(readMs)}` : counts;
}

/** "as of 14:32" on the day of the read, else "as of 19 Nov 14:32". */
export function asOf(at: number, now: number = Date.now()): string {
  const d = new Date(at), n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return `as of ${time}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `as of ${d.getDate()} ${months[d.getMonth()]} ${time}`;
}

/**
 * A reporter that passes progress on, at most every `everyMs`, but always a
 * new step and the last type of a step. The page draws what it gets, so
 * dropped reports in between lose nothing.
 */
export function progressReporter(send: (p: AtlasReadProgress) => void, now: () => number = Date.now, everyMs = 200): (p: AtlasReadProgress) => void {
  let lastAt = -Infinity;
  let lastStep: AtlasReadStep | null = null;
  return p => {
    const t = now();
    if (p.step !== lastStep || (p.total > 0 && p.done >= p.total) || t - lastAt >= everyMs) {
      lastAt = t;
      lastStep = p.step;
      send(p);
    }
  };
}
