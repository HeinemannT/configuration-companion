/**
 * Transport (beta), the patch: the probe script, the parse of a pasted
 * answer, the patch's outcomes, values and parts, and the transport log
 * helpers.
 */
import { describe, expect, it } from 'vitest';
import { ecLiteralText } from '../ec-parser';
import { ecSingleQuoted, splitAddress, type BundleInput } from '../transport-bundle';
import {
  assemblePatch, buildProbe, LISTING_CAP, parseProbeAnswer, propertyDefinitionRids, PATCH_NOTES, PROBE_MARKER, PROBE_VERSION, TRANSPORT_LOG_ID, TRANSPORT_SUMMARY_LIMIT, transportEntryId,
  transportSummary, type ProbeAnswer, type TransportProbe,
} from '../transport-patch';

let ridSeq = 9007199254750000n;
/** An object in the shapes measured: genedit with a leading and a trailing line break. */
const o = (id: string, cls: string, args: string, extra: Partial<BundleInput> = {}): BundleInput => ({
  rid: String(ridSeq++), id, className: cls, isNew: false,
  generate: `t.cc_folder.add(${cls}, id := '${id}', name := 'Name ${id}')`,
  genedit: `\nt.${id}.change(${args}) //${cls}\n`,
  parentAddress: 't.cc_folder', previousAddress: '', nextAddress: '',
  ...extra,
});
const gen = (id: string, cls: string, args: string) => `\nt.${id}.change(${args}) //${cls}\n`;

/** What the target holds per address: class, text, its parent's ID
 *  (default `cc_folder`) and its siblings' IDs (default none). */
type Target = Record<string, { cls: string; genedit?: string; parent?: string; prev?: string; next?: string; generate?: string; modified?: string } | undefined>;

/** When an object last changed on the target, as the comparison reads it. */
const DATE = 'Nov 16, 2026 20:17:30';

/** `<size>:<text>`. */
const framed = (s = '') => `${s.length}:${s}`;

/** The answer a target would print for `probe`, part by part, as a script
 *  window shows it (`Result : ` before, `Duration : …` after). */
function answerOf(probe: TransportProbe, target: Target, opts: { key?: string; parts?: number[]; listing?: string; types?: string } = {}): string[] {
  const k = opts.key ?? probe.key;
  return probe.parts.filter(p => !opts.parts || opts.parts.includes(p.index)).map(part => {
    let s = `${PROBE_MARKER} v${PROBE_VERSION} part ${part.index}/${part.total} key ${k}`;
    if (opts.types != null) s += `\nY ${framed(opts.types)}`;
    for (const e of probe.entries.filter(x => x.part === part.index)) {
      const t = target[e.address];
      const a = framed(e.address);
      if (!t) s += `\nM ${a}`;
      else if (e.kind === 'object') {
        // The place line as the part's loop prints it, then the object with its text and date.
        const at = splitAddress(e.address)!;
        s += `\nP ${at.space} ${framed(at.id)} ${framed(t.parent ?? 'cc_folder')} ${framed(t.prev)} ${framed(t.next)}`;
        s += `\nO ${a} ${t.cls} ${framed(t.genedit)} ${framed(t.modified ?? DATE)}${e.links ? `\nL ${a} ${framed(t.generate)}` : ''}`;
      } else s += `\nE ${a} ${t.cls} ${framed(t.parent ?? 'cc_folder')}`;
    }
    if (part.step === 'listing') s += opts.listing ?? '\nK 0';
    return `Result : ${s}\n${PROBE_MARKER} end part ${part.index}/${part.total} key ${k}\nDuration : 3ms\n`;
  });
}

const parsed = (probe: TransportProbe, target: Target): ProbeAnswer => {
  const r = parseProbeAnswer(answerOf(probe, target).join('\n'), probe);
  if (!r.ok) throw new Error(r.error);
  return r.answer;
};

// One object to create (not new on the source), one to change (a value
// set, one changed, one cleared), one the same, one of another class on
// the target.
const NEW = o('cc_new', 'TextElement', "id := 'cc_new', name := 'New one', text := 'Hello'", { previousAddress: 't.cc_same', nextAddress: 't.cc_old' });
const CHANGE = o('cc_change', 'ExtendedTable', "id := 'cc_change', name := 'New name', expression := '1 + 1', text := 'added'");
const SAME = o('cc_same', 'TextElement', "id := 'cc_same', name := 'Same'");
const CLASH = o('cc_clash', 'TextElement', "id := 'cc_clash', name := 'Clash'");
const INPUTS = [NEW, CHANGE, SAME, CLASH];
const TARGET: Target = {
  't.cc_change': { cls: 'ExtendedTable', genedit: gen('cc_change', 'ExtendedTable', "id := 'cc_change', name := 'Old name', expression := '1 + 1', description := 'old'") },
  't.cc_same': { cls: 'TextElement', genedit: SAME.genedit },
  't.cc_clash': { cls: 'ExtendedTable', genedit: gen('cc_clash', 'ExtendedTable', "id := 'cc_clash', name := 'Clash'") },
  't.cc_folder': { cls: 'Category' },
};

const bodyOf = (text: string) => text.split('\n').slice(3, -1);
/** A part's statements: its body after the guard lines. */
const statementsOf = (part: { text: string; guards: number }) => {
  const lines = bodyOf(part.text);
  // After the guard block (one line per object, or a loop per class).
  return part.guards ? lines.slice(lines.findIndex(l => l.startsWith('IF _w.size() > 0')) + 1) : lines;
};
/** The guard line of an object and the lines around a part's guards. */
const guard = (a: string, cls: string) => `IF ${a} != MISSING AND ${a}.className != '${cls}' THEN _w := _w + ' ${a} (' + str(${a}.className) + ')' ELSE "" ENDIF`;
const guarded = (...lines: string[]) => ['_w := ""', ...lines, `IF _w.size() > 0 THEN error('Other classes than expected:' + _w + '. Nothing in this part was applied.') ELSE "" ENDIF`];

describe('buildProbe', () => {
  it('asks for the objects with class and text, and for parents and siblings whether they exist; roots are not probed', () => {
    const note = o('cc_note', 'TextMethodConfig', "id := 'cc_note'", {
      generate: "_tmc := root.property.add(TextMethodConfig, id := 'cc_note', name := 'Note')\n        c.get(CeProcess.name).link(_tmc)", parentAddress: '',
    });
    const child = o('cc_child', 'TextElement', "id := 'cc_child'", { generate: "t.cc_note_parent.add(TextElement, id := 'cc_child')", parentAddress: 't.cc_page', previousAddress: 't.cc_prev', nextAddress: 't.cc_note' });
    const skipped = o('cc_skip', 'TextElement', "id := 'cc_skip'", { readError: 'Timed out', parentAddress: 't.cc_not_probed' });
    const probe = buildProbe([child, note, skipped]);
    // The probe is the same whether creation text was read or not: the
    // create statement's receiver is not asked about.
    expect(probe.entries).toEqual([
      { address: 't.cc_child', kind: 'object', part: 1 },
      { address: 't.cc_note', kind: 'object', part: 1 },
      { address: 't.cc_page', kind: 'exists', part: 1 },
      { address: 't.cc_prev', kind: 'exists', part: 1 },
    ]);
    expect(buildProbe([{ ...child, generate: undefined }, { ...note, generate: undefined }, skipped]).text).toBe(probe.text);
    expect(probe.leftOut.map(x => x.id)).toEqual(['cc_skip']);
    expect(probe.total).toBe(1);
    expect(probe.key).toMatch(/^[0-9a-f]{8}$/);
    const [part] = probe.parts;
    expect([part.step, part.run, part.guards]).toEqual(['probe', 'preview', 0]);
    expect(part.text.split('\n').slice(0, 3)).toEqual([
      '// Comparison script, part 1 of 1: Compare',
      '// Reads what the target holds for the objects of this transport. Changes nothing.',
      '// Run with Preview on the target, then copy the whole answer back.',
    ]);
    const body = bodyOf(part.text);
    // The places of both objects first, in one loop over their IDs, before any
    // genedit() (it adds a temporary sibling).
    const head = body.indexOf(`_r := "#cc-compare v9 part 1/1 key ${probe.key}" + _pl`);
    expect(PROBE_VERSION).toBe(9);
    expect(body.slice(0, head)).toEqual([
      '_pl := ""',
      'list("cc_child", "cc_note").forEach(_x:',
      '     _o := t.get(_x)',
      '     IF _o != MISSING THEN',
      '          _q := ""',
      '          _v := ""',
      '          _n := ""',
      '          _p := _o.parent',
      '          IF _p != MISSING THEN',
      '               _q := str(_p.id)',
      '               _i := _o.sortIndex',
      '               _c := _p.children.filter(sortIndex < _i)',
      '               IF _c.size() > 0 THEN',
      '                    _v := str(_c.last().id)',
      '               ELSE ""',
      '               ENDIF',
      '               _c := _p.children.filter(sortIndex > _i)',
      '               IF _c.size() > 0 THEN',
      '                    _n := str(_c.first().id)',
      '               ELSE ""',
      '               ENDIF',
      '          ELSE ""',
      '          ENDIF',
      '          _pl := _pl + ("\\nP t " + str(_x.size()) + ":" + _x + " " + str(_q.size()) + ":" + _q + " " + str(_v.size()) + ":" + _v + " " + str(_n.size()) + ":" + _n)',
      '     ELSE ""',
      '     ENDIF',
      ')',
    ]);
    expect(body.slice(0, head).join('\n')).not.toMatch(/genedit|generate|sortIndex [=]/);
    expect(body.at(-1)).toBe(`_r + "\\n#cc-compare end part 1/1 key ${probe.key}"`);
    // The types switched off on the target, once per part.
    expect(body.slice(head + 1, head + 3)).toEqual([
      '_ty := str(root.toggleableStateMap.whenMissing(""))',
      '_r := _r + ("\\nY " + str(_ty.size()) + ":" + _ty)',
    ]);
    // Each address framed by its size; the text and the date it last changed.
    expect(body.slice(head + 3, head + 10)).toEqual([
      'IF t.cc_child = MISSING THEN',
      '     _r := _r + "\\nM 10:t.cc_child"',
      'ELSE',
      '     _g := str(t.cc_child.genedit())',
      '     _d := str(t.cc_child.lastModifiedDate.whenMissing(""))',
      '     _r := _r + ("\\nO 10:t.cc_child " + str(t.cc_child.className) + " " + str(_g.size()) + ":" + _g + " " + str(_d.size()) + ":" + _d)',
      'ENDIF',
    ]);
    expect(body.slice(head + 17, head + 28)).toEqual([
      'IF t.cc_page = MISSING THEN',
      '     _r := _r + "\\nM 9:t.cc_page"',
      'ELSE',
      '     _q := ""',
      '     _p := t.cc_page.parent',
      '     IF _p != MISSING THEN',
      '          _q := str(_p.id)',
      '     ELSE ""',
      '     ENDIF',
      '     _r := _r + ("\\nE 9:t.cc_page " + str(t.cc_page.className) + " " + str(_q.size()) + ":" + _q)',
      'ENDIF',
    ]);
    expect(part.text).not.toContain('root.property');
    expect(part.text).not.toContain('cc_not_probed');
    expect(probe.text.startsWith(probe.preamble)).toBe(true);
    expect(probe.preamble).toContain(`(key ${probe.key})`);
  });

  it('the key follows the set of addresses, not their order; parts follow the limit', () => {
    expect(buildProbe([...INPUTS].reverse())).toEqual(buildProbe(INPUTS));
    expect(buildProbe(INPUTS.slice(1)).key).not.toBe(buildProbe(INPUTS).key);
    const many = Array.from({ length: 60 }, (_, i) => o(`cc_m${String(i).padStart(2, '0')}`, 'TextElement', "name := 'x'"));
    const probe = buildProbe(many, { partLimit: 3_000 });
    expect(probe.parts.length).toBeGreaterThan(2);
    for (const p of probe.parts) {
      expect(p.text.length).toBeLessThanOrEqual(3_000);
      expect(p.text).toContain(`_r := "#cc-compare v9 part ${p.index}/${probe.parts.length} key ${probe.key}"`);
      expect(p.text).toContain(`#cc-compare end part ${p.index}/${probe.parts.length} key ${probe.key}"`);
    }
    expect(new Set(probe.entries.map(e => e.part)).size).toBe(probe.parts.length);
  });
});

describe('the probe and references', () => {
  it('asks whether the addresses the values refer to exist; they are part of the key', () => {
    const view = o('cc_view', 'InputView', "id := 'cc_view', listPropertySet := t.cc_lps, expression := 't.cc_view.name + k.cc_kpi + t.cc_same'");
    const probe = buildProbe([view, SAME]);
    expect(probe.entries.map(e => [e.address, e.kind])).toEqual([
      ['t.cc_same', 'object'], ['t.cc_view', 'object'], ['k.cc_kpi', 'exists'], ['t.cc_folder', 'exists'], ['t.cc_lps', 'exists'],
    ]);
    const plain = o('cc_view', 'InputView', "id := 'cc_view'");
    expect(buildProbe([plain, SAME]).key).not.toBe(probe.key);
  });
});

describe('parseProbeAnswer', () => {
  const tricky = gen('cc_change', 'ExtendedTable', String.raw`id := 'cc_change', expression := 'x\n#cc-compare end part 1/1 key 00000000\nM t.cc_same\n'`)
    + `\n${PROBE_MARKER} end part 1/1 key 0\nM t.cc_same\n`;

  it('reads every state by its declared size, with CR LF, noise around and a text holding the markers', () => {
    const probe = buildProbe(INPUTS);
    const target = { ...TARGET, 't.cc_change': { cls: 'ExtendedTable', genedit: tricky } };
    const text = ['Some header\r\n', ...answerOf(probe, target)].join('\n').replace(/\n/g, '\r\n');
    const r = parseProbeAnswer(text, probe);
    expect(r).toEqual({
      ok: true,
      answer: {
        key: probe.key,
        states: {
          't.cc_change': { state: 'present', className: 'ExtendedTable', genedit: tricky, modified: DATE, parentId: 'cc_folder', previousId: '', nextId: '' },
          't.cc_clash': { state: 'present', className: 'ExtendedTable', genedit: TARGET['t.cc_clash']!.genedit, modified: DATE, parentId: 'cc_folder', previousId: '', nextId: '' },
          't.cc_new': { state: 'missing' },
          't.cc_same': { state: 'present', className: 'TextElement', genedit: SAME.genedit, modified: DATE, parentId: 'cc_folder', previousId: '', nextId: '' },
          't.cc_folder': { state: 'present', className: 'Category', parentId: 'cc_folder' },
          't.cc_old': { state: 'missing' },
        },
      },
    });
  });

  it('parts in any order, other text between them; the probe script pasted along is passed over', () => {
    const many = Array.from({ length: 30 }, (_, i) => o(`cc_m${String(i).padStart(2, '0')}`, 'TextElement', "name := 'x'"));
    const probe = buildProbe(many, { partLimit: 2_500 });
    expect(probe.total).toBeGreaterThan(2);
    const answers = answerOf(probe, Object.fromEntries(many.map(m => [`t.${m.id}`, { cls: 'TextElement', genedit: m.genedit }])));
    const pasted = [probe.parts[0].text, ...answers.reverse().map(a => `${a}\nsomething in between\n`)].join('');
    const r = parseProbeAnswer(pasted, probe);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.answer.states)).toHaveLength(31);
  });

  it('errors: nothing found, another key, a part missing, cut off, an address not answered', () => {
    const many = Array.from({ length: 30 }, (_, i) => o(`cc_m${String(i).padStart(2, '0')}`, 'TextElement', "name := 'x'"));
    const probe = buildProbe(many, { partLimit: 2_500 });
    const target = Object.fromEntries(many.map(m => [`t.${m.id}`, { cls: 'TextElement', genedit: m.genedit }]));
    const all = answerOf(probe, target);
    expect(parseProbeAnswer('Result : 42', probe)).toMatchObject({ ok: false, kind: 'not-found' });
    expect(parseProbeAnswer(answerOf(probe, target, { key: '0badc0de' }).join('\n'), probe)).toMatchObject({ ok: false, kind: 'wrong-key', error: expect.stringContaining('another comparison') });
    // An answer of the first probe version is refused as such.
    expect(parseProbeAnswer(all.join('\n').replace(/#cc-compare v9/g, '#cc-compare v2'), probe)).toMatchObject({ ok: false, kind: 'wrong-version' });
    expect(parseProbeAnswer([all[0], ...all.slice(2)].join('\n'), probe)).toEqual({ ok: false, kind: 'missing-part', part: 2, error: `Part 2 of ${probe.total} is missing.` });
    const cut = all.join('\n');
    expect(parseProbeAnswer(cut.slice(0, cut.length - 40), probe)).toMatchObject({ ok: false, kind: 'incomplete', error: 'The answer is incomplete: copy all of it.' });
    // A size larger than what follows: cut off inside a text.
    const one = buildProbe([SAME]);
    const a = answerOf(one, { 't.cc_same': { cls: 'TextElement', genedit: SAME.genedit } })[0];
    expect(parseProbeAnswer(a.replace(/TextElement \d+:/, 'TextElement 999:'), one)).toMatchObject({ ok: false, kind: 'incomplete' });
    // A part that leaves out one of its addresses.
    const dropped = a.replace(/\nE 11:t\.cc_folder Category \d+:\w*|\nM 11:t\.cc_folder/, '');
    expect(parseProbeAnswer(dropped, one)).toEqual({ ok: false, kind: 'unanswered', address: 't.cc_folder', error: 'The answer says nothing about t.cc_folder. Run the comparison script again and copy all of it.' });
  });
});

describe('assemblePatch: one write per object', () => {
  /** An object whose create statement sets exactly its genedit values. */
  const added = (id: string, args: string) => o(id, 'TextElement', args, { generate: `t.cc_folder.add(TextElement, ${args})` });
  const A = added('cc_a', "id := 'cc_a', name := 'A', ref := t.cc_b");
  const B = added('cc_b', "id := 'cc_b', name := 'B'");
  const C = added('cc_c', "id := 'cc_c', ref := t.cc_c");
  const D = o('cc_d', 'TextElement', "id := 'cc_d', name := 'D', text := 'more than its Add'");
  const E = o('cc_e', 'TextElement', "id := 'cc_e', ref := t.cc_b");
  const inputs = [A, B, C, D, E];
  const target: Target = { 't.cc_folder': { cls: 'Category' }, 't.cc_e': { cls: 'TextElement', genedit: gen('cc_e', 'TextElement', "id := 'cc_e'") } };
  const steps = (p: ReturnType<typeof assemblePatch>, step: string) => p.parts.filter(x => x.step === step).flatMap(statementsOf);

  it('an added object whose Add sets all its values is not changed; what it refers to is added first', () => {
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), target));
    expect(patch.review.map(r => [r.address, r.outcome])).toEqual([['t.cc_a', 'create'], ['t.cc_b', 'create'], ['t.cc_c', 'create'], ['t.cc_d', 'create'], ['t.cc_e', 'change']]);
    const adds = steps(patch, 'create').filter(l => l.startsWith('IF ')).map(l => /^IF (\S+) =/.exec(l)![1]);
    expect(adds).toEqual(['t.cc_b', 't.cc_a', 't.cc_c', 't.cc_d']);
    // Every Add is made from the genedit arguments: D needs no Change either.
    expect(steps(patch, 'set')).toEqual([
      't.cc_e.change(ref := t.cc_b)',
    ]);
    // Again: A refers to B added in the same Add part, C to itself, E's changed value to B.
    expect(steps(patch, 'setAgain')).toEqual([
      "t.cc_a.change(id := 'cc_a', name := 'A', ref := t.cc_b)",
      "t.cc_c.change(id := 'cc_c', ref := t.cc_c)",
      't.cc_e.change(ref := t.cc_b)',
    ]);
    expect(patch.parts.find(p => p.step === 'set')!.text).toContain('// Changes the values that differ on objects the target has, and the values of added objects that their Add does not give.');
  });

  it('an object referred to that is added in an earlier Add part resolves: no Change again for it', () => {
    const two = [A, B];
    const patch = assemblePatch(two, parsed(buildProbe(two), target), { partLimit: 700 });
    expect(patch.parts.filter(p => p.step === 'create')).toHaveLength(2);
    expect(patch.parts.find(p => p.step === 'set')).toBeUndefined();
    expect(patch.parts.find(p => p.step === 'setAgain')).toBeUndefined();
  });
});

describe('assemblePatch', () => {
  it('one outcome per object: create, change, same; a class mismatch is left out', () => {
    const probe = buildProbe(INPUTS);
    const patch = assemblePatch(INPUTS, parsed(probe, TARGET));
    expect(patch.review.map(r => [r.address, r.outcome])).toEqual([['t.cc_change', 'change'], ['t.cc_new', 'create'], ['t.cc_same', 'same']]);
    expect(patch.leftOut).toEqual([{ rid: CLASH.rid, id: 'cc_clash', className: 'TextElement', address: 't.cc_clash', reason: 'class-mismatch', detail: 'On the target t.cc_clash is of class ExtendedTable.' }]);
    expect(patch.counts).toEqual({ create: 1, change: 1, move: 0, same: 1, rename: 0, delete: 0, targetOnly: 0, leftOut: 1 });
    expect(patch.key).toBe(probe.key);
    expect(patch.nothingToDo).toBe(false);
    expect(patch.parts.map(p => [p.step, p.run])).toEqual([
      ['check', 'preview'], ['create', 'committed'], ['set', 'committed'], ['order', 'committed'], ['report', 'preview'],
    ]);
    expect(patch.parts[0].text.split('\n')[0]).toBe('// Transport scripts, part 1 of 5: Check');
    expect(patch.notes).toBe(PATCH_NOTES);
    expect(patch.text).not.toContain('t.cc_clash.change(');
  });

  it('change: one change line with the set and changed values, one clear per value only the target has; the review lists every value', () => {
    const patch = assemblePatch(INPUTS, parsed(buildProbe(INPUTS), TARGET));
    expect(patch.review[0].values).toEqual([
      { name: 'id', target: "'cc_change'", source: "'cc_change'", action: 'same' },
      { name: 'name', target: "'Old name'", source: "'New name'", action: 'change' },
      { name: 'expression', target: "'1 + 1'", source: "'1 + 1'", action: 'same' },
      { name: 'text', source: "'added'", action: 'set' },
      { name: 'description', target: "'old'", action: 'clear' },
    ]);
    const set = patch.parts.find(p => p.step === 'set')!;
    expect(statementsOf(set)).toEqual([
      "t.cc_change.change(name := 'New name', text := 'added')",
      't.cc_change.clear(description)',
    ]);
    expect(set.statements).toBe(1);
    // Its Add sets all its values, so the added object is not changed after
    // it; nothing refers to an added object: no Change again.
    expect(patch.parts.find(p => p.step === 'setAgain')).toBeUndefined();
    expect(patch.review[1].values.map(v => v.action)).toEqual(['set', 'set', 'set']);
    expect(patch.review[2].values.every(v => v.action === 'same')).toBe(true);
  });

  it('warns for each address the objects refer to that the target lacks and the patch does not carry', () => {
    const view = o('cc_view', 'InputView', "id := 'cc_view', listPropertySet := t.cc_lps, owner := k.cc_kpi, expression := 't.cc_new.name'");
    const page = o('cc_page', 'Scorecard', "id := 'cc_page', listPropertySet := t.cc_lps, other := t.cc_here");
    const inputs = [view, page, NEW];
    const target: Target = { 't.cc_folder': { cls: 'Category' }, 't.cc_same': { cls: 'TextElement' }, 't.cc_old': { cls: 'TextElement' }, 't.cc_here': { cls: 'Category' } };
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), target));
    // k.cc_kpi and t.cc_lps are missing; t.cc_here is there; t.cc_new is created by the patch.
    expect(patch.warnings.filter(w => w.kind === 'outside-reference')).toEqual([
      { kind: 'outside-reference', address: 'k.cc_kpi', detail: 'k.cc_kpi is missing on the target and used by t.cc_view.' },
      { kind: 'outside-reference', address: 't.cc_lps', detail: 't.cc_lps is missing on the target and used by t.cc_page (and 1 more).' },
    ]);
    expect(patch.preamble).toContain('//   t.cc_lps is missing on the target and used by t.cc_page (and 1 more).');
    // The Check part does not check them again.
    expect(patch.parts.find(p => p.step === 'check')!.text).not.toMatch(/cc_lps|cc_kpi|cc_here/);
    // All present: no warning.
    const all = assemblePatch(inputs, parsed(buildProbe(inputs), { ...target, 't.cc_lps': { cls: 'ListPropertySet' }, 'k.cc_kpi': { cls: 'Kpi' } }));
    expect(all.warnings.filter(w => w.kind === 'outside-reference')).toEqual([]);
  });

  it('clearExtra off: values only the target has are kept and said so', () => {
    const patch = assemblePatch(INPUTS, parsed(buildProbe(INPUTS), TARGET), { clearExtra: false });
    expect(patch.review[0].values.at(-1)).toEqual({ name: 'description', target: "'old'", action: 'keep' });
    expect(patch.text).not.toContain('.clear(');
    expect(patch.warnings).toContainEqual({ kind: 'kept-values', rid: CHANGE.rid, address: 't.cc_change', detail: 't.cc_change: values only the target has are kept, so the report shows it as DIFFERENT.' });
  });

  it('the id is never cleared; names match without regard to case', () => {
    const x = o('cc_x', 'TextElement', "name := 'B'");
    const probe = buildProbe([x]);
    const patch = assemblePatch([x], parsed(probe, { 't.cc_x': { cls: 'TextElement', genedit: gen('cc_x', 'TextElement', "id := 'cc_x', Name := 'A'") }, 't.cc_folder': { cls: 'Category' } }));
    expect(patch.review[0].values).toEqual([
      { name: 'name', target: "'A'", source: "'B'", action: 'change' },
      { name: 'id', target: "'cc_x'", action: 'keep' },
    ]);
    expect(patch.warnings.filter(w => w.kind === 'kept-values')).toEqual([]);
  });

  it('a target text of an unexpected form: the whole line is set, nothing cleared', () => {
    const x = o('cc_x', 'TextElement', "name := 'B'");
    const patch = assemblePatch([x], parsed(buildProbe([x]), { 't.cc_x': { cls: 'TextElement', genedit: 'not a change line' }, 't.cc_folder': { cls: 'Category' } }));
    expect(patch.review[0]).toMatchObject({ outcome: 'change', wholeLine: true });
    expect(patch.text).toContain("t.cc_x.change(name := 'B')");
    expect(patch.warnings.map(w => w.kind)).toContain('whole-line');
  });

  it('the Check part: texts still the probed ones, missing still missing, parents and anchors still there', () => {
    const patch = assemblePatch(INPUTS, parsed(buildProbe(INPUTS), TARGET));
    const check = patch.parts[0];
    const body = bodyOf(check.text);
    expect(body.slice(0, 3)).toEqual(['_r := "Transport check (4 checks in this part)"', '_ok := ""', '_dv := ""']);
    // The objects the target has: in one loop, by the size of their text and
    // the date they last changed as the comparison read them; no text.
    const loop = body.find(l => l.startsWith('_e := "|'))!;
    expect(ecLiteralText(loop.slice('_e := '.length))).toBe(`|cc_change=${TARGET['t.cc_change']!.genedit!.length}=${DATE}|cc_same=${TARGET['t.cc_same']!.genedit!.length}=${DATE}|`);
    expect(check.text).toContain('list("cc_change", "cc_same").forEach(_x:');
    expect(check.text).toContain('_k := "|" + _x + "=" + str(_g.size()) + "=" + str(_o.lastModifiedDate.whenMissing("")) + "|"');
    expect(check.text).toContain('_r := _r + "\\nCHANGED since the comparison " + "t." + _x');
    expect(check.text).not.toContain(`'Old name'`);
    expect(body).toContain('IF t.cc_new != MISSING THEN');
    expect(check.text).toContain('_r := _r + "\\nEXISTS now t.cc_new"');
    // The parent of the created object; its anchor t.cc_same is a patch object, checked in the loop.
    expect(body).toContain('IF t.cc_folder = MISSING THEN');
    expect(body.slice(-6)).toEqual([
      'IF _dv.size() = 0 THEN',
      '     _r := _r + "\\nReady: nothing changed since the comparison. Continue with the next part."',
      'ELSE',
      '     _r := _r + "\\nStop: the target changed since the comparison. Do not run the next parts; compare again."',
      'ENDIF',
      '_r',
    ]);
    // Nothing but reads.
    expect(body.join('\n')).not.toMatch(/\.change\(|\.add\(|\.clear\(|\.move/);
  });

  it('creates an object that is missing on the target, new or not, guarded; the report compares with the source text', () => {
    const patch = assemblePatch(INPUTS, parsed(buildProbe(INPUTS), TARGET));
    const create = patch.parts.find(p => p.step === 'create')!;
    expect(bodyOf(create.text)).toEqual([
      ...guarded(guard('t.cc_new', 'TextElement')),
      'IF t.cc_new = MISSING THEN',
      "     t.cc_folder.add(TextElement, id := 'cc_new', name := 'New one', text := 'Hello')",
      'ELSE ""',
      'ENDIF',
    ]);
    expect(NEW.isNew).toBe(false);
    const report = patch.parts.at(-1)!;
    expect(report.step).toBe('report');
    // Only what the scripts add or change; cc_same gets no line.
    expect(report.text).toContain('_r := "Transport report (2 objects in this part)"');
    expect(report.text).not.toContain('cc_same');
    const literal = bodyOf(report.text).find(l => l.startsWith('     _e := ') && l.includes('cc_change'))!;
    expect(ecLiteralText(literal.slice('     _e := '.length))).toBe(CHANGE.genedit!.trim());
  });

  it('order: only with anchors on the target or created by the patch', () => {
    const a = o('cc_a', 'TextElement', "name := 'A'", { previousAddress: 't.cc_gone', nextAddress: 't.cc_b' });
    const b = o('cc_b', 'TextElement', "name := 'B'", { previousAddress: 't.cc_a', nextAddress: 't.cc_there' });
    const c = o('cc_c', 'TextElement', "name := 'C'", { previousAddress: 't.cc_gone', nextAddress: 't.cc_gone_too' });
    const inputs = [a, b, c];
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), { 't.cc_folder': { cls: 'Category' }, 't.cc_there': { cls: 'TextElement' } }));
    const order = patch.parts.find(p => p.step === 'order')!;
    expect(statementsOf(order)).toEqual([
      // No previous sibling on the target: right to left, each before its next one.
      'IF t.cc_b != MISSING AND t.cc_there != MISSING THEN t.cc_b.moveBefore(t.cc_there) ELSE "" ENDIF',
      'IF t.cc_a != MISSING AND t.cc_b != MISSING THEN t.cc_a.moveBefore(t.cc_b) ELSE "" ENDIF',
    ]);
    expect(patch.text).not.toContain('t.cc_gone');
    // The anchor on the target is checked.
    expect(patch.parts[0].text).toContain('IF t.cc_there = MISSING THEN');
  });

  it('a parent neither on the target nor created: left out, and its children in turn', () => {
    const orphan = o('cc_orphan', 'TextElement', "name := 'O'", { generate: "t.cc_gone.add(TextElement, id := 'cc_orphan')", parentAddress: 't.cc_gone' });
    const child = o('cc_orphan_child', 'TextElement', "name := 'C'", { generate: "t.cc_orphan.add(TextElement, id := 'cc_orphan_child')", parentAddress: 't.cc_orphan' });
    const under = o('cc_under', 'TextElement', "name := 'U'", { generate: "t.cc_new.add(TextElement, id := 'cc_under')", parentAddress: 't.cc_new' });
    const inputs = [orphan, child, under, NEW];
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), { 't.cc_folder': { cls: 'Category' } }));
    expect(patch.leftOut.map(x => [x.id, x.reason, x.detail])).toEqual([
      ['cc_orphan', 'parent-missing', 'Its parent t.cc_gone is neither on the target nor added with this transport.'],
      ['cc_orphan_child', 'parent-missing', 'Its parent t.cc_orphan is neither on the target nor added with this transport.'],
    ]);
    // A child of an object the patch creates is created after it.
    const create = patch.parts.find(p => p.step === 'create')!.text;
    expect(create.indexOf('IF t.cc_new = MISSING')).toBeLessThan(create.indexOf('IF t.cc_under = MISSING'));
  });

  it('an object to add whose type is switched off on the target is left out; the types are read once per part, the first kept', () => {
    const kpi = o('cc_kpi', 'CeProduct', "id := 'cc_kpi', name := 'K'", { generate: '' });
    const ok = o('cc_ok', 'CePolicy', "id := 'cc_ok', name := 'P'", { generate: '' });
    const there = o('cc_there', 'CeProduct', "id := 'cc_there', name := 'T'");
    const inputs = [kpi, ok, there];
    const probe = buildProbe(inputs, { partLimit: 900 });
    expect(probe.total).toBeGreaterThan(1);
    const types = 'CePolicy;true&CeProduct;false&CeRisk;true';
    const target: Target = { 't.cc_folder': { cls: 'Category' }, 't.cc_there': { cls: 'CeProduct', genedit: gen('cc_there', 'CeProduct', "id := 'cc_there', name := 'Old'") } };
    const r = parseProbeAnswer(answerOf(probe, target, { types }).join('\n'), probe);
    if (!r.ok) throw new Error(r.error);
    expect(r.answer.types).toBe(types);
    const patch = assemblePatch(inputs, r.answer, { targetName: 'Demo TEST' });
    expect(patch.leftOut.map(x => [x.id, x.reason, x.detail])).toEqual([['cc_kpi', 'type-off', 'Its type CeProduct is switched off on Demo TEST.']]);
    expect(patch.typesOff).toEqual([{ rid: kpi.rid, address: 't.cc_kpi', className: 'CeProduct' }]);
    // Only adds: an object of that type the target has is still changed.
    expect(patch.review.find(x => x.address === 't.cc_there')!.outcome).toBe('change');
    expect(patch.parts.find(p => p.step === 'create')!.text).not.toContain('cc_kpi');
    // Without the line, nothing is switched off.
    expect(assemblePatch(inputs, parsed(probe, target)).typesOff).toEqual([]);
  });

  it('a missing object is added from its values, generate text or not; without a parent it is left out', () => {
    const x = o('cc_x', 'WebTableView', "id := 'cc_x', name := 'X'", { generate: '' });
    const patch = assemblePatch([x], parsed(buildProbe([x]), { 't.cc_folder': { cls: 'Category' } }));
    expect(patch.leftOut).toEqual([]);
    expect(patch.parts.find(p => p.step === 'create')!.text).toContain("     t.cc_folder.add(WebTableView, id := 'cc_x', name := 'X')");
    const y = o('cc_y', 'TextElement', "id := 'cc_y'", { parentAddress: '' });
    const none = assemblePatch([y], parsed(buildProbe([y]), {}));
    expect(none.leftOut).toMatchObject([{ reason: 'unreadable', detail: 'Its parent could not be read, so it cannot be added.' }]);
    expect(none.nothingToDo).toBe(true);
  });

  it('nothing to do: no scripts, and the preamble says so', () => {
    const probe = buildProbe([SAME]);
    const patch = assemblePatch([SAME], parsed(probe, TARGET), { record: { entryId: 'cc_tr_20261115_2130_abcdef', title: 'T' } });
    expect(patch.parts).toEqual([]);
    expect(patch.nothingToDo).toBe(true);
    expect(patch.preamble).toContain('// Nothing to do: the target already holds every object as it is here.');
    expect(patch.review).toMatchObject([{ outcome: 'same' }]);
  });

  it('refuses a probe answer of another set of objects', () => {
    const answer = parsed(buildProbe([SAME]), TARGET);
    expect(() => assemblePatch(INPUTS, answer)).toThrow(/another set of objects/);
  });

  it('the Record part: the log folder held in a variable, the entry added once, all text single-quoted', () => {
    const probe = buildProbe(INPUTS);
    const entryId = transportEntryId(new Date(Date.UTC(2026, 10, 15, 21, 30)), probe.key);
    const patch = assemblePatch(INPUTS, parsed(probe, TARGET), { record: { entryId, title: "Release 'Q4'\nfinal", summary: 'Line one\nit\'s \\ done' } });
    const record = patch.parts.find(p => p.step === 'record')!;
    expect(patch.parts.map(p => p.step)).toEqual(['check', 'create', 'set', 'order', 'record', 'report']);
    expect(record.run).toBe('committed');
    expect(bodyOf(record.text)).toEqual([
      ...guarded(guard(`t.${TRANSPORT_LOG_ID}`, 'Category'), guard(`t.${entryId}`, 'Category')),
      '_l := t.cc_transport_log',
      'IF _l = MISSING THEN',
      "     _l := root.portal.add(Category, id := 'cc_transport_log', name := 'Transport log')",
      'ELSE ""',
      'ENDIF',
      `IF t.${entryId} = MISSING THEN`,
      `     _l.add(Category, id := '${entryId}', name := ${ecSingleQuoted("Release 'Q4' final")}, description := ${ecSingleQuoted('Line one\nit\'s \\ done')})`,
      'ELSE ""',
      'ENDIF',
    ]);
    expect(record.text).toContain(String.raw`description := 'Line one\nit\'s \\ done'`);
    expect(() => assemblePatch(INPUTS, parsed(probe, TARGET), { record: { entryId: 'bad id', title: 'T' } })).toThrow(/Not a transport log entry ID/);
    // Without a summary: the patch's own.
    const own = assemblePatch(INPUTS, parsed(probe, TARGET), { record: { entryId, title: 'T' } });
    expect(own.parts.find(p => p.step === 'record')!.text).toContain(ecSingleQuoted(transportSummary(own)));
  });

  it('deterministic: the same inputs and probe give the same text in any order', () => {
    const answer = parsed(buildProbe(INPUTS), TARGET);
    const a = assemblePatch(INPUTS, answer);
    expect(assemblePatch([...INPUTS].reverse(), answer)).toEqual(a);
    expect(assemblePatch([INPUTS[2], INPUTS[0], INPUTS[3], INPUTS[1]], answer).text).toBe(a.text);
  });

  it('a created object whose neighbours could not be read: a warning that its place is not restored', () => {
    const lost = o('cc_lost', 'TextElement', "name := 'L'", { neighboursError: 'Timed out' });
    const patch = assemblePatch([lost], parsed(buildProbe([lost]), { 't.cc_folder': { cls: 'Category' } }));
    expect(patch.warnings).toContainEqual(expect.objectContaining({ kind: 'no-order', address: 't.cc_lost' }));
  });
});

describe('the probe answer of version 2', () => {
  it('reads the places of objects and the parents of other addresses by size; an ID may hold spaces and markers', () => {
    // (Version 8: the places in P lines, the addresses framed.)
    const x = o('cc_x', 'TextElement', "name := 'X'", { previousAddress: 't.cc_p', nextAddress: '' });
    const probe = buildProbe([x]);
    const odd = 'odd id 3:\nM t.cc_x';
    const r = parseProbeAnswer(answerOf(probe, {
      't.cc_x': { cls: 'TextElement', genedit: x.genedit, parent: odd, prev: 'cc_p', next: '' },
      't.cc_folder': { cls: 'Category', parent: 'PORTAL' },
      't.cc_p': { cls: 'TextElement', parent: 'cc_folder' },
    }).join('\n').replace(/\n/g, '\r\n'), probe);
    expect(r).toEqual({
      ok: true,
      answer: {
        key: probe.key,
        states: {
          't.cc_x': { state: 'present', className: 'TextElement', genedit: x.genedit, modified: DATE, parentId: odd, previousId: 'cc_p', nextId: '' },
          't.cc_folder': { state: 'present', className: 'Category', parentId: 'PORTAL' },
          't.cc_p': { state: 'present', className: 'TextElement', parentId: 'cc_folder' },
        },
      },
    });
    // An object entry without its place is cut off.
    const a = answerOf(probe, { 't.cc_x': { cls: 'TextElement', genedit: x.genedit }, 't.cc_folder': { cls: 'Category' }, 't.cc_p': { cls: 'TextElement' } })[0];
    expect(parseProbeAnswer(a.replace(/ 9:cc_folder 0: 0:/, ''), probe)).toMatchObject({ ok: false, kind: 'incomplete' });
  });
});

describe('places in the patch', () => {
  /** An object whose read place is given by its siblings' addresses. */
  const at = (id: string, prev: string, next: string, extra: Partial<BundleInput> = {}) => o(id, 'TextElement', `id := '${id}', name := '${id}'`, {
    previousAddress: prev ? `t.${prev}` : '', nextAddress: next ? `t.${next}` : '', parentId: 'cc_folder', ...extra,
  });
  /** The target as the source holds it: every object with its text and place. */
  const mirror = (inputs: readonly BundleInput[], others: Target = {}): Target => ({
    ...Object.fromEntries(inputs.map(i => [`t.${i.id}`, {
      cls: i.className, genedit: i.genedit, parent: i.parentId, prev: (i.previousAddress ?? '').replace(/^t\./, ''), next: (i.nextAddress ?? '').replace(/^t\./, ''),
    }])),
    ...others,
  });
  const orderOf = (patch: ReturnType<typeof assemblePatch>) => {
    const part = patch.parts.find(p => p.step === 'order');
    return part ? statementsOf(part) : [];
  };

  it('a workspace compared with itself gives no moves', () => {
    // A folder under the shared web root; under it a first child, children
    // after a sibling that is not in the transport (and a gap in sortIndex
    // between them on the source, which the probe does not see), a last child.
    const folder = o('cc_folder', 'Category', "id := 'cc_folder', name := 'F'", { parentAddress: '', parentId: 'PORTAL', parentIsRoot: true, previousAddress: 't.cc_top', nextAddress: '' });
    const first = at('cc_first', '', 'cc_kept');
    const after = at('cc_after', 'cc_kept', 'cc_last');
    const last = at('cc_last', 'cc_after', '');
    const inputs = [folder, first, after, last];
    const probe = buildProbe(inputs);
    expect(probe.entries.map(e => e.address)).toEqual(['t.cc_after', 't.cc_first', 't.cc_folder', 't.cc_last', 't.cc_kept', 't.cc_top']);
    const target = mirror(inputs, { 't.cc_kept': { cls: 'TextElement', parent: 'cc_folder' }, 't.cc_top': { cls: 'Category', parent: 'PORTAL' } });
    const patch = assemblePatch(inputs, parsed(probe, target));
    expect(patch.text).not.toMatch(/\.move(After|Before)?\(/);
    expect(patch.review.every(r => r.outcome === 'same' && !r.place)).toBe(true);
    expect(patch.counts).toEqual({ create: 0, change: 0, move: 0, same: 4, rename: 0, delete: 0, targetOnly: 0, leftOut: 0 });
    expect(patch.nothingToDo).toBe(true);
    expect(patch.parts).toEqual([]);
  });

  it('under another parent on the target: moved to its parent here, then placed; moves come first, parents first', () => {
    const box = o('cc_box', 'Category', "id := 'cc_box'", { parentAddress: 't.cc_folder', parentId: 'cc_folder', previousAddress: 't.cc_first', nextAddress: '' });
    const inner = o('cc_inner', 'TextElement', "id := 'cc_inner'", { parentAddress: 't.cc_box', parentId: 'cc_box' });
    const first = at('cc_first', '', 'cc_box');
    const inputs = [box, inner, first];
    const target = mirror(inputs, { 't.cc_folder': { cls: 'Category', parent: 'PORTAL' } });
    target['t.cc_box'] = { ...target['t.cc_box']!, parent: 'cc_old', prev: '' };
    target['t.cc_inner'] = { ...target['t.cc_inner']!, parent: 'CC_OLD_TOO' };
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), target));
    expect(orderOf(patch)).toEqual([
      'IF t.cc_box != MISSING AND t.cc_folder != MISSING THEN t.cc_box.move(t.cc_folder) ELSE "" ENDIF',
      'IF t.cc_inner != MISSING AND t.cc_box != MISSING THEN t.cc_inner.move(t.cc_box) ELSE "" ENDIF',
      'IF t.cc_box != MISSING AND t.cc_first != MISSING THEN t.cc_box.moveAfter(t.cc_first) ELSE "" ENDIF',
    ]);
    const order = patch.parts.find(p => p.step === 'order')!;
    expect(bodyOf(order.text).slice(0, order.guards + 2)).toEqual(guarded(guard('t.cc_box', 'Category'), guard('t.cc_inner', 'TextElement')));
    expect(patch.review.map(r => [r.address, r.outcome, r.place?.labels])).toEqual([
      ['t.cc_box', 'move', ['moved from cc_old to t.cc_folder', 'moved after t.cc_first']],
      ['t.cc_first', 'same', undefined],
      ['t.cc_inner', 'move', ['moved from CC_OLD_TOO to t.cc_box']],
    ]);
    expect(patch.review[0].place).toEqual({ from: 'cc_old', to: 't.cc_folder', method: 'moveAfter', anchor: 't.cc_first', labels: ['moved from cc_old to t.cc_folder', 'moved after t.cc_first'] });
    expect(patch.counts).toMatchObject({ change: 0, move: 2, same: 1 });
    expect(patch.nothingToDo).toBe(false);
    expect(patch.preamble).toContain('0 to change, 2 to move, 1 the same');
    expect(transportSummary(patch)).toContain('Added 0, changed 0, moved 2, deleted 0, ID changed 0, the same 1, left out 0.\nMoved:\nt.cc_box (moved from cc_old to t.cc_folder, moved after t.cc_first)\nt.cc_inner (moved from CC_OLD_TOO to t.cc_box)');
    // The Check part checks the parent moved to that the patch does not carry.
    expect(patch.parts[0].text).toContain('IF t.cc_folder = MISSING THEN');
    // IDs compare without regard to case: the same parent in other case is no move.
    target['t.cc_box'] = { ...target['t.cc_box']!, parent: 'CC_FOLDER' };
    target['t.cc_inner'] = { ...target['t.cc_inner']!, parent: 'cc_BOX' };
    expect(orderOf(assemblePatch(inputs, parsed(buildProbe(inputs), target)))).toEqual([
      'IF t.cc_box != MISSING AND t.cc_first != MISSING THEN t.cc_box.moveAfter(t.cc_first) ELSE "" ENDIF',
    ]);
  });

  it('a root parent: moved to root.<name>; a root the patch does not know: left where it is, with a warning', () => {
    const top = o('cc_top', 'Category', "id := 'cc_top'", { parentAddress: '', parentId: 'PORTAL', parentIsRoot: true });
    const page = o('cc_pg', 'Category', "id := 'cc_pg'", { parentAddress: '', parentId: 'WORKFLOW', parentIsRoot: true });
    const inputs = [top, page];
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), mirror(inputs, { 't.cc_top': { cls: 'Category', genedit: top.genedit, parent: 'cc_folder' }, 't.cc_pg': { cls: 'Category', genedit: page.genedit, parent: 'cc_folder' } })));
    expect(orderOf(patch)).toEqual(['IF t.cc_top != MISSING AND root.portal != MISSING THEN t.cc_top.move(root.portal) ELSE "" ENDIF']);
    expect(patch.warnings).toContainEqual({ kind: 'no-move', rid: page.rid, address: 't.cc_pg', detail: 't.cc_pg: its parent here is the root WORKFLOW, which these scripts do not address, so it stays where it is on the target.' });
    expect(patch.review.find(r => r.address === 't.cc_pg')!.outcome).toBe('same');
  });

  it('a parent neither on the target nor created: not moved, with a warning; re-placed only next to siblings under its own parent', () => {
    const x = at('cc_x', 'cc_sib', 'cc_next', { parentAddress: 't.cc_away', parentId: 'cc_away' });
    const y = at('cc_y', 'cc_elsewhere', 'cc_next');
    const inputs = [x, y];
    const target = mirror(inputs, {
      't.cc_sib': { cls: 'TextElement', parent: 'cc_away' }, 't.cc_next': { cls: 'TextElement', parent: 'cc_folder' },
      // Its previous sibling here is under another parent on the target: not used.
      't.cc_elsewhere': { cls: 'TextElement', parent: 'cc_other' }, 't.cc_folder': { cls: 'Category' },
    });
    target['t.cc_x'] = { ...target['t.cc_x']!, parent: 'cc_folder' };
    target['t.cc_y'] = { ...target['t.cc_y']!, prev: 'cc_elsewhere', next: 'cc_other_next' };
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), target));
    expect(patch.warnings).toContainEqual({ kind: 'no-move', rid: x.rid, address: 't.cc_x', detail: 't.cc_x: its parent t.cc_away is neither on the target nor added with this transport, so it stays where it is on the target.' });
    // Not under its parent here: never re-placed among the siblings of another.
    expect(orderOf(patch)).toEqual(['IF t.cc_y != MISSING AND t.cc_next != MISSING THEN t.cc_y.moveBefore(t.cc_next) ELSE "" ENDIF']);
    expect(patch.review.find(r => r.address === 't.cc_y')!.place!.labels).toEqual(['moved before t.cc_next']);
    // The anchor on the target is checked.
    expect(patch.parts[0].text).toContain('IF t.cc_next = MISSING THEN');
  });

  it('re-placed when the neighbour differs, and only then', () => {
    const a = at('cc_a', '', 'cc_b');
    const b = at('cc_b', 'cc_a', '');
    const inputs = [a, b];
    const target = mirror(inputs);
    target['t.cc_a'] = { ...target['t.cc_a']!, prev: 'cc_b', next: '' };
    target['t.cc_b'] = { ...target['t.cc_b']!, prev: '', next: 'cc_a' };
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), target));
    // a, a first child, goes before b; b, the last, stays: one statement is enough.
    expect(orderOf(patch)).toEqual([
      'IF t.cc_a != MISSING AND t.cc_b != MISSING THEN t.cc_a.moveBefore(t.cc_b) ELSE "" ENDIF',
    ]);
    expect(patch.counts).toMatchObject({ move: 1, same: 1 });
    // A changed object whose place differs too: one outcome, change, with its place.
    const changed = { ...a, genedit: gen('cc_a', 'TextElement', "id := 'cc_a', name := 'Renamed'") };
    const both = assemblePatch([changed, b], parsed(buildProbe([changed, b]), target));
    expect(both.review.find(r => r.address === 't.cc_a')).toMatchObject({ outcome: 'change', place: { labels: ['moved before t.cc_b'] } });
  });

  it('never for system objects, property definitions or enterprise records', () => {
    const sys = at('cc_sys', '', '', { systemObject: true });
    const prop = o('cc_prop', 'TextMethodConfig', "id := 'cc_prop'", { parentAddress: '', parentId: 'PROPERTY', parentIsRoot: true });
    const rec = o('cc_rec', 'CeRisk', "id := 'cc_rec'", { parentId: 'cc_folder' });
    const inputs = [sys, prop, rec];
    const target = mirror(inputs);
    for (const k of ['t.cc_sys', 't.cc_prop', 't.cc_rec']) target[k] = { ...target[k]!, parent: 'cc_other' };
    const patch = assemblePatch(inputs, parsed(buildProbe(inputs), target));
    expect(patch.text).not.toMatch(/\.move(After|Before)?\(/);
    expect(patch.nothingToDo).toBe(true);
    expect(patch.warnings.filter(w => w.kind === 'no-move')).toEqual([]);
  });

  it('no creation text for objects the target lacks: they are added from their values', () => {
    const gone = at('cc_gone', '', '', { generate: undefined });
    const here = at('cc_here', '', '', { generate: undefined });
    const inputs = [gone, here, o('cc_skip', 'TextElement', "id := 'cc_skip'", { readError: 'Timed out' })];
    const answer = parsed(buildProbe(inputs), mirror([here], { 't.cc_folder': { cls: 'Category' } }));
    expect(propertyDefinitionRids(inputs)).toEqual([]);
    const patch = assemblePatch(inputs, answer);
    expect(patch.review.find(r => r.address === 't.cc_gone')!.outcome).toBe('create');
  });
});

describe('the listing: objects only the target has, deletes and ID changes', () => {
  /** A listing line: class, system flag, ID, parent ID, name. */
  const u = (id: string, parent: string, extra: { cls?: string; system?: boolean; name?: string } = {}) =>
    `\nU ${extra.cls ?? 'TextElement'} ${extra.system ? 'true' : 'false'} ${framed(id)} ${framed(parent)} ${framed(extra.name ?? `Name ${id}`)}`;
  const listingOf = (lines: string[]) => `${lines.join('')}\nK ${lines.length}`;
  const START = 't.cc_folder';
  const KEEP = o('cc_keep', 'TextElement', "id := 'cc_keep', name := 'Keep'", { parentId: 'cc_folder' });
  const RENAMED = o('cc_new_name', 'TextElement', "id := 'cc_new_name', name := 'Renamed thing', text := 'x'", { parentId: 'cc_folder' });
  const INPUTS_L = [KEEP, RENAMED];
  const TARGET_L: Target = { 't.cc_keep': { cls: 'TextElement', genedit: KEEP.genedit }, 't.cc_folder': { cls: 'Category' } };
  // cc_moved_in: a source object the target has under an object only it has.
  const SOURCE_IDS = ['cc_folder', 'cc_keep', 'cc_new_name', 'cc_unticked', 'cc_moved_in'];
  const LISTING = listingOf([
    u('cc_keep', 'cc_folder'),
    u('cc_unticked', 'cc_folder'),
    u('cc_old_name', 'cc_folder', { name: 'Renamed thing' }),
    u('cc_extra', 'cc_folder', { cls: 'Category' }),
    u('cc_extra_child', 'cc_extra'),
    u('cc_sys', 'cc_folder', { system: true }),
    u('cc_box', 'cc_folder', { cls: 'Category' }),
    u('cc_box_a', 'cc_box'),
    u('bad\u0007id', 'cc_folder'),
    u('cc_moved_in', 'cc_box_a'),
  ]);
  const probeL = () => buildProbe(INPUTS_L, { listing: { start: START } });
  const answerL = (listing = LISTING) => {
    const r = parseProbeAnswer(answerOf(probeL(), TARGET_L, { listing }).join('\n'), probeL());
    if (!r.ok) throw new Error(r.error);
    return r.answer;
  };

  it('the probe lists the object in a last part of its own, before any genedit; the key covers it', () => {
    const probe = probeL();
    expect(probe.key).not.toBe(buildProbe(INPUTS_L).key);
    expect(probe.listing).toBe(START);
    const part = probe.parts.at(-1)!;
    expect([part.step, part.run, part.index, part.total]).toEqual(['listing', 'preview', probe.parts.length, probe.parts.length]);
    expect(probe.entries.every(e => e.part < part.index)).toBe(true);
    expect(part.text).not.toContain('genedit');
    expect(part.text).toContain(`IF ${START} = MISSING THEN`);
    expect(part.text).toContain(`${START}.descendants().first(${LISTING_CAP + 1}).forEach(_i:`);
    expect(part.text).toContain('_rc := _rc + ("\\nU " + str(_i.className) + " " + str(_i.systemObject.whenMissing(false)) + " " + str(_a.size()) + ":" + _a + " " + str(_b.size()) + ":" + _b + " " + str(_n.size()) + ":" + _n)');
    expect(part.text).toContain('_r := _r + "\\nK " + str(_k)\n');
    expect(part.text).toContain('_r := _r + "\\nK -1"');
    expect(part.text).not.toContain('description');
    expect(() => buildProbe(INPUTS_L, { listing: { start: 't.bad-id' } })).toThrow(/Not an address/);
    expect(() => buildProbe(INPUTS_L, { listing: { start: 't.1x' } })).toThrow(/Not an address/);
  });

  it('reads the listing by size; missing, cut and incomplete listings', () => {
    const l = answerL().listing!;
    expect(l).toMatchObject({ start: START, missing: false, cut: false });
    expect(l.objects).toHaveLength(10);
    expect(l.objects[7]).toEqual({ className: 'TextElement', system: false, id: 'cc_box_a', parentId: 'cc_box', name: 'Name cc_box_a' });
    expect(l.objects[5]).toMatchObject({ id: 'cc_sys', system: true });
    expect(answerL('\nK -1').listing).toMatchObject({ missing: true, objects: [] });
    // Fewer lines than the count, or no last line: incomplete or unanswered.
    expect(parseProbeAnswer(answerOf(probeL(), TARGET_L, { listing: `${u('a', 'cc_folder')}\nK 2` }).join('\n'), probeL())).toMatchObject({ ok: false, kind: 'incomplete' });
    expect(parseProbeAnswer(answerOf(probeL(), TARGET_L, { listing: u('a', 'cc_folder') }).join('\n'), probeL())).toMatchObject({ ok: false, kind: 'unanswered', address: START });
    const many = Array.from({ length: LISTING_CAP + 1 }, (_, i) => u(`cc_${i}`, 'cc_folder')).join('');
    const cut = answerL(`${many}\nK ${LISTING_CAP + 1}`);
    expect(cut.listing).toMatchObject({ cut: true });
    expect(cut.listing!.objects).toHaveLength(LISTING_CAP);
    const patch = assemblePatch(INPUTS_L, cut, { sourceIds: SOURCE_IDS, deleteExtra: true });
    expect(patch.targetOnly).toEqual([]);
    expect(patch.deletes).toEqual([]);
    expect(patch.warnings.map(w => w.kind)).toContain('listing');
  });

  it('only on the target: a tree by parent ID; with deletes on, what goes and why the rest stays', () => {
    const patch = assemblePatch(INPUTS_L, answerL(), { sourceIds: SOURCE_IDS, deleteExtra: true });
    expect(patch.targetOnly.map(t => [t.id, t.depth, t.fate, t.reason ?? '', t.under])).toEqual([
      ['cc_extra', 0, 'delete', '', 1],
      ['cc_extra_child', 1, 'with', '', 0],
      ['cc_sys', 0, 'keep', 'A system object', 0],
      ['cc_box', 0, 'keep', 'Something under it stays', 1],
      ['cc_box_a', 1, 'keep', 'Something under it stays', 0],
      ['bad\u0007id', 0, 'keep', 'Its ID cannot be addressed', 0],
    ]);
    expect(patch.counts.targetOnly).toBe(6);
    expect(patch.deletes).toEqual([{ address: 't.cc_extra', className: 'Category', name: 'Name cc_extra', parentId: 'cc_folder', under: 1 }]);
    const del = patch.parts.filter(p => p.step === 'delete');
    expect(del).toHaveLength(1);
    expect(del[0].text.split('\n').slice(0, 3)).toEqual([
      `// Transport scripts, part ${del[0].index} of ${del[0].total}: Delete`,
      '// Deletes the objects only the target has, and removes class links only the target has. Deleting cannot be undone and removes everything under each object; removing a class link loses the values of the property on objects of that class.',
      '// Run with Execute. Safe to run again: it deletes only what is still there.',
    ]);
    expect(statementsOf(del[0])).toEqual([
      'IF t.cc_extra != MISSING AND t.cc_extra.className = \'Category\' AND t.cc_extra.systemObject.whenMissing(false) = false AND t.cc_extra.parent.id = \'cc_folder\' THEN t.cc_extra.delete() ELSE "" ENDIF',
    ]);
    expect(bodyOf(del[0].text).slice(0, 3)).toEqual(guarded(guard('t.cc_extra', 'Category')));
    // After Order, before Record and Report.
    const steps = patch.parts.map(p => p.step);
    expect(steps.indexOf('delete')).toBeGreaterThan(steps.lastIndexOf('order'));
    expect(steps.at(-1)).toBe('report');
    // The Check part counts what is under each object to delete, before any genedit().
    const check = patch.parts.find(p => p.step === 'check')!;
    const body = statementsOf(check).join('\n');
    expect(body).toContain('IF t.cc_extra = MISSING THEN');
    // Bounded: an object with more than LISTING_CAP under it now reads as CHANGED.
    expect(body).toContain(`     _c := t.cc_extra.descendants().first(${LISTING_CAP + 1})\n     IF _c.size() = 1 THEN`);
    expect(body).not.toMatch(/descendants\(\)\n/);
    expect(body.indexOf('t.cc_extra.descendants()')).toBeLessThan(body.indexOf('genedit()'));
    expect(patch.notes[0]).toMatch(/cannot be undone/);
    expect(patch.preamble).toContain('// To delete (1), each with everything under it:\n//   t.cc_extra (Category), 1 under it');
    expect(transportSummary(patch)).toContain('Deleted:\nt.cc_extra (and 1 under it)');
  });

  it('deletes are off by default: the tree is shown, nothing is deleted', () => {
    const patch = assemblePatch(INPUTS_L, answerL(), { sourceIds: SOURCE_IDS });
    expect(patch.targetOnly.length).toBeGreaterThan(0);
    expect(patch.deletes).toEqual([]);
    expect(patch.parts.some(p => p.step === 'delete')).toBe(false);
    expect(patch.notes[0]).toBe('Objects only the target has stay. Turn on "Delete objects only the target has" to delete them.');
    // Without the source's IDs nothing counts as only on the target.
    expect(assemblePatch(INPUTS_L, answerL(), { deleteExtra: true }).targetOnly).toEqual([]);
  });

  it('an ID change: one to one by class, parent and name; renamed before Create, then its whole line set', () => {
    const patch = assemblePatch(INPUTS_L, answerL(), { sourceIds: SOURCE_IDS, deleteExtra: true });
    expect(patch.renames).toEqual([{ key: 'cc_old_name>cc_new_name', className: 'TextElement', name: 'Renamed thing', from: 't.cc_old_name', to: 't.cc_new_name', rid: RENAMED.rid, on: true }]);
    const r = patch.review.find(x => x.address === 't.cc_new_name')!;
    expect(r).toMatchObject({ outcome: 'change', wholeLine: true, renamedFrom: 't.cc_old_name' });
    expect(patch.parts.some(p => p.step === 'create')).toBe(false);
    const ren = patch.parts.find(p => p.step === 'rename')!;
    expect(statementsOf(ren)).toEqual([
      'IF t.cc_old_name != MISSING AND t.cc_new_name = MISSING AND t.cc_old_name.className = \'TextElement\' THEN t.cc_old_name.change(id := \'cc_new_name\') ELSE "" ENDIF',
    ]);
    const steps = patch.parts.map(p => p.step);
    expect(steps.indexOf('rename')).toBe(steps.indexOf('check') + 1);
    expect(statementsOf(patch.parts.find(p => p.step === 'set')!)).toContain("t.cc_new_name.change(id := 'cc_new_name', name := 'Renamed thing', text := 'x')");
    // The old object is not only on the target any more.
    expect(patch.targetOnly.some(t => t.id === 'cc_old_name')).toBe(false);
    // The Check part: the old object there, the new one not.
    const check = statementsOf(patch.parts.find(p => p.step === 'check')!).join('\n');
    expect(check).toContain('IF t.cc_new_name != MISSING THEN');
    expect(check).toContain('IF t.cc_old_name = MISSING THEN');
    expect(patch.counts).toMatchObject({ rename: 1, create: 0 });
    expect(transportSummary(patch)).toContain('ID changed:\nt.cc_old_name → t.cc_new_name');
  });

  it('an ID change turned off: the object is created and the old one stays only on the target', () => {
    const patch = assemblePatch(INPUTS_L, answerL(), { sourceIds: SOURCE_IDS, renamesOff: new Set(['cc_old_name>cc_new_name']) });
    expect(patch.renames[0].on).toBe(false);
    expect(patch.review.find(x => x.address === 't.cc_new_name')!.outcome).toBe('create');
    expect(patch.parts.some(p => p.step === 'rename')).toBe(false);
    expect(patch.targetOnly.some(t => t.id === 'cc_old_name')).toBe(true);
  });

  it('ambiguous matches are no hints; a pair under a pair is found and hangs on it', () => {
    const twin = o('cc_twin', 'TextElement', "id := 'cc_twin', name := 'Renamed thing'", { parentId: 'cc_folder' });
    const amb = assemblePatch([...INPUTS_L, twin], (() => {
      const probe = buildProbe([...INPUTS_L, twin], { listing: { start: START } });
      const r = parseProbeAnswer(answerOf(probe, TARGET_L, { listing: LISTING }).join('\n'), probe);
      if (!r.ok) throw new Error(r.error);
      return r.answer;
    })(), { sourceIds: [...SOURCE_IDS, 'cc_twin'] });
    expect(amb.renames).toEqual([]);
    // A folder renamed, and a child of it renamed too.
    const folder = o('cc_new_box', 'Category', "id := 'cc_new_box', name := 'Name cc_box'", { parentId: 'cc_folder' });
    const child = o('cc_new_a', 'TextElement', "id := 'cc_new_a', name := 'Name cc_box_a'", { parentId: 'cc_new_box' });
    const inputs = [KEEP, folder, child];
    const probe = buildProbe(inputs, { listing: { start: START } });
    const r = parseProbeAnswer(answerOf(probe, TARGET_L, { listing: LISTING }).join('\n'), probe);
    if (!r.ok) throw new Error(r.error);
    const ids = ['cc_folder', 'cc_keep', 'cc_new_box', 'cc_new_a'];
    const patch = assemblePatch(inputs, r.answer, { sourceIds: ids });
    expect(patch.renames.map(h => [h.from, h.to, h.on, h.after ?? ''])).toEqual([
      ['t.cc_box', 't.cc_new_box', true, ''],
      ['t.cc_box_a', 't.cc_new_a', true, 'cc_box>cc_new_box'],
    ]);
    const off = assemblePatch(inputs, r.answer, { sourceIds: ids, renamesOff: new Set(['cc_box>cc_new_box']) });
    expect(off.renames.map(h => h.on)).toEqual([false, false]);
    // A delete under a renamed folder checks the new parent ID.
    const del = assemblePatch(inputs, r.answer, { sourceIds: ids, deleteExtra: true });
    expect(del.deletes.find(d => d.address === 't.cc_moved_in')).toMatchObject({ parentId: 'cc_new_a' });
  });
});

describe('the Move part converges', () => {
  /** Children in order, by parent ID. */
  type Lists = Record<string, string[]>;
  const args = (id: string) => `id := '${id}', name := 'Name ${id}'`;
  /** The inputs of `ids` as the source holds them in `source`. */
  const inputsOf = (source: Lists, ids: readonly string[]): BundleInput[] => Object.entries(source).flatMap(([parent, kids]) => kids.flatMap((id, i) => (!ids.includes(id) ? [] : [o(id, 'TextElement', args(id), {
    parentAddress: `t.${parent}`, parentId: parent, previousAddress: i ? `t.${kids[i - 1]}` : '', nextAddress: i < kids.length - 1 ? `t.${kids[i + 1]}` : '',
    generate: `t.${parent}.add(TextElement, ${args(id)})`,
  })])));
  /** What a probe sees on a target of `lists`; `texts`: other genedit texts by ID. */
  const targetOf = (lists: Lists, texts: Record<string, string> = {}): Target => {
    const t: Target = {};
    for (const parent of Object.keys(lists)) t[`t.${parent}`] = { cls: 'Category', parent: 'PORTAL' };
    for (const [parent, kids] of Object.entries(lists)) kids.forEach((id, i) => {
      t[`t.${id}`] = { cls: 'TextElement', genedit: texts[id] ?? gen(id, 'TextElement', args(id)), parent, prev: kids[i - 1] ?? '', next: kids[i + 1] ?? '' };
    });
    return t;
  };
  /** The target after the patch's committed parts, in BMP's list semantics:
   *  add appends; move(parent) appends to that parent; moveAfter/moveBefore
   *  take the object out and put it right after/before the anchor. */
  const apply = (lists: Lists, patch: ReturnType<typeof assemblePatch>): Lists => {
    const l: Lists = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...v]]));
    const where = (id: string) => Object.keys(l).find(p => l[p].includes(id));
    const take = (id: string) => { const p = where(id); if (p) l[p].splice(l[p].indexOf(id), 1); };
    for (const line of patch.parts.filter(p => p.run === 'committed').flatMap(p => p.text.split('\n'))) {
      let m: RegExpExecArray | null;
      if ((m = /^IF t\.(\w+) != MISSING AND t\.\w+ = MISSING AND .* THEN t\.\w+\.change\(id := '(\w+)'\)/.exec(line))) {
        const p = where(m[1]);
        if (p) l[p][l[p].indexOf(m[1])] = m[2];
      } else if ((m = /^\s+t\.(\w+)\.add\(\w+, id := '(\w+)'/.exec(line))) {
        if (!where(m[2])) (l[m[1]] ??= []).push(m[2]);
      } else if ((m = /THEN t\.(\w+)\.move\(t\.(\w+)\)/.exec(line))) {
        if (!where(m[1])) continue;
        take(m[1]);
        (l[m[2]] ??= []).push(m[1]);
      } else if ((m = /THEN t\.(\w+)\.(moveAfter|moveBefore)\(t\.(\w+)\)/.exec(line))) {
        if (!where(m[1]) || !where(m[3])) continue;
        take(m[1]);
        const pa = where(m[3])!;
        const i = l[pa].indexOf(m[3]);
        l[pa].splice(m[2] === 'moveAfter' ? i + 1 : i, 0, m[1]);
      }
    }
    return l;
  };
  const patchOf = (inputs: BundleInput[], lists: Lists, texts: Record<string, string> = {}, listing?: { start: string; ids: string[]; parent: string }) => {
    const probe = buildProbe(inputs, listing ? { listing: { start: listing.start } } : {});
    const kids = listing ? lists[listing.parent].map(id => `\nU TextElement false ${framed(id)} ${framed(listing.parent)} ${framed(`Name ${id.replace(/_old$/, '')}`)}`) : [];
    const r = parseProbeAnswer(answerOf(probe, targetOf(lists, texts), { listing: `${kids.join('')}\nK ${kids.length}` }).join('\n'), probe);
    if (!r.ok) throw new Error(r.error);
    return assemblePatch(inputs, r.answer, listing ? { sourceIds: listing.ids } : {});
  };
  /** Apply the patch; the transported objects stand in source order, the
   *  others keep theirs; a second patch moves nothing. */
  const converges = (source: Lists, ids: string[], target: Lists, opts: { texts?: Record<string, string>; listing?: { start: string; ids: string[]; parent: string } } = {}) => {
    const inputs = inputsOf(source, ids);
    const after = apply(target, patchOf(inputs, target, opts.texts, opts.listing));
    // An object whose ID changes (`*_old`) is one of the transported ones.
    const others = new Set(Object.values(target).flat().filter(id => !ids.includes(id) && !id.endsWith('_old')));
    for (const [parent, kids] of Object.entries(source)) {
      expect(after[parent].filter(id => ids.includes(id)), parent).toEqual(kids.filter(id => ids.includes(id)));
      expect(after[parent].filter(id => others.has(id)), parent).toEqual((target[parent] ?? []).filter(id => others.has(id)));
    }
    const again = patchOf(inputs, after, {}, opts.listing);
    expect(again.parts.some(p => p.step === 'order'), 'a second patch moves nothing').toBe(false);
    return after;
  };

  it('(i) the live case: a first child before an ID-changed sibling', () => {
    const source = { cc_folder: ['a', 'b', 'f', 'g'] };
    const target = { cc_folder: ['a', 'b_old', 'f', 'g'] };
    const texts = { a: gen('a', 'TextElement', "id := 'a', name := 'Other'") };
    const listing = { start: 't.cc_folder', ids: ['cc_folder', 'a', 'b', 'f', 'g'], parent: 'cc_folder' };
    const patch = patchOf(inputsOf(source, ['a', 'b', 'f']), target, texts, listing);
    expect(patch.renames.map(h => h.from)).toEqual(['t.b_old']);
    expect(converges(source, ['a', 'b', 'f'], target, { texts, listing }).cc_folder).toEqual(['a', 'b', 'f', 'g']);
  });

  it('(ii) a new first child before existing ones', () => {
    expect(converges({ cc_folder: ['n', 'a', 'b'] }, ['n', 'a', 'b'], { cc_folder: ['a', 'b'] }).cc_folder).toEqual(['n', 'a', 'b']);
  });

  it('(iii) two new children at the start', () => {
    expect(converges({ cc_folder: ['n1', 'n2', 'a', 'b'] }, ['n1', 'n2', 'a', 'b'], { cc_folder: ['a', 'b'] }).cc_folder).toEqual(['n1', 'n2', 'a', 'b']);
  });

  it('(iv) a new child in the middle and one at the end', () => {
    expect(converges({ cc_folder: ['a', 'm', 'b', 'e'] }, ['a', 'm', 'b', 'e'], { cc_folder: ['a', 'b'] }).cc_folder).toEqual(['a', 'm', 'b', 'e']);
  });

  it('(v) siblings only the target has, interleaved, keep their order', () => {
    converges({ cc_folder: ['a', 'b', 'c'] }, ['a', 'b', 'c'], { cc_folder: ['c', 't1', 'a', 't2', 'b'] });
  });

  it('(vi) an object moved in that becomes the first child', () => {
    const after = converges({ cc_folder: ['x', 'a', 'b'], cc_other: ['y'] }, ['x', 'a', 'b'], { cc_folder: ['a', 'b'], cc_other: ['y', 'x'] });
    expect(after).toEqual({ cc_folder: ['x', 'a', 'b'], cc_other: ['y'] });
  });

  it('(vii) three existing siblings reversed', () => {
    expect(converges({ cc_folder: ['a', 'b', 'c'] }, ['a', 'b', 'c'], { cc_folder: ['c', 'b', 'a'] }).cc_folder).toEqual(['a', 'b', 'c']);
  });

  it('every order of four siblings, with one only on the target, converges', () => {
    const perms = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r])));
    for (const order of perms(['a', 'b', 'c', 'z'])) converges({ cc_folder: ['a', 'b', 'c'] }, ['a', 'b', 'c'], { cc_folder: order });
    for (const order of perms(['a', 'b', 'c'])) converges({ cc_folder: ['n', 'a', 'b', 'm', 'c'] }, ['n', 'a', 'b', 'm', 'c'], { cc_folder: order });
  });
});

describe('the transport log helpers', () => {
  it('an entry ID: UTC, word-safe, deterministic', () => {
    expect(transportEntryId(new Date(Date.UTC(2026, 10, 15, 21, 30, 59)), 'AB12CD34')).toBe('cc_tr_20261115_2130_ab12cd');
    expect(transportEntryId(new Date(Date.UTC(2026, 0, 2, 3, 4)), 'a-b')).toBe('cc_tr_20260102_0304_ab0000');
    expect(transportEntryId(new Date('2026-11-15T23:30:00+02:00'), 'ff')).toBe('cc_tr_20261115_2130_ff0000');
    expect(() => transportEntryId(new Date('nope'), 'x')).toThrow();
  });

  it('a summary: counts and addresses, cut at the limit with a line of how many more', () => {
    const patch = assemblePatch(INPUTS, parsed(buildProbe(INPUTS), TARGET));
    expect(transportSummary(patch)).toBe([
      'Added 1, changed 1, moved 0, deleted 0, ID changed 0, the same 1, left out 1.',
      'Added:', 't.cc_new',
      'Changed:', 't.cc_change',
      'The same:', 't.cc_same',
      'Left out:', 't.cc_clash (On the target t.cc_clash is of class ExtendedTable.)',
    ].join('\n'));
    const many = { review: Array.from({ length: 500 }, (_, i) => ({ rid: String(i), address: `t.cc_object_number_${i}`, className: 'TextElement', isNew: false, outcome: 'change' as const, values: [] })), leftOut: [] };
    const text = transportSummary(many);
    expect(text.length).toBeLessThanOrEqual(TRANSPORT_SUMMARY_LIMIT);
    const lines = text.split('\n');
    const shown = lines.filter(l => l.startsWith('t.')).length;
    expect(lines.at(-1)).toBe(`… and ${500 - shown} more`);
    expect(transportSummary(many, 100).length).toBeLessThanOrEqual(100);
  });
});

describe('linked copies', () => {
  const COPY = o('cc_copy', 'TextElement', "id := 'cc_copy', name := 'Own name'", { linkedTo: 'cc_template' });
  const PLAIN = o('cc_plain', 'TextElement', "id := 'cc_plain', name := 'Plain'");

  it('one the target lacks is left out (a link on the target makes it) and gets no creation read; one the target has gets its own values changed', () => {
    const probe = buildProbe([COPY, PLAIN]);
    const answer = parsed(probe, { 't.cc_folder': { cls: 'Category' } });
    expect(propertyDefinitionRids([COPY, PLAIN])).toEqual([]);
    const p = assemblePatch([COPY, PLAIN], answer);
    expect(p.leftOut).toEqual([expect.objectContaining({ rid: COPY.rid, reason: 'linked-copy', detail: 'A linked copy is not added: link cc_template under its parent on the target.' })]);
    expect(p.review.map(r => [r.address, r.outcome])).toEqual([['t.cc_plain', 'create']]);
    expect(p.text).not.toMatch(/add\(TextElement, id := 'cc_copy'/);

    const onTarget = parsed(buildProbe([COPY]), { 't.cc_copy': { cls: 'TextElement', genedit: gen('cc_copy', 'TextElement', "id := 'cc_copy', name := 'Old'") }, 't.cc_folder': { cls: 'Category' } });
    const q = assemblePatch([COPY], onTarget);
    expect(q.review).toEqual([expect.objectContaining({ address: 't.cc_copy', outcome: 'change' })]);
    expect(q.text).toContain("t.cc_copy.change(name := 'Own name')");
  });
});
