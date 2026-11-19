/**
 * The pure parts of the Colors and images page: colour arithmetic, proposed
 * IDs, the image folder tree, the write statements and the SVG adjustments.
 */
import { describe, expect, it } from 'vitest';
import {
  contrastRatio, hexFromRgbText, hexToHsv, hsvToHex, normalizeHex, rgbToHex, hexToRgb, textOn,
} from '../color-math';
import { idPart, isValidId, proposeColorId, proposeIds, sharedPrefix } from '../id-proposal';
import {
  buildImageIndexEc, buildImageTree, FILE_FIELD, FILE_ROW, folderIds, folderPath, imageMime, imagesIn, isImageName, parseImageIndexLog,
  totalImages, type ImageIndex,
} from '../image-files';
import { buildColorWriteEc, buildFileWriteEc, fileContent, fileFits, SCRIPT_BUDGET } from '../write-ops';

describe('color math', () => {
  it('reads hex as people type it', () => {
    expect(normalizeHex('1a56a0')).toBe('#1A56A0');
    expect(normalizeHex(' #1a5 ')).toBe('#11AA55');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('blue')).toBeNull();
  });

  it('converts between hex, rgb and hsv without drift', () => {
    expect(rgbToHex(hexToRgb('#1A56A0'))).toBe('#1A56A0');
    for (const hex of ['#1A56A0', '#E8742A', '#12808A', '#FFFFFF', '#000000', '#7FB6E6']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
    expect(hexFromRgbText('rgb(26,86,160)')).toBe('#1A56A0');
    expect(hexFromRgbText('nothing')).toBeNull();
  });

  it('gives the contrast of white and black text', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    const blue = textOn('#1A56A0');
    expect(blue.white).toBeGreaterThan(blue.black);
    expect(blue.white).toBeGreaterThan(7);
    const sand = textOn('#E9DCC4');
    expect(sand.black).toBeGreaterThan(sand.white);
  });
});

describe('proposed IDs', () => {
  it('follows the style of the neighbours', () => {
    expect(sharedPrefix(['icon_ics', 'icon_erm', 'icon_itrm', 'logo'])).toBe('icon_');
    expect(sharedPrefix(['a_x', 'b_y', 'c_z'])).toBe('');
    expect(proposeIds(['erm.svg', 'KRI.svg', 'Audit Plan.svg'], ['icon_ics', 'icon_itrm', 'icon_esg'])).toEqual(['icon_erm', 'icon_kri', 'icon_audit_plan']);
  });

  it('does not double a prefix the name already has', () => {
    expect(proposeIds(['icon_home.png'], ['icon_a', 'icon_b'])).toEqual(['icon_home']);
  });

  it('keeps every ID unique, also against the workspace', () => {
    expect(proposeIds(['erm.svg', 'erm.png'], ['icon_a', 'icon_b'], ['icon_erm'])).toEqual(['icon_erm_2', 'icon_erm_3']);
  });

  it('proposes a plain ID without neighbours, and never starts with a digit', () => {
    expect(proposeIds(['Logo Dark.png'], [])).toEqual(['logo_dark']);
    expect(proposeIds(['2024 plan.png'], [])).toEqual(['img_2024_plan']);
    expect(idPart('Für Ärzte.svg')).toBe('fur_arzte');
    expect(isValidId('icon_erm')).toBe(true);
    expect(isValidId('icon erm')).toBe(false);
  });
});

const SAMPLE: ImageIndex = {
  folders: [
    { id: 'root1', name: 'Default', parentId: 'EXTERNALRESOURCE' },
    { id: 'photos', name: 'Photography', parentId: 'root1' },
    { id: 'icons', name: 'Icons', parentId: 'root1' },
    { id: 'icons_deep', name: 'Deep', parentId: 'icons' },
    { id: 'libs', name: 'Libraries', parentId: 'EXTERNALRESOURCE' },
    { id: 'sheets', name: 'Sheets', parentId: 'root1' },
  ],
  files: [
    { rid: '1', id: 'p1', name: 'a.jpg', folderId: 'photos' },
    { rid: '2', id: 'i1', name: 'a.png', folderId: 'icons' },
    { rid: '3', id: 'i2', name: 'b.svg', folderId: 'icons_deep' },
    { rid: '9007199254740993', id: 'i3', name: 'c.png', folderId: 'root1' },
  ],
};

describe('image files', () => {
  it('knows images by the extension of the name', () => {
    expect(isImageName('a.PNG')).toBe(true);
    expect(isImageName('x.svg')).toBe(true);
    for (const n of ['lib.min.js', 'a.css', 'Threshold Upload.xlsx', 'w.wasm', 'x.txt', 'noextension']) expect(isImageName(n)).toBe(false);
    expect(imageMime('a.jpeg')).toBe('image/jpeg');
    expect(imageMime('a.js')).toBeNull();
  });

  it('keeps only the folders with images beneath them, nested, with counts', () => {
    const tree = buildImageTree(SAMPLE);
    expect(tree.map(r => r.id)).toEqual(['root1']);
    const root = tree[0];
    expect(root.count).toBe(4);
    expect(root.own).toBe(1);
    expect(root.children.map(c => [c.id, c.count])).toEqual([['photos', 1], ['icons', 2]]);
    expect(root.children[1].children.map(c => c.id)).toEqual(['icons_deep']);
    // 'libs' and 'sheets' hold no image: not in the tree.
    expect(JSON.stringify(tree)).not.toMatch(/libs|sheets/);
    expect(totalImages(tree)).toBe(4);
  });

  it('lists the images of a folder with everything beneath it, or the folder alone', () => {
    const tree = buildImageTree(SAMPLE);
    expect(imagesIn(SAMPLE, tree, 'icons').map(f => f.id)).toEqual(['i1', 'i2']);
    expect(imagesIn(SAMPLE, tree, 'icons', false).map(f => f.id)).toEqual(['i1']);
    expect(imagesIn(SAMPLE, tree, null)).toHaveLength(4);
    expect([...folderIds(tree, 'icons')].sort()).toEqual(['icons', 'icons_deep']);
    expect(folderPath(SAMPLE, 'icons_deep')).toBe('Default / Icons / Deep');
  });

  it('does not loop on a folder that is its own ancestor', () => {
    const tree = buildImageTree({
      folders: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'c' }],
      files: [{ rid: '1', id: 'x', name: 'x.png', folderId: 'a' }, { rid: '2', id: 'y', name: 'y.png', folderId: 'c' }],
    });
    expect(totalImages(tree)).toBeGreaterThanOrEqual(0);
  });

  it('reads the answer of the one read and refuses a cut answer', () => {
    const F = FILE_FIELD, R = FILE_ROW;
    const log = [`K${F}root1${F}Default${F}EXTERNALRESOURCE${R}`, `I${F}1524126395561369203${F}icon_erm${F}erm.png${F}root1${R}`,
      `I${F}77${F}lib${F}lib.js${F}root1${R}`, `D${F}2${R}`].join('');
    const index = parseImageIndexLog(log);
    expect(index.folders).toEqual([{ id: 'root1', name: 'Default', parentId: 'EXTERNALRESOURCE' }]);
    // The rid stays a string; the script file is not listed.
    expect(index.files).toEqual([{ rid: '1524126395561369203', id: 'icon_erm', name: 'erm.png', folderId: 'root1' }]);
    expect(() => parseImageIndexLog(`K${F}a${F}A${F}${R}`)).toThrow(/cut off/);
    expect(() => parseImageIndexLog(`I${F}1${F}a${F}a.png${F}x${R}D${F}2${R}`)).toThrow(/expected 2/);
  });

  it('reads files without growing one text, and never their content', () => {
    const ec = buildImageIndexEc();
    expect(ec).toContain('.calculate(');
    expect(ec).toContain('.join("")');
    expect(ec).not.toMatch(/\.content/);
  });
});

describe('write statements', () => {
  it('changes a color by its ID, only what changed', () => {
    expect(buildColorWriteEc([{ kind: 'change', id: 'swi_blue', hex: '#1a56a0' }])).toBe('t.swi_blue.change(color := "#1A56A0")');
    expect(buildColorWriteEc([{ kind: 'change', id: 'swi_blue', name: 'Blue "main"', hex: '#112233' }]))
      .toBe('t.swi_blue.change(name := "Blue \\"main\\"", color := "#112233")');
  });

  it('adds a color to a set, and a set with its colors', () => {
    const ec = buildColorWriteEc([
      { kind: 'addSet', besideSetId: 'swi_brand', id: 'swi_new', name: 'New set' },
      { kind: 'add', setId: 'swi_new', id: 'swi_new_ff0000', name: 'Red', hex: '#ff0000' },
      { kind: 'add', setId: 'swi_brand', id: 'swi_brand_00ff00', name: 'Green', hex: '#00FF00' },
    ]).split('\n');
    expect(ec).toEqual([
      '_p1 := t.swi_brand.parent',
      '_s1 := _p1.add(CorpoColorSet, id := "swi_new", name := "New set")',
      '_s1.add(CorpoColor, id := "swi_new_ff0000", name := "Red", color := "#FF0000")',
      't.swi_brand.add(CorpoColor, id := "swi_brand_00ff00", name := "Green", color := "#00FF00")',
    ]);
  });

  it('refuses what is not an ID, a color or a name, and has no delete', () => {
    expect(() => buildColorWriteEc([{ kind: 'change', id: 'a b', hex: '#fff' }])).toThrow(/valid ID/);
    expect(() => buildColorWriteEc([{ kind: 'change', id: 'a', hex: 'red' }])).toThrow(/Not a color/);
    expect(() => buildColorWriteEc([{ kind: 'add', setId: 'a"); delete(', id: 'x', name: 'x', hex: '#fff' }])).toThrow(/valid ID/);
    expect(buildColorWriteEc([{ kind: 'change', id: 'a', hex: '#fff' }])).not.toMatch(/delete/i);
  });

  it('adds a file under a folder and changes the content of one', () => {
    expect(fileContent('erm;x.png', 'image/png', 'AAAA')).toBe('ermx.png;image/png;AAAA');
    expect(buildFileWriteEc({ kind: 'add', folderId: 'folder_icons', id: 'icon_erm', name: 'erm.png', mime: 'image/png', base64: 'iVBO\nRw0K' }))
      .toBe('t.folder_icons.add(FileResource, id := "icon_erm", name := "erm.png", content := "erm.png;image/png;iVBORw0K")');
    expect(buildFileWriteEc({ kind: 'change', id: 'icon_erm', name: 'erm.png', mime: 'image/png', base64: 'AAAA' }))
      .toBe('r.icon_erm.change(content := "erm.png;image/png;AAAA")');
  });

  it('guards the content and says when a file is too large for one write', () => {
    expect(() => buildFileWriteEc({ kind: 'add', folderId: 'f', id: 'a', name: 'a.png', mime: 'image/png', base64: '"; delete' })).toThrow(/base64/);
    const small = { kind: 'add' as const, folderId: 'f', id: 'a', name: 'a.png', mime: 'image/png', base64: 'A'.repeat(1000) };
    expect(fileFits(small)).toBe(true);
    expect(fileFits({ ...small, base64: 'A'.repeat(SCRIPT_BUDGET) })).toBe(false);
  });

  describe('proposeColorId', () => {
    it('goes on with the numbers of numbered IDs', () => {
      expect(proposeColorId('New color', 'action_status_colours', ['action_status_colour_1', 'action_status_colour_2', 'action_status_colour_5'])).toBe('action_status_colour_6');
      expect(proposeColorId('New color', 'riskradar', ['riskradar_color1', 'riskradar_color2'])).toBe('riskradar_color3');
      expect(proposeColorId('New color', 'bc', ['bm1', 'bm2', 'bm3'], ['bm4'])).toBe('bm5');
    });
    it('starts like the colors in the set and ends with the name', () => {
      expect(proposeColorId('Signal orange', 'swi_brand', ['swi_brand_blue', 'swi_brand_navy'])).toBe('swi_brand_signal_orange');
      expect(proposeColorId('Signal orange', 'steadfast_colours', ['colour_cyan', 'colour_navy', 'colour_white', 'assessment_navigation_background'])).toBe('colour_signal_orange');
      expect(proposeColorId('Colour blue', 'x', ['colour_cyan', 'colour_navy'])).toBe('colour_blue');
    });
    it('takes the set ID and the name when the colors show no pattern', () => {
      expect(proposeColorId('Signal orange', 'swi_charts', [])).toBe('swi_charts_signal_orange');
      expect(proposeColorId('Gold', 'basic', ['trans', 'black', 'white', 'gray'])).toBe('basic_gold');
      expect(proposeColorId('Gold', 'basic', ['black'])).toBe('basic_gold');
      expect(proposeColorId('', 'basic', [])).toBe('basic_color');
    });
    it('keeps IDs apart that are taken, whatever the case', () => {
      expect(proposeColorId('Gold', 'basic', [], ['Basic_Gold'])).toBe('basic_gold_2');
    });
  });
});
