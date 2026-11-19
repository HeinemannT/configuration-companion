// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openColorPicker } from '../../lib/color-picker';
import { WorkspaceColorCatalogue } from '../../lib/workspace-color-catalogue';

let catalogue = new WorkspaceColorCatalogue();
const onColorSetsData = (m: Parameters<WorkspaceColorCatalogue['receive']>[0]) => catalogue.receive(m);

const savedSets = [{
  id: 'brand',
  name: 'Brand',
  colors: [{ bid: 'brand_red', name: 'Brand red', rgb: 'rgb(200,10,20)' }],
}];

function open() {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const sendMessage = vi.fn();
  const onPick = vi.fn();
  openColorPicker({ anchor, currentBid: null, sendMessage, onPick, catalogue });
  return { sendMessage, onPick };
}

describe('linked colour picker states', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    catalogue = new WorkspaceColorCatalogue();
  });

  it('shows loading on first open and asks the worker for colours', () => {
    const { sendMessage } = open();
    expect(document.querySelector('.cp-loading')?.textContent).toContain('Loading colours');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'FETCH_COLOR_SETS' });
  });

  it('shows a retryable error instead of treating a failed first load as empty', () => {
    const { sendMessage } = open();
    onColorSetsData({
      type: 'COLOR_SETS_DATA',
      environment: 'pro@https://bmp.example',
      sets: [],
      error: 'BMP timed out',
    });

    expect(document.querySelector('.cp-error')?.textContent).toContain('BMP timed out');
    (document.querySelector('.cp-error button') as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'FETCH_COLOR_SETS', force: true });
    expect(document.querySelector('.cp-loading')?.textContent).toContain('Loading colours');
  });

  it('keeps last-known-good colours selectable when refresh fails', () => {
    const { onPick } = open();
    onColorSetsData({
      type: 'COLOR_SETS_DATA',
      environment: 'pro@https://bmp.example',
      sets: savedSets,
      stale: true,
      error: 'BMP timed out',
    });

    expect(document.querySelector('.cp-notice--warn')?.textContent).toContain('Showing saved colours');
    const swatch = document.querySelector('.cp-swatch') as HTMLButtonElement;
    expect(swatch.textContent).toContain('Brand red');
    swatch.click();
    expect(onPick).toHaveBeenCalledWith('brand_red Brand red');
  });

  it('reads again only when Refresh is pressed, and says when the colors were read', () => {
    const { sendMessage } = open();
    onColorSetsData({ type: 'COLOR_SETS_DATA', environment: 'pro@https://bmp.example', sets: savedSets, fetchedAt: new Date(2026, 10, 19, 8, 40).getTime() });
    expect(document.querySelector('.cp-foot .cr-read')?.textContent).toBe('Read 19 Nov 08:40');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'FETCH_COLOR_SETS' });
    (document.querySelector('.cp-foot .cr-refresh') as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'FETCH_COLOR_SETS', force: true });
    expect((document.querySelector('.cp-foot .cr-refresh') as HTMLButtonElement).disabled).toBe(true);
    onColorSetsData({ type: 'COLOR_SETS_DATA', environment: 'pro@https://bmp.example', sets: savedSets, fetchedAt: new Date(2026, 10, 19, 9, 5).getTime() });
    expect(document.querySelector('.cp-foot .cr-read')?.textContent).toBe('Read 19 Nov 09:05');
  });

  it('has no read line before the colors are in', () => {
    open();
    expect(document.querySelector('.cp-foot .cr-foot')).toBeNull();
  });

  it('distinguishes a successful empty workspace from a load failure', () => {
    open();
    onColorSetsData({
      type: 'COLOR_SETS_DATA',
      environment: 'empty@https://bmp.example',
      sets: [],
    });

    expect(document.querySelector('.cp-error')).toBeNull();
    expect(document.querySelector('.cp-empty')?.textContent).toBe('No colours found.');
  });
});
