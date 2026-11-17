/**
 * BMP's own search command (`SearchCommand`), for finding objects by name
 * and ID without any Extended Code: no script text reaches the server's
 * parse cache.
 *
 * What the server does with it (verified live on BMP 5.6.17.6):
 *  - `fields` `id` and `name`: a case-insensitive substring match (`*word*`)
 *    on the search index; the ID is lower-cased in the index. `exact` matches
 *    the whole text. The index is updated in the save path, so it is fresh.
 *  - Code (expression and HTML properties) is NOT indexed: this command is
 *    only for names and IDs, never for code search.
 *  - `types` must not be empty (an empty list answers nothing). `roots`:
 *    model roots search their model; an ordinary object searches its
 *    subtree. The server applies the user's access. At most 10,000 hits.
 *  - The answer is a stream of hits, then "END" (zero hits: only "END"). A
 *    hit carries the RID, the tree text, the type (a TypeKey object), the
 *    parent chain and a link flag; not the field that matched.
 *  - A server that does not know the class, or has another
 *    serialVersionUID, answers HTTP 200 with an error that names the class
 *    ("local class incompatible"), the stream intact.
 *
 * RIDs are Java longs: strings end to end here.
 *
 * Also here: the capability record per server profile and command (unknown,
 * supported, unsupported, suspended after repeated errors), reset when the
 * profile reconnects. Pure: no chrome.*, no transport.
 */

import { registerType, SC_SERIALIZABLE, type JavaClassDesc } from './java-serial';
import { registerBmpTypes } from './bmp-types';

export const SEARCH_COMMAND_CLASS = 'com.corporater.bmp.dto.command.SearchCommand';

/** A record (serialVersionUID 0). Java stream order: primitives first, then
 *  object fields, each group sorted by name. */
export const SEARCH_COMMAND: JavaClassDesc = {
  name: SEARCH_COMMAND_CLASS, uid: 0n, flags: SC_SERIALIZABLE,
  fields: [
    { name: 'exact', type: 'Z' }, { name: 'links', type: 'Z' }, { name: 'normal', type: 'Z' },
    { name: 'fields', type: 'L', className: 'Ljava/util/Set;' },
    { name: 'roots', type: 'L', className: 'Ljava/util/Set;' },
    { name: 'searchFor', type: 'L', className: 'Ljava/lang/String;' },
    { name: 'types', type: 'L', className: 'Ljava/util/Set;' },
  ],
  parent: null,
};

let registered = false;
/** Idempotent: bmp-types first (Long, HashSet, Rid, TypeKey …), then the
 *  command. */
export function registerSearchCommand(): void {
  if (registered) return;
  registerBmpTypes();
  registerType({ desc: SEARCH_COMMAND });
  registered = true;
}

/** SearchCommand's hard cap on hits. */
export const SEARCH_CAP = 10_000;
export const SEARCH_END = 'END';

const RID_TEXT = /^-?\d{1,20}$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

/** A RID as a Java long, range-checked. Never through a JS number. */
export function ridLong(rid: string): bigint {
  if (!RID_TEXT.test(rid)) throw new Error(`Not a RID: ${rid}`);
  const n = BigInt(rid);
  if (n > 9223372036854775807n || n < -9223372036854775808n) throw new Error(`RID out of range: ${rid}`);
  return n;
}

const hashSet = (elements: unknown[]) => ({
  $type: 'java.util.HashSet', $elements: elements, $size: elements.length,
  $capacity: Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, elements.length) / 0.75 + 1))), $loadFactor: 0.75,
});

export interface SearchCommandOptions {
  searchFor: string;
  roots: readonly string[];
  types: readonly string[];
  fields: readonly string[];
  exact?: boolean;
  normal?: boolean;
  links?: boolean;
}

/** One SearchCommand. Type and field names are checked; RIDs travel as
 *  boxed longs built from their text. */
export function makeSearchCommand(o: SearchCommandOptions): Record<string, unknown> {
  if (!o.types.length) throw new Error('SearchCommand needs at least one type');
  if (!o.roots.length) throw new Error('SearchCommand needs at least one root');
  for (const t of o.types) if (!TYPE_NAME.test(t)) throw new Error(`Not a type name: ${t}`);
  for (const f of o.fields) if (!FIELD_NAME.test(f)) throw new Error(`Not a field name: ${f}`);
  return {
    $type: SEARCH_COMMAND_CLASS,
    exact: o.exact ?? false, links: o.links ?? true, normal: o.normal ?? true,
    fields: hashSet([...new Set(o.fields)]),
    roots: hashSet([...new Set(o.roots)].map(rid => ({ $type: 'java.lang.Long', value: ridLong(rid) }))),
    searchFor: o.searchFor,
    types: hashSet([...new Set(o.types)]),
  };
}

// ── answer ──────────────────────────────────────────────────────

interface Obj { $class?: string; [k: string]: unknown }
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

function ridText(v: unknown): string | null {
  if (typeof v === 'string' && RID_TEXT.test(v)) return v;
  if (typeof v === 'bigint') return String(v);
  if (isObj(v)) {
    for (const k of ['identifier', 'value'] as const) {
      const x = v[k];
      if (typeof x === 'bigint') return String(x);
      if (typeof x === 'string' && RID_TEXT.test(x)) return x;
    }
  }
  return null;
}

/** A TypeKey as the reader gives it: `{ $class: …TypeKey, typeId }`, a
 *  plain string, or an enum-like `{ name }`. */
function typeKeyText(v: unknown): string {
  if (typeof v === 'string') return TYPE_NAME.test(v) ? v : '';
  if (!isObj(v)) return '';
  if (typeof v.typeId === 'string') return v.typeId;
  if (typeof v.name === 'string' && TYPE_NAME.test(v.name) && !('rid' in v)) return v.name;
  return '';
}

/** The type of a hit: its `type` field, else the one TypeKey among its own
 *  fields (the field's name is not part of the contract the probe saw). */
function hitType(obj: Obj): string {
  const direct = typeKeyText(obj.type);
  if (direct) return direct;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'parents' || k === 'rid' || !isObj(v)) continue;
    if (String(v.$class ?? '').endsWith('.TypeKey') && typeof v.typeId === 'string') return v.typeId;
  }
  return '';
}

const listItems = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObj(v) && Array.isArray(v.$elements) ? v.$elements : []);

export interface SearchHit {
  rid: string;
  /** The type, '' when the answer did not carry it. */
  type: string;
  /** The tree text: the name, or "id name" for types whose tree shows the ID. */
  text: string;
  /** The business ID, when the hit carries it. */
  businessId?: string;
  link: boolean;
  /** Parents, nearest first, as the server listed them. */
  parents: Array<{ rid: string; type: string; text: string }>;
}

export type SearchAnswer =
  | { ok: true; hits: SearchHit[]; complete: boolean }
  | { ok: false; message: string; stackTrace?: string };

/** A SearchCommand stream. `complete` is false when "END" never came. A
 *  ServerExceptionResponse (or a thrown exception object) is the failure. */
export function decodeSearchStream(objects: readonly unknown[]): SearchAnswer {
  const hits: SearchHit[] = [];
  for (const obj of objects) {
    if (obj === SEARCH_END) return { ok: true, hits, complete: true };
    if (!isObj(obj)) continue;
    const cls = String(obj.$class ?? '');
    if (/ExceptionResponse$|Exception$|Error$/.test(cls)) {
      const message = String(obj.message ?? obj.detailMessage ?? cls);
      return { ok: false, message, ...(typeof obj.stackTrace === 'string' ? { stackTrace: obj.stackTrace } : {}) };
    }
    const rid = ridText(obj.rid);
    if (!rid) continue;
    const parents = listItems(obj.parents).flatMap(p => {
      const r = isObj(p) ? ridText(p.rid) : null;
      return r && isObj(p) ? [{ rid: r, type: hitType(p), text: typeof p.text === 'string' ? p.text : '' }] : [];
    });
    const id = typeof obj.id === 'string' ? obj.id : typeof obj.businessId === 'string' ? obj.businessId : undefined;
    hits.push({
      rid, type: hitType(obj), text: typeof obj.text === 'string' ? obj.text : '', link: obj.link === true || obj.isLink === true, parents,
      ...(id !== undefined && id !== '-1' ? { businessId: id } : {}),
    });
  }
  return { ok: true, hits, complete: false };
}

/** The stream of `count` SearchCommands sent in one post: each answer ends
 *  with its own "END", in command order. A failure object fails the command
 *  it stands in and every later one (a post that failed as a whole holds one
 *  ServerExceptionResponse); a stream cut short leaves the rest incomplete. */
export function decodeSearchStreams(objects: readonly unknown[], count: number): SearchAnswer[] {
  const out: SearchAnswer[] = [];
  let part: unknown[] = [];
  for (const obj of objects) {
    if (out.length >= count) break;
    part.push(obj);
    if (obj === SEARCH_END) { out.push(decodeSearchStream(part)); part = []; continue; }
    if (isObj(obj) && /ExceptionResponse$|Exception$|Error$/.test(String(obj.$class ?? ''))) {
      const failed = decodeSearchStream(part);
      while (out.length < count) out.push(failed);
      return out;
    }
  }
  if (out.length < count) out.push(decodeSearchStream(part));
  while (out.length < count) out.push({ ok: true, hits: [], complete: false });
  return out;
}

/** What a failed answer means for the command, not for one search:
 *  `unsupported` when the server does not know the class or speaks another
 *  form of it, `failed` otherwise. */
export function classifySearchFailure(message: string, stackTrace = ''): 'unsupported' | 'failed' {
  const text = `${message}\n${stackTrace}`;
  if (/local class incompatible/i.test(text)) return 'unsupported';
  if (/ClassNotFoundException/.test(text) && text.includes('SearchCommand')) return 'unsupported';
  // The servlet reports only the root cause's message: for an unknown class
  // that is the bare class name.
  if (message.trim() === SEARCH_COMMAND_CLASS) return 'unsupported';
  return 'failed';
}

// ── capability record ───────────────────────────────────────────

export type CommandSupport = 'unknown' | 'supported' | 'unsupported' | 'suspended';
/** `identity`: the TreeItemCommand read of the hits' IDs (counted only; it
 *  gates nothing). `feed`: the change feed (tree-events.ts, code-feed.ts). */
export type CapabilityCommand = 'search' | 'identity' | 'feed';

/** Failures in a row (anything but a recognisable unknown or incompatible
 *  class) that suspend a command. */
export const SUSPEND_AFTER = 2;
/** A suspended command gets one trial query after this long. */
export const SUSPEND_RETRY_MS = 5 * 60_000;

interface CapabilityEntry { support: CommandSupport; failures: number; detail?: string; since?: number }

/**
 * Which built-in commands a server profile speaks, learnt from real use.
 * Keyed by server profile; a new connection of the profile (another
 * session) starts from `unknown` again. `unsupported` lasts for the
 * connection; `suspended` lifts by itself: SUSPEND_RETRY_MS after it was
 * set, one query may try the command again (an answer makes it supported,
 * a failure suspends it again for as long).
 */
export class CommandCapabilities {
  private readonly profiles = new Map<string, { session: string; commands: Map<CapabilityCommand, CapabilityEntry> }>();

  /** The record of `profile` for this connection (`session`); a different
   *  session than last time resets it. */
  private of(profile: string, session: string) {
    let p = this.profiles.get(profile);
    if (!p || p.session !== session) { p = { session, commands: new Map() }; this.profiles.set(profile, p); }
    return p;
  }

  get(profile: string, session: string, command: CapabilityCommand): CommandSupport {
    return this.of(profile, session).commands.get(command)?.support ?? 'unknown';
  }

  /** May the command be tried now? A suspended one is let through once
   *  per SUSPEND_RETRY_MS (the trial). */
  usable(profile: string, session: string, command: CapabilityCommand, now = Date.now()): boolean {
    const e = this.of(profile, session).commands.get(command);
    const s = e?.support ?? 'unknown';
    if (s === 'unknown' || s === 'supported') return true;
    if (s === 'suspended' && e && now - (e.since ?? 0) >= SUSPEND_RETRY_MS) {
      e.since = now; // one trial; queries meanwhile use the fallback
      return true;
    }
    return false;
  }

  /** Failures counted for a command (consecutive, reset by an answer). */
  failures(profile: string, session: string, command: CapabilityCommand): number {
    return this.of(profile, session).commands.get(command)?.failures ?? 0;
  }

  record(profile: string, session: string, command: CapabilityCommand, outcome: 'answered' | 'unsupported' | 'failed', detail?: string, now = Date.now()): CommandSupport {
    const cmds = this.of(profile, session).commands;
    const e = cmds.get(command) ?? { support: 'unknown' as CommandSupport, failures: 0 };
    if (outcome === 'answered') { e.support = 'supported'; e.failures = 0; delete e.detail; delete e.since; }
    else if (outcome === 'unsupported') { e.support = 'unsupported'; e.detail = detail; }
    else {
      e.failures++;
      e.detail = detail;
      if (e.failures >= SUSPEND_AFTER) { e.support = 'suspended'; e.since = now; }
    }
    cmds.set(command, e);
    return e.support;
  }

  /** Forget a profile (deleted, local data cleared), or every profile. */
  clear(profile?: string): void {
    if (profile == null) this.profiles.clear(); else this.profiles.delete(profile);
  }
}
