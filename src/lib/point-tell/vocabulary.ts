/**
 * What an AI answer may do, as data. One place says which properties each kind of object can change and
 * what values they take; the copied text publishes it, and the staging step checks every operation against
 * it. Sources: the style catalog (style-props), the appearance and visibility type sets (pane-schema), the
 * add palette and the layout model, so a new style property or widget type reaches the vocabulary by itself.
 */
import { STYLE_PROPS, styleOptions } from '../style-props';
import { APPEARANCE_TYPES, HAS_VISIBLE_TYPES } from '../pane-schema';
import { PALETTE } from '../layout/palette';
import { hasHeight, isResultTab } from '../layout/model';
import type { LModel, LNode } from '../layout/types';
import type { ColorSetData } from '../types';
import { routedProps } from './routes';

export type PtProp =
  | 'name' | 'columns' | 'columnsMedium' | 'columnsSmall' | 'height'
  | 'headerColor' | 'fontColor' | 'shadow' | 'headerStyle' | 'borderStyle' | 'transparency'
  | 'showToolMenu' | 'disableSearch' | 'visibility' | 'shownOnLargeDisplay' | 'shownOnMediumDisplay' | 'shownOnSmallDisplay';

const SIZE: PtProp[] = ['columns', 'columnsMedium', 'columnsSmall'];
const LOOK: PtProp[] = ['headerColor', 'fontColor', 'shadow', 'headerStyle', 'borderStyle', 'transparency'];
const SHOWN: PtProp[] = ['visibility', 'shownOnLargeDisplay', 'shownOnMediumDisplay', 'shownOnSmallDisplay'];

/** The properties an answer may change on this object. */
export function changeableProps(node: LNode): PtProp[] {
  if (node.kind === 'tab') return isResultTab(node) ? [] : ['name'];
  if (node.kind === 'container') return ['name', ...SIZE];
  const out: PtProp[] = ['name', ...SIZE];
  if (hasHeight(node.className)) out.push('height');
  if (APPEARANCE_TYPES.has(node.className)) out.push(...LOOK);
  // The tools menu and search flags exist only on types that carry the trait: the layout read says which.
  if (node.style?.showToolMenu !== undefined) out.push('showToolMenu');
  if (node.style?.disableSearch !== undefined) out.push('disableSearch');
  if (HAS_VISIBLE_TYPES.has(node.className)) out.push(...SHOWN);
  return out;
}

/** What a new widget of this type may be given as it is added. */
export function newWidgetProps(className: string): PtProp[] {
  const out: PtProp[] = ['columns'];
  if (hasHeight(className)) out.push('height');
  if (APPEARANCE_TYPES.has(className)) out.push(...LOOK);
  return out;
}

/** Every type an answer may add: the picker's widgets, plus Container and Tab. */
export function addTypes(): string[] {
  return ['Container', 'Tab', ...PALETTE.flatMap(g => g.items.map(i => i.key))];
}

/** Whether `type` is one an answer may add as a widget. */
export const isAddableWidget = (type: string): boolean => PALETTE.some(g => g.items.some(i => i.key === type));

export const VALUE_SPECS: Record<PtProp, string | string[]> = {
  name: 'text, 1-120 characters',
  columns: 'integer 1-6',
  columnsMedium: 'integer 1-6',
  columnsSmall: 'integer 1-6',
  height: 'integer, pixels, 20 or more',
  headerColor: 'a color ref from "colors", or null for none',
  fontColor: 'a color ref from "colors", or null for none',
  shadow: 'true | false',
  headerStyle: styleOptions('headerStyle').map(o => o.value),
  borderStyle: styleOptions('borderStyle').map(o => o.value),
  transparency: 'integer 0-100',
  showToolMenu: 'true | false',
  disableSearch: 'true | false',
  visibility: styleOptions('visibility').map(o => o.value),
  shownOnLargeDisplay: 'true | false',
  shownOnMediumDisplay: 'true | false',
  shownOnSmallDisplay: 'true | false',
};

// The style catalog and the vocabulary must not drift: every style property is one the vocabulary knows.
export const STYLE_PROP_NAMES: readonly string[] = STYLE_PROPS.map(s => s.prop);

// ── Colours ─────────────────────────────────────────────────────────────────────────────────────

export interface PtColour { ref: string; bid: string; name: string; rgb: string; /** Other colours of the table that look the same (same name and value): they share this ref. */ same?: string[] }

/** "rgb(10, 79, 158)" or "#0a4f9e" as "#0a4f9e"; the input unchanged when it is neither. */
export function toHex(rgb: string): string {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(rgb.trim());
  if (!m) return rgb;
  return '#' + [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('');
}

export const COLOUR_CAP = 40;

/** The colours an answer may use: the workspace's own sets first, then the stock palette, up to the cap,
 *  plus any colour an object already uses (so "now" can always name it). k1, k2 ... in that order. */
export function buildColours(sets: ColorSetData[] | null, inUse: Iterable<string>): PtColour[] {
  if (!sets?.length) return [];
  const all = [...sets].sort((a, b) => Number(a.folder === 'ColorRoot') - Number(b.folder === 'ColorRoot'))
    .flatMap(s => s.colors);
  const seen = new Set<string>();
  const unique = all.filter(c => !seen.has(c.bid) && seen.add(c.bid));
  // A workspace repeats colours (the same name and value in several sets): the AI is shown each look once.
  const look = (c: { name: string; rgb: string }): string => `${c.name}|${toHex(c.rgb)}`;
  const first = new Map<string, (typeof unique)[number]>();
  const same = new Map<string, string[]>();
  for (const c of unique) {
    const k = look(c);
    const f = first.get(k);
    if (!f) first.set(k, c); else same.set(f.bid, [...(same.get(f.bid) ?? []), c.bid]);
  }
  const chosen = [...first.values()].slice(0, COLOUR_CAP);
  const have = new Set(chosen.map(c => c.bid));
  for (const bid of inUse) {
    const c = unique.find(x => x.bid === bid);
    if (!c) continue;
    const f = first.get(look(c));
    if (f && !have.has(f.bid)) { chosen.push(f); have.add(f.bid); }
  }
  return chosen.map((c, i) => ({ ref: `k${i + 1}`, bid: c.bid, name: c.name, rgb: toHex(c.rgb), ...(same.get(c.bid) ? { same: same.get(c.bid) } : {}) }));
}

// ── The vocabulary, as published ────────────────────────────────────────────────────────────────

export interface PtVocabulary {
  layout: string;
  addTypes: string[];
  /** Types that take the same properties share one entry, their names joined with ", ". */
  properties: Record<string, string[]>;
  values: Partial<Record<PtProp, string | string[]>>;
  /** "k1 Cyan #00a2b8" */
  colors: string[];
  /** Properties whose change opens another window for the user to review. */
  elsewhere: Record<string, string[]>;
  elsewhereNote: string;
}

export const LAYOUT = 'Each tab or container is a grid 6 columns wide. Children flow left to right in the listed order and wrap when they do not fit. Containers come before widgets in the same parent. A place is exactly one of {"before": ref}, {"after": ref}, {"into": tab or container ref}.';
export const ELSEWHERE_NOTE = 'These properties are changed in a window the user reviews: give the complete new text or code as "value".';

/** Types with the same list of properties as one entry. */
function grouped(byType: Record<string, string[]>): Record<string, string[]> {
  const out = new Map<string, { types: string[]; list: string[] }>();
  for (const [type, list] of Object.entries(byType)) {
    const key = list.join('|');
    const g = out.get(key);
    if (g) g.types.push(type); else out.set(key, { types: [type], list });
  }
  return Object.fromEntries([...out.values()].map(g => [g.types.join(', '), g.list]));
}

export function buildVocabulary(model: LModel, colours: PtColour[]): PtVocabulary {
  const props: Record<string, Set<PtProp>> = {};
  const visit = (n: LNode): void => {
    const set = (props[n.className] ??= new Set());
    for (const p of changeableProps(n)) set.add(p);
    n.children.forEach(visit);
  };
  model.tabs.forEach(visit);
  const properties: Record<string, string[]> = {};
  const used = new Set<PtProp>();
  for (const [type, set] of Object.entries(props)) {
    const list = [...set];
    if (!list.length) continue;
    properties[type] = list;
    list.forEach(p => used.add(p));
  }
  const fresh = new Set<PtProp>();
  for (const type of addTypes()) newWidgetProps(type).forEach(p => fresh.add(p));
  const grouping = grouped(properties);
  grouping.newWidget = [...fresh];
  fresh.forEach(p => used.add(p));
  const elsewhere: Record<string, string[]> = {};
  const routed: Record<string, string[]> = {};
  for (const type of Object.keys(props)) {
    const r = routedProps(type);
    const names = [...r.text, ...r.code];
    if (names.length) routed[type] = names;
  }
  Object.assign(elsewhere, grouped(routed));
  const values: PtVocabulary['values'] = {};
  for (const p of used) values[p] = VALUE_SPECS[p];
  return {
    layout: LAYOUT,
    addTypes: addTypes(),
    properties: grouping,
    values,
    colors: colours.map(c => `${c.ref} ${c.name} ${c.rgb}`),
    elsewhere,
    elsewhereNote: ELSEWHERE_NOTE,
  };
}
