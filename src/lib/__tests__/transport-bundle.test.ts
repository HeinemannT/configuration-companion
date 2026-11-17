/**
 * Transport (beta), the pure half: reading genedit and generate text,
 * address checks, parents-first order, the guards and exact comparison, and
 * the bundle's parts.
 */
import { describe, expect, it } from 'vitest';
import {
  argumentPairs, argumentReferences, argumentText, assembleBundle, BUNDLE_NOTES, BUNDLE_PART_LIMIT, checkAddress, createArgumentPieces, createBlock, createdOnOrAfter,
  createParentAddress, createSetsValues, decodeEcString, orderForAdd, refersToLaterAdded,
  ecSingleQuoted, exactTextEc, GUARD_CLOSE, GUARD_OPEN, guardBlockEc, identityGuardEc, idOfAddress, isScanDay, isTransportRoot, nameArgument, orderParentsFirst, outsideReferences, parseGenedit, parseScanStart,
  plainAddress, PREAMBLE_REFERENCES_SHOWN, referencedAddresses, rootAddressOf, serverStampIso, splitArguments, splitStatements, START_EMPTY, START_NOT_ID, START_SPACE,
  stripLikeServer, NO_PARENT_DETAIL, PROPERTY_LINKS_COMMENT, TRANSPORT_DEFAULT_ROOTS, TRANSPORT_ROOTS, UNADDRESSABLE_REASON, type BundleInput,
} from '../transport-bundle';
import { ecLiteralText } from '../ec-parser';

// Lines in the shapes measured on BMP 5.6.17.
const TEXT_EDIT = String.raw`t.crev_qa_text.change(id := 'crev_qa_text', name := 'CREV QA Text', text := '<p>One (two), it\'s \"three\"<\/p>\n') //TextElement`;
const HIST_EDIT = String.raw`cepro.108.change(id := '108', name := 'Owner list', owners := historical(2026-10-01:list(o.111, o.112))) //CeProcedure`;
const PROP_GEN = [
  "_tmc := root.property.add(TextMethodConfig, id := 'crev_qa_note', name := 'CREV QA note')",
  '        c.get(CeProcedure.name).link(_tmc)',
  '        c.get(CeProcess.name).link(_tmc)',
].join('\n');
const PARENT_GEN = [
  "_sco := o.administration_area.add(Scorecard, id := 'crev_qa_card', name := 'Card')",
  "        _sco.add(TextElement, id := 'crev_qa_card_text', name := 'Card text')",
  "        _sco.add(TextElement, id := 'crev_qa_card_more', name := 'More')",
].join('\n');

describe('roots and days', () => {
  it('knows the roots, the default ones first', () => {
    expect(TRANSPORT_ROOTS.slice(0, TRANSPORT_DEFAULT_ROOTS.length)).toEqual(TRANSPORT_DEFAULT_ROOTS);
    expect(TRANSPORT_DEFAULT_ROOTS).toEqual(['expression', 'portal', 'property', 'templateCategory', 'externalResource', 'transformer', 'defaults', 'page', 'nodeType', 'classConfig']);
    expect(isTransportRoot('organisation')).toBe(false);
    for (const bad of ['Portal', 'portal.x', 'risk', '', 1, null]) expect(isTransportRoot(bad)).toBe(false);
  });

  it('a day is a real calendar day', () => {
    expect(isScanDay('2026-11-15')).toBe(true);
    expect(isScanDay('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '2026-1-15', '15.11.2026', '2026-11-15T00:00', '', 20261115]) expect(isScanDay(bad)).toBe(false);
  });

  it('reads the server\'s printed dates as ISO text', () => {
    expect(serverStampIso('Nov 1, 2026 10:00:00')).toBe('2026-11-01T10:00:00');
    expect(serverStampIso('Nov 12, 2026 11:59:59')).toBe('2026-11-12T11:59:59');
    expect(serverStampIso('Nov 12, 2026 1:05:09 PM')).toBe('2026-11-12T13:05:09');
    expect(serverStampIso('Nov 12, 2026 12:05:09 AM')).toBe('2026-11-12T00:05:09');
    expect(serverStampIso('2026-05-14T10:00:00.123Z')).toBe('2026-05-14T10:00:00');
    expect(serverStampIso('2026-05-14 10:00')).toBe('2026-05-14T10:00:00');
    expect(serverStampIso('2026-05-14')).toBe('2026-05-14T00:00:00');
    for (const bad of ['', 'yesterday', 'Foo 1, 2026 10:00:00', 'Feb 30, 2026 10:00:00', '2026-05-14T25:00:00', 'Nov 1, 2026 13:00:00 PM']) expect(serverStampIso(bad)).toBeUndefined();
  });

  it('new: created on or after the day', () => {
    expect(createdOnOrAfter('2026-11-15T00:00:00', '2026-11-15')).toBe(true);
    expect(createdOnOrAfter('2026-11-14T23:59:59', '2026-11-15')).toBe(false);
    expect(createdOnOrAfter(undefined, '2026-11-15')).toBe(false);
  });
});

describe('the start of a scan under an object', () => {
  it('takes an ID, its t. address or a .get form; refuses another space and what cannot be written', () => {
    expect(parseScanStart('my_module')).toEqual({ ok: true, space: 't', id: 'my_module', address: 't.my_module' });
    expect(parseScanStart('  t.my_module ')).toEqual({ ok: true, space: 't', id: 'my_module', address: 't.my_module' });
    for (const space of ['k', 'r', 'd']) expect(parseScanStart(`${space}.my_x`)).toEqual({ ok: true, space, id: 'my_x', address: `${space}.my_x` });
    expect(parseScanStart('_x9')).toMatchObject({ ok: true, id: '_x9' });
    expect(parseScanStart(`a${'b'.repeat(127)}`)).toMatchObject({ ok: true });
    expect(parseScanStart(' ')).toEqual({ ok: false, error: START_EMPTY });
    for (const other of ['o.x', 'u.x', 'T.x', 'K.x', 'root.portal', 'cepro.108']) expect(parseScanStart(other), other).toEqual({ ok: false, error: START_SPACE });
    // Any other ID: written as `t.get("…")` (a person may type it bare, with spaces and dots).
    expect(parseScanStart('108')).toEqual({ ok: true, space: 't', id: '108', address: 't.108' });
    expect(parseScanStart('my module')).toEqual({ ok: true, space: 't', id: 'my module', address: 't.get("my module")' });
    expect(parseScanStart('t.a.b')).toEqual({ ok: true, space: 't', id: 'a.b', address: 't.get("a.b")' });
    expect(parseScanStart('k.get("my-x")')).toEqual({ ok: true, space: 'k', id: 'my-x', address: 'k.get("my-x")' });
    expect(parseScanStart("t.get('it\\'s')")).toEqual({ ok: true, space: 't', id: "it's", address: 't.get("it\'s")' });
    expect(parseScanStart('x")')).toEqual({ ok: true, space: 't', id: 'x")', address: 't.get("x\\")")' });
    for (const bad of ['t.', 'a\nb', `a${'b'.repeat(128)}`]) expect(parseScanStart(bad), bad).toEqual({ ok: false, error: START_NOT_ID });
  });
});

describe('references', () => {
  it('a reference argument, a list and code in a string', () => {
    expect(argumentReferences("id := 'x', listPropertySet := t.my_lps")).toEqual(['t.my_lps']);
    expect(argumentReferences("expression := 't.a.name + k.b'")).toEqual(['k.b', 't.a']);
    expect(argumentReferences('owners := LIST(t.a, t.b), lead := u.admin, grp := g.all, unit := o.unit_a')).toEqual(['g.all', 'o.unit_a', 't.a', 't.b', 'u.admin']);
  });

  it('next to escaped quotes and after an escaped line break; not inside another name', () => {
    expect(argumentReferences(String.raw`expression := 'IF x = \'t.a\' THEN \"k.b\" ENDIF'`)).toEqual(['k.b', 't.a']);
    expect(argumentReferences(String.raw`expression := '_x := 1\nt.c.name\tk.d'`)).toEqual(['k.d', 't.c']);
    // An escaped backslash before the letter: the letter belongs to a name.
    expect(argumentReferences(String.raw`text := 'a\\nt.c'`)).toEqual([]);
    expect(argumentReferences("expression := '_t.name + root.t.x + list.k.y + at.b + x9k.z + t.1'")).toEqual([]);
  });

  it('without the object itself and repeats (any case), sorted', () => {
    expect(argumentReferences("expression := 't.b + t.A + t.B + t.self + t.a'", 't.SELF')).toEqual(['t.A', 't.b']);
    expect(referencedAddresses("\nt.self.change(id := 'self', expression := 't.self.name + t.other') //ExtendedTable\n")).toEqual(['t.other']);
    expect(referencedAddresses('not a genedit text t.x')).toEqual([]);
  });

  it('outside a set: one entry per address with who refers to it, deterministic', () => {
    const objects = [
      { address: 't.b', args: "ref := t.x, other := t.a, code := 'k.y'" },
      { address: 't.a', args: 'ref := t.x, list := LIST(t.b, t.z)' },
    ];
    const expected = [
      { address: 'k.y', by: ['t.b'] },
      { address: 't.x', by: ['t.a', 't.b'] },
      { address: 't.z', by: ['t.a'] },
    ];
    expect(outsideReferences(objects)).toEqual(expected);
    expect(outsideReferences([...objects].reverse())).toEqual(expected);
  });
});

describe('parseGenedit', () => {
  it('reads address, raw arguments and class', () => {
    expect(parseGenedit(TEXT_EDIT)).toEqual({
      address: 't.crev_qa_text',
      args: String.raw`id := 'crev_qa_text', name := 'CREV QA Text', text := '<p>One (two), it\'s \"three\"<\/p>\n'`,
      className: 'TextElement',
    });
  });

  it('a historical value with a nested list, an address in a CE space', () => {
    expect(parseGenedit(HIST_EDIT)).toEqual({
      address: 'cepro.108', args: "id := '108', name := 'Owner list', owners := historical(2026-10-01:list(o.111, o.112))", className: 'CeProcedure',
    });
  });

  it('tolerates a leading line break, a missing class and a raw line break inside a string', () => {
    expect(parseGenedit("\nt.x.change(name := 'X')")).toEqual({ address: 't.x', args: "name := 'X'" });
    expect(parseGenedit("t.x.change(text := 'a\nb)') //TextElement")).toEqual({ address: 't.x', args: "text := 'a\nb)'", className: 'TextElement' });
  });

  it('finds the real .change( and closing parenthesis, not those in strings', () => {
    expect(parseGenedit("t.x.change(text := '.change( ) //Fake', expression := \"_a := ')'\") //ExtendedTable")).toEqual({
      address: 't.x', args: "text := '.change( ) //Fake', expression := \"_a := ')'\"", className: 'ExtendedTable',
    });
  });

  it('null for other shapes', () => {
    for (const bad of ['', '   ', 't.x.add(TextElement)', 't.x.change(name := \'X\'', "t.x.change(name := 'X') extra", "t x.change(name := 'X')", ".change(name := 'X')", "t.x.change(name := 'X')) //A"]) {
      expect(parseGenedit(bad), bad).toBeNull();
    }
  });
});

describe('arguments', () => {
  it('splits at top-level commas only', () => {
    expect(splitArguments(String.raw`id := 'a,b', v := list(o.1, o.2), w := historical(2026-10-01:list(o.111, o.112)), t := 'it\'s, (x)'`)).toEqual([
      "id := 'a,b'", 'v := list(o.1, o.2)', 'w := historical(2026-10-01:list(o.111, o.112))', String.raw`t := 'it\'s, (x)'`,
    ]);
  });

  it('decodes the name for the report', () => {
    expect(nameArgument(parseGenedit(TEXT_EDIT)!.args)).toBe('CREV QA Text');
    expect(nameArgument(String.raw`id := 'x', name := 'It\'s \"A\" \\ B\nC<\/p>'`)).toBe('It\'s "A" \\ B\nC</p>');
    expect(nameArgument("id := 'x', Name := \"double\"")).toBe('double');
    expect(nameArgument("id := 'x'")).toBeUndefined();
    expect(nameArgument("id := 'x', name := lookup(t.y).name")).toBeUndefined();
    expect(argumentText("id := 'x', name := lookup(t.y).name", 'NAME')).toBe('lookup(t.y).name');
    expect(decodeEcString("'a' + 'b'")).toBeUndefined();
  });
});

describe('the create block', () => {
  it('one statement', () => {
    expect(createBlock("t.crev_qa_sandbox.add(TextElement, id := 'crev_qa_tb_folder', name := 'CREV QA tb first')")).toEqual({
      statements: ["t.crev_qa_sandbox.add(TextElement, id := 'crev_qa_tb_folder', name := 'CREV QA tb first')"], parentAddress: 't.crev_qa_sandbox', dropped: 0,
    });
  });

  it('a property with two class links keeps both links', () => {
    expect(createBlock(PROP_GEN)).toEqual({
      statements: [
        "_tmc := root.property.add(TextMethodConfig, id := 'crev_qa_note', name := 'CREV QA note')",
        'c.get(CeProcedure.name).link(_tmc)', 'c.get(CeProcess.name).link(_tmc)',
      ],
      parentAddress: 'root.property', dropped: 0,
    });
  });

  it('a parent with children: the children are dropped', () => {
    expect(createBlock(PARENT_GEN)).toEqual({
      statements: ["_sco := o.administration_area.add(Scorecard, id := 'crev_qa_card', name := 'Card')"], parentAddress: 'o.administration_area', dropped: 2,
    });
  });

  it('a link of another variable is a child line; a raw line break inside a string stays in its statement', () => {
    const text = "_a := t.p.add(TextElement, id := 'a', text := 'one\ntwo')\n_b := _a.add(TextMethodConfig, id := 'b')\nc.get(CeProcess.name).link(_b)";
    expect(createBlock(text)).toEqual({ statements: ["_a := t.p.add(TextElement, id := 'a', text := 'one\ntwo')"], parentAddress: 't.p', dropped: 2 });
    expect(splitStatements('a\r\n\r\n  b // it\'s\nc')).toEqual(['a', 'b // it\'s', 'c']);
  });

  it('empty text has no block; an odd receiver has no parent address', () => {
    expect(createBlock('')).toBeNull();
    expect(createBlock('\n  \n')).toBeNull();
    expect(createParentAddress("lookup(1).add(TextElement, id := 'x')")).toBeUndefined();
    expect(createParentAddress("x := 1")).toBeUndefined();
  });
});

describe('addresses', () => {
  it('<space>.<ID>; a numeric ID is allowed and marked', () => {
    expect(checkAddress('t.crev_qa_text')).toEqual({ ok: true, space: 't', id: 'crev_qa_text', numeric: false });
    expect(checkAddress('cepro.108')).toEqual({ ok: true, space: 'cepro', id: '108', numeric: true });
  });

  it('an ID outside letters, digits and underscore is addressed as <space>.get("<ID>")', () => {
    expect(checkAddress('t.get("my-id")')).toEqual({ ok: true, space: 't', id: 'my-id', numeric: false });
    expect(checkAddress("t.get('été')")).toEqual({ ok: true, space: 't', id: 'été', numeric: false });
    for (const bad of ['t', 't.a.b', 't.my-id', '1.x', '']) expect(checkAddress(bad).ok, bad).toBe(false);
    expect(checkAddress('t.get("a\\nb")'.replace('\\n', '\n'))).toMatchObject({ ok: false });
    expect(plainAddress(' t.x ')).toBe('t.x');
    // Written the way addressOf writes it.
    expect(plainAddress("t.get('x-y')")).toBe('t.get("x-y")');
    expect(plainAddress("t.get('x')")).toBe('t.x');
    expect(plainAddress(undefined)).toBe('');
  });

  it('parents before children, by address without regard to case; stable; a cycle changes nothing', () => {
    const items = [
      { a: 't.child2', p: 't.Parent' }, { a: 't.grand', p: 't.child1' }, { a: 't.child1', p: 't.parent' }, { a: 't.parent', p: 'o.outside' }, { a: 't.other', p: '' },
    ];
    expect(orderParentsFirst(items, i => i.a, i => i.p).map(i => i.a)).toEqual(['t.parent', 't.child2', 't.child1', 't.grand', 't.other']);
    const cycle = [{ a: 't.a', p: 't.b' }, { a: 't.b', p: 't.a' }];
    expect(orderParentsFirst(cycle, i => i.a, i => i.p).map(i => i.a)).toEqual(['t.b', 't.a']);
  });
});

// ── the bundle ──────────────────────────────────────────────────────

const obj = (rid: string, id: string, className: string, isNew: boolean, extra: Partial<BundleInput> = {}): BundleInput => ({
  rid, id, className, isNew,
  generate: `t.crev_qa_sandbox.add(${className}, id := '${id}', name := 'Name ${id}')`,
  genedit: `t.${id}.change(id := '${id}', name := 'Name ${id}') //${className}`,
  parentAddress: 't.crev_qa_sandbox', previousAddress: '', nextAddress: '',
  ...extra,
});

const NOTE = obj('9007199254740993', 'crev_qa_note', 'TextMethodConfig', true, { generate: PROP_GEN, genedit: "\nk.crev_qa_note.change(id := 'crev_qa_note', name := 'CREV QA note') //TextMethodConfig", parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY' });
const FOLDER = obj('9007199254740995', 'crev_qa_folder', 'TextElement', true, { nextAddress: 't.crev_qa_text' });
const TEXT = obj('9007199254740997', 'crev_qa_text', 'TextElement', false, { genedit: TEXT_EDIT, previousAddress: 't.crev_qa_folder' });

/** The guard line of an object, as the bundle writes it. */
const guard = (a: string, cls: string) => `IF ${a} != MISSING AND ${a}.className != '${cls}' THEN _w := _w + ' ${a} (' + str(${a}.className) + ')' ELSE "" ENDIF`;
/** A part's guard lines around the lines of its objects. */
const guarded = (...lines: string[]) => ['_w := ""', ...lines, `IF _w.size() > 0 THEN error('Other classes than expected:' + _w + '. Nothing in this part was applied.') ELSE "" ENDIF`];

/** The body of a part: its lines after the three header lines. */
const bodyOf = (text: string) => text.split('\n').slice(3, -1);

describe('Extended Code text helpers', () => {
  it('single-quoted literals escape backslash and quote, line breaks as \\n', () => {
    expect(ecSingleQuoted('plain')).toBe("'plain'");
    expect(ecSingleQuoted("it's \\ a\nb\r\nc\rd")).toBe(String.raw`'it\'s \\ a\nb\nc\nd'`);
    expect(ecSingleQuoted('"double" *?')).toBe(`'"double" *?'`);
  });

  it('trims the whitespace at the ends, not non-breaking spaces', () => {
    expect(stripLikeServer('\n t.x.change() //A \r\n')).toBe('t.x.change() //A');
    expect(stripLikeServer(' x ')).toBe(' x ');
    expect(stripLikeServer(' x\t')).toBe('x');
  });

  it('the guards: one short line per object adds it to a list, one error for all of them', () => {
    expect(identityGuardEc({ address: 't.a', className: 'ExtendedTable' })).toBe(guard('t.a', 'ExtendedTable'));
    expect(guardBlockEc([{ address: 't.a', className: 'ExtendedTable' }, { address: 'k.b', className: 'Kpi' }])).toEqual(guarded(guard('t.a', 'ExtendedTable'), guard('k.b', 'Kpi')));
    expect([GUARD_OPEN, GUARD_CLOSE]).toEqual([guarded()[0], guarded()[1]]);
    expect(guardBlockEc([])).toEqual([]);
  });

  it('the ID of an address; the address of a root by its ID', () => {
    expect(idOfAddress('t.my_x')).toBe('my_x');
    expect(idOfAddress('cepro.108')).toBe('108');
    expect(idOfAddress("t.get('x')")).toBe('x');
    expect(idOfAddress('t.get("a b")')).toBe('a b');
    for (const bad of ['', 't', 't.a.b']) expect(idOfAddress(bad), bad).toBe('');
    expect(rootAddressOf('PORTAL')).toBe('root.portal');
    expect(rootAddressOf('TEMPLATECATEGORY')).toBe('root.templateCategory');
    expect(rootAddressOf('PAGE')).toBe('root.page');
    expect(rootAddressOf('NODETYPE')).toBe('root.nodeType');
    expect(rootAddressOf('WORKFLOW')).toBe('');
  });

  it('the exact comparison: size and position, never `=` between texts', () => {
    expect(exactTextEc('t.a', '\nt.a.change(x := \'*\') //A\n', ['_ok := 1'], ['_df := 1'], '  ')).toEqual([
      '  _g := str(t.a.genedit())',
      `  _e := "t.a.change(x := '*') //A"`,
      '  IF _g.size() = _e.size() + 2 AND _g.indexOf(_e).whenMissing(-1) = 1 THEN',
      '       _ok := 1',
      '  ELSE',
      '       _df := 1',
      '  ENDIF',
    ]);
  });
});

describe('assembleBundle', () => {
  it('the parts, in order, each with its header; committed parts start with their guards', () => {
    const b = assembleBundle([TEXT, FOLDER, NOTE]);
    // No object refers to an added one: no Change again.
    expect(b.parts.map(p => [p.index, p.total, p.step, p.run])).toEqual([
      [1, 4, 'create', 'committed'], [2, 4, 'set', 'committed'], [3, 4, 'order', 'committed'], [4, 4, 'report', 'preview'],
    ]);
    for (const p of b.parts) {
      const head = p.text.split('\n').slice(0, 3);
      expect(head[0]).toMatch(new RegExp(`^// Transport scripts, part ${p.index} of 4: `));
      expect(head[2]).toMatch(/^\/\/ Run with (Execute|Preview)\. Safe to run again: /);
      expect(p.text.endsWith('\n')).toBe(true);
    }
    expect(b.parts[0].text).toBe([
      '// Transport scripts, part 1 of 4: Add',
      '// Adds the objects the target lacks, parents before children.',
      '// Run with Execute. Safe to run again: it adds only what is missing.',
      ...guarded(guard('k.crev_qa_note', 'TextMethodConfig'), guard('t.crev_qa_folder', 'TextElement')),
      'IF k.crev_qa_note = MISSING THEN',
      "     _pd := root.property.add(TextMethodConfig, id := 'crev_qa_note', name := 'CREV QA note')",
      '     c.get(CeProcedure.name).link(_pd)',
      '     c.get(CeProcess.name).link(_pd)',
      'ELSE ""',
      'ENDIF',
      'IF t.crev_qa_folder = MISSING THEN',
      "     t.crev_qa_sandbox.add(TextElement, id := 'crev_qa_folder', name := 'Name crev_qa_folder')",
      'ELSE ""',
      'ENDIF',
      '',
    ].join('\n'));
    expect([b.parts[0].statements, b.parts[0].guards]).toEqual([2, 2]);
    const guards = [guard('k.crev_qa_note', 'TextMethodConfig'), guard('t.crev_qa_folder', 'TextElement'), guard('t.crev_qa_text', 'TextElement')];
    const values = [
      "k.crev_qa_note.change(id := 'crev_qa_note', name := 'CREV QA note')",
      "t.crev_qa_folder.change(id := 'crev_qa_folder', name := 'Name crev_qa_folder')",
      String.raw`t.crev_qa_text.change(id := 'crev_qa_text', name := 'CREV QA Text', text := '<p>One (two), it\'s \"three\"<\/p>\n')`,
    ];
    // The Change part says once that links come only with the Add.
    expect(bodyOf(b.parts[1].text)).toEqual([PROPERTY_LINKS_COMMENT, ...guarded(...guards), ...values]);
    expect(bodyOf(b.parts[2].text)).toEqual([
      ...guarded(guard('t.crev_qa_folder', 'TextElement')),
      'IF t.crev_qa_folder != MISSING AND t.crev_qa_text != MISSING THEN t.crev_qa_folder.moveBefore(t.crev_qa_text) ELSE "" ENDIF',
    ]);
    expect(b.parts[3].guards).toBe(0);
    expect(b.objects).toEqual([
      { rid: NOTE.rid, address: 'k.crev_qa_note', className: 'TextMethodConfig', isNew: true, name: 'CREV QA note' },
      { rid: FOLDER.rid, address: 't.crev_qa_folder', className: 'TextElement', isNew: true, name: 'Name crev_qa_folder' },
      { rid: TEXT.rid, address: 't.crev_qa_text', className: 'TextElement', isNew: false, name: 'CREV QA Text' },
    ]);
    expect(b.notes).toBe(BUNDLE_NOTES);
    expect(b.text.startsWith(b.preamble)).toBe(true);
    for (const n of BUNDLE_NOTES) expect(b.preamble).toContain(`// ${n}`);
    expect(BUNDLE_NOTES.join(' ')).toContain('nothing of that part is stored');
    expect(BUNDLE_NOTES.join(' ')).toContain('To move objects the target already has, compare with the target instead.');
  });

  it('the report compares the whole generated text exactly and ends with the counts', () => {
    // Quotes, backslashes, an escaped and a raw line break, * and ?.
    const genedit = "\nt.crev_qa_odd.change(name := 'Say \\\"hi\\\" \\\\ *?', text := 'a\\nb\nc') //TextElement\n";
    const odd = obj('9007199254740999', 'crev_qa_odd', 'TextElement', false, { genedit });
    const report = assembleBundle([odd]).parts.at(-1)!;
    expect(report.step).toBe('report');
    expect(bodyOf(report.text)).toEqual([
      '_r := "Transport report (1 object in this part)"',
      '_ok := ""',
      '_df := ""',
      '_ms := ""',
      'IF t.crev_qa_odd = MISSING THEN',
      '     _r := _r + "\\nMISSING t.crev_qa_odd"',
      '     _ms := _ms + "."',
      'ELSE',
      '     _g := str(t.crev_qa_odd.genedit())',
      // The literal of the trimmed source text: backslash, double quote and
      // the raw line break escaped.
      '     _e := "t.crev_qa_odd.change(name := \'Say \\\\\\"hi\\\\\\" \\\\\\\\ *?\', text := \'a\\\\nb\\nc\') //TextElement"',
      '     IF _g.size() = _e.size() + 2 AND _g.indexOf(_e).whenMissing(-1) = 1 THEN',
      '          _r := _r + "\\nok t.crev_qa_odd"',
      '          _ok := _ok + "."',
      '     ELSE',
      '          _r := _r + "\\nDIFFERENT t.crev_qa_odd"',
      '          _df := _df + "."',
      '     ENDIF',
      'ENDIF',
      '_r := _r + "\\n" + str(_ok.size()) + " ok, " + str(_df.size()) + " different, " + str(_ms.size()) + " missing"',
      '_r',
    ]);
    // The literal decodes back to the trimmed source text.
    const literal = bodyOf(report.text).find(l => l.startsWith('     _e := '))!.slice('     _e := '.length);
    expect(ecLiteralText(literal)).toBe(genedit.trim());
    expect(report.text).not.toMatch(/_s = "|_e = "|= _e\b(?!\.)/);
  });

  it('no new object: no Create, no Set values again and no Order part', () => {
    const b = assembleBundle([TEXT]);
    expect(b.parts.map(p => p.step)).toEqual(['set', 'report']);
    expect(b.parts.map(p => p.text.split('\n')[0])).toEqual(['// Transport scripts, part 1 of 2: Change', '// Transport scripts, part 2 of 2: Report']);
    expect(assembleBundle([]).parts).toEqual([]);
  });

  it('Change again: new objects that refer to one added with or after them, and the others that refer to a new one', () => {
    const user = obj('9007199254741101', 'crev_qa_user', 'InputView', false, { genedit: "t.crev_qa_user.change(id := 'crev_qa_user', code := 'k.crev_qa_kpi.value') //InputView" });
    const kpi = obj('9007199254741103', 'crev_qa_kpi', 'TextElement', true, { genedit: "k.crev_qa_kpi.change(id := 'crev_qa_kpi') //TextElement" });
    const other = obj('9007199254741105', 'crev_qa_other', 'TextElement', false, { genedit: "t.crev_qa_other.change(id := 'crev_qa_other', ref := t.crev_qa_elsewhere) //TextElement" });
    // A cycle of two new objects: the one added first refers to the later one.
    const a = obj('9007199254741107', 'crev_qa_a', 'TextElement', true, { genedit: "t.crev_qa_a.change(id := 'crev_qa_a', ref := t.crev_qa_b) //TextElement" });
    const b = obj('9007199254741109', 'crev_qa_b', 'TextElement', true, { genedit: "t.crev_qa_b.change(id := 'crev_qa_b', ref := t.crev_qa_a) //TextElement" });
    // A new object that refers to a new one: that one is added first.
    const c = obj('9007199254741111', 'crev_qa_c', 'TextElement', true, { genedit: "t.crev_qa_c.change(id := 'crev_qa_c', ref := t.crev_qa_d) //TextElement" });
    const d = obj('9007199254741113', 'crev_qa_d', 'TextElement', true, { genedit: "t.crev_qa_d.change(id := 'crev_qa_d') //TextElement" });
    const bundle = assembleBundle([user, kpi, other, a, b, c, d]);
    const create = bundle.parts.find(p => p.step === 'create')!.text;
    expect(create.indexOf('IF t.crev_qa_d = MISSING')).toBeLessThan(create.indexOf('IF t.crev_qa_c = MISSING'));
    const again = bundle.parts.find(p => p.step === 'setAgain')!;
    expect(bodyOf(again.text).slice(again.guards + 2)).toEqual([
      "t.crev_qa_a.change(id := 'crev_qa_a', ref := t.crev_qa_b)",
      "t.crev_qa_user.change(id := 'crev_qa_user', code := 'k.crev_qa_kpi.value')",
    ]);
    expect(again.text).toContain('// Changes again the added objects that use one added after them');
    // The bundle changes every object, whatever the target has.
    expect(bundle.parts.filter(p => p.step === 'set').reduce((n, p) => n + p.statements, 0)).toBe(7);
  });

  it('a new object whose parent could not be read is left out with that reason; its generate text plays no part', () => {
    const b = assembleBundle([
      obj('9007199254741107', 'crev_qa_gone', 'TextElement', true, { parentAddress: '' }),
      obj('9007199254741109', 'crev_qa_old', 'TextElement', false, { generate: undefined, parentAddress: '' }),
    ]);
    expect(b.leftOut).toMatchObject([{ id: 'crev_qa_gone', reason: 'unreadable', detail: NO_PARENT_DETAIL }]);
    expect(b.objects.map(o => o.address)).toEqual(['t.crev_qa_old']);
  });

  it('creates parents before children, each from its values', () => {
    const card = obj('9007199254741011', 'crev_qa_card', 'Scorecard', true, { generate: PARENT_GEN, genedit: "o.crev_qa_card.change(id := 'crev_qa_card', name := 'Card') //Scorecard", parentAddress: 'o.administration_area' });
    const child = obj('9007199254741013', 'crev_qa_card_text', 'TextElement', true, {
      genedit: "t.crev_qa_card_text.change(id := 'crev_qa_card_text', name := 'Card text') //TextElement", parentAddress: 'o.crev_qa_card',
    });
    // The child's address sorts before its parent's.
    const create = assembleBundle([child, card]).parts[0].text;
    expect(create.indexOf('IF o.crev_qa_card = MISSING')).toBeLessThan(create.indexOf('IF t.crev_qa_card_text = MISSING'));
    expect(create).toContain("     o.administration_area.add(Scorecard, id := 'crev_qa_card', name := 'Card')");
    expect(create).toContain("     o.crev_qa_card.add(TextElement, id := 'crev_qa_card_text', name := 'Card text')");
    // Nothing of the parent's generate text (its children) is used.
    expect(create).not.toContain('_sco');
  });

  it('new siblings next to each other are put back in order', () => {
    const a = obj('9007199254741021', 'crev_qa_a', 'TextElement', true, { previousAddress: '', nextAddress: 't.crev_qa_b' });
    const b = obj('9007199254741023', 'crev_qa_b', 'TextElement', true, { previousAddress: 't.crev_qa_a', nextAddress: 't.crev_qa_old' });
    const c = obj('9007199254741025', 'crev_qa_c', 'TextElement', true, { previousAddress: 't.crev_qa_old', nextAddress: '' });
    const lone = obj('9007199254741027', 'crev_qa_lone', 'TextElement', true, { parentAddress: 't.crev_qa_new_parent' });
    const order = bodyOf(assembleBundle([b, c, a, lone]).parts.find(p => p.step === 'order')!.text);
    expect(order).toEqual([
      // Three of one class: one loop over their IDs.
      '_w := ""',
      'list("crev_qa_b", "crev_qa_a", "crev_qa_c").forEach(_x:',
      '     _o := t.get(_x)',
      '     IF _o != MISSING AND _o.className != \'TextElement\' THEN _w := _w + " " + "t." + _x + " (" + str(_o.className) + ")" ELSE "" ENDIF',
      ')',
      guarded()[1],
      'IF t.crev_qa_b != MISSING AND t.crev_qa_old != MISSING THEN t.crev_qa_b.moveBefore(t.crev_qa_old) ELSE "" ENDIF',
      'IF t.crev_qa_a != MISSING AND t.crev_qa_b != MISSING THEN t.crev_qa_a.moveBefore(t.crev_qa_b) ELSE "" ENDIF',
      'IF t.crev_qa_c != MISSING AND t.crev_qa_old != MISSING THEN t.crev_qa_c.moveAfter(t.crev_qa_old) ELSE "" ENDIF',
    ]);
  });

  it('a new object whose neighbours could not be read: a warning that its place is not restored', () => {
    const lost = obj('9007199254741029', 'crev_qa_lost', 'TextElement', true, { neighboursError: 'Timed out' });
    const kept = obj('9007199254741031', 'crev_qa_kept', 'TextElement', false, { neighboursError: 'Timed out' });
    const b = assembleBundle([lost, kept]);
    expect(b.warnings.filter(w => w.kind === 'no-order')).toEqual([{ kind: 'no-order', rid: lost.rid, address: 't.crev_qa_lost', detail: 't.crev_qa_lost: its parent and siblings could not be read, so its place among its siblings is not restored.' }]);
    expect(b.preamble).toContain('//   t.crev_qa_lost: its parent and siblings could not be read');
  });

  it('leaves objects out with their reason; a numeric ID is a warning only; an object without generate text is added from its values', () => {
    const b = assembleBundle([
      obj('9007199254741033', 'my-id', 'TextElement', true, { genedit: "t.get('my-id').change(name := 'X') //TextElement" }),
      obj('9007199254741035', 'crev_qa_map', 'ObjectProfileMapping', false, { generate: '', genedit: '' }),
      obj('9007199254741037', 'crev_qa_view', 'WebTableView', true, { generate: '' }),
      obj('9007199254741039', 'crev_qa_fail', 'TextElement', false, { readError: 'Timed out' }),
      obj('9007199254741041', 'crev_qa_odd', 'TextElement', false, { genedit: 'something else' }),
      obj('9007199254741043', '108', 'CeProcedure', false, { genedit: HIST_EDIT }),
      obj('9007199254741045', 'crev_qa_dash', 'TextElement', false, { genedit: "t.crev-qa.change(name := 'X') //TextElement", id: 'crev_qa_dash' }),
    ]);
    expect(b.leftOut.map(o => [o.id, o.reason])).toEqual([
      ['crev_qa_dash', 'unaddressable'],
      ['crev_qa_fail', 'unreadable'],
      ['crev_qa_map', 'no-text'],
      ['crev_qa_odd', 'unreadable'],
    ]);
    expect(b.leftOut.find(o => o.id === 'crev_qa_fail')!.detail).toBe('Its text could not be read: Timed out.');
    // An ID of other characters is addressed with .get("…").
    expect(b.objects.map(o => o.address)).toEqual(['cepro.108', 't.crev_qa_view', 't.get("my-id")']);
    expect(b.parts.find(p => p.step === 'create')!.text).toContain("t.crev_qa_sandbox.add(WebTableView, id := 'crev_qa_view', name := 'Name crev_qa_view')");
    expect(b.warnings.filter(w => w.kind === 'numeric-id')).toEqual([{ kind: 'numeric-id', rid: '9007199254741043', address: 'cepro.108', detail: 'cepro.108: its ID is a number, which may name another object on the target.' }]);
    expect(b.preamble).toContain('// Left out (4):');
    expect(UNADDRESSABLE_REASON).toBe('Its ID has a character that cannot be written into a script.');
    expect(b.preamble).toContain('//   t.crev-qa (TextElement): Its address is not of the form <space>.<ID>, so it cannot be addressed.');
    expect(b.preamble).toContain('// Warnings:\n//   cepro.108: its ID is a number');
    expect(b.parts.find(p => p.step === 'set')!.text).toContain("cepro.108.change(id := '108', name := 'Owner list', owners := historical(2026-10-01:list(o.111, o.112)))");
  });

  it('one object per address and per RID', () => {
    const b = assembleBundle([TEXT, { ...TEXT, rid: '9007199254740998' }, TEXT]);
    expect(b.objects.map(o => o.rid)).toEqual([TEXT.rid]);
    expect(b.leftOut).toMatchObject([{ rid: '9007199254740998', detail: 'Another object in this transport has the same address.' }]);
  });

  it('parts stay within the limit, cut only between statements; a guard is in the part of its object\'s statement', () => {
    const many = Array.from({ length: 300 }, (_, i) => obj(String(9007199254742000n + BigInt(i)), `crev_qa_n${String(i).padStart(3, '0')}`, 'TextElement', true, {
      // Each refers to itself, so each is changed again.
      genedit: `t.crev_qa_n${String(i).padStart(3, '0')}.change(name := 'N${i}', ref := t.crev_qa_n${String(i).padStart(3, '0')}, text := '${'x'.repeat(200)}') //TextElement`,
    }));
    const b = assembleBundle(many, { partLimit: 6_000 });
    const steps = b.parts.map(p => p.step);
    for (const step of ['create', 'set', 'setAgain', 'report'] as const) expect(steps.filter(s => s === step).length, step).toBeGreaterThan(1);
    for (const p of b.parts) {
      expect(p.text.length).toBeLessThanOrEqual(6_000);
      expect(p.oversize).toBeUndefined();
      expect(p.text.split('\n')[0]).toBe(`// Transport scripts, part ${p.index} of ${b.parts.length}: ${{ create: 'Add', set: 'Change', link: 'Link', own: 'Change per class', setAgain: 'Change (uses added objects)', order: 'Move', report: 'Report' }[p.step]} (${p.stepIndex} of ${p.stepTotal})`);
    }
    // Every statement is whole in exactly one part of its step, after the
    // guards of exactly the objects it addresses.
    const afterGuards = (lines: string[]) => lines.indexOf(GUARD_CLOSE) + 1;
    for (const p of b.parts.filter(x => x.run === 'committed')) {
      const lines = bodyOf(p.text);
      expect(lines[0]).toBe(GUARD_OPEN);
      const end = afterGuards(lines);
      expect(end).toBeGreaterThan(1);
      const guards = lines.slice(1, end - 1);
      expect(lines.slice(end).some(l => / THEN (error\(|_w := )/.test(l))).toBe(false);
      // One line per object, or one loop over the IDs of a class (three or more).
      const guardedAt = guards.flatMap(l => {
        const single = /^IF (\S+) != MISSING/.exec(l);
        if (single) return [single[1]];
        const loop = /^list\((.*)\)\.forEach\(_x:$/.exec(l);
        return loop ? [...loop[1].matchAll(/"([^"]*)"/g)].map(m => `t.${m[1]}`) : [];
      });
      expect(guardedAt).toHaveLength(p.guards);
      const addressed = [...new Set(lines.slice(end).map(l => /^(?:IF )?(t\.crev_qa_n\d{3})/.exec(l)?.[1]).filter(Boolean))];
      expect([...guardedAt].sort()).toEqual([...addressed].sort());
    }
    const setLines = b.parts.filter(p => p.step === 'set').flatMap(p => { const l = bodyOf(p.text); return l.slice(afterGuards(l)); });
    expect(setLines).toHaveLength(300);
    expect(setLines.every(l => l.startsWith('t.crev_qa_n') && l.endsWith("')"))).toBe(true);
    for (const p of b.parts.filter(x => x.step === 'create')) {
      const all = bodyOf(p.text);
      const lines = all.slice(afterGuards(all));
      expect(lines[0]).toMatch(/^IF \S+ = MISSING THEN$/);
      expect(lines.at(-1)).toBe('ENDIF');
    }
    // Every report part builds its own string and ends with its counts.
    for (const p of b.parts.filter(x => x.step === 'report')) {
      const lines = bodyOf(p.text);
      expect(lines[0]).toMatch(/^_r := "Transport report \(\d+ objects in this part\)"$/);
      expect(lines.at(-2)).toMatch(/ missing"$/);
      expect(lines.at(-1)).toBe('_r');
    }
    expect(b.parts.filter(p => p.step === 'report').reduce((n, p) => n + Number(/\((\d+) objects/.exec(p.text)![1]), 0)).toBe(300);
    expect(BUNDLE_PART_LIMIT).toBe(20_000);
  });

  it('a statement longer than the limit is a part of its own, flagged', () => {
    const big = obj('9007199254743001', 'crev_qa_big', 'ExtendedTable', false, { genedit: `t.crev_qa_big.change(expression := '${'y'.repeat(25_000)}') //ExtendedTable` });
    const small = obj('9007199254743003', 'crev_qa_small', 'TextElement', false);
    const b = assembleBundle([big, small]);
    const set = b.parts.filter(p => p.step === 'set');
    expect(set.map(p => p.statements)).toEqual([1, 1]);
    expect(set.map(p => p.guards)).toEqual([1, 1]);
    expect(set[0].oversize).toBe(true);
    expect(set[0].text).toContain('// This part is longer than 20,000 characters: one statement is that long.');
    expect(set[0].text).toContain(guard('t.crev_qa_big', 'ExtendedTable'));
    expect(set[1].oversize).toBeUndefined();
    expect(set[1].text.length).toBeLessThanOrEqual(BUNDLE_PART_LIMIT);
    expect(b.warnings.filter(w => w.kind === 'oversize').map(w => w.part)).toEqual(b.parts.filter(p => p.oversize).map(p => p.index));
    // Set values and the report with its literal (it is not new: no Set values again).
    expect(b.warnings.filter(w => w.kind === 'oversize')).toHaveLength(2);
  });

  it('deterministic: the same objects give the same text in any order', () => {
    const inputs = [NOTE, FOLDER, TEXT, obj('9007199254741043', '108', 'CeProcedure', false, { genedit: HIST_EDIT }), obj('9007199254741031', 'crev_qa_plain', 'TextElement', false)];
    const a = assembleBundle(inputs);
    expect(assembleBundle([...inputs].reverse())).toEqual(a);
    expect(assembleBundle([inputs[2], inputs[4], inputs[0], inputs[3], inputs[1]]).text).toBe(a.text);
    expect(assembleBundle(inputs).text).toBe(a.text);
  });

  it('warns once per address the objects refer to that is not in the bundle', () => {
    const page = obj('9007199254741051', 'crev_qa_page', 'Scorecard', true, { genedit: "t.crev_qa_page.change(id := 'crev_qa_page', listPropertySet := t.crev_qa_lps, expression := 't.crev_qa_view.name') //Scorecard" });
    const view = obj('9007199254741053', 'crev_qa_view', 'InputView', true, { genedit: "t.crev_qa_view.change(id := 'crev_qa_view', listPropertySet := t.crev_qa_lps, owner := k.crev_qa_kpi) //InputView" });
    const b = assembleBundle([page, view]);
    expect(b.warnings.filter(w => /crev_qa_(kpi|lps)$/.test(w.address ?? ''))).toEqual([
      { kind: 'outside-reference', address: 'k.crev_qa_kpi', detail: 'k.crev_qa_kpi is used by t.crev_qa_view but is not in this transport; it must exist on the target.' },
      { kind: 'outside-reference', address: 't.crev_qa_lps', detail: 't.crev_qa_lps is used by t.crev_qa_page (and 1 more) but is not in this transport; it must exist on the target.' },
    ]);
    expect(b.preamble).toContain('//   k.crev_qa_kpi is used by t.crev_qa_view but is not in this transport; it must exist on the target.\n//   t.crev_qa_lps is used by');
    // The parent of the objects to add is said apart.
    expect(b.warnings.filter(w => w.kind === 'outside-parent')).toEqual([{
      kind: 'outside-parent', address: 't.crev_qa_sandbox', by: ['t.crev_qa_page', 't.crev_qa_view'],
      detail: 't.crev_qa_sandbox is the parent of t.crev_qa_page (and 1 more) but is not in this transport; it must exist on the target.',
    }]);
  });

  it('the preamble lists at most a few outside references, then how many more', () => {
    const refs = Array.from({ length: PREAMBLE_REFERENCES_SHOWN + 3 }, (_, i) => `r${String(i).padStart(2, '0')} := t.crev_qa_out${String(i).padStart(2, '0')}`).join(', ');
    const many = obj('9007199254741055', 'crev_qa_many', 'TextElement', false, { genedit: `t.crev_qa_many.change(${refs}) //TextElement` });
    const lone = obj('9007199254741057', 'crev_qa_lone', 'TextElement', true, { neighboursError: 'Timed out' });
    const b = assembleBundle([many, lone]);
    expect(b.warnings.filter(w => w.kind === 'outside-reference' && /crev_qa_out/.test(w.address ?? ''))).toHaveLength(PREAMBLE_REFERENCES_SHOWN + 3);
    const lines = b.preamble.split('\n');
    const at = lines.indexOf('// Warnings:');
    // Other warnings first (the parent of the new object among them), the references last.
    expect(lines[at + 1]).toMatch(/^\/\/ {3}t\.crev_qa_lone: its parent and siblings/);
    expect(lines[at + 2]).toMatch(/^\/\/ {3}t\.crev_qa_sandbox is the parent of t\.crev_qa_lone/);
    expect(lines.slice(at + 3, at + 3 + PREAMBLE_REFERENCES_SHOWN).every(l => / is used by t\.crev_qa_many but/.test(l))).toBe(true);
    expect(lines[at + 3 + PREAMBLE_REFERENCES_SHOWN]).toBe('//   … and 3 more');
    expect(b.preamble).not.toContain('crev_qa_out12');
  });

  it('comment lines hold no line break from a class name or a reason', () => {
    const b = assembleBundle([obj('9007199254741039', 'crev_qa_fail', 'Text\nElement', false, { readError: 'line one\nline two' })]);
    expect(b.preamble).toContain('//   crev_qa_fail (Text Element): Its text could not be read: line one line two.');
    for (const line of b.preamble.split('\n').filter(Boolean)) expect(line.startsWith('//')).toBe(true);
  });
});

describe('a parent outside the bundle', () => {
  it('is a warning of its own when the object is to be added', () => {
    const b = assembleBundle([{
      rid: '9007199254749001', id: 'cc_child', name: 'Child', className: 'TextElement', isNew: true,
      generate: "t.cc_outside.add(TextElement, id := 'cc_child', name := 'Child')",
      genedit: "t.cc_child.change(id := 'cc_child', name := 'Child') //TextElement",
      parentAddress: 't.cc_outside',
    }]);
    expect(b.warnings.filter(w => w.kind === 'outside-reference')).toEqual([]);
    expect(b.warnings.filter(w => w.kind === 'outside-parent')).toEqual([{
      kind: 'outside-parent', address: 't.cc_outside', by: ['t.cc_child'], detail: 't.cc_outside is the parent of t.cc_child but is not in this transport; it must exist on the target.',
    }]);
  });
});

describe('one write per object', () => {
  it('the arguments of a create statement after its class', () => {
    expect(createArgumentPieces("t.page.add(TextElement, id := 'x', name := 'a, (b)')")).toEqual(["id := 'x'", "name := 'a, (b)'"]);
    expect(createArgumentPieces("_tmc := root.property.add(TextMethodConfig, id := 'n')")).toEqual(["id := 'n'"]);
    for (const bad of ["t.page.add('x', id := 'x')", 't.page.change(id := 1)', "t.page.add(TextElement, id := 'x') + 1", "t.page.add(TextElement, id := 'x'"]) {
      expect(createArgumentPieces(bad), bad).toBeUndefined();
    }
    expect(argumentPairs(["id := 'x'", 'ref:=t.y'])).toEqual([{ name: 'id', value: "'x'" }, { name: 'ref', value: 't.y' }]);
    expect(argumentPairs(['TextElement'])).toBeNull();
  });

  it('a create statement sets the genedit values only when names and value texts are the same, in any order', () => {
    const add = "t.page.add(TextElement, id := 'x', name := 'N', text := 'a\nb')";
    expect(createSetsValues(add, "id := 'x', name := 'N', text := 'a\nb'")).toBe(true);
    expect(createSetsValues(add, "text := 'a\nb', id := 'x', name := 'N'")).toBe(true);
    expect(createSetsValues(add, "id := 'x', name := 'N'")).toBe(false);
    expect(createSetsValues(add, "id := 'x', name := 'M', text := 'a\nb'")).toBe(false);
    expect(createSetsValues(add, "id := 'x', Name := 'N', text := 'a\nb'")).toBe(false);
    expect(createSetsValues(add, "id := 'x', name := 'N', name := 'N'")).toBe(false);
    expect(createSetsValues("t.page.add(TextElement, id := 'x', id := 'x')", "id := 'x', id := 'x'")).toBe(false);
    expect(createSetsValues('t.page.add(TextElement)', '')).toBe(true);
    expect(createSetsValues('something else', '')).toBe(false);
  });

  type Item = { a: string; parent?: string; args: string };
  const order = (items: Item[]) => orderForAdd(items, i => i.a, i => i.parent, i => i.args).map(i => i.a);

  it('adds parents first and, where that allows, what is referred to before what refers to it', () => {
    expect(order([{ a: 't.a', args: 'ref := t.c' }, { a: 't.b', args: '' }, { a: 't.c', args: '' }])).toEqual(['t.b', 't.c', 't.a']);
    // A child that refers to its parent, and a parent that refers to its child: parents first.
    expect(order([{ a: 't.p', args: 'ref := t.q' }, { a: 't.q', parent: 't.p', args: 'ref := t.p' }])).toEqual(['t.p', 't.q']);
    // Referred to, through its parent: the parent and it come first.
    expect(order([{ a: 't.a', args: 'x := t.z' }, { a: 't.y', args: '' }, { a: 't.z', parent: 't.y', args: '' }])).toEqual(['t.y', 't.z', 't.a']);
    // A cycle: the first of the parents-first order goes first, the rest follow.
    expect(order([{ a: 't.a', args: 'ref := t.b' }, { a: 't.b', args: 'ref := t.a' }])).toEqual(['t.a', 't.b']);
    // Nothing to follow: the parents-first order.
    expect(order([{ a: 't.c', parent: 't.b', args: '' }, { a: 't.a', args: '' }, { a: 't.b', args: '' }]))
      .toEqual(orderParentsFirst([{ a: 't.c', parent: 't.b' }, { a: 't.a' }, { a: 't.b' }], i => i.a, i => i.parent).map(i => i.a));
  });

  it('those that refer to one added with or after them', () => {
    const items: Item[] = [{ a: 't.a', args: 'ref := t.b' }, { a: 't.b', args: 'ref := t.a' }, { a: 't.c', args: 'ref := t.c' }, { a: 't.d', args: 'ref := t.a, other := t.elsewhere' }];
    expect([...refersToLaterAdded(items, i => i.a, i => i.args)].map(i => i.a)).toEqual(['t.a', 't.c']);
  });
});

describe('linked copies and templates in scripts without comparison', () => {
  it('a linked copy is never added, only changed; objects under Templates get one warning', () => {
    const copy = obj('9007199254741101', 'crev_qa_copy', 'TextElement', true, { linkedTo: 'crev_qa_tpl' });
    const tpl = obj('9007199254741102', 'crev_qa_tpl', 'TextElement', true, { template: true });
    const b = assembleBundle([copy, tpl]);
    const adds = b.parts.filter(p => p.step === 'create').map(p => p.text).join('\n');
    expect(adds).not.toContain("id := 'crev_qa_copy'");
    expect(adds).toContain("id := 'crev_qa_tpl'");
    expect(b.parts.filter(p => p.step === 'set').map(p => p.text).join('\n')).toContain('t.crev_qa_copy.change(');
    expect(b.objects.find(o => o.rid === copy.rid)?.isNew).toBe(false);
    expect(b.warnings.filter(w => w.kind === 'template')).toEqual([{ kind: 'template', detail: '1 object is a template. These scripts change every value of it on the target, and each value written walks every linked copy. Compare with the target instead where you can.' }]);
    expect(b.preamble).toContain('1 object is a template.');
  });
});
