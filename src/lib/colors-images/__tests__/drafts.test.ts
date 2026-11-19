/**
 * The unsaved changes of the two tabs: colors and images.
 */
import { describe, expect, it } from 'vitest';
import type { ColorSetData } from '../../types';
import {
  addColor, addSet, changeCount, editColor, emptyDraft, hasChanges, pendingChanges, problems, removeNewSet, renameNewColor, setViews,
  verifyColors,
} from '../colors-draft';
import { buildFileOps, idProblem, isOverLimit, newImagesFor, outputName, overLimitText, storedKb, verifyFiles, type NewImage } from '../images-draft';
import { FILE_LIMIT_KB } from '../write-ops';
import type { ImageIndex } from '../image-files';

const SETS: ColorSetData[] = [
  { id: 'swi_brand', name: 'Steadfast brand', folder: 'swi', colors: [
    { bid: 'swi_blue', name: 'Steadfast blue', rgb: 'rgb(31,95,168)' },
    { bid: 'swi_navy', name: 'Steadfast navy', rgb: 'rgb(12,45,87)' },
  ] },
  { id: 'swi_status', name: 'Status', folder: 'swi', colors: [{ bid: 'swi_ok', name: 'OK', rgb: 'rgb(46,125,50)' }] },
];

describe('color draft', () => {
  it('records a change and drops it when the value is back to the stored one', () => {
    let d = editColor(emptyDraft(), SETS[0], 'swi_blue', 'hex', '#1A56A0');
    expect(d.edits).toEqual({ swi_blue: { hex: '#1A56A0' } });
    d = editColor(d, SETS[0], 'swi_blue', 'name', 'Blue');
    expect(Object.keys(d.edits.swi_blue)).toEqual(['hex', 'name']);
    d = editColor(d, SETS[0], 'swi_blue', 'hex', '#1F5FA8');
    d = editColor(d, SETS[0], 'swi_blue', 'name', 'Steadfast blue');
    expect(hasChanges(d)).toBe(false);
  });

  it('sends only what changed, with the stored value for the bar', () => {
    const d = editColor(editColor(emptyDraft(), SETS[0], 'swi_blue', 'hex', '#1a56a0'), SETS[0], 'swi_navy', 'name', 'Deep navy');
    const { ops, rows } = pendingChanges(SETS, d);
    expect(ops).toEqual([{ kind: 'change', id: 'swi_blue', hex: '#1A56A0' }, { kind: 'change', id: 'swi_navy', name: 'Deep navy' }]);
    expect(rows[0]).toMatchObject({ kind: 'change', name: 'Steadfast blue', from: '#1F5FA8', to: '#1A56A0', detail: '#1F5FA8 → #1A56A0' });
    expect(rows[1].detail).toBe('name: Steadfast navy → Deep navy');
    expect(changeCount(d)).toBe(2);
  });

  it('adds a color with an ID in the style of its neighbours, that follows its name', () => {
    const first = addColor(emptyDraft(), SETS, 'swi_brand', 'k1', '#E8742A', 'New color');
    let d = first.draft;
    expect(first.added.id).toBe('swi_new_color');
    d = renameNewColor(d, SETS, 'k1', 'Signal orange');
    expect(d.newColors[0].id).toBe('swi_signal_orange');
    // Once the person edits the ID by hand it stays.
    d = { ...d, newColors: d.newColors.map(n => ({ ...n, id: 'swi_custom', idTouched: true })) };
    expect(renameNewColor(d, SETS, 'k1', 'Another').newColors[0]).toMatchObject({ id: 'swi_custom', name: 'Another' });
    expect(pendingChanges(SETS, d).ops).toEqual([{ kind: 'add', setId: 'swi_brand', id: 'swi_custom', name: 'Signal orange', hex: '#E8742A' }]);
  });

  it('adds a set beside an existing one and colors into it', () => {
    let d = addSet(emptyDraft(), SETS, 'Charts', 'swi_brand');
    expect(d.newSets).toEqual([{ id: 'swi_charts', name: 'Charts', besideSetId: 'swi_brand', idTouched: false }]);
    d = addColor(d, SETS, 'swi_charts', 'k1', '#4E79A7').draft;
    expect(d.newColors[0].id).toBe('swi_charts_new_color');
    expect(setViews(SETS, d).map(v => [v.id, v.isNew, v.colors.length])).toEqual([['swi_brand', false, 2], ['swi_status', false, 1], ['swi_charts', true, 1]]);
    const ops = pendingChanges(SETS, d).ops;
    expect(ops.map(o => o.kind)).toEqual(['addSet', 'add']);
    expect(removeNewSet(d, 'swi_charts')).toEqual(emptyDraft());
  });

  it('stops a save on a taken ID, an empty name or a bad color', () => {
    let d = addSet(emptyDraft(), SETS, 'Status', 'swi_brand');
    d = { ...d, newSets: d.newSets.map(s => ({ ...s, id: 'swi_status' })) };
    expect(problems(SETS, d).get('swi_status')).toBe('This ID is taken');
    const withColor = addColor(emptyDraft(), SETS, 'swi_brand', 'k1').draft;
    expect(problems(SETS, { ...withColor, newColors: withColor.newColors.map(n => ({ ...n, name: ' ' })) }).get('k1')).toBe('Give the color a name');
    expect(problems(SETS, { ...emptyDraft(), edits: { swi_blue: { hex: 'red' } } }).get('swi_blue')).toBe('Not a color');
    expect(problems(SETS, emptyDraft()).size).toBe(0);
  });

  it('checks the fresh read against what was sent', () => {
    const ops = pendingChanges(SETS, editColor(emptyDraft(), SETS[0], 'swi_blue', 'hex', '#1A56A0')).ops;
    const after: ColorSetData[] = [{ ...SETS[0], colors: [{ bid: 'swi_blue', name: 'Steadfast blue', rgb: 'rgb(26,86,160)' }, SETS[0].colors[1]] }, SETS[1]];
    expect(verifyColors(ops, after)).toEqual([]);
    expect(verifyColors(ops, SETS)).toEqual(['swi_blue reads #1F5FA8']);
    expect(verifyColors([{ kind: 'add', setId: 'swi_brand', id: 'nope', name: 'Nope', hex: '#fff' }], SETS)).toEqual(['The color Nope was not found']);
  });
});

const INDEX: ImageIndex = {
  folders: [{ id: 'icons', name: 'Icons', parentId: 'EXTERNALRESOURCE' }, { id: 'photos', name: 'Photos', parentId: 'EXTERNALRESOURCE' }],
  files: [
    { rid: '1', id: 'icon_ics', name: 'ics.png', folderId: 'icons' },
    { rid: '2', id: 'icon_erm', name: 'erm.png', folderId: 'icons' },
    { rid: '3', id: 'icon_esg', name: 'esg.png', folderId: 'icons' },
    { rid: '4', id: 'file_a', name: 'a.jpg', folderId: 'photos' },
  ],
};
const bytes = (n: number) => new Uint8Array(n).fill(65);

describe('image draft', () => {
  it('proposes IDs from the file names in the style of the selected folder', () => {
    let n = 0;
    const { added, skipped } = newImagesFor(
      [{ name: 'kri.svg', bytes: bytes(10) }, { name: 'Audit Plan.png', bytes: bytes(10) }, { name: 'notes.txt', bytes: bytes(1) }, { name: 'erm.svg', bytes: bytes(10) }],
      'icons', INDEX, [], () => `n${++n}`,
    );
    expect(added.map(a => [a.fileName, a.id, a.mime])).toEqual([
      ['kri.svg', 'icon_kri', 'image/svg+xml'], ['Audit Plan.png', 'icon_audit_plan', 'image/png'], ['erm.svg', 'icon_erm_2', 'image/svg+xml'],
    ]);
    expect(skipped).toEqual(['notes.txt']);
  });

  it('says what is wrong with an ID the person edited', () => {
    const item: NewImage = { key: 'a', fileName: 'x.png', bytes: bytes(1), mime: 'image/png', id: 'icon_erm', idTouched: true, folderId: 'icons' };
    expect(idProblem(item, INDEX, [item])).toBe('This ID is taken');
    expect(idProblem({ ...item, id: 'icon erm' }, INDEX, [])).toMatch(/letters/);
    expect(idProblem({ ...item, id: 'icon_new' }, INDEX, [{ ...item, key: 'b', id: 'icon_new' }])).toBe('This ID is taken');
    expect(idProblem({ ...item, id: 'icon_new' }, INDEX, [])).toBe('');
  });

  it('names a written file by its stem and the type written', () => {
    expect(outputName('erm.svg', 'image/png')).toBe('erm.png');
    expect(outputName('erm.png', 'image/svg+xml')).toBe('erm.svg');
    expect(outputName('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
  });

  it('builds the write: new files first, then changes, and leaves out what is too large', () => {
    const item: NewImage = { key: 'a', fileName: 'kri.svg', bytes: bytes(3), mime: 'image/svg+xml', id: 'icon_kri', idTouched: false, folderId: 'icons' };
    const big: NewImage = { ...item, key: 'b', fileName: 'big.png', id: 'icon_big' };
    const { ops, tooLarge } = buildFileOps(
      [{ item, out: { bytes: bytes(3), mime: 'image/png' } }, { item: big, out: { bytes: new Uint8Array(40_000), mime: 'image/png' } }],
      [{ file: INDEX.files[1], out: { bytes: bytes(3), mime: 'image/png' } }], b => btoa(String.fromCharCode(...b)),
    );
    expect(ops).toEqual([
      { kind: 'add', folderId: 'icons', id: 'icon_kri', name: 'kri.png', mime: 'image/png', base64: 'QUFB' },
      { kind: 'change', id: 'icon_erm', name: 'erm.png', mime: 'image/png', base64: 'QUFB' },
    ]);
    expect(tooLarge).toEqual(['big.png']);
  });

  it('says at once whether a file fits one write, with its size and the limit', () => {
    const item: NewImage = { key: 'a', fileName: 'photo.jpg', bytes: bytes(3), mime: 'image/jpeg', id: 'photo', idTouched: false, folderId: 'icons' };
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    expect(isOverLimit({ item }, { bytes: new Uint8Array(40_000), mime: 'image/jpeg' }, b64)).toBe(true);
    expect(isOverLimit({ item }, { bytes: new Uint8Array(10_000), mime: 'image/jpeg' }, b64)).toBe(false);
    expect(isOverLimit({ file: INDEX.files[1] }, { bytes: new Uint8Array(40_000), mime: 'image/png' }, b64)).toBe(true);
    expect(storedKb('A'.repeat(160_000))).toBe(120);
    expect(storedKb('')).toBe(1);
    expect(overLimitText('photo.jpg', 'A'.repeat(160_000))).toBe(`photo.jpg is 120 KB. One write holds about ${FILE_LIMIT_KB} KB.`);
  });

  it('checks the fresh list against what was sent', () => {
    const ops = [{ kind: 'add' as const, folderId: 'icons', id: 'icon_kri', name: 'kri.png', mime: 'image/png', base64: 'QUFB' }];
    expect(verifyFiles(ops, INDEX)).toEqual(['kri.png was not found']);
    const after: ImageIndex = { ...INDEX, files: [...INDEX.files, { rid: '9', id: 'icon_kri', name: 'kri.png', folderId: 'icons' }] };
    expect(verifyFiles(ops, after)).toEqual([]);
    expect(verifyFiles(ops, { ...after, files: after.files.map(f => f.id === 'icon_kri' ? { ...f, folderId: 'photos' } : f) })).toEqual(['kri.png is in another folder']);
  });
});
