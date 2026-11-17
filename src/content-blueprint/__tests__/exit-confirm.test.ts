// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { askDiscard, discardTitle, exitDecision, exitPromptOpen, keepEditing } from '../exit-confirm';

describe('exitDecision', () => {
  it('leaves at once with nothing unsaved', () => expect(exitDecision({ pending: 0, applying: false })).toBe('leave'));
  it('asks with unsaved changes', () => expect(exitDecision({ pending: 3, applying: false })).toBe('ask'));
  it('never leaves while an Apply is writing', () => expect(exitDecision({ pending: 0, applying: true })).toBe('busy'));
});

describe('askDiscard', () => {
  beforeEach(() => { keepEditing(); document.body.textContent = ''; });

  it('names the count', () => {
    expect(discardTitle(1)).toBe('Discard 1 unsaved change?');
    expect(discardTitle(3)).toBe('Discard 3 unsaved changes?');
  });

  it('Discard resolves true and removes the dialog', async () => {
    const p = askDiscard(2, { host: document.body });
    expect(document.querySelector('.bp-modal-h')?.textContent).toBe('Discard 2 unsaved changes?');
    expect(document.activeElement?.textContent).toBe('Keep editing');
    (document.querySelector('.bp-leave-discard') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(true);
    expect(document.querySelector('.bp-leave')).toBeNull();
    expect(exitPromptOpen()).toBe(false);
  });

  it('Keep editing (button, outside click or the Escape layer) resolves false', async () => {
    const p = askDiscard(1, { host: document.body });
    (document.querySelector('.bp-modal-foot .apply') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(false);
    const q = askDiscard(1, { host: document.body });
    keepEditing(); // what the Escape layer calls
    await expect(q).resolves.toBe(false);
  });

  it('concurrent asks share one dialog', async () => {
    const a = askDiscard(2, { host: document.body });
    const b = askDiscard(2, { host: document.body });
    expect(document.querySelectorAll('.bp-leave').length).toBe(1);
    (document.querySelector('.bp-leave-discard') as HTMLButtonElement).click();
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it('returns focus to the control that opened it', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const p = askDiscard(1, { host: document.body });
    keepEditing();
    await p;
    expect(document.activeElement).toBe(opener);
  });
});

describe('the confirm outlives a Blueprint re-render', () => {
  it('exposes its element while open so render can put it back', async () => {
    const { exitPromptElement } = await import('../exit-confirm');
    const host = document.createElement('div');
    document.body.append(host);
    const p = askDiscard(1, { host });
    const el = exitPromptElement();
    expect(el).not.toBeNull();
    host.textContent = ''; // what render() does
    host.append(el!);
    (host.querySelector('.bp-leave-discard') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(true);
    expect(exitPromptElement()).toBeNull();
  });
});
