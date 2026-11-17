// @vitest-environment happy-dom
/**
 * The hover card of a code reference (fillRefCard): compact, never "No
 * code", the ID only when it is not the name, a second line with the type in
 * words, the class and (when the by-ID lookup brought it) the model, an open
 * button instead of a printed shortcut, and no rebuild while nothing changed
 * (the editor refills the card on a timer). The by-ID lookup hands over the
 * model from the same answer (no extra command).
 */
import { describe, expect, it, vi } from 'vitest';
import { fillRefCard, refMetaText } from '../code-links';
import { lookupRefsByCommand } from '../../lib/id-lookup';
import type { CodeRefCache, TargetCode } from '../../lib/code-ref-client';
import type { RefResolution, RefTarget } from '../../lib/code-ref-resolve';
import type { CodeRef } from '../../lib/code-refs';

const ref = { key: 't.ceRisk', ns: 't', id: 'ceRisk', start: 0, end: 8, line: 3 } as unknown as CodeRef;

function cache(res: RefResolution | 'pending' | undefined, code?: TargetCode): CodeRefCache {
  return { ref: () => res, code: () => code, requestCode: vi.fn(async () => undefined) } as unknown as CodeRefCache;
}

const target = (over: Partial<RefTarget> = {}): RefTarget => ({ rid: '9223372036854775807', type: 'Category', name: 'ceRisk', businessId: 'ceRisk', ...over });

describe('the reference card', () => {
  it('an object without code: one compact card, no "No code", no printed shortcut, an open button', () => {
    const card = document.createElement('div');
    const open = vi.fn();
    fillRefCard(card, ref, cache({ found: true, target: target({ model: 'DEFAULTS' }) }), 'editor', open);
    expect(card.textContent).not.toMatch(/No code/);
    expect(card.textContent).not.toMatch(/F12|open in object window/i);
    expect(card.querySelector('kbd')).toBeNull();
    expect(card.classList.contains('compact')).toBe(true);
    // Line 1: name; the ID equals the name, so it is left out.
    expect(card.querySelector('.ow-card-h .nm')?.textContent).toBe('ceRisk');
    expect(card.querySelector('.ow-card-h .ui-id')).toBeNull();
    // Line 2: type words, class, model.
    expect(card.querySelector('.ow-card-m')?.textContent).toBe(`${refMetaText({ type: 'Category' })} · model DEFAULTS`);
    const b = card.querySelector<HTMLButtonElement>('.ow-card-h .ow-card-open')!;
    expect(b.getAttribute('aria-label')).toBe('Open ceRisk in the object window');
    expect(b.querySelector('use')?.getAttribute('href')).toBe('#i-popout');
    b.click();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ rid: '9223372036854775807' }));
  });

  it('type words and the raw class; the ID shows when it differs from the name', () => {
    const card = document.createElement('div');
    fillRefCard(card, ref, cache({ found: true, target: target({ type: 'CeRisk', name: 'Risk', businessId: 'ceRisk' }) }), 'window', () => undefined);
    expect(card.querySelector('.ow-card-h .ui-id')?.textContent).toBe('ceRisk');
    const meta = card.querySelector('.ow-card-m')!.textContent!;
    expect(meta.endsWith(' · CeRisk')).toBe(true);
    expect(meta).not.toMatch(/model/);
    expect(refMetaText({ type: 'CeRisk' })).toBe(meta);
  });

  it('leaves the class out when it only repeats the type words', () => {
    expect(refMetaText({ type: 'ListPropertySetItem' })).toBe('List property set item');
    expect(refMetaText({ type: 'ExtendedExpression', model: 'PORTAL' })).toBe('Extended expression · model PORTAL');
  });

  it('with code: the preview and its line count; an empty read says nothing about code', () => {
    const card = document.createElement('div');
    const t = target({ type: 'ExtendedExpression', codeProp: 'expression' });
    fillRefCard(card, ref, cache({ found: true, target: t }, { text: 'a := 1\nb := 2\n', prop: 'expression' } as TargetCode), 'editor', () => undefined);
    expect(card.querySelector('.ow-code')).not.toBeNull();
    expect(card.querySelector('.ow-card-f')?.textContent).toContain('2 lines');
    expect(card.textContent).not.toMatch(/F12|open in object window/i);
    const empty = document.createElement('div');
    fillRefCard(empty, ref, cache({ found: true, target: t }, { prop: 'expression' } as TargetCode), 'editor', () => undefined);
    expect(empty.textContent).not.toMatch(/No code/);
    expect(empty.querySelector('.ow-code')).toBeNull();
  });

  it('a failed lookup keeps its quiet form', () => {
    const card = document.createElement('div');
    fillRefCard(card, ref, cache({ found: false, error: 'HTTP 500' }), 'editor', () => undefined);
    expect(card.classList.contains('nf')).toBe(true);
    expect(card.textContent).toBe('No object t.ceRisk on this server.');
    expect(card.querySelector('button')).toBeNull();
  });

  it('a refill with nothing changed keeps the same button (a click under way is not lost)', () => {
    const card = document.createElement('div');
    const c = cache({ found: true, target: target() });
    fillRefCard(card, ref, c, 'editor', () => undefined);
    const b = card.querySelector('button');
    fillRefCard(card, ref, c, 'editor', () => undefined);
    expect(card.querySelector('button')).toBe(b);
    card.hidden = true;
    fillRefCard(card, ref, c, 'editor', () => undefined);
    expect(card.hidden).toBe(false);
  });
});

describe('the model from the by-ID answer', () => {
  it('comes with the RID, in the same single post', async () => {
    const cat = { types: { Category: { parents: [], concrete: true, idSpace: 'TEMPLATE' }, Identifiable: { parents: [], concrete: false } } };
    const client = { resolvePolicyReferences: vi.fn(async () => ({ references: { 0: { rid: '9223372036854775807', model: 'DEFAULTS' } }, unavailable: [] })) };
    const models = new Map<string, string>();
    const out = await lookupRefsByCommand(client, [{ key: 't.ceRisk', ns: 't', id: 'ceRisk' }], async () => cat as never, undefined, models);
    expect(client.resolvePolicyReferences).toHaveBeenCalledTimes(1);
    expect(out?.get('t.ceRisk')).toBe('9223372036854775807');
    expect(models.get('t.ceRisk')).toBe('DEFAULTS');
  });
});
