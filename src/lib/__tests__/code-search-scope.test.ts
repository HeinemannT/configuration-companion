/**
 * Code search "under an object" means what the object window shows as the
 * object's structure: its tree, the reference its structure rule follows
 * (InputView → input set) and the references followed below a node (an
 * action button → its action object). One listing post, no full reads.
 */
import { describe, expect, it } from 'vitest';
import './chrome-mock';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { STATIC_CODE_PROPS } from '../code-index-sync';
import { findEvaluatingCodeReads } from '../ec-code-safety';
import { buildCodeScopeEc, followTypes, parseCodeScopeLog, structureVia } from '../code-search-scope';
import { buildHitScanEcs } from '../code-scope-read';
import { compileSearch } from '../code-search-match';
import { scopeText } from '../../codesearch/search-model';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

const row = (...f: string[]) => R(...f);

describe('the scope listing', () => {
  it('follows the rules of the type table', () => {
    expect(structureVia('InputView')).toBe('inputSet');
    expect(structureVia('ActionButton')).toBe('actionObject');
    expect(structureVia('CreateObjectView')).toBe('editPage');
    expect(structureVia('ExtendedExpression')).toBeUndefined();
    expect(followTypes()).toEqual([{ type: 'ButtonInput', via: 'actionObject', test: 'buttonType' }]);
  });

  it('lists an InputView, its input set, the buttons there and their action objects', () => {
    const ec = buildCodeScopeEc('lookup(42)', 'InputView', F);
    expect(ec).toContain('_o := lookup(42)');
    // The input set is a reference, not a child: listed with what is under it.
    expect(ec).toContain('_s := _o.inputSet');
    expect(ec).toContain('_ld := SELECT ButtonInput FROM _s\n     _x := _ld.calculate(\n          _d := self');
    expect(ec).toContain('_lb := SELECT ButtonInput FROM _s\n     _lb.forEach(_b:');
    expect(ec).toContain('_a := _b.actionObject');
    expect(ec).toContain('str(output(_b.buttonType.whenMissing("")))');
    // The tree under the object itself stays in.
    expect(ec).toContain('_ld := SELECT ExtendedExpression FROM _o');
    // A SELECT is assigned before it is looped: never `SELECT … FROM _o.forEach(`.
    expect(ec).not.toMatch(/FROM _\w+\.forEach/);
    // Code is only measured, never run.
    expect(findEvaluatingCodeReads(ec)).toEqual([]);
    expect(ec.endsWith(`_r + "${F.done}"`)).toBe(true);
  });

  it('lists only the tree for a type without a structure reference', () => {
    const ec = buildCodeScopeEc('lookup(7)', 'ExtendedExpression', F);
    expect(ec).not.toContain('_s := ');
    expect(ec).toContain('_lb := SELECT ButtonInput FROM _o');
    expect(findEvaluatingCodeReads(ec)).toEqual([]);
  });

  it('is safe for every known code property', () => {
    for (const type of ['InputView', 'ActionButton', 'CreateObjectView', 'Scorecard']) {
      expect(findEvaluatingCodeReads(buildCodeScopeEc('lookup(1)', type, F, STATIC_CODE_PROPS))).toEqual([]);
    }
  });
});

describe('the listed scope', () => {
  const log = [
    row('O', '1', '', 'InputView', '12'),            // the object, with code
    row('S', '2', '1', 'InputSet', '0'),             // its input set, no code of its own
    row('O', '3', '2', 'ButtonInput', '30'),         // a button in the input set
    row('O', '4', '2', 'ButtonInput', '8'),
    row('O', '3', '2', 'ButtonInput', '30'),         // listed twice: kept once
    row('O', '5', '2', 'TextInput', '0'),            // no code: left out
    row('B', '3', '', 'ButtonInput', 'ButtonInputType.action'),
    row('B', '4', '', 'ButtonInput', 'ButtonInputType.submit'),
    row('F', '6', '3', 'TransportGroup', '0'),       // the action object of button 3
    row('F', '7', '3', 'ExtendedTransport', '40'),   // under it, with code
    row('F', '8', '4', 'ExtendedTransport', '9'),    // button 4 is no action button
  ].join('') + F.done;

  it('keeps the objects with code, each once, and follows action buttons only', () => {
    const scope = parseCodeScopeLog(log, F, 'InputView');
    expect(scope.items).toEqual([
      { rid: '1', type: 'InputView', len: 12 },
      { rid: '3', type: 'ButtonInput', len: 30 },
      { rid: '4', type: 'ButtonInput', len: 8 },
      { rid: '7', type: 'ExtendedTransport', len: 40 },
    ]);
    // The listing carries each object's stamp after its length.
    expect(parseCodeScopeLog(row('O', '1', '', 'InputView', '12@Nov 1, 2026 10:00:00') + F.done, F, 'InputView').items)
      .toEqual([{ rid: '1', type: 'InputView', len: 12, stamp: 'Nov 1, 2026 10:00:00' }]);
    expect(scope.covered).toEqual({ via: { prop: 'inputSet', found: true }, followed: 1 });
  });

  it('says when the structure reference is not set', () => {
    const scope = parseCodeScopeLog(row('O', '1', '', 'InputView', '3') + F.done, F, 'InputView');
    expect(scope.covered).toEqual({ via: { prop: 'inputSet', found: false }, followed: 0 });
  });

  it('refuses a listing without its completion marker', () => {
    expect(() => parseCodeScopeLog(row('O', '1', '', 'InputView', '3'), F, 'InputView')).toThrow();
  });

  it('names what was covered in the status line', () => {
    expect(scopeText('Sandbox', { via: { prop: 'inputSet', found: true }, followed: 2 }))
      .toBe('Under Sandbox: the object and what is under it, its input set with what is under it and what 2 buttons act on.');
    expect(scopeText('Sandbox', { via: { prop: 'inputSet', found: false }, followed: 0 }))
      .toBe('Under Sandbox: the object and what is under it. It has no input set.');
    expect(scopeText('Rule', { followed: 1 })).toBe('Under Rule: the object and what is under it and what 1 button acts on.');
  });
});

describe('the narrowing scan of a listed scope (above the read-all limit)', () => {
  it('tests each object, the command\'s context, with its own code properties, safely and small', () => {
    const c = compileSearch({ query: 'today', caseSensitive: false, wholeWord: false, regex: false });
    if ('error' in c) throw new Error(c.error);
    const scripts = buildHitScanEcs(['ButtonInput', 'ExtendedExpression'], c.prefilter, undefined, true);
    // The search text comes first; the object is the context, not in the text.
    for (const s of scripts) {
      expect(s.code.split('\n')[0]).toBe('_p := "*today*"');
      expect(s.code).toContain('_l := LIST(this.object)');
      expect(s.code).not.toContain('lookup(');
      expect(s.code.length).toBeLessThanOrEqual(1_200);
      expect(findEvaluatingCodeReads(s.code)).toEqual([]);
    }
    expect(scripts.filter(s => s.type === 'ButtonInput').map(s => s.code).join('\n')).toContain('_w := output(_o.expression)');
    expect(() => buildHitScanEcs(['NoSuchType'], c.prefilter)).toThrow();
  });
});
