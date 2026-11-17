// One visual system for the Access page: the sheets it loads, and the literals
// those sheets may contain. Colours, fonts, radii and type sizes come from
// src/styles/tokens.css and ui.css; Access sheets refer to them by token.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const read = file => strip(readFileSync(file, 'utf8'));
/** Declarations of a sheet as { sel, prop, value }, at-rule bodies included. */
function decls(css) {
  const out = [];
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = block[1].trim();
    if (/^(from|to|\d+%)$/.test(sel)) continue;
    for (const d of block[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out.push({ sel, prop: d.slice(0, i).trim(), value: d.slice(i + 1).replace(/!important/, '').trim() });
    }
  }
  return out;
}

const html = readFileSync('src/access/access.html', 'utf8');
const LINKED = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]);
/** The agreed list, in load order. */
const AGREED = ['../styles/tokens.css', 'access-base.css', 'pbac-highlighting.css', 'access-test.css', 'access-performance.css', '../styles/ui.css', 'access-workspace.css'];
/** Access sheets checked for literals. pbac-highlighting.css is left out on purpose: it is
 * the JSON editor's syntax palette, generated from pbac-highlighting.js and compared
 * byte for byte with it (pbac-palette.test.js), so its colours live in that module. */
const CHECKED = ['access-base.css', 'access-test.css', 'access-performance.css', 'access-workspace.css'].map(f => 'src/access/' + f);
const PALETTE = 'src/access/pbac-highlighting.css';

describe('Access stylesheets', () => {
  it('loads exactly the agreed sheets, in order, and no CSS file in src/access is left unloaded', () => {
    expect(LINKED).toEqual(AGREED);
    const onDisk = readdirSync('src/access').filter(f => f.endsWith('.css')).sort();
    expect(onDisk).toEqual(AGREED.filter(f => !f.startsWith('../')).sort());
  });

  it('has no colour literal outside token definitions', () => {
    const NAMED = /\b(white|black|red|green|blue|gray|grey|silver|purple|violet|orange|yellow|pink|lavender)\b/i;
    const found = [];
    for (const file of CHECKED) for (const d of decls(read(file))) {
      if (d.prop.startsWith('--') && d.sel === ':root' && file.endsWith('access-workspace.css') && !/#|rgb|hsl/.test(d.value)) continue;
      if (/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(d.value) || (NAMED.test(d.value) && !/^(white-space|font|grid|transition)/.test(d.prop)))
        found.push(`${file.replace('src/access/', '')}: ${d.sel} { ${d.prop}: ${d.value} }`);
    }
    expect(found).toEqual([]);
    // The palette sheet holds only syntax-colour classes.
    for (const d of decls(read(PALETTE))) expect(d.sel).toMatch(/^\.pbac-[a-z]+$/);
  });

  it('sets fonts only through the token stacks', () => {
    const found = [];
    for (const file of CHECKED) for (const d of decls(read(file))) {
      if (d.prop === 'font-family' && !/^(var\(--font-(ui|mono)\)|inherit)$/.test(d.value)) found.push(`${file}: ${d.sel} → ${d.value}`);
      if (d.prop === 'font' && !/^inherit$/.test(d.value) && !/var\(--font-(ui|mono)\)$/.test(d.value)) found.push(`${file}: ${d.sel} → font: ${d.value}`);
    }
    expect(found).toEqual([]);
  });

  it('keeps radii and type sizes on the scale', () => {
    const RADIUS = /^((0|50%|var\(--radius-(0|1|2|sm|md|lg|round)\)|inherit)(\s+|$))+$/;
    const SIZE = /^(var\(--ui-fs-(xs|sm|base|name)\)|inherit|1em|100%)$/;
    const found = [];
    for (const file of CHECKED) for (const d of decls(read(file))) {
      if (/radius$/.test(d.prop) && !RADIUS.test(d.value)) found.push(`${file}: ${d.sel} → ${d.prop}: ${d.value}`);
      if (d.prop === 'font-size' && !SIZE.test(d.value)) found.push(`${file}: ${d.sel} → font-size: ${d.value}`);
      if (d.prop === 'font' && d.value !== 'inherit') {
        const size = d.value.match(/(?:^|\s)(var\(--ui-fs-[a-z]+\)|\d+(?:\.\d+)?(?:px|em|rem|%))(?=\s*\/|\s+var\(--font)/)?.[1];
        if (!size || !SIZE.test(size)) found.push(`${file}: ${d.sel} → font: ${d.value}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('refers only to custom properties that something defines', () => {
    const defined = new Set();
    const sources = ['src/styles/tokens.css', 'src/styles/ui.css', ...CHECKED].map(f => readFileSync(f, 'utf8'));
    for (const css of sources) for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    // Properties set from script (style="--depth:…", element.style.setProperty).
    const scripts = readdirSync('src/access').filter(f => /\.(js|ts)$/.test(f) && !/\.test\./.test(f)).map(f => readFileSync('src/access/' + f, 'utf8')).join('\n');
    for (const m of scripts.matchAll(/(--[a-z][\w-]*)\s*[:'"]/g)) defined.add(m[1]);
    const missing = [];
    for (const file of CHECKED) for (const m of read(file).matchAll(/var\((--[\w-]+)\s*([,)])/g)) if (!defined.has(m[1]) && m[2] === ')') missing.push(file + ': ' + m[1]);
    expect([...new Set(missing)]).toEqual([]);
  });
});
