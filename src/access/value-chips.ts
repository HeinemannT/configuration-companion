// A condition's list of values as chips. A chip shows the value's name, or its ID
// when no name is known; the class prefix of a stored token ("ListPropertySetItem:")
// is not shown, and an ID that differs from the name is secondary text. The stored
// token is never changed. A list- or type-valued property adds values through its
// picker; a free-text property keeps a text box that suggests the values known on
// the server for that property (typed, and from the ▾ button beside the box).
//
// A value is marked "not found on this server" only when the extension holds the
// complete list of valid values for that exact property and the value is not in it.
// Only a fully loaded list property qualifies. The comparison is by exact stored
// token, as the server compares it (no case folding, prefix kept). Never marked:
// - a list that is still loading or only partly loaded (re-evaluated on each render,
//   so the mark appears once the full list arrives);
// - object type conditions: the type catalogue is root.classConfig's children (the
//   configurable types), not every class BMP accepts as resource.type / new.type
//   (platform classes such as ReportForms or TaskFormEnrollment are valid but absent);
// - free-text properties: the values used in saved policies are not a list of valid values.
import { escapeHtml as esc } from '../lib/escape';
import { icon } from './icons';

export const NOT_FOUND = 'not found on this server';
export interface KnownItem { token: unknown; name?: string; id?: string }
export interface ValueChip { index: number; token: unknown; name: string; id: string; missing: boolean }

/** A stored value without its class prefix: "ListPropertySetItem:type_risk" reads "type_risk". */
export const valueId = (value: unknown): string => typeof value === 'string' ? value.replace(/^[A-Z][A-Za-z0-9]*:/, '') : JSON.stringify(value) ?? '';

/**
 * Chips for the values. `items` are the property's known items (name and ID), used
 * for display. A value is missing only when `complete` says `items` is every valid
 * value of the property and the exact token is not among them.
 */
export function valueChips(values: unknown[], { items, complete = false }: { items?: KnownItem[]; complete?: boolean } = {}): ValueChip[] {
  const byToken = new Map((items ?? []).map(item => [item.token, item]));
  return values.map((token, index) => {
    const item = byToken.get(token), id = item?.id || valueId(token);
    const missing = !item && complete && !!items?.length;
    return { index, token, name: item?.name || id, id, missing };
  });
}

/** Values used for the same property in saved conditions anywhere in the policies. */
export function knownValues(policies: { content?: unknown }[], left: string): Set<unknown> {
  const found = new Set<unknown>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const c = (node as { Condition?: { Left?: unknown; Right?: unknown } }).Condition;
    if (c && c.Left === left) (Array.isArray(c.Right) ? c.Right : [c.Right]).forEach(v => found.add(v));
    Object.values(node).forEach(walk);
  };
  policies.forEach(p => walk(p.content));
  return found;
}

/** The value to store for typed text: a known token whose ID matches the text keeps its
 *  prefix, so "type_process" becomes "ListPropertySetItem:type_process" when that is known. */
export function resolveTyped(text: string, known: Set<unknown>): { value: string; known: boolean } {
  const value = text.trim();
  if (known.has(value)) return { value, known: true };
  const matches = [...known].filter((k): k is string => typeof k === 'string' && valueId(k) === value);
  return matches.length === 1 ? { value: matches[0], known: true } : { value, known: false };
}

export interface ChipsOptions {
  /** Attributes that address the condition, for example data-path='[...]'. */
  attrs: string;
  /** Encoded condition path for the text box. */
  path: string;
  fieldName: string;
  /** "picker": Add value opens the property's picker. "text": a text box with suggestions. */
  add: 'picker' | 'text';
  /** Suggestions for the text box: known values that are not chosen yet. */
  suggestions?: unknown[];
}

/** Picker rows for the ▾ button of a free-text box: the known values not chosen
 *  yet, by ID, sorted. Choosing a row adds the stored token itself. */
export function suggestionRows(values: unknown[], known: Iterable<unknown>): { rid: string; label: string; secondary: string; group: string; icon: string; depth: number }[] {
  const chosen = new Set(values);
  return [...new Set(known)].filter((v): v is string => typeof v === 'string' && !!v && !chosen.has(v))
    .sort((a, b) => valueId(a).localeCompare(valueId(b), undefined, { numeric: true, sensitivity: 'base' }))
    .map(v => ({ rid: v, label: valueId(v), secondary: valueId(v) === v ? '' : v, group: 'Known on this server', icon: 'list', depth: 0 }));
}

export interface ConditionChipsInput {
  values: unknown[];
  left: string;
  /** The property's list (items with token, name and id; partial when only a page is loaded). */
  list?: { items?: KnownItem[]; partial?: boolean } | null;
  /** Object types of the loaded environment, when the condition compares the object
   *  type. Used for display only: it is not every class the server accepts. */
  types?: string[] | null;
  /** Saved policies, for the values known for a free-text property. */
  saved: { content?: unknown }[];
  attrs: string;
  path: string;
  fieldName: string;
}

/** The chip list of one condition, with the add control that fits its property. */
export function conditionChipsHtml(i: ConditionChipsInput): string {
  if (i.list || i.types) {
    const items = i.list ? i.list.items ?? [] : (i.types ?? []).map(t => ({ token: t }));
    return valueChipsHtml(valueChips(i.values, { items, complete: !!i.list && !i.list.partial }), { attrs: i.attrs, path: i.path, fieldName: i.fieldName, add: 'picker' });
  }
  const known = knownValues(i.saved, i.left);
  const chosen = new Set(i.values);
  return valueChipsHtml(valueChips(i.values), { attrs: i.attrs, path: i.path, fieldName: i.fieldName, add: 'text', suggestions: [...known].filter(v => !chosen.has(v)) });
}

export function valueChipsHtml(chips: ValueChip[], o: ChipsOptions): string {
  const chip = (c: ValueChip) => `<span class="chip val ${c.missing ? 'missing' : ''}"><span class="nm">${esc(c.name)}</span>${c.name !== c.id ? `<code>${esc(c.id)}</code>` : ''}${c.missing ? `<small class="vmiss">${NOT_FOUND}</small>` : ''}<button type="button" class="chip-rm" data-command="value-remove" ${o.attrs} data-index="${c.index}" aria-label="Remove ${esc(c.name)}">${icon('close')}</button></span>`;
  const listId = 'values-' + o.path.replace(/[^A-Za-z0-9]/g, '');
  const add = o.add === 'picker' ?
    `<button type="button" class="ui-tbtn value-add-pick" data-command="schema-value" ${o.attrs} aria-label="Add a value to ${esc(o.fieldName)}">${icon('plus')}Add value…</button>` :
    // The box keeps its native list for typed suggestions; the ▾ button opens the same
    // values in the shared chooser. Both carry the condition path the add needs.
    (o.suggestions?.length ?
      `<span class="value-combo"><input class="value-add" data-value-add='${o.path}' placeholder="Add value" autocomplete="off" aria-label="Add a value to ${esc(o.fieldName)}" list="${listId}"><button type="button" class="value-suggest" data-command="value-suggest" ${o.attrs} aria-label="Show known values of ${esc(o.fieldName)}" aria-haspopup="dialog">${icon('down')}</button></span>` +
      `<datalist id="${listId}">${[...new Set(o.suggestions.map(valueId))].map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>` :
      `<input class="value-add" data-value-add='${o.path}' placeholder="Add value" aria-label="Add a value to ${esc(o.fieldName)}">`);
  return `<span class="value-chips" role="group" aria-label="Values of ${esc(o.fieldName)}">${chips.map(chip).join('')}${add}<button type="button" class="ui-ibtn ui-ibtn-sm" data-command="edit-condition-value" ${o.attrs} aria-label="Edit the values of ${esc(o.fieldName)} as JSON" title="Edit as JSON">${icon('json')}</button></span>`;
}
