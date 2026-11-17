// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../content-state';
import {
  OBJECT_CARD_INITIAL_DELAY,
  placeCard,
  scheduleTooltipForElement,
  setInputModality,
  showTooltipForElement,
  hideTooltip,
  OBJECT_CARD_LEAVE_DELAY,
  wireObjectPopover,
} from '../content-tooltip';

vi.mock('../lib/messaging', () => ({
  sendRequest: vi.fn(),
  sendFireForget: vi.fn(),
}));

function mountLabel(rid: string): { label: HTMLElement; trigger: HTMLElement } {
  const label = document.createElement('span');
  label.className = 'crev-label';
  label.dataset.crevLabel = rid;
  const trigger = document.createElement('span');
  trigger.className = 'crev-stub';
  trigger.tabIndex = 0;
  label.appendChild(trigger);
  document.body.appendChild(label);
  return { label, trigger };
}

describe('rich object popover', () => {
  let state: ContentState;
  let tooltip: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.querySelector('#crev-tooltip')?.remove();
    state = new ContentState();
    state.enrichments.set('123', {
      name: 'Risk register',
      type: 'ExtendedTable',
      businessId: 'sc_risk_register',
    });
    tooltip = document.createElement('div');
    tooltip.id = 'crev-tooltip';
    document.documentElement.appendChild(tooltip);
    wireObjectPopover(state, tooltip);
  });

  afterEach(() => {
    state.resetAll();
    tooltip.remove();
    vi.useRealTimers();
  });

  it('opens from keyboard focus with dialog semantics', () => {
    const { trigger } = mountLabel('123');

    setInputModality(true);
    trigger.focus();

    expect(tooltip.classList.contains('crev-visible')).toBe(true);
    expect(tooltip.getAttribute('role')).toBe('dialog');
    expect(tooltip.getAttribute('aria-label')).toBe('Details of Risk register');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('is one tab stop: Enter moves into the card, arrows walk it, Escape returns focus', () => {
    const { trigger } = mountLabel('123');
    setInputModality(true);
    trigger.focus();
    // Card controls are not tab stops of their own.
    expect([...tooltip.querySelectorAll<HTMLElement>('button')].every(b => b.tabIndex === -1)).toBe(true);

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(tooltip.contains(document.activeElement)).toBe(true);
    const first = document.activeElement;
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).not.toBe(first);
    expect(tooltip.contains(document.activeElement)).toBe(true);

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));

    expect(tooltip.classList.contains('crev-visible')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores pointer fly-over until the intent delay completes', async () => {
    const { label } = mountLabel('123');
    state.hoveredLabelEl = label;

    scheduleTooltipForElement(state, label, '123');
    await vi.advanceTimersByTimeAsync(OBJECT_CARD_INITIAL_DELAY - 1);
    expect(tooltip.classList.contains('crev-visible')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(tooltip.classList.contains('crev-visible')).toBe(true);
  });

  it('shows one row per identity kind, a Reference row and the click legend', () => {
    state.enrichments.set('124', { name: 'Issue', type: 'CeIssue', businessId: '716', templateBusinessId: 'issue_tpl' });
    const { label } = mountLabel('124');
    showTooltipForElement(state, label, '124');
    const rows = [...tooltip.querySelectorAll('.crev-tt-cprow')].map(r => [r.querySelector('.crev-tt-k')?.textContent, r.querySelector('.crev-tt-v')?.textContent]);
    expect(rows).toEqual([['ID', 'issue_tpl'], ['Instance ID', '716'], ['RID', '124'], ['Reference', 'ceiss.716']]);
    expect(tooltip.querySelector('.crev-tt-legend')?.textContent).toBe('ClickIDShiftRIDAltInstance IDCtrlReference');
  });

  it('has one hint row and no hover texts except on the header icon buttons', () => {
    const { label } = mountLabel('123');
    showTooltipForElement(state, label, '123');
    const legends = tooltip.querySelectorAll('.crev-tt-legend');
    expect(legends.length).toBe(1);
    expect(legends[0]?.textContent).toBe('ClickIDShiftRIDCtrlReference');
    const titled = [...tooltip.querySelectorAll('[title]')];
    expect(titled.length).toBeGreaterThan(0);
    expect(titled.every(el => el.classList.contains('crev-tt-open') && el.hasAttribute('aria-label'))).toBe(true);
    for (const row of tooltip.querySelectorAll('.crev-tt-cprow')) expect(row.getAttribute('aria-label')).toMatch(/^Copy /);
  });

  it('a card row copies through the badge copy path with a toast', async () => {
    vi.useRealTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { label } = mountLabel('123');
    showTooltipForElement(state, label, '123');
    tooltip.querySelector<HTMLElement>('[data-copy-kind="reference"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('t.sc_risk_register'));
    await vi.waitFor(() => expect(document.querySelector('.crev-toast')?.textContent).toBe('Copied Referencet.sc_risk_register'));
  });
});

describe('hover card placement', () => {
  const W = 272, H = 180, VW = 1280, VH = 800;
  const box = (top: number, left: number, w = 80, h = 44) => ({ top, left, bottom: top + h, right: left + w });
  const overlapsAnchor = (p: { top: number; left: number }, a: ReturnType<typeof box>) =>
    p.left < a.right && a.left < p.left + W && p.top < a.bottom && a.top < p.top + H;

  it('opens below the badge when it fits', () => {
    expect(placeCard(box(100, 200), W, H, VW, VH)).toMatchObject({ top: 148, left: 200, side: 'below' });
  });

  it('opens above near the viewport bottom and keeps inside horizontally', () => {
    const a = box(700, 1250);
    const p = placeCard(a, W, H, VW, VH);
    expect(p.side).toBe('above');
    expect(p.left + W).toBeLessThanOrEqual(VW - 8);
    expect(overlapsAnchor(p, a)).toBe(false);
  });

  it('opens beside a badge when neither below nor above has room', () => {
    const a = box(100, 300, 80, 600);
    const p = placeCard(a, W, H, VW, VH);
    expect(p.side).toBe('right');
    expect(overlapsAnchor(p, a)).toBe(false);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it('scrolls the card in a tiny viewport instead of leaving it', () => {
    const p = placeCard(box(10, 10, 80, 20), W, H, 300, 140);
    expect(p.maxHeight).toBeGreaterThan(0);
    expect(p.top + (p.maxHeight ?? H)).toBeLessThanOrEqual(140);
  });
});

describe('a pointer click never leaves the card held open (review 4, item 1)', () => {
  it('click badge A, move away, click badge B with each modifier: B is copied', async () => {
    vi.useRealTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    document.body.innerHTML = '';
    const { createIdentityLabel } = await import('../content-overlays');
    const state = new ContentState();
    state.enrichments.set('901', { name: 'A', type: 'TextElement', businessId: 'a_id' });
    state.enrichments.set('902', { name: 'B', type: 'TextElement', businessId: 'b_id' });
    const tooltip = document.createElement('div');
    tooltip.id = 'crev-tooltip';
    document.documentElement.appendChild(tooltip);
    wireObjectPopover(state, tooltip);
    const a = createIdentityLabel(state, '901');
    const b = createIdentityLabel(state, '902');
    document.body.append(a, b);
    const stubA = a.querySelector<HTMLElement>('.crev-stub')!;
    const stubB = b.querySelector<HTMLElement>('.crev-stub')!;

    // Pointer click on A: the pointer, not the keyboard, put focus there.
    stubA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    stubA.focus();
    stubA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, shiftKey: true }));
    expect(tooltip.classList.contains('crev-visible')).toBe(false);
    // Even if the card was open from hovering A, leaving closes it.
    showTooltipForElement(state, a, '901');
    hideTooltip(state);
    await new Promise(r => setTimeout(r, OBJECT_CARD_LEAVE_DELAY + 20));
    expect(tooltip.classList.contains('crev-visible')).toBe(false);
    writeText.mockClear();

    for (const [mods, value] of [[{ shiftKey: true }, '902'], [{ altKey: true }, 'b_id'], [{ ctrlKey: true }, 't.b_id']] as const) {
      stubB.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      stubB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...mods }));
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(value));
    }
    stubB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('b_id'));
    expect(writeText.mock.calls.flat().some(v => String(v).includes('901') || String(v).includes('a_id'))).toBe(false);
    state.resetAll();
    tooltip.remove();
  });
});

