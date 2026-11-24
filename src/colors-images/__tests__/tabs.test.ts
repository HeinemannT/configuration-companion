// @vitest-environment happy-dom
/**
 * The two tabs of the Colors and images page against a fake server: what is
 * shown, what the confirm bar lists, what a save sends and how it checks the
 * answer. The service worker is not involved: `../api` is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorSetData } from '../../lib/types';

const api = vi.hoisted(() => ({
  readColors: vi.fn(),
  readImages: vi.fn(),
  readImageBytes: vi.fn(),
  writeChanges: vi.fn(),
}));
vi.mock('../api', () => api);
vi.mock('../../lib/colors-images/image-process', async importOriginal => ({
  ...(await importOriginal<typeof import('../../lib/colors-images/image-process')>()),
  // No canvas here: a processed image is its source bytes.
  processImage: vi.fn(async (source: { bytes: Uint8Array; mime: string }) => ({ bytes: source.bytes, mime: source.mime, width: 24, height: 24 })),
}));

import { processImage } from '../../lib/colors-images/image-process';
import { createColorsTab } from '../colors-tab';
import { createImagesTab } from '../images-tab';
import { SAVED_MS, type PageCtx } from '../common';

const ctx: PageCtx = { environment: 'p1@https://bmp.example.test/', work: t => t, openTab: () => {} };
const flush = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await flush(); };
/** Waits for work that takes real time (reading, compressing and drawing a file), however slow the machine. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

function sets(hex = 'rgb(31,95,168)'): ColorSetData[] {
  return [
    { id: 'swi_brand', name: 'Steadfast brand', folder: 'swi', colors: [{ bid: 'swi_blue', name: 'Steadfast blue', rgb: hex }, { bid: 'swi_navy', name: 'Steadfast navy', rgb: 'rgb(12,45,87)' }] },
    { id: 'swi_status', name: 'Status', folder: 'swi', colors: [{ bid: 'swi_ok', name: 'OK', rgb: 'rgb(46,125,50)' }] },
  ];
}

const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
const saveButton = (tab: { root: HTMLElement }) => tab.root.querySelector<HTMLButtonElement>('.ci-sb .ui-btn.primary')!;
/** Open Review (or Details) and return the rows it lists. */
const review = (tab: { root: HTMLElement }): HTMLElement[] => {
  if (!tab.root.querySelector('.ci-sb-panel')) tab.root.querySelector<HTMLButtonElement>('.ci-sb-review')!.click();
  return [...tab.root.querySelectorAll<HTMLElement>('.ci-sb-panel .ci-prow')];
};
const closeReview = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

describe('Colors tab', () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });

  it('shows the sets and the colors of the chosen one, with the date the copy was read', async () => {
    api.readColors.mockResolvedValue({ sets: sets(), fetchedAt: new Date(2026, 10, 19, 8, 40).getTime() });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    expect([...tab.root.querySelectorAll('.ci-srow-name')].map(e => e.textContent)).toEqual(['Steadfast brand', 'Status']);
    expect([...tab.root.querySelectorAll('.ci-ctile:not(.add) .ci-nm')].map(e => e.textContent)).toEqual(['Steadfast blue', 'Steadfast navy']);
    expect(tab.root.querySelector('.ci-read')?.textContent).toBe('Read 19 Nov 08:40');
    // Read once, never by itself again.
    expect(api.readColors).toHaveBeenCalledTimes(1);
    expect(api.readColors).toHaveBeenCalledWith(false);
    // The editor shows the chosen color with the contrast of white and black text on it.
    expect(tab.root.querySelectorAll('.ci-ontext > div')).toHaveLength(2);
    expect((tab.root.querySelector('.ci-hexrow input') as HTMLInputElement).value).toBe('#1F5FA8');
  });

  it('lists a change in one confirm bar that says it changes the color everywhere it is linked, sends it, and checks the fresh read', async () => {
    api.readColors.mockResolvedValueOnce({ sets: sets(), fetchedAt: 1 });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '#1a56a0');
    const bar = tab.root.querySelector<HTMLElement>('.ci-savebar')!;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.ci-sb-text')?.textContent).toBe('1 unsaved change');
    expect(review(tab)[0].textContent).toContain('#1F5FA8 → #1A56A0');
    expect(bar.querySelector('.ci-sb-pnote')?.textContent).toBe('Changes it everywhere it is linked.');
    expect(tab.hasUnsaved()).toBe(true);

    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    api.readColors.mockResolvedValueOnce({ sets: sets('rgb(26,86,160)'), fetchedAt: 2 });
    saveButton(tab).click();
    await settle();
    expect(api.writeChanges).toHaveBeenCalledWith('p1@https://bmp.example.test/', [{ kind: 'change', id: 'swi_blue', hex: '#1A56A0' }], []);
    expect(api.readColors).toHaveBeenLastCalledWith(true);
    // The bar says so in its own place, then leaves.
    expect(tab.root.querySelector('.ci-sb.ok .ci-sb-text')?.textContent).toBe('Saved 1 change');
    expect(tab.root.querySelector('.ci-sb-review, .ci-sb .ui-btn')).toBeNull();
    expect(tab.hasUnsaved()).toBe(false);
  });

  it('says so when the server does not hold what was sent, and keeps nothing it did not write', async () => {
    api.readColors.mockResolvedValueOnce({ sets: sets(), fetchedAt: 1 });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '#1A56A0');
    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    api.readColors.mockResolvedValueOnce({ sets: sets(), fetchedAt: 2 });
    saveButton(tab).click();
    await settle();
    expect(tab.root.querySelector('.ci-result')?.textContent).toContain('does not hold it as sent');
    expect(tab.root.querySelector('.ci-result')?.classList.contains('bad')).toBe(true);
  });

  it('keeps the changes and shows the refusal when the write fails', async () => {
    api.readColors.mockResolvedValueOnce({ sets: sets(), fetchedAt: 1 });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '#1A56A0');
    api.writeChanges.mockResolvedValue({ ok: false, written: 0, error: 'BMP would not write all of it' });
    saveButton(tab).click();
    await settle();
    expect(tab.root.querySelector('.ci-sb.bad .ci-sb-text')?.textContent).toBe('Not saved.');
    expect(tab.root.querySelector('.ci-sb-review')?.textContent).toBe('Details');
    review(tab);
    expect(tab.root.querySelector('.ci-sb-pmsg')?.textContent).toBe('BMP would not write all of it');
    expect(tab.root.querySelector('.ci-prow .ci-pstate')?.textContent).toBe('Not saved');
    expect(tab.hasUnsaved()).toBe(true);
    expect(api.readColors).toHaveBeenCalledTimes(1);
  });

  it('adds a set and a color with proposed IDs, and has no delete', async () => {
    api.readColors.mockResolvedValueOnce({ sets: sets(), fetchedAt: 1 });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    tab.root.querySelector<HTMLButtonElement>('.ci-side-h .ci-ib')!.click();
    const name = tab.root.querySelector<HTMLInputElement>('.ci-addset input')!;
    name.value = 'Charts';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    tab.root.querySelector<HTMLButtonElement>('.ci-ctile.add')!.click();
    type(tab.root.querySelector('.ci-name') as HTMLInputElement, 'Signal orange');
    expect((tab.root.querySelector('.ci-newid') as HTMLInputElement).value).toBe('swi_charts_signal_orange');
    expect(review(tab).map(r => r.querySelector('.ci-pname')?.textContent)).toEqual(['Charts', 'Signal orange']);
    expect(tab.root.textContent).not.toMatch(/delete/i);
    api.writeChanges.mockResolvedValue({ ok: true, written: 2 });
    api.readColors.mockResolvedValueOnce({ sets: [...sets(), { id: 'swi_charts', name: 'Charts', colors: [{ bid: 'swi_charts_signal_orange', name: 'Signal orange', rgb: 'rgb(128,128,128)' }] }], fetchedAt: 2 });
    saveButton(tab).click();
    await settle();
    expect(api.writeChanges.mock.calls[0][1]).toEqual([
      { kind: 'addSet', besideSetId: 'swi_brand', id: 'swi_charts', name: 'Charts' },
      { kind: 'add', setId: 'swi_charts', id: 'swi_charts_signal_orange', name: 'Signal orange', hex: '#808080' },
    ]);
    expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('Saved 2 changes');
  });

  async function openedColors() {
    api.readColors.mockResolvedValue({ sets: sets(), fetchedAt: 1 });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await until(() => expect(tab.root.querySelector('.ci-addmenu')).not.toBeNull());
    return tab;
  }
  const menuItem = (tab: { root: HTMLElement }, text: string) => {
    tab.root.querySelector<HTMLButtonElement>('.ci-addmenu')!.click();
    return [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-menu button')].find(b => b.textContent?.startsWith(text))!;
  };

  it('adds pasted colors after review: names from the labels, a row left out, a name edited, a close one marked, one confirmed write', async () => {
    const tab = await openedColors();
    menuItem(tab, 'Paste colors').click();
    const area = tab.root.querySelector<HTMLTextAreaElement>('.ci-paste')!;
    area.value = '--brand-blue: #1F5FA9;\nSignal orange  #E8742A\nSurface rgb(246, 244, 239)';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = () => [...tab.root.querySelectorAll<HTMLElement>('.ci-frow')];
    expect(rows().map(r => (r.querySelector('input') as HTMLInputElement).value)).toEqual(['Brand blue', 'Signal orange', 'Surface']);
    // #1F5FA9 is a re-typed Steadfast blue.
    expect(rows()[0].querySelector('.ci-fwarn')?.getAttribute('title')).toBe('Close to Steadfast blue #1F5FA8');
    rows()[2].querySelector<HTMLButtonElement>('.ci-ib')!.click();
    type(rows()[1].querySelector('input') as HTMLInputElement, 'Signal');
    const add = tab.root.querySelector<HTMLButtonElement>('.ci-panel .ui-btn.primary')!;
    expect(add.textContent).toBe('Add 2 colors');
    add.click();
    expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('2 unsaved changes');
    api.writeChanges.mockResolvedValue({ ok: true, written: 2 });
    saveButton(tab).click();
    await until(() => expect(api.writeChanges).toHaveBeenCalled());
    expect(api.writeChanges.mock.calls[0][1]).toEqual([
      { kind: 'add', setId: 'swi_brand', id: 'swi_brand_blue', name: 'Brand blue', hex: '#1F5FA9' },
      { kind: 'add', setId: 'swi_brand', id: 'swi_signal', name: 'Signal', hex: '#E8742A' },
    ]);
  });

  it('previews a scale of five steps from the chosen color and adds the four new ones named after it', async () => {
    const tab = await openedColors();
    menuItem(tab, 'Scale from').click();
    expect(tab.root.querySelectorAll('.ci-strip i')).toHaveLength(5);
    expect([...tab.root.querySelectorAll('.ci-scale .ci-sname')].map(e => e.textContent)).toEqual(['Steadfast blue 100', 'Steadfast blue 300', 'Steadfast blue', 'Steadfast blue 700', 'Steadfast blue 900']);
    tab.root.querySelector<HTMLButtonElement>('.ci-panel .ui-btn.primary')!.click();
    expect(review(tab).map(r => r.querySelector('.ci-pname')?.textContent)).toEqual(['Steadfast blue 100', 'Steadfast blue 300', 'Steadfast blue 700', 'Steadfast blue 900']);
    expect(api.writeChanges).not.toHaveBeenCalled();
  });

  it('marks a new color close to one in the sets, offers where white text passes, and takes RGB', async () => {
    const tab = await openedColors();
    tab.root.querySelector<HTMLButtonElement>('.ci-ctile.add')!.click();
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '#0C2E58');
    expect(tab.root.querySelector<HTMLElement>('.ci-close')!.hidden).toBe(false);
    expect(tab.root.querySelector('.ci-close')?.textContent).toContain('Close to Steadfast navy');
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '#0F8A9D');
    expect(tab.root.querySelector<HTMLElement>('.ci-close')!.hidden).toBe(true);
    const nudge = tab.root.querySelector<HTMLElement>('.ci-nudge')!;
    expect(nudge.hidden).toBe(false);
    nudge.querySelector<HTMLButtonElement>('.ci-link')!.click();
    const now = (tab.root.querySelector('.ci-hexrow input') as HTMLInputElement).value;
    expect(now).not.toBe('#0F8A9D');
    expect(tab.root.querySelector<HTMLElement>('.ci-nudge')!.hidden).toBe(true);
    const fmt = tab.root.querySelector<HTMLSelectElement>('.ci-fmtsel')!;
    fmt.value = 'rgb'; fmt.dispatchEvent(new Event('change'));
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '26, 86, 160');
    expect(review(tab)[0].textContent).toContain('#1A56A0');
  });

  it('turns Refresh off while changes are unsaved, and reads again only when asked', async () => {
    api.readColors.mockResolvedValue({ sets: sets(), fetchedAt: 1 });
    const tab = createColorsTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    const refresh = () => tab.root.querySelector<HTMLButtonElement>('.ci-side-f .ci-link')!;
    refresh().click();
    await settle();
    expect(api.readColors).toHaveBeenLastCalledWith(true);
    type(tab.root.querySelector('.ci-hexrow input') as HTMLInputElement, '#1A56A0');
    expect(refresh().disabled).toBe(true);
  });
});

const FOLDERS = [{ id: 'nav', name: 'Icons - Navigation', parentId: 'EXTERNALRESOURCE' }, { id: 'libs', name: 'Libraries', parentId: 'EXTERNALRESOURCE' }];
const FILES = [
  { rid: '9007199254740993', id: 'icon_home', name: 'home.png', folderId: 'nav' },
  { rid: '9007199254740995', id: 'icon_risk', name: 'risk.png', folderId: 'nav' },
];

describe('Images tab', () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })); });

  async function opened() {
    api.readImages.mockResolvedValue({ folders: FOLDERS, files: FILES, fetchedAt: new Date(2026, 10, 19, 8, 40).getTime() });
    api.readImageBytes.mockImplementation(async (rids: string[]) => rids.map(rid => ({ rid, base64: 'iVBORw0KGgo=' })));
    const tab = createImagesTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    return tab;
  }

  it('shows only the folders that hold images, with counts, and the images with their IDs', async () => {
    const tab = await opened();
    expect([...tab.root.querySelectorAll('.ci-sec.bmp .ci-srow')].map(r => r.textContent)).toEqual(['All images2', 'Icons - Navigation2']);
    expect([...tab.root.querySelectorAll('.ci-itile:not(.drop) .ci-nm')].map(e => e.textContent)).toEqual(['home.png', 'risk.png']);
    expect(tab.root.querySelector('.ci-read')?.textContent).toBe('Read 19 Nov 08:40');
    expect(api.readImages).toHaveBeenCalledWith(false);
  });

  it('adds dropped files under New with IDs in the style of the folder, and sends them on one confirmed save', async () => {
    const tab = await opened();
    const input = tab.root.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = (name: string, text: string) => Object.assign(new File([text], name), { arrayBuffer: async () => new TextEncoder().encode(text).buffer });
    Object.defineProperty(input, 'files', { value: [file('erm.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'), file('notes.txt', 'x')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle(10);
    await until(() => expect(tab.root.textContent).toContain('1 file is not an image'));
    expect(tab.root.querySelector('.ci-group .ci-ghead')?.textContent).toContain('New');
    expect((tab.root.querySelector('.ci-idin') as HTMLInputElement).value).toBe('icon_erm');
    const bar = tab.root.querySelector<HTMLElement>('.ci-savebar')!;
    expect(bar.querySelector('.ci-sb-text')?.textContent).toBe('1 unsaved change');
    expect(review(tab)[0].textContent).toContain('icon_erm');
    expect(tab.root.textContent).toContain('1 file is not an image');

    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    api.readImages.mockResolvedValue({ folders: FOLDERS, files: [...FILES, { rid: '5', id: 'icon_erm', name: 'erm.png', folderId: 'nav' }], fetchedAt: 2 });
    // Save is enabled only once the file has been read, drawn and encoded.
    await until(() => expect(saveButton(tab).disabled).toBe(false));
    saveButton(tab).click();
    await until(() => expect(tab.root.querySelector('.ci-result')?.textContent).toContain('icon_erm is named erm.png'));
    const [env, colors, files] = api.writeChanges.mock.calls[0];
    expect(env).toBe('p1@https://bmp.example.test/');
    expect(colors).toEqual([]);
    expect(files).toEqual([{ kind: 'add', folderId: 'nav', id: 'icon_erm', name: 'erm.svg', mime: 'image/svg+xml', base64: expect.any(String) }]);
    expect(api.readImages).toHaveBeenLastCalledWith(true);
    // The fresh list holds the file under another name than the one sent (the fake says erm.png): said.
    expect(tab.root.querySelector('.ci-result')?.textContent).toContain('icon_erm is named erm.png');
  });

  it('refuses a taken ID before anything is sent', async () => {
    const tab = await opened();
    const input = tab.root.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = Object.assign(new File(['x'], 'home.png'), { arrayBuffer: async () => new Uint8Array([1]).buffer });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await until(() => expect(tab.root.querySelector<HTMLInputElement>('.ci-idin')?.value).toBe('icon_home_2'));
    // 'icon_home' is taken: the proposal is home_2 style.
    const id = tab.root.querySelector<HTMLInputElement>('.ci-idin')!;
    expect(id.value).toBe('icon_home_2');
    type(id, 'icon_home');
    expect(id.getAttribute('aria-invalid')).toBe('true');
    expect(saveButton(tab).disabled).toBe(true);
    expect(api.writeChanges).not.toHaveBeenCalled();
  });

  it('marks a file over what one write holds when it is added, leaves it unselected, and re-checks it when it is made smaller', async () => {
    const tab = await opened();
    let seed = 12345;
    const noise = (n: number) => Uint8Array.from({ length: n }, () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 24; });
    vi.mocked(processImage).mockImplementation(async (source, adjust) => ({ bytes: adjust.size === 'keep' ? source.bytes : noise(6_000), mime: source.mime, width: 24, height: 24 }));
    const input = tab.root.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = (name: string, bytes: Uint8Array) => Object.assign(new File([bytes as BlobPart], name), { arrayBuffer: async () => bytes.buffer as ArrayBuffer });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>';
    Object.defineProperty(input, 'files', { value: [file('photo.jpg', noise(30_000)), file('erm.svg', new TextEncoder().encode(svg))], configurable: true });
    input.dispatchEvent(new Event('change'));
    await until(() => expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('1 unsaved change, 1 left out'));
    const tiles = () => [...tab.root.querySelectorAll<HTMLElement>('.ci-group:first-child .ci-itile:not(.drop)')];
    const tileOf = (name: string) => tiles().find(t => t.querySelector('.ci-nm')?.textContent?.startsWith(name))!;
    expect(tileOf('photo').querySelector('.ci-over')?.textContent).toBe('Too large');
    expect(tileOf('photo').classList.contains('on')).toBe(false);
    expect(tileOf('erm').querySelector('.ci-over')).toBeNull();
    expect(tileOf('erm').classList.contains('on')).toBe(true);
    // The size and the limit are said on the tile and, once it is selected, in the Adjust panel; the confirm bar keeps its line.
    expect(tileOf('photo').querySelector('.ci-over')?.getAttribute('title')).toMatch(/^photo\.jpg is \d+ KB\. One write holds about 17 KB\.$/);
    review(tab);
    expect(tab.root.querySelector('.ci-sb-panel .ci-confirm-skip')?.textContent).toContain('over what one write holds');
    closeReview();
    tileOf('photo').querySelector<HTMLButtonElement>('.ci-itile-pick')!.click();
    await settle();
    expect(tab.root.querySelector('.ci-panel .ci-over-note')?.textContent).toMatch(/^photo\.jpg is \d+ KB\. One write holds about 17 KB\.$/);
    // A smaller size brings it under the limit: it is no longer marked and the bar leaves nothing out.
    [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-panel .ci-seg button')].find(b => b.textContent === '48')!.click();
    await until(() => expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('2 unsaved changes'));
    expect(tab.root.querySelector('.ci-over')).toBeNull();
    expect(tab.root.querySelector('.ci-panel .ci-over-note')?.textContent).toBe('');
    review(tab);
    expect(tab.root.querySelector('.ci-sb-panel .ci-confirm-skip')).toBeNull();
    vi.mocked(processImage).mockImplementation(async (source: { bytes: Uint8Array; mime: string }) => ({ bytes: source.bytes, mime: source.mime, width: 24, height: 24 }));
  });

  const LINE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#14324A" stroke-width="2"><path d="M4 11 12 4l8 7"/><circle cx="12" cy="16" r="2" fill="#E07B24" stroke="none"/></svg>';
  const SVG_FILE = { rid: '9007199254740997', id: 'icon_flag', name: 'flag.svg', folderId: 'nav' };

  async function withSvg() {
    api.readImages.mockResolvedValue({ folders: FOLDERS, files: [...FILES, SVG_FILE], fetchedAt: 1 });
    api.readImageBytes.mockImplementation(async (rids: string[]) => rids.map(rid => ({ rid, base64: rid === SVG_FILE.rid ? btoa(LINE_SVG) : 'iVBORw0KGgo=' })));
    api.readColors.mockResolvedValue({ sets: sets(), fetchedAt: 1 });
    const tab = createImagesTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await until(() => expect(tab.root.querySelectorAll('.ci-itile-pick')).toHaveLength(3));
    return tab;
  }
  const pickTile = (tab: { root: HTMLElement }, name: string) => [...tab.root.querySelectorAll<HTMLElement>('.ci-itile')].find(t => t.querySelector('.ci-nm')?.textContent === name)!.querySelector<HTMLButtonElement>('.ci-itile-pick')!.click();
  const segButton = (tab: { root: HTMLElement }, text: string) => [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-panel .ci-seg button')].find(b => b.textContent === text)!;

  it('offers the colors of a selected SVG to swap one by one, from the workspace colors, and sends the swap', async () => {
    const tab = await withSvg();
    pickTile(tab, 'flag.svg');
    await until(() => expect(segButton(tab, 'Swap colors').disabled).toBe(false));
    segButton(tab, 'Swap colors').click();
    await until(() => expect([...tab.root.querySelectorAll('.ci-swaps .ci-cchip span')].map(s => s.textContent)).toEqual(['14324A', 'E07B24']));
    tab.root.querySelectorAll<HTMLButtonElement>('.ci-swaps .ci-cchip')[1].click();
    // The workspace's colors are read (the copy read before) only when a color is chosen.
    await until(() => expect(tab.root.querySelectorAll('.ci-pop .ci-popsw button')).toHaveLength(2));
    expect(api.readColors).toHaveBeenCalledWith(false);
    tab.root.querySelectorAll<HTMLButtonElement>('.ci-pop .ci-popsw button')[0].click();
    await until(() => expect(tab.root.querySelector<HTMLElement>('.ci-savebar')!.hidden).toBe(false));
    const adjust = vi.mocked(processImage).mock.calls.at(-1)![1];
    expect(adjust.color).toEqual({ mode: 'swap', hex: expect.any(String), map: { '#E07B24': '#1F5FA8' } });
    expect(adjust.format).toBe('svg');
    expect(tab.root.querySelectorAll<HTMLElement>('.ci-swaps .ci-cchip')[1].classList.contains('chg')).toBe(true);
  });

  it('offers swapping single colors for SVG files only', async () => {
    const tab = await withSvg();
    pickTile(tab, 'home.png');
    await settle();
    expect(segButton(tab, 'Swap colors').disabled).toBe(true);
    expect(segButton(tab, 'Swap colors').title).toBe('SVG files only');
  });

  it('keeps turn, shape, line width and trim behind More, counts what is on while closed, and shows line width for line icons only', async () => {
    const tab = await withSvg();
    pickTile(tab, 'flag.svg');
    await settle();
    expect(tab.root.querySelector('[aria-label="Rotate right"]')).toBeNull();
    tab.root.querySelector<HTMLButtonElement>('.ci-more')!.click();
    await until(() => expect(tab.root.querySelector('[aria-label="Line width"]')).not.toBeNull());
    tab.root.querySelector<HTMLButtonElement>('[aria-label="Rotate right"]')!.click();
    tab.root.querySelector<HTMLButtonElement>('[aria-label="Circle"]')!.click();
    await until(() => expect(vi.mocked(processImage).mock.calls.at(-1)![1]).toMatchObject({ turn: { rotate: 90 }, shape: { kind: 'circle' } }));
    tab.root.querySelector<HTMLButtonElement>('.ci-more')!.click();
    expect(tab.root.querySelector('.ci-more-n')?.textContent).toBe('2');
    // A picture has no line width to set.
    pickTile(tab, 'flag.svg');
    pickTile(tab, 'home.png');
    tab.root.querySelector<HTMLButtonElement>('.ci-more')!.click();
    await settle();
    expect(tab.root.querySelector('[aria-label="Line width"]')).toBeNull();
  });

  it('replaces the file of an existing image, keeps its ID, and renames it in the same write when the type changes', async () => {
    const tab = await withSvg();
    pickTile(tab, 'home.png');
    await settle();
    const replace = [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-panel .ci-link')].find(b => b.textContent === 'Replace file')!;
    expect(replace).toBeTruthy();
    const input = tab.root.querySelectorAll<HTMLInputElement>('input[type=file]')[1];
    const svgFile = Object.assign(new File([LINE_SVG], 'house.svg'), { arrayBuffer: async () => new TextEncoder().encode(LINE_SVG).buffer });
    Object.defineProperty(input, 'files', { value: [svgFile], configurable: true });
    input.dispatchEvent(new Event('change'));
    await until(() => expect(review(tab)[0]?.textContent).toContain('file replaced with house.svg'));
    expect(tab.root.querySelector('.ci-replaced')?.textContent).toContain('Replaced with house.svg');
    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    await until(() => expect(saveButton(tab).disabled).toBe(false));
    saveButton(tab).click();
    await until(() => expect(api.writeChanges).toHaveBeenCalled());
    expect(api.writeChanges.mock.calls[0][2]).toEqual([{ kind: 'change', id: 'icon_home', name: 'home.svg', mime: 'image/svg+xml', base64: expect.any(String), rename: true }]);
  });

  it('changes a selected existing image only when the Adjust panel asks for it', async () => {
    const tab = await opened();
    tab.root.querySelector<HTMLButtonElement>('.ci-itile-pick')!.click();
    await settle();
    // One image: the panel names it and its ID.
    expect(tab.root.querySelector('.ci-panel .ci-title')?.textContent).toBe('home.png');
    expect(tab.root.querySelector('.ci-panel .ci-ph .ci-id')?.textContent).toBe('icon_home');
    expect(tab.root.querySelector<HTMLElement>('.ci-savebar')!.hidden).toBe(true);
    const size24 = [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-panel .ci-seg button')].find(b => b.textContent === '24')!;
    size24.click();
    await until(() => expect(tab.root.querySelector<HTMLElement>('.ci-savebar')!.hidden).toBe(false));
    expect(tab.root.querySelector<HTMLElement>('.ci-savebar')!.hidden).toBe(false);
    review(tab);
    expect(tab.root.querySelector('.ci-sb-pnote')?.textContent).toBe('Changes it everywhere it is linked.');
    expect(tab.hasUnsaved()).toBe(true);
  });
});

describe('Images tab: adding a folder and from the library', () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })); });

  async function opened() {
    api.readImages.mockResolvedValue({ folders: FOLDERS, files: FILES, fetchedAt: 1 });
    api.readImageBytes.mockImplementation(async (rids: string[]) => rids.map(rid => ({ rid, base64: 'iVBORw0KGgo=' })));
    api.readColors.mockResolvedValue({ sets: sets(), fetchedAt: 1 });
    const tab = createImagesTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    return tab;
  }
  const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>';
  const inFolder = (path: string, text: string) => {
    const read = vi.fn(async () => new TextEncoder().encode(text).buffer);
    return Object.assign(new File([text], path.split('/').pop()!), { webkitRelativePath: path, arrayBuffer: read });
  };
  const save = async (tab: { root: HTMLElement }) => {
    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    await until(() => expect(saveButton(tab).disabled).toBe(false));
    saveButton(tab).click();
    await until(() => expect(api.writeChanges).toHaveBeenCalled());
    return api.writeChanges.mock.calls[0][2] as Array<Record<string, unknown>>;
  };
  const press = (host: HTMLElement, selector: string, text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(selector)].find(b => b.textContent === text || b.textContent?.startsWith(text))!.click();

  it('adds every image of a picked folder and its subfolders as dropped files are added, in path order, and leaves out the rest unread', async () => {
    const tab = await opened();
    const input = tab.root.querySelector<HTMLInputElement>('input[webkitdirectory]')!;
    expect([...tab.root.querySelectorAll<HTMLButtonElement>('.ci-mhead .ui-btn')].map(b => b.textContent)).toEqual(['Upload files', 'Upload folder']);
    const notes = inFolder('icons/notes.txt', 'x');
    Object.defineProperty(input, 'files', { value: [inFolder('icons/sub/risk.svg', svgText), notes, inFolder('icons/audit.svg', svgText)], configurable: true });
    input.dispatchEvent(new Event('change'));
    await until(() => expect(tab.root.textContent).toContain('1 file is not an image and was left out.'));
    expect(notes.arrayBuffer).not.toHaveBeenCalled();
    expect([...tab.root.querySelectorAll<HTMLInputElement>('.ci-idin')].map(i => i.value)).toEqual(['icon_audit', 'icon_risk_2']);
    const files = await save(tab);
    expect(files.map(f => [f.id, f.name])).toEqual([['icon_audit', 'audit.svg'], ['icon_risk_2', 'risk.svg']]);
    expect(files.every(f => !('description' in f))).toBe(true);
  });

  const side = (tab: { root: HTMLElement }) => tab.root.querySelector<HTMLElement>('.ci-side')!;
  const strip = (tab: { root: HTMLElement }) => tab.root.querySelector<HTMLElement>('.ci-libstrip');
  const libTiles = (tab: { root: HTMLElement }) => [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-main .ci-libtile .ci-itile-pick')];
  const addButton = (tab: { root: HTMLElement }) => tab.root.querySelector<HTMLButtonElement>('.ci-panel .ci-lib-add')!;
  const openCollection = async (tab: { root: HTMLElement }, name: string, firstGroup: string) => {
    await until(() => expect(side(tab).querySelectorAll('.ci-sec.lib .ci-srow').length).toBe(3));
    press(side(tab), '.ci-sec.lib .ci-srow', name);
    await until(() => expect(tab.root.querySelector('.ci-main .ci-ghead')?.textContent).toContain(firstGroup));
  };

  it('shows the BMP folders with no heading and the library below them under its own header, with the shared glyphs, and no library overlay', async () => {
    const tab = await opened();
    await until(() => expect(side(tab).querySelectorAll('.ci-sec.lib .ci-srow').length).toBe(3));
    // The folder tree starts with All images; only the library has a header, and one short line under it.
    expect([...side(tab).querySelectorAll('.ci-sec-h')].map(h => h.textContent)).toEqual(['Library']);
    expect(side(tab).textContent).not.toContain('In BMP');
    expect(side(tab).querySelector('.ci-sec.lib .ci-sec-cap')?.textContent).toBe('Not in BMP yet');
    const glyphs = (sel: string) => [...side(tab).querySelectorAll(`${sel} .ci-tglyph use`)].map(u => u.getAttribute('href'));
    expect(glyphs('.ci-sec.bmp')).toEqual(['#o-image', '#o-folder']);
    expect(side(tab).querySelector('.ci-sec-h use')?.getAttribute('href')).toBe('#o-library');
    expect(glyphs('.ci-sec.lib .ci-trow')).toEqual(['#o-status', '#o-control', '#o-button']);
    expect([...side(tab).querySelectorAll('.ci-sec.lib .ci-srow-name')].map(e => e.textContent)).toEqual(['Status symbols', 'GRC object icons', 'Button icons']);
    // Collections are folded until one is shown.
    expect([...side(tab).querySelectorAll('.ci-sec.lib .ci-trow')].map(r => r.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);
    expect(tab.root.querySelector('.ci-lib, .ci-lib-open')).toBeNull();
    // A collection shows in the main area under the library strip; its tiles carry the library mark and no ID.
    await openCollection(tab, 'Status symbols', 'Status dots');
    expect(strip(tab)?.textContent).toContain('Library');
    expect(strip(tab)?.textContent).toContain('Not in BMP until you add them.');
    expect(tab.root.querySelector('.ci-libtile .ci-libmark')).not.toBeNull();
    expect(tab.root.querySelector('.ci-libtile .ci-id, .ci-libtile .ci-idin')).toBeNull();
    expect(tab.root.querySelector('.ci-panel .ci-title')?.textContent).toBe('Add from the library');
  });

  it('searches BMP and the library at once, by meaning, and says plainly where nothing matches', async () => {
    const tab = await opened();
    const search = tab.root.querySelector<HTMLInputElement>('.ci-search input')!;
    expect(search.placeholder).toBe('Search BMP and the library');
    type(search, 'green');
    await until(() => expect(tab.root.querySelector('.ci-sres.lib .ci-gn')).not.toBeNull());
    const bmp = tab.root.querySelector<HTMLElement>('.ci-sres.bmp')!;
    expect(bmp.querySelector('.ci-shead')?.textContent).toBe('Images0');
    expect(bmp.querySelector('.ci-nomatch')?.textContent).toBe('No image matches “green”.');
    const lib = tab.root.querySelector<HTMLElement>('.ci-sres.lib')!;
    expect(lib.querySelector('.ci-shead')?.textContent).toMatch(/^Library\d+/);
    expect(Number(lib.querySelector('.ci-shead .ci-gn')?.textContent)).toBeGreaterThan(10);
    // Grouped by where they come from; the first tile is a name match.
    expect(lib.querySelector('.ci-ghead')?.textContent).toMatch(/^Status dotsStatus symbols/);
    expect(lib.querySelector('.ci-libtile .ci-nm')?.textContent).toBe('Green');
    type(tab.root.querySelector<HTMLInputElement>('.ci-search input')!, 'home');
    await until(() => expect(tab.root.querySelector('.ci-sres.bmp .ci-gn')?.textContent).toBe('1'));
    expect(tab.root.querySelector('.ci-sres.bmp .ci-nm')?.textContent).toBe('home.png');
    type(tab.root.querySelector<HTMLInputElement>('.ci-search input')!, 'zebra');
    await until(() => expect(tab.root.querySelector('.ci-sres.lib .ci-nomatch')?.textContent).toBe('No image in the library matches “zebra”.'));
  });

  it('adds selected button icons in white to the folder shown on the button, goes to that folder with them selected, and writes the licence note', async () => {
    const tab = await opened();
    await openCollection(tab, 'Button icons', 'Create and add');
    libTiles(tab)[0].click();
    libTiles(tab)[1].click();
    expect(tab.root.querySelector('.ci-panel .ci-title')?.textContent).toBe('2 selected from the library');
    // Button icons start as One color, White, shown on a dark tile.
    expect(tab.root.querySelector('.ci-panel .ci-seg button.on')?.textContent).toBe('One color');
    expect((tab.root.querySelector('.ci-panel input[aria-label="Color"]') as HTMLInputElement).value).toBe('#FFFFFF');
    expect(tab.root.querySelector('.ci-libtile.on .ci-thumb.on-dark')).not.toBeNull();
    expect(tab.root.querySelector('.ci-panel')?.textContent).toContain('Phosphor Icons (MIT License), phosphoricons.com');
    // No folder says "button": the first folder.
    expect(addButton(tab).textContent).toBe('Add 2 to Icons - Navigation');
    addButton(tab).click();
    await until(() => expect([...tab.root.querySelectorAll<HTMLInputElement>('.ci-idin')].map(i => i.value)).toEqual(['icon_plus_ffffff', 'icon_plus_circle_ffffff']));
    expect(tab.root.querySelector('.ci-notes')?.textContent).toBe('2 images added to Icons - Navigation. Save to write them to BMP.');
    expect(strip(tab)).toBeNull();
    expect(tab.root.querySelector('.ci-sec.bmp .ci-srow.on')?.textContent).toContain('Icons - Navigation');
    expect(tab.root.querySelector('.ci-group .ci-ghead')?.textContent).toContain('New');
    expect(tab.root.querySelectorAll('.ci-group:first-child .ci-itile.on')).toHaveLength(2);
    await until(() => expect(tab.root.querySelector<HTMLInputElement>('.ci-panel .ci-desc')?.value).toBe('Phosphor Icons (MIT License), phosphoricons.com'));
    expect(review(tab).map(r => r.textContent).join(' ')).toContain('Phosphor Icons (MIT License)');
    closeReview();
    const sent = vi.mocked(processImage).mock.calls.find(c => c[0].mime === 'image/svg+xml')![0];
    expect(new TextDecoder().decode(sent.bytes)).toContain('fill="#FFFFFF"');
    expect(tab.root.querySelector('.ci-group .ci-thumb.on-dark')).not.toBeNull();
    expect(api.writeChanges).not.toHaveBeenCalled();
    const files = await save(tab);
    expect(files.map(f => [f.folderId, f.id, f.name, f.description])).toEqual([
      ['nav', 'icon_plus_ffffff', 'plus.svg', 'Phosphor Icons (MIT License), phosphoricons.com'],
      ['nav', 'icon_plus_circle_ffffff', 'plus-circle.svg', 'Phosphor Icons (MIT License), phosphoricons.com'],
    ]);
  });

  it('adds status symbols and GRC icons to the folder picked in the strip, in the chosen style and color, and lets a description be written', async () => {
    const tab = await opened();
    await openCollection(tab, 'Status symbols', 'Status dots');
    libTiles(tab)[0].click();
    // Status symbols start as drawn.
    expect(tab.root.querySelector('.ci-panel .ci-seg button.on')?.textContent).toBe('Original');
    press(side(tab), '.ci-sec.lib .ci-srow', 'GRC object icons');
    press(tab.root, '.ci-libstrip .ci-seg button', 'Tile');
    libTiles(tab)[0].click();
    press(tab.root, '.ci-panel .ci-seg button', 'One color');
    type(tab.root.querySelector<HTMLInputElement>('.ci-panel input[aria-label="Color"]')!, '#0E7C86');
    expect(tab.root.querySelector('.ci-panel')?.textContent).not.toContain('Phosphor');
    const dest = tab.root.querySelector<HTMLSelectElement>('.ci-libstrip select')!;
    dest.value = 'libs'; dest.dispatchEvent(new Event('change'));
    expect(addButton(tab).textContent).toBe('Add 2 to Libraries');
    addButton(tab).click();
    // An empty folder gives no prefix: icon_. One color: the ID ends with it.
    await until(() => expect([...tab.root.querySelectorAll<HTMLInputElement>('.ci-idin')].map(i => i.value)).toEqual(['icon_status_dot_green_0e7c86', 'icon_risk_warning_triangle_tile_0e7c86']));
    // The folder shows in the sidebar with its new images, though BMP holds none there yet.
    expect(tab.root.querySelector('.ci-sec.bmp .ci-srow.on')?.textContent).toBe('Libraries+20');
    await until(() => expect(tab.root.querySelector('.ci-panel .ci-desc')).not.toBeNull());
    const desc = tab.root.querySelector<HTMLInputElement>('.ci-panel .ci-desc')!;
    expect(desc.value).toBe('');
    type(desc, 'Risk icons');
    const files = await save(tab);
    expect(files.map(f => [f.folderId, f.name, f.description])).toEqual([['libs', 'status_dot_green.svg', 'Risk icons'], ['libs', 'risk_warning_triangle_tile.svg', 'Risk icons']]);
    const tile = vi.mocked(processImage).mock.calls.map(c => new TextDecoder().decode(c[0].bytes)).find(t => t.includes('<mask'))!;
    expect(tile).toContain('fill="#0E7C86"');
  });

  it('lets the ID follow a color set later in the Adjust panel while it is proposed, and keeps an ID the person typed', async () => {
    const tab = await opened();
    const search = tab.root.querySelector<HTMLInputElement>('.ci-search input')!;
    type(search, 'pencil simple');
    await until(() => expect(libTiles(tab).length).toBe(2));
    libTiles(tab)[0].click();
    press(tab.root, '.ci-panel .ci-seg button', 'Original');
    addButton(tab).click();
    const ids = () => [...tab.root.querySelectorAll<HTMLInputElement>('.ci-idin')].map(i => i.value);
    await until(() => expect(ids()).toEqual(['icon_pencil_simple']));
    press(tab.root, '.ci-panel .ci-seg button', 'One color');
    type(tab.root.querySelector<HTMLInputElement>('.ci-panel input[aria-label="Color"]')!, '#003C64');
    await until(() => expect(ids()).toEqual(['icon_pencil_simple_003c64']));
    type(tab.root.querySelector<HTMLInputElement>('.ci-idin')!, 'pen_blue');
    type(tab.root.querySelector<HTMLInputElement>('.ci-panel input[aria-label="Color"]')!, '#FFFFFF');
    await settle();
    expect(ids()).toEqual(['pen_blue']);
  });

  it('adds selected library images to a BMP folder they are dragged onto, lighting the folder under the pointer', async () => {
    const tab = await opened();
    await openCollection(tab, 'Status symbols', 'Status dots');
    libTiles(tab)[0].click();
    const row = side(tab).querySelector<HTMLElement>('[data-drop-folder="nav"]')!;
    const at = vi.spyOn(document, 'elementFromPoint').mockImplementation((x: number) => (x > 500 ? row : null));
    const pointer = (type: string, x: number, target: EventTarget) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 10 }));
    pointer('pointerdown', 10, libTiles(tab)[1]);
    pointer('pointermove', 40, window);
    expect(tab.root.classList.contains('lib-dragging')).toBe(true);
    expect(document.querySelector('.ci-dragghost')?.textContent).toBe('2 images');
    pointer('pointermove', 600, window);
    expect(side(tab).querySelector('[data-drop-folder="nav"]')?.classList.contains('drop-on')).toBe(true);
    pointer('pointerup', 600, window);
    at.mockRestore();
    await until(() => expect([...tab.root.querySelectorAll<HTMLInputElement>('.ci-idin')].map(i => i.value)).toEqual(['icon_status_dot_green', 'icon_status_dot_amber']));
    expect(document.querySelector('.ci-dragghost')).toBeNull();
    expect(tab.root.classList.contains('lib-dragging')).toBe(false);
    expect(tab.root.querySelector('.ci-notes')?.textContent).toBe('2 images added to Icons - Navigation. Save to write them to BMP.');
  });

  it('defaults the destination to the folder chosen in the sidebar', async () => {
    const tab = await opened();
    press(side(tab), '.ci-sec.bmp .ci-srow', 'Icons - Navigation');
    await openCollection(tab, 'Status symbols', 'Status dots');
    expect(tab.root.querySelector<HTMLSelectElement>('.ci-libstrip select')!.value).toBe('nav');
    libTiles(tab)[0].click();
    libTiles(tab)[1].click();
    libTiles(tab)[2].click();
    expect(addButton(tab).textContent).toBe('Add 3 to Icons - Navigation');
  });
});

describe('Images tab: the sidebar tree and the save bar', () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })); });

  const NESTED = [
    { id: 'img', name: 'Images', parentId: 'EXTERNALRESOURCE' },
    { id: 'nav', name: 'Navigation', parentId: 'img' },
    { id: 'sts', name: 'Status', parentId: 'img' },
    { id: 'old', name: 'Archive', parentId: 'sts' },
  ];
  const NESTED_FILES = [
    { rid: '9007199254740993', id: 'home', name: 'home.png', folderId: 'nav' },
    { rid: '9007199254740995', id: 'ok', name: 'ok.png', folderId: 'sts' },
    { rid: '9007199254740997', id: 'bad', name: 'bad.png', folderId: 'old' },
  ];
  async function opened(folders = NESTED, files = NESTED_FILES) {
    api.readImages.mockResolvedValue({ folders, files, fetchedAt: 1 });
    api.readImageBytes.mockImplementation(async (rids: string[]) => rids.map(rid => ({ rid, base64: 'iVBORw0KGgo=' })));
    api.readColors.mockResolvedValue({ sets: sets(), fetchedAt: 1 });
    const tab = createImagesTab(ctx);
    document.body.append(tab.root);
    tab.show();
    await settle();
    return tab;
  }
  const rows = (tab: { root: HTMLElement }, sel = '.ci-sec.bmp') => [...tab.root.querySelectorAll<HTMLElement>(`${sel} .ci-trow`)];
  const row = (tab: { root: HTMLElement }, name: string, sel = '.ci-sec.bmp') => rows(tab, sel).find(r => r.querySelector('.ci-srow-name')?.textContent === name)!;
  const names = (tab: { root: HTMLElement }, sel = '.ci-sec.bmp') => rows(tab, sel).map(r => `${r.style.getPropertyValue('--d')}:${r.querySelector('.ci-srow-name')?.textContent}`);
  const drop = (tab: { root: HTMLElement }, ...files: Array<[string, string]>) => {
    const input = tab.root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: files.map(([name, text]) => Object.assign(new File([text], name), { arrayBuffer: async () => new TextEncoder().encode(text).buffer })), configurable: true });
    input.dispatchEvent(new Event('change'));
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>';

  it('draws the folders as a tree with depth, chevrons on folders that hold folders, and folds one without opening it', async () => {
    const tab = await opened();
    expect(names(tab)).toEqual(['0:All images', '0:Images', '1:Navigation', '1:Status', '2:Archive']);
    expect(row(tab, 'Images').getAttribute('aria-expanded')).toBe('true');
    expect(row(tab, 'Navigation').hasAttribute('aria-expanded')).toBe(false);
    expect(row(tab, 'Images').querySelector('.ci-n')?.textContent).toBe('3');
    row(tab, 'Status').querySelector<HTMLElement>('.ci-tchev')!.click();
    expect(names(tab)).toEqual(['0:All images', '0:Images', '1:Navigation', '1:Status']);
    expect(row(tab, 'Status').getAttribute('aria-expanded')).toBe('false');
    // Folding does not open the folder: All images stays the one shown.
    expect(tab.root.querySelector('.ci-sec.bmp .ci-trow.on .ci-srow-name')?.textContent).toBe('All images');
    row(tab, 'Images').querySelector<HTMLElement>('.ci-tchev')!.click();
    expect(names(tab)).toEqual(['0:All images', '0:Images']);
    row(tab, 'Images').querySelector<HTMLElement>('.ci-tchev')!.click();
    row(tab, 'Status').click();
    expect(row(tab, 'Status').classList.contains('on')).toBe(true);
    expect(row(tab, 'Status').getAttribute('aria-current')).toBe('true');
  });

  it('keeps the mark of unsaved images on a folder, also when it is folded', async () => {
    const tab = await opened();
    row(tab, 'Archive').click();
    drop(tab, ['x.svg', svg]);
    await until(() => expect(row(tab, 'Archive').querySelector('.ci-newn')?.textContent).toBe('+1'));
    row(tab, 'Images').querySelector<HTMLElement>('.ci-tchev')!.click();
    expect(row(tab, 'Images').querySelector('.ci-newn')?.textContent).toBe('+1');
    expect(row(tab, 'All images').querySelector('.ci-newn')?.textContent).toBe('+1');
  });

  it('unfolds the open library collection with its groups as children, and folds it on its chevron', async () => {
    const tab = await opened();
    await until(() => expect(rows(tab, '.ci-sec.lib').length).toBe(3));
    row(tab, 'Status symbols', '.ci-sec.lib').click();
    await until(() => expect(rows(tab, '.ci-sec.lib').length).toBeGreaterThan(3));
    const lib = names(tab, '.ci-sec.lib');
    expect(lib.slice(0, 2)).toEqual(['0:Status symbols', '1:Status dots']);
    expect(lib.at(-2)).toBe('0:GRC object icons');
    expect(row(tab, 'Status dots', '.ci-sec.lib').querySelector('.ci-tdot')).not.toBeNull();
    row(tab, 'Status symbols', '.ci-sec.lib').querySelector<HTMLElement>('.ci-tchev')!.click();
    expect(names(tab, '.ci-sec.lib')).toEqual(['0:Status symbols', '0:GRC object icons', '0:Button icons']);
    // Another collection can be unfolded without being shown.
    row(tab, 'GRC object icons', '.ci-sec.lib').querySelector<HTMLElement>('.ci-tchev')!.click();
    expect(names(tab, '.ci-sec.lib')[2]).toMatch(/^1:/);
    expect(tab.root.querySelector('.ci-libstrip')?.textContent).toContain('Status symbols');
  });

  it('counts the changes in one floating bar and lists them only on Review, which Escape or a click outside closes', async () => {
    const tab = await opened();
    row(tab, 'Navigation').click();
    drop(tab, ['a.svg', svg], ['b.svg', svg]);
    await until(() => expect(saveButton(tab).disabled).toBe(false));
    expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('2 unsaved changes');
    expect(tab.root.classList.contains('ci-has-bar')).toBe(true);
    expect(tab.root.querySelector('.ci-sb-panel')).toBeNull();
    expect(review(tab).map(r => r.querySelector('.ci-pname')?.textContent)).toEqual(['a.svg', 'b.svg']);
    expect(tab.root.querySelector('.ci-sb-review')?.getAttribute('aria-expanded')).toBe('true');
    closeReview();
    expect(tab.root.querySelector('.ci-sb-panel')).toBeNull();
    review(tab);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(tab.root.querySelector('.ci-sb-panel')).toBeNull();
  });

  it('asks once before discarding more than one change', async () => {
    const tab = await opened();
    row(tab, 'Navigation').click();
    drop(tab, ['a.svg', svg], ['b.svg', svg]);
    await until(() => expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('2 unsaved changes'));
    const discard = () => [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-sb button')].find(b => b.textContent === 'Discard')!;
    discard().click();
    expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('Discard 2 changes?');
    [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-sb button')].find(b => b.textContent === 'Keep')!.click();
    expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('2 unsaved changes');
    discard().click();
    discard().click();
    expect(tab.root.querySelector<HTMLElement>('.ci-savebar')!.hidden).toBe(true);
    expect(tab.root.classList.contains('ci-has-bar')).toBe(false);
    expect(tab.hasUnsaved()).toBe(false);
  });

  it('says in one sentence when a save stops part way, shows BMP\'s message on the file it stopped at, and Save sends only the rest', async () => {
    const tab = await opened();
    row(tab, 'Navigation').click();
    drop(tab, ['a.svg', svg], ['b.svg', svg], ['c.svg', svg]);
    await until(() => expect(saveButton(tab).disabled).toBe(false));
    let release: (v: unknown) => void = () => {};
    api.writeChanges.mockImplementationOnce(() => new Promise(r => { release = r; }));
    saveButton(tab).click();
    await settle();
    expect(tab.root.querySelector('.ci-sb-text')?.textContent).toBe('Saving 3 changes…');
    expect(saveButton(tab).disabled).toBe(true);
    release({ ok: false, written: 1, error: 'b.svg: BMP would not write all of it: Missing value for .crev_qa_c3_folder at line 1, column 2' });
    await settle();
    expect(tab.root.querySelector('.ci-sb.bad .ci-sb-text')?.textContent).toBe('2 of 3 not saved.');
    expect(tab.root.querySelector('.ci-sb-review')?.textContent).toBe('Details');
    const listed = review(tab);
    expect(listed.map(r => r.querySelector('.ci-pstate')?.textContent)).toEqual(['Saved', 'Not saved', 'Not saved']);
    expect(listed[1].querySelector('.ci-pmsg')?.textContent).toBe('BMP would not write all of it: Missing value for .crev_qa_c3_folder at line 1, column 2');
    expect(listed[2].querySelector('.ci-pmsg')).toBeNull();
    expect(tab.hasUnsaved()).toBe(true);
    // Save again: the file already written is not sent twice; the check reads all three back.
    api.writeChanges.mockResolvedValueOnce({ ok: true, written: 2 });
    api.readImages.mockResolvedValue({ folders: NESTED, files: [...NESTED_FILES, ...['a', 'b', 'c'].map((n, i) => ({ rid: String(i + 1), id: n, name: `${n}.svg`, folderId: 'nav' }))], fetchedAt: 2 });
    saveButton(tab).click();
    await until(() => expect(tab.root.querySelector('.ci-sb.ok .ci-sb-text')?.textContent).toBe('Saved 3 changes'));
    expect(api.writeChanges.mock.calls[1][2].map((f: { name: string }) => f.name)).toEqual(['b.svg', 'c.svg']);
    expect(api.writeChanges.mock.calls[0][2].map((f: { name: string }) => f.name)).toEqual(['a.svg', 'b.svg', 'c.svg']);
    expect(tab.hasUnsaved()).toBe(false);
  });

  it('leaves the bar a while after Saved, then puts it away', async () => {
    const tab = await opened();
    row(tab, 'Navigation').click();
    drop(tab, ['a.svg', svg]);
    await until(() => expect(saveButton(tab).disabled).toBe(false));
    api.writeChanges.mockResolvedValueOnce({ ok: true, written: 1 });
    api.readImages.mockResolvedValue({ folders: NESTED, files: [...NESTED_FILES, { rid: '1', id: 'a', name: 'a.svg', folderId: 'nav' }], fetchedAt: 2 });
    saveButton(tab).click();
    await until(() => expect(tab.root.querySelector('.ci-sb.ok')).not.toBeNull());
    const shownAt = Date.now();
    await vi.waitFor(() => expect(tab.root.querySelector<HTMLElement>('.ci-savebar')!.hidden).toBe(true), { timeout: SAVED_MS + 2000, interval: 50 });
    expect(Date.now() - shownAt).toBeGreaterThanOrEqual(SAVED_MS - 100);
  });
});