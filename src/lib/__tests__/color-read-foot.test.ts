// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { colorReadFoot } from '../color-read-foot';

describe('color read foot', () => {
  it('says when the colors were read and offers Refresh', () => {
    const onRefresh = vi.fn();
    const foot = colorReadFoot({ at: new Date(2026, 10, 19, 8, 40).getTime(), busy: false, onRefresh });
    expect(foot.textContent).toBe('Read 19 Nov 08:40·Refresh');
    foot.querySelector<HTMLButtonElement>('.cr-refresh')!.click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('says so when the date is not known, and waits while a read runs', () => {
    const onRefresh = vi.fn();
    const foot = colorReadFoot({ at: null, busy: true, onRefresh });
    expect(foot.querySelector('.cr-read')?.textContent).toBe('Not read');
    const refresh = foot.querySelector<HTMLButtonElement>('.cr-refresh')!;
    expect(refresh.disabled).toBe(true);
    refresh.click();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('sets its layout inline, so a missing stylesheet cannot drop it out of line', () => {
    const foot = colorReadFoot({ at: 1, busy: false, onRefresh: () => {} });
    expect(foot.style.display).toBe('flex');
    expect(foot.style.flexShrink).toBe('0');
  });

  it('does not let a press reach the page behind the popover', () => {
    const foot = colorReadFoot({ at: 1, busy: false, onRefresh: () => {} });
    const seen = vi.fn();
    document.body.addEventListener('mousedown', seen);
    document.body.append(foot);
    foot.querySelector('.cr-refresh')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.removeEventListener('mousedown', seen);
    expect(seen).not.toHaveBeenCalled();
  });
});
