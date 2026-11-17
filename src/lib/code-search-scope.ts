/**
 * Code search "under an object": the objects the object window shows as that
 * object's structure, as one light listing (no full object reads).
 *
 *  - the object and its tree descendants;
 *  - the reference its type's structure rule follows (object-window-table
 *    `structure.via`: an InputView's input set, an ActionButton's action
 *    object, a CreateObjectView's edit page) with what is under it;
 *  - the references the type table follows below a node (`follow`: a
 *    ButtonInput of type action → its action object) with what is under it.
 *
 * One read-only EC post lists every one of them with its type and the length
 * of its code (read with `output(…)`, ec-code-safety). Only objects with code
 * are kept. The same list is the scope of the index mode, the live scan and
 * "Used in code".
 */

import { appendRowEc, chunkByScriptSize, EC_CHUNK, EC_DONE_LITERAL, flushChunkEc, parseFramedLog, type EcFrame } from './ec-parser';
import { isCodeProperty } from './ec-code-safety';
import { validateEcIdentifier } from './ec-guards';
import { scriptOn } from './script-kinds';
import { codeTypes, propsOf, STATIC_CODE_PROPS, type CodePropMap } from './code-index-sync';
import { followRule, TYPES } from './object-window-table';

const RID = /^-?\d{1,20}$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

/** The property each follow rule tests (`follow.when` in the type table):
 *  the listing sends its text so followRule can decide here. */
const FOLLOW_TEST_PROP: Readonly<Record<string, string>> = { ButtonInput: 'buttonType' };

/** Types that follow a reference below them (`follow` in the type table). A
 *  rule whose tested property is not known here is not followed. */
export function followTypes(): Array<{ type: string; via: string; test: string }> {
  return Object.entries(TYPES)
    .filter(([type, t]) => t.follow && FOLLOW_TEST_PROP[type])
    .map(([type, t]) => ({ type, via: t.follow!.via, test: FOLLOW_TEST_PROP[type] }));
}

/** The reference the structure rule of `type` follows from the root, if any. */
export function structureVia(type: string): string | undefined {
  return TYPES[type]?.structure?.via;
}

function checkVia(via: string): void {
  validateEcIdentifier(via);
  // A reference, never a code property: `_o.expression` would run it.
  if (isCodeProperty(via)) throw new Error(`Not a reference: ${via}`);
}

/** `_len` := the code length of `v` (a known type), counted on the server. */
function lengthLines(v: string, type: string, map: CodePropMap, indent: string): string[] {
  const lines = [`${indent}_len := 0`];
  for (const p of propsOf(type, map)) {
    if (!PROP_NAME.test(p)) throw new Error(`Invalid property ${p}`);
    lines.push(
      `${indent}_v_${p} := output(${v}.${p})`,
      `${indent}_w_${p} := _v_${p}.whenMissing("")`,
      `${indent}_len := _len + _w_${p}.size()`,
    );
  }
  return lines;
}

/** One framed row: kind, rid, parent, type, value. */
function row(indent: string, kind: string, rid: string, parent: string, type: string, value: string): string[] {
  return appendRowEc(EC_CHUNK, [`"${kind}"`, rid, parent, type, value], indent);
}

/** The value of an object row: its code length, `@`, its stamp (the code
 *  search reads an object again only when they change). */
function lenStamp(v: string): string {
  return `str(_len) + "@" + str(${v}.lastModifiedDate.whenMissing(""))`;
}

/** Lines that write `v` itself (its type read on the server) as a `kind` row. */
function selfLines(v: string, kind: string, parent: string, types: readonly string[], map: CodePropMap, frame: EcFrame, indent: string): string[] {
  const lines = [`${indent}_cls := str(${v}.className.whenMissing(""))`, `${indent}_len := 0`];
  for (const t of types) {
    lines.push(`${indent}IF _cls = "${t}" THEN`, ...lengthLines(v, t, map, `${indent}     `), `${indent}ENDIF`);
  }
  lines.push(...row(indent, kind, `${v}.rid`, parent, '_cls', lenStamp(v)));
  return lines;
}

/** Lines that write every object of a code type under `v` as a `kind` row. */
function descendantLines(v: string, listVar: string, loopVar: string, kind: string, parent: string, types: readonly string[], map: CodePropMap, frame: EcFrame, indent: string): string[] {
  const lines: string[] = [];
  for (const t of types) {
    lines.push(
      `${indent}${listVar} := SELECT ${t} FROM ${v}`,
      `${indent}${listVar}.forEach(${loopVar}:`,
      ...lengthLines(loopVar, t, map, `${indent}     `),
      ...row(`${indent}     `, kind, `${loopVar}.rid`, parent, `"${t}"`, lenStamp(loopVar)),
      `${indent}     _k := _k + 1`,
      `${indent}     IF _k >= 40 THEN`,
      ...flushChunkEc().map(l => `${indent}          ${l}`),
      `${indent}          _k := 0`,
      `${indent}     ENDIF`,
      `${indent})`,
    );
  }
  return lines;
}

/**
 * The listing EC. `ref` is the scope object's EC reference (built from a
 * validated RID), `rootType` its type (decides the structure rule).
 *
 * Rows (kind, rid, parent, type, value):
 *  - `O`: an object of the scope with its code length (`parent` = the start
 *    it was found under, empty for the scope object itself);
 *  - `S`: the reference of the structure rule itself (parent = the object);
 *  - `B`: a node that may follow a reference (`type` = its follow-rule type,
 *    `value` = the text of the property the rule tests, e.g. the button type);
 *  - `F`: an object reached through such a node (`parent` = that node).
 */
export function buildCodeScopeEc(ref: string, rootType: string, frame: EcFrame, map: CodePropMap = STATIC_CODE_PROPS, only?: readonly string[]): string {
  const types = (only ?? codeTypes(map)).filter(t => TYPE_NAME.test(t));
  const via = structureVia(rootType);
  const follows = followTypes();
  // The scope object is the only part that changes: its line comes first.
  const lines = [`_o := ${ref}`, '_r := ""', `${EC_CHUNK} := ""`, '_k := 0'];
  lines.push(...selfLines('_o', 'O', '""', types, map, frame, ''));
  const starts: string[] = ['_o'];
  if (via) {
    checkVia(via);
    lines.push(`_s := _o.${via}`, 'IF _s != MISSING THEN', ...selfLines('_s', 'S', 'str(_o.rid)', types, map, frame, '     '), 'ENDIF');
    starts.push('_s');
  }
  for (const start of starts) {
    const body: string[] = [];
    body.push(...descendantLines(start, '_ld', '_d', 'O', `str(${start}.rid)`, types, map, frame, '     '));
    for (const f of follows) {
      if (!TYPE_NAME.test(f.type)) throw new Error(`Invalid type ${f.type}`);
      checkVia(f.via);
      if (!PROP_NAME.test(f.test) || isCodeProperty(f.test)) throw new Error(`Invalid property ${f.test}`);
      // The test of the follow rule runs here (followRule), on the text of
      // the value it looks at; the server only lists.
      body.push(
        `     _lb := SELECT ${f.type} FROM ${start}`,
        `     _lb.forEach(_b:`,
        ...row('          ', 'B', '_b.rid', '""', `"${f.type}"`, `output(_b.${f.test}.whenMissing(""))`),
        `          _a := _b.${f.via}`,
        '          IF _a != MISSING THEN',
        ...selfLines('_a', 'F', 'str(_b.rid)', types, map, frame, '               '),
        ...descendantLines('_a', '_le', '_e', 'F', 'str(_b.rid)', types, map, frame, '               '),
        '          ENDIF',
        '     )',
      );
    }
    if (start === '_o') lines.push(...body);
    else lines.push('IF _s != MISSING THEN', ...body, 'ENDIF');
  }
  // The server's time of the listing, for the stamps (code-scope-read settledStamp).
  lines.push(...row('', 'T', '""', '""', '""', 'this.end'), ...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  return scriptOn('buildCodeScopeEc', ref, lines.join('\n'));
}

/** The listing as small scripts (ec-parser SCRIPT_TARGET_CHARS), one per
 *  group of code types; their rows together are the rows of the one script
 *  (parseCodeScopeLog keeps each object once). */
export function buildCodeScopeEcs(ref: string, rootType: string, frame: EcFrame, map: CodePropMap = STATIC_CODE_PROPS): string[] {
  const types = codeTypes(map).filter(t => TYPE_NAME.test(t));
  return chunkByScriptSize(types, t => buildCodeScopeEc(ref, rootType, frame, map, t)).map(t => buildCodeScopeEc(ref, rootType, frame, map, t));
}

export interface CodeScopeItem {
  rid: string;
  type: string;
  /** Code length and stamp (`lastModifiedDate`) as listed. */
  len?: number;
  stamp?: string;
}

export interface CodeScope {
  /** Objects of the scope with code, each once, the scope object first. */
  items: CodeScopeItem[];
  /** What the scope covers, for the status line. */
  covered: { via?: { prop: string; found: boolean }; followed: number };
  /** The server's time of the listing (the stamps' format). */
  now?: string;
}

/** Parse the listing. Only objects with code are kept; an object reached
 *  through a node whose follow rule does not hold (a button that is not of
 *  type action) is left out, as in the object window. */
export function parseCodeScopeLog(log: string, frame: EcFrame, rootType: string): CodeScope {
  const rows = parseFramedLog(log, frame, 5);
  const follows = new Map<string, boolean>();
  for (const [kind, rid, , type, value] of rows) {
    const test = FOLLOW_TEST_PROP[type.trim()];
    if (kind !== 'B' || !RID.test(rid.trim()) || !test) continue;
    follows.set(rid.trim(), !!followRule({ rid: rid.trim(), type: type.trim(), name: '', businessId: '', props: { [test]: { kind: 'text', text: value.trim() } }, references: {}, overridden: [] }));
  }
  const items: CodeScopeItem[] = [];
  const seen = new Set<string>();
  const followed = new Set<string>();
  const via = structureVia(rootType);
  let viaFound = false;
  for (const [kind, ridRaw, parentRaw, typeRaw, lenRaw] of rows) {
    const rid = ridRaw.trim();
    const parent = parentRaw.trim();
    if (!RID.test(rid) || (kind !== 'O' && kind !== 'S' && kind !== 'F')) continue;
    if (kind === 'F') {
      if (!follows.get(parent)) continue;
      followed.add(parent);
    }
    if (kind === 'S') viaFound = true;
    const at = lenRaw.indexOf('@');
    const len = Number((at < 0 ? lenRaw : lenRaw.slice(0, at)).trim());
    if (!(len > 0) || seen.has(rid)) continue;
    seen.add(rid);
    items.push({ rid, type: typeRaw.trim(), len, ...(at >= 0 ? { stamp: lenRaw.slice(at + 1).trim() } : {}) });
  }
  const now = rows.find(r => r[0] === 'T')?.[4]?.trim();
  return { items, covered: { ...(via ? { via: { prop: via, found: viaFound } } : {}), followed: followed.size }, ...(now ? { now } : {}) };
}
