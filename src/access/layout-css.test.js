import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/access/access-workspace.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector) => css.split('}').filter(r => r.split('{')[0].split(',').map(s => s.trim()).includes(selector)).map(r => r.split('{')[1] ?? '').join(';');

describe('access workspace layout', () => {
  it('keeps the matrix band label inside its type column', () => {
    expect(rule('.mb .mc.type')).toContain('overflow: hidden');
    expect(rule('.band-toggle .ct')).toContain('text-overflow: ellipsis');
  });
  it('gives every icon-and-input search field one focus ring, drawn by the shared .ui-search rule', () => {
    const strip = file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const ui = strip('src/styles/ui.css');
    expect(ui).toMatch(/\.ui-search:has\(input:focus\)\s*\{[^}]*box-shadow: 0 0 0 1px var\(--brand\)/);
    expect(ui).toMatch(/\.ui-search input:focus, \.ui-search input:focus-visible \{[^}]*outline: 0/);
    const wrappers = { 'src/access/matrix-view.js': 'srch', 'src/access/access.html': 'search', 'src/access/workspace.js': 'picker-search',
      'src/access/trace-review.ts': 'er-search', 'src/codesearch/codesearch.ts': 'cs-fld', 'src/objectview/window/access-view.ts': 'ow-cb-in' };
    for (const [file, cls] of Object.entries(wrappers)) expect(readFileSync(file, 'utf8'), file).toContain(cls + ' ui-search');
    expect(readFileSync('src/access/workspace.js', 'utf8')).toContain('history-search ui-search');
    // A wrapper ring of its own would come back as a second ring.
    const local = /(\.srch|\.explorer \.search|\.picker-search|\.history-search|\.er-search|\.cs-fld|\.ow-cb-in):focus-within/;
    for (const file of ['src/access/access-workspace.css', 'src/access/access-test.css', 'src/access/access-base.css', 'src/access/access-performance.css', 'src/codesearch/codesearch.css', 'src/objectview/window/window.css']) expect(strip(file), file).not.toMatch(local);
  });
  it('builds the top bar in two rows: tools above, the open records with back and forward below, at every width', () => {
    const html = readFileSync('src/access/access.html', 'utf8');
    const tools = html.slice(html.indexOf('class="topbar-tools"'), html.indexOf('class="topbar-records"'));
    const records = html.slice(html.indexOf('class="topbar-records"'), html.indexOf('</header>'));
    for (const cmd of ['explorer', 'editor-surface', 'matrix', 'undo', 'redo', 'history', 'topbar-more', 'context-panel']) expect(tools).toContain(`data-command="${cmd}"`);
    expect(records).toMatch(/data-command="navigate-back"[\s\S]*data-command="navigate-forward"[\s\S]*id="tabs"/);
    // Performance and help moved behind More; nothing else sits in the record row.
    expect(html).not.toMatch(/data-command="(performance|help)"/);
    expect(tools).toContain('id="pending-review"');
    expect(rule('.topbar')).toContain('flex-direction: column');
    expect(rule('.topbar-tools')).toContain('height: 34px');
    expect(rule('.topbar-records')).toContain('height: 30px');
    expect(css).toMatch(/--bar-h: 64px;/);
    // Tabs keep their size and the row scrolls sideways; no narrow-window rule moves them any more.
    expect(rule('.document-tabs')).toContain('overflow-x: auto');
    expect(rule('.document-tabs')).toContain('flex: 1 1 0');
    expect(rule('.document-tabs .doc-tab')).toContain('flex: none');
    expect([...css.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)].filter(([, , body]) => body.includes('.document-tabs'))).toEqual([]);
  });
  it('sets the sentence pickers as inline tokens: line height, one baseline rule, wrapping like text', () => {
    const tokenRule = css.split('}').find(r => r.includes('.rp-tok, .rp-sentence .token-choice .fast-choice-trigger {'));
    expect(tokenRule).toBeTruthy();
    const body = tokenRule.split('{')[1];
    // Token height is the line height of the sentence, and it sits on the text baseline.
    expect(body).toContain('height: var(--rp-line)');
    expect(body).toMatch(/font: 500 var\(--ui-fs-base\)\/var\(--rp-line\)/);
    expect(rule('.rp-sentence')).toContain('line-height: var(--rp-line)');
    expect(rule('.rp-sentence')).toContain('font-size: var(--ui-fs-base)');
    // A token is exactly one line tall at the line's top, so its text shares the
    // words' baseline (a clipped box has no reliable baseline of its own).
    expect(body).toContain('vertical-align: top');
    // The token's wrapper overrides the shared .fast-choice `vertical-align: middle`,
    // which shifted its line-height box 0.96 px down and grew the line to 24.95 px.
    expect(readFileSync('src/access/access-base.css', 'utf8')).toMatch(/\.fast-choice \{[^}]*vertical-align: middle/);
    expect(rule('.rp-sentence .token-choice')).toContain('vertical-align: baseline');
    // Everything else inside the sentence sits on the text baseline.
    const sentenceRules = css.split('}').filter(r => r !== tokenRule && (r.split('{')[0].includes('.rp-sentence') || r.split('{')[0].includes('.rp-tok')));
    for (const r of sentenceRules) expect(r.match(/vertical-align: (\w+)/g) ?? [], r).toEqual((r.match(/vertical-align: (\w+)/g) ?? []).map(() => 'vertical-align: baseline'));
    // At rest a token has no box border; it is a tint and an underline.
    expect(body).toContain('border: 0');
    // Wrapping: the sentence wraps between words, a token never breaks or overflows.
    expect(rule('.rp-sentence')).toMatch(/flex: 1 1 18em; min-width: 0/);
    expect(rule('.rp-sentence')).toContain('overflow-wrap: anywhere');
    expect(body).toContain('white-space: nowrap');
    expect(body).toMatch(/max-width: 100%[\s\S]*overflow: hidden; text-overflow: ellipsis/);
    expect(rule('.rp-as-line')).toContain('flex-wrap: wrap');
  });
  it('gives every control in the top bar and on the role page one height', () => {
    for (const selector of ['.topbar .icon-button', '.surface-switch, .seg', '.dirty-bar'])
      expect(rule(selector.split(',')[0].trim()) + rule(selector), selector).toMatch(/height: var\(--ui-ctl-h\)/);
    expect(rule('.surface-switch button')).toContain('height: calc(var(--ui-ctl-h) - 4px)');
    expect(css).toMatch(/\.rp-sec :is\(\.ui-btn, \.ui-tbtn, \.icon-button, select[^)]*\) \{ height: var\(--ui-ctl-h\)/);
    // One section header style for both role sections.
    const js = readFileSync('src/access/workspace.js', 'utf8');
    expect(js.match(/class="rp-sh"/g)).toHaveLength(2);
    expect(js).not.toContain('class="section-heading"');
  });
  it('scrolls the active tab into view when it changes', () => {
    const js = readFileSync('src/access/workspace.js', 'utf8');
    const body = js.slice(js.indexOf('function renderTabs()'), js.indexOf('function recordHead('));
    expect(body).toMatch(/activeKey !== lastActiveTab[\s\S]*scrollIntoView\?\.\(\{ block: 'nearest', inline: 'nearest' \}\)/);
  });
  it('lays the role grants out as one table: fixed columns under one sticky header, C R U D cells, no Allow column', () => {
    expect(rule('.gt')).toMatch(/--gt-cols: 22px minmax\(0, 1fr\) 40px 96px minmax\(0, 1\.2fr\) 28px/);
    expect(rule('.gt-row')).toContain('grid-template-columns: var(--gt-cols)');
    expect(rule('.gt-cells')).toContain('grid-template-columns: repeat(4, 22px)');
    expect(rule('.gt-head')).toMatch(/position: sticky/);
    // The ID column appears only where the page is wide enough.
    expect(rule('.gt-c-id')).toContain('display: none');
    expect(css).toMatch(/@container rp \(min-width: 980px\) \{[^@]*\.gt-c-id \{ display: block; grid-column: 6/);
    // Long policy names wrap to two lines rather than lose the verb in a middle cut.
    expect(rule('.gt-name')).toContain('-webkit-line-clamp: 2');
    const js = readFileSync('src/access/workspace.js', 'utf8');
    const head = js.slice(js.indexOf('function grantsSection('), js.indexOf('function syncGrantGroup('));
    expect(head).toContain('role="columnheader">Policy<');
    expect(head).not.toMatch(/columnheader">Allow|Effect</);
  });
  it('gives the explorer one scroll area with sticky Roles and Policies bands, styled in one sheet', () => {
    expect(rule('#tree')).toContain('overflow-y: auto');
    expect(rule('#tree')).toContain('scrollbar-gutter: stable');
    expect(rule('.explorer .collection-list')).toContain('overflow: visible');
    expect(rule('.explorer .collection-heading')).toMatch(/position: sticky; top: 0/);
    // No older sheet styles the lists any more, so nothing can bring back a second scrollbar.
    const strip = file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const file of ['access-base.css', 'access-test.css', 'access-performance.css'])
      expect(strip('src/access/' + file), file).not.toMatch(/(^|[},])\s*(#tree(:has\([^{]*\))?|\.collection-list|\.collection(\+\.collection)?|\.tree-row(\.selected|:hover)?|\.tree-label|\.tree-name[\w-]*|\.folder-count)\s*[{,]/);
    // Middle ellipsis: the start shrinks, the tail stays; counts right-aligned in tabular figures.
    expect(rule('.explorer .tree-name-start')).toContain('text-overflow: ellipsis');
    expect(rule('.explorer .tree-name-end')).toContain('max-width: 78%');
    expect(rule('.explorer .tree-row .folder-count')).toContain('font-variant-numeric: tabular-nums');
    // All / Roles / Policies is a segmented control, like Editor / Matrix.
    expect(readFileSync('src/access/access.html', 'utf8')).toContain('id="search-scopes" class="seg" role="group"');
  });
  it('wraps Granted by names instead of scrolling sideways', () => {
    expect(rule('.context-panel')).toContain('overflow-x: hidden');
    expect(rule('.gl')).toContain('white-space: normal');
    expect(rule('.gl .pl')).toContain('overflow-wrap: anywhere');
  });
});

// Pixels are checked live; these lock the structure the role-page fixes rely on.
describe('access role page layout rules', () => {
  const media = width => css.match(new RegExp(String.raw`@media \(max-width: ${width}px\) \{([\s\S]*?)\n\}`))?.[1] ?? '';
  it('gives a review field its own column, so a long name never draws over its value', () => {
    expect(rule('.rv-delta')).toContain('flex-wrap: wrap');
    expect(rule('.rv-field')).toMatch(/flex: 0 1 9rem;[\s\S]*min-width: 0;[\s\S]*overflow-wrap: anywhere/);
    expect(rule('.rv-delta > .ba')).toContain('min-width: 0');
    expect(rule('.bf .plain')).toContain('overflow-wrap: anywhere');
  });
  it('breaks a long group title between words and ends it with an ellipsis only past two lines', () => {
    expect(rule('.gt-group .gt-c-name')).not.toContain('nowrap');
    expect(rule('.gt-group .gt-title')).toMatch(/-webkit-line-clamp: 2;[\s\S]*white-space: normal/);
    // A flex button cannot show an ellipsis; the parent role's name is an inline block.
    expect(rule('.gt-group .gt-title .link-button')).toMatch(/display: inline-block;[\s\S]*max-width: 100%;[\s\S]*text-overflow: ellipsis/);
  });
  it('turns the details pane into a drawer below 1000 px and the lists below 760 px, as the workspace does', async () => {
    const { CONTEXT_DRAWER_BELOW, EXPLORER_DRAWER_BELOW } = await import('./statement-lines.js');
    expect([CONTEXT_DRAWER_BELOW, EXPLORER_DRAWER_BELOW]).toEqual([1000, 760]);
    expect(media(CONTEXT_DRAWER_BELOW - 1)).toMatch(/\.context-panel \{ position: absolute;/);
    expect(media(EXPLORER_DRAWER_BELOW - 1)).toMatch(/\.explorer \{ position: absolute;/);
    expect(media(EXPLORER_DRAWER_BELOW - 1)).toContain('grid-template-columns: 0 0 minmax(0, 1fr)');
    expect(media(900)).not.toMatch(/\.explorer \{|\.context-panel \{|grid-template-columns: 0 0/);
    expect(css).not.toContain('@media (max-width: 1199px)');
  });
  it('sets sentence tokens one line tall at the top of the line, never on a clipped baseline', () => {
    const tok = rule('.rp-tok');
    expect(tok).toContain('height: var(--rp-line)');
    expect(tok).toContain('font: 500 var(--ui-fs-base)/var(--rp-line) var(--font-ui)');
    expect(tok).toContain('vertical-align: top');
    expect(tok).not.toContain('vertical-align: baseline');
    expect(rule('.rp-sentence')).toContain('line-height: var(--rp-line)');
  });
});
