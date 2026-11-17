import { expect, it } from 'vitest';
import { statementLines, parseProblem } from './statement-lines.js';

it('maps each statement to its own lines, also for identical statements', () => {
  const statement = { Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [] } };
  const text = JSON.stringify({ Version: '1.0', Statement: [statement, statement, { ...statement, Effect: 'Deny' }] }, null, 2);
  const lines = text.split('\n');
  const map = statementLines(text);
  expect(map).toHaveLength(3);
  expect(map[0].from).toBeLessThan(map[1].from);
  expect(map[0].to).toBeLessThan(map[1].from);
  for (const range of map) {
    expect(lines[range.from - 1].trim()).toBe('{');
    expect(lines[range.to - 1].trim()).toMatch(/^},?$/);
  }
  expect(lines.slice(map[2].from - 1, map[2].to).join('\n')).toContain('"Deny"');
});

it('returns no map for text that does not parse, and names the line', () => {
  const text = '{\n  "Statement": [\n    {\n      "Subject": ["role:a"]\n      "Action": ["Read"]\n    }\n  ]\n}';
  expect(statementLines(text)).toEqual([]);
  expect(parseProblem(text).line).toBe(5);
  expect(parseProblem('{"Statement": []}')).toBeNull();
});

it('puts JSON beside Rules only where both panes keep their width', async () => {
  const { besideFitsWidth } = await import('./statement-lines.js');
  expect(besideFitsWidth(1100, false)).toBe(false);
  expect(besideFitsWidth(1360, false)).toBe(true);
  expect(besideFitsWidth(1320, false)).toBe(false);
  expect(besideFitsWidth(1150, true)).toBe(true);
});
