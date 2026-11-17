/**
 * The undo of the last apply (transport-undo.ts): the record kept from the
 * confirmed comparison, what is read after the apply, and the scripts that
 * bring the target back as it was before, per kind.
 */
import { describe, expect, it } from 'vitest';
import { checkSaysReady, createdTimesText, CREATED_MARKER, parseCreatedTimes, UNDO_READY_LINE, type ProbeAnswer } from '../transport-patch';
import { buildUndoPlan, finishUndoRecord, KEPT_LINE, keptLines, NO_CREATED_TIME, readUndoRecord, undoKey, type UndoRecord } from '../transport-undo';

const record = (over: Partial<UndoRecord> = {}): UndoRecord => ({
  v: 1, source: 'p1@https://a.test/', target: 'p2@https://b.test/', targetLabel: 'Demo TEST', at: '2026-11-16T20:40:00.000Z',
  changed: [], moved: [], renamed: [], added: [], classLinks: [], stepLinks: [], own: [], cannot: [], ...over,
});

/** A part's statements, without its comment lines. */
const bodyOf = (text: string) => text.split('\n').filter(l => l && !l.startsWith('//'));
const partOf = (r: UndoRecord, step: string) => buildUndoPlan(r).patch.parts.find(p => p.step === step);

const changed: UndoRecord['changed'][number] = {
  rid: '1', address: 't.el_a', className: 'TextElement',
  before: "t.el_a.change(id := 'el_a', name := 'Old', description := 'only there') //TextElement",
  written: "t.el_a.change(id := 'el_a', name := 'New', status := 'x') //TextElement",
};

describe('the undo scripts', () => {
  it('a Check first, a preview, then the committed parts in the order of an apply', () => {
    const plan = buildUndoPlan(record({
      changed: [{ ...changed, after: { size: 80, date: 'Nov 16, 2026 21:40:10' } }],
      moved: [{ rid: '2', address: 't.el_b', className: 'TextElement', parentId: 'page_a', previousId: 'el_prev', nextId: '', afterParentId: 'page_b' }],
      renamed: [{ rid: '3', from: 't.old_id', to: 't.new_id', className: 'TextElement' }],
      added: [{ rid: '4', address: 't.el_new', className: 'Category', created: 'Nov 16, 2026 21:40:05' }],
      classLinks: [{ rid: '6', address: 'property.cc_note', className: 'CeProcess' }],
      own: [{ rid: '6', address: 'property.cc_note', className: 'CeProcess', before: [{ name: 'mandatory', value: 'true' }], written: [{ name: 'mandatory', value: 'false' }] }],
    }));
    expect(plan.patch.parts.map(p => [p.step, p.run])).toEqual([
      ['check', 'preview'], ['rename', 'committed'], ['set', 'committed'], ['link', 'committed'], ['own', 'committed'], ['order', 'committed'], ['delete', 'committed'],
    ]);
    expect(plan.patch.nothingToDo).toBe(false);
    expect(plan.patch.parts[0].text.split('\n')[0]).toBe('// Undo scripts, part 1 of 7: Check');
  });

  it('the Check: size and date the apply left, else the text as written or as it was before; the place; the new ID', () => {
    const check = bodyOf(partOf(record({
      changed: [{ ...changed, after: { size: 80, date: 'Nov 16, 2026 21:40:10' } }],
      moved: [{ rid: '2', address: 't.el_b', className: 'TextElement', parentId: 'page_a', previousId: '', nextId: '', afterParentId: 'page_b' }],
      renamed: [{ rid: '3', from: 't.old_id', to: 't.new_id', className: 'TextElement' }],
    }), 'check')!.text);
    expect(check.slice(0, 3)).toEqual(['_r := "Undo check (3 checks in this part)"', '_ok := ""', '_dv := ""']);
    expect(check).toContain('     IF _g.size() = 80 AND _d = "Nov 16, 2026 21:40:10" THEN');
    expect(check).toContain('          _r := _r + "\\nCHANGED since the apply t.el_a"');
    expect(check).toContain('IF t.el_b != MISSING AND str(t.el_b.parent.id) = "page_b" THEN');
    expect(check).toContain('     _r := _r + "\\nMOVED since the apply t.el_b"');
    expect(check).toContain('IF t.new_id != MISSING THEN');
    expect(check.slice(-6)).toEqual([
      'IF _dv.size() = 0 THEN',
      `     _r := _r + "\\n${UNDO_READY_LINE}"`,
      'ELSE',
      '     _r := _r + "\\nStop: the target changed since the apply. Do not run the next parts."',
      'ENDIF',
      '_r',
    ]);
    expect(checkSaysReady(`Undo check (3 checks in this part)\n${UNDO_READY_LINE}`)).toBe(true);
    // Without size and date (the apply stopped before its comparison): the
    // whole text, as written or as it was before.
    const open = partOf(record({ changed: [changed] }), 'check')!.text;
    expect(open).not.toContain('lastModifiedDate');
    expect(open).toContain('New');
    expect(open).toContain('only there');
    expect(open).toContain('CHANGED since the apply t.el_a');
  });

  it('a changed object: changed back, and the values the apply added cleared', () => {
    expect(bodyOf(partOf(record({ changed: [changed] }), 'set')!.text).slice(-2)).toEqual([
      "t.el_a.change(id := 'el_a', name := 'Old', description := 'only there')",
      't.el_a.clear(status)',
    ]);
  });

  it('a moved object: moved back under its parent, then after its previous sibling (or before its next)', () => {
    const m = { rid: '2', address: 't.el_b', className: 'TextElement', parentId: 'page_a', previousId: 'el_prev', nextId: 'el_next', afterParentId: 'page_b' };
    expect(bodyOf(partOf(record({ moved: [m] }), 'order')!.text).slice(-2)).toEqual([
      'IF t.el_b != MISSING AND t.page_a != MISSING THEN t.el_b.move(t.page_a) ELSE "" ENDIF',
      'IF t.el_b != MISSING AND t.el_prev != MISSING THEN t.el_b.moveAfter(t.el_prev) ELSE "" ENDIF',
    ]);
    expect(bodyOf(partOf(record({ moved: [{ ...m, previousId: '' }] }), 'order')!.text).at(-1))
      .toBe('IF t.el_b != MISSING AND t.el_next != MISSING THEN t.el_b.moveBefore(t.el_next) ELSE "" ENDIF');
  });

  it('an ID change: back to the old ID, only while the old one is free', () => {
    expect(bodyOf(partOf(record({ renamed: [{ rid: '3', from: 't.old_id', to: 't.new_id', className: 'TextElement' }] }), 'rename')!.text).at(-1))
      .toBe("IF t.new_id != MISSING AND t.old_id = MISSING AND t.new_id.className = 'TextElement' THEN t.new_id.change(id := 'old_id') ELSE \"\" ENDIF");
  });

  it('class links and links between steps: those added removed, those removed added again', () => {
    const link = partOf(record({
      classLinks: [{ rid: '6', address: 'property.cc_note', className: 'CeProcess' }],
      stepLinks: [{ rid: '7', project: 't.flow', pair: 's1>s2', from: 't.s1', to: 't.s2' }, { rid: '7', project: 't.flow', pair: 's2>s3', from: 't.s2', to: 't.s3', removed: true }],
    }), 'link')!.text;
    expect(link).toContain('_lc := c.get(CeProcess.name)');
    expect(link).toContain('          k.get(_lx).delete()');
    expect(link).toContain('          IF _k = "s1>s2" THEN _i.delete() ELSE "" ENDIF');
    expect(link).toContain('          t.flow.add(TransLink, transLink, from := t.s2, to := t.s3)');
  });

  it('own values per class: back as they were, those the apply added cleared', () => {
    const own = bodyOf(partOf(record({
      own: [{ rid: '6', address: 'property.cc_note', className: 'CeProcess', before: [{ name: 'mandatory', value: 'true' }], written: [{ name: 'mandatory', value: 'false' }, { name: 'readOnly', value: 'true' }] }],
    }), 'own')!.text);
    expect(own).toContain('          k.get(_lx).change(mandatory := true)');
    expect(own).toContain('          k.get(_lx).clear(readOnly)');
  });

  it('added objects: deleted children first, each guarded by class, when it was added and nothing under it', () => {
    const plan = buildUndoPlan(record({
      added: [
        { rid: '4', address: 't.el_new', className: 'Category', created: 'Nov 16, 2026 21:40:05' },
        { rid: '5', address: 't.el_child', className: 'TextElement', created: 'Nov 16, 2026 21:40:06' },
        { rid: '8', address: 't.el_unread', className: 'TextElement' },
        { rid: '9', address: 't.el_never', className: 'TextElement', created: '' },
      ],
    }));
    const del = bodyOf(plan.patch.parts.find(p => p.step === 'delete')!.text);
    expect(del[0]).toBe('_r := ""');
    expect(del.at(-1)).toBe('_r');
    expect(del.slice(1, 15)).toEqual([
      'IF t.el_child != MISSING AND t.el_child.className = \'TextElement\' AND str(t.el_child.createdTime.whenMissing("")) = "Nov 16, 2026 21:40:06" THEN',
      '     _d := t.el_child.descendants().first(1)',
      '     IF _d.size() = 0 THEN',
      '          t.el_child.delete()',
      '     ELSE',
      `          _r := _r + "\\nt.el_child ${KEPT_LINE}"`,
      '     ENDIF',
      'ELSE',
      '     IF t.el_child != MISSING THEN',
      `          _r := _r + "\\nt.el_child ${KEPT_LINE}"`,
      '     ELSE ""',
      '     ENDIF',
      'ENDIF',
      'IF t.el_new != MISSING AND t.el_new.className = \'Category\' AND str(t.el_new.createdTime.whenMissing("")) = "Nov 16, 2026 21:40:05" THEN',
    ]);
    // When it was added was not read: it stays, listed. Not on the target: nothing to do.
    expect(plan.kept).toEqual([{ address: 't.el_unread', reason: NO_CREATED_TIME }]);
    expect(del.join('\n')).not.toMatch(/el_unread|el_never/);
    expect(plan.patch.counts.delete).toBe(2);
    // The lines of a committed Delete part that kept objects.
    expect(keptLines(`Result : \nt.el_child ${KEPT_LINE}\r\nDuration : 3ms`)).toEqual([`t.el_child ${KEPT_LINE}`]);
  });

  it('deleted objects and removed class links are listed as cannot be undone; nothing else: nothing to do', () => {
    const plan = buildUndoPlan(record({ cannot: [{ address: 't.gone', className: 'TextElement', what: 'deleted' }, { address: 'property.cc_x', className: 'CeRisk', what: 'unlinked' }] }));
    expect(plan.cannot.map(c => c.reason)).toEqual([
      't.gone (TextElement) was deleted: it cannot be undone.',
      'The link of property.cc_x to CeRisk was removed: it cannot be undone.',
    ]);
    expect(plan.patch.nothingToDo).toBe(true);
    expect(plan.patch.text).toContain('// Cannot be undone: t.gone (TextElement) was deleted: it cannot be undone.');
  });
});

describe('the record', () => {
  it('after the apply: size and date per changed object, when each added object was added', () => {
    const r = record({ changed: [changed], added: [{ rid: '4', address: 't.el_new', className: 'Category' }, { rid: '5', address: 't.el_gone', className: 'Category' }] });
    const answer = { states: { 't.el_a': { state: 'present', className: 'TextElement', genedit: 'x'.repeat(42), modified: 'Nov 16, 2026 21:40:10' } } } as unknown as ProbeAnswer;
    const done = finishUndoRecord(r, answer, new Map([['t.el_new', 'Nov 16, 2026 21:40:05'], ['t.el_gone', '']]));
    expect(done.changed[0].after).toEqual({ size: 42, date: 'Nov 16, 2026 21:40:10' });
    expect(done.added.map(a => a.created)).toEqual(['Nov 16, 2026 21:40:05', '']);
  });

  it('when objects were added: one loop per ID space, an empty time when it is not there', () => {
    const text = createdTimesText(['t.el_new', 't.EL_two', 'property.cc_note']);
    expect(text.split('\n')).toEqual([
      `_r := "${CREATED_MARKER}"`,
      'list("el_new", "EL_two").forEach(_x:',
      '     _o := t.get(_x)',
      '     IF _o != MISSING THEN',
      '          _c := str(_o.createdTime.whenMissing(""))',
      '          _r := _r + ("\\nt " + str(_x.size()) + ":" + _x + " " + str(_c.size()) + ":" + _c)',
      '     ELSE',
      '          _r := _r + ("\\nt " + str(_x.size()) + ":" + _x + " 0:")',
      '     ENDIF',
      ')',
      'list("cc_note").forEach(_x:',
      '     _o := property.get(_x)',
      '     IF _o != MISSING THEN',
      '          _c := str(_o.createdTime.whenMissing(""))',
      '          _r := _r + ("\\nproperty " + str(_x.size()) + ":" + _x + " " + str(_c.size()) + ":" + _c)',
      '     ELSE',
      '          _r := _r + ("\\nproperty " + str(_x.size()) + ":" + _x + " 0:")',
      '     ENDIF',
      ')',
      `_r + "\\n${CREATED_MARKER} end"`,
    ]);
    const log = `Result : ${CREATED_MARKER}\nt 6:el_new 21:Nov 16, 2026 21:40:05\nt 6:EL_two 0:\nproperty 7:cc_note 21:Nov 16, 2026 21:40:07\n${CREATED_MARKER} end\nDuration : 3ms`;
    expect([...parseCreatedTimes(log)]).toEqual([['t.el_new', 'Nov 16, 2026 21:40:05'], ['t.el_two', ''], ['property.cc_note', 'Nov 16, 2026 21:40:07']]);
    expect(parseCreatedTimes('Result : nothing').size).toBe(0);
  });

  it('is read only for its source and target, and has its own key in the draft family', () => {
    const r = record();
    expect(readUndoRecord(structuredClone(r), r.source, r.target)).toEqual(r);
    expect(readUndoRecord(r, r.source, 'p3@https://c.test/')).toBeNull();
    expect(readUndoRecord({ ...r, added: null }, r.source, r.target)).toBeNull();
    expect(readUndoRecord(null, r.source, r.target)).toBeNull();
    expect(undoKey(r.source, r.target)).toBe('crev_transport_undo:p1@https://a.test/|p2@https://b.test/');
  });
});
