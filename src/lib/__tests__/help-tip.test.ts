/**
 * @vitest-environment happy-dom
 *
 * The "?" that explains a setting: placed once inside the window from its
 * measured size; opens on hover (after a rest), focus and click; closes on
 * leave, Escape, scroll and a press elsewhere; inside a label it does not
 * toggle the label's checkbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELP_TIP_DELAY_MS, dropStaleHelpTip, helpTip, helpTipAnchor, hideHelpTip, placeTip } from '../help-tip';
import { escapeLayers } from '../escape-layers';

const box = (left: number, top: number, width = 16, height = 16) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe('placeTip', () => {
  it('centres under the "?" when it fits', () => {
    expect(placeTip(box(150, 100), { width: 200, height: 60 }, 360, 600)).toEqual({ left: 58, top: 122, side: 'below' });
  });

  it('never leaves a narrow panel at either side', () => {
    expect(placeTip(box(4, 100), { width: 280, height: 60 }, 320, 600).left).toBe(8);
    expect(placeTip(box(300, 100), { width: 280, height: 60 }, 320, 600).left).toBe(32);
  });

  it('goes above when there is no room below, and is pinned in when neither fits', () => {
    expect(placeTip(box(150, 560), { width: 200, height: 60 }, 360, 600)).toEqual({ left: 58, top: 494, side: 'above' });
    expect(placeTip(box(150, 40), { width: 200, height: 580 }, 360, 600)).toEqual({ left: 58, top: 12, side: 'below' });
  });
});

describe('helpTip', () => {
  let b: HTMLButtonElement;
  let input: HTMLInputElement;
  const tip = () => document.getElementById('crev-help-tip')!;
  const pointer = (type: string, pointerType = 'mouse') => {
    const e = new Event(type) as Event & { pointerType: string };
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    b.dispatchEvent(e);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    const label = document.createElement('label');
    input = Object.assign(document.createElement('input'), { type: 'checkbox' });
    b = helpTip('Switches the panel to the server of the page.', 'Auto-detect');
    label.append('Auto-detect', b, input);
    document.body.append(label);
  });
  afterEach(() => { hideHelpTip(); document.body.querySelectorAll('label').forEach(l => l.remove()); vi.useRealTimers(); });

  it('is a labelled "?" button', () => {
    expect(b.type).toBe('button');
    expect(b.textContent).toBe('?');
    expect(b.getAttribute('aria-label')).toBe('About Auto-detect');
  });

  it('opens after a rest on hover and closes when the pointer leaves', () => {
    pointer('pointerenter');
    expect(helpTipAnchor()).toBeNull();
    vi.advanceTimersByTime(HELP_TIP_DELAY_MS);
    expect(helpTipAnchor()).toBe(b);
    expect(tip().textContent).toBe('Switches the panel to the server of the page.');
    expect(tip().getAttribute('role')).toBe('tooltip');
    expect(b.getAttribute('aria-describedby')).toBe('crev-help-tip');
    expect(tip().style.visibility).toBe('');
    expect(tip().style.left).toMatch(/px$/);
    pointer('pointerleave');
    expect(helpTipAnchor()).toBeNull();
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });

  it('a pointer passing through opens nothing', () => {
    pointer('pointerenter');
    vi.advanceTimersByTime(HELP_TIP_DELAY_MS / 2);
    pointer('pointerleave');
    vi.advanceTimersByTime(HELP_TIP_DELAY_MS);
    expect(helpTipAnchor()).toBeNull();
  });

  it('opens on focus at once and closes on blur', () => {
    b.dispatchEvent(new Event('focus'));
    expect(helpTipAnchor()).toBe(b);
    b.dispatchEvent(new Event('blur'));
    expect(helpTipAnchor()).toBeNull();
  });

  it('a click (or a tap) opens it and a second click closes it; the checkbox stays as it was', () => {
    b.click();
    expect(helpTipAnchor()).toBe(b);
    expect(input.checked).toBe(false);
    pointer('pointerleave', 'touch'); // a tap leaves at once; its tip stays
    expect(helpTipAnchor()).toBe(b);
    b.click();
    expect(helpTipAnchor()).toBeNull();
    expect(input.checked).toBe(false);
  });

  it('closes on Escape, on a scroll and on a press elsewhere', () => {
    b.click();
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(helpTipAnchor()).toBeNull();

    b.click();
    expect(escapeLayers(document).escape()).toBe(true);
    expect(helpTipAnchor()).toBeNull();

    b.click();
    document.dispatchEvent(new Event('scroll'));
    expect(helpTipAnchor()).toBeNull();

    b.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(helpTipAnchor()).toBeNull();
  });

  it('closes when a redraw removed its "?"', () => {
    b.click();
    b.closest('label')!.remove();
    dropStaleHelpTip();
    expect(helpTipAnchor()).toBeNull();
  });
});
