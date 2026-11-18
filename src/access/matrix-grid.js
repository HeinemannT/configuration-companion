// Transposed access matrix: object types run down in bands, roles run across.
// Built on the saved-policy index (matrix-model.js). Marks never claim more than
// the evidence: unresolved evidence is "?", never zero. The engine is grant-only,
// so a Deny statement has no mark: a cell it alone matches is not granted.
import { PBAC_ACTIONS } from './pbac-syntax';
import { roleAncestry } from './role-lookup.js';
import { UNDECIDED, UNDECIDED_GLYPH } from './access-terms';
import { ANY_TYPE } from './matrix-model';
import { isEveryoneRole } from './everyone-role';

/** The row of statements that name no type, and its name on screen. */
export { ANY_TYPE };
export const ANY_TYPE_NAME = 'Any type';
export const typeName = id => id === ANY_TYPE ? ANY_TYPE_NAME : id;

export const BANDS = ['Structure', 'Enterprise objects', 'Interface objects', 'Other types'];
export const MARKS = {
  granted: { glyph: 'check', word: 'Granted', legend: 'Allowed' },
  inherited: { glyph: 'check', word: 'Inherited', legend: 'Inherited' },
  conditional: { glyph: 'C', word: 'Under a condition', legend: 'Under a condition' },
  unresolved: { glyph: UNDECIDED_GLYPH, word: UNDECIDED, legend: UNDECIDED },
  none: { glyph: '', word: 'Not granted', legend: 'Not granted' },
};
/** The kinds of condition (matrix-evaluation CONDITION_KINDS), in words. */
export const KINDS = {
  own: { short: 'own', word: 'own objects', title: 'only objects that name the user, such as the owner' },
  related: { short: 'related', word: 'through a related object', title: 'only with access to, or a role on, a related object' },
  model: { short: 'model', word: 'in certain models', title: 'only objects in certain models' },
  some: { short: 'certain', word: 'certain objects', title: 'only objects with certain field values, or certain named objects' },
};
export const kindWords = kinds => (kinds ?? []).map(k => KINDS[k]?.word ?? k).join(', ');
/** The kinds of condition a conditional operation hangs on. */
export const cellKinds = (index, rid, type, action) => index.summary(rid, type).kinds?.[action] ?? [];
/** Granted through a parent role or Everyone, not by a statement that names the role. A role's
 *  own conditional grant does not make a full grant from above its own. */
export function cellInherited(index, rid, type, action) {
  if (!index.own || isEveryoneRole(index.roles.find(r => r.rid === rid))) return false; // statements for everyone (*) are Everyone's own
  const own = index.own(rid, type), full = !index.summary(rid, type).conditionalActions.includes(action);
  return !(own.actions.includes(action) && !(full && own.conditionalActions.includes(action)));
}
const GRANTS = new Set(['granted', 'inherited', 'conditional']);
export const grants = mark => GRANTS.has(mark);

export function matrixGridState() {
  return { roleQ: '', typeQ: '', lens: 'All', hideEmpty: true, role: '', closed: [], selected: null,
    scroll: [0, 0], focus: '' };
}

/** Mark for one role, type and operation. */
export function cellMark(index, rid, type, action) {
  const cell = index.summary(rid, type);
  if (cell.actions.includes(action)) {
    if (cell.conditionalActions.includes(action)) return 'conditional';
    return cellInherited(index, rid, type, action) ? 'inherited' : 'granted';
  }
  if (cell.unresolvedActions.includes(action)) return 'unresolved';
  return 'none';
}

/** All four operations of a cell, in C R U D order. */
export const cellMarks = (index, rid, type) => Object.fromEntries(PBAC_ACTIONS.map(a => [a, cellMark(index, rid, type, a)]));

/** The strongest mark across the lens: one operation, or any of the four. */
export function lensMark(index, rid, type, lens) {
  if (lens !== 'All') return cellMark(index, rid, type, lens);
  const marks = PBAC_ACTIONS.map(a => cellMark(index, rid, type, a));
  for (const m of ['granted', 'inherited', 'conditional', 'unresolved']) if (marks.includes(m)) return m;
  return 'none';
}

/** A definite answer for the lens: a grant. "?" and no mark are not. */
export function resolvedMark(index, rid, type, lens) {
  return (lens === 'All' ? PBAC_ACTIONS : [lens]).some(a => { const m = cellMark(index, rid, type, a); return grants(m); });
}

/** A grant for the lens that comes from a statement naming this type (or these objects). A
 *  statement that names no type applies everywhere and has its own row: it does not make every
 *  type's row worth showing. */
export function typedGrant(index, rid, type, lens) {
  if (!index.typed) return resolvedMark(index, rid, type, lens);
  const cell = index.typed(rid, type);
  return (lens === 'All' ? PBAC_ACTIONS : [lens]).some(a => cell.actions.includes(a));
}

/** Roles in hierarchy order: Everyone first, then the roots with most heirs, each followed by its children. */
export function orderRoles(roles) {
  const byParent = new Map(), ids = new Set(roles.map(r => r.rid));
  for (const r of roles) { const p = ids.has(r.parent) ? r.parent : ''; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(r); }
  const size = new Map();
  const count = (r, seen = new Set()) => { if (size.has(r.rid)) return size.get(r.rid); if (seen.has(r.rid)) return 0; seen.add(r.rid);
    const n = (byParent.get(r.rid) ?? []).reduce((sum, c) => sum + 1 + count(c, seen), 0); size.set(r.rid, n); return n; };
  const everyone = r => /^everyone$/i.test(r.name) || /^everyone$/i.test(r.id);
  const sort = list => [...list].sort((a, b) => Number(everyone(b)) - Number(everyone(a)) || count(b) - count(a) || a.name.localeCompare(b.name));
  const out = [], seen = new Set();
  const visit = r => { if (seen.has(r.rid)) return; seen.add(r.rid); out.push(r); for (const c of sort(byParent.get(r.rid) ?? [])) visit(c); };
  for (const r of sort(byParent.get('') ?? [])) visit(r);
  for (const r of roles) visit(r); // parent cycles
  return out;
}

/** "11 of 38", "2 + 1? of 24" or "? of 31" while evidence is not resolved. */
export function countText({ granted, unresolved, total, pending }) {
  if (pending && !granted) return '? of ' + total;
  if (!unresolved) return granted + ' of ' + total;
  return granted ? granted + ' + ' + unresolved + '? of ' + total : '? of ' + total;
}

/** The same count in words, for prose next to the matrix (the role's Can do panel):
 * "1 of 95 · 94 undecided", "undecided · 27". */
export function countWords({ granted, unresolved, total, pending }) {
  if (pending && !granted) return 'undecided · ' + total;
  if (!unresolved) return granted + ' of ' + total;
  return granted ? granted + ' of ' + total + ' · ' + unresolved + ' undecided' : 'undecided · ' + total;
}

/**
 * Bands, visible roles and flat rows for a virtualised grid.
 * pending: evidence for some references is still loading.
 */
export function transposeMatrix(index, s, { pending = false } = {}) {
  const roleQ = (s.roleQ || '').toLowerCase(), typeQ = (s.typeQ || '').toLowerCase();
  let roles = orderRoles(index.roles).filter(r => !roleQ || (r.name + ' ' + r.id).toLowerCase().includes(roleQ));
  if (s.role) roles = index.roles.filter(r => r.rid === s.role);
  const bands = [], rows = [];
  // First row: what the statements that name no type grant, on every type.
  if ((!typeQ || ANY_TYPE_NAME.toLowerCase().includes(typeQ)) && roles.some(r => lensMark(index, r.rid, ANY_TYPE, s.lens) !== 'none'))
    rows.push({ kind: 'type', id: ANY_TYPE, group: '', any: true });
  for (const group of BANDS) {
    const all = index.columns.filter(t => t.group === group);
    if (!all.length) continue;
    const matching = all.filter(t => !typeQ || t.id.toLowerCase().includes(typeQ));
    const counts = new Map();
    for (const role of roles) {
      let granted = 0, unresolved = 0;
      for (const t of all) {
        const m = lensMark(index, role.rid, t.id, s.lens);
        if (grants(m)) granted++; else if (m === 'unresolved') unresolved++;
      }
      counts.set(role.rid, { granted, unresolved, total: all.length, pending, text: countText({ granted, unresolved, total: all.length, pending }) });
    }
    // Hide empty keeps a row only when some shown role has a definite answer for the lens.
    const types = s.hideEmpty ? matching.filter(t => roles.some(r => typedGrant(index, r.rid, t.id, s.lens))) : matching;
    const open = !s.closed.includes(group);
    const band = { kind: 'band', group, total: all.length, shown: types.length, open, counts };
    bands.push(band); rows.push(band);
    if (open) for (const t of types) rows.push({ kind: 'type', id: t.id, group });
  }
  return { roles, bands, rows };
}

/** What a role can do per band for one operation, with the same count words as the matrix. */
export function roleBandCounts(index, rid, action, { pending = false } = {}) {
  return BANDS.map(group => {
    const types = index.columns.filter(t => t.group === group);
    if (!types.length) return null;
    let granted = 0, unresolved = 0;
    for (const t of types) { const m = lensMark(index, rid, t.id, action); if (grants(m)) granted++; else if (m === 'unresolved') unresolved++; }
    const counts = { granted, unresolved, total: types.length, pending: pending && !granted };
    return { group, ...counts, text: countText(counts) };
  }).filter(Boolean);
}

/** Neutral words for an operation with nothing granted and nothing open. */
export function nothingGranted(rows) {
  return rows.every(r => !r.granted && !r.unresolved && !r.pending);
}

/** Short words for why a cell is "?", once per reason. Conditions are not listed here:
 *  they are marks on the letter (KINDS). */
const REASONS = [
  [/Object reference/i, 'a referenced object is not loaded'],
  [/Type inheritance/i, 'the type hierarchy is not loaded'],
  [/Unsupported|Ambiguous|Invalid|engine evaluation/i, 'the statement uses something the matrix cannot read'],
];
export function unresolvedWords(reasons) {
  return [...new Set((reasons ?? []).map(r => REASONS.find(([re]) => re.test(r))?.[1] ?? r))];
}

/** Is the selected cell still on the grid (role column shown, type row shown)? */
export function selectionVisible(grid, selected) {
  return !!selected && grid.roles.some(r => r.rid === selected.role) && grid.rows.some(r => r.kind === 'type' && r.id === selected.type);
}

/** Where a statement in a cell comes from, relative to the role. */
export function ruleVia(rule, roles, rid) {
  const chain = roleAncestry(roles, rid), subjects = rule.statement.Subject === '*' ? ['*'] : [].concat(rule.statement.Subject ?? []);
  if (chain[0] && subjects.includes('role:' + chain[0].id)) return { via: 'own', label: 'names this role' };
  const parent = chain.slice(1).find(p => subjects.includes('role:' + p.id));
  if (parent) return { via: 'parent', label: 'inherited via ' + parent.name };
  if (subjects.includes('*')) return { via: 'everyone', label: 'inherited via Everyone (*)' };
  return { via: 'other', label: '' };
}

/** The cell's "why": per operation, the statements that produce it. */
export function cellWhy(index, rid, type) {
  const cell = index.cell(rid, type), marks = cellMarks(index, rid, type);
  return PBAC_ACTIONS.map(action => {
    const rules = cell.rules.filter(r => r.actions.includes(action));
    const unresolved = (cell.unresolvedRules ?? []).filter(r => r.unresolvedActions?.includes(action));
    return { action, mark: marks[action],
      rules: rules.map(rule => ({ rule, ...ruleVia(rule, index.roles, rid), conditional: rule.conditionalActions?.includes(action), kinds: rule.kinds?.[action] ?? [] })),
      kinds: cellKinds(index, rid, type, action), inherited: marks[action] !== 'none' && cellInherited(index, rid, type, action),
      unresolved: unresolved.map(rule => ({ rule, ...ruleVia(rule, index.roles, rid), reasons: rule.unresolvedReasons })) };
  });
}

/** Row offsets for fixed-height virtualisation. */
export function rowOffsets(rows, bandHeight = 34, typeHeight = 28) {
  const offsets = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + (rows[i].kind === 'band' ? bandHeight : typeHeight);
  return offsets;
}

/** First and last row index that intersect [top, top + height]. */
export function visibleRange(offsets, top, height, overscan = 8) {
  let low = 0, high = offsets.length - 2;
  while (low < high) { const mid = (low + high + 1) >> 1; if (offsets[mid] <= top) low = mid; else high = mid - 1; }
  let end = low;
  while (end < offsets.length - 2 && offsets[end + 1] < top + height) end++;
  return [Math.max(0, low - overscan), Math.min(offsets.length - 1, end + 1 + overscan)];
}
