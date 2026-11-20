/**
 * Point and tell: what a widget visibly holds, read from the live DOM for the drawn picture. Headings and labels,
 * button captions, field boxes, a table's header and its first rows, chart and image placeholders with their alt or
 * title, each where it is on the screen (window coordinates).
 *
 * Only what the page shows in the window is read: nothing hidden, nothing scrolled out of the widget or the window,
 * no input values (a field is an empty box), never a password or hidden input. Nothing is fetched. The reading is
 * capped in nodes, items, rows and time, so a big page costs a few milliseconds and the picture stays small.
 */

export interface WireRect { x: number; y: number; w: number; h: number }

export type WireItem =
  | (WireRect & { k: 'text'; text: string; size: number; strong: boolean })
  | (WireRect & { k: 'button'; text: string })
  | (WireRect & { k: 'field' })
  | (WireRect & { k: 'media'; what: 'chart' | 'image'; text: string })
  | (WireRect & { k: 'head' })
  | (WireRect & { k: 'more'; text: string });

/** The caps: per widget and for the whole picture. */
export const CAPS = {
  /** DOM nodes looked at in one widget. */
  nodesPerWidget: 1500,
  /** DOM nodes looked at in the whole picture. */
  nodes: 12000,
  /** Things drawn in one widget. */
  itemsPerWidget: 160,
  /** Things drawn in the whole picture. */
  items: 1600,
  /** Body rows of one table. */
  rows: 6,
  /** Characters of one text. */
  chars: 80,
  /** Lines one wrapped text is drawn on. */
  lines: 3,
  /** Milliseconds for the whole reading. */
  ms: 120,
} as const;

/** How the reader sees the page; the real DOM by default, a fake one in tests. */
export interface WireGeo {
  /** An element's box in window coordinates, or null when it has none. */
  rect(el: Element): WireRect | null;
  /** The boxes of a text's lines in window coordinates. */
  lines(t: Text): WireRect[];
  /** The element is shown (not display:none, visibility:hidden or transparent). */
  shown(el: Element): boolean;
  /** The element hides what overflows it (overflow other than visible). */
  clips(el: Element): boolean;
  /** The element's content overflows it and is cut off there (a table cell with an ellipsis, a scrolled list). */
  hides(el: Element): boolean;
  /** Font size (px) and weight of an element. */
  font(el: Element): { size: number; weight: number; upper?: boolean };
  now(): number;
}

/** Icon fonts draw private-use characters: they are not words. */
const ICON_CHARS = /[-\u{F0000}-\u{FFFFD}]/gu;

/** Text as one short line: icons out, spaces folded, cut at `max` characters. */
export function wireText(raw: string, max: number = CAPS.chars): string {
  const t = raw.replace(ICON_CHARS, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'OPTION', 'DATALIST', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO']);
const FIELD_TYPES = new Set(['', 'text', 'search', 'email', 'number', 'tel', 'url', 'date', 'datetime-local', 'month', 'time', 'week', 'color', 'file', 'range']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset']);

const overlaps = (a: WireRect, b: WireRect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const within = (r: WireRect, clip: WireRect): WireRect | null => {
  const x = Math.max(r.x, clip.x), y = Math.max(r.y, clip.y);
  const w = Math.min(r.x + r.w, clip.x + clip.w) - x, h = Math.min(r.y + r.h, clip.y + clip.h) - y;
  return w > 1 && h > 1 ? { x, y, w, h } : null;
};

/** A shared budget across the widgets of one picture. */
export interface WireBudget { nodes: number; items: number; until: number; cut: boolean }
export const wireBudget = (geo: WireGeo): WireBudget => ({ nodes: CAPS.nodes, items: CAPS.items, until: geo.now() + CAPS.ms, cut: false });

/** An element of Companion's own (overlays, badges, labels): never part of the page. */
const ours = (el: Element): boolean => (el.id ? el.id.startsWith('crev-') : false) || (typeof el.className === 'string' && /(^|\s)(crev-|pt-)/.test(el.className));

/** A caption that reads as a button: a button, an input button, or something the page marks as one. */
function isButton(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'BUTTON') return true;
  if (tag === 'INPUT') return BUTTON_TYPES.has(((el as HTMLInputElement).type || '').toLowerCase());
  return el.getAttribute('role') === 'button';
}

/** The words of a button: its text, or for an input button its caption, or its label for an icon button. */
function buttonCaption(el: Element): string {
  if (el.tagName === 'INPUT') return wireText((el as HTMLInputElement).value || '', 40);
  return wireText(el.textContent ?? '', 40) || wireText(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '', 40);
}

/** What names a chart or an image: its alt, title or label, or a chart's own title text. */
function mediaWords(el: Element): string {
  const own = el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? el.getAttribute('title');
  if (own) return wireText(own, 50);
  const title = el.querySelector(':scope > title, .highcharts-title');
  return title ? wireText(title.textContent ?? '', 50) : '';
}

/**
 * What one widget shows. `box` is the widget's box and `view` the window, both in window coordinates; items outside
 * either are left out. `budget` is shared by all widgets of a picture.
 */
export function readWidget(root: Element, view: WireRect, geo: WireGeo, budget: WireBudget): WireItem[] {
  const out: WireItem[] = [];
  const own = geo.rect(root);
  const first = own ? within(own, view) : null;
  if (!first) return out;
  // What can be seen: the widget in the window, narrowed by each element on the way down that cuts off its content.
  let clip: WireRect = first;
  let nodes = CAPS.nodesPerWidget;
  const rows = new Map<Element, { shown: number; hidden: number; last: WireRect | null }>();
  const add = (item: WireItem): boolean => {
    if (out.length >= CAPS.itemsPerWidget || budget.items <= 0) return false;
    out.push(item); budget.items--;
    return true;
  };
  const room = (): boolean => {
    if (nodes <= 0 || budget.nodes <= 0 || out.length >= CAPS.itemsPerWidget || budget.items <= 0) return false;
    nodes--; budget.nodes--;
    if ((budget.nodes & 63) === 0 && geo.now() > budget.until) budget.cut = true;
    return !budget.cut;
  };

  const text = (t: Text, parent: Element): void => {
    const words = wireText(t.data, 400);
    if (!words) return;
    const lines = geo.lines(t).map(r => within(r, clip)).filter((r): r is WireRect => !!r).slice(0, CAPS.lines);
    if (!lines.length) return;
    const f = geo.font(parent);
    const strong = f.weight >= 600 || /^(H[1-6]|TH|B|STRONG|LEGEND|LABEL)$/.test(parent.tagName) || parent.getAttribute('role') === 'columnheader';
    // A wrapped text: its words are shared out over its lines by their widths.
    const total = lines.reduce((s, r) => s + r.w, 0);
    let at = 0;
    lines.forEach((r, i) => {
      let end = i === lines.length - 1 ? words.length : Math.min(words.length, at + Math.round((r.w / total) * words.length));
      // A line ends between words: at the space nearest to its share.
      if (end < words.length && words[end] !== ' ') {
        const back = words.lastIndexOf(' ', end), fwd = words.indexOf(' ', end);
        end = back > at && (fwd < 0 || end - back <= fwd - end) ? back : fwd > 0 ? fwd : end;
      }
      const part = words.slice(at, end);
      at = end;
      const cut = wireText(part, CAPS.chars);
      const shown = f.upper ? cut.toUpperCase() : cut;
      if (shown) add({ k: 'text', ...r, text: shown, size: Math.max(8, Math.min(18, f.size)), strong });
    });
  };

  const tableOf = (row: Element): Element => row.closest('table, [role="grid"], [role="table"], [role="treegrid"]') ?? row.parentElement ?? row;
  const headerRow = (row: Element): boolean => row.parentElement?.tagName === 'THEAD' || !!row.querySelector(':scope > th, :scope > [role="columnheader"]');

  const visit = (el: Element): void => {
    if (!room()) return;
    if (SKIP.has(el.tagName) || ours(el)) return;
    const tag = el.tagName;
    if (tag === 'INPUT' && !FIELD_TYPES.has(((el as HTMLInputElement).type || 'text').toLowerCase()) && !isButton(el)) {
      // Password, hidden, checkbox, radio: a checkbox or radio is a small box; the rest is not drawn at all.
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      if (type !== 'checkbox' && type !== 'radio') return;
    }
    if (el.getAttribute('aria-hidden') === 'true') return;
    const r = geo.rect(el);
    if (r && (r.w > 0 || r.h > 0) && !overlaps(r, clip)) return;
    if (!geo.shown(el)) return;
    // A box folded to nothing that hides its overflow (a closed filter row, a collapsed panel) shows none of its content.
    if (r && (r.w < 2 || r.h < 2) && geo.clips(el)) return;

    if (tag === 'TR' || el.getAttribute('role') === 'row') {
      const table = tableOf(el);
      const s = rows.get(table) ?? { shown: 0, hidden: 0, last: null };
      rows.set(table, s);
      if (headerRow(el)) { const c = r && within(r, clip); if (c) add({ k: 'head', ...c }); }
      else if (s.shown >= CAPS.rows) { s.hidden++; return; }
      else { s.shown++; if (r) s.last = r; }
    }
    if (isButton(el)) {
      const c = r && within(r, clip);
      if (c && c.w >= 6 && c.h >= 6) add({ k: 'button', ...c, text: buttonCaption(el) });
      return;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox') {
      const c = r && within(r, clip);
      if (c && c.w >= 6 && c.h >= 6) add({ k: 'field', ...c });
      return;
    }
    if (tag === 'IMG' || tag === 'CANVAS' || (tag === 'svg' || tag === 'SVG')) {
      const c = r && within(r, clip);
      // Small pictures are icons: left out.
      if (!c || r!.w < 40 || r!.h < 28) return;
      const chart = tag !== 'IMG';
      add({ k: 'media', ...c, what: chart ? 'chart' : 'image', text: mediaWords(el) });
      // A chart's own labels (axis, legend, title) are text the page shows: they are drawn too.
      if (chart && tag !== 'CANVAS') for (const t of el.querySelectorAll('text')) { if (!room()) break; textOfSvg(t); }
      return;
    }
    const outer = clip;
    if (r && geo.hides(el)) { const inner = within(r, clip); if (!inner) return; clip = inner; }
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { if (room()) text(n as Text, el); }
      else if (n.nodeType === 1) visit(n as Element);
      if (budget.cut) break;
    }
    clip = outer;
  };

  /** One <text> of a chart: drawn as one line where it is. */
  const textOfSvg = (t: Element): void => {
    const words = wireText(t.textContent ?? '', 40);
    const r = words ? geo.rect(t) : null;
    const c = r && within(r, clip);
    if (c) add({ k: 'text', ...c, text: words, size: Math.max(8, Math.min(14, r!.h * 0.8)), strong: false });
  };

  visit(root);
  for (const s of rows.values()) {
    if (!s.hidden || !s.last) continue;
    const y = s.last.y + s.last.h + 2;
    if (y < clip.y + clip.h - 4) add({ k: 'more', x: s.last.x + 8, y, w: Math.max(40, s.last.w - 16), h: 14, text: `${s.hidden} more row${s.hidden === 1 ? '' : 's'}` });
  }
  return out;
}

/** The real page. */
export function domGeo(): WireGeo {
  const range = document.createRange();
  const fonts = new Map<Element, { size: number; weight: number; upper?: boolean }>();
  const box = (r: DOMRect): WireRect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  return {
    rect: el => { const r = el.getBoundingClientRect(); return r.width || r.height ? box(r) : null; },
    lines: t => { range.selectNodeContents(t); return [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1).map(box); },
    hides: el => (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) && (() => { const s = getComputedStyle(el); return s.overflowX !== 'visible' || s.overflowY !== 'visible'; })(),
    clips: el => { const s = getComputedStyle(el); return s.overflowX !== 'visible' || s.overflowY !== 'visible'; },
    shown: el => {
      const v = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
      if (v) return v.call(el, { opacityProperty: true, visibilityProperty: true });
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    },
    font: el => {
      let f = fonts.get(el);
      if (!f) { const s = getComputedStyle(el); f = { size: parseFloat(s.fontSize) || 12, weight: parseInt(s.fontWeight, 10) || 400, ...(s.textTransform === 'uppercase' ? { upper: true } : {}) }; fonts.set(el, f); }
      return f;
    },
    now: () => performance.now(),
  };
}

/** Of a set of widget elements, those not inside another one: each is read once, with what it holds. */
export function outermostElements(els: readonly Element[]): Element[] {
  const set = new Set(els);
  return els.filter(el => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
}
