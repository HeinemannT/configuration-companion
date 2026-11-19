import { describe, expect, it } from 'vitest';
import { parseAnswer, noteNumbers, lenient, NOTHING_FOUND, MAX_OPS, MAX_TEXT } from '../parse-answer';

const JSON_BLOCK = `{
  "format": "companion.point-and-tell.answer/1",
  "operations": [
    { "note": 1, "op": "change", "ref": "o4", "property": "headerColor", "value": "k3" },
    { "note": 2, "op": "move", "ref": "o5", "to": { "before": "o4" } }
  ],
  "questions": [{ "note": 3, "text": "What should the intro say?" }],
  "cannot": [{ "note": 3, "text": "Adding a column changes the expression." }]
}`;

const ok = (text: string) => {
  const r = parseAnswer(text);
  if (!r.ok) throw new Error(r.error);
  return r.answer;
};

describe('parseAnswer', () => {
  it('reads a bare JSON object', () => {
    const a = ok(JSON_BLOCK);
    expect(a.operations).toHaveLength(2);
    expect(a.operations[0]).toMatchObject({ notes: [1], op: 'change', ref: 'o4', property: 'headerColor', value: 'k3' });
    expect(a.operations[1]).toMatchObject({ notes: [2], op: 'move', ref: 'o5', to: { before: 'o4' }, place: { before: 'o4' } });
    expect(a.questions).toEqual([{ notes: [3], text: 'What should the intro say?' }]);
    expect(a.cannot).toEqual([{ notes: [3], text: 'Adding a column changes the expression.' }]);
  });

  it('reads an answer with prose around it and a markdown fence', () => {
    const text = `Sure, here is the plan. I made the button blue and moved Export.\n\n\`\`\`json\n${JSON_BLOCK}\n\`\`\`\n\nLet me know if you want more changes!`;
    expect(ok(text).operations).toHaveLength(2);
  });

  it('takes the last fenced block that is an answer', () => {
    const first = '```json\n{"operations":[{"note":1,"op":"delete","ref":"o1"}]}\n```';
    const second = '```json\n{"operations":[{"note":2,"op":"delete","ref":"o2"}]}\n```';
    const a = ok(`First idea:\n${first}\nBetter:\n${second}`);
    expect(a.operations.map(o => o.ref)).toEqual(['o2']);
  });

  it('skips a fence that is not an answer (a code sample) and finds the one that is', () => {
    const text = '```js\nconsole.log(1)\n```\nand the answer: ```json\n{"operations":[{"note":1,"op":"delete","ref":"o1"}]}\n```';
    expect(ok(text).operations).toHaveLength(1);
  });

  it('finds an unfenced object inside prose', () => {
    const a = ok('Here you go: {"operations":[{"note":1,"op":"delete","ref":"o1"}]} - done.');
    expect(a.operations[0].op).toBe('delete');
  });

  it('forgives curly quotes, trailing commas and // comments', () => {
    const text = '{\n  “operations”: [\n    { “note”: 1, “op”: “change”, “ref”: “o1”, “property”: “name”, “value”: “Hello”, }, // rename\n  ],\n}';
    const a = ok(text);
    expect(a.operations[0]).toMatchObject({ op: 'change', value: 'Hello' });
  });

  it('keeps // inside a string and a comma inside a string', () => {
    const a = ok('{"operations":[{"note":1,"op":"change","ref":"o1","property":"name","value":"http://x, y]"}]}');
    expect(a.operations[0].value).toBe('http://x, y]');
  });

  it('a top-level array counts as the operations; the synonyms action and operation work', () => {
    const a = ok('[{"note":"#2","action":"Move","ref":"O3","to":{"After":"o1"}}]');
    expect(a.operations[0]).toMatchObject({ notes: [2], op: 'move', ref: 'o3' });
    // "After" with a capital is not a key we know: the place is missing, and staging says so
    expect(a.operations[0].to).toBeUndefined();
    const b = ok('{"operations":[{"note":2,"operation":"delete","ref":"o3"}]}');
    expect(b.operations[0].op).toBe('delete');
  });

  it('refs are lower-cased; unknown keys are ignored', () => {
    const a = ok('{"extra":1,"operations":[{"note":1,"op":"delete","ref":" O3 ","comment":"x"}]}');
    expect(a.operations[0].ref).toBe('o3');
  });

  it('note may be a number, a string, "#3", "note 3" or a list', () => {
    expect(noteNumbers(3)).toEqual([3]);
    expect(noteNumbers('3')).toEqual([3]);
    expect(noteNumbers('#3')).toEqual([3]);
    expect(noteNumbers('note 3')).toEqual([3]);
    expect(noteNumbers([1, '2'])).toEqual([1, 2]);
    expect(noteNumbers(0)).toEqual([]);
    expect(noteNumbers(1.5)).toEqual([]);
    expect(noteNumbers(null)).toEqual([]);
  });

  it('an unknown verb is kept as unknown, to be refused with its name', () => {
    const a = ok('{"operations":[{"note":1,"op":"explode","ref":"o1"}]}');
    expect(a.operations[0]).toMatchObject({ op: 'unknown', verb: 'explode' });
  });

  it('an answer that only asks questions or says cannot is still an answer', () => {
    const a = ok('{"questions":[{"note":1,"text":"Which table?"}]}');
    expect(a.operations).toEqual([]);
    expect(a.questions).toHaveLength(1);
  });

  it('add keeps its type, name, place, properties and as', () => {
    const a = ok('{"operations":[{"note":4,"op":"add","type":"TextElement","name":"Intro","place":{"after":"o3"},"properties":{"columns":4},"as":"N1"}]}');
    expect(a.operations[0]).toMatchObject({ op: 'add', type: 'TextElement', name: 'Intro', place: { after: 'o3' }, properties: { columns: 4 }, as: 'n1' });
  });

  it('refuses text with no answer in it, and says what to do', () => {
    for (const text of ['', 'I cannot help with that.', '{"a":1}', '```json\n{"foo": []}\n```', '{"operations": []}']) {
      expect(parseAnswer(text)).toEqual({ ok: false, error: NOTHING_FOUND });
    }
  });

  it('refuses broken JSON without throwing', () => {
    expect(parseAnswer('{"operations": [ {"note": 1, "op": ')).toEqual({ ok: false, error: NOTHING_FOUND });
  });

  it('refuses a text over the limit and an answer with too many operations', () => {
    expect(parseAnswer('x'.repeat(MAX_TEXT + 1))).toMatchObject({ ok: false, error: expect.stringContaining('too long') });
    const ops = Array.from({ length: MAX_OPS + 1 }, (_, i) => ({ note: 1, op: 'delete', ref: `o${i}` }));
    expect(parseAnswer(JSON.stringify({ operations: ops }))).toMatchObject({ ok: false, error: expect.stringContaining('more than 200') });
  });

  it('does not run anything: a script-like value is just a string', () => {
    const a = ok('{"operations":[{"note":1,"op":"change","ref":"o1","property":"name","value":"x\\"); alert(1); (\\""}]}');
    expect(typeof a.operations[0].value).toBe('string');
  });
});

describe('lenient', () => {
  it('leaves valid JSON alone', () => {
    const t = '{"a":[1,2,{"b":"c, d"}],"e":"//"}';
    expect(JSON.parse(lenient(t))).toEqual(JSON.parse(t));
  });
});
