/**
 * Every Extended Code script Companion sends is one of three kinds, and the
 * transport refuses a script over its kind's limit (BmpTransport):
 *
 *  - `constant`: the text does not change with the question (the object,
 *    the query, an ID or a date travel in the command's context, or not at
 *    all). It may vary only with a small, fixed choice such as the code
 *    properties of one type. The server parses it once per life and keeps
 *    one tree: up to 25,000 characters.
 *  - `varying`: the text holds the question (a search text, a business ID).
 *    Every new question is a new entry in the server's parse cache, which
 *    holds 2,000 entries counted by entry, not by size (about 40 bytes of
 *    heap per character, kept until a restart). At most 1,200 characters,
 *    so 2,000 of them stay under 100 MB.
 *  - `user`: code the user wrote or asked for (the editor's Preview and
 *    Execute, the assistant's queries) and every write. Its text is the
 *    user's; only the general 25,000-character limit applies.
 *
 * A builder says which kind it makes: `constantScript(name, text)` for a
 * constant builder, `varyingScript(name, text)` for a varying one and
 * `userScript(text)` for the user's own code. A script nobody marked counts
 * as varying (the strict limit), so a forgotten mark fails loudly in the
 * transport instead of filling the server's memory.
 *
 * A constant builder is checked at run time too: past
 * CONSTANT_TEXTS_PER_BUILDER distinct texts it no longer counts as
 * constant (its texts are refused when they are longer than a varying
 * script may be), and the Log says so once. The unit test
 * `ec-script-kinds.test.ts` calls every builder with two different inputs.
 */

import { scriptKey } from './load-governor';
import { log } from './logger';

export type ScriptKind = 'constant' | 'varying' | 'user';

export const SCRIPT_LIMITS: Readonly<Record<ScriptKind, number>> = Object.freeze({
  constant: 25_000,
  varying: 1_200,
  user: 25_000,
});

/** Distinct texts one constant builder may make (one per type or property
 *  set is the most any builder needs). */
export const CONSTANT_TEXTS_PER_BUILDER = 160;
const USER_TEXTS = 64;
const VARYING_NAMES = 512;

/** text key → constant builder */
const constantKeys = new Map<string, string>();
const constantPerBuilder = new Map<string, number>();
const overflowed = new Set<string>();
/** text key → builder, for the diagnostic of a refused varying script. */
const varyingNames = new Map<string, string>();
/** text keys of a constant builder's texts past its limit → builder. */
const overflowKeys = new Map<string, string>();
/** text keys of the user's own scripts, most recent last. */
const userKeys = new Map<string, true>();
/** > 0 while a builder is only measured (measureScript): nothing is marked. */
let measuring = 0;

/** Run `build` to measure the text it makes (chunkByScriptSize): the text
 *  is not sent, so it is not marked and does not count against its
 *  builder's distinct texts. */
export function measureScript<T>(build: () => T): T {
  measuring++;
  try { return build(); } finally { measuring--; }
}

/** Mark `text` as the output of the constant builder `builder`; returns it. */
export function constantScript(builder: string, text: string): string {
  if (measuring) return text;
  const { key } = scriptKey(text);
  if (constantKeys.has(key)) return text;
  const n = constantPerBuilder.get(builder) ?? 0;
  if (n >= CONSTANT_TEXTS_PER_BUILDER) {
    if (!overflowed.has(builder)) {
      overflowed.add(builder);
      log.warn('script:constant', `${builder} made more than ${CONSTANT_TEXTS_PER_BUILDER} distinct texts: its further texts count as varying`);
    }
    remember(varyingNames, key, builder, VARYING_NAMES);
    remember(overflowKeys, key, builder, VARYING_NAMES);
    return text;
  }
  constantPerBuilder.set(builder, n + 1);
  constantKeys.set(key, builder);
  return text;
}

/** Mark `text` as the output of the varying builder `builder`; returns it. */
export function varyingScript(builder: string, text: string): string {
  if (measuring) return text;
  const { key } = scriptKey(text);
  remember(varyingNames, key, builder, VARYING_NAMES);
  overflowKeys.delete(key);
  return text;
}

/** A builder that reaches its object through `ref`: constant when `ref` is
 *  the command's context object (`this.object`), varying otherwise (the
 *  object is in the text: the fallback for a client without the context
 *  path). */
export function scriptOn(builder: string, ref: string, text: string): string {
  return ref === 'this.object' ? constantScript(builder, text) : varyingScript(builder, text);
}

/** Mark `text` as the user's own code (or a write); returns it. */
export function userScript(text: string): string {
  if (measuring) return text;
  const { key } = scriptKey(text);
  userKeys.delete(key);
  userKeys.set(key, true);
  while (userKeys.size > USER_TEXTS) userKeys.delete(userKeys.keys().next().value!);
  return text;
}

function remember(map: Map<string, string>, key: string, value: string, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

export interface ScriptClass {
  kind: ScriptKind;
  /** The builder that made it, when it said. */
  builder?: string;
  key: string;
  chars: number;
  /** A constant builder's text past CONSTANT_TEXTS_PER_BUILDER (counted
   *  as varying). */
  overflow?: true;
}

/** The kind of a script the transport is about to send. A transactional
 *  command (a write) is the user's. */
export function classifyScript(text: string, transactional = false): ScriptClass {
  const k = scriptKey(text);
  const constant = constantKeys.get(k.key);
  if (constant) return { kind: 'constant', builder: constant, ...k };
  if (transactional || userKeys.has(k.key)) return { kind: 'user', ...k };
  const builder = varyingNames.get(k.key);
  return { kind: 'varying', ...(builder ? { builder } : {}), ...(overflowKeys.has(k.key) ? { overflow: true as const } : {}), ...k };
}

/** Why a script may not be sent (null: it may). */
export function scriptLimitProblem(c: ScriptClass): string | null {
  const limit = SCRIPT_LIMITS[c.kind];
  if (c.chars <= limit) return null;
  if (c.overflow) {
    return `Script not sent: ${c.builder ?? 'a builder'} made more than ${CONSTANT_TEXTS_PER_BUILDER} different scripts since the extension started, which a script that does not change with the question should never do, so this one (${c.chars} characters) was held back to protect the server's memory (a Companion bug; please report it).`;
  }
  const who = c.builder ? `${c.builder} (${c.kind})` : c.kind === 'varying' ? 'an unmarked script (counted as varying)' : `a ${c.kind} script`;
  return `Script not sent: ${who} has ${c.chars} characters, over Companion's limit of ${limit} for ${c.kind} scripts (a Companion bug; please report it).`;
}

/** Forget every mark (tests). */
export function resetScriptKinds(): void {
  constantKeys.clear();
  constantPerBuilder.clear();
  overflowed.clear();
  varyingNames.clear();
  overflowKeys.clear();
  userKeys.clear();
  measuring = 0;
}
