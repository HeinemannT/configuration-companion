import { describe, expect, it } from 'vitest';
import {
  applyEdits, applyReplace, buildReplaceRecord, changesOf, confirmQuestion, expandReplacement, isReferenceFind, planReplace,
  readReplaceRecord, recordAfterUndo, resultSummary, startsTicked, syntaxProblemText, textAfter, undoReplace, wrapForSyntaxCheck,
  type ReplacePort, type ReplaceQuery, type ReplaceScript, type SyntaxAnswer,
} from '../code-replace';
import { codeSpans } from '../code-refs';

const q = (find: string, replace: string, o: Partial<ReplaceQuery> = {}): ReplaceQuery => ({ find, replace, caseSensitive: true, wholeWord: false, regex: false, ...o });
const script = (rid: string, text: string, prop = 'expression'): ReplaceScript => ({ rid, prop, text });

describe('codeSpans', () => {
  it('finds comments and strings as links skip them', () => {
    const t = 'a := "x // y" // note\n/* c\nd */ b';
    expect(codeSpans(t).map(s => [s.kind, t.slice(s.start, s.end)])).toEqual([
      ['string', '"x // y"'], ['comment', '// note'], ['comment', '/* c\nd */'],
    ]);
  });
});

describe('isReferenceFind', () => {
  it('is true for one whole reference only', () => {
    expect(isReferenceFind('t.some_id')).toBe(true);
    expect(isReferenceFind(' t.get("a-b") ')).toBe(true);
    expect(isReferenceFind('lookup(1234567)')).toBe(true);
    expect(isReferenceFind('t.some_id + 1')).toBe(false);
    expect(isReferenceFind('some_id')).toBe(false);
    expect(isReferenceFind('')).toBe(false);
  });
});

describe('planReplace', () => {
  const code = [
    '_now := t.old_id.value;',
    'output("Based on t.old_id");',
    '// copied from t.old_id',
    'x := t.old_id_more.value + t.old_id.expression',
  ].join('\n');

  it('marks where a reference match sits and starts strings and comments unticked', () => {
    const plan = planReplace([script('1', code)], q('t.old_id', 't.new_id'));
    expect(plan.reference).toBe(true);
    const m = plan.scripts[0].matches;
    // t.old_id_more is another object: an ID ends where it ends
    expect(m.map(x => [x.line, x.kind])).toEqual([[1, 'code'], [2, 'string'], [3, 'comment'], [4, 'code']]);
    expect(m.map(x => startsTicked(x, plan.reference))).toEqual([true, false, false, true]);
    expect(plan.matches).toBe(4);
  });

  it('starts everything ticked when the find text is not a reference', () => {
    const plan = planReplace([script('1', 'a := "today"\n// today')], q('today', 'now'));
    expect(plan.reference).toBe(false);
    expect(plan.scripts[0].matches.map(x => startsTicked(x, plan.reference))).toEqual([true, true]);
  });

  it('treats the literal argument of get as a reference, not a string', () => {
    const plan = planReplace([script('1', 'v := t.get("old-id").value')], q('old-id', 'new-id'));
    expect(plan.reference).toBe(false);
    const ref = planReplace([script('1', 'v := t.get("old-id").value')], q('t.get("old-id")', 't.get("new-id")'));
    expect(ref.scripts[0].matches.map(x => x.kind)).toEqual(['code']);
  });

  it('does not tell strings from code in HTML or JavaScript properties', () => {
    const plan = planReplace([script('1', 'var a = "t.old_id";', 'javascript')], q('t.old_id', 't.new_id'));
    expect(plan.scripts[0].matches[0].kind).toBe('code');
  });

  it('honours case, whole word and regex, and reports a bad pattern', () => {
    expect(planReplace([script('1', 'Task tasks task')], q('task', 'x', { caseSensitive: false, wholeWord: true })).matches).toBe(2);
    expect(planReplace([script('1', 'Task tasks task')], q('task', 'x')).matches).toBe(2);
    expect(planReplace([script('1', 'a1 b22')], q('[a-z](\\d+)', '<$1>', { regex: true })).scripts[0].matches.map(x => x.replacement)).toEqual(['<1>', '<22>']);
    expect(planReplace([script('1', 'a')], q('(', 'x', { regex: true })).problem).toMatch(/Not a valid regular expression/);
    expect(planReplace([script('1', 'a')], q('', 'x')).problem).toMatch(/Enter something/);
  });

  it('keeps offsets right over several lines and CRLF', () => {
    const text = 'one\r\ntwo ab\r\nab three';
    const plan = planReplace([script('1', text)], q('ab', 'XY'));
    const m = plan.scripts[0].matches;
    expect(m.map(x => [x.line, text.slice(x.start, x.end)])).toEqual([[2, 'ab'], [3, 'ab']]);
    expect(textAfter(plan.scripts[0], () => true)).toBe('one\r\ntwo XY\r\nXY three');
    expect(m[0].lineText).toBe('two ab');
  });

  it('does not read $ in a plain replacement', () => {
    const plan = planReplace([script('1', 'a')], q('a', '$&$1'));
    expect(textAfter(plan.scripts[0], () => true)).toBe('$&$1');
  });

  it('changes only the ticked matches', () => {
    const plan = planReplace([script('1', 'a b a b a')], q('a', 'X'));
    const keep = plan.scripts[0].matches[1].id;
    expect(textAfter(plan.scripts[0], m => m.id !== keep)).toBe('X b a b X');
    const ch = changesOf(plan, m => m.id !== keep, () => ({ type: 'T', name: 'N', businessId: 'b' }));
    expect(ch).toHaveLength(1);
    expect(applyEdits(ch[0].opened, ch[0].edits)).toBe('X b a b X');
    expect(changesOf(plan, () => false, () => ({ type: 'T', name: 'N', businessId: 'b' }))).toEqual([]);
  });
});

describe('expandReplacement', () => {
  it('reads the same $ forms as JavaScript', () => {
    const re = /(?<k>b)(c)/g;
    const m = re.exec('abcd')!;
    expect(expandReplacement(m, 'abcd', '[$2$1|$<k>|$&|$`|$\'|$$|$9]')).toBe('[cb|b|bc|a|d|$|$9]');
  });
});

describe('the syntax check', () => {
  it('wraps the script in a branch that never runs', () => {
    expect(wrapForSyntaxCheck('x := 1')).toBe('IF 1 = 2 THEN\nx := 1\nENDIF\n"parsed"');
  });
  it('gives line numbers of the script, not of the wrapper', () => {
    expect(syntaxProblemText('Encountered " "ENDIF" "ENDIF "" at line 5, column 1.\nWas expecting: x')).toBe('Unexpected "ENDIF" at line 4, column 1.');
    expect(syntaxProblemText('something odd\nsecond')).toBe('something odd');
  });
});

// ── the write ─────────────────────────────────────────────────────

function fakeServer(texts: Record<string, string>, opts: { badSyntax?: (text: string) => string | null; failWrite?: (rid: string) => string | null } = {}) {
  const log: string[] = [];
  const port: ReplacePort = {
    async fetch(rid, props) { log.push(`fetch ${rid}`); return { ok: true, code: Object.fromEntries(props.map(p => [p, texts[`${rid}|${p}`] ?? ''])) }; },
    async check(text): Promise<SyntaxAnswer> {
      log.push('check');
      const bad = opts.badSyntax?.(text);
      return bad ? { ok: false, message: bad, verdict: true } : { ok: true };
    },
    async write(rid, _label, prop, value) {
      const fail = opts.failWrite?.(rid);
      if (fail) return { ok: false, error: fail };
      log.push(`write ${rid}`);
      texts[`${rid}|${prop}`] = value;
      return { ok: true };
    },
    pause: async () => undefined,
  };
  return { port, log, texts };
}
const label = (rid: string) => ({ type: 'ExtendedExpression', name: `Object ${rid}`, businessId: `o_${rid}` });

describe('applyReplace', () => {
  const scripts = [script('1', 'x := t.a'), script('2', 'y := t.a + t.a'), script('3', 'z := t.a'), script('4', 'w := t.a')];
  const plan = planReplace(scripts, q('t.a', 't.b'));
  const changes = () => changesOf(plan, () => true, label);

  it('saves each script after reading it again and checking it', async () => {
    const s = fakeServer({ '1|expression': 'x := t.a', '2|expression': 'y := t.a + t.a', '3|expression': 'z := t.a', '4|expression': 'w := t.a' });
    const r = await applyReplace(changes(), s.port);
    expect(r.map(x => x.status)).toEqual(['saved', 'saved', 'saved', 'saved']);
    expect(s.texts['2|expression']).toBe('y := t.b + t.b');
    // read, check, write, read back for each script, in this order
    expect(s.log.slice(0, 5)).toEqual(['fetch 1', 'check', 'write 1', 'fetch 1', 'fetch 2']);
    expect(r[1].changes).toBe(2);
  });

  it('does not write a script that changed on the server, and goes on', async () => {
    const s = fakeServer({ '1|expression': 'x := t.a', '2|expression': 'y := changed by someone', '3|expression': 'z := t.a', '4|expression': 'w := t.a' });
    const r = await applyReplace(changes(), s.port);
    expect(r.map(x => x.status)).toEqual(['saved', 'changed', 'saved', 'saved']);
    expect(r[1].message).toBe('Changed on the server');
    expect(s.texts['2|expression']).toBe('y := changed by someone');
    expect(s.log).not.toContain('write 2');
    expect(resultSummary(r)).toEqual({ saved: 3, notSaved: 1 });
  });

  it('does not save a script the server cannot parse and reports the server message', async () => {
    const s = fakeServer({ '1|expression': 'x := t.a', '2|expression': 'y := t.a + t.a', '3|expression': 'z := t.a', '4|expression': 'w := t.a' },
      { badSyntax: t => (t.startsWith('y') ? 'Unexpected "+" at line 1, column 8.' : null) });
    const r = await applyReplace(changes(), s.port);
    expect(r.map(x => x.status)).toEqual(['saved', 'syntax', 'saved', 'saved']);
    expect(r[1].message).toBe('Unexpected "+" at line 1, column 8.');
    expect(s.texts['2|expression']).toBe('y := t.a + t.a');
  });

  it('does not check HTML or JavaScript as Extended Code', async () => {
    const p = planReplace([script('1', 'var a = t.a', 'javascript')], q('t.a', 't.b'));
    const s = fakeServer({ '1|javascript': 'var a = t.a' }, { badSyntax: () => 'not EC' });
    const r = await applyReplace(changesOf(p, () => true, label), s.port);
    expect(r[0].status).toBe('saved');
    expect(s.log).not.toContain('check');
  });

  it('reports a rejected write and does not stop the others', async () => {
    const s = fakeServer({ '1|expression': 'x := t.a', '2|expression': 'y := t.a + t.a', '3|expression': 'z := t.a', '4|expression': 'w := t.a' },
      { failWrite: rid => (rid === '1' ? 'Not allowed' : null) });
    const r = await applyReplace(changes(), s.port);
    expect(r.map(x => x.status)).toEqual(['failed', 'saved', 'saved', 'saved']);
    expect(r[0].message).toBe('Not allowed');
  });

  it('reports a script it could not read as not saved', async () => {
    const s = fakeServer({});
    s.port.fetch = async () => ({ ok: false, error: 'No answer' });
    const r = await applyReplace(changes().slice(0, 1), s.port);
    expect(r[0]).toMatchObject({ status: 'failed' });
    expect(r[0].message).toContain('No answer');
  });

  it('stops starting scripts after an abort', async () => {
    const s = fakeServer({ '1|expression': 'x := t.a', '2|expression': 'y := t.a + t.a' });
    const ac = new AbortController();
    const r = await applyReplace(changes().slice(0, 2), s.port, { signal: ac.signal, onResult: () => ac.abort() });
    expect(r.map(x => x.status)).toEqual(['saved', 'failed']);
  });
});

describe('the record and the undo', () => {
  const scripts = [script('1', 'x := t.a'), script('2', 'y := t.a')];
  const plan = planReplace(scripts, q('t.a', 't.b'));
  const state = () => ({ '1|expression': 'x := t.a', '2|expression': 'y := t.a' });

  it('puts back the texts the replace wrote and leaves a changed script alone', async () => {
    const s = fakeServer(state());
    const done = await applyReplace(changesOf(plan, () => true, label), s.port);
    const record = buildReplaceRecord('p@srv', q('t.a', 't.b'), done)!;
    expect(record.scripts.map(x => x.before)).toEqual(['x := t.a', 'y := t.a']);
    // someone changes script 2 after the replace
    s.texts['2|expression'] = 'y := t.b + 1';
    const back = await undoReplace(record, s.port);
    expect(back.map(x => x.status)).toEqual(['saved', 'changed']);
    expect(back[1].message).toMatch(/Changed on the server since the replace/);
    expect(s.texts['1|expression']).toBe('x := t.a');
    expect(s.texts['2|expression']).toBe('y := t.b + 1');
    // what is left in the record is what was not put back
    const rest = recordAfterUndo(record, back)!;
    expect(rest.scripts.map(x => x.rid)).toEqual(['2']);
    expect(recordAfterUndo(rest, [{ ...back[1], status: 'saved' }])).toBeNull();
  });

  it('records only the scripts that were saved', async () => {
    const s = fakeServer({ '1|expression': 'x := t.a', '2|expression': 'other' });
    const done = await applyReplace(changesOf(plan, () => true, label), s.port);
    expect(buildReplaceRecord('p@srv', q('t.a', 't.b'), done)!.scripts.map(x => x.rid)).toEqual(['1']);
    expect(buildReplaceRecord('p@srv', q('t.a', 't.b'), done.filter(x => x.status !== 'saved'))).toBeNull();
  });

  it('reads back only its own server\'s record', async () => {
    const s = fakeServer(state());
    const record = buildReplaceRecord('p@srv', q('t.a', 't.b'), await applyReplace(changesOf(plan, () => true, label), s.port))!;
    const stored = JSON.parse(JSON.stringify(record)) as unknown;
    expect(readReplaceRecord(stored, 'p@srv')).toEqual(record);
    expect(readReplaceRecord(stored, 'other@srv')).toBeNull();
    expect(readReplaceRecord({ v: 2 }, 'p@srv')).toBeNull();
    expect(readReplaceRecord(null, 'p@srv')).toBeNull();
  });
});

describe('words', () => {
  it('asks the question as the draft does', () => {
    expect(confirmQuestion(7, 5)).toBe('Change 7 matches in 5 objects?');
    expect(confirmQuestion(1, 1)).toBe('Change 1 match in 1 object?');
  });
});
