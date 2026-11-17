// @vitest-environment happy-dom
/**
 * The object picker shows the search's line for its results (a cut, IDs
 * that could not be read) under the rows, not only under an empty result.
 */
import { expect, it, vi } from 'vitest';
import { createObjectPicker, type PickerSearch } from '../object-picker';

it('shows "Showing the first N. Type more to narrow." with the results', async () => {
  const search = (async () => [{ rid: '9007199254740993', name: 'Risk view', type: 'InputView', businessId: 'risk_view' }]) as PickerSearch;
  search.notice = () => 'Showing the first 200. Type more to narrow.';
  const picker = createObjectPicker({
    source: { search, resolve: async () => ({ error: 'x' }), suggestions: async () => ({ recent: [] }) },
    label: 'Object', onPick: () => {}, onCancel: () => {}, debounceMs: 0,
  });
  document.body.append(picker.el);
  const input = picker.el.querySelector('input')!;
  input.value = 'risk';
  input.dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(picker.el.querySelector('.ui-picker-note')?.textContent).toBe('Showing the first 200. Type more to narrow.'));
  expect(picker.el.textContent).toContain('Risk view');
  picker.destroy();
});
