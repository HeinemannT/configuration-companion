// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendFireForget = vi.fn();
const sendToSW = vi.fn();
vi.mock('../lib/messaging', () => ({ sendFireForget: (m: unknown) => sendFireForget(m) }));
vi.mock('../lib/content-port', () => ({ sendToSW: (m: unknown) => sendToSW(m) }));

const { ContentState } = await import('../content-state');
const { createIdentityLabel, SINGLE_CLICK_DELAY } = await import('../content-overlays');

const sent = () => [...sendFireForget.mock.calls, ...sendToSW.mock.calls].map(c => c[0] as { type: string });

describe('page badge senders (no side panel)', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sendFireForget.mockClear();
    sendToSW.mockClear();
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    document.body.replaceChildren();
    document.getElementById('crev-toast-container')?.remove();
  });

  function label(type: string, cascade?: { rid: string; businessId?: string; type?: string; name?: string }) {
    const s = new ContentState();
    s.enrichments.set('700', { type, businessId: 'iv_main', name: 'Main view', ...(cascade ? { cascade } : {}) });
    const el = createIdentityLabel(s, '700', undefined, type === 'EditField' ? { rid: '701', businessId: 'riskOwner', type: 'ReferenceMethodConfig' } : undefined);
    document.body.append(el);
    return el;
  }

  const stub = (el: HTMLElement) => el.querySelector<HTMLElement>('.crev-stub')!;
  const click = (el: HTMLElement, init: MouseEventInit = {}) =>
    stub(el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }));
  const toasts = () => [...document.querySelectorAll('.crev-toast')].map(t => t.textContent);

  it('a plain click copies the ID after a short wait and sets the current position, never SELECT_OBJECT', async () => {
    vi.useFakeTimers();
    try {
      click(label('TextElement'));
      expect(sendFireForget).toHaveBeenCalledWith({
        type: 'SET_CONTEXT_RID', rid: '700', source: 'badge', name: 'Main view', objectType: 'TextElement', businessId: 'iv_main',
      });
      expect(writeText).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
      expect(writeText).toHaveBeenCalledWith('iv_main');
      expect(toasts()).toEqual(['Copied IDiv_main']);
      expect(sent().some(m => m.type === 'SELECT_OBJECT')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    [{ shiftKey: true }, '700', 'Copied RID700'],
    // Alt on an object whose instance ID is its ID: copies the ID, named so.
    [{ altKey: true }, 'iv_main', 'Copied IDiv_main'],
    [{ ctrlKey: true }, 't.iv_main', 'Copied Referencet.iv_main'],
    [{ metaKey: true }, 't.iv_main', 'Copied Referencet.iv_main'],
  ])('a modifier click %o copies at once and still sets the position', async (mods, text, toast) => {
    click(label('TextElement'), mods);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    expect(sent().map(m => m.type)).toEqual(['SET_CONTEXT_RID']);
    await vi.waitFor(() => expect(toasts()).toEqual([toast]));
  });

  it('a double-click opens the object window and copies nothing', async () => {
    vi.useFakeTimers();
    try {
      const el = label('TextElement');
      click(el);
      click(el, { detail: 2 });
      stub(el).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
      await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
      expect(writeText).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
      expect(sendFireForget).toHaveBeenCalledWith(expect.objectContaining({ type: 'OPEN_OBJECT_VIEW', rid: '700' }));
    } finally { vi.useRealTimers(); }
  });

  it('a kind without a value copies nothing and says so', async () => {
    const s = new ContentState();
    s.enrichments.set('701', { type: 'TextElement', name: 'No id' });
    const el = createIdentityLabel(s, '701');
    document.body.append(el);
    click(el, { ctrlKey: true });
    await vi.waitFor(() => expect(toasts()).toEqual(['No Reference to copy: this object has no ID']));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a blocked clipboard shows an error toast as an alert', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    click(label('TextElement'), { shiftKey: true });
    await vi.waitFor(() => expect(document.querySelector('.crev-toast--error')?.getAttribute('role')).toBe('alert'));
  });

  it('copy toasts replace each other instead of stacking', async () => {
    const el = label('TextElement');
    click(el, { shiftKey: true });
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    click(el, { ctrlKey: true });
    await vi.waitFor(() => expect(toasts()).toEqual(['Copied Referencet.iv_main']));
  });

  it('has no separate arrow square: the double-click already opens the object', () => {
    expect(label('InputView').querySelector('.crev-sub--flow')).toBeNull();
  });

  it('the cascade chip opens the linked object', () => {
    const chip = label('InputView', { rid: '800', businessId: 'set_main', type: 'InputSet' }).querySelector<HTMLElement>('.crev-cascade')!;
    expect(chip.title).toContain('object window');
    // The end cap: the linked type's icon, the ID inside for hover, welded to the badge.
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.querySelector('.crev-cascade-id')?.textContent).toBe('set_main');
    expect(chip.closest('.crev-label')?.classList.contains('crev-label--linked')).toBe(true);
    expect(chip.parentElement?.firstElementChild).toBe(chip);
    chip.click();
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'OPEN_OBJECT_VIEW', rid: '800', objectType: 'InputSet', businessId: 'set_main' });
    expect(sent().some(m => m.type === 'SELECT_OBJECT')).toBe(false);
  });

  it('the property chip opens the property', () => {
    const chip = label('EditField').querySelector<HTMLElement>('.crev-sub--property')!;
    expect(chip.title).toContain('object window');
    chip.click();
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'OPEN_OBJECT_VIEW', rid: '701', objectType: 'ReferenceMethodConfig', businessId: 'riskOwner' });
  });

  it('Alt copies a distinct Instance ID and names it so', async () => {
    const s = new ContentState();
    s.enrichments.set('702', { type: 'CeIssue', businessId: '716', templateBusinessId: 'issue_tpl', name: 'Issue 716' });
    const el = createIdentityLabel(s, '702');
    document.body.append(el);
    click(el, { altKey: true });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('716'));
    await vi.waitFor(() => expect(toasts()).toEqual(['Copied Instance ID716']));
  });

  it('names each badge by its object and describes the click scheme', () => {
    const st = stub(label('TextElement'));
    expect(st.getAttribute('aria-label')).toBe('Copy ID of Main view');
    expect(st.getAttribute('aria-description')).toContain('Shift copies RID');
  });
});
