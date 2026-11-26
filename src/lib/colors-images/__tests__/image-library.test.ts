/**
 * @vitest-environment happy-dom
 *
 * The image library: what ships (every SVG parses, has a viewBox, is small
 * and self-contained), how each collection takes a color through the SVG
 * color swap, and the licence note that only Phosphor icons carry.
 */
import { describe, expect, it } from 'vitest';
import {
  allItems, colorMapFor, coloredSvg, colorsOf, colorSuffix, isTint, itemsOf, libraryFiles, loadLibrary, PHOSPHOR_NOTE, searchItems, searchLibrary, statusLabel, tintOf, WHITE,
  type Library, type LibraryCollection, type LibraryColor,
} from '../image-library';
import { CURRENT_COLOR, svgColorsOfText } from '../svg-colors';
import { buildFileOps, defaultDestination, newImagesFor, reproposeId } from '../images-draft';
import { buildFileWriteEc } from '../write-ops';

/** One shipped image may be at most this large (bytes of SVG text). */
const SIZE_LIMIT = 4_000;

const lib = await loadLibrary();
const coll = (l: Library, id: string): LibraryCollection => l.collections.find(c => c.id === id)!;
const one = (hex: string): LibraryColor => ({ mode: 'one', hex, map: {} });
const parse = (text: string) => new DOMParser().parseFromString(text, 'image/svg+xml');

describe('what the library ships', () => {
  const all = lib.collections.flatMap(c => itemsOf(c).flatMap(i => Object.entries(i.svg).map(([v, svg]) => ({ c: c.id, key: i.key, v, svg }))));

  it('holds the decided images: 77 status symbols, 16 GRC metaphors in three styles, 197 Phosphor icons in two weights', () => {
    expect(itemsOf(coll(lib, 'status'))).toHaveLength(77);
    expect(itemsOf(coll(lib, 'grc')).map(i => i.code)).toEqual(['R1', 'R2', 'R5', 'C1', 'C2', 'C5', 'M1', 'M2', 'M3', 'M4', 'M5', 'P1', 'P2', 'P3', 'P4', 'P5']);
    expect(coll(lib, 'grc').variants.map(v => v.label)).toEqual(['Line', 'Two-tone', 'Tile']);
    expect(itemsOf(coll(lib, 'buttons'))).toHaveLength(197);
    expect(coll(lib, 'buttons').groups).toHaveLength(19);
    expect(coll(lib, 'buttons').variants.map(v => v.id)).toEqual(['regular', 'fill']);
    expect(all).toHaveLength(77 + 16 * 3 + 197 * 2);
    // No triangles; dots and squares in all colours and glyphs.
    expect(itemsOf(coll(lib, 'status')).some(i => i.key.includes('triangle'))).toBe(false);
    expect(coll(lib, 'status').groups.map(g => g.name)).toEqual(['Status dots', 'Status squares', 'Control effectiveness', 'Progress', 'Trend', 'Risk level', 'Approval', 'Traffic light', 'Harvey balls']);
  });

  it('every SVG parses, has a viewBox, stays small and holds no script or outside reference', () => {
    for (const { key, v, svg } of all) {
      const doc = parse(svg);
      const where = `${key} ${v}`;
      expect(doc.querySelector('parsererror'), where).toBeNull();
      expect(doc.documentElement.localName, where).toBe('svg');
      expect(doc.documentElement.getAttribute('viewBox'), where).toMatch(/^[\d.\s-]+$/);
      expect(svg.length, where).toBeLessThan(SIZE_LIMIT);
      expect(svg, where).not.toMatch(/<script|<foreignObject|\son[a-z]+=|href="(?!#)|url\((?!#)|<image/i);
    }
  });

  it('gives every image a file name the draft proposes an ID from, unique within a collection and variant', () => {
    for (const c of lib.collections) for (const v of c.variants) {
      const names = itemsOf(c).map(i => i.fileName[v.id]);
      expect(new Set(names).size).toBe(names.length);
      expect(names.every(n => /^[a-z0-9_-]+\.svg$/.test(n))).toBe(true);
    }
    const r1 = itemsOf(coll(lib, 'grc'))[0];
    expect(r1.fileName).toEqual({ line: 'risk_warning_triangle_line.svg', twotone: 'risk_warning_triangle_twotone.svg', tile: 'risk_warning_triangle_tile.svg' });
    expect(itemsOf(coll(lib, 'buttons'))[0].fileName).toEqual({ regular: 'plus.svg', fill: 'plus-fill.svg' });
  });

  it('names status symbols plainly and finds images by name, number or group', () => {
    expect(statusLabel('status_dot_green_check')).toBe('Green check');
    expect(statusLabel('control_partly_effective')).toBe('Partly effective');
    expect(statusLabel('harvey_25')).toBe('25%');
    expect(searchItems(coll(lib, 'grc'), 'r2').map(i => i.label)).toEqual(['Lightning']);
    expect(searchItems(coll(lib, 'buttons'), 'trash').map(i => i.label)).toContain('trash');
    expect(searchItems(coll(lib, 'status'), 'red cross').map(i => i.key)).toEqual(['status:status_dot_red_cross', 'status:status_square_red_cross']);
  });

  it('gives every image search keywords, and its words to search in', () => {
    for (const i of allItems(lib)) {
      expect(i.keywords.length, i.key).toBeGreaterThan(0);
      expect(i.nameWords.length, i.key).toBeGreaterThan(0);
      expect(i.otherWords.length, i.key).toBeGreaterThan(0);
    }
    const kw = (key: string) => allItems(lib).find(i => i.key === key)!.keywords;
    // Phosphor's own tags and category.
    expect(kw('buttons:check-circle')).toEqual(expect.arrayContaining(['ok', 'done', 'todo', 'system']));
    // Written by hand: colour, meaning, shape, German.
    expect(kw('status:status_dot_green_check')).toEqual(expect.arrayContaining(['green', 'grün', 'ok', 'done', 'dot', 'check', 'erledigt']));
    expect(kw('status:progress_overdue')).toEqual(expect.arrayContaining(['overdue', 'red', 'überfällig']));
    expect(kw('grc:C2')).toEqual(expect.arrayContaining(['lock', 'control', 'kontrolle']));
    expect(kw('grc:P5')).toEqual(expect.arrayContaining(['scales', 'policy', 'richtlinie']));
  });
});

describe('the library search', () => {
  const items = allItems(lib);
  const keys = (q: string) => searchLibrary(items, q).map(i => i.key);

  it('finds by meaning, not only by file name, and ranks name matches first', () => {
    const green = keys('green');
    expect(green.slice(0, 3)).toEqual(['status:status_dot_green', 'status:status_dot_green_ring', 'status:status_dot_green_check']);
    // Found by its keywords, after every name match.
    expect(green.indexOf('status:control_effective')).toBeGreaterThan(green.indexOf('status:traffic_green'));
    expect(green).toEqual(expect.arrayContaining(['status:progress_done', 'status:approval_approved', 'status:risk_low']));
    expect(keys('ok')).toEqual(expect.arrayContaining(['status:status_dot_green_check', 'status:progress_done', 'buttons:check-circle']));
    expect(keys('warning')).toEqual(expect.arrayContaining(['status:status_dot_amber_excl', 'grc:R1']));
    expect(keys('traffic light')).toEqual(expect.arrayContaining(['status:traffic_red', 'status:traffic_amber', 'status:traffic_green', 'status:traffic_off']));
  });

  it('takes German words, with or without accents and umlauts', () => {
    const ampel = keys('ampel');
    expect(ampel).toEqual(expect.arrayContaining(['status:traffic_red', 'status:traffic_green', 'status:status_dot_green', 'status:status_square_red']));
    expect(ampel).not.toContain('status:status_dot_blue');
    for (const q of ['grün', 'grun', 'gruen', 'GRÜN']) expect(keys(q), q).toContain('status:status_dot_green');
    // The overdue progress symbol, and the red ones that also mean overdue.
    expect(keys('überfällig')).toContain('status:progress_overdue');
    expect(keys('uberfallig')).toEqual(keys('überfällig'));
    expect(keys('ueberfaellig')).toEqual(keys('überfällig'));
    expect(keys('überfällig').every(k => k === 'status:progress_overdue' || k.includes('red'))).toBe(true);
    expect(keys('kontrolle').some(k => k.startsWith('grc:C'))).toBe(true);
    expect(keys('richtlinie').filter(k => k.startsWith('grc:'))).toEqual(['grc:P1', 'grc:P2', 'grc:P3', 'grc:P4', 'grc:P5']);
  });

  it('needs every word of the query to start a word of the image', () => {
    expect(keys('green check')).toEqual(['status:status_dot_green_check', 'status:status_square_green_check']);
    expect(keys('red sq').length).toBeGreaterThan(0);
    expect(keys('red sq').every(k => k.includes('square'))).toBe(true);
    // "een" is inside "green" but starts no word.
    expect(keys('een')).toEqual([]);
    expect(keys('measure gauge')).toEqual(['grc:M1', 'buttons:gauge']);
  });

  it('answers a query with no match, or no words, with nothing', () => {
    expect(keys('zebra')).toEqual([]);
    expect(keys('  ')).toEqual([]);
    expect(keys('-')).toEqual([]);
  });
});

describe('IDs of library images', () => {
  const index = (ids: string[]) => ({
    folders: [{ id: 'f', name: 'Status', parentId: '' }, { id: 'g', name: 'Other', parentId: '' }],
    files: ids.map((id, i) => ({ rid: String(9007199254740993n + BigInt(i)), id, name: `${id}.svg`, folderId: 'f' })),
  });
  const pick = (key: string, variant = 'flat') => ({ item: allItems(lib).find(i => i.key === key)!, variant, description: '' });
  const original: LibraryColor = { mode: 'original', hex: '#000000', map: {} };
  let n = 0;
  const next = () => `k${++n}`;

  it('start with icon_ where the folder gives no prefix and keep the prefix the neighbours share; dropped files get none', () => {
    const files = libraryFiles([pick('status:status_dot_green')], original);
    expect(newImagesFor(files, 'f', index(['home', 'search']), [], next).added[0].id).toBe('icon_status_dot_green');
    expect(newImagesFor(files, 'f', index(['button_save', 'button_edit', 'button_delete']), [], next).added[0].id).toBe('button_status_dot_green');
    expect(newImagesFor([{ name: 'status_dot_green.svg', bytes: files[0].bytes }], 'f', index(['home', 'search']), [], next).added[0].id).toBe('status_dot_green');
  });

  it('end with the one colour as six lower-case hex digits; Original and Swap colors add none', () => {
    const id = (c: LibraryColor, key = 'buttons:pencil-simple') => newImagesFor(libraryFiles([pick(key, 'regular')], c), 'f', index([]), [], next).added[0].id;
    expect(colorSuffix({ mode: 'one', hex: '#FFFFFF' })).toBe('ffffff');
    expect(id({ mode: 'one', hex: WHITE, map: {} })).toBe('icon_pencil_simple_ffffff');
    expect(id({ mode: 'one', hex: '#003C64', map: {} }, 'buttons:plus')).toBe('icon_plus_003c64');
    expect(id(original)).toBe('icon_pencil_simple');
    expect(id({ mode: 'swap', hex: '#000000', map: { [CURRENT_COLOR]: '#003C64' } })).toBe('icon_pencil_simple');
  });

  it('are made unique after the colour, as any proposed ID', () => {
    const files = libraryFiles([pick('buttons:plus', 'regular'), pick('buttons:plus', 'regular')], { mode: 'one', hex: '#003C64', map: {} });
    expect(newImagesFor(files, 'f', index(['icon_plus_003c64']), [], next).added.map(a => a.id)).toEqual(['icon_plus_003c64_2', 'icon_plus_003c64_3']);
  });

  it('follow a later colour and folder while still proposed; an ID the person typed stays', () => {
    const idx = index([]);
    idx.files.push({ rid: '9007199254740999', id: 'btn_a', name: 'a.svg', folderId: 'g' }, { rid: '9007199254741000', id: 'btn_b', name: 'b.svg', folderId: 'g' });
    const { added } = newImagesFor(libraryFiles([pick('buttons:plus', 'regular'), pick('buttons:trash', 'regular')], original), 'f', idx, [], next);
    const [plus, trash] = added;
    expect(plus.id).toBe('icon_plus');
    expect(reproposeId(plus, idx, added, 'ffffff')).toBe('icon_plus_ffffff');
    plus.folderId = 'g';
    expect(reproposeId(plus, idx, added, 'ffffff')).toBe('btn_plus_ffffff');
    expect(reproposeId(plus, idx, added)).toBe('btn_plus');
    trash.id = 'my_bin'; trash.idTouched = true;
    expect(reproposeId(trash, idx, added, 'ffffff')).toBe('my_bin');
  });
});

describe('where library images go by default', () => {
  const folders = [
    { id: 'images', name: 'Images', parentId: '' }, { id: 'nav', name: 'Navigation', parentId: 'images' },
    { id: 'btn1', name: 'Button icons (old)', parentId: 'images' }, { id: 'btn2', name: 'Buttons', parentId: 'images' }, { id: 'st', name: 'Status', parentId: 'images' },
  ];
  const file = (folderId: string, i: number) => ({ rid: String(9007199254740993n + BigInt(i)), id: `x${i}`, name: `x${i}.svg`, folderId });
  const index = { folders, files: [file('nav', 1), file('btn1', 2), file('btn2', 3), file('btn2', 4)] };
  const order = ['images', 'nav', 'btn1', 'btn2'];

  it('is the folder chosen in the sidebar', () => {
    expect(defaultDestination(index, 'nav', 'buttons', order)).toBe('nav');
    expect(defaultDestination(index, 'nav', 'status', order)).toBe('nav');
  });

  it('with All images: the folder whose name says the kind and that holds most images, else the first folder', () => {
    expect(defaultDestination(index, null, 'buttons', order)).toBe('btn2');
    // An empty folder named Status is still the place for status symbols.
    expect(defaultDestination(index, null, 'status', order)).toBe('st');
    expect(defaultDestination(index, null, 'grc', order)).toBe('images');
    expect(defaultDestination(index, null, null, order)).toBe('images');
    expect(defaultDestination(index, 'gone', 'grc', [])).toBe('images');
    expect(defaultDestination({ folders: [], files: [] }, null, 'status')).toBe('');
  });
});

describe('colors', () => {
  const item = (c: string, key: string) => itemsOf(coll(lib, c)).find(i => i.key === key)!;

  it('One color on a status symbol: the drawing takes the color, its white glyph stays white', () => {
    const svg = coloredSvg(item('status', 'status:status_dot_green_check').svg.flat, one('#7650C2'));
    expect(svgColorsOfText(svg).map(c => c.key).sort()).toEqual(['#7650C2', WHITE]);
  });

  it('Swap colors maps each palette color of a status symbol to the person\'s own', () => {
    const src = item('status', 'status:risk_high').svg.flat;
    expect(colorsOf(src)).toEqual(['#CF3030', '#D5D9DF']);
    const svg = coloredSvg(src, { mode: 'swap', hex: '#000000', map: { '#CF3030': '#B00020' } });
    expect(colorsOf(svg).sort()).toEqual(['#B00020', '#D5D9DF']);
  });

  it('One color on a GRC icon: the line takes the color, the soft fill a light tint of it; the tile style keeps its mask', () => {
    const r1 = item('grc', 'grc:R1');
    const two = coloredSvg(r1.svg.twotone, one('#0E7C86'));
    expect(colorsOf(two).sort()).toEqual(['#0E7C86', tintOf('#0E7C86')].sort());
    expect(isTint(tintOf('#0E7C86'))).toBe(true);
    const tile = coloredSvg(r1.svg.tile, one('#0E7C86'));
    expect(colorsOf(tile).sort()).toEqual(['#0E7C86', tintOf('#0E7C86')].sort());
    // The cut-out of the glyph is a mask: its black and white are not the icon's colors and stay as they are.
    const mask = parse(tile).querySelector('mask')!;
    expect(mask.querySelector('rect')!.getAttribute('fill')).toBe('#fff');
    expect(mask.querySelector('g')!.getAttribute('stroke')).toBe('#000');
  });

  it('a Phosphor icon draws in currentColor: One color and the White preset paint it, Swap colors maps it', () => {
    const plus = item('buttons', 'buttons:plus');
    for (const v of ['regular', 'fill']) {
      expect(colorsOf(plus.svg[v])).toEqual([CURRENT_COLOR]);
      expect(colorsOf(coloredSvg(plus.svg[v], one(WHITE)))).toEqual([WHITE]);
      expect(colorsOf(coloredSvg(plus.svg[v], { mode: 'swap', hex: '', map: { [CURRENT_COLOR]: '#1A56A0' } }))).toEqual(['#1A56A0']);
    }
    // White on a status symbol leaves its white glyph white: the map does not touch white.
    expect(colorMapFor(['#1F8549', WHITE], one(WHITE))).toEqual({ '#1F8549': WHITE });
    // Original keeps the file as it is (currentColor stays, so BMP can still draw it in the text color).
    expect(colorsOf(coloredSvg(plus.svg.regular, { mode: 'original', hex: '#000000', map: {} }))).toEqual([CURRENT_COLOR]);
  });
});

describe('into the draft', () => {
  const index = { folders: [{ id: 'icons', name: 'Icons', parentId: '' }], files: [{ rid: '9007199254740993', id: 'icon_home', name: 'home.png', folderId: 'icons' }, { rid: '9007199254740994', id: 'icon_plus', name: 'plus.svg', folderId: 'icons' }] };

  it('Phosphor icons carry the licence note as their description, the owner\'s drawings none; the write sets it', () => {
    const pick = (c: string, key: string, variant: string) => ({ item: itemsOf(coll(lib, c)).find(i => i.key === key)!, variant, description: coll(lib, c).description });
    const files = libraryFiles([pick('buttons', 'buttons:plus', 'fill'), pick('status', 'status:trend_stable', 'flat'), pick('grc', 'grc:M1', 'tile')], one(WHITE));
    expect(files.map(f => [f.name, f.description])).toEqual([['plus-fill.svg', PHOSPHOR_NOTE], ['trend_stable.svg', undefined], ['measure_gauge_tile.svg', undefined]]);

    let n = 0;
    const { added } = newImagesFor(files, 'icons', index, [], () => `k${++n}`);
    // One color (white here): the ID ends with it.
    expect(added.map(a => [a.id, a.description])).toEqual([['icon_plus_fill_ffffff', PHOSPHOR_NOTE], ['icon_trend_stable_ffffff', ''], ['icon_measure_gauge_tile_ffffff', '']]);
    const { ops } = buildFileOps(added.map(item => ({ item, out: { bytes: item.bytes, mime: item.mime } })), [], b => btoa(String.fromCharCode(...b)));
    expect(ops.map(o => (o.kind === 'add' ? o.description : null))).toEqual([PHOSPHOR_NOTE, undefined, undefined]);
    expect(buildFileWriteEc(ops[0])).toMatch(/^t\.icons\.add\(FileResource, id := "icon_plus_fill_ffffff", name := "plus-fill\.svg", description := "Phosphor Icons \(MIT License\), phosphoricons\.com", content := "plus-fill\.svg;image\/svg\+xml;/);
    expect(buildFileWriteEc(ops[1])).not.toContain('description');
  });
});

describe('the AI group', () => {
  it('has five icons and is found by "ai", "ki" and "agent"', async () => {
    const lib = await loadLibrary();
    const all = lib.collections.flatMap(c => c.groups.flatMap(g => g.items));
    const ai = all.filter(i => i.group === 'AI');
    expect(ai.map(i => i.label).sort()).toEqual(['brain', 'cpu', 'head-circuit', 'robot', 'sparkle']);
    for (const q of ['ai', 'ki', 'agent']) {
      const hits = searchLibrary(all, q).filter(i => i.group === 'AI');
      expect(hits).toHaveLength(5);
    }
  });
});
