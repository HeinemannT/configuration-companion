// @vitest-environment happy-dom
/**
 * The image of a button (ActionButton.imageFile, ImageView.imageFile): the
 * read keeps the link as a RID in the object's props, the window edits it
 * through the existing staged-change route, the write is
 * `imageFile := lookup(<rid>)` (or `""` to clear), and the picker offers the
 * workspace's image files without editing anything itself.
 */
import { describe, expect, it, vi } from 'vitest';
import '../../lib/__tests__/chrome-mock';
import { BmpClient, OBJECT_CHANGE_PROPS_SET } from '../../lib/bmp-client';
import { fileLinkPropsOf, fileLinkRhs, fileLinkText, rememberFileNames } from '../../lib/file-link-props';
import { fullObjectFromPane, noteFileLinks, type FullObject, type PropValue } from '../../lib/object-read';
import { findPropDef } from '../../lib/pane-schema';
import { typeInfo } from '../../lib/object-window-table';
import { buildChangesPayload } from '../../lib/pane-edit';
import { createImageEditor, ImageCatalogue, openImagePicker } from '../../lib/image-picker';
import { ThumbCache } from '../../lib/colors-images/thumb-cache';
import { editability, WindowDraft } from '../window/draft';
import { planSave } from '../window/save-plan';

const BTN = '2081208944661642130';
const FILE = '1524126395561369203';
const OTHER = '8604206227672741791';
const t = (text: string): PropValue => ({ kind: 'text', text });

function button(references: Record<string, string[]> = {}, props: Record<string, PropValue> = {}): FullObject {
  const o: FullObject = { rid: BTN, type: 'ActionButton', name: 'Reassign', businessId: 'acb_reassign', props: { name: t('Reassign'), id: t('acb_reassign'), ...props }, references, overridden: [] };
  noteFileLinks(o.type, o.props, o.references);
  return o;
}

describe('the image link as a property', () => {
  it('is on buttons and image views only', () => {
    expect(fileLinkPropsOf('ActionButton')).toEqual(['imageFile']);
    expect(fileLinkPropsOf('ImageView')).toEqual(['imageFile']);
    expect(fileLinkPropsOf('Label')).toEqual([]);
    expect(findPropDef('imageFile')).toMatchObject({ kind: 'image' });
    expect(OBJECT_CHANGE_PROPS_SET.has('imageFile')).toBe(true);
  });

  it('is held as the RID of the file, "" when there is none', () => {
    expect(button({ imageFile: [FILE] }).props.imageFile).toEqual({ kind: 'text', text: FILE });
    expect(button().props.imageFile).toEqual({ kind: 'text', text: '' });
    // A read that puts the RID in the props takes it from there.
    expect(button({}, { imageFile: t(FILE) }).props.imageFile.text).toBe(FILE);
    // The rid stays a string past 2^53.
    expect(button({ imageFile: ['9223372036854775801'] }).props.imageFile.text).toBe('9223372036854775801');
    const label: FullObject = { rid: '1', type: 'Label', name: 'x', businessId: 'x', props: {}, references: {}, overridden: [] };
    noteFileLinks(label.type, label.props, label.references);
    expect(label.props.imageFile).toBeUndefined();
    const fromPane = fullObjectFromPane({
      instance: { rid: BTN, type: 'ActionButton', name: 'Reassign', businessId: 'acb' }, references: { imageFile: { rid: FILE } },
      codeFields: {}, instanceProps: {}, contextValues: {}, gateValues: {}, lists: {},
    } as unknown as Parameters<typeof fullObjectFromPane>[0]);
    expect(fromPane.props.imageFile.text).toBe(FILE);
  });

  it('shows on the button as a row of its own, edited by the existing route', () => {
    const fields = typeInfo('ActionButton').groups.flatMap(g => g.fields).filter(f => f.prop === 'imageFile');
    expect(fields).toEqual([{ prop: 'imageFile', label: 'Image file', widget: 'image' }]);
    expect(typeInfo('ImageView').groups.flatMap(g => g.fields).some(f => f.prop === 'imageFile')).toBe(true);
    expect(editability(button({ imageFile: [FILE] }), 'imageFile')).toMatchObject({ route: 'props', def: { kind: 'image' } });
    expect(editability(button(), 'imageFile')?.route).toBe('props');
  });

  it('stages a pick like any property edit and sends it with the others', () => {
    const o = button({ imageFile: [FILE] });
    const draft = new WindowDraft();
    draft.set(BTN, 'imageFile', OTHER, FILE);
    expect(draft.count()).toBe(1);
    // Picking the file it already has stages nothing.
    draft.set(BTN, 'imageFile', FILE, FILE);
    expect(draft.count()).toBe(0);
    draft.set(BTN, 'imageFile', OTHER, FILE);
    const plan = planSave(draft.items(), { [BTN]: o });
    expect(plan[0].rejected).toEqual([]);
    expect(plan[0].steps[0].step).toEqual({ route: 'APPLY_OBJECT_CHANGES', rid: BTN, changes: { imageFile: OTHER }, resetProps: [] });
    expect(buildChangesPayload({ imageFile: '' })).toEqual({ imageFile: '' });
  });

  it('writes lookup(<rid>) and clears with an empty literal', async () => {
    expect(fileLinkRhs(FILE)).toBe(`lookup(${FILE})`);
    expect(fileLinkRhs('')).toBe('""');
    expect(fileLinkRhs('x; delete')).toBeNull();
    const c = new BmpClient('http://localhost/Steadfast/', 'admin', 'pw');
    c.supportsLookup = true;
    const exec = vi.fn(async (_ec: string) => ({ ok: true, log: 'Result : 0', hasError: false, hasWarning: false }));
    (c as unknown as { executeEc: typeof exec }).executeEc = exec;
    await expect(c.applyObjectChanges(BTN, 'instance', { imageFile: FILE })).resolves.toMatchObject({ ok: true });
    expect(exec.mock.calls[0][0]).toContain(`_o.change(imageFile := lookup(${FILE}))`);
    await c.applyObjectChanges(BTN, 'instance', { imageFile: '' });
    expect(exec.mock.calls[1][0]).toContain('_o.change(imageFile := "")');
    await expect(c.applyObjectChanges(BTN, 'instance', { imageFile: 'a b' })).resolves.toMatchObject({ ok: false });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('says the file by name in the review, "No image" for none', () => {
    rememberFileNames([{ rid: FILE, id: 'icon_erm', name: 'erm.png' }]);
    expect(fileLinkText(FILE)).toBe('erm.png (icon_erm)');
    expect(fileLinkText('')).toBe('No image');
    expect(fileLinkText(OTHER, () => 'Other (icon_x)')).toBe('Other (icon_x)');
    expect(fileLinkText('55')).toBe('55');
  });
});

const FILES = [
  { rid: FILE, id: 'icon_erm', name: 'erm.png', folderId: 'nav' },
  { rid: OTHER, id: 'icon_itrm', name: 'itrm.svg', folderId: 'nav' },
  { rid: '77', id: 'file_a', name: 'a.jpg', folderId: 'photos' },
];
const FOLDERS = [{ id: 'nav', name: 'Icons - Navigation', parentId: 'EXTERNALRESOURCE' }, { id: 'photos', name: 'Photography', parentId: 'EXTERNALRESOURCE' }];

function catalogue(read = vi.fn(async () => ({ folders: FOLDERS, files: FILES }))) {
  const bytes = vi.fn(async (rids: string[]) => rids.map(rid => ({ rid, base64: 'AAAA' })));
  return { cat: new ImageCatalogue(new ThumbCache(bytes), read), read, bytes };
}

describe('the image picker', () => {
  it('reads nothing until it is opened, then lists the files by folder with None first', async () => {
    const { cat, read } = catalogue();
    const edit = createImageEditor({ rid: FILE, name: 'erm.png', id: 'icon_erm', background: () => null, dirty: false, catalogue: cat, onChange: () => {}, onOpenImages: () => {} });
    document.body.append(edit);
    expect(read).not.toHaveBeenCalled();
    expect(edit.textContent).toContain('erm.png');
    expect(edit.textContent).toContain('icon_erm');
    edit.querySelector<HTMLElement>('.ip-field')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.ip-tile').length).toBe(3));
    expect(read).toHaveBeenCalledOnce();
    expect(document.querySelector('.ip-none')).not.toBeNull();
    expect([...document.querySelectorAll('.ip-group')].map(g => g.textContent)).toEqual(['Icons - Navigation', 'Photography']);
    expect(document.querySelector('.ip-tile.on')?.getAttribute('aria-label')).toBe('erm.png, icon_erm');
    document.querySelector<HTMLElement>('.ip-backdrop')!.click();
    edit.remove();
  });

  it('searches by name, ID and folder', async () => {
    const { cat } = catalogue();
    openImagePicker({ anchor: document.body, catalogue: cat, currentRid: '', background: null, onPick: () => {}, onOpenImages: () => {} });
    await vi.waitFor(() => expect(document.querySelectorAll('.ip-tile').length).toBe(3));
    const q = document.querySelector<HTMLInputElement>('.ip-search')!;
    q.value = 'itrm'; q.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll('.ip-tile')].map(x => x.getAttribute('aria-label'))).toEqual(['itrm.svg, icon_itrm']);
    q.value = 'photo'; q.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.ip-tile')).toHaveLength(1);
    q.value = 'zzz'; q.dispatchEvent(new Event('input'));
    expect(document.querySelector('.ip-note')?.textContent).toBe('No image matches.');
    document.querySelector<HTMLElement>('.ip-backdrop')!.click();
  });

  it('draws the thumbnails on the background color of the object', async () => {
    const { cat } = catalogue();
    openImagePicker({ anchor: document.body, catalogue: cat, currentRid: '', background: 'rgb(26,86,160)', onPick: () => {}, onOpenImages: () => {} });
    await vi.waitFor(() => expect(document.querySelectorAll('.ip-tile').length).toBe(3));
    expect((document.querySelector('.ip-tile') as HTMLElement).style.background).toContain('rgb(26, 86, 160)');
    document.querySelector<HTMLElement>('.ip-backdrop')!.click();
  });

  it('only picks: a file gives its RID, None gives an empty one, and the link opens the page', async () => {
    const { cat } = catalogue();
    const picks: string[] = [];
    const open = vi.fn();
    const start = () => openImagePicker({ anchor: document.body, catalogue: cat, currentRid: FILE, background: null, onPick: r => picks.push(r), onOpenImages: open });
    start();
    await vi.waitFor(() => expect(document.querySelectorAll('.ip-tile').length).toBe(3));
    document.querySelectorAll<HTMLElement>('.ip-tile')[1].click();
    expect(picks).toEqual([OTHER]);
    expect(document.querySelector('.ip-popover')).toBeNull();
    start();
    document.querySelector<HTMLElement>('.ip-none')!.click();
    expect(picks).toEqual([OTHER, '']);
    start();
    expect(document.querySelector('.ip-current')?.textContent).toBe('erm.png · icon_erm');
    document.querySelector<HTMLElement>('.ip-foot .ip-link')!.click();
    expect(open).toHaveBeenCalledOnce();
    expect(document.querySelector('.ip-popover')).toBeNull();
  });

  it('says so when the files cannot be read, and tries again', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('No connection')).mockResolvedValueOnce({ folders: FOLDERS, files: FILES });
    const { cat } = catalogue(read);
    openImagePicker({ anchor: document.body, catalogue: cat, currentRid: '', background: null, onPick: () => {}, onOpenImages: () => {} });
    await vi.waitFor(() => expect(document.querySelector('.ip-note.bad')?.textContent).toContain('No connection'));
    document.querySelector<HTMLElement>('.ip-note .ip-link')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.ip-tile').length).toBe(3));
    document.querySelector<HTMLElement>('.ip-backdrop')!.click();
  });

  it('closes on Escape', async () => {
    const { cat } = catalogue();
    openImagePicker({ anchor: document.body, catalogue: cat, currentRid: '', background: null, onPick: () => {}, onOpenImages: () => {} });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.ip-popover')).toBeNull();
  });
});
