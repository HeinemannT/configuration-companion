import { expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { jsonFormattingChanges } from './json-format.js';

const format = source => ChangeSet.of(jsonFormattingChanges(source), source.length).apply(Text.of(source.split('\n'))).toString();

it('only changes whitespace, including around empty containers and escaped punctuation', () => {
  const source = String.raw` {"a": [], "b":{}, "text":` + JSON.stringify('quoted " comma, braces{} newline\n backslash\\') +
    String.raw`,"escaped":"\u0061","number":1e+100,"rid":9223372036854775807,"a":false} `;
  const result = format(source);
  expect(JSON.parse(result)).toEqual(JSON.parse(source));
  for (const literal of [String.raw`"\u0061"`, '1e+100', '9223372036854775807', '"a": []', '"a": false']) expect(result).toContain(literal);
  expect(jsonFormattingChanges(result)).toEqual([]);
});

it('matches normal two-space JSON layout without touching malformed input', () => {
  for (const value of [{ Statement: [{ Resource: { All: [] } }, { description: 'line\nbreak', values: [true, null, {}, []] }] }, [], {}, 'text', 42]) {
    expect(format(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
  }
  for (const source of ['', '{', '{"Statement":[],}', '// note\n{}']) expect(jsonFormattingChanges(source)).toBeNull();
});
