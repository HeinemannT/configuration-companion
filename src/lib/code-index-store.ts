/**
 * Code index storage: a local copy of every object's Extended Code, kept per
 * server (the environment token `<profileId>@<serverUrl>`), in IndexedDB.
 *
 * Both the service worker (which builds and refreshes the index) and the
 * code search window (which searches it in its own page) open the same
 * database: extension pages and the worker share one origin. Nothing is
 * synced; the database is deleted per profile when the profile is removed
 * and as a whole by "Clear cached objects".
 *
 * Two stores per object: `objects` holds the full record (with the code),
 * `cards` a light record without the code (identity, place, stamps, the
 * reference list and the names of the code properties). Syncs, the object
 * pickers and "Used in code" read the cards; only a text search reads code.
 * The cards are written in the same transaction as the objects. An index
 * built before the cards existed (database version 1) gets its cards when the
 * database is opened (one pass over the stored objects, no server request).
 *
 * `MemoryCodeIndexStore` has the same contract for tests.
 */

/** One reference in an object's code, precomputed with `findCodeRefs`. */
export interface IndexedRef {
  /** Resolve key (`t.some_id`, `rid:123`). */
  k: string;
  /** Property that holds the code. */
  p: string;
  /** 1-based line. */
  l: number;
  /** Start and end on that line. */
  s: number;
  e: number;
  /** Form: dot, get, brace, lookup, rid. */
  f: string;
}

export interface IndexedObject {
  env: string;
  /** 64-bit RID as a string. */
  rid: string;
  type: string;
  name: string;
  businessId: string;
  /** "Grandparent › Parent". */
  where: string;
  /** Last-modified stamp as BMP prints it, plus the code length: the pair
   *  decides whether the object changed since it was read. */
  stamp: string;
  len: number;
  /** Code per property (empty properties are left out). For an instance,
   *  only the properties whose text differs from its template's. */
  code: Record<string, string>;
  refs: IndexedRef[];
  /** Technical accessor of the root the object lives under (`organisation`,
   *  `templateCategory`, `portal` …). Absent in an index built before roots. */
  root?: string;
  /** Organisation root: RIDs of the organisations above the object, the
   *  top-level organisation first, its own organisation last. */
  path?: string[];
  /** RID of the template the object is an instance of (`linkedTo`). */
  tmpl?: string;
  /** Code properties whose text the server found equal to the template's:
   *  not stored here, read from the template (code-search `effectiveCode`). */
  inherits?: string[];
}

/** The light record of an object: everything but its code text, plus the
 *  names of its own code properties. */
export type IndexedCard = Omit<IndexedObject, 'code'> & { props: string[] };

export function cardOf(o: IndexedObject): IndexedCard {
  const { code, ...rest } = o;
  return { ...rest, props: Object.keys(code) };
}

/** One root of the index and how much of it is read. */
export interface RootCoverage {
  /** The root object's name on the server (or the built-in label). */
  name: string;
  /** Objects with code under it, so far. */
  objects: number;
  /** Every object of the root is listed and read. */
  done: boolean;
  /** Organisation root: top-level organisations, and how many are read. */
  tops?: number;
  topsDone?: number;
  /** RIDs of the top-level organisations read completely. */
  topsRead?: string[];
}

/** What a refresh of one list (a root or a top-level organisation, one
 *  type) needs from the previous one: how many objects the type had there,
 *  and the day the list was complete. */
export interface BucketState {
  count: number;
  /** yyyy-mm-dd: objects changed since the day before are listed again. */
  day: string;
}

export interface CodeIndexMeta {
  env: string;
  /** When the last complete sync finished (ms). */
  syncedAt: number | null;
  /** When the first complete build finished (ms). */
  builtAt: number | null;
  objects: number;
  bytes: number;
  /** Types the last inventory covered. */
  types: string[];
  /** Objects the last inventory listed that are not read yet (a build in
   *  progress or one that stopped). */
  pending: number;
  /** Objects the last sync could not read (counted in `pending`). */
  failed?: number;
  /** Bumps with every write of objects: the search window reloads its copy
   *  when it changes (persisted, so a worker restart cannot reuse a number). */
  revision?: number;
  /** Code properties per type, as discovered on the server. */
  codeProps?: Record<string, string[]>;
  codePropsAt?: number | null;
  discovery?: { types: number; withObjects: number; sampled: number; unreadable: string[]; error?: string };
  /** Code types whose object list failed in the last sync (not covered). */
  notCovered?: string[];
  lastError?: string;
  /** Per root (accessor): name, objects, whether it is read completely. */
  roots?: Record<string, RootCoverage>;
  /** Root accessors in build order. */
  rootOrder?: string[];
  /** Organisations: RID → name and parent organisation RID ('' for a
   *  top-level organisation). */
  orgs?: Record<string, { name: string; parent: string }>;
  /** Build stage: 'roots' (everything but the organisation root), then
   *  'organisation' (top-level organisation by organisation), then 'done'. */
  stage?: 'roots' | 'organisation' | 'done';
  /** `<bucket>|<type>` → state of the last complete list (refresh). */
  buckets?: Record<string, BucketState>;
  /** Objects of code types the server counts outside every known root. */
  outside?: Record<string, number>;
  /** The last change summary (`<source>|<type>` → count, changed, newest
   *  changed stamp) and the day its window starts from. */
  summary?: Record<string, { n: number; c: number; m: string }>;
  summaryDay?: string;
  /** Server and extension version the discovered properties belong to. */
  discoveryKey?: string;
  /** Objects listed without code: RID → stamp, type and root (not read
   *  again unchanged; counted by the completeness check). */
  empty?: Record<string, string>;
  /** Objects of a type the server counts in a root but the index does not
   *  hold (completeness check): type → how many. */
  incomplete?: Record<string, number>;
  /** Roots the completeness check could not count: accessor → why. */
  uncounted?: Record<string, string>;
  /** Root accessor → the root's RID (the context object of a count). */
  rootRids?: Record<string, string>;
  /** When every object was last listed (ms). */
  lastFullAt?: number;
  /** When the server last answered like an overloaded one (ms). */
  overloadAt?: number;
  /** A copy made from the code search's own read (code-copy.ts); absent for
   *  an index of the older root-by-root builder. Read source by source
   *  (`perSource`): the sources stored so far of a build that has not
   *  finished. A copy stored by an earlier version may still hold
   *  `serverNow` and `copiedAt`; they are not used. */
  copy?: { perSource?: boolean; sourcesDone?: string[] };
}

/** What an incremental sync needs to know about a stored object. */
export interface StoredStamp {
  type: string;
  stamp: string;
  len: number;
  root?: string;
  /** Top-level organisation (organisation root). */
  top?: string;
  /** Organisations above the object, top-level first. */
  path?: string[];
  tmpl?: string;
  inherits?: number;
}

export interface CodeIndexStore {
  getMeta(env: string): Promise<CodeIndexMeta | null>;
  putMeta(meta: CodeIndexMeta): Promise<void>;
  /** Read from the light records: no code is loaded. */
  stamps(env: string): Promise<Map<string, StoredStamp>>;
  put(objects: readonly IndexedObject[]): Promise<void>;
  /** Every light record of `env` (no code), in batches. */
  scanCards(env: string, each: (batch: IndexedCard[]) => boolean | void, batchSize?: number): Promise<void>;
  /** Full records of some objects (missing ones are left out). */
  getMany(env: string, rids: readonly string[]): Promise<IndexedObject[]>;
  remove(env: string, rids: readonly string[]): Promise<void>;
  /** Every object of `env`, in batches. Return false from `each` to stop. */
  scan(env: string, each: (batch: IndexedObject[]) => boolean | void, batchSize?: number): Promise<void>;
  get(env: string, rid: string): Promise<IndexedObject | null>;
  /** Delete one environment, every environment of a profile, or all. */
  clear(filter?: { env?: string; profileId?: string }): Promise<void>;
}

function stampOf(o: IndexedCard | IndexedObject): StoredStamp {
  return {
    type: o.type, stamp: o.stamp, len: o.len,
    ...(o.root ? { root: o.root } : {}), ...(o.path?.length ? { top: o.path[0], path: o.path } : {}),
    ...(o.tmpl ? { tmpl: o.tmpl } : {}), ...(o.inherits?.length ? { inherits: o.inherits.length } : {}),
  };
}

const DB_NAME = 'crev-code-index';
/** 2: the light records (`cards`). */
export const DB_VERSION = 2;
const OBJECTS = 'objects';
const META = 'meta';
const CARDS = 'cards';

/** Create the stores, and give an index of an older version its light
 *  records from the stored objects (inside the upgrade, no server request). */
export function upgradeCodeIndexDb(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS, { keyPath: ['env', 'rid'] });
  if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'env' });
  if (!db.objectStoreNames.contains(CARDS)) {
    const cards = db.createObjectStore(CARDS, { keyPath: ['env', 'rid'] });
    if (oldVersion >= 1) {
      const cursor = tx.objectStore(OBJECTS).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        cards.put(cardOf(c.value as IndexedObject));
        c.continue();
      };
    }
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

const envRange = (env: string) => IDBKeyRange.bound([env, ''], [env, '￿']);
const profileOf = (env: string) => env.split('@')[0];

export class IdbCodeIndexStore implements CodeIndexStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = e => { upgradeCodeIndexDb(r.result, r.transaction!, e.oldVersion); };
        r.onsuccess = () => {
          const db = r.result;
          // Another page upgrading or deleting the database closes this one.
          db.onversionchange = () => { db.close(); this.db = null; };
          resolve(db);
        };
        r.onerror = () => { this.db = null; reject(r.error ?? new Error('Cannot open the local code copy')); };
        r.onblocked = () => { this.db = null; reject(new Error('The local code copy is blocked by another page')); };
      });
    }
    return this.db;
  }

  async getMeta(env: string): Promise<CodeIndexMeta | null> {
    const db = await this.open();
    return (await req(db.transaction(META).objectStore(META).get(env)) as CodeIndexMeta | undefined) ?? null;
  }

  async putMeta(meta: CodeIndexMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(meta);
    await done(tx);
  }

  async stamps(env: string): Promise<Map<string, StoredStamp>> {
    const out = new Map<string, StoredStamp>();
    await this.scanCards(env, batch => { for (const o of batch) out.set(o.rid, stampOf(o)); }, 1000);
    return out;
  }

  async put(objects: readonly IndexedObject[]): Promise<void> {
    if (!objects.length) return;
    const db = await this.open();
    const tx = db.transaction([OBJECTS, CARDS], 'readwrite');
    const s = tx.objectStore(OBJECTS);
    const c = tx.objectStore(CARDS);
    for (const o of objects) { s.put(o); c.put(cardOf(o)); }
    await done(tx);
  }

  async remove(env: string, rids: readonly string[]): Promise<void> {
    if (!rids.length) return;
    const db = await this.open();
    const tx = db.transaction([OBJECTS, CARDS], 'readwrite');
    const s = tx.objectStore(OBJECTS);
    const c = tx.objectStore(CARDS);
    for (const rid of rids) { s.delete([env, rid]); c.delete([env, rid]); }
    await done(tx);
  }

  private async pages<T extends { rid: string }>(store: string, env: string, each: (batch: T[]) => boolean | void, batchSize: number): Promise<void> {
    const db = await this.open();
    let lower: IDBKeyRange = envRange(env);
    for (;;) {
      const batch = await req(db.transaction(store).objectStore(store).getAll(lower, batchSize)) as T[];
      if (!batch.length) return;
      if (each(batch) === false) return;
      if (batch.length < batchSize) return;
      lower = IDBKeyRange.bound([env, batch[batch.length - 1].rid], [env, '￿'], true, false);
    }
  }

  scan(env: string, each: (batch: IndexedObject[]) => boolean | void, batchSize = 400): Promise<void> {
    return this.pages(OBJECTS, env, each, batchSize);
  }

  scanCards(env: string, each: (batch: IndexedCard[]) => boolean | void, batchSize = 1000): Promise<void> {
    return this.pages(CARDS, env, each, batchSize);
  }

  async getMany(env: string, rids: readonly string[]): Promise<IndexedObject[]> {
    if (!rids.length) return [];
    const db = await this.open();
    const s = db.transaction(OBJECTS).objectStore(OBJECTS);
    const got = await Promise.all(rids.map(rid => req(s.get([env, rid])) as Promise<IndexedObject | undefined>));
    return got.filter((o): o is IndexedObject => !!o);
  }

  async get(env: string, rid: string): Promise<IndexedObject | null> {
    const db = await this.open();
    return (await req(db.transaction(OBJECTS).objectStore(OBJECTS).get([env, rid])) as IndexedObject | undefined) ?? null;
  }

  async clear(filter: { env?: string; profileId?: string } = {}): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([OBJECTS, META, CARDS], 'readwrite');
    const objects = tx.objectStore(OBJECTS);
    const meta = tx.objectStore(META);
    const cards = tx.objectStore(CARDS);
    if (!filter.env && !filter.profileId) {
      objects.clear();
      meta.clear();
      cards.clear();
    } else {
      const envs = filter.env ? [filter.env]
        : ((await req(meta.getAllKeys())) as string[]).filter(e => profileOf(e) === filter.profileId);
      for (const env of envs) {
        objects.delete(envRange(env));
        cards.delete(envRange(env));
        meta.delete(env);
      }
    }
    await done(tx);
  }
}

/** Same contract in memory (tests, and a fallback when IndexedDB is not
 *  available). */
export class MemoryCodeIndexStore implements CodeIndexStore {
  readonly objects = new Map<string, IndexedObject>();
  readonly meta = new Map<string, CodeIndexMeta>();
  private key = (env: string, rid: string) => `${env}\u0000${rid}`;

  getMeta(env: string) { return Promise.resolve(this.meta.get(env) ?? null); }
  putMeta(m: CodeIndexMeta) { this.meta.set(m.env, { ...m }); return Promise.resolve(); }
  /** Records read, and characters of them (measurements). */
  readonly reads = { objects: 0, cards: 0, chars: 0 };
  stamps(env: string) {
    const out = new Map<string, StoredStamp>();
    void this.scanCards(env, batch => { for (const o of batch) out.set(o.rid, stampOf(o)); });
    return Promise.resolve(out);
  }
  scanCards(env: string, each: (batch: IndexedCard[]) => boolean | void, batchSize = 1000) {
    const all = this.sorted(env).map(cardOf);
    this.reads.cards += all.length;
    this.reads.chars += all.reduce((n, c) => n + JSON.stringify(c).length, 0);
    for (let i = 0; i < all.length; i += batchSize) if (each(all.slice(i, i + batchSize)) === false) break;
    return Promise.resolve();
  }
  getMany(env: string, rids: readonly string[]) {
    const got = rids.map(r => this.objects.get(this.key(env, r))).filter((o): o is IndexedObject => !!o);
    this.reads.objects += got.length;
    return Promise.resolve(got);
  }
  private sorted(env: string): IndexedObject[] {
    return [...this.objects.values()].filter(o => o.env === env).sort((a, b) => (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0));
  }
  put(list: readonly IndexedObject[]) { for (const o of list) this.objects.set(this.key(o.env, o.rid), o); return Promise.resolve(); }
  remove(env: string, rids: readonly string[]) { for (const r of rids) this.objects.delete(this.key(env, r)); return Promise.resolve(); }
  scan(env: string, each: (batch: IndexedObject[]) => boolean | void, batchSize = 400) {
    const all = this.sorted(env);
    this.reads.objects += all.length;
    this.reads.chars += all.reduce((n, c) => n + JSON.stringify(c).length, 0);
    for (let i = 0; i < all.length; i += batchSize) if (each(all.slice(i, i + batchSize)) === false) break;
    return Promise.resolve();
  }
  get(env: string, rid: string) { return Promise.resolve(this.objects.get(this.key(env, rid)) ?? null); }
  clear(filter: { env?: string; profileId?: string } = {}) {
    const hit = (env: string) => (!filter.env && !filter.profileId) || env === filter.env || (filter.profileId != null && profileOf(env) === filter.profileId);
    for (const [k, o] of this.objects) if (hit(o.env)) this.objects.delete(k);
    for (const env of this.meta.keys()) if (hit(env)) this.meta.delete(env);
    return Promise.resolve();
  }
}

let shared: CodeIndexStore | null = null;
/** The page's (or the worker's) store. */
export function codeIndexStore(): CodeIndexStore {
  if (!shared) shared = typeof indexedDB !== 'undefined' ? new IdbCodeIndexStore() : new MemoryCodeIndexStore();
  return shared;
}
