import { expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as terms from './access-terms';
import { unsavedCount, statementLabel, statementCount, PART, UNDECIDED, NAMING_THIS_ROLE, currentWords } from './access-terms';
import { MARKS } from './matrix-grid.js';

it('says one thing one way', () => {
  expect([unsavedCount(1), unsavedCount(3)]).toEqual(['1 unsaved change', '3 unsaved changes']);
  expect([statementLabel(0), statementCount(1), statementCount(2)]).toEqual(['Statement 1', '1 statement', '2 statements']);
  expect(Object.values(PART)).toEqual(['Who', 'Can', 'On']);
  expect([MARKS.unresolved.word, MARKS.unresolved.legend]).toEqual([UNDECIDED, UNDECIDED]);
  expect(NAMING_THIS_ROLE).toBe('Naming this role');
});

it('rewrites history entries stored before the current words', () => {
  expect(currentWords('Rule 1 effect: Allow')).toBe('Statement 1 effect: Allow');
  expect(currentWords('JSON draft updated')).toBe('JSON kept as an unsaved change');
  // A record name is never rewritten.
  expect(currentWords('Renamed Business rules draft')).toBe('Renamed Business rules draft');
});

/** Retired words, as plain phrases or patterns. Each one once named something the
 *  screens now call a statement, an unsaved change, or Save. */
const RETIRED = [
  'Pending edits', 'pending edits', 'Not resolved', 'cannot be decided here', '>Rules<', 'local changes', 'captured configuration',
  'Directly on this role', 'Collapse rules', 'Policy / rule', 'Open rule', 'Your draft matches', 'Export draft', 'Draft changes are not included',
  'Pending edit', 'Pending JSON edit', 'Pending membership', 'records with unsaved', 'no operation', 'No operation', 'Saved to ',
  /\b(?:Update|Open|In|JSON|local|Local|the|this|complete|current|Resolve these JSON|Resolve this JSON) drafts?\b/,
  /\bDrafts? (?:are|and|could|storage|save)\b/,
  /'Rule'|'Rule '|\bRule \d/,
  /\bApplied\b/, /\bApply (?:or|writes|checks|is|was|at|this|the|recovery)\b/, /\b(?:and|before|not|Could not|previous|current|An|The) apply(?:ing)?\b/,
];

/** Every source of text the Access page shows: templates and strings in .js and
 *  .ts, access.html, and the Access wording and model helpers in src/lib. */
function sources() {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = dir + '/' + name;
      if (statSync(path).isDirectory()) { if (!name.startsWith('__')) walk(path); continue; }
      if (/\.(js|ts|html)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(path);
    }
  };
  walk('src/access'); walk('src/lib/access-workspace');
  out.push('src/lib/access-wording.ts', 'src/lib/access-mode.ts');
  return out;
}
// Comments describe code, not screens: whole-line, block and trailing comments are left out.
const withoutComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '').replace(/\s\/\/\s.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

it('leaves none of the retired words in any Access text source', () => {
  const files = sources();
  expect(files).toEqual(expect.arrayContaining(['src/access/access.html', 'src/access/workspace.js', 'src/access/value-chips.ts', 'src/lib/access-workspace/service.ts']));
  const found = [];
  for (const file of files) {
    // The terms module holds the old words once, to rewrite stored history.
    const source = withoutComments(readFileSync(file, 'utf8')).replace(/export const currentWords[\s\S]*?;\n/, '');
    for (const word of RETIRED) if (typeof word === 'string' ? source.includes(word) : word.test(source)) found.push(file + ': ' + word);
  }
  expect(found).toEqual([]);
});

it('keeps the retired words out of the terms themselves', () => {
  const values = Object.values(terms).map(v => v === currentWords ? '' : typeof v === 'function' ? String(v(2)) : JSON.stringify(v)).join('\n');
  for (const word of RETIRED) expect(typeof word === 'string' ? values.includes(word) : word.test(values), String(word)).toBe(false);
});
