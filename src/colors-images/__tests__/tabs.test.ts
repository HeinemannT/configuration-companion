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
import type { PageCtx } from '../common';

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
    const bar = tab.root.querySelector<HTMLElement>('.ci-confirm')!;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.ci-confirm-h')?.textContent).toBe('Save 1 change');
    expect(bar.querySelector('.ci-prow')?.textContent).toContain('#1F5FA8 → #1A56A0');
    expect(bar.querySelector('.ci-note')?.textContent).toBe('Changes it everywhere it is linked.');
    expect(tab.hasUnsaved()).toBe(true);

    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    api.readColors.mockResolvedValueOnce({ sets: sets('rgb(26,86,160)'), fetchedAt: 2 });
    bar.querySelector<HTMLButtonElement>('.ui-btn.primary')!.click();
    await settle();
    expect(api.writeChanges).toHaveBeenCalledWith('p1@https://bmp.example.test/', [{ kind: 'change', id: 'swi_blue', hex: '#1A56A0' }], []);
    expect(api.readColors).toHaveBeenLastCalledWith(true);
    expect(tab.root.querySelector('.ci-result')?.textContent).toBe('Saved 1 change');
    expect(tab.root.querySelector<HTMLElement>('.ci-confirm')!.hidden).toBe(true);
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
    tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.click();
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
    tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.click();
    await settle();
    expect(tab.root.querySelector('.ci-confirm-err')?.textContent).toContain('BMP would not write all of it');
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
    expect([...tab.root.querySelectorAll('.ci-prow .ci-pname')].map(e => e.textContent)).toEqual(['Charts', 'Signal orange']);
    expect(tab.root.textContent).not.toMatch(/delete/i);
    api.writeChanges.mockResolvedValue({ ok: true, written: 2 });
    api.readColors.mockResolvedValueOnce({ sets: [...sets(), { id: 'swi_charts', name: 'Charts', colors: [{ bid: 'swi_charts_signal_orange', name: 'Signal orange', rgb: 'rgb(128,128,128)' }] }], fetchedAt: 2 });
    tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.click();
    await settle();
    expect(api.writeChanges.mock.calls[0][1]).toEqual([
      { kind: 'addSet', besideSetId: 'swi_brand', id: 'swi_charts', name: 'Charts' },
      { kind: 'add', setId: 'swi_charts', id: 'swi_charts_signal_orange', name: 'Signal orange', hex: '#808080' },
    ]);
    expect(tab.root.querySelector('.ci-result')?.textContent).toBe('Saved 2 changes');
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
    expect(tab.root.querySelector('.ci-confirm-h')?.textContent).toBe('Save 2 changes');
    api.writeChanges.mockResolvedValue({ ok: true, written: 2 });
    tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.click();
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
    expect([...tab.root.querySelectorAll('.ci-confirm .ci-pname')].map(e => e.textContent)).toEqual(['Steadfast blue 100', 'Steadfast blue 300', 'Steadfast blue 700', 'Steadfast blue 900']);
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
    expect(tab.root.querySelector('.ci-confirm .ci-prow')?.textContent).toContain('#1A56A0');
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
    expect([...tab.root.querySelectorAll('.ci-srow')].map(r => r.textContent)).toEqual(['All images2', 'Icons - Navigation2']);
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
    const bar = tab.root.querySelector<HTMLElement>('.ci-confirm')!;
    expect(bar.querySelector('.ci-confirm-h')?.textContent).toBe('Save 1 change');
    expect(bar.querySelector('.ci-prow')?.textContent).toContain('icon_erm');
    expect(tab.root.textContent).toContain('1 file is not an image');

    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    api.readImages.mockResolvedValue({ folders: FOLDERS, files: [...FILES, { rid: '5', id: 'icon_erm', name: 'erm.png', folderId: 'nav' }], fetchedAt: 2 });
    // Save is enabled only once the file has been read, drawn and encoded.
    await until(() => expect(tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.disabled).toBe(false));
    tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.click();
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
    expect(tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.disabled).toBe(true);
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
    await until(() => expect(tab.root.querySelector('.ci-confirm .ci-confirm-h')?.textContent).toBe('Save 1 change'));
    const tiles = () => [...tab.root.querySelectorAll<HTMLElement>('.ci-group:first-child .ci-itile:not(.drop)')];
    const tileOf = (name: string) => tiles().find(t => t.querySelector('.ci-nm')?.textContent?.startsWith(name))!;
    expect(tileOf('photo').querySelector('.ci-over')?.textContent).toBe('Too large');
    expect(tileOf('photo').classList.contains('on')).toBe(false);
    expect(tileOf('erm').querySelector('.ci-over')).toBeNull();
    expect(tileOf('erm').classList.contains('on')).toBe(true);
    // The size and the limit are said on the tile and, once it is selected, in the Adjust panel; the confirm bar keeps its line.
    expect(tileOf('photo').querySelector('.ci-over')?.getAttribute('title')).toMatch(/^photo\.jpg is \d+ KB\. One write holds about 17 KB\.$/);
    expect(tab.root.querySelector('.ci-confirm:not([hidden])')?.textContent).toContain('over what one write holds');
    expect(tab.root.querySelector('.ci-confirm .ci-confirm-h')?.textContent).toBe('Save 1 change');
    tileOf('photo').querySelector<HTMLButtonElement>('.ci-itile-pick')!.click();
    await settle();
    expect(tab.root.querySelector('.ci-panel .ci-over-note')?.textContent).toMatch(/^photo\.jpg is \d+ KB\. One write holds about 17 KB\.$/);
    // A smaller size brings it under the limit: it is no longer marked and the bar leaves nothing out.
    [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-panel .ci-seg button')].find(b => b.textContent === '48')!.click();
    await until(() => expect(tab.root.querySelector('.ci-confirm .ci-confirm-h')?.textContent).toBe('Save 2 changes'));
    expect(tab.root.querySelector('.ci-over')).toBeNull();
    expect(tab.root.querySelector('.ci-panel .ci-over-note')?.textContent).toBe('');
    expect(tab.root.querySelector('.ci-confirm')?.textContent).not.toContain('over what one write holds');
    expect(tab.root.querySelector('.ci-confirm .ci-confirm-h')?.textContent).toBe('Save 2 changes');
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
    await until(() => expect(tab.root.querySelector<HTMLElement>('.ci-confirm')!.hidden).toBe(false));
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
    await until(() => expect(tab.root.querySelector('.ci-confirm .ci-prow')?.textContent).toContain('file replaced with house.svg'));
    expect(tab.root.querySelector('.ci-replaced')?.textContent).toContain('Replaced with house.svg');
    api.writeChanges.mockResolvedValue({ ok: true, written: 1 });
    await until(() => expect(tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.disabled).toBe(false));
    tab.root.querySelector<HTMLButtonElement>('.ci-confirm .ui-btn.primary')!.click();
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
    expect(tab.root.querySelector<HTMLElement>('.ci-confirm')!.hidden).toBe(true);
    const size24 = [...tab.root.querySelectorAll<HTMLButtonElement>('.ci-panel .ci-seg button')].find(b => b.textContent === '24')!;
    size24.click();
    await until(() => expect(tab.root.querySelector<HTMLElement>('.ci-confirm')!.hidden).toBe(false));
    expect(tab.root.querySelector<HTMLElement>('.ci-confirm')!.hidden).toBe(false);
    expect(tab.root.querySelector('.ci-confirm .ci-note')?.textContent).toBe('Changes it everywhere it is linked.');
    expect(tab.hasUnsaved()).toBe(true);
  });
});
