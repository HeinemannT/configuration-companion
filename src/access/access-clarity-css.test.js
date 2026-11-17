// Text floor, the one primary button, condition value rows and the review card
// styles in the Access screens. Pixels still need a live look; these lock the rules.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const strip = file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = css => css.split('}').map(r => r.split('{')).filter(r => r.length === 2).map(([sel, body]) => ({ sel: sel.split(',').map(s => s.trim()), body }));
const rule = (css, selector) => rules(css).filter(r => r.sel.includes(selector)).map(r => r.body).join(';');
const workspace = strip('src/access/access-workspace.css'), review = strip('src/access/access-test.css');

describe('text floor', () => {
  it('has no 9 or 10 px text in the access test and trace review sheet, and no fixed 11 px text there', () => {
    expect(review).not.toMatch(/font(-size)?:\s*(9|10|11)px/);
    expect(review).toMatch(/\.er-table \{ border-collapse: collapse; width: 100%; font-size: var\(--ui-fs-sm\)/);
  });
  it('lets the test table scroll sideways before the policy column gets narrow', () => {
    expect(review).toMatch(/\.er-table \{ table-layout: fixed; min-width: 680px/);
    expect(review).toMatch(/@container workarea \(max-width:620px\) \{\s*\.er-table \{ min-width: 680px/);
    expect(review).toMatch(/\.er-scroll \{ overflow: auto/);
  });
  it('raises legacy test text and the matrix counts, reasons and legend to 12 px', () => {
    for (const sel of ['.context-test .quiet-button', '.context-test .test-scope', '.context-test .result-line > span', '.context-test .check-result pre'])
      expect(rule(workspace, sel), sel).toContain('font-size: var(--ui-fs-sm)');
    for (const sel of ['.mc.cnt', '.band-toggle .ct', '.mc.why', '.legend']) expect(rules(workspace).filter(r => r.sel.includes(sel)).at(-1).body, sel).toContain('var(--ui-fs-sm)');
  });
});

describe('primary actions', () => {
  it('uses the shared ui.css primary for every primary action in Access', () => {
    for (const file of ['src/access/workspace.js', 'src/access/performance-view.js', 'src/access/create-test-view.js', 'src/access/matrix-view.js']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/class=\\?["'](?![^"']*ui-btn)[^"']*\bprimary\b/);
    }
    expect(readFileSync('src/access/workspace.js', 'utf8')).toContain('class="ui-btn primary test-run"');
    expect(readFileSync('src/access/performance-view.js', 'utf8')).toContain('class="ui-btn primary" data-pr="analyze"');
  });
  it('removes the legacy gradient, radius and shadow from the shared primary', () => {
    const body = rule(workspace, '.ui-btn.primary');
    expect(body).toContain('box-shadow: none');
    expect(body).toContain('border-radius: var(--radius-2)');
    expect(rule(workspace, '.context-test .test-run.ui-btn')).toContain('font-size: var(--ui-fs-sm)');
  });
});

// The stylesheets access.html loads, in order; tokens.css and ui.css come from src/styles.
const LINKED = [...readFileSync('src/access/access.html', 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => 'src/access/' + m[1]);
const ACCESS_SHEETS = LINKED.filter(f => !f.includes('../styles/'));
/** font-size declarations allowed below 12 px, as "file: selector". Empty: no Access text needs it. */
const BELOW_FLOOR_ALLOWED = [];

/** Custom properties as the Access page resolves them: later sheets win. */
function tokens() {
  const values = new Map();
  for (const file of LINKED) for (const m of strip(file.replace('src/access/../', 'src/')).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) values.set(m[1], m[2].trim());
  return values;
}
/** The size in px of a font-size value or the size part of a font shorthand, or null when not in px. */
function px(value, values, shorthand) {
  let v = value.replace(/!important/, '').trim();
  if (shorthand) v = (v.match(/(var\([^)]*\)|\d+(?:\.\d+)?px|[\d.]+(?:em|rem|%))(?=\s*\/|\s+[^\d\s])/) ?? [])[1] ?? '';
  for (let i = 0; i < 5; i++) {
    const ref = v.match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/);
    if (!ref) break;
    v = values.get(ref[1]) ?? ref[2] ?? '';
  }
  const n = v.match(/^(\d+(?:\.\d+)?)px$/);
  return n ? Number(n[1]) : /^(smaller|x-small|xx-small|small)$/.test(v) || /^0?\.\d+(em|rem)$/.test(v) ? 0 : null;
}

describe('text floor on the whole Access page', () => {
  it('sets no Access text below 12 px, as a px literal or through a token', () => {
    expect(ACCESS_SHEETS).toContain('src/access/access-workspace.css');
    const values = tokens(), below = [];
    for (const file of ACCESS_SHEETS) for (const r of rules(strip(file))) {
      for (const m of r.body.matchAll(/(?:^|;|\s)(font-size|font)\s*:\s*([^;]+)/g)) {
        const size = px(m[2], values, m[1] === 'font');
        const where = file.replace('src/access/', '') + ': ' + r.sel.join(', ');
        if (size !== null && size < 12 && !BELOW_FLOOR_ALLOWED.includes(where)) below.push(where + ' → ' + m[2].trim());
      }
    }
    expect(below).toEqual([]);
  });
  it('raises the shared extra-small step and the ui.css primitives with a smaller fixed size', () => {
    expect(tokens().get('--ui-fs-xs')).toBe('12px');
    const ui = strip('src/styles/ui.css'), fixed = rules(ui).filter(r => /font-size:\s*([0-9]|1[01])px/.test(r.body)).flatMap(r => r.sel);
    for (const sel of fixed) expect(rules(workspace).some(r => r.sel.includes(sel) && /font-size:\s*(12px|var\(--ui-fs-sm\))/.test(r.body)), sel).toBe(true);
  });
});

describe('one primary button look', () => {
  it('leaves no legacy gradient or other colour on a primary button in any Access sheet', () => {
    const odd = [];
    for (const file of ACCESS_SHEETS) for (const r of rules(strip(file))) {
      if (!r.sel.some(s => /\.primary(?::[\w-]+)?$/.test(s))) continue;
      for (const m of r.body.matchAll(/background(?:-color|-image)?\s*:\s*([^;]+)/g))
        if (!/^var\(--brand(-hover)?\)$/.test(m[1].trim())) odd.push(file + ': ' + r.sel.join(', ') + ' → ' + m[1].trim());
    }
    expect(odd).toEqual([]);
  });
  it('gives Analyze and the chooser\'s Apply the same 28 px primary as Save and Run test', () => {
    const sized = rules(workspace).find(r => r.sel.includes('.picker-footer .ui-btn.primary'));
    expect(sized.sel).toEqual(expect.arrayContaining(['.performance-review .ui-btn.primary', '.context-test .test-run.ui-btn']));
    expect(sized.body).toContain('height: 28px');
    expect(rule(workspace, '.ui-btn.primary')).toMatch(/background: var\(--brand\).*font-weight: 600/s);
    expect(readFileSync('src/access/workspace.js', 'utf8')).not.toMatch(/ui-btn sm primary" data-command="schema-apply"/);
  });
});

describe('condition values and the review card', () => {
  it('puts a value list on a full-width row that wraps', () => {
    expect(rule(workspace, '.editor .xp .logic-comparison > .value-chips')).toContain('grid-column: 1 / -1 !important');
    expect(rule(workspace, '.chip.val').split(';').some(d => d.includes('white-space: normal'))).toBe(true);
  });
  it('wraps the differing values in the review card', () => {
    expect(rule(workspace, '.rv-vals')).toContain('flex-wrap: wrap');
    expect(rule(workspace, '.bf.rv-side')).toContain('overflow: visible');
  });
});
