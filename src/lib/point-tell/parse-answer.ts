// Not used by the interface at present: Point and tell is one way. Kept for a later two-way channel.
/**
 * An AI's answer, as text, to the structure the page can judge. Tolerant of how chat answers look: prose
 * around the JSON, a markdown fence, curly quotes, a trailing comma, a // comment. Strict about what it
 * accepts as an operation: the text is only ever JSON-parsed (never run), then read field by field.
 */
import type { PtAnswer, PtOp, PtOpKind, PtParse, PtQuestion, PtRawPlace } from './types';

export const MAX_TEXT = 200_000;
export const MAX_OPS = 200;

export const NOTHING_FOUND = 'No operations found in the pasted text. Paste the whole answer, including the JSON block.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text between the `{` at `from` and its matching `}`, braces inside strings ignored; null when unbalanced. */
function balanced(text: string, from: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/** Copy `t` outside its strings through `step`: it returns null to keep the character at i, or the index to skip to. */
function outsideStrings(t: string, step: (i: number) => number | null): string {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    const skip = step(i);
    if (skip !== null) { i = skip; continue; }
    out += c;
  }
  return out;
}

/** Curly quotes to straight ones, `//` comments and trailing commas out, all outside strings. */
export function lenient(text: string): string {
  const t = text.replace(/^﻿/, '').replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");
  const noComments = outsideStrings(t, (i) => {
    if (t[i] !== '/' || t[i + 1] !== '/') return null;
    let j = i;
    while (j < t.length && t[j] !== '\n') j++;
    return j - 1;
  });
  return outsideStrings(noComments, (i) => {
    if (noComments[i] !== ',') return null;
    let j = i + 1;
    while (j < noComments.length && /\s/.test(noComments[j])) j++;
    return noComments[j] === '}' || noComments[j] === ']' ? i : null;
  });
}

function tryParse(raw: string): { value: unknown } | undefined {
  for (const candidate of [raw, lenient(raw)]) {
    try { return { value: JSON.parse(candidate) as unknown }; } catch { /* next */ }
  }
  return undefined;
}

const looksLikeAnswer = (v: unknown): boolean => Array.isArray(v) || (isObj(v) && ('operations' in v || 'questions' in v || 'cannot' in v));

/** Every place an answer may sit, best first: fenced blocks (last first), the first object, then the whole text. */
function candidates(text: string): string[] {
  const out: string[] = [];
  const fences = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)].map(m => m[1]);
  out.push(...fences.reverse());
  const start = text.indexOf('{');
  if (start >= 0) { const b = balanced(text, start); if (b) out.push(b); }
  out.push(text);
  return out;
}

/** "3", 3, "#3", "note 3" and lists of those: the numbers. */
export function noteNumbers(v: unknown): number[] {
  const one = (x: unknown): number[] => {
    if (typeof x === 'number' && Number.isInteger(x) && x > 0) return [x];
    if (typeof x === 'string') { const m = /(\d+)/.exec(x); return m ? [Number(m[1])] : []; }
    return [];
  };
  return Array.isArray(v) ? v.flatMap(one) : one(v);
}

const OPS = new Set<PtOpKind>(['change', 'move', 'add', 'delete']);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function placeOf(v: unknown): PtRawPlace | undefined {
  if (!isObj(v)) return undefined;
  const p: Record<string, string> = {};
  for (const k of ['before', 'after', 'into']) { const s = str(v[k]); if (s) p[k] = s.trim().toLowerCase(); }
  return Object.keys(p).length ? p : undefined;
}

function readOp(raw: unknown): PtOp | null {
  if (!isObj(raw)) return null;
  const verb = String(raw.op ?? raw.action ?? raw.operation ?? '').trim();
  const kind = verb.toLowerCase() as PtOpKind;
  const notes = noteNumbers(raw.note ?? raw.notes ?? raw.mark ?? raw.marks);
  if (!OPS.has(kind)) return { notes, op: 'unknown', verb };
  const op: PtOp = { notes, op: kind };
  const ref = str(raw.ref) ?? str(raw.target) ?? str(raw.id);
  if (ref) op.ref = ref.trim().toLowerCase();
  const property = str(raw.property) ?? str(raw.prop) ?? str(raw.field);
  if (property) op.property = property.trim();
  if ('value' in raw) op.value = raw.value;
  const to = placeOf(raw.to);
  if (to) op.to = to;
  const place = placeOf(raw.place) ?? placeOf(raw.to);
  if (place) op.place = place;
  const type = str(raw.type) ?? str(raw.className) ?? str(raw.class);
  if (type) op.type = type.trim();
  const name = str(raw.name);
  if (name !== undefined) op.name = name;
  if (isObj(raw.properties)) op.properties = raw.properties;
  const as = str(raw.as);
  if (as) op.as = as.trim().toLowerCase();
  return op;
}

function readQuestions(v: unknown): PtQuestion[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((q): PtQuestion[] => {
    if (typeof q === 'string') return [{ notes: [], text: q }];
    if (!isObj(q)) return [];
    const text = str(q.text) ?? str(q.question) ?? str(q.reason) ?? str(q.message) ?? '';
    return text.trim() ? [{ notes: noteNumbers(q.note ?? q.notes ?? q.mark), text: text.trim() }] : [];
  });
}

/** Read an answer out of pasted text. */
export function parseAnswer(text: string): PtParse {
  if (text.length > MAX_TEXT) return { ok: false, error: 'The pasted text is too long to read as an answer.' };
  for (const raw of candidates(text)) {
    const parsedRaw = tryParse(raw.trim());
    if (!parsedRaw || !looksLikeAnswer(parsedRaw.value)) continue;
    const v = parsedRaw.value;
    const root = Array.isArray(v) ? { operations: v } : v as Record<string, unknown>;
    const rawOps = Array.isArray(root.operations) ? root.operations : [];
    if (rawOps.length > MAX_OPS) return { ok: false, error: `The answer has more than ${MAX_OPS} operations. Ask for fewer.` };
    const operations = rawOps.flatMap(o => { const op = readOp(o); return op ? [op] : []; });
    const questions = readQuestions(root.questions);
    const cannot = readQuestions(root.cannot);
    if (!operations.length && !questions.length && !cannot.length) continue;
    return { ok: true, answer: { operations, questions, cannot } satisfies PtAnswer };
  }
  return { ok: false, error: NOTHING_FOUND };
}
