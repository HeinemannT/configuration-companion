/**
 * confirmModal: which button has the focus when the dialog opens. A destructive confirm starts on
 * Cancel, so Enter keeps the work; every other confirm starts on its confirm button.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { confirmModal } from '../modal';

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('confirmModal initial focus', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('starts a destructive confirm on Cancel', async () => {
    const answer = confirmModal({ title: 'Discard?', body: 'x', confirmLabel: 'Discard', cancelLabel: 'Keep editing', confirmVariant: 'danger' });
    await frame();
    expect(document.activeElement?.textContent).toBe('Keep editing');
    press('Escape');
    expect(await answer).toBe(false);
  });

  it('starts any other confirm on its confirm button', async () => {
    const answer = confirmModal({ title: 'Save?', body: 'x', confirmLabel: 'Save changes', cancelLabel: 'Cancel', confirmVariant: 'success' });
    await frame();
    expect(document.activeElement?.textContent).toBe('Save changes');
    press('Escape');
    expect(await answer).toBe(false);
  });
});
