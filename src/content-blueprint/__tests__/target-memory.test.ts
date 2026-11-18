// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberTarget, rememberedTarget } from '../resume-note';

describe('edit target chosen for a page', () => {
  beforeEach(() => sessionStorage.clear());

  it('is remembered per page', () => {
    expect(rememberedTarget('118')).toBeNull();
    rememberTarget('118', 'instance');
    expect(rememberedTarget('118')).toBe('instance');
    expect(rememberedTarget('119')).toBeNull();
    rememberTarget('118', 'template');
    expect(rememberedTarget('118')).toBe('template');
  });

  it('ignores a value it did not write', () => {
    sessionStorage.setItem('crev_bp_target:118', 'other');
    expect(rememberedTarget('118')).toBeNull();
  });
});
