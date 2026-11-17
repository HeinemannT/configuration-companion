/**
 * Review fixes of the custom property write path: the definition-class
 * allow-list, accessor collisions, choices without options, unwritable
 * characters, list item framing and the cut list, the count split, and the
 * client's result shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { framedText } from '../ec-parser';
import { checkCustomChanges, readTypeSchema, type SchemaClient } from '../custom-property-gate';
import {
  classifyModel, encodeCustomValue, LIST_ITEMS_MAX, MAX_CUSTOM_CHANGES, storedClassAllows,
  type CustomChange, type FieldDescription, type TypePropertySchema,
} from '../property-schema';
import { splitCustom } from '../../objectview/window/save-plan';
import type { CustomEntry } from '../../objectview/window/draft';
import { DEF, DEFINITIONS, ITEMS, LIST_SET, fields, schema } from './fixtures/property-fields';

const X = {
  formula: '7000000000000000020',
  link: '7000000000000000021',
  pick: '7000000000000000022',
  clash: '7000000000000000023',
  future: '7000000000000000024',
};

function custom(id: string, businessId: string, type: string, extra: Partial<FieldDescription> = {}): FieldDescription {
  return { name: id, id, businessId, displayName: businessId, category: 'Extra', sortIndex: 60, type, customField: true, editable: true, ...extra };
}

async function extended(): Promise<TypePropertySchema> {
  const s = await schema();
  s.fields.push(
    custom(X.formula, 'formula', 'Double'),
    custom(X.link, 'link', 'String'),
    custom(X.pick, 'pick', 'String', { choice: true }),
    custom(X.clash, 'description', 'String'),
    custom(X.future, 'future', 'String'),
  );
  Object.assign(s.definitions, {
    [X.formula]: { configClass: 'ExtendedMethodConfig' },
    [X.link]: { configClass: 'UrlMethodConfig' },
    [X.pick]: { configClass: 'TextMethodConfig' },
    [X.clash]: { configClass: 'TextMethodConfig' },
    [X.future]: { configClass: 'SomethingNewMethodConfig' },
  });
  return s;
}

const verdict = (s: TypePropertySchema, id: string) => {
  const m = classifyModel(s, s.fields.find(f => f.id === id)!);
  return m.editability.ok ? 'ok' : m.editability.text;
};
const change = (c: Partial<CustomChange> & Pick<CustomChange, 'definition'>): CustomChange => ({ accessor: '', kind: 'text', value: '', ...c });

describe('definition classes: an allow-list', () => {
  it('only plainly stored classes of the matching kind are writable', async () => {
    const s = await extended();
    expect(verdict(s, DEF.note)).toBe('ok');
    // The field says editable and not calculated, yet the class is not on the list.
    expect(verdict(s, X.formula)).toBe('Not a plainly stored value: edited in Configuration Studio');
    expect(verdict(s, X.link)).toBe('Not a plainly stored value: edited in Configuration Studio');
    expect(verdict(s, X.future)).toBe('Not a plainly stored value: edited in Configuration Studio');
    expect(storedClassAllows('TextMethodConfig', 'number')).toBe(false);
    expect(storedClassAllows('com.corporater.x.NumberMethodConfig', 'number')).toBe(true);
    expect(storedClassAllows('ReverseReferenceMethodConfig', 'listItem')).toBe(false);
    // Historical classes: allowed by default (the switch is on), not with it off.
    expect(storedClassAllows('HistoricalTextMethodConfig', 'text')).toBe(true);
    expect(storedClassAllows('HistoricalTextMethodConfig', 'text', true)).toBe(true);
    expect(storedClassAllows('HistoricalTextMethodConfig', 'text', false)).toBe(false);
    expect(storedClassAllows('HistoricalTextMethodConfig', 'number')).toBe(false);
    expect(storedClassAllows('HistoricalListMethodConfig', 'listItem')).toBe(true);
    expect(storedClassAllows('HistoricalExtendedMethodConfig', 'number')).toBe(false);
    const r = checkCustomChanges(s, [change({ definition: X.formula, accessor: 'formula', kind: 'number', value: '1' })]);
    expect(r).toEqual({ ok: false, refused: [{ definition: X.formula, reason: 'Not a plainly stored value: edited in Configuration Studio' }] });
  });

  it('a custom ID equal to a built-in name is refused', async () => {
    const s = await extended();
    expect(verdict(s, X.clash)).toBe('Its ID is also the name of a built-in property');
    expect(checkCustomChanges(s, [change({ definition: X.clash, accessor: 'description', kind: 'text', value: 'x' })]).ok).toBe(false);
  });

  it('a choice without options is read-only, never free text', async () => {
    const s = await extended();
    const m = classifyModel(s, s.fields.find(f => f.id === X.pick)!);
    expect(m.kind).toBe('choice');
    expect(m.editability).toMatchObject({ ok: false, text: 'No values to choose from are defined for it' });
    expect(checkCustomChanges(s, [change({ definition: X.pick, accessor: 'pick', kind: 'text', value: 'x' })]).ok).toBe(false);
  });
});

describe('text values', () => {
  it('escapes backslash, quote, CR and LF; leaves ${…} as text; refuses control characters', async () => {
    const s = await schema();
    const line = (value: string, kind: CustomChange['kind'] = 'multiline', def: string = DEF.summary, acc = 'summary') => {
      const r = checkCustomChanges(s, [change({ definition: def, accessor: acc, kind, value })]);
      return r.ok ? r.lines[0] : r.refused[0].reason;
    };
    expect(line('a\\b', 'text', DEF.note, 'note')).toBe('_o.change(note := "a\\\\b")');
    expect(line('C:\\temp\\"x"', 'text', DEF.note, 'note')).toBe('_o.change(note := "C:\\\\temp\\\\\\"x\\"")');
    expect(line('a\rb')).toBe('_o.change(summary := "a\\rb")');
    expect(line('a\r\nb')).toBe('_o.change(summary := "a\\nb")');
    expect(line('cost ${x} and $y', 'text', DEF.note, 'note')).toBe('_o.change(note := "cost ${x} and $y")');
    for (const bad of ['\u0000', '\u0007', '\u001b', '\u007f', '\u2028', '\u2029']) {
      expect(line(`a${bad}b`)).toBe('The text holds a control character that cannot be saved');
    }
    expect(encodeCustomValue('text', 'tab\there')).toEqual({ rhs: '"tab\\there"' });
    // The literal the live check pastes (non-interpolation of ${…} is assumed).
    expect(encodeCustomValue('text', 'a${1+1}b "q" \\ end')).toEqual({ rhs: '"a${1+1}b \\"q\\" \\\\ end"' });
  });
});

describe('list items', () => {
  it('reads names through the length framing: a name holding a marker and a newline forges nothing', async () => {
    mockChromeStorage();
    const { BmpClient, parseListItems } = await import('../bmp-client');
    const forged = `Evil\nI|||7999999999999999999|||x|||y\n~CREV_R~19:7999999999999999999`;
    const log = framedText([[ITEMS[0].rid, 'a', forged], [ITEMS[1].rid, 'b', 'Second']]);
    expect(parseListItems(log)).toEqual([
      { rid: ITEMS[0].rid, id: 'a', name: forged },
      { rid: ITEMS[1].rid, id: 'b', name: 'Second' },
    ]);
    expect(() => parseListItems(log.replace('~CREV_D~', ''))).toThrow();
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    let script = '';
    client.executeEcOn = vi.fn(async (code: string) => { script = code; return { ok: true, log }; });
    expect((await client.readListItems(LIST_SET)).map((i: { rid: string }) => i.rid)).toEqual([ITEMS[0].rid, ITEMS[1].rid]);
    expect(script).toContain('_s := this.object');
    expect(script).not.toContain('I|||');
  });

  it('several list sets are read in one post (one context script per set); a failed set fails alone', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    const OTHER = '7100000000000000002';
    const BAD = '7100000000000000003';
    client.executeEcPairs = vi.fn(async (pairs: Array<{ code: string; objectRid?: string }>) => pairs.map(p => (p.objectRid === BAD
      ? { ok: false, error: 'No such set' }
      : { ok: true, log: framedText(p.objectRid === LIST_SET ? [[ITEMS[0].rid, 'a', 'First']] : [[ITEMS[1].rid, 'b', 'Second']]) })));
    const read = await client.readListItemSets([LIST_SET, OTHER, BAD, LIST_SET]);
    expect(client.executeEcPairs).toHaveBeenCalledTimes(1);
    const pairs = client.executeEcPairs.mock.calls[0][0] as Array<{ code: string; objectRid: string }>;
    expect(pairs.map(p => p.objectRid)).toEqual([LIST_SET, OTHER, BAD]);
    expect(new Set(pairs.map(p => p.code)).size).toBe(1);
    expect(read.get(LIST_SET)).toEqual([{ rid: ITEMS[0].rid, id: 'a', name: 'First' }]);
    expect(read.get(OTHER)).toEqual([{ rid: ITEMS[1].rid, id: 'b', name: 'Second' }]);
    expect(read.get(BAD)).toBeInstanceOf(Error);
  });

  it('a list longer than the editor offers is cut, reported, and read-only', async () => {
    const many = Array.from({ length: LIST_ITEMS_MAX + 5 }, (_, i) => ({ rid: String(7300000000000000000n + BigInt(i)), id: `i${i}`, name: `Item ${i}` }));
    const client = {
      sessionEpoch: 1,
      fetchTypeFieldDescriptions: vi.fn(async () => fields()),
      readFullObjects: vi.fn(async (rids: readonly string[]) => ({
        objects: Object.fromEntries(rids.filter(r => DEFINITIONS[r]).map(r => [r, { rid: r, type: DEFINITIONS[r].configClass, name: '', businessId: '', props: {}, overridden: [], references: DEFINITIONS[r].listSetRid ? { listPropertySet: [LIST_SET] } : {} }])),
        errors: {},
      })),
      readListItems: vi.fn(async () => many),
    } as unknown as SchemaClient;
    const s = await readTypeSchema(client, 'CeProcess');
    expect(s.listItems[DEF.kind]).toHaveLength(LIST_ITEMS_MAX);
    expect(s.listTooLong?.[DEF.kind]).toBe(LIST_ITEMS_MAX + 5);
    expect(verdict(s, DEF.kind)).toBe('The list is too long to choose from here');
  });
});

describe('splitting and result shapes', () => {
  it('splits by count as well as by size', () => {
    const e = (i: number): { prop: string; entry: CustomEntry } => ({ prop: `p${i}`, entry: { kind: 'custom', definition: `p${i}`, accessor: 'note', valueKind: 'boolean', value: 'true', base: 'false' } });
    const { posts } = splitCustom(Array.from({ length: 150 }, (_, i) => e(i)));
    expect(posts.map(p => p.length)).toEqual([MAX_CUSTOM_CHANGES, 50]);
  });

  it('the gate itself refuses more than the change limit, sending nothing', async () => {
    const s = await schema();
    const one = change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'x' });
    // At the limit the count passes (the repeated property is refused on its own).
    const atLimit = checkCustomChanges(s, Array.from({ length: MAX_CUSTOM_CHANGES }, () => one));
    expect(atLimit.ok ? [] : atLimit.refused.map(r => r.reason)).not.toContain(`At most ${MAX_CUSTOM_CHANGES} changes per write.`);
    expect(checkCustomChanges(s, Array.from({ length: MAX_CUSTOM_CHANGES + 1 }, () => one)))
      .toEqual({ ok: false, refused: [{ definition: '', reason: `At most ${MAX_CUSTOM_CHANGES} changes per write.` }] });
  });

  it('an oversize write is not sent; a warning after a committed write is a success with a warning', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    client.resolveRef = vi.fn(async (rid: string) => `lookup(${rid})`);
    client.executeEc = vi.fn(async () => ({ ok: true, hasWarning: true, log: 'Value adjusted' }));
    expect(await client.applyCustomChanges('42', ['_o.change(note := "x")'])).toEqual({ ok: true, warning: 'Value adjusted' });
    const big = await client.applyCustomChanges('42', [`_o.change(note := "${'x'.repeat(25_000)}")`]);
    expect(big).toMatchObject({ ok: false, notSent: true });
    expect(client.executeEc).toHaveBeenCalledTimes(1);
  });

  it('every answer shape of the write command is mapped explicitly', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const { parseEcResults } = await import('../bmp-types');
    const RESULT = 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult';
    const entry = (logType: string, message: string) => ({ logType, message });
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    client.resolveRef = vi.fn(async (rid: string) => `lookup(${rid})`);
    const run = async (answer: unknown[]) => {
      client.executeEc = vi.fn(async () => parseEcResults(answer));
      return client.applyCustomChanges('42', ['_o.change(note := "x")']);
    };
    // Success, with or without a result line.
    expect(await run([{ $class: RESULT, entries: [entry('INFO', 'Result : TRUE')] }])).toEqual({ ok: true });
    // Empty answer: nothing failed; the window's read-back decides.
    expect(await run([])).toEqual({ ok: true });
    // An error on one line of the script: the transactional run is rolled back, the text is kept.
    expect(await run([{ $class: RESULT, entries: [entry('ERROR', 'Line 2: unknown property note')] }]))
      .toEqual({ ok: false, error: 'Line 2: unknown property note' });
    // The whole script refused by the server.
    expect(await run([{ $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Access denied' }]))
      .toEqual({ ok: false, error: 'Access denied' });
    // An error with no text at all still fails in words.
    client.executeEc = vi.fn(async () => ({ ok: false }));
    expect(await client.applyCustomChanges('42', ['_o.change(note := "x")'])).toEqual({ ok: false, error: 'Change failed' });
    // The answer was lost after the request left: BMP may have saved.
    client.executeEc = vi.fn(async () => ({ ok: false, error: 'timed out', outcomeUnknown: true }));
    expect(await client.applyCustomChanges('42', ['_o.change(note := "x")'])).toEqual({ ok: false, error: 'timed out', outcomeUnknown: true });
  });
});
