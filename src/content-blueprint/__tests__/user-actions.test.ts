/** @vitest-environment happy-dom */
/**
 * Only a real user action may start a write from Blueprint's in-page controls
 * (lib/trusted-event.ts): page script shares the DOM and can dispatch mouse
 * and key events, but the browser marks those as untrusted. Review and apply,
 * Confirm & apply, the portable-ID setting and saved styles ignore them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlueprintCtx } from '../../lib/layout/sync';
import type { LModel, LNode } from '../../lib/layout/types';
import { asUser, userMouseDown } from '../../lib/__tests__/user-event';

const openApplyPreview = vi.fn();
const confirmApply = vi.fn();
const setPortableIdsEnabled = vi.fn();
const persistPortableIdPattern = vi.fn();
const setPortableIdPatternDraft = vi.fn((_p: string) => null);

vi.mock('../actions', async importOriginal => ({
  ...(await importOriginal<typeof import('../actions')>()),
  openApplyPreview: () => openApplyPreview(),
  confirmApply: () => confirmApply(),
}));
vi.mock('../id-config', async importOriginal => ({
  ...(await importOriginal<typeof import('../id-config')>()),
  setPortableIdsEnabled: (v: boolean) => setPortableIdsEnabled(v),
  persistPortableIdPattern: () => persistPortableIdPattern(),
  setPortableIdPatternDraft: (p: string) => setPortableIdPatternDraft(p),
}));

import { bp, resetState } from '../state';
import { previewModal, renderChip, settingsPanel } from '../view-panels';
import { paintPopup } from '../view-paint';

const ctx: BlueprintCtx = { pageId: 'page', pageRid: '98357', pageClass: 'ModelPage', tabsetId: 'tabs', target: 'template', hasTemplate: true };

const node = (partial: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({ name: partial.id, cols: { L: 6 }, children: [], ...partial });
const model = (name: string): LModel => ({
  pageId: 'page', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template', hasTemplate: false,
  tabs: [node({ id: 'tab', kind: 'tab', className: 'Tab', children: [node({ id: 'w', kind: 'widget', className: 'TextElement', name })] })],
});

/** A press as page script makes it: `isTrusted` is false. */
const scriptMouseDown = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage: vi.fn(async () => undefined) } };
});
afterEach(() => { document.body.replaceChildren(); delete (globalThis as { chrome?: unknown }).chrome; });

describe('Blueprint writes need a real user action', () => {
  it('Review and apply ignores a scripted press', () => {
    const chip = renderChip(ctx, 2);
    const apply = [...chip.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Review and apply')!;
    scriptMouseDown(apply);
    expect(openApplyPreview).not.toHaveBeenCalled();
    userMouseDown(apply);
    expect(openApplyPreview).toHaveBeenCalledTimes(1);
  });

  it('Confirm & apply ignores a scripted press', () => {
    const review = {
      env: 'p@https://bmp.test', ctx, baseline: model('Before'), desired: model('After'),
      plan: [], notes: [], script: '', changes: 1, actions: 0,
      impact: { status: 'ready', value: { fanout: null, blast: null, flowBlast: null } },
    } as const;
    const modal = previewModal(review as never, ctx);
    const confirm = [...modal.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Confirm & apply')!;
    scriptMouseDown(confirm);
    expect(confirmApply).not.toHaveBeenCalled();
    userMouseDown(confirm);
    expect(confirmApply).toHaveBeenCalledTimes(1);
  });

  it('the portable-ID switch and pattern change only on the user’s own input', () => {
    bp.ctx = ctx;
    bp.idConfig = { enabled: true, pattern: '{page}_{name}' };
    bp.idConfigStatus = 'ready';
    const panel = settingsPanel({ left: 0, top: 0 });
    document.body.appendChild(panel);
    const toggle = panel.querySelector<HTMLButtonElement>('.bp-settings-section [role="switch"]')!;
    toggle.click();
    expect(setPortableIdsEnabled).not.toHaveBeenCalled();
    toggle.dispatchEvent(asUser(new MouseEvent('click', { bubbles: true })));
    expect(setPortableIdsEnabled).toHaveBeenCalledWith(false);

    const input = panel.querySelector<HTMLInputElement>('.bp-id-pattern')!;
    // Page script writes the field, fires `input`, then blurs it.
    input.value = '{name}_forged';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur'));
    expect(input.value).toBe('{page}_{name}');
    expect(setPortableIdPatternDraft).not.toHaveBeenCalledWith('{name}_forged');
    // A tag inserted by a scripted press does nothing either.
    scriptMouseDown(panel.querySelector('.bp-id-tags button')!);
    expect(input.value).toBe('{page}_{name}');

    // The user types: that value is the one saved.
    input.value = '{class}_{name}';
    input.dispatchEvent(asUser(new Event('input', { bubbles: true })));
    input.dispatchEvent(new FocusEvent('blur'));
    expect(setPortableIdPatternDraft).toHaveBeenLastCalledWith('{class}_{name}');
    expect(persistPortableIdPattern).toHaveBeenCalled();
  });

  it('saved styles are saved and deleted only by the user', () => {
    // The real save/delete path: each sends one message to the worker.
    const sent = () => (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(c => (c[0] as { type: string }).type).filter(t => t === 'SAVE_STYLE_PRESET' || t === 'DELETE_STYLE_PRESET');
    bp.active = true;
    bp.brush.held = { fill: '#ffffff' } as never;
    bp.paintPanel = 'library';
    bp.presets = [{ id: 'p1', name: 'Mine', style: { fill: '#000000' } } as never];
    bp.presetStatus = 'ready';
    document.body.appendChild(paintPopup()!);
    const name = document.querySelector<HTMLInputElement>('.bp-paint-name')!;
    const save = [...document.querySelectorAll<HTMLButtonElement>('.bp-paint-btn')].find(b => b.textContent === '+ Save')!;
    const del = document.querySelector<HTMLButtonElement>('.bp-paint-ldel')!;
    name.value = 'Forged';
    scriptMouseDown(save);
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    scriptMouseDown(del);
    expect(sent()).toEqual([]);
    expect(name.value).toBe('Forged');
    userMouseDown(save);
    userMouseDown(del);
    expect(sent()).toEqual(['SAVE_STYLE_PRESET', 'DELETE_STYLE_PRESET']);
  });
});
