/**
 * Every Extended Code builder that interpolates free text writes it through the
 * one literal escaper (ec-guards formatEcLiteral / ecString / ecScalarLiteral):
 * tab, double quote, backslash, newline and carriage return are escaped,
 * non-ASCII text passes through unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import './chrome-mock';
import { BmpClient } from '../bmp-client';
import { ecScalarLiteral, ecString, formatEcLiteral } from '../ec-guards';
import { literal } from '../access-workspace/read';
import { ecStringLiteral } from '../code-search-match';
import { refExpression } from '../code-ref-resolve';
import { buildNameSearchEc } from '../object-search';
import { buildContextQueryEc } from '../handlers/ai-tools';
import { buildFlowContainerBlastEc } from '../layout/blast-radius';
import { TEST_FRAME } from './ec-frame-fixtures';

/** Tab, quote, backslash, newline, carriage return and non-ASCII text. */
const RAW = 'a\tb"c\\d\ne\rf é 日本';
/** RAW as it must appear between the quotes of an EC string literal. */
const ESCAPED = 'a\\tb\\"c\\\\d\\ne\\rf é 日本';

function makeClient() {
  const c = new BmpClient('http://localhost/Steadfast/', 'admin', 'pw');
  c.supportsLookup = true;
  const exec = vi.fn(async (_ec: string) => ({ ok: true, log: 'Result : 0', hasError: false, hasWarning: false }));
  (c as unknown as { executeEc: typeof exec }).executeEc = exec;
  return { c, exec };
}

describe('the shared EC literal escaper', () => {
  it('escapes tab, quote, backslash, newline and carriage return; keeps non-ASCII', () => {
    expect(formatEcLiteral(RAW)).toBe(ESCAPED);
    expect(ecString(RAW)).toBe(`"${ESCAPED}"`);
    expect(ecScalarLiteral(RAW)).toBe(`"${ESCAPED}"`);
    expect(ecScalarLiteral(true)).toBe('TRUE');
    expect(ecScalarLiteral(false)).toBe('FALSE');
    expect(ecScalarLiteral(12.5)).toBe('12.5');
  });
});

describe('applyObjectChanges: built-in text fields', () => {
  it('writes quotes, backslashes, line breaks and non-ASCII text as one escaped literal', async () => {
    const { c, exec } = makeClient();
    await expect(c.applyObjectChanges('100', 'instance', { pageTitle: RAW, description: 'Line one\nLine two' })).resolves.toMatchObject({ ok: true });
    const ec = exec.mock.calls[0][0];
    expect(ec).toContain(`pageTitle := "${ESCAPED}"`);
    expect(ec).toContain('description := "Line one\\nLine two"');
  });

  it('clears a text field with an empty string literal', async () => {
    const { c, exec } = makeClient();
    await c.applyObjectChanges('100', 'instance', { pageTitle: '', description: '' });
    expect(exec.mock.calls[0][0]).toContain('_o.change(pageTitle := "", description := "")');
  });

  it('refuses the text fields that are not editable', async () => {
    const { c, exec } = makeClient();
    for (const p of ['key', 'image', 'information', 'richText']) {
      await expect(c.applyObjectChanges('100', 'instance', { [p]: 'x' })).resolves.toMatchObject({ ok: false });
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('builders that interpolate text', () => {
  it('BmpClient.applyObjectChanges: a text property value', async () => {
    const { c, exec } = makeClient();
    await expect(c.applyObjectChanges('100', 'instance', { name: RAW })).resolves.toMatchObject({ ok: true });
    expect(exec.mock.calls[0][0]).toContain(`name := "${ESCAPED}"`);
  });

  it('BmpClient.applyIdentityChanges: the name', async () => {
    const { c, exec } = makeClient();
    await c.applyIdentityChanges('100', { name: RAW });
    expect(exec).toHaveBeenCalled();
    for (const [ec] of exec.mock.calls) expect(ec).toContain(`name := "${ESCAPED}"`);
  });

  it('BmpClient.saveCodeViaEc: the code', async () => {
    const { c, exec } = makeClient();
    await c.saveCodeViaEc('100', 'expression', RAW);
    expect(exec.mock.calls[0][0]).toBe(`_o := lookup(100)\n_o.change(expression := "${ESCAPED}")`);
  });

  it('Access workspace reads: literal()', () => {
    expect(literal(RAW)).toBe(`"${ESCAPED}"`);
  });

  it('code search prefilter: a needle without line breaks; none with one', () => {
    expect(ecStringLiteral('a\tb"c\\d é 日本')).toBe('a\\tb\\"c\\\\d é 日本');
    expect(ecStringLiteral(RAW)).toBeNull();
  });

  it('reference resolution: a t.get("...") id', () => {
    expect(refExpression('t.a\tb é 日本')).toBe('t.get("a\\tb é 日本")');
  });

  it('object search: the name query', () => {
    expect(buildNameSearchEc('Scorecard', RAW, TEST_FRAME)).toContain(`_q := "${ESCAPED}"`);
  });

  it('AI context query: the template query and the filter value', () => {
    const ec = buildContextQueryEc('lookup(1)', undefined, RAW, ['name'], 'name', RAW);
    expect(ec).toContain(`linkedTo.name = "*${ESCAPED}*"`);
    expect(ec).toContain(`_items := _items.filter(name = "*${ESCAPED}*")`);
  });

  it('Blueprint flow-container probe: the id', () => {
    const ec = buildFlowContainerBlastEc([{ id: RAW, className: 'InputSet', ref: 'lookup(1)' }]);
    expect(ec).toContain(`FLOW|${ESCAPED}|InputSet|`);
  });
});
