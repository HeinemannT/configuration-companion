// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { jsonDiffHTML, reviewedJSON } from './json-diff-view.js';

it('marks changed lines, folds unchanged runs and compares only what is reviewed', () => {
  const statements = Array.from({ length: 12 }, (_, i) => ({ Effect: 'Allow', Subject: '*', Action: ['Read'], n: i }));
  const before = { rid: '1', id: 'p', name: 'P', valid: true, content: { Version: '1.0', Statement: statements } };
  const after = { ...before, content: { ...before.content, Statement: statements.map((s, i) => i === 6 ? { ...s, Action: ['Read', 'Delete'] } : s) } };
  expect(reviewedJSON('policies', before)).not.toContain('"rid"');
  expect(reviewedJSON('roles', { rid: '9', id: 'r', name: 'R', parent: '' })).toBe('{\n  "id": "r",\n  "name": "R",\n  "parent": ""\n}');
  document.body.innerHTML = jsonDiffHTML(reviewedJSON('policies', before), reviewedJSON('policies', after));
  expect(document.querySelector('.jd-summary').textContent).toBe('2 lines added, 1 removed');
  expect([...document.querySelectorAll('.jd-row.add .jd-text')].map(e => e.textContent.trim())).toEqual(['"Read",', '"Delete"']);
  expect(document.querySelectorAll('.jd-gap').length).toBe(2);
  expect(document.querySelector('.jd-row.del .sr-only').textContent).toBe('Removed: ');
});
