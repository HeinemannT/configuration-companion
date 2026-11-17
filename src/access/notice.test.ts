// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { renderNotice } from './notice';
it('keeps operation context actionable, treats diagnostics as text, and can be dismissed', () => {
  const host=document.createElement('div'), open=vi.fn();
  renderNotice(host,'Unknown ActionButton\n<script>bad()</script>',{ tone:'error', title:'Could not apply changes', targets:[{label:'Risk owner',open}] });
  expect(host.getAttribute('role')).toBe('alert');
  expect(host.dataset.tone).toBe('error');
  expect(host.textContent).toContain('Working on:');
  expect(host.querySelector('script')).toBeNull();
  host.querySelector<HTMLButtonElement>('.notice-targets button')!.click(); expect(open).toHaveBeenCalledOnce();
  host.querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!.click(); expect(host.hidden).toBe(true);
  renderNotice(host,'Recovered'); expect(host.dataset.tone).toBe('info'); expect(host.querySelector('.notice-targets')).toBeNull();
  renderNotice(host,''); expect(host.hidden).toBe(true);
});
