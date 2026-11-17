/**
 * A deterministic code search world: roots, templates, instances in
 * organisations (some overriding), long lines, comments, references.
 */
import type { SimObject, SimOrg } from './code-search-sim';

function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); }
const WORDS = ['_rows', 'SELECT', 'CeRisk', 'WHERE', 'owner', '=', 'this.user', 'AND', 'today', 'Today', 'todays', 'IF', 'THEN', 'ENDIF',
  't.e1.expression', '{e1}', 'lookup(3)', 'o.e1', '"t.e1 in a string"', 'due_date_reminder', 'whenMissing("")', '+', '1'];

function text(r: () => number, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const n = 2 + Math.floor(r() * 8);
    let line = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
    // Now and then a very long line (cut around the first match in a hit).
    if (r() < 0.03) line = `${'x'.repeat(700)} today ${'y'.repeat(300)}`;
    if (r() < 0.05) line = `// today in a comment ${line}`;
    out.push(`${'  '.repeat(Math.floor(r() * 3))}${line}`);
  }
  return out.join(r() < 0.5 ? '\n' : '\r\n');
}

export function goldenWorld(): { objects: SimObject[]; orgs: SimOrg[] } {
  const r = rng(11);
  const orgs: SimOrg[] = [
    { rid: '100', name: 'Group', parent: '' }, { rid: '110', name: 'Europe', parent: '100' },
    { rid: '120', name: 'Asia', parent: '100' }, { rid: '200', name: 'Administration', parent: '' },
  ];
  const objects: SimObject[] = [];
  objects.push({ rid: '3', type: 'ExtendedExpression', id: 'e1', name: 'Expr one', stamp: 's', root: 'expression', code: { expression: 'today + 1' } });
  for (let i = 0; i < 40; i++) {
    objects.push({ rid: `9${String(i).padStart(18, '0')}`, type: 'ExtendedExpression', id: `x${i}`, name: `Expression ${i % 7}`, stamp: 's', root: 'expression', code: { expression: text(r, 3 + Math.floor(r() * 30)) } });
  }
  for (let t = 0; t < 25; t++) {
    const type = t % 3 === 0 ? 'ActionButton' : 'ExtendedTable';
    const code: Record<string, string> = type === 'ActionButton'
      ? { expression: text(r, 2 + Math.floor(r() * 6)), afterExpression: text(r, 1 + Math.floor(r() * 4)) }
      : { expression: text(r, 5 + Math.floor(r() * 40)) };
    const trid = `8${String(t).padStart(18, '0')}`;
    objects.push({ rid: trid, type, id: `t${t}`, name: `Template ${t % 9}`, stamp: 's', root: 'templateCategory', code });
    for (const org of ['100', '110', '120', '200']) {
      for (let k = 0; k < 3; k++) {
        const over = r() < 0.15;
        const own = over ? { ...code, expression: `${code.expression}\n_extra := today` } : { ...code };
        objects.push({ rid: `7${String(t * 1000 + Number(org) + k).padStart(18, '0')}`, type, id: `i${t}_${org}_${k}`, name: `Template ${t % 9}`, stamp: 's', root: 'organisation', org, tmpl: trid, code: own });
      }
    }
  }
  for (let i = 0; i < 15; i++) {
    objects.push({ rid: `6${String(i).padStart(18, '0')}`, type: 'ExtendedTable', id: `p${i}`, name: `Portal ${i}`, stamp: 's', root: 'portal', code: { expression: text(r, 4 + Math.floor(r() * 12)) } });
  }
  return { objects, orgs };
}
