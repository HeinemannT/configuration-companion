/**
 * For one target, compared and applied by Companion over its own connection
 * (fake worker, fake target): the connected workspaces, Compare running the
 * probe as previews on the target one part at a time, the confirmation
 * before anything is written, the Check that must say Ready, the committed
 * parts one at a time with `confirmed`, a failed, rolled back or timed-out
 * part that stops the run, Stop between parts, the comparison afterwards as
 * the outcome, and closing the window during an apply.
 */
import { describe, expect, it } from 'vitest';
import { CHECK_READY_LINE, CREATED_MARKER, NO_CHANGES_LINE, checkSaysReady, storedNothing } from '../../lib/transport-patch';
import type { TransportTarget } from '../../lib/transport-read';
import type { InspectorMessage } from '../../lib/types';
import { objectAtLine } from '../../lib/transport-bundle';
import { applyCounts, applyParts, applySize, choiceOf, CHOICE_PASTE, namedProblem, remainingOf, shownMessage, MESSAGE_SHOWN, TransportController } from '../transport-controller';
import { ENV, fakeWorker, flush, HOLD, LONG_TEXT, memoryStore, patchCase, probeAnswer, type ProbeTarget, type Sent } from './fakes';

const TARGET_ENV = 'p2@https://bmp.example.test/Test/';
const TARGET: TransportTarget = { environment: TARGET_ENV, label: 'Demo TEST', host: 'bmp.example.test' };

/** What the target holds once every part was applied: the source's texts. */
const source = (id: string, name = `'Name ${id}'`) => ({ cls: 'TextElement', genedit: `\nt.${id}.change(id := '${id}', name := ${name}) //TextElement\n` });

interface Options {
  /** Answer of a committed part (1-based among the committed parts); undefined: ok. */
  committed?: (n: number, msg: Sent) => InspectorMessage | Promise<InspectorMessage> | undefined;
  /** The Check part's log. */
  checkLog?: string;
  /** The target after the apply (default: matches the source). */
  after?: ProbeTarget;
  /** The log of a committed part's dry run (1-based among them); undefined: no problem. */
  dryRun?: (n: number, msg: Sent) => InspectorMessage | string | undefined;
  /** When objects were added, by address (the read after the apply). */
  created?: Record<string, string>;
}

function directCase(opts: Options = {}) {
  const c = patchCase();
  const w = fakeWorker();
  w.targets = [TARGET];
  const store = memoryStore();
  const ctl = new TransportController({ ...w.deps, store }, { since: '2026-11-08' });
  let target: ProbeTarget = { ...c.target };
  const after: ProbeTarget = opts.after ?? { ...c.target, 't.el_change': source('el_change', LONG_TEXT), 't.el_new': source('el_new') };
  const runs: Sent[] = [];
  let committed = 0;
  let tried = 0;
  const result = (msg: Sent, over: Record<string, unknown>) => ({ type: 'TRANSPORT_PART_RESULT', requestId: msg.requestId, environment: ENV, target: msg.target, ok: true, ...over }) as InspectorMessage;
  const answer = (msg: Sent): InspectorMessage | Promise<InspectorMessage> | undefined => {
    if (msg.type !== 'TRANSPORT_RUN_PART') return c.answer!(msg) as InspectorMessage;
    runs.push(msg);
    const probe = ctl.bundle!.target!.probe;
    if (!msg.transactional) {
      const part = probe.parts.find(p => p.text === msg.code);
      if (part) return result(msg, { log: probeAnswer(probe, target, { parts: [part.index] }) });
      const code = msg.code as string;
      if (code.includes(CREATED_MARKER)) {
        const ids = [...code.matchAll(/list\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]));
        const lines = ids.map(id => { const c = opts.created?.[`t.${id}`] ?? ''; return `\nt ${id.length}:${id} ${c.length}:${c}`; });
        return result(msg, { log: `${CREATED_MARKER}${lines.join('')}\n${CREATED_MARKER} end` });
      }
      const writes = applyParts(ctl.bundle!.target!.patch!).filter(p => p.run === 'committed');
      if (writes.some(p => p.text === code)) {
        tried++;
        const own = opts.dryRun?.(tried, msg);
        if (own && typeof own !== 'string') return own;
        return result(msg, { log: own ?? 'done' });
      }
      return result(msg, { log: opts.checkLog ?? `Transport check (4 checks in this part)\n${CHECK_READY_LINE}` });
    }
    committed++;
    const own = opts.committed?.(committed, msg);
    if (own) return own;
    const total = applyParts(ctl.bundle!.target!.patch!).filter(p => p.run === 'committed').length;
    if (committed === total) target = after;
    return result(msg, { log: 'done' });
  };
  w.answer = answer;
  return { ...c, w, ctl, runs, answer, result, store, t: () => ctl.bundle!.target! };
}

/** Scan, tick all, choose the connected target and Compare. */
async function compared(opts: Options = {}) {
  const k = directCase(opts);
  await k.ctl.scan();
  k.ctl.setGroupTicked('portal', true);
  await k.ctl.loadTargets();
  k.ctl.setTarget(TARGET_ENV);
  await k.ctl.buildBundle();
  return k;
}

const committedRuns = (runs: Sent[]) => runs.filter(r => r.transactional);

describe('the connected workspaces', () => {
  it('are read when the window opens; the first is the target until the person chooses; any other cannot be chosen', async () => {
    const { w, ctl } = directCase();
    expect(ctl.targets).toBeNull();
    await ctl.loadTargets();
    expect(w.targetsSent).toEqual([expect.objectContaining({ type: 'TRANSPORT_TARGETS', environment: ENV })]);
    expect(ctl.targets).toEqual([TARGET]);
    expect(ctl.chosenTarget).toEqual(TARGET);
    expect(ctl.choice).toBe(choiceOf(TARGET_ENV));
    ctl.setTarget('p9@https://elsewhere.test/');
    expect(ctl.target).toBe(TARGET_ENV);
    ctl.setChoice(CHOICE_PASTE);
    expect(ctl.chosenTarget).toBeUndefined();
    // Chosen by the person: reading again does not choose for them.
    await ctl.loadTargets();
    expect(ctl.chosenTarget).toBeUndefined();
    ctl.setChoice(choiceOf(TARGET_ENV));
    expect(ctl.chosenTarget).toEqual(TARGET);
    // Read again without it: back to paste.
    w.targets = [];
    await ctl.loadTargets();
    expect(ctl.target).toBe('');
    expect(ctl.chosenTarget).toBeUndefined();
  });

  it('nothing chosen: the paste flow, nothing runs on a target', async () => {
    const k = directCase();
    await k.ctl.scan();
    k.ctl.setGroupTicked('portal', true);
    await k.ctl.loadTargets();
    k.ctl.setChoice(CHOICE_PASTE);
    await k.ctl.buildBundle();
    expect(k.t().direct).toBeUndefined();
    expect(k.runs).toEqual([]);
  });
});

describe('Compare', () => {
  it('runs every probe part on the target as a preview, one at a time, and builds the patch from the answers', async () => {
    const k = directCase();
    await k.ctl.scan();
    k.ctl.setGroupTicked('portal', true);
    await k.ctl.loadTargets();
    k.ctl.setTarget(TARGET_ENV);
    // Hold the target's answers to see one request at a time.
    k.w.answer = (m: Sent) => (m.type === 'TRANSPORT_RUN_PART' ? HOLD : k.answer(m));
    const held = k.w.pending;
    const done = k.ctl.buildBundle();
    await flush(30);
    const probe = k.t().probe;
    expect(held).toHaveLength(1);
    expect(held[0].msg).toMatchObject({ type: 'TRANSPORT_RUN_PART', environment: ENV, target: TARGET_ENV, code: probe.parts[0].text, transactional: false });
    expect(held[0].msg.confirmed).toBeUndefined();
    expect(k.t().direct!.phase).toEqual({ kind: 'comparing', part: 1, total: probe.parts.length });
    expect(k.ctl.busy).toBe(true);
    k.w.answer = k.answer;
    const first = held.shift()!;
    first.resolve(k.answer(first.msg) as InspectorMessage);
    await done;
    expect(k.t().direct!.phase).toEqual({ kind: 'reviewed' });
    expect(k.t().direct!.answerFrom).toBe(TARGET_ENV);
    expect(k.t().patch!.counts).toMatchObject({ create: 1, change: 1, same: 1, leftOut: 1 });
    expect(k.runs.every(r => !r.transactional)).toBe(true);
  });

  it('Stop cancels the part that runs and ends the comparison', async () => {
    const k = directCase();
    await k.ctl.scan();
    k.ctl.setGroupTicked('portal', true);
    await k.ctl.loadTargets();
    k.ctl.setTarget(TARGET_ENV);
    k.w.answer = (m: Sent) => (m.type === 'TRANSPORT_RUN_PART' ? HOLD : k.answer(m));
    const done = k.ctl.buildBundle();
    await flush(30);
    const id = k.w.pending[0].msg.requestId;
    k.ctl.stopCompare();
    await done;
    expect(k.w.posted).toContainEqual({ type: 'TRANSPORT_CANCEL', requestId: id });
    expect(k.t().direct!.phase).toMatchObject({ kind: 'stopped', stage: 'compare', after: 0 });
    expect(k.ctl.canApply()).toBe(false);
    expect(k.ctl.canCompare()).toBe(true);
  });

  it('a part that fails on the target ends the comparison with its message', async () => {
    const k = directCase();
    const answer = k.answer;
    k.w.answer = (m: Sent) => (m.type === 'TRANSPORT_RUN_PART' ? k.result(m, { ok: false, error: '  Syntax error at line 3  ' }) : answer(m));
    await k.ctl.scan();
    k.ctl.setGroupTicked('portal', true);
    await k.ctl.loadTargets();
    k.ctl.setTarget(TARGET_ENV);
    await k.ctl.buildBundle();
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'compare', part: 1, error: 'Syntax error at line 3' });
    expect(k.t().patch).toBeUndefined();
  });
});

describe('Apply', () => {
  it('needs the confirmation every time; Cancel sends nothing', async () => {
    const k = await compared();
    const before = k.runs.length;
    await k.ctl.apply();
    expect(k.runs).toHaveLength(before);
    expect(k.ctl.canApply()).toBe(true);
    k.ctl.requestApply();
    expect(k.t().direct!.phase).toEqual({ kind: 'confirming' });
    // Options are locked while it is asked.
    k.ctl.setClearExtra(true);
    expect(k.t().clearExtra).toBe(false);
    k.ctl.cancelApply();
    expect(k.t().direct!.phase).toEqual({ kind: 'reviewed' });
    expect(k.runs).toHaveLength(before);
  });

  it('runs the Check as a preview, then each committed part with confirmed, one at a time, no Report; then compares again', async () => {
    const k = await compared();
    const patch = k.t().patch!;
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    const sent = k.runs.slice(before);
    const plan = applyParts(patch);
    expect(plan.map(p => p.step)).toEqual(['check', 'create', 'set']);
    // The Check, then each committed part once as a preview (the dry run),
    // then each committed with the same text.
    const writes = plan.filter(p => p.run === 'committed');
    const head = 1 + 2 * writes.length;
    expect(sent.slice(0, head).map(r => [r.code, r.transactional, r.confirmed])).toEqual([
      [plan[0].text, false, undefined],
      ...writes.map(p => [p.text, false, undefined]),
      ...writes.map(p => [p.text, true, true]),
    ]);
    expect(sent.some(r => /Transport report/.test(r.code as string))).toBe(false);
    // Then the probe again, as previews, and when the added object was added.
    expect(sent.slice(head, head + k.t().probe.parts.length).map(r => r.code)).toEqual(k.t().probe.parts.map(p => p.text));
    expect(sent.slice(head + k.t().probe.parts.length).map(r => [(r.code as string).split('\n')[0], r.transactional])).toEqual([[`_r := "${CREATED_MARKER}"`, false]]);
    expect(k.t().direct!.phase).toEqual({ kind: 'done', remaining: 0 });
    expect(k.t().patch!.nothingToDo).toBe(true);
    expect(k.ctl.canApply()).toBe(false);
  });

  it('progress names the step and the part, with the time it started', async () => {
    const k = await compared({ committed: () => undefined });
    k.ctl.requestApply();
    const phases: unknown[] = [];
    k.ctl.onChange(c => { if (c.kind === 'apply') phases.push({ ...k.t().direct!.phase }); });
    await k.ctl.apply();
    const applying = phases.filter(p => (p as { kind: string }).kind === 'applying');
    expect(applying.map(p => [(p as { step: string }).step, (p as { part: number }).part, (p as { total: number }).total])).toEqual([['check', 1, 3], ['create', 2, 3], ['set', 3, 3]]);
    expect((applying[0] as { startedAt: number }).startedAt).toBe(k.w.deps.now().getTime());
  });

  it('a Check that does not say Ready stops before any write and shows its lines', async () => {
    const k = await compared({ checkLog: 'Transport check (4 checks in this part)\nCHANGED since the probe t.el_change\nStop: the target changed since the probe.' });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs)).toEqual([]);
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'check', lines: ['Transport check (4 checks in this part)', 'CHANGED since the probe t.el_change', 'Stop: the target changed since the probe.'] });
    // A line that only looks like Ready is not Ready.
    expect(checkSaysReady(`x ${CHECK_READY_LINE}`)).toBe(false);
    expect(checkSaysReady(`a\r\n  ${CHECK_READY_LINE}  \r\nb`)).toBe(true);
    expect(k.ctl.canCompare()).toBe(true);
    expect(k.ctl.canApply()).toBe(false);
  });

  it('a committed part that is not ok stops the run: later parts do not run', async () => {
    const k = await compared({ committed: (n, m) => (n === 1 ? { type: 'TRANSPORT_PART_RESULT', requestId: m.requestId, environment: ENV, target: TARGET_ENV, ok: false, error: `Other classes than expected: t.el_new (Kpi). Nothing in this part was applied.\n${'x'.repeat(2_000)}`, log: '' } as InspectorMessage : undefined) });
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs.slice(before))).toHaveLength(1);
    const ph = k.t().direct!.phase;
    // Nothing was applied: the record is the one kept before the first write.
    expect(k.ctl.lastApply?.stoppedAfter).toBeUndefined();
    expect(ph).toMatchObject({ kind: 'failed', stage: 'apply', part: 2, total: 3, step: 'create', applied: 0 });
    expect(ph.kind === 'failed' && ph.unknown).toBeFalsy();
    expect(ph.kind === 'failed' && ph.error.length).toBe(MESSAGE_SHOWN + 1);
    // No comparison afterwards: the window offers Compare again. Sent: the
    // Check, the dry run of both parts, the first committed part.
    expect(k.runs.slice(before)).toHaveLength(4);
  });

  it('an ok answer whose log says nothing was stored is a failure', async () => {
    const k = await compared({ committed: (n, m) => (n === 2 ? { type: 'TRANSPORT_PART_RESULT', requestId: m.requestId, environment: ENV, target: TARGET_ENV, ok: true, log: `Error in line 2\n${NO_CHANGES_LINE}` } as InspectorMessage : undefined) });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'apply', part: 3, step: 'set', applied: 1, error: `Error in line 2\n${NO_CHANGES_LINE}` });
    expect(storedNothing('fine')).toBe(false);
  });

  it('a committed part that times out is reported as unknown and not tried again', async () => {
    const k = await compared({ committed: () => Promise.reject(Object.assign(new Error('Timed out'), { kind: 'timeout' })) as never });
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs.slice(before))).toHaveLength(1);
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'apply', part: 2, unknown: true, error: 'The server did not answer in time.' });
    // A server answer that says the outcome is unknown is the same.
    const k2 = await compared({ committed: (_n, m) => ({ type: 'TRANSPORT_PART_RESULT', requestId: m.requestId, environment: ENV, target: TARGET_ENV, ok: false, error: 'EC execution timed out (120s)', errorKind: 'timeout', outcomeUnknown: true } as InspectorMessage) });
    k2.ctl.requestApply();
    await k2.ctl.apply();
    expect(k2.t().direct!.phase).toMatchObject({ kind: 'failed', unknown: true });
  });

  it('Stop takes effect after the part that runs; that part is not cancelled', async () => {
    const k = await compared();
    k.ctl.requestApply();
    const hold = k.w.answer!;
    k.w.answer = (m: Sent) => (m.type === 'TRANSPORT_RUN_PART' && m.transactional ? HOLD : hold(m));
    const done = k.ctl.apply();
    await flush(30);
    expect(k.w.pending).toHaveLength(1);
    const running = k.w.pending.shift()!;
    expect(running.msg.transactional).toBe(true);
    const posted = k.w.posted.length;
    k.ctl.stopApply();
    expect(k.w.posted).toHaveLength(posted);
    expect(k.t().direct!.stopping).toBe(true);
    running.resolve(k.result(running.msg, { log: 'done' }));
    await done;
    expect(k.t().direct!.phase).toEqual({ kind: 'stopped', stage: 'apply', after: 2, total: 3, applied: 1 });
    expect(k.w.pending).toHaveLength(0);
  });

  it('differences that remain after the apply are the outcome, with the review to apply again', async () => {
    const k = await compared({ after: { ...patchCase().target, 't.el_new': source('el_new') } });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(k.t().direct!.phase).toEqual({ kind: 'done', remaining: 1 });
    expect(k.ctl.canApply()).toBe(true);
    k.ctl.requestApply();
    expect(k.t().direct!.phase.kind).toBe('confirming');
  });

  it('the Log entry part runs as the last committed part, before the comparison', async () => {
    const k = await compared();
    k.ctl.setRecord(true);
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    const committed = committedRuns(k.runs.slice(before));
    expect(committed.at(-1)!.code).toContain("_l := t.cc_transport_log");
  });

  it('closing the window during an apply: the running part is finished by the worker, nothing else runs', async () => {
    const k = await compared();
    k.ctl.requestApply();
    const hold = k.w.answer!;
    k.w.answer = (m: Sent) => (m.type === 'TRANSPORT_RUN_PART' && m.transactional ? HOLD : hold(m));
    const done = k.ctl.apply();
    await flush(30);
    const running = k.w.pending.shift()!;
    k.ctl.dispose();
    expect(k.w.posted).toContainEqual({ type: 'TRANSPORT_CANCEL', requestId: running.msg.requestId });
    running.resolve(k.result(running.msg, { log: 'done' }));
    await done;
    expect(committedRuns(k.w.sent.filter(m => m.type === 'TRANSPORT_RUN_PART'))).toHaveLength(1);
  });

  it('the back button does nothing while a part is applied', async () => {
    const k = await compared();
    k.ctl.requestApply();
    const hold = k.w.answer!;
    k.w.answer = (m: Sent) => (m.type === 'TRANSPORT_RUN_PART' && m.transactional ? HOLD : hold(m));
    const done = k.ctl.apply();
    await flush(30);
    k.ctl.backToList();
    expect(k.ctl.tab).toBe('transport');
    const running = k.w.pending.shift()!;
    k.w.answer = hold;
    running.resolve(k.result(running.msg, { log: 'done' }));
    await done;
  });
});

describe('what the confirmation says', () => {
  it('counts in BMP words, the size of what is sent, a shown message', async () => {
    expect(applyCounts({ create: 12, change: 30, move: 4, same: 9, rename: 1, delete: 2, targetOnly: 3, leftOut: 5 })).toBe('12 to add, 30 to change, 4 to move, 2 to delete, 1 ID to change');
    expect(applyCounts({ create: 0, change: 1, move: 0, same: 0, rename: 2, delete: 0, targetOnly: 0, leftOut: 0 })).toBe('1 to change, 2 IDs to change');
    expect(remainingOf({ create: 1, change: 2, move: 3, same: 9, rename: 1, delete: 4, targetOnly: 3, leftOut: 5 })).toBe(10);
    const k = await compared();
    const patch = k.t().patch!;
    expect(applySize(patch)).toEqual({ parts: 3, chars: applyParts(patch).reduce((n, p) => n + p.text.length, 0) });
    expect(shownMessage('  a  ')).toBe('a');
  });
});

describe('the dry run before the first write', () => {
  const failed = (k: Awaited<ReturnType<typeof compared>>) => k.t().direct!.phase;
  const undoKeys = (k: Awaited<ReturnType<typeof compared>>) => Object.keys(k.store.data).filter(x => x.startsWith('crev_transport_undo:'));

  it('a part whose preview says it would fail stops before any committed request; its lines are shown with their step', async () => {
    const k = await compared({ dryRun: n => (n === 1 ? 'Result : \nFailed to write description on t.el_new\nMissing value for t.cc_other\nDuration : 3ms' : '  Property status not found on TextElement  ') });
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs.slice(before))).toEqual([]);
    expect(failed(k)).toMatchObject({
      kind: 'failed', stage: 'dryrun', applied: 0, error: 'The scripts would fail on Demo TEST. Nothing was changed.',
      lines: ['Add · t.el_new: Failed to write description on t.el_new', 'Change: Property status not found on TextElement'],
    });
    // Nothing was written: nothing to undo.
    expect(undoKeys(k)).toEqual([]);
    expect(k.ctl.lastApply).toBeNull();
  });

  it('counts a part that is not ok, a class that cannot be added and a run that stored nothing; at most 20 lines', async () => {
    const k = await compared({ dryRun: (n, m) => (n === 1 ? k.result(m, { ok: false, error: 'Syntax error at line 3' }) : `Can't add an object of type Kpi under t.page\n${NO_CHANGES_LINE}`) });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(failed(k)).toMatchObject({ stage: 'dryrun', lines: ['Add: Syntax error at line 3', "Change: Can't add an object of type Kpi under t.page", `Change: ${NO_CHANGES_LINE}`] });
    const many = await compared({ dryRun: () => Array.from({ length: 15 }, (_, i) => `Failed to write name on t.x${i}`).join('\n') });
    many.ctl.requestApply();
    await many.ctl.apply();
    const ph = failed(many);
    expect(ph.kind === 'failed' && ph.lines).toHaveLength(20);
  });

  it('"Missing value for" lines do not count: a later part sees only what its own run adds', async () => {
    const k = await compared({ dryRun: () => 'Missing value for t.el_new\nMissing value for t.cc_other' });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs)).toHaveLength(2);
    expect(failed(k)).toEqual({ kind: 'done', remaining: 0 });
  });

  it('an ok dry run sends each committed part twice, as a preview then committed, with the same text; progress says Trying', async () => {
    const k = await compared();
    const writes = applyParts(k.t().patch!).filter(p => p.run === 'committed');
    const phases: unknown[] = [];
    k.ctl.onChange(c => { if (c.kind === 'apply') phases.push({ ...k.t().direct!.phase }); });
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    for (const p of writes) {
      const sent = k.runs.slice(before).filter(r => r.code === p.text);
      expect(sent.map(r => r.transactional)).toEqual([false, true]);
    }
    expect(phases.filter(p => (p as { kind: string }).kind === 'trying')).toEqual([{ kind: 'trying', part: 1, total: 2 }, { kind: 'trying', part: 2, total: 2 }]);
  });

  it('Stop during the dry run: nothing is written', async () => {
    const k = await compared({ dryRun: n => { if (n === 1) k.ctl.stopApply(); return undefined; } });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs)).toEqual([]);
    expect(failed(k)).toMatchObject({ kind: 'stopped', stage: 'apply', applied: 0 });
  });
});

describe('undo of the last apply', () => {
  const CREATED = 'Nov 16, 2026 21:40:05';
  const KEY = `crev_transport_undo:${ENV}|${TARGET_ENV}`;
  type Stored = { at: string; stoppedAfter?: { part: number; total: number }; added: Array<{ address: string; created?: string }>; changed: Array<{ address: string; after?: { size: number; date: string } }> };

  it('the record is kept before the first write, and finished by the comparison after the apply', async () => {
    let atFirst: Stored | undefined;
    const k = await compared({ created: { 't.el_new': CREATED }, committed: n => { if (n === 1) atFirst = structuredClone(k.store.data[KEY]) as Stored; return undefined; } });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(atFirst).toMatchObject({ target: TARGET_ENV, targetLabel: 'Demo TEST', added: [{ address: 't.el_new' }], changed: [{ address: 't.el_change' }], cannot: [] });
    expect(atFirst!.added[0].created).toBeUndefined();
    expect(atFirst!.changed[0].after).toBeUndefined();
    const done = k.store.data[KEY] as Stored;
    expect(done.added[0].created).toBe(CREATED);
    expect(done.changed[0].after).toEqual({ size: expect.any(Number), date: 'Nov 16, 2026 20:17:30' });
    expect(done.stoppedAfter).toBeUndefined();
    expect(k.ctl.lastApply).toEqual(done);
    // A window opened later reads it for the same source and target.
    const again = new TransportController({ ...k.w.deps, store: k.store }, { since: '2026-11-08' });
    await again.loadTargets();
    await flush(30);
    expect(again.lastApply).toEqual(done);
  });

  it('a failed apply leaves a record: stopped after part i of n, with what the target has then', async () => {
    const k = await compared({ created: { 't.el_new': CREATED }, committed: (n, m) => (n === 2 ? k.result(m, { ok: false, error: 'Failed to write name' }) : undefined) });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'apply', applied: 1 });
    const r = k.store.data[KEY] as Stored;
    expect(r.stoppedAfter).toEqual({ part: 1, total: 2 });
    expect(r.added[0].created).toBe(CREATED);
  });

  it('Undo shows the scripts headed by the apply; they run with Check and dry run; the record goes; nothing kept', async () => {
    const k = await compared({ created: { 't.el_new': CREATED } });
    k.ctl.requestApply();
    await k.ctl.apply();
    const record = k.ctl.lastApply!;
    k.ctl.startUndo();
    const t = k.t();
    expect(t.undoOf).toBe(record);
    const parts = applyParts(t.patch!);
    expect(parts.map(p => [p.step, p.run])).toEqual([['check', 'preview'], ['set', 'committed'], ['delete', 'committed']]);
    expect(parts[2].text).toContain(`str(t.el_new.createdTime.whenMissing("")) = "${CREATED}"`);
    expect(t.direct!.phase).toEqual({ kind: 'reviewed' });
    expect(k.ctl.canApply()).toBe(true);
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    const sent = k.runs.slice(before);
    expect(sent.map(r => [r.code, r.transactional])).toEqual([
      [parts[0].text, false], [parts[1].text, false], [parts[2].text, false], [parts[1].text, true], [parts[2].text, true],
    ]);
    expect(k.t().direct!.phase).toEqual({ kind: 'done', remaining: 0, undone: true, kept: 0 });
    expect(k.store.data[KEY]).toBeUndefined();
    expect(k.ctl.lastApply).toBeNull();
  });

  it('an added object that fails its guard is kept and counted', async () => {
    const opts: Options = { created: { 't.el_new': CREATED } };
    const k = await compared(opts);
    k.ctl.requestApply();
    await k.ctl.apply();
    k.ctl.startUndo();
    opts.committed = (_n, m) => ((m.code as string).includes('descendants()') ? k.result(m, { log: 'Result : \nt.el_new kept: it was changed or has objects under it\nDuration : 3ms' }) : undefined);
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(k.t().direct!.phase).toEqual({ kind: 'done', remaining: 0, undone: true, kept: 1 });
  });

  it('the Check of the undo: when the target changed since the apply, nothing is written and the record stays', async () => {
    const opts: Options = { created: { 't.el_new': CREATED } };
    const k = await compared(opts);
    k.ctl.requestApply();
    await k.ctl.apply();
    k.ctl.startUndo();
    opts.checkLog = 'Undo check (1 check in this part)\nCHANGED since the apply t.el_change\nStop: the target changed since the apply. Do not run the next parts.';
    const before = k.runs.length;
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(committedRuns(k.runs.slice(before))).toEqual([]);
    expect(k.runs.slice(before)).toHaveLength(1);
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'check', error: 'Demo TEST changed since the apply. Nothing was changed.' });
    expect(k.store.data[KEY]).toBeDefined();
  });

  it('Remove deletes the record; nothing refreshes it', async () => {
    const k = await compared({ created: { 't.el_new': CREATED } });
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(k.store.data[KEY]).toBeDefined();
    await k.ctl.removeUndo();
    expect(k.store.data[KEY]).toBeUndefined();
    expect(k.ctl.lastApply).toBeNull();
    // Comparing again does not keep a new one.
    await k.ctl.buildBundle();
    expect(k.store.data[KEY]).toBeUndefined();
  });
});

describe('round 16: what the dry run names, back from an undo', () => {
  const CREATED = 'Nov 16, 2026 21:40:05';

  it('a line "at line n" names the object of that line; the line, column and level are left out', async () => {
    const k = await compared({
      dryRun: n => {
        if (n !== 1) return undefined;
        const add = applyParts(k.t().patch!).find(p => p.step === 'create')!;
        const span = add.spans!.find(x => x.address === 't.el_new')!;
        return `Result : \n[WARNING] Property crev_qa_un_p not found at line ${span.from + 1}, column 85\nProperty other not found at line 1, column 3\nDuration : 3ms`;
      },
    });
    k.ctl.requestApply();
    await k.ctl.apply();
    // Line 1 is the part's header: no object, the line as BMP printed it.
    expect(k.t().direct!.phase).toMatchObject({
      kind: 'failed', stage: 'dryrun',
      lines: ['Add · t.el_new: Property crev_qa_un_p not found', 'Add: Property other not found at line 1, column 3'],
      objects: ['t.el_new'],
    });
  });

  it('the spans of a part cover the lines of each object statement', async () => {
    const k = await compared();
    for (const part of applyParts(k.t().patch!).filter(p => p.run === 'committed')) {
      const lines = part.text.split('\n');
      for (const sp of part.spans ?? []) expect(lines.slice(sp.from - 1, sp.to).join('\n')).toContain(sp.address);
    }
    const add = applyParts(k.t().patch!).find(p => p.step === 'create')!;
    const sp = add.spans!.find(x => x.address === 't.el_new')!;
    expect(objectAtLine(add, sp.from)).toBe('t.el_new');
    expect(objectAtLine(add, 1)).toBeUndefined();
    expect(namedProblem(add, 'Failed to write name on el_new', new Map([['el_new', 't.el_new']]))).toEqual({ text: 'Add · t.el_new: Failed to write name on el_new', address: 't.el_new' });
    expect(namedProblem(add, "Can't add an object of type Kpi", new Map())).toEqual({ text: "Add: Can't add an object of type Kpi" });
  });

  it('"Remove from transport" removes a named object; the comparison is then out of date', async () => {
    const k = await compared();
    expect(k.ctl.addressInTransport('t.el_new')).toBe(true);
    k.ctl.removeAddress('t.el_new');
    expect(k.ctl.addressInTransport('t.el_new')).toBe(false);
    expect(k.ctl.stale).toBe(true);
    expect(k.ctl.canApply()).toBe(false);
  });

  it('after a refused undo, back to the transport: the comparison as it was, Apply and Compare work again', async () => {
    const opts: Options = { created: { 't.el_new': CREATED } };
    const k = await compared(opts);
    const comparison = k.t().patch;
    // A new change to apply: the comparison before the undo had something to do.
    k.ctl.requestApply();
    await k.ctl.apply();
    const after = k.t().patch;
    k.ctl.startUndo();
    expect(k.ctl.showingUndo).toBe(true);
    opts.checkLog = 'Undo check (1 check in this part)\nStop: the target changed since the apply. Do not run the next parts.';
    k.ctl.requestApply();
    await k.ctl.apply();
    expect(k.t().direct!.phase).toMatchObject({ kind: 'failed', stage: 'check' });
    expect(k.ctl.canCompare()).toBe(true);
    k.ctl.backToTransport();
    expect(k.ctl.showingUndo).toBe(false);
    expect(k.t().patch).toBe(after);
    expect(k.t().patch).not.toBe(comparison);
    expect(k.t().direct!.phase).toEqual({ kind: 'done', remaining: 0 });
    expect(k.t().undoOf).toBeUndefined();
    // Compare compares the transport.
    delete opts.checkLog;
    await k.ctl.compareOrBuild();
    expect(k.ctl.showingUndo).toBe(false);
    expect(k.t().direct!.phase).toEqual({ kind: 'reviewed' });
  });

  it('an undo opened without a comparison goes back to none', async () => {
    const k = await compared({ created: { 't.el_new': CREATED } });
    k.ctl.requestApply();
    await k.ctl.apply();
    const again = new TransportController({ ...k.w.deps, store: k.store }, { since: '2026-11-08' });
    await again.loadTargets();
    await flush(30);
    again.startUndo();
    expect(again.showingUndo).toBe(true);
    again.backToTransport();
    expect(again.bundle).toBeNull();
  });
});
