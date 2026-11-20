import { describe, expect, it } from 'vitest';
import { BADGE_R, boxName, cutWords, boxesFor, contentTop, placeBadges, spreadBadges, type BadgeAsk, type Box, type PlacedBadge } from '../sketch-picture';

const t = (id: string, left: number, top: number, width: number, height: number) => ({ id, kind: 'widget' as const, rect: { left, top, width, height } });
const label = (id: string) => ({ name: `Name ${id}`, type: 'TextElement' });

describe('boxesFor', () => {
  it('moves page coordinates into the window and draws the larger box first', () => {
    const boxes = boxesFor([t('small', 120, 700, 100, 50), t('big', 20, 650, 800, 400)], label, { x: 0, y: 600 }, { w: 1440, h: 900 });
    expect(boxes.map(b => b.id)).toEqual(['big', 'small']);
    expect(boxes[1]).toMatchObject({ x: 120, y: 100, w: 100, h: 50, name: 'Name small', type: 'TextElement' });
  });

  it('leaves out boxes that are off screen or too small to see', () => {
    const boxes = boxesFor([t('above', 0, 0, 300, 100), t('below', 0, 2000, 300, 100), t('tiny', 10, 700, 4, 4), t('in', 10, 700, 300, 100)], label, { x: 0, y: 600 }, { w: 1440, h: 900 });
    expect(boxes.map(b => b.id)).toEqual(['in']);
  });
});

describe('spreadBadges', () => {
  it('two marks on one object: the later badge moves aside so both numbers show', () => {
    const out = spreadBadges([{ label: '1', x: 400, y: 100 }, { label: '2', x: 400, y: 100 }, { label: '3', x: 404, y: 102 }], 1440);
    expect(out[0]).toEqual({ label: '1', x: 400, y: 100 });
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThanOrEqual(24);
  });

  it('keeps badges inside the picture at its edges, and leaves badges that are apart alone', () => {
    const out = spreadBadges([{ label: '1', x: 12, y: 50 }, { label: '2', x: 12, y: 50 }], 300);
    expect(out[1].x).toBeGreaterThanOrEqual(12);
    expect(spreadBadges([{ label: '1', x: 10, y: 10 }, { label: '2', x: 200, y: 10 }], 300)).toEqual([{ label: '1', x: 10, y: 10 }, { label: '2', x: 200, y: 10 }]);
  });
});

describe('the drawn picture starts at what it shows', () => {
  it('leaves out the empty top of the window, with a little room', () => {
    expect(contentTop([120, 96, 300], 900)).toBe(82);
    expect(contentTop([], 900)).toBe(0);
    expect(contentTop([5], 900)).toBe(0);
    expect(contentTop([Infinity, 2000], 900)).toBe(0);
  });

  it('an object without a name of its own shows its ID', () => {
    expect(boxName('Open risks', 'tbl_open_risks')).toBe('Open risks');
    expect(boxName('', 'tbl_open_risks')).toBe('ID tbl_open_risks');
    expect(boxName('tbl_open_risks', 'tbl_open_risks')).toBe('ID tbl_open_risks');
  });
});

describe('placeBadges: a badge on an object belongs to that object alone', () => {
  const view = { w: 1440, h: 900 };
  const inside = (b: PlacedBadge, box: Box): boolean => b.x - BADGE_R >= box.x && b.y - BADGE_R >= box.y && b.x + BADGE_R <= box.x + box.w && b.y + BADGE_R <= box.y + box.h;
  const touches = (b: PlacedBadge, box: Box): boolean => {
    const nx = Math.max(box.x, Math.min(b.x, box.x + box.w)), ny = Math.max(box.y, Math.min(b.y, box.y + box.h));
    return Math.hypot(nx - b.x, ny - b.y) < BADGE_R;
  };
  const apart = (bs: PlacedBadge[]): boolean => bs.every((a, i) => bs.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= 2 * BADGE_R));

  it('two stacked buttons: each badge sits inside its own button and touches the other not at all', () => {
    const top = { id: 'btn_a', x: 900, y: 300, w: 160, h: 32 }, low = { id: 'btn_b', x: 900, y: 336, w: 160, h: 32 };
    const out = placeBadges([{ label: '1', object: 'btn_a', box: top }, { label: '2', object: 'btn_b', box: low }], [top, low], view);
    expect(inside(out[0], top) && !touches(out[0], low)).toBe(true);
    expect(inside(out[1], low) && !touches(out[1], top)).toBe(true);
  });

  it('a badge never straddles the border to the next object (the case that read as either)', () => {
    const table = { id: 'tbl', x: 24, y: 278, w: 1376, h: 332 }, news = { id: 'news', x: 953, y: 627, w: 447, h: 300 };
    const out = placeBadges([{ label: '1', object: 'tbl', box: table }, { label: '2', object: 'tbl', box: table }], [table, news], view);
    for (const b of out) { expect(inside(b, table)).toBe(true); expect(touches(b, news)).toBe(false); }
    expect(apart(out)).toBe(true);
  });

  it('several marks on one object: all badges show, side by side inside it, and in rows when it is narrow', () => {
    const box = { id: 'w', x: 100, y: 100, w: 400, h: 200 };
    const asks: BadgeAsk[] = ['1', '2', '3'].map(label => ({ label, object: 'w', box }));
    const out = placeBadges(asks, [box], view);
    expect(out.map(b => b.label)).toEqual(['1', '2', '3']);
    expect(out.every(b => inside(b, box))).toBe(true);
    expect(apart(out)).toBe(true);
    const narrow = { id: 'n', x: 100, y: 400, w: 50, h: 120 };
    const tall = placeBadges(['1', '2', '3'].map(label => ({ label, object: 'n', box: narrow })), [narrow], view);
    expect(tall.every(b => inside(b, narrow))).toBe(true);
    expect(apart(tall)).toBe(true);
  });

  it('a button in the corner: the badges move along the edge, past it, and stay in reading order', () => {
    const box = { id: 'w', x: 0, y: 0, w: 900, h: 400 };
    const buttons = [{ x: 830, y: 8, w: 30, h: 30 }, { x: 862, y: 8, w: 30, h: 30 }];
    const out = placeBadges([{ label: '1', object: 'w', box }, { label: '2', object: 'w', box }], [box], { w: 1440, h: 900 }, undefined, buttons);
    for (const b of out) { expect(inside(b, box)).toBe(true); for (const s of buttons) expect(touches(b, { ...s, id: 's' } as Box)).toBe(false); }
    expect(out[0].x).toBeLessThan(out[1].x);
    expect(out[0].y).toBeLessThan(40);
  });

  it('too small for a badge: it goes beside the object on a short line, clear of the neighbours', () => {
    const small = { id: 's', x: 300, y: 200, w: 60, h: 18 }, left = { id: 'l', x: 200, y: 200, w: 90, h: 18 };
    const [b] = placeBadges([{ label: '1', object: 's', box: small }], [small, left], view);
    expect(inside(b, small)).toBe(false);
    expect(touches(b, left)).toBe(false);
    expect(b.leader).toBeDefined();
    const l = b.leader!;
    expect(l.x >= small.x && l.x <= small.x + small.w && l.y >= small.y && l.y <= small.y + small.h).toBe(true);
    expect(Math.hypot(b.x - l.x, b.y - l.y)).toBeLessThan(30);
  });

  it('a container: the badge stays off the widgets it holds', () => {
    const cont = { id: 'c', x: 100, y: 100, w: 600, h: 300 }, kid = { id: 'k', x: 100, y: 100, w: 600, h: 300 };
    // One widget fills the container: only the layout can tell which holds which.
    const [b] = placeBadges([{ label: '1', object: 'c', box: cont }], [cont, kid], view, (outer, inner) => outer === 'c' && inner === 'k');
    expect(touches(b, kid)).toBe(false);
    expect(b.leader).toBeDefined();
  });

  it('a mark on a widget inside a container may sit on the container', () => {
    const cont = { id: 'c', x: 100, y: 100, w: 600, h: 300 }, kid = { id: 'k', x: 110, y: 110, w: 300, h: 120 };
    const [b] = placeBadges([{ label: '1', object: 'k', box: kid }], [cont, kid], view);
    expect(inside(b, kid)).toBe(true);
  });

  it('ink keeps its place; two inks on one spot move apart', () => {
    const box = { id: 'w', x: 100, y: 100, w: 400, h: 200 };
    const out = placeBadges([{ label: '1', at: { x: 640, y: 420 } }, { label: '2', at: { x: 640, y: 420 } }, { label: '3', object: 'w', box }], [box], view);
    const one = out.find(b => b.label === '1')!;
    expect(one).toMatchObject({ x: 640, y: 420 });
    expect(apart(out)).toBe(true);
  });
});

describe('cutWords: fewer whole words, never a stub', () => {
  const fits = (limit: number) => (n: number) => n + 1 <= limit;
  it('cuts at a word and adds an ellipsis', () => {
    expect(cutWords('Accountable owner: System Administrator', fits(22))).toBe('Accountable owner…');
  });
  it('drops a value that would keep fewer than 6 characters', () => {
    expect(cutWords('Zoom out', fits(4))).toBe('');
    expect(cutWords('Fit to screen', fits(5))).toBe('');
  });
  it('a long single word is cut inside it when that keeps enough', () => {
    expect(cutWords('Organisationstruktur', fits(10))).toBe('Organisat…');
  });
});
