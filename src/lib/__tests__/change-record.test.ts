import { describe, expect, it } from 'vitest';
import { appendChanges, CHANGES_MAX, changesKey, cutNote, toRecord, VALUE_MAX, type ChangeRecord } from '../change-record';

const input = (over: Record<string, unknown> = {}) => ({ rid: '9007199254740993', prop: 'description', before: 'old', after: 'new', ...over });

describe('change record', () => {
  it('keeps the rid as text and the values as sent', () => {
    expect(toRecord(input({ name: 'Risk', label: 'Description' }), 1, 5, 'admin')).toEqual({
      id: 1, at: 5, rid: '9007199254740993', prop: 'description', name: 'Risk', label: 'Description', before: 'old', after: 'new', actor: 'admin',
    });
  });

  it('refuses what is not a change', () => {
    expect(toRecord(input({ rid: 'x' }), 1, 0)).toBeNull();
    expect(toRecord(input({ rid: 12 }), 1, 0)).toBeNull();
    expect(toRecord(input({ before: undefined }), 1, 0)).toBeNull();
    expect(toRecord(input({ prop: '' }), 1, 0)).toBeNull();
    expect(toRecord(null, 1, 0)).toBeNull();
  });

  it('cuts long values and says so', () => {
    const rec = toRecord(input({ before: 'a'.repeat(VALUE_MAX + 1), after: 'b' }), 1, 0)!;
    expect(rec.before).toHaveLength(VALUE_MAX);
    expect(rec.cut).toBe('before');
    expect(cutNote(rec, 'before')).toBe(`Only the first ${VALUE_MAX} characters were kept.`);
    expect(cutNote(rec, 'after')).toBe('');
  });

  it('marks a reset and an unconfirmed write', () => {
    expect(toRecord(input({ reset: true, unchecked: true, after: '' }), 1, 0)).toMatchObject({ reset: true, unchecked: true });
    expect(toRecord(input({ reset: 'yes' }), 1, 0)).not.toHaveProperty('reset');
  });

  it('numbers on from the newest and keeps the newest CHANGES_MAX', () => {
    let list: ChangeRecord[] = [];
    for (let i = 0; i < CHANGES_MAX + 5; i++) list = appendChanges(list, [input({ after: String(i) })], i);
    expect(list).toHaveLength(CHANGES_MAX);
    expect(list[0].after).toBe('5');
    expect(list[list.length - 1].id).toBe(CHANGES_MAX + 5);
    expect(appendChanges(list, [{ rid: 'bad' }], 0)).toHaveLength(CHANGES_MAX);
  });

  it('stores per server profile', () => {
    expect(changesKey('p1')).toBe('crev_p1_changes');
  });
});
