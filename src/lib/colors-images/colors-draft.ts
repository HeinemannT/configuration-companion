/**
 * The unsaved color changes of the Colors tab: what was changed, added or
 * created, the colors a set shows with them, the operations the write sends
 * and the check of the answer after the write. Pure.
 */
import type { ColorSetData } from '../types';
import { hexFromRgbText, normalizeHex } from './color-math';
import { isValidId, proposeColorId, proposeIds } from './id-proposal';
import type { ColorOp } from './write-ops';

export interface NewColor { key: string; setId: string; id: string; name: string; hex: string; idTouched: boolean }
export interface NewSet { id: string; name: string; besideSetId: string; idTouched: boolean }

export interface ColorDraft {
  /** Changes of colors that exist, by ID. A field equal to the stored one is not kept. */
  edits: Record<string, { name?: string; hex?: string }>;
  newColors: NewColor[];
  newSets: NewSet[];
}

export const emptyDraft = (): ColorDraft => ({ edits: {}, newColors: [], newSets: [] });

/** One color as the grid and the editor show it. */
export interface ColorView {
  /** The color's ID, or the key of a new one. */
  key: string;
  id: string;
  name: string;
  hex: string;
  /** Stored values of a color that exists. */
  was?: { name: string; hex: string };
  isNew: boolean;
}

/** A set as the list shows it (a new set has no stored colors). */
export interface SetView { id: string; name: string; isNew: boolean; colors: ColorView[]; besideSetId?: string }

export function storedHex(rgb: string): string {
  return hexFromRgbText(rgb) ?? '#000000';
}

export function colorsOfSet(set: ColorSetData | undefined, setId: string, draft: ColorDraft): ColorView[] {
  const stored = (set?.colors ?? []).map((c): ColorView => {
    const hex = storedHex(c.rgb);
    const e = draft.edits[c.bid];
    return { key: c.bid, id: c.bid, name: e?.name ?? c.name, hex: e?.hex ?? hex, was: { name: c.name, hex }, isNew: false };
  });
  const added = draft.newColors.filter(n => n.setId === setId).map((n): ColorView => ({ key: n.key, id: n.id, name: n.name, hex: n.hex, isNew: true }));
  return [...stored, ...added];
}

/** The sets in the order of the read, then the new ones. */
export function setViews(sets: readonly ColorSetData[], draft: ColorDraft): SetView[] {
  const byId = new Map(sets.map(s => [s.id, s]));
  return [
    ...sets.map((s): SetView => ({ id: s.id, name: s.name || s.id, isNew: false, colors: colorsOfSet(s, s.id, draft) })),
    ...draft.newSets.map((n): SetView => ({ id: n.id, name: n.name, isNew: true, besideSetId: n.besideSetId, colors: colorsOfSet(byId.get(n.id), n.id, draft) })),
  ];
}

/** Set a field of a color that exists; a value equal to the stored one drops the change. */
export function editColor(draft: ColorDraft, set: ColorSetData | undefined, bid: string, field: 'name' | 'hex', value: string): ColorDraft {
  const stored = set?.colors.find(c => c.bid === bid);
  if (!stored) return draft;
  const was = field === 'name' ? stored.name : storedHex(stored.rgb);
  const next = { ...(draft.edits[bid] ?? {}) };
  if (value === was) delete next[field]; else next[field] = value;
  const edits = { ...draft.edits };
  if (Object.keys(next).length) edits[bid] = next; else delete edits[bid];
  return { ...draft, edits };
}

export function editNewColor(draft: ColorDraft, key: string, patch: Partial<Pick<NewColor, 'name' | 'hex' | 'id'>>): ColorDraft {
  return { ...draft, newColors: draft.newColors.map(n => n.key !== key ? n : { ...n, ...patch, ...(patch.id !== undefined ? { idTouched: true } : {}) }) };
}

/** Every ID of the sets and colors read, and of the new ones. */
export function takenIds(sets: readonly ColorSetData[], draft: ColorDraft): string[] {
  return [
    ...sets.flatMap(s => [s.id, ...s.colors.map(c => c.bid)]),
    ...draft.newSets.map(n => n.id), ...draft.newColors.map(n => n.id),
  ];
}

/** A new color in a set, with the ID following the IDs of the colors in the set. */
export function addColor(draft: ColorDraft, sets: readonly ColorSetData[], setId: string, key: string, hex = '#808080', name = 'New color'): { draft: ColorDraft; added: NewColor } {
  const id = proposeColorId(name, setId, colorsOfSet(sets.find(s => s.id === setId), setId, draft).map(c => c.id), takenIds(sets, draft));
  const added: NewColor = { key, setId, id, name, hex, idTouched: false };
  return { draft: { ...draft, newColors: [...draft.newColors, added] }, added };
}

/** Several new colors in a set at once (pasted, or the steps of a scale), each
 *  with an ID that follows the set and the ones added before it. */
export function addColors(
  draft: ColorDraft, sets: readonly ColorSetData[], setId: string, items: ReadonlyArray<{ name: string; hex: string; id?: string }>, nextKey: () => string,
): { draft: ColorDraft; added: NewColor[] } {
  let d = draft;
  const added: NewColor[] = [];
  for (const it of items) {
    const r = addColor(d, sets, setId, nextKey(), normalizeHex(it.hex) ?? it.hex, it.name.trim() || 'Color');
    // An ID the caller gives (the steps of a scale: the base ID and the step) stands where it is free.
    const taken = new Set([...takenIds(sets, d), ...colorsOfSet(sets.find(s => s.id === setId), setId, d).map(c => c.id)].map(x => x.toLowerCase()));
    if (it.id && isValidId(it.id) && !taken.has(it.id.toLowerCase())) {
      const added1 = { ...r.added, id: it.id };
      d = { ...r.draft, newColors: r.draft.newColors.map(n => n.key === added1.key ? added1 : n) };
      added.push(added1);
      continue;
    }
    d = r.draft;
    added.push(r.added);
  }
  return { draft: d, added };
}

/** The steps of a scale from a color, named after it (`Steadfast teal 100`); the base itself is not added again. */
export function scaleColors(baseName: string, steps: ReadonlyArray<{ step: number; hex: string }>, baseId?: string): Array<{ name: string; hex: string; step: number; id?: string }> {
  return steps.filter(s => s.step !== 500).map(s => ({ name: `${baseName.trim()} ${s.step}`, hex: s.hex, step: s.step, ...(baseId ? { id: `${baseId}_${s.step}` } : {}) }));
}

/** Every color of the sets as read and as changed on the page: what a new color is compared with. */
export function knownColors(sets: readonly ColorSetData[], draft: ColorDraft, exceptKey?: string): Array<{ key: string; name: string; hex: string }> {
  return setViews(sets, draft).flatMap(v => v.colors).filter(c => c.key !== exceptKey).map(c => ({ key: c.key, name: c.name, hex: c.hex }));
}

/** The name of a new color changed: its ID follows until the person edits the ID. */
export function renameNewColor(draft: ColorDraft, sets: readonly ColorSetData[], key: string, name: string): ColorDraft {
  const cur = draft.newColors.find(n => n.key === key);
  if (!cur) return draft;
  if (cur.idTouched) return editNewColor(draft, key, { name });
  const others = { ...draft, newColors: draft.newColors.filter(n => n.key !== key) };
  const id = proposeColorId(name || 'color', cur.setId, colorsOfSet(sets.find(s => s.id === cur.setId), cur.setId, others).map(c => c.id), takenIds(sets, others));
  return { ...draft, newColors: draft.newColors.map(n => n.key !== key ? n : { ...n, name, id }) };
}

export function removeNewColor(draft: ColorDraft, key: string): ColorDraft {
  return { ...draft, newColors: draft.newColors.filter(n => n.key !== key) };
}

/** A new set beside an existing one; its ID follows the IDs of the sets. */
export function addSet(draft: ColorDraft, sets: readonly ColorSetData[], name: string, besideSetId: string): ColorDraft {
  const [id] = proposeIds([name], sets.map(s => s.id), takenIds(sets, draft));
  return { ...draft, newSets: [...draft.newSets, { id, name: name.trim(), besideSetId, idTouched: false }] };
}

export function removeNewSet(draft: ColorDraft, id: string): ColorDraft {
  return { ...draft, newSets: draft.newSets.filter(n => n.id !== id), newColors: draft.newColors.filter(n => n.setId !== id) };
}

/** Problems that stop a save, by key. */
export function problems(sets: readonly ColorSetData[], draft: ColorDraft): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  const stored = new Set(sets.flatMap(s => [s.id, ...s.colors.map(c => c.bid)]));
  for (const n of draft.newSets) seen.set(n.id.toLowerCase(), (seen.get(n.id.toLowerCase()) ?? 0) + 1);
  for (const n of draft.newColors) seen.set(n.id.toLowerCase(), (seen.get(n.id.toLowerCase()) ?? 0) + 1);
  for (const n of draft.newSets) {
    if (!n.name.trim()) out.set(n.id, 'Give the set a name');
    else if (!isValidId(n.id)) out.set(n.id, 'Use letters, digits and _ in the ID');
    else if (stored.has(n.id) || (seen.get(n.id.toLowerCase()) ?? 0) > 1) out.set(n.id, 'This ID is taken');
  }
  for (const n of draft.newColors) {
    if (!n.name.trim()) out.set(n.key, 'Give the color a name');
    else if (!isValidId(n.id)) out.set(n.key, 'Use letters, digits and _ in the ID');
    else if (stored.has(n.id) || (seen.get(n.id.toLowerCase()) ?? 0) > 1) out.set(n.key, 'This ID is taken');
    else if (!normalizeHex(n.hex)) out.set(n.key, 'Not a color');
  }
  for (const [bid, e] of Object.entries(draft.edits)) {
    if (e.name !== undefined && !e.name.trim()) out.set(bid, 'Give the color a name');
    else if (e.hex !== undefined && !normalizeHex(e.hex)) out.set(bid, 'Not a color');
  }
  return out;
}

/** One line of the confirm bar. */
export interface ChangeRow {
  kind: 'change' | 'add' | 'addSet';
  name: string;
  id: string;
  /** Hex before and after (change), or the new hex (add). */
  from?: string;
  to?: string;
  /** What else changed ("name: A → B"). */
  detail: string;
}

export function pendingChanges(sets: readonly ColorSetData[], draft: ColorDraft): { ops: ColorOp[]; rows: ChangeRow[] } {
  const ops: ColorOp[] = [];
  const rows: ChangeRow[] = [];
  const setName = (id: string) => draft.newSets.find(s => s.id === id)?.name ?? sets.find(s => s.id === id)?.name ?? id;
  for (const n of draft.newSets) {
    ops.push({ kind: 'addSet', besideSetId: n.besideSetId, id: n.id, name: n.name.trim() });
    rows.push({ kind: 'addSet', name: n.name.trim(), id: n.id, detail: 'New set' });
  }
  for (const n of draft.newColors) {
    const hex = normalizeHex(n.hex) ?? n.hex;
    ops.push({ kind: 'add', setId: n.setId, id: n.id, name: n.name.trim(), hex });
    rows.push({ kind: 'add', name: n.name.trim(), id: n.id, to: hex, detail: `New in ${setName(n.setId)}` });
  }
  for (const s of sets) for (const c of s.colors) {
    const e = draft.edits[c.bid];
    if (!e) continue;
    const was = storedHex(c.rgb);
    const hex = e.hex !== undefined ? normalizeHex(e.hex) ?? e.hex : undefined;
    ops.push({ kind: 'change', id: c.bid, ...(e.name !== undefined ? { name: e.name.trim() } : {}), ...(hex !== undefined ? { hex } : {}) });
    rows.push({
      kind: 'change', name: e.name?.trim() || c.name, id: c.bid, from: was, to: hex ?? was,
      detail: [hex !== undefined ? `${was} → ${hex}` : '', e.name !== undefined ? `name: ${c.name} → ${e.name.trim()}` : ''].filter(Boolean).join(', '),
    });
  }
  return { ops, rows };
}

/** After the write and a fresh read: what the server does not hold as sent. */
export function verifyColors(ops: readonly ColorOp[], sets: readonly ColorSetData[]): string[] {
  const colors = new Map(sets.flatMap(s => s.colors.map(c => [c.bid, { name: c.name, hex: storedHex(c.rgb), set: s.id }] as const)));
  const setIds = new Set(sets.map(s => s.id));
  const bad: string[] = [];
  for (const op of ops) {
    if (op.kind === 'addSet') { if (!setIds.has(op.id)) bad.push(`The set ${op.name} was not found`); continue; }
    const got = colors.get(op.id);
    if (!got) { bad.push(`The color ${op.kind === 'add' ? op.name : op.id} was not found`); continue; }
    if (op.kind === 'add') {
      if (got.hex !== normalizeHex(op.hex)) bad.push(`${op.name} reads ${got.hex}`);
      if (got.set !== op.setId) bad.push(`${op.name} is in another set`);
    } else {
      if (op.hex !== undefined && got.hex !== normalizeHex(op.hex)) bad.push(`${op.name ?? op.id} reads ${got.hex}`);
      if (op.name !== undefined && got.name !== op.name) bad.push(`${op.id} is named ${got.name}`);
    }
  }
  return bad;
}

export const hasChanges = (d: ColorDraft): boolean => d.newColors.length + d.newSets.length + Object.keys(d.edits).length > 0;
export const changeCount = (d: ColorDraft): number => d.newColors.length + d.newSets.length + Object.keys(d.edits).length;
