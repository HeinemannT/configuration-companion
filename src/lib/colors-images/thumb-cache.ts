/**
 * Thumbnails of image files, loaded lazily: a tile asks for its file when it
 * scrolls into view, asks are collected for a moment and sent as one batch
 * (the cheapest source: the download of the file, never its whole content
 * read through a query). A file is read once per cache. Used by the Colors
 * and images page and by the image picker on a button.
 */
import { base64ToBytes } from './image-process';
import { imageMime } from './image-files';

export interface Thumb {
  /** An object URL of the file, for an <img>. */
  url: string;
  bytes: Uint8Array;
  mime: string;
}

export type ThumbState = { state: 'loading' } | { state: 'error'; error: string } | ({ state: 'ready' } & Thumb);

type Loader = (rids: string[]) => Promise<Array<{ rid: string; mime?: string; base64?: string; error?: string }>>;

const BATCH = 12;
const DELAY_MS = 30;

export class ThumbCache {
  private readonly states = new Map<string, ThumbState>();
  private readonly names = new Map<string, string>();
  private readonly waiting = new Set<string>();
  private readonly listeners = new Map<string, Set<(s: ThumbState) => void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly load: Loader) {}

  peek(rid: string): ThumbState | undefined { return this.states.get(rid); }

  /** Ask for a file; `cb` is called now with what is known and again when it
   *  is read. Returns the function that stops the calls. */
  want(rid: string, name: string, cb: (s: ThumbState) => void): () => void {
    let set = this.listeners.get(rid);
    if (!set) this.listeners.set(rid, set = new Set());
    set.add(cb);
    const known = this.states.get(rid);
    if (known) cb(known);
    else {
      this.states.set(rid, { state: 'loading' });
      this.names.set(rid, name);
      this.waiting.add(rid);
      cb({ state: 'loading' });
      this.schedule();
    }
    return () => { set.delete(cb); };
  }

  /** The bytes of a file now (for processing), reading it when needed. */
  async bytes(rid: string, name: string): Promise<Thumb> {
    const known = this.states.get(rid);
    if (known?.state === 'ready') return known;
    return new Promise((resolve, reject) => {
      const stop = this.want(rid, name, s => {
        if (s.state === 'ready') { queueMicrotask(stop); resolve(s); }
        else if (s.state === 'error') { queueMicrotask(stop); reject(new Error(s.error)); }
      });
    });
  }

  /** Forget a file (it was changed): the next ask reads it again. */
  forget(rids: Iterable<string>): void {
    for (const rid of rids) {
      const s = this.states.get(rid);
      if (s?.state === 'ready') URL.revokeObjectURL(s.url);
      this.states.delete(rid);
    }
  }

  /** Forget everything (a new read of the list). */
  clear(): void {
    this.generation += 1;
    this.forget([...this.states.keys()]);
    this.waiting.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, DELAY_MS);
  }

  private async flush(): Promise<void> {
    const rids = [...this.waiting].slice(0, BATCH);
    for (const rid of rids) this.waiting.delete(rid);
    if (this.waiting.size) this.schedule();
    if (!rids.length) return;
    const generation = this.generation;
    let items: Awaited<ReturnType<Loader>>;
    try { items = await this.load(rids); } catch (e) {
      items = rids.map(rid => ({ rid, error: e instanceof Error ? e.message : String(e) }));
    }
    if (generation !== this.generation) return;
    for (const rid of rids) {
      const item = items.find(i => i.rid === rid);
      // The name says what a file is; the servlet may say octet-stream.
      const mime = imageMime(this.names.get(rid) ?? '') ?? (item?.mime && item.mime.startsWith('image/') ? item.mime : 'application/octet-stream');
      let next: ThumbState;
      if (item?.base64 !== undefined) {
        const bytes = base64ToBytes(item.base64);
        next = { state: 'ready', url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })), bytes, mime };
      } else next = { state: 'error', error: item?.error ?? 'The file could not be read' };
      this.states.set(rid, next);
      for (const cb of this.listeners.get(rid) ?? []) cb(next);
    }
  }
}
