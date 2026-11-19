import { describe, expect, it } from 'vitest';
import { numericRecordKey } from '../../lib/numeric-id-write';
import { scanFromRows } from '../numeric-ids-controller';
import { ENV, flush, row, setup, type Setup } from './numeric-fakes';

const kinds = (s: Setup) => s.sent.map(m => m.type as string);
const three = () => [
  row('11', '5612', 'Cleanup', { parentRid: 'F1' }),
  row('12', '5613', 'Other', { parentRid: 'F1' }),
  row('13', '316', 'My KPIs', { parentRid: 'F1', className: 'Tab' }),
];

describe('reading', () => {
  it('reads nothing until the tab is opened, then each area once, then who created the objects and the code copy', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory', 'portal'], origins: [['13', 'System']] });
    await flush();
    expect(s.sent).toEqual([]);
    s.c.open();
    s.c.open();
    await flush();
    expect(kinds(s)).toEqual(['NUMERIC_IDS_SCAN', 'NUMERIC_IDS_SCAN', 'NUMERIC_IDS_ORIGINS']);
    expect(s.sent.filter(m => m.type === 'NUMERIC_IDS_SCAN').map(m => m.root)).toEqual(['portal', 'templateCategory']);
    expect((s.sent[2].rids as string[])).toEqual(['11', '12', '13']);
    expect(s.c.reading).toBeNull();
    expect(s.c.count).toBe(2);
    expect(s.c.readAt).toBe(new Date(2026, 10, 19, 12, 0, 0).getTime());
  });

  it('ticks the user\'s own objects and leaves BMP\'s own, listed last, unticked', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'], origins: [['13', 'System']] });
    s.c.open();
    await flush();
    expect([...s.c.ticked].sort()).toEqual(['11', '12']);
    expect(s.c.ownEntries.map(e => e.row.id).sort()).toEqual(['5612', '5613']);
    expect(s.c.bmpEntries.map(e => e.row.id)).toEqual(['316']);
    expect(s.c.ready.map(e => e.row.rid).sort()).toEqual(['11', '12']);
    expect(s.c.listed).toBe(2);
    expect(s.c.proposalOf('11')!.id).toBe('cleanup');
  });

  it('keeps the creator group for another signed-in user', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'], origins: [['13', 'System']], user: 'tassilo' });
    s.c.open();
    await flush();
    expect(s.c.byCreator).toBe(true);
    expect([...s.c.ticked].sort()).toEqual(['11', '12']);
    expect(s.c.bmpEntries.map(e => e.row.id)).toEqual(['316']);
  });

  it('lets the creator say nothing for the built-in account: every row listed, nothing ticked', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'], origins: [['11', 'System'], ['12', 'System'], ['13', 'System']], user: 'Admin' });
    s.c.open();
    await flush();
    expect(s.c.byCreator).toBe(false);
    expect(s.c.bmpEntries).toEqual([]);
    expect(s.c.ownEntries.map(e => e.row.id).sort()).toEqual(['316', '5612', '5613']);
    expect(s.c.count).toBe(3);
    expect(s.c.ticked.size).toBe(0);
  });

  it('still puts a system object in the group for the built-in account', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'], user: 'admin' });
    s.origins.set('13', { rid: '13', systemObject: true, createdBy: 'System' });
    s.c.open();
    await flush();
    expect(s.c.bmpEntries.map(e => e.row.id)).toEqual(['316']);
    expect(s.c.ownEntries).toHaveLength(2);
    expect(s.c.ticked.size).toBe(0);
    expect(s.c.whyBmp(s.c.bmpEntries[0])).toMatch(/system object/);
  });

  it('does not list properties, linked copies or IDs with letters', async () => {
    const s = setup({ rows: [row('1', '5', 'a', { className: 'NumberMethodConfig' }), row('2', '6', 'b', { linkedTo: 'tmpl' }), row('3', '7', 'c'), row('4', 'abc', 'd')], areas: ['templateCategory'] });
    s.c.open();
    await flush();
    expect(s.c.ownEntries.map(e => e.row.rid)).toEqual(['3']);
  });

  it('starts BMP\'s own group closed and counts only the user\'s own on the tab', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'], origins: [['13', 'System']] });
    s.c.open();
    await flush();
    expect(s.c.bmpOpen).toBe(false);
    expect(s.c.count).toBe(2);
  });

  it('refresh reads the chosen areas again and nothing else', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'] });
    s.c.open();
    await flush();
    s.sent.length = 0;
    s.c.refresh();
    await flush();
    expect(kinds(s)).toEqual(['NUMERIC_IDS_SCAN']);
  });

  it('reads an area chosen later, and only that one; leaving one out reads nothing', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'] });
    s.c.open();
    await flush();
    s.sent.length = 0;
    s.c.setArea('portal', true);
    await flush();
    expect(s.sent.filter(m => m.type === 'NUMERIC_IDS_SCAN').map(m => m.root)).toEqual(['portal']);
    s.sent.length = 0;
    s.c.setArea('portal', false);
    await flush();
    expect(s.sent).toEqual([]);
    expect(s.c.areaModels.map(m => m.root)).toEqual(['templateCategory']);
  });

  it('takes an area Find holds in full instead of reading it again', async () => {
    const all = [...three(), row('20', 'folder_one', 'Folder one', { className: 'Category', parentRid: 'ROOT', parentId: 'TEMPLATECATEGORY' })];
    const s = setup({ rows: three(), areas: ['templateCategory'], find: { templateCategory: all } });
    s.c.open();
    await flush();
    expect(kinds(s)).toEqual(['NUMERIC_IDS_ORIGINS']);
    expect(s.c.count).toBe(3);
    const scan = scanFromRows('portal', all, 1);
    expect(scan.rows.map(r => r.id)).toEqual(['5612', '5613', '316']);
    expect(scan.context.map(r => r.id)).toEqual(['folder_one']);
  });

  it('keeps going without a code copy and says why, once; counts appear only with a copy', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'], copy: { ready: false, reason: 'no code copy on this computer', canMake: true }, code: [['77', 'expression', 'x := t.5612']] });
    s.c.open();
    await flush();
    expect(s.c.code).toEqual({ ready: false, reason: 'no code copy on this computer', canMake: true });
    expect(s.c.codeCount(s.c.ownEntries[0])).toBeUndefined();
    const t = setup({ rows: three(), areas: ['templateCategory'], code: [['77', 'expression', 'x := t.5612 + t.5612'], ['78', 'expression', 'y := t.get("5612")']] });
    t.c.open();
    await flush();
    const e = t.c.ownEntries.find(x => x.row.id === '5612')!;
    expect(t.c.codeCount(e)).toBe(2);
    expect(t.c.codeCount(t.c.ownEntries.find(x => x.row.id === '5613')!)).toBe(0);
  });

  it('stops on a failed read with the reason and keeps what was read', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory', 'portal'] });
    s.fail.scanRoot = 'templateCategory';
    s.c.open();
    await flush();
    expect(s.c.error).toMatch(/did not answer/);
    expect(s.c.areaModels.map(m => m.root)).toEqual(['portal']);
  });

  it('lists rows unticked when it could not tell who created them', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'] });
    s.fail.originsFail = true;
    s.c.open();
    await flush();
    expect(s.c.error).toMatch(/BMP's own/);
    expect(s.c.ticked.size).toBe(0);
    expect(s.c.ownEntries).toHaveLength(3);
  });
});

describe('filters, ticks and typed IDs', () => {
  async function opened() {
    const s = setup({ rows: three(), areas: ['templateCategory'], origins: [['13', 'System']] });
    s.c.open();
    await flush();
    return s;
  }

  it('narrows by name or ID and ticks a folder\'s shown rows only', async () => {
    const s = await opened();
    const m = s.c.areaModels[0];
    s.c.setText('cleanup');
    expect(s.c.entriesIn(m, false).map(e => e.row.id)).toEqual(['5612']);
    const node = m.tree.byKey.get('F1')!;
    s.c.setTicked(s.c.entriesIn(m, false, node).map(e => e.row.rid), false);
    expect([...s.c.ticked]).toEqual(['12']);
    expect(s.c.tickState(s.c.entriesIn(m, false, node))).toBe('none');
    s.c.setText('');
    expect(s.c.tickState(s.c.entriesIn(m, false, node))).toBe('some');
    expect(s.c.shown.map(e => e.row.id).sort()).toEqual(['5612', '5613']);
  });

  it('validates a typed ID quietly: the row leaves the count, with a reason', async () => {
    const s = await opened();
    s.c.setValue('11', 'bad id');
    expect(s.c.stateOf('11')).toMatchObject({ value: 'bad id', problem: expect.stringMatching(/Letters/) });
    expect(s.c.ready.map(e => e.row.rid)).toEqual(['12']);
    s.c.setValue('11', 'btn_mine');
    expect(s.c.stateOf('11')!.problem).toBeNull();
    s.c.setValue('12', 'btn_mine');
    expect(s.c.stateOf('11')!.problem).toMatch(/another row/);
    expect(s.c.ready).toHaveLength(0);
    s.c.resetValue('12');
    expect(s.c.stateOf('12')!.value).toBe(s.c.proposalOf('12')!.id);
    expect(s.c.ready.map(e => e.row.rid).sort()).toEqual(['11', '12']);
  });

  it('shows BMP\'s own rows only when their group is open', async () => {
    const s = await opened();
    expect(s.c.shown.map(e => e.row.id)).not.toContain('316');
    s.c.toggleBmp();
    expect(s.c.shown.map(e => e.row.id)).toContain('316');
  });
});

describe('the change', () => {
  const codeOf = () => [['77', 'expression', 'a := t.5612.value + t.5613'], ['78', 'initExpression', 'b := t.get("5612")'], ['79', 'expression', 'c := "t.5612" // t.5612']] as Array<[string, string, string]>;

  async function ready(extra: Parameters<typeof setup>[0] = {}) {
    const s = setup({ rows: three(), areas: ['templateCategory'], origins: [['13', 'System']], code: codeOf(), ...extra });
    s.c.open();
    await flush();
    return s;
  }

  it('checks the new IDs, counts the objects with code and asks once', async () => {
    const s = await ready();
    await s.c.requestChange();
    expect(s.c.confirm).toMatchObject({ phase: 'ready', codeObjects: 2, leftOut: 0 });
    expect(s.c.confirm!.items.map(i => `${i.from}>${i.to}`)).toEqual(['5612>cleanup', '5613>other']);
    // Nothing was written to look at the IDs or the code.
    expect(kinds(s).filter(t => t === 'NUMERIC_IDS_RUN')).toEqual([]);
    expect(s.writes).toEqual([]);
  });

  it('leaves a row out when its new ID turns out to be used, naming the reason', async () => {
    const s = await ready();
    s.fail.factsTaken = new Set(['t.cleanup']);
    await s.c.requestChange();
    expect(s.c.confirm!.items.map(i => i.from)).toEqual(['5613']);
    expect(s.c.stateOf('11')!.problem).toMatch(/Already used/);
    s.c.cancelConfirm();
    expect(s.c.confirm).toBeNull();
  });

  it('changes the IDs first, then the code that names them, then the rows leave the list', async () => {
    const s = await ready();
    await s.c.requestChange();
    const before = s.sent.length;
    await s.c.confirmChange();
    const run = s.sent.slice(before).filter(m => m.type === 'NUMERIC_IDS_RUN');
    expect(run.map(m => m.transactional)).toEqual([false, true]);
    expect(run[1].confirmed).toBe(true);
    expect(s.ids.get('11')).toBe('cleanup');
    expect(s.ids.get('12')).toBe('other');
    expect(s.texts.get('77|expression')).toBe('a := t.cleanup.value + t.other');
    expect(s.texts.get('78|initExpression')).toBe('b := t.get("cleanup")');
    expect(s.texts.get('79|expression')).toBe('c := "t.5612" // t.5612');
    // The IDs are in place before the first script is written.
    expect(s.writes.sort()).toEqual(['77|expression', '78|initExpression']);
    expect(s.c.result).toBe('Changed 2 IDs and code in 2 objects.');
    expect(s.c.ownEntries).toEqual([]);
    expect(s.c.bmpEntries.map(e => e.row.id)).toEqual(['316']);
    expect(s.c.confirm).toBeNull();
    const rec = s.store.get(numericRecordKey(ENV)) as { phase: string; ids: unknown[]; code: unknown[] };
    expect(rec.phase).toBe('done');
    expect(rec.ids).toHaveLength(2);
    expect(rec.code).toHaveLength(2);
    expect(s.c.record).not.toBeNull();
  });

  it('does not run anything the user did not confirm', async () => {
    const s = await ready();
    await s.c.confirmChange();
    expect(kinds(s)).not.toContain('NUMERIC_IDS_RUN');
    await s.c.requestChange();
    s.c.cancelConfirm();
    await s.c.confirmChange();
    expect(kinds(s)).not.toContain('NUMERIC_IDS_RUN');
  });

  it('without a code copy changes the IDs alone and says nothing about code', async () => {
    const s = await ready({ copy: { ready: false, reason: 'a copy cannot be made of this server', canMake: false } });
    await s.c.requestChange();
    expect(s.c.confirm!.codeObjects).toBeNull();
    await s.c.confirmChange();
    expect(s.c.result).toBe('Changed 2 IDs.');
    expect(s.writes).toEqual([]);
    expect(s.texts.get('77|expression')).toBe(codeOf()[0][2]);
  });

  it('a failure in the middle leaves the IDs of the earlier batches changed, recorded, and the code only for those', async () => {
    const many = Array.from({ length: 45 }, (_, i) => row(String(100 + i), String(7000 + i), `Item ${i}`, { className: 'Container' }));
    const s = setup({ rows: many, areas: ['templateCategory'], code: [['77', 'expression', 't.7000 + t.7044']] });
    s.fail.previewFail = 2;
    s.c.open();
    await flush();
    await s.c.requestChange();
    expect(s.c.confirm!.items).toHaveLength(45);
    await s.c.confirmChange();
    expect(s.ids.get('100')).toMatch(/^item_/);
    expect(s.ids.get('144')).toBe('7044');
    // The script names one ID that changed and one that did not: only the first is replaced.
    expect(s.texts.get('77|expression')).toMatch(/^t\.item_0 \+ t\.7044$/);
    expect(s.c.result).toContain('Changed 20 IDs');
    expect(s.c.result).toContain('25 not changed');
    expect(s.c.notes.get('144')).toBe('Not started: an earlier step failed');
    expect(s.c.notes.get('120')).toMatch(/too large/);
    expect(s.c.ownEntries).toHaveLength(25);
    const rec = s.store.get(numericRecordKey(ENV)) as { ids: unknown[] };
    expect(rec.ids).toHaveLength(20);
  });

  it('a script the server refuses stays as it was and the line says it still names an old ID', async () => {
    const s = await ready();
    s.fail.syntaxFail = new Set(['b := t.get("cleanup")']);
    await s.c.requestChange();
    await s.c.confirmChange();
    expect(s.texts.get('78|initExpression')).toBe('b := t.get("5612")');
    expect(s.c.result).toBe('Changed 2 IDs and code in 1 object. 1 script still names an old ID.');
    expect(s.c.error).toMatch(/Syntax error/);
    const rec = s.store.get(numericRecordKey(ENV)) as { code: unknown[] };
    expect(rec.code).toHaveLength(1);
  });

  it('changes back the IDs and the code of the last change, and forgets it', async () => {
    const s = await ready();
    await s.c.requestChange();
    await s.c.confirmChange();
    await s.c.undo();
    expect(s.ids.get('11')).toBe('5612');
    expect(s.ids.get('12')).toBe('5613');
    expect(s.texts.get('77|expression')).toBe(codeOf()[0][2]);
    expect(s.texts.get('78|initExpression')).toBe(codeOf()[1][2]);
    expect(s.c.record).toBeNull();
    expect(s.store.has(numericRecordKey(ENV))).toBe(false);
    expect(s.c.result).toBe('Changed back 2 IDs and 2 scripts. Refresh to list them again.');
    s.c.refresh();
    await flush();
    expect(s.c.ownEntries).toHaveLength(2);
  });

  it('finds the record of an earlier session when the tab opens', async () => {
    const s = setup({ rows: three(), areas: ['templateCategory'] });
    s.store.set(numericRecordKey(ENV), { v: 1, environment: ENV, at: '2026-11-19T10:00:00.000Z', phase: 'ids', ids: [{ rid: '11', space: 't', className: 'ActionButton', name: 'x', from: '5612', to: 'btn_cleanup' }], code: [] });
    s.c.open();
    await flush();
    expect(s.c.record).toMatchObject({ phase: 'ids' });
  });
});
