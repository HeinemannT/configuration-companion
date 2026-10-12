// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { objectChip, resetObjectPreview } from '../object-chip';
import { wireBadgeCopy, typeBadge } from '../type-badge';

const sendMessage = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({
    type: 'HOVER_LOOKUP_RESULT',
    rid: '9007199254740993',
    name: 'Resolved name',
    objectType: 'ExtendedTable',
    businessId: 't.results',
    templateBusinessId: 'results_template',
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
  };
});

afterEach(() => {
  resetObjectPreview();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('objectChip', () => {
  it('keeps the type badge passive and activates the object as one button', () => {
    const activate = vi.fn();
    const chip = objectChip({
      rid: '9007199254740993',
      type: 'ExtendedTable',
      businessId: 't.results',
      name: 'Results',
    }, {
      showId: true,
      onActivate: activate,
    });

    expect(chip.tagName).toBe('BUTTON');
    expect(chip.querySelector('.bdg')?.getAttribute('role')).toBeNull();
    expect(chip.querySelector('.object-chip-label')?.textContent).toBe('Results');
    expect(chip.querySelector('.object-chip-id')?.textContent).toBe('t.results');

    chip.click();
    expect(activate).toHaveBeenCalledOnce();
  });

  it('shows known identity immediately and enriches the shared preview lazily', async () => {
    const chip = objectChip({ rid: '9007199254740993' });
    document.body.appendChild(chip);

    chip.dispatchEvent(new Event('pointerenter'));
    await vi.advanceTimersByTimeAsync(449);
    expect(document.querySelector('.object-preview-host')).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const host = document.querySelector('.object-preview-host');
    expect(host?.classList.contains('object-preview-host--visible')).toBe(true);
    expect(host?.textContent).toContain('9007199254740993');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'HOVER_LOOKUP',
      rid: '9007199254740993',
    });

    await Promise.resolve();
    expect(host?.textContent).toContain('Resolved name');
    expect(host?.textContent).toContain('results_template');
    expect(host?.textContent).toContain('t.results');
  });

  it('captures the original connection for Access, even when the caller reuses its options', async () => {
    const options = { environment: 'original@https://bmp.example/' };
    const chip = objectChip({ rid: '9007199254740993', type: 'Role' }, options);
    options.environment = 'different@https://bmp.example/';
    document.body.append(chip);
    chip.dispatchEvent(new Event('focusin'));
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector<HTMLButtonElement>('[aria-label="Open role in Access"]')!.click();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'OPEN_ACCESS_WORKSPACE',
      environment: 'original@https://bmp.example/', destination: { kind: 'role', rid: '9007199254740993' } });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'HOVER_LOOKUP', rid: '9007199254740993', environment: 'original@https://bmp.example/' });
  });

  it('does not offer contextual Access when the identity has no connection provenance', async () => {
    const chip = objectChip({ rid: '9007199254740993', type: 'Role' });
    document.body.append(chip);
    chip.dispatchEvent(new Event('focusin'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.object-preview-host--visible')).not.toBeNull();
    expect(document.querySelector('[aria-label="Open role in Access"]')).toBeNull();
  });

  it('does not reuse another connection’s metadata for the same RID', async () => {
    sendMessage.mockResolvedValueOnce({ type: 'HOVER_LOOKUP_RESULT', name: 'Original role', objectType: 'Role' })
      .mockResolvedValueOnce({ type: 'HOVER_LOOKUP_RESULT', name: 'Different role', objectType: 'Role' });
    for (const environment of ['original', 'different']) {
      const chip = objectChip({ rid: '9007199254740993' }, { environment });
      document.body.append(chip);
      chip.dispatchEvent(new Event('focusin'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.object-preview-host')?.textContent).toContain('Different role');
    expect(document.querySelector('.object-preview-host')?.textContent).not.toContain('Original role');
  });

  it('dismisses the card and ignores its pending lookup after a connection reset', async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const chip = objectChip({ rid: '9007199254740993', type: 'Role' }, { environment: 'original' });
    document.body.append(chip);
    chip.dispatchEvent(new Event('focusin'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[aria-label="Open role in Access"]')).not.toBeNull();
    resetObjectPreview();
    finish({ type: 'HOVER_LOOKUP_RESULT', name: 'Late response', objectType: 'Role' });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.object-preview-host')).toBeNull();
  });
});

describe('wireBadgeCopy', () => {
  it('provides keyboard parity for the legacy copy gesture', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onCopied = vi.fn();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const badge = wireBadgeCopy(typeBadge('Container'), () => 't.container', { onCopied });

    expect(badge.getAttribute('role')).toBe('button');
    expect(badge.tabIndex).toBe(0);
    badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(writeText).toHaveBeenCalledWith('t.container');
    await Promise.resolve();
    expect(onCopied).toHaveBeenCalledWith('t.container');
  });

  it('keeps the badge label stable and restarts feedback on repeated copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const badge = wireBadgeCopy(typeBadge('Container'), () => 't.container');
    const label = badge.querySelector('.lbl');

    badge.click();
    await Promise.resolve();
    expect(label?.textContent).toBe('CON');
    expect(badge.classList.contains('bdg-copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    badge.click();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(label?.textContent).toBe('CON');
    expect(badge.classList.contains('bdg-copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(badge.classList.contains('bdg-copied')).toBe(false);
  });

  it('does not report success when the clipboard write fails', async () => {
    const onCopied = vi.fn();
    const onCopyError = vi.fn();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    });
    const badge = wireBadgeCopy(typeBadge('Container'), () => 't.container', {
      onCopied,
      onCopyError,
    });

    badge.click();
    await Promise.resolve();
    expect(onCopied).not.toHaveBeenCalled();
    expect(onCopyError).toHaveBeenCalledOnce();
    expect(badge.classList.contains('bdg-copied')).toBe(false);
  });
});
