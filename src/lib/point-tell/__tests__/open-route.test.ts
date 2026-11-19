import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendFireForget = vi.fn();
vi.mock('../../messaging', () => ({ sendFireForget: (...a: unknown[]) => sendFireForget(...a) }));

import { openRoute } from '../open-route';

beforeEach(() => sendFireForget.mockClear());

describe('openRoute', () => {
  it('code opens the editor on that property of that object, with the whole new text as a proposal', () => {
    openRoute('1000000000000000001', { kind: 'code', property: 'expression', value: 'SELECT 1' });
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'OPEN_EDITOR', rid: '1000000000000000001', property: 'expression', proposal: 'SELECT 1' });
  });

  it('text opens the object window with the change as a draft, and the identity the page knows', () => {
    openRoute('1000000000000000002', { kind: 'text', property: 'buttonText', value: 'Download', name: 'Export', className: 'ActionButton' });
    expect(sendFireForget).toHaveBeenCalledWith(expect.objectContaining({ type: 'OPEN_OBJECT_VIEW', rid: '1000000000000000002', name: 'Export', objectType: 'ActionButton', draft: { prop: 'buttonText', value: 'Download' } }));
  });
});
