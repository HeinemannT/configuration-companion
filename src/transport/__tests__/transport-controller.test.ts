/**
 * The Transport window's state without a DOM, driven by a fake worker: Find
 * goes area by area in list order and stops on Stop; a missing area, a
 * failed area with its retry and the cap; filters leave the transport as it
 * is; the group box and Clear; numeric IDs are not added with their group; the objects are read 25 per request,
 * can be stopped, and a failed object read ends in the left-out list; a
 * refused answer stops the run. For a comparison by paste: the comparison
 * script, a pasted answer and its errors, the scripts rebuilt for their
 * options. The transport log is read on demand only. The collection itself,
 * the other ways to find, drafts, uses and the map: transport-collection.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { START_SPACE, TRANSPORT_DEFAULT_ROOTS, TRANSPORT_SCAN_CAP, TRANSPORT_SCAN_TOTAL } from '../../lib/transport-bundle';
import { transportEntryId } from '../../lib/transport-patch';
import { NONE_FOUND, parseIdList, PROBE_CHANGED, TransportController, UNDER } from '../transport-controller';
import { AREA_ORDER } from '../transport-model';
import {
  belowResult, creationResult, ENV, fakeWorker, flush, logResult, objectsResult, patchCase, probeAnswer, readOk, row, scanResult, underResult, type ProbeTarget, type Sent,
} from './fakes';

const SINCE = '2026-11-08';
/** A controller that builds scripts without comparison unless a test chooses a target. */
const make = (w: ReturnType<typeof fakeWorker>) => { const c = new TransportController(w.deps, { since: SINCE }); c.setMode('any'); return c; };
const scans = (w: ReturnType<typeof fakeWorker>) => w.sent.filter(m => m.type === 'TRANSPORT_SCAN');

describe('scan', () => {
  it('reads the chosen areas one at a time, in list order, with the window environment and day', async () => {
    const w = fakeWorker();
    const ctl = make(w);
    expect([...ctl.chosen].sort()).toEqual([...TRANSPORT_DEFAULT_ROOTS].sort());
    const done = ctl.scan();
    await flush();
    const order: string[] = [];
    for (let i = 0; i < TRANSPORT_DEFAULT_ROOTS.length; i++) {
      // Only one request is out at a time.
      expect(w.pending).toHaveLength(1);
      const p = w.pending.shift()!;
      order.push(p.msg.root as string);
      expect(p.msg).toMatchObject({ type: 'TRANSPORT_SCAN', environment: ENV, since: SINCE });
      expect(ctl.run?.index).toBe(i);
      p.resolve(scanResult(p.msg, { rows: [row()] }));
      await flush();
    }
    await done;
    expect(order).toEqual(AREA_ORDER.filter(r => TRANSPORT_DEFAULT_ROOTS.includes(r)));
    expect(new Set(scans(w).map(m => m.requestId)).size).toBe(order.length);
    expect(ctl.outcome).toEqual({ kind: 'done', areas: 10, of: 10 });
    expect(ctl.found()).toBe(10);
  });

  it('Stop cancels the running area and reads no further area', async () => {
    const w = fakeWorker();
    const ctl = make(w);
    const done = ctl.scan();
    await flush();
    const first = w.pending.shift()!;
    first.resolve(scanResult(first.msg, { rows: [row()] }));
    await flush();
    const second = w.pending[0];
    ctl.stopScan();
    await done;
    expect(w.posted).toEqual([{ type: 'TRANSPORT_CANCEL', requestId: second.msg.requestId }]);
    expect(scans(w)).toHaveLength(2);
    expect(ctl.scanning).toBe(false);
    expect(ctl.outcome).toEqual({ kind: 'stopped', areas: 1, of: 10 });
    expect(ctl.areas.map(a => a.status)).toEqual(['done', ...Array<string>(9).fill('stopped')]);
    // The rows of the first area stay.
    expect(ctl.found()).toBe(1);
  });

  it('a missing area, a failed area that can be tried again, and an area over the cap', async () => {
    const w = fakeWorker(msg => {
      if (msg.root === 'portal') return scanResult(msg, { missingRoot: true });
      if (msg.root === 'templateCategory') return scanResult(msg, { ok: false, rows: undefined, error: 'EC error: something broke', errorKind: 'server' });
      if (msg.root === 'property') return scanResult(msg, { rows: Array.from({ length: 3 }, () => row()), more: true });
      return scanResult(msg);
    });
    const ctl = make(w);
    await ctl.scan();
    const area = (r: string) => ctl.areas.find(a => a.root === r)!;
    expect(area('portal').status).toBe('missing');
    expect(area('templateCategory')).toMatchObject({ status: 'failed', error: 'EC error: something broke' });
    // A failure of one area does not stop the others.
    expect(scans(w)).toHaveLength(10);
    expect(ctl.error).toBeNull();
    expect(area('property')).toMatchObject({ status: 'done', more: true });
    expect(TRANSPORT_SCAN_CAP).toBe(2000);

    w.answer = msg => scanResult(msg, { rows: [row({ id: 'tpl_fixed' })] });
    await ctl.retry('templateCategory');
    expect(scans(w).at(-1)).toMatchObject({ root: 'templateCategory', since: SINCE });
    expect(area('templateCategory')).toMatchObject({ status: 'done' });
    expect(area('templateCategory').rows.map(r => r.id)).toEqual(['tpl_fixed']);
  });

  it('a refused or unanswered request stops the scan with one line', async () => {
    const w = fakeWorker(msg => scanResult(msg, { ok: false, rows: undefined, error: 'Not connected to BMP' }));
    const ctl = make(w);
    await ctl.scan();
    expect(scans(w)).toHaveLength(1);
    expect(ctl.error).toBe('Not connected to BMP');
    expect(ctl.outcome?.kind).toBe('failed');

    const t = fakeWorker(() => Promise.reject(Object.assign(new Error('Request timed out'), { kind: 'timeout' })));
    const c2 = make(t);
    await c2.scan();
    expect(c2.error).toBe('The server did not answer in time.');

    const none = fakeWorker(undefined, false);
    const c3 = make(none);
    await c3.scan();
    expect(none.sent).toHaveLength(0);
    expect(c3.error).toMatch(/Not connected/);
  });

  it('a refused answer stops the scan even with a server error kind', async () => {
    const w = fakeWorker(msg => scanResult(msg, { ok: false, rows: undefined, error: 'Not a root the changes scan reads: x', errorKind: 'server', refused: true }));
    const ctl = make(w);
    await ctl.scan();
    expect(scans(w)).toHaveLength(1);
    expect(ctl.error).toBe('Not a root the changes scan reads: x');
    expect(ctl.outcome?.kind).toBe('failed');
  });

  it('a damaged answer (protocol kind) fails that area only', async () => {
    const w = fakeWorker(msg => (msg.root === 'portal'
      ? scanResult(msg, { ok: false, rows: undefined, error: 'BMP returned a damaged row', errorKind: 'protocol' })
      : scanResult(msg)));
    const ctl = make(w);
    await ctl.scan();
    expect(scans(w)).toHaveLength(10);
    expect(ctl.areas[0]).toMatchObject({ status: 'failed', error: 'BMP returned a damaged row' });
    expect(ctl.error).toBeNull();
  });

  it('a cancelled answer marks the area as not scanned', async () => {
    const w = fakeWorker(msg => scanResult(msg, { ok: false, cancelled: true, rows: undefined }));
    const ctl = make(w);
    await ctl.scan();
    expect(ctl.areas.every(a => a.status === 'stopped')).toBe(true);
  });
});

describe('under an object', () => {
  const module = row({ id: 'my_module', name: 'My module', className: 'Category', createdIso: '2026-11-10T08:00:00' });
  const tab = row({ id: 'my_tab', className: 'Tab' });
  const list = row({ id: 'my_list', className: 'ExtendedTable', createdIso: '2026-11-12T08:00:00' });
  const auto = row({ id: '40213', className: 'TextElement' });

  async function underScanned(since = '') {
    const w = fakeWorker(msg => (msg.type === 'TRANSPORT_SCAN_UNDER' ? underResult(msg, module, [tab, list, auto]) : scanResult(msg)));
    const ctl = make(w);
    ctl.setScope('under');
    ctl.setStart('t.my_module');
    ctl.setUnderSince(since);
    await ctl.scan();
    return { w, ctl, area: ctl.areas[0] };
  }

  it('the date scan stays the default; one request with the object as typed and an empty day', async () => {
    const { w, ctl, area } = await underScanned();
    expect(make(fakeWorker()).scope).toBe('changed');
    expect(w.sent.map(m => m.type)).toEqual(['TRANSPORT_SCAN_UNDER']);
    expect(w.sent[0]).toMatchObject({ environment: ENV, start: 't.my_module', since: '' });
    expect(ctl.scannedStart).toBe('my_module');
    expect(ctl.scannedSince).toBe('');
    expect(ctl.startAddress).toBe('t.my_module');
    expect(ctl.outcome).toEqual({ kind: 'done', areas: 1, of: 1 });
    // One group: the starting object first, then the others by class and ID.
    expect(ctl.areas.map(a => a.root)).toEqual([UNDER]);
    expect(area.rows.map(r => r.id)).toEqual(['my_module', 'my_list', 'my_tab', '40213']);
    expect(ctl.groupLabel(area)).toBe('my_module · My module');
  });

  it('without a day no row is new; with one, rows created on or after it are', async () => {
    const { ctl } = await underScanned();
    expect(ctl.allRows().some(r => ctl.isNew(r))).toBe(false);
    const dated = await underScanned('2026-11-11');
    expect(dated.w.sent[0]).toMatchObject({ since: '2026-11-11' });
    expect(dated.ctl.allRows().filter(r => dated.ctl.isNew(r)).map(r => r.id)).toEqual(['my_list']);
    dated.ctl.setFilters({ newOnly: true });
    expect(dated.ctl.visibleRows(dated.area).map(r => r.id)).toEqual(['my_list']);
  });

  it('the filter, Changed by and the group tick work as for areas; numeric IDs stay unticked', async () => {
    const { ctl, area } = await underScanned();
    ctl.setFilters({ text: 'my_' });
    expect(ctl.visibleRows(area).map(r => r.id)).toEqual(['my_module', 'my_list', 'my_tab']);
    ctl.setFilters({ text: '' });
    ctl.setGroupTicked(UNDER, true);
    expect(ctl.transportItems().map(i => i.row).map(r => r.id)).toEqual(['my_module', 'my_list', 'my_tab']);
    expect(ctl.groupTick(area)).toBe('all');
  });

  it('a no-day scan turns New only off', async () => {
    const w = fakeWorker(msg => underResult(msg, module, [tab]));
    const ctl = make(w);
    ctl.setFilters({ newOnly: true });
    ctl.setScope('under');
    ctl.setStart('my_module');
    await ctl.scan();
    expect(ctl.filters.newOnly).toBe(false);
    expect(ctl.visibleRows(ctl.areas[0])).toHaveLength(2);
  });

  it('Scan needs an object and a day that is one or none; a start that is not an ID is said, nothing is sent', async () => {
    const w = fakeWorker(msg => underResult(msg, module));
    const ctl = make(w);
    ctl.setScope('under');
    expect(ctl.canScan()).toBe(false);
    ctl.setStart('o.my_org');
    expect(ctl.canScan()).toBe(true);
    await ctl.scan();
    expect(w.sent).toHaveLength(0);
    expect(ctl.error).toBe(START_SPACE);
    // Typing again takes the line away.
    ctl.setStart('my_module');
    expect(ctl.error).toBeNull();
    ctl.setUnderSince('2026-02-30');
    expect(ctl.canScan()).toBe(false);
    ctl.setUnderSince('');
    expect(ctl.canScan()).toBe(true);
    // The date scan's own inputs are kept.
    ctl.setScope('changed');
    expect(ctl.since).toBe(SINCE);
  });

  it('an object that is not there; a failed scan can be tried again', async () => {
    const w = fakeWorker(msg => underResult(msg, null));
    const ctl = make(w);
    ctl.setScope('under');
    ctl.setStart('gone');
    await ctl.scan();
    expect(ctl.areas[0].status).toBe('missing');
    expect(ctl.error).toBeNull();
    expect(ctl.groupLabel(ctl.areas[0])).toBe('t.gone');

    w.answer = msg => underResult(msg, null, [], { ok: false, rows: undefined, missingStart: undefined, error: 'Script failed', errorKind: 'server' });
    await ctl.scan();
    expect(ctl.areas[0]).toMatchObject({ status: 'failed', error: 'Script failed' });
    w.answer = msg => underResult(msg, module, [tab]);
    await ctl.retry(UNDER);
    expect(w.sent.at(-1)).toMatchObject({ type: 'TRANSPORT_SCAN_UNDER', start: 't.gone', since: '' });
    expect(ctl.areas[0].rows.map(r => r.id)).toEqual(['my_module', 'my_tab']);
  });

  it('Stop cancels the request', async () => {
    const w = fakeWorker();
    const ctl = make(w);
    ctl.setScope('under');
    ctl.setStart('my_module');
    const done = ctl.scan();
    await flush();
    const p = w.pending[0];
    ctl.stopScan();
    await done;
    expect(w.posted).toEqual([{ type: 'TRANSPORT_CANCEL', requestId: p.msg.requestId }]);
    expect(ctl.areas[0].status).toBe('stopped');
    expect(ctl.outcome?.kind).toBe('stopped');
  });

  it('scripts without comparison add every object the target lacks, whatever the day', async () => {
    const answer = (m: Sent) => (m.type === 'TRANSPORT_READ_OBJECTS'
      ? objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, [module, tab, list].find(r => r.rid === rid)!.id)))
      : underResult(m, module, [tab, list]));
    const all = make(fakeWorker(answer));
    all.setScope('under');
    all.setStart('my_module');
    await all.scan();
    all.setGroupTicked(UNDER, true);
    await all.buildBundle();
    expect(all.bundle!.inputs!.map(i => i.isNew)).toEqual([true, true, true]);
    expect(all.bundle!.result!.parts.map(p => p.step)).toContain('create');

    const dated = make(fakeWorker(answer));
    dated.setScope('under');
    dated.setStart('my_module');
    dated.setUnderSince('2026-11-11');
    await dated.scan();
    dated.setGroupTicked(UNDER, true);
    await dated.buildBundle();
    expect(dated.bundle!.inputs!.filter(i => i.isNew).map(i => i.id)).toEqual(['my_module', 'my_list', 'my_tab']);
  });
});

describe('objects only the target has', () => {
  const module = row({ id: 'my_module', className: 'Category' });
  const tab = row({ id: 'my_tab', parentRid: module.rid });
  const kept = row({ id: 'my_kept', parentRid: module.rid });
  const answer = (m: Sent) => (m.type === 'TRANSPORT_READ_OBJECTS'
    ? objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, [module, tab, kept].find(r => r.rid === rid)!.id)))
    : m.type === 'TRANSPORT_READ_CREATION' ? creationResult(m, new Map([module, tab, kept].map(r => [r.rid, r.id])))
      : m.type === 'TRANSPORT_SCAN_BELOW' ? belowResult(m, module, [tab, kept])
        : underResult(m, module, [tab, kept]));
  const target: ProbeTarget = {
    't.my_module': { cls: 'TextElement', genedit: "\nt.my_module.change(id := 'my_module', name := 'Name my_module') //TextElement\n" },
    't.page': { cls: 'Category' },
  };
  const listing = [
    { id: 'old_tab', parent: 'page', name: 'Name my_tab' },
    { id: 'extra', parent: 'my_module' },
  ];

  async function built(since = '') {
    const ctl = make(fakeWorker(answer));
    ctl.setScope('under');
    ctl.setStart('my_module');
    ctl.setUnderSince(since);
    await ctl.scan();
    await ctl.takeAll(module.rid);
    ctl.setMode('target');
    await ctl.buildBundle();
    return ctl;
  }

  it('an object read in full without a day, with everything under it in the transport: the comparison lists the target under it', async () => {
    const ctl = await built();
    const t = ctl.bundle!.target!;
    expect(t.probe.listing).toBe('t.my_module');
    expect(t.probe.parts.at(-1)!.step).toBe('listing');
    expect(t.listing).toEqual({ start: 't.my_module', ids: ['my_module', 'my_tab', 'my_kept'] });
    // One of them unticked: it is left out, the folder stays whole and is still listed.
    ctl.remove(kept.rid);
    expect(ctl.collection.get(module.rid)!.whole).toMatchObject({ leftOut: [kept.rid] });
    await ctl.buildBundle();
    expect(ctl.bundle!.rids).toEqual([module.rid, tab.rid]);
    expect(ctl.bundle!.target!.probe.listing).toBe('t.my_module');
  });

  it('the answer gives the objects only the target has, the ID change on by default; the switches rebuild the patch', async () => {
    const ctl = await built();
    const t = ctl.bundle!.target!;
    await ctl.readAnswer(probeAnswer(t.probe, target, { listing }));
    expect(t.answerError).toBeUndefined();
    expect(t.patch!.renames).toMatchObject([{ from: 't.old_tab', to: 't.my_tab', on: true }]);
    expect(t.patch!.targetOnly.map(o => o.id)).toEqual(['extra']);
    expect(t.patch!.deletes).toEqual([]);
    ctl.setDeleteExtra(true);
    expect(t.patch!.deletes.map(d => d.address)).toEqual(['t.extra']);
    ctl.setRename('old_tab>my_tab', false);
    expect(t.patch!.renames[0].on).toBe(false);
    expect(t.patch!.deletes.map(d => d.address)).toEqual(['t.old_tab', 't.extra']);
    expect(t.patch!.review.find(r => r.address === 't.my_tab')!.outcome).toBe('create');
  });

  async function builtWith() {
    const w = fakeWorker(answer);
    const ctl = make(w);
    ctl.setScope('under');
    ctl.setStart('my_module');
    await ctl.scan();
    await ctl.takeAll(module.rid);
    ctl.setMode('target');
    await ctl.buildBundle();
    return { w, ctl, t: ctl.bundle!.target! };
  }

  it('at every comparison what this workspace has under the start is read again: an object added here since the scan is not only on the target', async () => {
    const { w, ctl, t } = await builtWith();
    // The scan did not see `extra`; this workspace has it now.
    w.sourceIds = ['my_module', 'my_tab', 'my_kept', 'extra'];
    await ctl.readAnswer(probeAnswer(t.probe, target, { listing }));
    expect(w.sourceListingSent.map(m => m.start)).toEqual(['t.my_module']);
    expect(t.patch!.targetOnly).toEqual([]);
    ctl.setDeleteExtra(true);
    expect(t.patch!.deletes).toEqual([]);
    // Compare again: read again.
    w.sourceIds = ['my_module', 'my_tab', 'my_kept'];
    await ctl.readAnswer(probeAnswer(t.probe, target, { listing }));
    expect(w.sourceListingSent).toHaveLength(2);
    expect(t.patch!.targetOnly.map(o => o.id)).toEqual(['extra']);
  });

  it('an object of the transport that could not be read here: nothing is only on the target and nothing is deleted', async () => {
    const unread = (m: Sent) => (m.type === 'TRANSPORT_READ_OBJECTS'
      ? objectsResult(m, (m.rids as string[]).map(rid => (rid === kept.rid ? { rid, ok: false as const, error: 'Timed out' } : readOk(rid, [module, tab].find(r => r.rid === rid)!.id))))
      : answer(m));
    const ctl = make(fakeWorker(unread));
    ctl.setScope('under');
    ctl.setStart('my_module');
    await ctl.scan();
    await ctl.takeAll(module.rid);
    ctl.setMode('target');
    await ctl.buildBundle();
    const t = ctl.bundle!.target!;
    await ctl.readAnswer(probeAnswer(t.probe, target, { listing }));
    // The target is still listed under the start: only the read decides.
    expect(t.probe.listing).toBe('t.my_module');
    expect(t.unreadHere).toBe(1);
    expect(t.patch!.targetOnly).toEqual([]);
    ctl.setDeleteExtra(true);
    expect(t.patch!.deletes).toEqual([]);
    expect(t.patch!.parts.some(p => p.step === 'delete')).toBe(false);
  });

  it('when that read fails, nothing is only on the target and nothing is deleted; the reason is kept', async () => {
    const { w, ctl, t } = await builtWith();
    w.sourceListing = m => ({ type: 'TRANSPORT_SOURCE_LISTING_RESULT', requestId: m.requestId as string, environment: m.environment as string, start: m.start as string, ok: false, error: 'This workspace has more than 20,000 objects under t.my_module.' }) as never;
    await ctl.readAnswer(probeAnswer(t.probe, target, { listing }));
    expect(t.sourceError).toBe('This workspace has more than 20,000 objects under t.my_module.');
    expect(t.patch!.targetOnly).toEqual([]);
    ctl.setDeleteExtra(true);
    expect(t.patch!.deletes).toEqual([]);
    expect(t.patch!.parts.some(p => p.step === 'delete')).toBe(false);
  });
});

async function scanned(rows: Record<string, ReturnType<typeof row>[]>) {
  const w = fakeWorker(msg => scanResult(msg, { rows: rows[msg.root as string] ?? [] }));
  const ctl = make(w);
  await ctl.scan();
  return { w, ctl };
}

describe('list', () => {
  it('rows are sorted by class, then ID', async () => {
    const { ctl } = await scanned({ portal: [row({ className: 'Page', id: 'b' }), row({ className: 'Card', id: 'z' }), row({ className: 'Page', id: 'a' })] });
    expect(ctl.areas[0].rows.map(r => `${r.className}:${r.id}`)).toEqual(['Card:z', 'Page:a', 'Page:b']);
  });

  it('filters by text, user and new only; hidden rows stay in the transport', async () => {
    const a = row({ id: 'risk_page', name: 'Risk page', modifiedBy: 'Editor One', modifiedById: 'u1' });
    const b = row({ id: 'kpi_card', name: 'KPI', className: 'Card', modifiedBy: 'Editor Two', modifiedById: 'u2', createdIso: '2026-11-10T08:00:00' });
    const { ctl } = await scanned({ portal: [a, b] });
    const area = ctl.areas[0];
    ctl.setTicked(a.rid, true);
    ctl.setTicked(b.rid, true);

    ctl.setFilters({ text: 'RISK' });
    expect(ctl.visibleRows(area).map(r => r.id)).toEqual(['risk_page']);
    ctl.setFilters({ text: 'card' });
    expect(ctl.visibleRows(area).map(r => r.id)).toEqual(['kpi_card']);
    expect(ctl.collection.size).toBe(2);

    ctl.setFilters({ text: '', user: 'u1' });
    expect(ctl.visibleRows(area).map(r => r.id)).toEqual(['risk_page']);
    ctl.setFilters({ user: '', newOnly: true });
    expect(ctl.visibleRows(area).map(r => r.id)).toEqual(['kpi_card']);
    expect(ctl.isNew(b)).toBe(true);
    expect(ctl.isNew(a)).toBe(false);
    expect(ctl.collection.rids().sort()).toEqual([a.rid, b.rid].sort());
  });

  it('the group box adds the shown rows; Clear empties the transport and Undo brings it back', async () => {
    const rows = [row({ id: 'qq1' }), row({ id: 'qq2' }), row({ id: 'zz1' })];
    const { ctl } = await scanned({ portal: rows });
    const area = ctl.areas[0];
    expect(ctl.groupTick(area)).toBe('none');
    ctl.setFilters({ text: 'qq' });
    ctl.setGroupTicked('portal', true);
    expect(ctl.collection.size).toBe(2);
    expect(ctl.groupTick(area)).toBe('all');
    ctl.setFilters({ text: '' });
    expect(ctl.groupTick(area)).toBe('some');
    ctl.setGroupTicked('portal', true);
    expect(ctl.collection.size).toBe(3);
    ctl.setGroupTicked('portal', false);
    expect(ctl.collection.size).toBe(0);
    ctl.setGroupTicked('portal', true);
    ctl.clearTransport();
    expect(ctl.collection.size).toBe(0);
    expect(ctl.groupTick(area)).toBe('none');
    ctl.undoClear();
    expect(ctl.collection.size).toBe(3);
  });

  it('rows with a numeric ID are left out of the group tick but can be ticked by hand', async () => {
    const auto = row({ id: '40213' });
    const named = row({ id: 'el_named' });
    const { ctl } = await scanned({ portal: [auto, named] });
    ctl.setGroupTicked('portal', true);
    expect(ctl.collection.rids()).toEqual([named.rid]);
    expect(ctl.groupTick(ctl.areas[0])).toBe('all');
    ctl.setTicked(auto.rid, true);
    expect(ctl.inTransport(auto.rid)).toBe(true);
    ctl.setGroupTicked('portal', false);
    expect(ctl.collection.size).toBe(0);
  });

  it('a new search replaces the results; the transport stays and its rows show ticked', async () => {
    const r = row();
    const { ctl } = await scanned({ portal: [r] });
    ctl.setTicked(r.rid, true);
    await ctl.scan();
    expect(ctl.collection.rids()).toEqual([r.rid]);
    expect(ctl.inTransport(r.rid)).toBe(true);
    expect(ctl.groupTick(ctl.areas[0])).toBe('all');
  });
});

describe('bundle', () => {
  it('reads the ticked objects 25 per request, one request at a time, then assembles', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ id: `el_${String(i).padStart(2, '0')}`, createdIso: i < 5 ? '2026-11-09T10:00:00' : '2026-01-01T10:00:00' }));
    const { w, ctl } = await scanned({ portal: rows });
    ctl.setGroupTicked('portal', true);
    w.answer = undefined;
    const done = ctl.buildBundle();
    await flush();
    expect(ctl.tab).toBe('transport');
    const sizes: number[] = [];
    while (w.pending.length) {
      expect(w.pending).toHaveLength(1);
      const p = w.pending.shift()!;
      expect(p.msg).toMatchObject({ type: 'TRANSPORT_READ_OBJECTS', environment: ENV });
      const rids = p.msg.rids as string[];
      sizes.push(rids.length);
      for (const rid of rids) expect(typeof rid).toBe('string');
      p.resolve(objectsResult(p.msg, rids.map(rid => readOk(rid, ctl.row(rid)!.id))));
      await flush();
    }
    await done;
    expect(sizes).toEqual([25, 25, 10]);
    const b = ctl.bundle!;
    expect(b.status).toBe('done');
    expect(b.result!.objects).toHaveLength(60);
    // Without a comparison every object is added where the target lacks it.
    expect(b.result!.objects.filter(o => o.isNew)).toHaveLength(60);
    expect(b.result!.parts.map(p => p.step)).toContain('create');
  });

  it('no creation text for ordinary objects, with a comparison or without; places reach the inputs', async () => {
    const fresh = row({ id: 'el_fresh', createdIso: '2026-11-10T08:00:00' });
    const old = row({ id: 'el_old', linkedTo: 'tpl_x' });
    const { w, ctl } = await scanned({ portal: [fresh, old] });
    ctl.setGroupTicked('portal', true);
    w.answer = (m: Sent) => objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, ctl.row(rid)!.id, { parentId: 'PORTAL', parentIsRoot: true, systemObject: rid === old.rid })));
    await ctl.buildBundle();
    expect(w.sent.at(-1)!.type).toBe('TRANSPORT_READ_OBJECTS');
    expect(w.sent.at(-1)!.creation).toBeUndefined();
    expect(ctl.bundle!.inputs!.map(i => [i.id, i.parentId, i.parentIsRoot, i.systemObject])).toEqual([['el_fresh', 'PORTAL', true, false], ['el_old', 'PORTAL', true, true]]);
    ctl.backToList();
    ctl.setMode('target');
    await ctl.buildBundle();
    expect(w.sent.at(-1)!.type).toBe('TRANSPORT_READ_OBJECTS');
    expect(w.sent.at(-1)!.creation).toBeUndefined();
  });

  it('Stop cancels the batch being read; Continue reads the rest', async () => {
    const rows = Array.from({ length: 30 }, () => row());
    const { w, ctl } = await scanned({ portal: rows });
    ctl.setGroupTicked('portal', true);
    w.answer = undefined;
    const done = ctl.buildBundle();
    await flush();
    const first = w.pending.shift()!;
    first.resolve(objectsResult(first.msg, (first.msg.rids as string[]).map(rid => readOk(rid, ctl.row(rid)!.id))));
    await flush();
    const second = w.pending[0];
    ctl.stopReading();
    await done;
    expect(w.posted.at(-1)).toEqual({ type: 'TRANSPORT_CANCEL', requestId: second.msg.requestId });
    expect(ctl.bundle!.status).toBe('stopped');
    expect(ctl.bundle!.reads.size).toBe(25);
    w.pending.length = 0;

    w.answer = (m: Sent) => objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, ctl.row(rid)!.id)));
    await ctl.continueReading();
    expect((w.sent.at(-1)!.rids as string[])).toHaveLength(5);
    expect(ctl.bundle!.status).toBe('done');
  });

  it('a failed object read and a failed batch end in the left-out list', async () => {
    const rows = Array.from({ length: 27 }, (_, i) => row({ id: `el_${i}` }));
    const { w, ctl } = await scanned({ portal: rows });
    ctl.setGroupTicked('portal', true);
    let call = 0;
    w.answer = (m: Sent) => {
      call++;
      const rids = m.rids as string[];
      if (call === 2) return objectsResult(m, [], { ok: false, objects: undefined, error: 'The read failed on the server', errorKind: 'server' });
      return objectsResult(m, rids.map((rid, i) => (i === 0 ? { rid, ok: false, error: 'Missing value' } : readOk(rid, ctl.row(rid)!.id))));
    };
    await ctl.buildBundle();
    const res = ctl.bundle!.result!;
    expect(ctl.bundle!.status).toBe('done');
    expect(res.leftOut).toHaveLength(3);
    expect(res.leftOut.every(o => o.reason === 'unreadable')).toBe(true);
    expect(res.leftOut.map(o => o.detail).join('\n')).toMatch(/Missing value/);
    expect(res.leftOut.map(o => o.detail).join('\n')).toMatch(/The read failed on the server/);
    expect(res.objects).toHaveLength(24);
  });

  it('Back to changes keeps the ticks', async () => {
    const r = row();
    const { ctl } = await scanned({ portal: [r] });
    ctl.setTicked(r.rid, true);
    await ctl.buildBundle();
    ctl.backToList();
    expect(ctl.tab).toBe('find');
    expect(ctl.collection.rids()).toEqual([r.rid]);
  });

  it('a new object whose parent and siblings could not be read is left out: its Add needs its parent', async () => {
    const r = row({ id: 'el_lost', createdIso: '2026-11-10T08:00:00' });
    const { w, ctl } = await scanned({ portal: [r] });
    ctl.setTicked(r.rid, true);
    w.answer = (m: Sent) => objectsResult(m, [readOk(r.rid, 'el_lost', { parentAddress: '', neighboursError: 'Its parent and siblings could not be read.' })]);
    await ctl.buildBundle();
    const res = ctl.bundle!.result!;
    expect(ctl.bundle!.inputs![0].neighboursError).toBe('Its parent and siblings could not be read.');
    expect(res.leftOut).toMatchObject([{ id: 'el_lost', detail: 'Its parent could not be read, so it cannot be added.' }]);
  });

  it('dispose cancels a scan in progress', async () => {
    const w = fakeWorker();
    const ctl = make(w);
    const done = ctl.scan();
    await flush();
    const p = w.pending[0];
    ctl.dispose();
    await done;
    expect(w.posted).toEqual([{ type: 'TRANSPORT_CANCEL', requestId: p.msg.requestId }]);
    expect(scans(w)).toHaveLength(1);
  });
});

describe('refused reads', () => {
  it('a refused object read stops the read with one line', async () => {
    const r = row();
    const { w, ctl } = await scanned({ portal: [r] });
    ctl.setTicked(r.rid, true);
    w.answer = (m: Sent) => objectsResult(m, [], { ok: false, objects: undefined, error: 'Not an object RID: x', errorKind: 'server', refused: true });
    await ctl.buildBundle();
    expect(ctl.bundle!.status).toBe('failed');
    expect(ctl.error).toBe('Not an object RID: x');
  });
});

async function targetBuilt() {
  const c = patchCase();
  const w = fakeWorker(c.answer);
  const ctl = make(w);
  await ctl.scan();
  ctl.setGroupTicked('portal', true);
  ctl.setMode('target');
  await ctl.buildBundle();
  return { ...c, w, ctl, t: () => ctl.bundle!.target! };
}

describe('for one target', () => {
  it('builds for any workspace by default; for one target it builds the probe, not a bundle', async () => {
    const w = fakeWorker();
    expect(make(w).mode).toBe('any');
    const { ctl, t } = await targetBuilt();
    expect(ctl.bundle!.mode).toBe('target');
    expect(ctl.bundle!.result).toBeUndefined();
    expect(t().probe.entries.map(e => e.address)).toEqual(['t.el_change', 't.el_clash', 't.el_new', 't.el_same', 't.page']);
    expect(t().probe.parts.every(p => p.run === 'preview')).toBe(true);
    expect(t().patch).toBeUndefined();
  });

  it('a pasted answer, with text around it, gives the patch', async () => {
    const { ctl, t, target } = await targetBuilt();
    await ctl.readAnswer(`Some text before\n${probeAnswer(t().probe, target)}\nand after`);
    const p = t().patch!;
    expect(t().answerError).toBeUndefined();
    expect(p.counts).toEqual({ create: 1, change: 1, move: 0, same: 1, rename: 0, delete: 0, targetOnly: 0, leftOut: 1 });
    expect(p.leftOut[0]).toMatchObject({ reason: 'class-mismatch', address: 't.el_clash' });
    const change = p.review.find(r => r.outcome === 'change')!;
    // "Remove values only the target has" is off by default: kept.
    expect(change.values.map(v => [v.name, v.action])).toEqual([['id', 'same'], ['name', 'change'], ['description', 'keep']]);
  });

  it('the links of the property definitions: read after the answer, once; Stop and Continue', async () => {
    const c = patchCase();
    const type = row({ id: 'cc_type', className: 'ListMethodConfig' });
    const propRead = readOk(type.rid, 'cc_type', { className: 'ListMethodConfig', genedit: "k.cc_type.change(id := 'cc_type', name := 'Type') //ListMethodConfig", parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY', generate: undefined });
    const w = fakeWorker((m: Sent) => {
      if (m.type === 'TRANSPORT_READ_OBJECTS') {
        const rids = m.rids as string[];
        const res = c.answer!({ ...m, rids: rids.filter(r => r !== type.rid) }) as Sent;
        return { ...res, objects: [...(res.objects as unknown[]), ...(rids.includes(type.rid) ? [propRead] : [])] } as never;
      }
      if (m.type === 'TRANSPORT_SCAN') return scanResult(m, { rows: m.root === 'portal' ? [...c.rows, type] : [] });
      return c.answer!(m) as never;
    });
    const ctl = make(w);
    await ctl.scan();
    ctl.setGroupTicked('portal', true);
    ctl.setMode('target');
    await ctl.buildBundle();
    const t = () => ctl.bundle!.target!;
    const target = c.target;
    const fresh = type.rid;
    w.answer = undefined;
    const done = ctl.readAnswer(probeAnswer(t().probe, target));
    await flush();
    expect(w.pending.map(p => [p.msg.type, p.msg.rids])).toEqual([['TRANSPORT_READ_CREATION', [fresh]]]);
    expect(t().creation).toMatchObject({ status: 'reading', rids: [fresh] });
    expect(ctl.busy).toBe(true);
    expect(t().patch).toBeUndefined();
    ctl.stopCreation();
    await done;
    expect(w.posted.at(-1)).toEqual({ type: 'TRANSPORT_CANCEL', requestId: w.pending[0].msg.requestId });
    expect(t().creation!.status).toBe('stopped');
    expect(t().patch).toBeUndefined();
    w.pending.length = 0;
    w.answer = (m: Sent) => ({ type: 'TRANSPORT_CREATION_RESULT', requestId: m.requestId, environment: ENV, ok: true, texts: [{ rid: fresh, ok: false, error: 'Heap' }] }) as never;
    await ctl.continueCreation();
    expect(t().creation!.status).toBe('done');
    expect(t().patch!.leftOut.map(o => [o.address, o.detail])).toContainEqual(['k.cc_type', 'The text that adds it could not be read: Heap.']);
    // Every other object the target lacks is added from its values.
    expect(t().patch!.review.find(r => r.address === 't.el_new')!.outcome).toBe('create');
    // The same answer again: nothing more to read.
    const sent = w.sent.length;
    await ctl.readAnswer(probeAnswer(t().probe, target));
    expect(w.sent).toHaveLength(sent);
    expect(t().patch).toBeDefined();
  });

  it('an answer that cannot be read keeps the text and gives the parse error', async () => {
    const { ctl, t, target } = await targetBuilt();
    await ctl.readAnswer('nothing useful');
    expect(t().answerError).toMatchObject({ kind: 'not-found' });
    expect(t().answerText).toBe('nothing useful');
    expect(t().patch).toBeUndefined();
    await ctl.readAnswer(probeAnswer(t().probe, target, { key: 'deadbeef' }));
    expect(t().answerError?.kind).toBe('wrong-key');
    await ctl.readAnswer(probeAnswer(t().probe, target));
    expect(t().patch).toBeDefined();
    // A second answer that fails takes the patch away.
    await ctl.readAnswer(probeAnswer(t().probe, target, { cut: true }));
    expect(t().answerError?.kind).toBe('incomplete');
    expect(t().patch).toBeUndefined();
  });

  it('the clear-extra switch rebuilds the patch from the same answer', async () => {
    const { ctl, t, target } = await targetBuilt();
    await ctl.readAnswer(probeAnswer(t().probe, target));
    const kept = t().patch!;
    expect(t().clearExtra).toBe(false);
    expect(kept.review.find(r => r.outcome === 'change')!.values.find(v => v.name === 'description')!.action).toBe('keep');
    expect(kept.warnings.map(x => x.kind)).toContain('kept-values');
    expect(kept.text).not.toContain('.clear(description)');
    ctl.setClearExtra(true);
    const cleared = t().patch!;
    expect(cleared).not.toBe(kept);
    expect(cleared.text).toContain('.clear(description)');
  });

  it('the record option adds the Record part with an entry ID fixed when it is turned on', async () => {
    const { w, ctl, t, target } = await targetBuilt();
    await ctl.readAnswer(probeAnswer(t().probe, target));
    expect(t().patch!.parts.map(p => p.step)).not.toContain('record');
    ctl.setRecord(true);
    const id = transportEntryId(w.deps.now(), t().probe.key);
    expect(t().recordEntryId).toBe(id);
    ctl.setRecordTitle('Release 12');
    const rec = t().patch!.parts.find(p => p.step === 'record')!;
    expect(rec.run).toBe('committed');
    expect(rec.text).toContain(`id := '${id}'`);
    expect(rec.text).toContain("name := 'Release 12'");
    ctl.setRecord(false);
    expect(t().patch!.parts.map(p => p.step)).not.toContain('record');
  });
});

describe('transport log', () => {
  it('reads only when opened and on Refresh, and returns to the view it came from', async () => {
    const entry = { rid: '9007199254740995', id: 'cc_tr_1', name: 'Release 12', description: 'Created 1.', created: 'Nov 14, 2026 10:05:00', createdIso: '2026-11-14T10:05:00', createdBy: 'Editor One' };
    const w = fakeWorker(msg => (msg.type === 'TRANSPORT_LOG' ? logResult(msg, { entries: [entry], more: true }) : scanResult(msg)));
    const ctl = make(w);
    const logs = () => w.sent.filter(m => m.type === 'TRANSPORT_LOG');
    expect(logs()).toHaveLength(0);
    await ctl.openLog();
    expect(ctl.logOpen).toBe(true);
    expect(logs()).toEqual([expect.objectContaining({ type: 'TRANSPORT_LOG', environment: ENV })]);
    expect(ctl.log).toMatchObject({ status: 'done', read: true, more: true, missingLog: false, entries: [entry] });
    await ctl.readLog();
    expect(logs()).toHaveLength(2);
    ctl.closeLog();
    expect(ctl.tab).toBe('find');
  });

  it('a missing log, a failure and Stop', async () => {
    const w = fakeWorker(msg => logResult(msg, { missingLog: true }));
    const ctl = make(w);
    await ctl.openLog();
    expect(ctl.log).toMatchObject({ status: 'done', missingLog: true });

    w.answer = msg => logResult(msg, { ok: false, entries: undefined, error: 'Not connected to BMP', refused: true });
    await ctl.readLog();
    expect(ctl.log).toMatchObject({ status: 'failed', error: 'Not connected to BMP', missingLog: true });

    w.answer = undefined;
    const done = ctl.readLog();
    await flush();
    const p = w.pending[0];
    ctl.stopLog();
    await done;
    expect(w.posted.at(-1)).toEqual({ type: 'TRANSPORT_CANCEL', requestId: p.msg.requestId });
    expect(ctl.log!.status).toBe('stopped');
    expect(ctl.busy).toBe(false);
  });
});

describe('the list as a tree', () => {
  it('the subtree control ticks a node and what the filters show under it, without numeric IDs; it unticks them all', async () => {
    const folder = row({ id: 'folder' });
    const a = row({ id: 'a', parentRid: folder.rid });
    const n = row({ id: '77', parentRid: folder.rid });
    const other = row({ id: 'other' });
    const { ctl } = await scanned({ portal: [folder, a, n, other] });
    const area = ctl.areas[0];
    const tree = ctl.groupTree(area);
    expect(tree.byKey.get(a.rid)!.depth).toBe(1);
    // Built once per rows and per filters.
    expect(ctl.groupTree(area)).toBe(tree);
    expect(ctl.groupShow(area)).toBe(ctl.groupShow(area));
    // The control of a node takes what is under it; the node has its own tick box.
    ctl.setSubtreeTicked('portal', folder.rid, true);
    expect(ctl.collection.rids()).toEqual([a.rid]);
    const ticked = ctl.subtreeTicked(area);
    const fn = tree.byKey.get(folder.rid)!;
    expect(ticked[fn.end] - ticked[fn.index]).toBe(1);
    ctl.setTicked(n.rid, true);
    ctl.setSubtreeTicked('portal', folder.rid, false);
    expect(ctl.collection.size).toBe(0);
    // With a filter, only what it shows.
    ctl.setFilters({ text: 'a' });
    ctl.setSubtreeTicked('portal', folder.rid, true);
    expect(ctl.collection.rids()).toEqual([a.rid]);
  });

  it('nodes open and close, a text filter too; a large group starts with its nodes below the first level closed', async () => {
    const top = row({ id: 'top' });
    const mid = row({ id: 'mid', parentRid: top.rid });
    const leaf = row({ id: 'leaf', parentRid: mid.rid });
    const filler = Array.from({ length: 500 }, () => row());
    const { ctl } = await scanned({ portal: [top, mid, leaf], property: [top, mid, leaf, ...filler].map(r => ({ ...r })) });
    const small = ctl.areas.find(a => a.root === 'portal')!;
    const big = ctl.areas.find(a => a.root === 'property')!;
    const node = (a: typeof small, rid: string) => ctl.groupTree(a).byKey.get(rid)!;
    expect(ctl.nodeClosed('portal', node(small, mid.rid))).toBe(false);
    expect(ctl.nodeClosed('property', node(big, top.rid))).toBe(false);
    expect(ctl.nodeClosed('property', node(big, mid.rid))).toBe(true);
    const changes: string[] = [];
    ctl.onChange(c => changes.push(c.kind));
    ctl.toggleNode('portal', mid.rid);
    expect(ctl.nodeClosed('portal', node(small, mid.rid))).toBe(true);
    expect(changes).toEqual(['node']);
    // Closed stays closed under a text filter, and opens again.
    ctl.setFilters({ text: 'leaf' });
    expect(ctl.nodeClosed('portal', node(small, mid.rid))).toBe(true);
    ctl.toggleNode('portal', mid.rid);
    expect(ctl.nodeClosed('portal', node(small, mid.rid))).toBe(false);
  });
});

describe('reading the rest of a cut scan', () => {
  const C1 = '9007199254741001', C2 = '9007199254741002', C3 = '9007199254741003';

  async function cut() {
    const first = Array.from({ length: TRANSPORT_SCAN_CAP }, () => row());
    const w = fakeWorker(msg => scanResult(msg, msg.root === 'portal' ? { rows: first, more: true } : {}));
    const ctl = make(w);
    await ctl.scan();
    return { w, ctl, first, area: ctl.areas.find(a => a.root === 'portal')! };
  }

  it('reads the children of the root one by one, a cut child the same way, merges by RID; a failed child is named and read again alone', async () => {
    const { w, ctl, first, area } = await cut();
    expect(ctl.canReadRest(area)).toBe(true);
    const c1 = row({ rid: C1, id: 'c1' }), c3 = row({ rid: C3, id: 'c3', parentRid: C1 });
    const more = row({ id: 'under_c1' }), deeper = row({ id: 'under_c3' });
    let failC2 = true;
    w.answer = (m: Sent) => {
      if (m.type === 'TRANSPORT_CHILDREN') return { type: 'TRANSPORT_CHILDREN_RESULT', requestId: m.requestId, environment: ENV, ok: true, rids: m.root === 'portal' ? [C1, C2] : [C3] } as never;
      if (m.type === 'TRANSPORT_SCAN_BELOW') {
        const base = { type: 'TRANSPORT_SCAN_BELOW_RESULT', requestId: m.requestId, environment: ENV, rid: m.rid, since: m.since, ok: true };
        if (m.rid === C1) return { ...base, origin: c1, rows: [c1, first[0], more], more: true } as never;
        if (m.rid === C2) return (failC2 ? { ...base, ok: false, error: 'Script failed', errorKind: 'server' } : { ...base, rows: [row({ rid: C2, id: 'c2' })] }) as never;
        return { ...base, origin: c3, rows: [c3, deeper] } as never;
      }
      return undefined;
    };
    const seen: number[] = [];
    ctl.onChange(c => { if (c.kind === 'rest') seen.push(ctl.areas[0].rows.length); });
    await ctl.readRest('portal');
    const sent = w.sent.filter(m => m.type !== 'TRANSPORT_SCAN').map(m => [m.type, m.root ?? m.rid, m.since]);
    expect(sent).toEqual([
      ['TRANSPORT_CHILDREN', 'portal', undefined],
      ['TRANSPORT_SCAN_BELOW', C1, SINCE],
      ['TRANSPORT_SCAN_BELOW', C2, SINCE],
      ['TRANSPORT_CHILDREN', C1, undefined],
      ['TRANSPORT_SCAN_BELOW', C3, SINCE],
    ]);
    expect(area.rows).toHaveLength(TRANSPORT_SCAN_CAP + 4);
    expect(new Set(area.rows.map(r => r.rid)).size).toBe(area.rows.length);
    expect(seen.length).toBeGreaterThan(0);
    expect(area.rest).toMatchObject({ status: 'done', full: false });
    expect(area.rest!.failed).toEqual([{ kind: 'below', rid: C2 }]);
    expect(area.more).toBe(true);
    expect(ctl.scanning).toBe(false);
    // Try again reads only the failed child.
    failC2 = false;
    const before = w.sent.length;
    expect(ctl.canReadRest(area)).toBe(true);
    await ctl.readRest('portal');
    expect(w.sent.slice(before).map(m => [m.type, m.rid])).toEqual([['TRANSPORT_SCAN_BELOW', C2]]);
    expect(area.more).toBe(false);
    expect(area.rest!.failed).toEqual([]);
    expect(ctl.canReadRest(area)).toBe(false);
    expect(ctl.row(C2)?.id).toBe('c2');
  });

  it('Stop keeps what is left; Read the rest goes on from there; one request at a time', async () => {
    const { w, ctl, area } = await cut();
    w.answer = undefined;
    const done = ctl.readRest('portal');
    await flush();
    expect(ctl.scanning).toBe(true);
    expect(w.pending).toHaveLength(1);
    const p = w.pending.shift()!;
    p.resolve({ type: 'TRANSPORT_CHILDREN_RESULT', requestId: p.msg.requestId, environment: ENV, ok: true, rids: [C1, C2] } as never);
    await flush();
    expect(w.pending).toHaveLength(1);
    const below = w.pending[0];
    ctl.stopScan();
    await done;
    expect(w.posted.at(-1)).toEqual({ type: 'TRANSPORT_CANCEL', requestId: below.msg.requestId });
    expect(area.rest).toMatchObject({ status: 'stopped', todo: [{ kind: 'below', rid: C1 }, { kind: 'below', rid: C2 }] });
    w.answer = (m: Sent) => ({ type: 'TRANSPORT_SCAN_BELOW_RESULT', requestId: m.requestId, environment: ENV, rid: m.rid, since: m.since, ok: true, rows: [row({ rid: m.rid as string })] }) as never;
    await ctl.readRest('portal');
    expect(w.sent.filter(m => m.type === 'TRANSPORT_SCAN_BELOW').map(m => m.rid)).toEqual([C1, C1, C2]);
    expect(area.more).toBe(false);
  });

  it('stops at the total bound and offers nothing more', async () => {
    const { w, ctl, area } = await cut();
    w.answer = (m: Sent) => (m.type === 'TRANSPORT_CHILDREN'
      ? { type: 'TRANSPORT_CHILDREN_RESULT', requestId: m.requestId, environment: ENV, ok: true, rids: [C1, C2] }
      : { type: 'TRANSPORT_SCAN_BELOW_RESULT', requestId: m.requestId, environment: ENV, rid: m.rid, since: m.since, ok: true, rows: Array.from({ length: 19_000 }, () => row()) }) as never;
    await ctl.readRest('portal');
    expect(area.rows).toHaveLength(TRANSPORT_SCAN_TOTAL);
    expect(area.rest).toMatchObject({ full: true });
    expect(area.more).toBe(true);
    expect(ctl.canReadRest(area)).toBe(false);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_SCAN_BELOW')).toHaveLength(1);
  });

  it('under an object: the children of the starting object; a refused request stops with one line', async () => {
    const origin = row({ id: 'my_module' });
    const w = fakeWorker(msg => underResult(msg, origin, Array.from({ length: TRANSPORT_SCAN_CAP - 1 }, () => row()), { more: true }));
    const ctl = make(w);
    ctl.setScope('under');
    ctl.setStart('my_module');
    await ctl.scan();
    w.answer = (m: Sent) => ({ type: 'TRANSPORT_CHILDREN_RESULT', requestId: m.requestId, environment: ENV, ok: false, error: 'Not connected to BMP', refused: true }) as never;
    await ctl.readRest(UNDER);
    expect(w.sent.at(-1)).toMatchObject({ type: 'TRANSPORT_CHILDREN', rid: origin.rid });
    expect(ctl.error).toBe('Not connected to BMP');
    expect(ctl.areas[0].rest?.status).toBe('stopped');
  });
});

describe('referenced objects', () => {
  const findResult = (m: Sent, r?: ReturnType<typeof row>) => ({ type: 'TRANSPORT_FIND_RESULT', requestId: m.requestId, environment: ENV, address: m.address, ok: true, ...(r ? { row: r } : { missing: true }) }) as never;

  async function warned(mode: 'any' | 'target' = 'any') {
    const page = row({ id: 'my_page' });
    const kpi = row({ id: 'my_kpi', className: 'Kpi' });
    const w = fakeWorker(msg => scanResult(msg, { rows: msg.root === 'portal' ? [page] : [] }));
    const ctl = make(w);
    await ctl.scan();
    ctl.setTicked(page.rid, true);
    ctl.setMode(mode);
    w.answer = (m: Sent) => {
      if (m.type === 'TRANSPORT_READ_OBJECTS') {
        return objectsResult(m, (m.rids as string[]).map(rid => (rid === page.rid
          ? readOk(rid, 'my_page', { genedit: "t.my_page.change(id := 'my_page', kpi := k.my_kpi, other := t.gone_obj, org := o.some_org) //TextElement" })
          : readOk(rid, 'my_kpi', { className: 'Kpi', genedit: "k.my_kpi.change(id := 'my_kpi') //Kpi" }))));
      }
      if (m.type === 'TRANSPORT_FIND') return findResult(m, m.address === 'k.my_kpi' ? kpi : undefined);
      return undefined;
    };
    await ctl.buildBundle();
    return { w, ctl, page, kpi };
  }

  it('Copy IDs: the addresses of the transport, one per line; pasted into the ID list they find the same objects', async () => {
    const { ctl, page, kpi } = await warned();
    await ctl.addReferenced();
    const text = ctl.transportAddresses().join('\n');
    expect(text).toBe('t.my_page\nk.my_kpi');
    const w = fakeWorker(m => (m.type === 'TRANSPORT_FIND' ? findResult(m, m.address === 't.my_page' ? page : m.address === 'k.my_kpi' ? kpi : undefined) : undefined));
    const again = make(w);
    again.setScope('ids');
    again.setIdText(text);
    await again.scan();
    expect(w.sent.filter(m => m.type === 'TRANSPORT_FIND').map(m => m.address)).toEqual(['t.my_page', 'k.my_kpi']);
    expect(again.allRows().map(r => r.rid).sort()).toEqual(ctl.transportItems().map(i => i.rid).sort());
    // Before anything is read: by the object's kind; an odd ID in its get form.
    const fresh = make(fakeWorker(m => scanResult(m, { rows: m.root === 'portal' ? [row({ id: 'odd id' }), row({ id: 'cc_def', className: 'TextMethodConfig' })] : [] })));
    await fresh.scan();
    fresh.setGroupTicked('portal', true);
    expect([...fresh.transportAddresses()].sort()).toEqual(['k.cc_def', 't.get("odd id")']);
    expect(parseIdList(fresh.transportAddresses().join('\n')).addresses).toEqual(fresh.transportAddresses());
  });

  it('"Add them" looks each supported address up, adds the found ones to the transport and builds again; not found stays needed', async () => {
    const { w, ctl, kpi } = await warned();
    // Used objects and the parent of the objects to add are said apart.
    expect(ctl.referencedAddresses()).toEqual(['k.my_kpi', 't.gone_obj']);
    expect([...ctl.neededAddresses().values()]).toEqual(['k.my_kpi', 'o.some_org', 't.gone_obj']);
    expect(ctl.neededParents()).toEqual({ parents: new Map([['t.page', 't.page']]), objects: 1 });
    expect(ctl.referencedAddresses('parents')).toEqual(['t.page']);
    // The map's right column counts the same objects as the line.
    expect(ctl.mapModel().right.reduce((n, r) => n + r.keys.length, 0)).toBe(3);
    await ctl.addReferenced();
    expect(w.sent.filter(m => m.type === 'TRANSPORT_FIND').map(m => m.address)).toEqual(['k.my_kpi', 't.gone_obj']);
    // The results of Find stay as they were.
    expect(ctl.areas.some(a => a.rows.some(r => r.rid === kpi.rid))).toBe(false);
    expect(ctl.inTransport(kpi.rid)).toBe(true);
    expect(ctl.collection.get(kpi.rid)!.trail).toEqual([]);
    const b = ctl.bundle!;
    expect(b.status).toBe('done');
    expect(b.rids).toContain(kpi.rid);
    // Only the new object was read.
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_OBJECTS').at(-1)!.rids).toEqual([kpi.rid]);
    expect(b.result!.warnings.filter(x => x.kind === 'outside-reference').map(x => x.address)).toEqual(['o.some_org', 't.gone_obj']);
    expect(ctl.neededParents().objects).toBe(2);
    // An address looked up in vain is not offered again, and is said so.
    expect(ctl.referencedAddresses()).toEqual([]);
    expect(ctl.useState('t.gone_obj')).toBe('not-found');
    expect(ctl.usesOf(ctl.collection.rids()[0])!.map(u => [u.address, u.state])).toEqual([['k.my_kpi', 'transport'], ['o.some_org', 'unknown'], ['t.gone_obj', 'not-found']]);
  });

  it('one already in the transport stays as it is; a numeric ID is added; nothing found says so', async () => {
    const { w, ctl, page } = await warned();
    const numeric = row({ id: '4711' });
    w.answer = (m: Sent) => (m.type === 'TRANSPORT_FIND' ? findResult(m, { ...page }) : objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, 'x'))));
    ctl.setMode('any');
    await ctl.addReferenced();
    expect(ctl.collection.rids()).toEqual([page.rid]);
    expect(ctl.notice).toBe('They are in the transport already.');
    const again = await warned();
    again.w.answer = (m: Sent) => (m.type === 'TRANSPORT_FIND' ? findResult(m, m.address === 'k.my_kpi' ? numeric : undefined) : objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, 'x'))));
    await again.ctl.addReferenced();
    expect(again.ctl.inTransport(numeric.rid)).toBe(true);
    const none = await warned();
    none.w.answer = (m: Sent) => findResult(m);
    await none.ctl.addReferenced();
    expect(none.ctl.notice).toBe(NONE_FOUND);
    expect(none.ctl.collection.size).toBe(1);
  });

  it('for one target the probe is built again, and a pasted answer is dropped with one line', async () => {
    const { ctl } = await warned('target');
    expect(ctl.referencedAddresses()).toEqual([]);
    // After an answer: the used objects the target lacks.
    const t = ctl.bundle!.target!;
    t.answerText = 'pasted';
    t.answer = { key: t.probe.key, states: { 'k.my_kpi': { state: 'missing' }, 't.gone_obj': { state: 'present', className: 'Kpi' } } };
    // Not known here (no facts read): it cannot be checked, so it is not counted as missing.
    expect(ctl.referencedAddresses()).toEqual([]);
    expect(ctl.uncheckedUses()).toEqual(['k.my_kpi']);
    // Known here: missing on the target.
    (ctl as unknown as { facts: Map<string, unknown> }).facts.set('k.my_kpi', { address: 'k.my_kpi', name: 'KPI', className: 'Kpi', parentId: '' });
    t.answer = { ...t.answer };
    expect(ctl.referencedAddresses()).toEqual(['k.my_kpi']);
    expect(ctl.uncheckedUses()).toEqual([]);
    await ctl.addReferenced();
    expect(ctl.notice).toBe(PROBE_CHANGED);
    expect(ctl.bundle!.target!.answerText).toBe('');
    expect(ctl.bundle!.target!.probe.entries.map(e => e.address)).toContain('k.my_kpi');
  });

  it('Stop while looking up adds what was found so far', async () => {
    const { w, ctl, kpi } = await warned();
    const answer = w.answer!;
    w.answer = undefined;
    const done = ctl.addReferenced();
    await flush();
    expect(ctl.lookingUp).toBe(true);
    expect(ctl.busy).toBe(true);
    const p = w.pending.shift()!;
    p.resolve(findResult(p.msg, kpi));
    await flush();
    ctl.stopRefs();
    w.answer = answer;
    await done;
    expect(w.posted.at(-1)?.type).toBe('TRANSPORT_CANCEL');
    expect(ctl.refs).toBeNull();
    expect(ctl.inTransport(kpi.rid)).toBe(true);
  });
});
