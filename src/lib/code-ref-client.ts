/**
 * Window-side cache for code references: resolved identities (one batched
 * RESOLVE_CODE_REFS per request) and the targets' code (read on the first
 * peek through the object read). Shared by the object window and the
 * Extended Code window; the transport is injected, so it is unit-tested
 * without chrome.*.
 *
 * Answers are kept for the life of the window. A failed request (no
 * connection) is remembered only briefly, so the next hover asks again.
 */

import type { FullObject } from './object-read';
import type { RefResolution } from './code-ref-resolve';
import { blocksFor, isEmptyValue, typeInfo } from './object-window-table';

export interface CodeRefIo {
  resolve(keys: string[]): Promise<Record<string, RefResolution>>;
  read(rids: string[]): Promise<{ objects: Record<string, FullObject>; errors: Record<string, string> }>;
}

export interface TargetCode {
  loading?: boolean;
  obj?: FullObject;
  /** Property shown, and its text. */
  prop?: string;
  text?: string;
  error?: string;
}

/** Short memory of a failed request (not of a "not found"). */
const RETRY_MS = 10_000;

/** The code property to show for a target: the resolve's hint when it holds
 *  code, else the first code block of the type, else any code property. */
export function pickCode(obj: FullObject, hint?: string): { prop: string; text: string } | null {
  const has = (p: string) => !!obj.props[p] && obj.props[p].kind === 'code' && !isEmptyValue(obj.props[p]);
  const text = (p: string) => obj.props[p]?.text ?? '';
  if (hint && obj.props[hint] && !isEmptyValue(obj.props[hint])) return { prop: hint, text: text(hint) };
  const blocks = blocksFor(typeInfo(obj.type), obj).filter(p => obj.props[p] && !isEmptyValue(obj.props[p]));
  if (blocks.length) return { prop: blocks[0], text: text(blocks[0]) };
  const any = Object.keys(obj.props).find(has);
  return any ? { prop: any, text: text(any) } : null;
}

export class CodeRefCache {
  private readonly refs = new Map<string, RefResolution & { until?: number }>();
  private readonly inflight = new Set<string>();
  private readonly codes = new Map<string, TargetCode>();
  /** Bumps on every change, so a view can tell whether to redraw. */
  version = 0;

  constructor(private readonly io: CodeRefIo, private readonly onChange: () => void = () => {}) {}

  /** Known answer for `key`; 'pending' while asked; undefined when unknown. */
  ref(key: string): RefResolution | 'pending' | undefined {
    const r = this.refs.get(key);
    if (r?.until != null && Date.now() > r.until) { this.refs.delete(key); return this.inflight.has(key) ? 'pending' : undefined; }
    if (r) return r;
    return this.inflight.has(key) ? 'pending' : undefined;
  }

  /** Ask for every unknown key in ONE request. */
  request(keys: readonly string[]): Promise<void> {
    const want = [...new Set(keys)].filter(k => this.ref(k) === undefined);
    if (!want.length) return Promise.resolve();
    for (const k of want) this.inflight.add(k);
    this.changed();
    return this.io.resolve(want).then(res => {
      for (const k of want) this.refs.set(k, res[k] ?? { found: false });
    }, (e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      for (const k of want) this.refs.set(k, { found: false, error, until: Date.now() + RETRY_MS });
    }).finally(() => {
      for (const k of want) this.inflight.delete(k);
      this.changed();
    });
  }

  /** Ask again for the keys whose request failed (not for a "not found"). */
  retry(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      const r = this.refs.get(k);
      if (r && !r.found && r.error !== undefined) this.refs.delete(k);
    }
    return this.request(keys);
  }

  code(rid: string): TargetCode | undefined {
    return this.codes.get(rid);
  }

  /** Read a target's code once (the first peek). */
  requestCode(rid: string, hint?: string): Promise<void> {
    const cur = this.codes.get(rid);
    if (cur && (cur.loading || cur.obj)) return Promise.resolve();
    this.codes.set(rid, { loading: true });
    this.changed();
    return this.io.read([rid]).then(({ objects, errors }) => {
      const obj = objects[rid];
      if (!obj) { this.codes.set(rid, { error: errors[rid] ?? 'Object not found' }); return; }
      const picked = pickCode(obj, hint);
      this.codes.set(rid, { obj, ...(picked ? { prop: picked.prop, text: picked.text } : {}) });
    }, (e: unknown) => {
      this.codes.delete(rid);
      this.codes.set(rid, { error: e instanceof Error ? e.message : String(e) });
    }).finally(() => this.changed());
  }

  /** A full read the caller already has (the tree, a save's re-read). */
  putObject(obj: FullObject, hint?: string): void {
    const picked = pickCode(obj, hint);
    this.codes.set(obj.rid, { obj, ...(picked ? { prop: picked.prop, text: picked.text } : {}) });
  }

  /** Changes are announced once per task: a view may ask for keys while it
   *  renders without being re-entered. */
  private changed(): void {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.onChange();
      for (const fn of this.listeners) fn();
    });
  }

  private readonly listeners = new Set<() => void>();

  /** Also tell `fn` about changes (an editor sharing the window's cache). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private scheduled = false;
}
