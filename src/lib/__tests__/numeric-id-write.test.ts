import { describe, expect, it } from 'vitest';
import { framedText } from '../ec-parser';
import { applyReplace, type ReplacePort, type ScriptLabel } from '../code-replace';
import {
  applyIdChanges, buildIdChangeEc, buildNumericRecord, changeBack, checkIdChange, codeObjectCounts, ID_BATCH, idEdit, inBatches, numericRecordKey, parseIdChangeLog,
  planCodeEdits, readNumericRecord, type CodeHolder, type IdChange, type IdRead, type IdRunAnswer, type IdWritePort, type RunStatus,
} from '../numeric-id-write';
import { findCodeRefs } from '../code-refs';

const change = (n: number, o: Partial<IdChange> = {}): IdChange => ({ rid: `9000000000000000${String(n).padStart(3, '0')}`, space: 't', className: 'ActionButton', name: `Button ${n}`, from: String(5000 + n), to: `btn_${n}`, ...o });
const many = (count: number): IdChange[] => Array.from({ length: count }, (_, i) => change(i + 1));

/** A server that holds IDs by RID; `refuse` makes the preview or the commit say something else. */
function fakeServer(items: readonly IdChange[], opts: { taken?: Set<string>; gone?: Set<string>; previewFails?: number; commitFails?: number; commitThrows?: number; readFails?: boolean; dropWrites?: Set<string> } = {}) {
  const ids = new Map(items.map(i => [i.rid, i.from]));
  const calls: Array<{ kind: 'preview' | 'commit' | 'read'; count: number }> = [];
  let previews = 0;
  let commits = 0;
  const port: IdWritePort = {
    async run(batch, transactional): Promise<IdRunAnswer> {
      calls.push({ kind: transactional ? 'commit' : 'preview', count: batch.length });
      if (!transactional && opts.previewFails != null && ++previews === opts.previewFails) return { ok: false, error: 'Script too large' };
      if (transactional) {
        commits++;
        if (opts.commitThrows === commits) throw new Error('lost connection');
        if (opts.commitFails === commits) return { ok: false, error: 'Server error' };
      }
      const rows: string[][] = [];
      for (const c of batch) {
        let status: RunStatus = 'ok';
        if (opts.gone?.has(c.rid) || !ids.has(c.rid)) status = 'gone';
        else if (ids.get(c.rid) !== c.from) status = 'moved';
        else if (opts.taken?.has(c.to)) status = 'taken';
        rows.push(['R', c.rid, status]);
        if (transactional && status === 'ok' && !opts.dropWrites?.has(c.rid)) ids.set(c.rid, c.to);
      }
      return { ok: true, log: framedText(rows) };
    },
    async read(rids): Promise<Map<string, IdRead>> {
      calls.push({ kind: 'read', count: rids.length });
      if (opts.readFails) throw new Error('no answer');
      return new Map(rids.map(r => [r, ids.has(r) ? { id: ids.get(r)! } : { missing: true }]));
    },
  };
  return { port, ids, calls };
}

describe('the script of a batch', () => {
  it('addresses each object by its old ID and checks its RID, the new ID and the result', () => {
    const [c] = many(1);
    const ec = buildIdChangeEc([c]);
    expect(ec).toContain(`_o := t.get("${c.from}")`);
    expect(ec).toContain(`str(_o.rid) != "${c.rid}"`);
    expect(ec).toContain(`t.get("${c.to}") != MISSING`);
    expect(ec).toContain(`_o.change(id := "${c.to}")`);
    expect(ec.indexOf('MISSING')).toBeLessThan(ec.indexOf('.change('));
    expect(ec.trimEnd().endsWith('"~CREV_D~"')).toBe(true);
    for (const status of ['gone', 'moved', 'taken', 'ok']) expect(ec).toContain(`${status.length}:${status}`);
  });

  it('stays small: a full batch is a few kilobytes, one statement per object', () => {
    const ec = buildIdChangeEc(many(ID_BATCH));
    expect(ec.length).toBeLessThan(12_000);
    expect(ec.match(/\.change\(id :=/g)).toHaveLength(ID_BATCH);
  });

  it('refuses an empty or oversized batch and anything that is not an ID, RID or space', () => {
    expect(() => buildIdChangeEc([])).toThrow();
    expect(() => buildIdChangeEc(many(ID_BATCH + 1))).toThrow();
    expect(() => checkIdChange(change(1, { to: 'bad id' }))).toThrow();
    expect(() => checkIdChange(change(1, { to: 'x"; DELETE' }))).toThrow();
    expect(() => checkIdChange(change(1, { rid: '12a' }))).toThrow();
    expect(() => checkIdChange(change(1, { space: 'T.x' }))).toThrow();
    expect(() => checkIdChange(change(1, { from: 'same', to: 'same' }))).toThrow();
  });

  it('reads the answer per RID and rejects damaged ones', () => {
    const items = many(2);
    const log = framedText([['R', items[0].rid, 'ok'], ['R', items[1].rid, 'taken']]);
    expect([...parseIdChangeLog(log, items)]).toEqual([[items[0].rid, 'ok'], [items[1].rid, 'taken']]);
    expect(() => parseIdChangeLog(framedText([['R', '1', 'ok']]), items)).toThrow();
    expect(() => parseIdChangeLog(framedText([['R', items[0].rid, 'maybe']]), items)).toThrow();
    expect(() => parseIdChangeLog('~CREV_R~1:R', items)).toThrow();
  });

  it('splits into batches', () => {
    expect(inBatches(many(45)).map(b => b.length)).toEqual([20, 20, 5]);
    expect(inBatches([])).toEqual([]);
  });
});

describe('applyIdChanges', () => {
  it('previews, commits and reads back each batch, never one call per object', async () => {
    const items = many(45);
    const s = fakeServer(items);
    const out = await applyIdChanges(items, s.port);
    expect(out.every(o => o.status === 'changed')).toBe(true);
    expect(s.calls.map(c => c.kind)).toEqual(['preview', 'commit', 'read', 'preview', 'commit', 'read', 'preview', 'commit', 'read']);
    expect(s.calls.filter(c => c.kind === 'commit').map(c => c.count)).toEqual([20, 20, 5]);
    expect(items.every(i => s.ids.get(i.rid) === i.to)).toBe(true);
  });

  it('commits only what the preview accepted and says why the rest was skipped', async () => {
    const items = many(4);
    const s = fakeServer(items, { taken: new Set([items[1].to]), gone: new Set([items[2].rid]) });
    const out = await applyIdChanges(items, s.port);
    expect(out.map(o => o.status)).toEqual(['changed', 'skipped', 'skipped', 'changed']);
    expect(out[1].reason).toMatch(/already used/);
    expect(out[2].reason).toMatch(/not on the server/);
    expect(s.calls.find(c => c.kind === 'commit')!.count).toBe(2);
    expect(s.ids.get(items[1].rid)).toBe(items[1].from);
  });

  it('does not commit a batch whose preview was not accepted, and does not start the next', async () => {
    const items = many(45);
    const s = fakeServer(items, { previewFails: 2 });
    const out = await applyIdChanges(items, s.port);
    expect(out.slice(0, 20).every(o => o.status === 'changed')).toBe(true);
    expect(out.slice(20, 40).every(o => o.status === 'failed' && /too large/.test(o.reason ?? ''))).toBe(true);
    expect(out.slice(40).every(o => o.status === 'skipped')).toBe(true);
    expect(s.calls.filter(c => c.kind === 'commit')).toHaveLength(1);
    expect(items.slice(20).every(i => s.ids.get(i.rid) === i.from)).toBe(true);
  });

  it('stops after a commit that failed, leaving the earlier batches changed', async () => {
    const items = many(25);
    const s = fakeServer(items, { commitFails: 2 });
    const out = await applyIdChanges(items, s.port);
    expect(out.filter(o => o.status === 'changed')).toHaveLength(20);
    expect(out.slice(20).map(o => o.status)).toEqual(Array(5).fill('failed'));
  });

  it('lets the server decide when a commit gives no answer', async () => {
    const items = many(3);
    const s = fakeServer(items, { commitThrows: 1 });
    const out = await applyIdChanges(items, s.port);
    // The write happened on the fake server although the call threw: the read shows it.
    expect(out.map(o => o.status)).toEqual(['failed', 'failed', 'failed']);
    const s2 = fakeServer(items, { dropWrites: new Set([items[0].rid]) });
    const out2 = await applyIdChanges(items, s2.port);
    expect(out2.map(o => o.status)).toEqual(['failed', 'changed', 'changed']);
  });

  it('reports "not known" when the read back fails, and stops', async () => {
    const items = many(25);
    const s = fakeServer(items, { readFails: true });
    const out = await applyIdChanges(items, s.port);
    expect(out.slice(0, 20).every(o => o.status === 'unknown')).toBe(true);
    expect(out.slice(20).every(o => o.status === 'skipped')).toBe(true);
  });

  it('does not start a batch after Stop', async () => {
    const items = many(25);
    const s = fakeServer(items);
    const stop = new AbortController();
    const out = await applyIdChanges(items, s.port, { signal: stop.signal, onBatch: () => stop.abort() });
    expect(out.slice(0, 20).every(o => o.status === 'changed')).toBe(true);
    expect(out.slice(20).every(o => o.status === 'skipped')).toBe(true);
  });
});

describe('planCodeEdits', () => {
  const changed = [change(1, { from: '5612', to: 'btn_proto_cleanup' }), change(2, { from: '316', to: 'tab_my_kpis', space: 'o' })];
  const holder = (code: string, prop = 'expression'): CodeHolder => ({ rid: '77', type: 'ExtendedExpression', name: 'Calc', businessId: 'calc', code: { [prop]: code } });
  const after = (code: string): string => {
    const [c] = planCodeEdits(changed, [holder(code)]);
    return c ? [...c.edits].sort((a, b) => b[0] - a[0]).reduce((t, [s, e, r]) => t.slice(0, s) + r + t.slice(e), code) : code;
  };

  it('replaces real references in every form the code links know', () => {
    expect(after('x := t.5612.value + t.5612.expression')).toBe('x := t.btn_proto_cleanup.value + t.btn_proto_cleanup.expression');
    expect(after('x := t.get("5612").name')).toBe('x := t.btn_proto_cleanup.name'.replace('t.btn_proto_cleanup.name', 't.get("btn_proto_cleanup").name'));
    expect(after("y := t.get('5612')")).toBe("y := t.get('btn_proto_cleanup')");
    expect(after('z := {5612}')).toBe('z := {btn_proto_cleanup}');
    expect(after('w := o.316.name')).toBe('w := o.tab_my_kpis.name');
  });

  it('leaves strings, comments, other IDs and other spaces alone', () => {
    const code = ['a := "t.5612"', '// t.5612', '/* t.5612 */', 'b := t.56123', 'c := t.5612_x', 'd := k.5612', 'e := _x.t.5612', 'f := t.get(_id)', 'g := o.5612'].join('\n');
    expect(planCodeEdits(changed, [holder(code)])).toEqual([]);
  });

  it('keeps the edits inside the reference and handles several scripts', () => {
    const code = 't.5612 + t.5612';
    const [c] = planCodeEdits(changed, [holder(code)]);
    expect(c.edits).toEqual([[2, 6, 'btn_proto_cleanup'], [11, 15, 'btn_proto_cleanup']]);
    expect(c.opened).toBe(code);
    const multi = planCodeEdits(changed, [holder('t.5612', 'expression'), { ...holder('t.5612', 'html'), rid: '78' }, { ...holder('t.5612', 'initExpression'), rid: '79' }]);
    // `html` is not Extended Code: it is left to a text search.
    expect(multi.map(m => `${m.rid}|${m.prop}`)).toEqual(['77|expression', '79|initExpression']);
  });

  it('idEdit refuses a reference that does not hold the ID where expected', () => {
    const text = 't.get("5612")';
    const [ref] = findCodeRefs(text);
    expect(idEdit(text, ref, '5612', 'x')).toEqual([7, 11, 'x']);
    expect(idEdit(text, ref, '9999', 'x')).toBeNull();
  });

  it('counts the objects whose code names each key', () => {
    const cards = [
      { rid: 'a', refs: [{ k: 't.5612' }, { k: 't.5612' }, { k: 'rid:1' }] },
      { rid: 'b', refs: [{ k: 't.5612' }, { k: 'o.316' }] },
      { rid: 'c', refs: [{ k: 't.other' }] },
    ];
    const counts = codeObjectCounts(cards, new Set(['t.5612', 'o.316', 't.none']));
    expect([...counts.get('t.5612')!].sort()).toEqual(['a', 'b']);
    expect([...counts.get('o.316')!]).toEqual(['b']);
    expect(counts.has('t.none')).toBe(false);
  });
});

/** A code port over a map of server texts. */
function codePort(texts: Map<string, string>, opts: { syntaxFails?: Set<string>; changed?: Set<string> } = {}): { port: ReplacePort; writes: string[] } {
  const writes: string[] = [];
  const key = (rid: string, prop: string) => `${rid}|${prop}`;
  return {
    writes,
    port: {
      async fetch(rid, props) {
        const code: Record<string, string> = {};
        for (const p of props) code[p] = opts.changed?.has(key(rid, p)) ? `${texts.get(key(rid, p))} // edited by someone` : texts.get(key(rid, p)) ?? '';
        return { ok: true, code };
      },
      async check(text) { return opts.syntaxFails?.has(text) ? { ok: false, message: 'bad', verdict: true } : { ok: true }; },
      async write(rid: string, _l: ScriptLabel, prop: string, value: string) {
        texts.set(key(rid, prop), value);
        writes.push(key(rid, prop));
        return { ok: true, committed: true } as never;
      },
    },
  };
}

describe('the record and changing back', () => {
  const ids = [change(1, { from: '5612', to: 'btn_a' }), change(2, { from: '5613', to: 'btn_b' })];
  const outcomes = ids.map(item => ({ item, status: 'changed' as const }));

  it('is built from what changed, read back and validated', () => {
    expect(buildNumericRecord('env', [{ item: ids[0], status: 'failed' }], [], 'ids')).toBeNull();
    const r = buildNumericRecord('env', outcomes, [], 'ids', new Date('2026-11-19T10:00:00Z'))!;
    expect(r).toMatchObject({ v: 1, environment: 'env', phase: 'ids', at: '2026-11-19T10:00:00.000Z' });
    expect(readNumericRecord(JSON.parse(JSON.stringify(r)), 'env')).toEqual(r);
    expect(readNumericRecord(r, 'other')).toBeNull();
    expect(readNumericRecord({ ...r, ids: [{ rid: 1 }] }, 'env')).toBeNull();
    expect(readNumericRecord(null, 'env')).toBeNull();
    expect(numericRecordKey('env')).toBe('crev_numeric_ids_undo:env');
  });

  async function changeAll() {
    const server = fakeServer(ids);
    await applyIdChanges(ids, server.port);
    const texts = new Map([['77|expression', 'a := t.5612 + t.5613'], ['78|expression', 'b := t.5612']]);
    const holders: CodeHolder[] = [
      { rid: '77', type: 'ExtendedExpression', name: 'One', businessId: 'one', code: { expression: texts.get('77|expression')! } },
      { rid: '78', type: 'ExtendedExpression', name: 'Two', businessId: 'two', code: { expression: texts.get('78|expression')! } },
    ];
    const cp = codePort(texts);
    const results = await applyReplace(planCodeEdits(ids, holders), cp.port);
    return { server, texts, cp, results };
  }

  it('changes the code that names changed IDs, once each', async () => {
    const { texts, results } = await changeAll();
    expect(results.map(r => r.status)).toEqual(['saved', 'saved']);
    expect(texts.get('77|expression')).toBe('a := t.btn_a + t.btn_b');
    expect(texts.get('78|expression')).toBe('b := t.btn_a');
  });

  it('puts IDs and code back, in that order', async () => {
    const { server, texts, cp, results } = await changeAll();
    const record = buildNumericRecord('env', outcomes, results, 'done')!;
    const back = await changeBack(record, server.port, cp.port);
    expect(back.ids.every(o => o.status === 'changed')).toBe(true);
    expect(back.heldBack).toBe(0);
    expect(back.rest).toBeNull();
    expect(texts.get('77|expression')).toBe('a := t.5612 + t.5613');
    expect(texts.get('78|expression')).toBe('b := t.5612');
    expect(ids.every(i => server.ids.get(i.rid) === i.from)).toBe(true);
  });

  it('keeps the new name of an ID that cannot go back, and the scripts that name it', async () => {
    const { server, texts, cp, results } = await changeAll();
    const record = buildNumericRecord('env', outcomes, results, 'done')!;
    // Something else has taken the old ID of the first object since.
    const stuck = fakeServer(ids, { taken: new Set(['5612']) });
    for (const [k, v] of server.ids) stuck.ids.set(k, v);
    const back = await changeBack(record, stuck.port, cp.port);
    expect(back.ids.map(o => o.status)).toEqual(['skipped', 'changed']);
    // Script one names both IDs, script two only the stuck one: both stay as they are.
    expect(back.heldBack).toBe(2);
    expect(back.code).toEqual([]);
    expect(texts.get('78|expression')).toBe('b := t.btn_a');
    expect(back.rest!.ids.map(i => i.rid)).toEqual([ids[0].rid]);
    expect(back.rest!.code).toHaveLength(2);
  });

  it('leaves a script that someone changed since, and keeps it in the record', async () => {
    const { server, texts, results } = await changeAll();
    const record = buildNumericRecord('env', outcomes, results, 'done')!;
    const cp = codePort(texts, { changed: new Set(['78|expression']) });
    const back = await changeBack(record, server.port, cp.port);
    expect(back.code.map(r => r.status)).toEqual(['saved', 'changed']);
    expect(back.rest!.code.map(s => s.rid)).toEqual(['78']);
    expect(back.rest!.ids).toEqual([]);
  });
});
