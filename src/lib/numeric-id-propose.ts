/**
 * Proposed IDs for objects that carry a number BMP assigned. Pure: no DOM, no
 * chrome.*; the same objects always give the same proposals.
 *
 * A proposal follows how the workspace already names things, in this order:
 *  1. `siblings`: the objects under the same parent (those of the same class
 *     first). When most of them have IDs that start with the same words
 *     (`btn_proto_run`, `btn_proto_stop` → `btn_proto`), the new ID starts
 *     with those words.
 *  2. `parent`: most of the parent's children have IDs that start with the
 *     parent's own ID (`tab_prop_risk`, `tab_prop_risk_r1`); the new ID does too.
 *  3. `class`: most objects of the class in the workspace start with the same
 *     word (`card`).
 *  4. `default`: no pattern nearby, so the ID is the name alone.
 * Then a slug of the name (lower case, words joined by `_`), and the word
 * most IDs of the class end with when the workspace has one (`_tab`, `_cell`),
 * unique among every ID of the same ID space and the other proposals of the
 * batch (a clash first adds the parent's words, then a number).
 * The result is valid for BMP (`validateBusinessId`), starts with a letter
 * and has at most MAX_ID_LENGTH characters.
 */

import { validateBusinessId } from './ec-guards';
import { SPACE_MEMBERS } from './code-refs';

/** The longest ID proposed or accepted. */
export const MAX_ID_LENGTH = 64;
/** The longest slug of a name. */
export const MAX_SLUG_LENGTH = 32;

/** An object of the workspace as the proposals need it. */
export interface IdObject {
  rid: string;
  id: string;
  name: string;
  className: string;
  parentRid: string;
  /** The ID space the ID lives in (`t`, `r` …). */
  space: string;
}

export type ProposalBasis = 'siblings' | 'parent' | 'class' | 'default';

export interface Proposal {
  id: string;
  basis: ProposalBasis;
  /** The words the ID starts with. */
  prefix: string;
}

export const isNumericOnly = (id: string): boolean => /^\d+$/.test(id);

const usedKey = (space: string, id: string): string => `${space}\u0000${id.toLowerCase()}`;

// ── class words ───────────────────────────────────────────────────

const CLASS_WORDS: Readonly<Record<string, string>> = {
  Category: 'cat', Tab: 'tab', Container: 'con', Label: 'lbl', ExtendedTable: 'tbl', ActionButton: 'btn', ImageView: 'img',
  DescriptionView: 'dsv', ExtendedExpression: 'exp', ExtendedCode: 'ec', ModelPage: 'page', Spacer: 'spc', InputView: 'inp',
  TextElement: 'txt', ExtendedMethodConfig: 'p', CreateObjectView: 'cov', ReportsList: 'rpt', PieChart: 'pie', BarChart: 'bar',
  RadarChart: 'rad', PolarChart: 'pol', BubbleChart: 'bub', RiskChart: 'rch', Transformer: 'trf', FileResource: 'res',
};

/** The short word for a class: the table above, else the capitals of its name
 *  (`RiskChart` → `rc`), else its first three letters. Starts an ID only when no
 *  name is left to make one from. */
export function classWord(className: string): string {
  const known = CLASS_WORDS[className];
  if (known) return known;
  const capitals = className.replace(/[^A-Z]/g, '').toLowerCase();
  if (capitals.length >= 2) return capitals.slice(0, 4);
  const letters = className.toLowerCase().replace(/[^a-z]/g, '');
  return letters.slice(0, 3) || 'obj';
}

// ── slugs ─────────────────────────────────────────────────────────

/** Words of a name: letters and digits, lower case, accents taken off. */
export function nameWords(name: string): string[] {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss').split(/[^a-z0-9]+/).filter(Boolean);
}

/** The slug of a name: its words joined by `_`, cut at a word to at most `max` characters. */
export function slugOf(name: string, max = MAX_SLUG_LENGTH): string {
  const out: string[] = [];
  let length = 0;
  for (const w of nameWords(name)) {
    const next = length + (out.length ? 1 : 0) + w.length;
    if (next > max) { if (!out.length) out.push(w.slice(0, max)); break; }
    out.push(w);
    length = next;
  }
  return out.join('_');
}

const tokensOf = (id: string): string[] => id.split('_').filter(Boolean);

/** `ActualBudget_drill` → `Actual Budget drill`. */
const wordsApart = (text: string): string => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

/** The words of a class name: `NameColumn` → `name_column`. */
export function classSlug(className: string): string {
  return slugOf(wordsApart(className).replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'));
}

/** The word at least 5 IDs of a class end with, when that is at least 40% of its IDs of two words or more. */
export function sharedSuffix(ids: readonly string[]): string | null {
  const list = ids.map(tokensOf).filter(t => t.length >= 2);
  if (list.length < 5) return null;
  const counts = new Map<string, number>();
  for (const t of list) { const w = t[t.length - 1]; if (!/^[0-9]+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1); }
  let best: string | null = null;
  let bestCount = 0;
  for (const [w, n] of counts) if (n > bestCount || (n === bestCount && best != null && w < best)) { best = w; bestCount = n; }
  return best && bestCount >= 5 && bestCount * 5 >= list.length * 2 ? best : null;
}

// ── the style of the IDs around ───────────────────────────────────

/**
 * The words most of `ids` start with: the longest run of leading words (at
 * most `maxWords`) shared by more than half of them, each of which has more
 * words after it. Null when there are fewer than two IDs or no such run.
 */
export function sharedPrefix(ids: readonly string[], maxWords = 6): string | null {
  const list = ids.map(tokensOf).filter(t => t.length >= 2);
  if (ids.length < 2 || list.length * 2 <= ids.length) return null;
  for (let k = Math.min(maxWords, Math.max(...list.map(t => t.length - 1))); k >= 1; k--) {
    const counts = new Map<string, number>();
    for (const t of list) if (t.length > k) { const p = t.slice(0, k).join('_'); counts.set(p, (counts.get(p) ?? 0) + 1); }
    let best: string | null = null;
    let bestCount = 0;
    for (const [p, n] of counts) if (n > bestCount || (n === bestCount && best != null && p < best)) { best = p; bestCount = n; }
    if (best && bestCount * 2 > ids.length) return best;
  }
  return null;
}

/** The first word most of `ids` start with (the class level), when at least three do. */
function sharedWord(ids: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const t = tokensOf(id);
    if (t.length >= 2) counts.set(t[0], (counts.get(t[0]) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [w, n] of counts) if (n > bestCount || (n === bestCount && best != null && w < best)) { best = w; bestCount = n; }
  return best && bestCount >= 3 && bestCount * 2 > ids.length ? best : null;
}

const startsWithLetter = (s: string): boolean => /^[a-z]/i.test(s);

/** Compose `prefix_slug`, leaving out words of the slug the prefix already ends with. */
function compose(prefix: string, slug: string, fallbackWord: string, suffix = ''): string {
  let words = tokensOf(slug);
  const p = tokensOf(prefix);
  // `btn` + `btn_cleanup` is `btn_cleanup`; `tab_risk` + `risk` is `tab_risk`.
  while (words.length && p.length && words[0] === p[p.length - 1]) words = words.slice(1);
  // `risk_tab` + `tab` stays `risk_tab`.
  if (suffix && (words.length ? words[words.length - 1] : p[p.length - 1]) !== suffix) words = [...words, suffix];
  if (!words.length && !p.length) words = ['item'];
  let id = [...p, ...words].join('_');
  if (!id) id = fallbackWord;
  if (!startsWithLetter(id)) id = `${fallbackWord}_${id}`;
  return id;
}

/** Cut the slug, not the prefix, so the whole ID has at most MAX_ID_LENGTH characters; null when the prefix alone is too long. */
function fit(prefix: string, slug: string, fallbackWord: string, suffix = ''): string | null {
  for (let max = MAX_SLUG_LENGTH; max >= 1; max = max > 8 ? max - 8 : max - 1) {
    const id = compose(prefix, slug.length > max ? slugOf(slug.replace(/_/g, ' '), max) : slug, fallbackWord, suffix);
    if (id.length <= MAX_ID_LENGTH) return id;
  }
  return null;
}

/** Why an ID cannot be used, or null. `used`: the IDs of the same ID space already taken (lower case). */
export function idProblem(id: string, used?: (id: string) => string | null): string | null {
  if (!id) return 'Enter an ID';
  try { validateBusinessId(id); } catch { return 'Letters, digits and _ only'; }
  if (isNumericOnly(id)) return 'Add letters: a number alone is what BMP assigns';
  if (!/^[a-z_]/i.test(id)) return 'Start with a letter';
  if (id.length > MAX_ID_LENGTH) return `At most ${MAX_ID_LENGTH} characters`;
  if (SPACE_MEMBERS.has(id)) return 'This word is used by BMP itself';
  return used?.(id) ?? null;
}

// ── the proposals ─────────────────────────────────────────────────

export interface ProposeOptions {
  /** IDs that are taken though no object in `world` has them, by ID space (anything). */
  taken?: ReadonlySet<string>;
}

const ridOrder = (a: string, b: string): number => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * A proposal for each of `targets` (objects whose ID is a number), given
 * every other object of the scan (`world`, including the targets). Targets
 * are handled in a fixed order (class, name, RID), so a clash between two
 * names always gives the same suffix.
 */
export function proposeIds(targets: readonly IdObject[], world: readonly IdObject[], opts: ProposeOptions = {}): Map<string, Proposal> {
  const used = new Set<string>();
  const named = world.filter(o => o.id && !isNumericOnly(o.id));
  for (const o of world) if (o.id) used.add(usedKey(o.space, o.id));
  for (const t of opts.taken ?? []) used.add(t);

  const byParent = new Map<string, IdObject[]>();
  const byClass = new Map<string, string[]>();
  const byRid = new Map<string, IdObject>();
  for (const o of world) byRid.set(o.rid, o);
  for (const o of named) {
    const p = byParent.get(`${o.space}\u0000${o.parentRid}`);
    if (p) p.push(o); else byParent.set(`${o.space}\u0000${o.parentRid}`, [o]);
    const c = byClass.get(`${o.space}\u0000${o.className}`);
    if (c) c.push(o.id); else byClass.set(`${o.space}\u0000${o.className}`, [o.id]);
  }

  const out = new Map<string, Proposal>();
  const suffixes = new Map<string, string>();
  const suffixOf = (space: string, className: string): string => {
    const key = `${space} ${className}`;
    let w = suffixes.get(key);
    if (w === undefined) { w = sharedSuffix(byClass.get(key) ?? []) ?? ''; suffixes.set(key, w); }
    return w;
  };
  const ordered = [...targets].sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name) || ridOrder(a.rid, b.rid));
  for (const t of ordered) {
    const word = classWord(t.className);
    const slug = slugOf(t.name) || classSlug(t.className);
    const suffix = suffixOf(t.space, t.className);
    const kids = byParent.get(`${t.space}\u0000${t.parentRid}`) ?? [];
    const sameClass = kids.filter(k => k.className === t.className).map(k => k.id);
    const parent = t.parentRid ? byRid.get(t.parentRid) : undefined;
    const parentKids = kids.filter(k => parent && k.id.startsWith(`${parent.id}_`));

    let basis: ProposalBasis = 'default';
    let prefix = '';
    const fromSiblings = sharedPrefix(sameClass) ?? sharedPrefix(kids.map(k => k.id));
    if (fromSiblings) { basis = 'siblings'; prefix = fromSiblings; }
    else if (parent && parent.id && !isNumericOnly(parent.id) && parent.id.length <= 40 && parentKids.length && parentKids.length * 2 >= kids.length) { basis = 'parent'; prefix = parent.id; }
    else {
      const shared = sharedWord(byClass.get(`${t.space}\u0000${t.className}`) ?? []);
      if (shared) { basis = 'class'; prefix = shared; }
    }

    let base = fit(prefix, slug, word, suffix);
    if (base == null) { basis = 'default'; prefix = ''; base = fit('', slug, word, suffix) ?? word; }
    let id = base;
    // A name that clashes first tries the parent's words, then a number.
    if (used.has(usedKey(t.space, id)) || idProblem(id)) {
      const qualifier = parent ? slugOf(wordsApart(parent.id && !isNumericOnly(parent.id) ? parent.id : parent.name), 24) : '';
      const qualified = qualifier ? fit(!prefix || qualifier === prefix || qualifier.startsWith(`${prefix}_`) ? qualifier : `${prefix}_${qualifier}`, slug, word, suffix) : null;
      if (qualified && !used.has(usedKey(t.space, qualified)) && !idProblem(qualified)) { id = qualified; base = qualified; }
    }
    for (let n = 2; used.has(usedKey(t.space, id)) || idProblem(id); n++) {
      const suffix = `_${n}`;
      id = `${base.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
    }
    used.add(usedKey(t.space, id));
    out.set(t.rid, { id, basis, prefix });
  }
  return out;
}

/** What a proposal followed, for a tooltip. */
export function basisText(p: Proposal): string {
  switch (p.basis) {
    case 'siblings': return `Starts like the IDs next to it: ${p.prefix}`;
    case 'parent': return `Starts like the IDs under its parent: ${p.prefix}`;
    case 'class': return `Starts like most objects of its type: ${p.prefix}`;
    default: return 'No pattern nearby: made from its name';
  }
}

export { usedKey };
