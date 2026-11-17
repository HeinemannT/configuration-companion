// @vitest-environment happy-dom
/**
 * The Transport window's view of Compare and Apply on a connected target:
 * the target picker in the Transport tab's header (connected workspaces,
 * the pasted comparison, scripts without comparison), Compare for a
 * connected one, no answer field, the summary line and the states in the
 * list, the scripts closed, the confirmation in the window with the
 * counts, the delete line and the size, progress, the outcome and the
 * failure block.
 */
import { describe, expect, it } from 'vitest';
import { CHECK_READY_LINE, CREATED_MARKER } from '../../lib/transport-patch';
import { draftKey, toDraft } from '../transport-collection';
import type { InspectorMessage } from '../../lib/types';
import { applyParts, CHOICE_ANY, CHOICE_PASTE, choiceOf, TransportController } from '../transport-controller';
import { ANY_TARGET, CONFIRM_DELETE, DRY_RUN_HELP, needsBlock, undoDeleteSentence, elapsedText, mountTransportView, NO_TARGETS, PASTE_TARGET } from '../transport-view';
import { ENV, fakeWorker, flush, LONG_TEXT, memoryStore, patchCase, probeAnswer, type ProbeTarget, type Sent } from './fakes';

const TARGET_ENV = 'p2@https://bmp.example.test/Test/';
const source = (id: string, name = `'Name ${id}'`) => ({ cls: 'TextElement', genedit: `\nt.${id}.change(id := '${id}', name := ${name}) //TextElement\n` });

function setup(opts: { targets?: boolean; failCommitted?: string; dryRun?: string; types?: string; unread?: string; created?: string } = {}) {
  const c = patchCase();
  const w = fakeWorker();
  if (opts.targets !== false) w.targets = [{ environment: TARGET_ENV, label: 'Demo TEST', host: 'bmp.example.test' }];
  const store = memoryStore();
  const ctl = new TransportController({ ...w.deps, store }, { since: '2026-11-08' });
  let target: ProbeTarget = { ...c.target };
  let committed = 0;
  const result = (msg: Sent, over: Record<string, unknown>) => ({ type: 'TRANSPORT_PART_RESULT', requestId: msg.requestId, environment: ENV, target: msg.target, ok: true, ...over }) as InspectorMessage;
  w.answer = msg => {
    if (msg.type === 'TRANSPORT_READ_OBJECTS' && opts.unread) {
      const r = c.answer!(msg) as { objects: Array<{ rid: string }> };
      return { ...r, objects: r.objects.map(o => (c.ids.get(o.rid) === opts.unread ? { rid: o.rid, ok: false, error: 'Timed out' } : o)) } as unknown as InspectorMessage;
    }
    if (msg.type !== 'TRANSPORT_RUN_PART') return c.answer!(msg) as InspectorMessage;
    const probe = ctl.bundle!.target!.probe;
    if (!msg.transactional) {
      const part = probe.parts.find(p => p.text === msg.code);
      if (opts.created && (msg.code as string).includes(CREATED_MARKER)) {
        return result(msg, { log: `${CREATED_MARKER}\nt 6:el_new ${opts.created.length}:${opts.created}\n${CREATED_MARKER} end` });
      }
      const tried = !part && opts.dryRun && applyParts(ctl.bundle!.target!.patch!).some(p => p.run === 'committed' && p.text === msg.code);
      if (tried) return result(msg, { log: opts.dryRun });
      return result(msg, { log: part ? probeAnswer(probe, target, { parts: [part.index], ...(opts.types ? { types: opts.types } : {}) }) : `Transport check\n${CHECK_READY_LINE}` });
    }
    committed++;
    if (opts.failCommitted) return result(msg, { ok: false, error: opts.failCommitted });
    if (committed === 2) target = { ...c.target, 't.el_change': source('el_change', LONG_TEXT), 't.el_new': source('el_new') };
    return result(msg, { log: 'done' });
  };
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  mountTransportView(host, ctl, { now: () => new Date(2026, 10, 15, 12, 0, 0) });
  const $ = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
  const $$ = <T extends Element = HTMLElement>(s: string) => [...host.querySelectorAll<T>(s)];
  return { w, ctl, store, c, $, $$ };
}

async function chosen(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.ctl.loadTargets();
  await s.ctl.scan();
  s.ctl.setGroupTicked('portal', true);
  s.$<HTMLButtonElement>('.tr-open')!.click();
  await flush(20);
  return s;
}

async function compared(opts: Parameters<typeof setup>[0] = {}) {
  const s = await chosen(opts);
  s.$<HTMLButtonElement>('.tr-act')!.click();
  await flush(60);
  return s;
}

const choose = (sel: HTMLSelectElement, value: string) => {
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('the target picker', () => {
  it('connected workspaces, the pasted comparison, scripts without comparison; Compare or Build scripts', async () => {
    const { $ } = await chosen();
    const sel = $<HTMLSelectElement>('.tr-target')!;
    expect([...sel.options].map(o => [o.value, o.text])).toEqual([
      [choiceOf(TARGET_ENV), 'Demo TEST · bmp.example.test'], [CHOICE_PASTE, PASTE_TARGET], [CHOICE_ANY, ANY_TARGET],
    ]);
    expect([PASTE_TARGET, ANY_TARGET]).toEqual(['Another workspace: compare by pasted script', 'Another workspace: scripts only, no comparison']);
    expect(sel.value).toBe(choiceOf(TARGET_ENV));
    expect($('.tr-act')!.textContent).toBe('Compare');
    expect($('.tr-apply')!.hidden).toBe(false);
    choose(sel, CHOICE_PASTE);
    expect($('.tr-act')!.textContent).toBe('Build scripts');
    expect($('.tr-apply')!.hidden).toBe(true);
    choose(sel, CHOICE_ANY);
    expect($('.tr-act')!.textContent).toBe('Build scripts');
  });

  it('no other connected workspace: a disabled line in the picker, the pasted comparison chosen', async () => {
    const { $ } = await chosen({ targets: false });
    const sel = $<HTMLSelectElement>('.tr-target')!;
    expect(sel.options[0].text).toBe(NO_TARGETS);
    expect(sel.options[0].disabled).toBe(true);
    expect(sel.value).toBe(CHOICE_PASTE);
    expect($('.tr-act')!.textContent).toBe('Build scripts');
  });
});

describe('Compare and Apply', () => {
  it('no answer field; the summary line, the states in the list, the scripts closed; Apply ready', async () => {
    const { $, $$ } = await compared();
    expect($('.tr-answer')).toBeNull();
    expect($('.tr-sum')!.textContent).toBe('1 to add · 1 to change · 1 the same · 1 left out');
    expect($$('.tr-trow .tr-tag[data-state]').map(t => t.textContent).sort()).toEqual(['left out', 'the same', 'to add', 'to change']);
    expect($<HTMLDetailsElement>('.tr-scripts')!.open).toBe(false);
    expect($('.tr-scripts > summary')!.textContent).toMatch(/^Scripts · \d+ parts?$/);
    // With a connected target, Copy all and Download stay inside the closed block.
    expect($('.tr-sumline .tr-copyall')).toBeNull();
    expect($('.tr-scripts .tr-copyall')).not.toBeNull();
    expect($('.tr-apply')!.textContent).toBe('Apply to Demo TEST');
    expect($<HTMLButtonElement>('.tr-apply')!.disabled).toBe(false);
    expect($('.tr-act')!.textContent).toBe('Compare again');
  });

  it('Apply opens the confirmation; Cancel closes it; Apply in it runs and shows the outcome', async () => {
    const { $, w, ctl } = await compared();
    const runs = () => w.sent.filter(m => m.type === 'TRANSPORT_RUN_PART' && m.transactional).length;
    $<HTMLButtonElement>('.tr-apply')!.click();
    const confirm = $('.tr-confirm')!;
    expect(confirm.getAttribute('role')).toBe('group');
    expect($('.tr-confirm-h')!.textContent).toBe('Apply to Demo TEST (bmp.example.test)?');
    expect($('.tr-confirm-counts')!.textContent).toBe('1 to add, 1 to change');
    expect($('.tr-confirm-del')).toBeNull();
    expect($('.tr-confirm-size')!.textContent).toMatch(/^3 parts, [\d,]+ characters\.$/);
    expect($<HTMLButtonElement>('.tr-apply')!.disabled).toBe(true);
    // The transport cannot change while the apply is confirmed.
    expect($<HTMLButtonElement>('.tr-rm')!.disabled).toBe(true);
    $<HTMLButtonElement>('.tr-confirm-cancel')!.click();
    expect($('.tr-confirm')).toBeNull();
    expect(runs()).toBe(0);
    $<HTMLButtonElement>('.tr-apply')!.click();
    $<HTMLButtonElement>('.tr-confirm-apply')!.click();
    await flush(80);
    expect(runs()).toBe(2);
    expect(ctl.bundle!.target!.direct!.phase.kind).toBe('done');
    expect($('.tr-outcome')!.textContent).toBe('Applied. Demo TEST matches.');
  });

  it('the delete line in the confirmation when deletes are on', async () => {
    const { $, ctl } = await compared();
    // Scripts with deletes, as the comparison would build them.
    const t = ctl.bundle!.target!;
    t.patch = { ...t.patch!, counts: { ...t.patch!.counts, delete: 2 } };
    $<HTMLButtonElement>('.tr-apply')!.click();
    expect($('.tr-confirm-del')!.textContent).toBe(CONFIRM_DELETE);
    expect($('.tr-confirm-counts')!.textContent).toBe('1 to add, 1 to change, 2 to delete');
  });

  it('a failed part: the failure block with the step, the message and what was applied', async () => {
    const { $ } = await compared({ failCommitted: 'Other classes than expected: t.el_new (Kpi).' });
    $<HTMLButtonElement>('.tr-apply')!.click();
    $<HTMLButtonElement>('.tr-confirm-apply')!.click();
    await flush(60);
    const fail = $('.tr-failure')!;
    expect($('.tr-direct-state')!.getAttribute('role')).toBe('alert');
    expect($('.tr-failure-h')!.textContent).toBe('Add failed: part 2 of 3.');
    expect($('.tr-failure-msg')!.textContent).toBe('Other classes than expected: t.el_new (Kpi).');
    expect(fail.textContent).toContain('This part stored nothing.');
    expect(fail.textContent).toContain('Nothing before it was changed.');
    expect($<HTMLButtonElement>('.tr-apply')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('.tr-act')!.disabled).toBe(false);
  });

  it('removing an object after the comparison: the transport changed, Apply waits for Compare', async () => {
    const { $, ctl } = await compared();
    $<HTMLButtonElement>('.tr-rm')!.click();
    expect(ctl.stale).toBe(true);
    expect($('.tr-stale')!.textContent).toBe('The transport changed since the comparison.');
    expect($<HTMLButtonElement>('.tr-apply')!.disabled).toBe(true);
    expect($('.tr-act')!.textContent).toBe('Compare');
  });

  it('elapsed time in seconds, then minutes', () => {
    expect(elapsedText(12_400)).toBe('12 s');
    expect(elapsedText(185_000)).toBe('3 min 5 s');
  });
});

describe('dry run, undo, types switched off, objects not read here', () => {
  const apply = async ($: ReturnType<typeof setup>['$']) => {
    $<HTMLButtonElement>('.tr-apply')!.click();
    $<HTMLButtonElement>('.tr-confirm-apply')!.click();
    await flush(120);
  };

  it('a dry run that would fail: its block with the lines; nothing written, no last apply', async () => {
    const { $, $$, w } = await compared({ dryRun: 'Failed to write name on t.el_new\nMissing value for t.cc_x' });
    await apply($);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_RUN_PART' && m.transactional)).toEqual([]);
    expect($('.tr-failure-h')!.textContent).toBe('The scripts would fail on Demo TEST. Nothing was changed.');
    // Each line names its object: from an ID of the transport in it.
    expect($('.tr-dryrun-lines')!.textContent).toBe('Add · t.el_new: Failed to write name on t.el_new\nChange · t.el_new: Failed to write name on t.el_new');
    expect($('.tr-dryrun-help')!.textContent).toBe(DRY_RUN_HELP);
    expect($$('.tr-dryrun-objects li').map(li => li.textContent)).toEqual(['t.el_newRemove from transport']);
    expect($('.tr-lastapply')!.hidden).toBe(true);
  });

  it('after an apply: the last apply line with Undo and Remove; Undo shows its scripts and undoes; the line goes', async () => {
    const { $, $$, ctl, store } = await compared();
    await apply($);
    expect($('.tr-lastapply')!.hidden).toBe(false);
    expect($('.tr-lastapply-t')!.textContent).toBe('Last apply to Demo TEST: 15 Nov 12:00 · 1 added, 1 changed');
    expect($('.tr-undo')!.textContent).toBe('Undo');
    expect($('.tr-undo-remove')!.textContent).toBe('Remove');
    $<HTMLButtonElement>('.tr-undo')!.click();
    await flush(20);
    expect($('.tr-undo-h')!.textContent).toBe('Undo of the apply of 15 Nov 12:00');
    // When the added object was added was not read here: it stays, listed.
    const cannot = $('[data-need="cannot-undo"]')!;
    expect(cannot.querySelector('summary')!.textContent).toBe('1 object: cannot be undone');
    expect($$('.tr-cannotlist li').map(li => li.textContent)).toEqual(['t.el_new kept: when it was added was not read']);
    expect(ctl.canApply()).toBe(true);
    await apply($);
    expect($('.tr-outcome')!.textContent).toBe('Undone. Demo TEST is as it was before the apply.');
    expect($('.tr-lastapply')!.hidden).toBe(true);
    expect(Object.keys(store.data).filter(k => k.startsWith('crev_transport_undo:'))).toEqual([]);
  });

  it('Remove deletes the last apply', async () => {
    const { $, store } = await compared();
    await apply($);
    $<HTMLButtonElement>('.tr-undo-remove')!.click();
    await flush(20);
    expect($('.tr-lastapply')!.hidden).toBe(true);
    expect(Object.keys(store.data).filter(k => k.startsWith('crev_transport_undo:'))).toEqual([]);
  });

  it('types switched off on the target: a line with the classes', async () => {
    const { $, $$ } = await compared({ types: 'TextElement;false&Category;true' });
    const off = $('[data-need="types-off"]')!;
    expect(off.querySelector('summary')!.textContent).toBe('1 object has a type that is switched off on Demo TEST');
    expect($$('.tr-typesofflist li').map(li => li.textContent)).toEqual(['TextElement']);
  });

  it('an object that could not be read here: nothing is deleted, and the summary says why', async () => {
    const { $ } = await compared({ unread: 'el_same' });
    expect($('[data-need="unread"]')!.textContent).toBe('1 object could not be read here, so nothing is deleted on Demo TEST.');
  });
});

describe('round 16', () => {
  const apply = async ($: ReturnType<typeof setup>['$']) => {
    $<HTMLButtonElement>('.tr-apply')!.click();
    $<HTMLButtonElement>('.tr-confirm-apply')!.click();
    await flush(120);
  };

  it('the undo is confirmed as an undo: its heading, its button, the deletes without the dangerous sentence', async () => {
    const { $ } = await compared({ created: 'Nov 15, 2026 12:00:05' });
    await apply($);
    $<HTMLButtonElement>('.tr-undo')!.click();
    await flush(20);
    expect($('.tr-apply')!.textContent).toBe('Undo on Demo TEST');
    $<HTMLButtonElement>('.tr-apply')!.click();
    expect($('.tr-confirm-h')!.textContent).toBe('Undo the apply of 15 Nov 12:00 on Demo TEST (bmp.example.test)?');
    expect($('.tr-confirm-apply')!.textContent).toBe('Undo');
    expect($('.tr-confirm-undel')!.textContent).toBe(undoDeleteSentence(1));
    expect(undoDeleteSentence(3)).toBe('3 objects the apply added are deleted again.');
    expect($('.tr-confirm-del')).toBeNull();
    expect($('.tr-confirm')!.textContent).not.toContain(CONFIRM_DELETE);
  });

  it('back to the transport from the undo: the link in its heading, and the header button compares again', async () => {
    const { $, ctl } = await compared({ created: 'Nov 15, 2026 12:00:05' });
    await apply($);
    $<HTMLButtonElement>('.tr-undo')!.click();
    await flush(20);
    expect($('.tr-act')!.textContent).toBe('Compare');
    expect($<HTMLButtonElement>('.tr-act')!.disabled).toBe(false);
    const back = $<HTMLButtonElement>('.tr-undo-hl .tr-undo-back')!;
    expect(back.textContent).toBe('Back to the transport');
    back.click();
    await flush(20);
    expect($('.tr-undo-h')).toBeNull();
    expect(ctl.showingUndo).toBe(false);
    expect($('.tr-act')!.textContent).toBe('Compare again');
    expect($('.tr-apply')!.textContent).toBe('Apply to Demo TEST');
  });

  it('a dry run that names objects: one line of help and "Remove from transport" for each', async () => {
    const { $, $$, ctl } = await compared({ dryRun: 'Failed to write name on el_new' });
    await apply($);
    expect($$('.tr-dryrun-objects .tr-dryrun-a').map(x => x.textContent)).toEqual(['t.el_new']);
    $<HTMLButtonElement>('.tr-dryrun-rm')!.click();
    await flush(20);
    expect(ctl.addressInTransport('t.el_new')).toBe(false);
    expect($('.tr-stale')!.textContent).toBe('The transport changed since the comparison.');
  });

  it('a restored draft not read again: the confirmation says how old it is', async () => {
    const s = setup();
    const c = s.c;
    s.store.data[draftKey(ENV)] = toDraft(ENV, c.rows.map(r => ({ rid: r.rid, row: r, area: 'portal' as const, trail: [], readAt: '2026-11-14T09:00:00.000Z' })), '2026-11-14T09:00:00.000Z');
    await s.ctl.loadTargets();
    await s.ctl.restoreDraft();
    s.ctl.showTab('transport');
    s.$<HTMLButtonElement>('.tr-act')!.click();
    await flush(60);
    s.$<HTMLButtonElement>('.tr-apply')!.click();
    expect(s.$('.tr-confirm-draft')!.textContent).toBe('This transport is a draft from 14 Nov with 4 objects.');
    // Above the counts.
    expect(s.$('.tr-confirm-draft')!.nextElementSibling!.className).toBe('tr-confirm-counts');
    s.$<HTMLButtonElement>('.tr-confirm-cancel')!.click();
    // Not after a fresh find.
    const fresh = await compared();
    fresh.$<HTMLButtonElement>('.tr-apply')!.click();
    expect(fresh.$('.tr-confirm-draft')).toBeNull();
  });

  it('the lines under the summary: one form, danger then needs you then to know, four shown and "n more"', () => {
    const line = (level: string, text: string) => {
      const e = document.createElement('div');
      e.dataset.level = level;
      e.textContent = text;
      return e;
    };
    const state = { open: false };
    const box = needsBlock([line('know', 'k1'), line('needs', 'n1'), line('danger', 'd1'), line('know', 'k2'), line('needs', 'n2'), line('know', 'k3')], state);
    const shown = [...box.children].filter(e => (e as HTMLElement).dataset.level).map(e => e.textContent);
    expect(shown).toEqual(['d1', 'n1', 'n2', 'k1']);
    const more = box.querySelector<HTMLElement>('.tr-needs-more')!;
    expect(more.hidden).toBe(true);
    expect([...more.children].map(e => e.textContent)).toEqual(['k2', 'k3']);
    const toggle = box.querySelector<HTMLButtonElement>('.tr-needs-toggle')!;
    expect(toggle.textContent).toBe('2 more');
    toggle.click();
    expect(more.hidden).toBe(false);
    expect(toggle.textContent).toBe('Show fewer');
    expect(state.open).toBe(true);
    // Four or fewer: no toggle.
    expect(needsBlock([line('know', 'a'), line('needs', 'b')], { open: false }).querySelector('.tr-needs-toggle')).toBeNull();
  });

  it('the lines of a comparison keep their levels and order', async () => {
    const { $$ } = await compared({ types: 'TextElement;false&Category;true', unread: 'el_same' });
    const lines = $$('.tr-needs .tr-need');
    expect(lines.map(e => [e.dataset.need, e.dataset.level])).toEqual([['types-off', 'needs'], ['unread', 'needs']]);
    // Each: a dot, the sentence, at most one action.
    for (const e of lines) {
      const row = e.querySelector('.tr-need-row')!;
      expect(row.firstElementChild!.className).toBe('tr-need-dot');
      expect(row.querySelectorAll('.tr-need-t')).toHaveLength(1);
      expect(row.querySelectorAll('button, .tr-need-chev').length).toBeLessThanOrEqual(1);
    }
  });
});
