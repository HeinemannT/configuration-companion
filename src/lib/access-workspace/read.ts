import type { BmpClient } from '../bmp-client';
import { ecString, validateEcIdentifier, validateRid } from '../ec-guards';
import { emptyModel, type AccessSnapshot, type AccessChoice, type AccessProperty, type AccessRecord } from './model';
import { readTypeFields } from './requests';
import { pMap } from '../util';
import { CE_ROOT_SECTIONS } from '../ec-grammar';
import { completedValue } from './response';
import { appendRowEc, splitFramedRows } from '../ec-parser';
import { constantScript, SCRIPT_LIMITS, varyingScript } from '../script-kinds';

export interface ReadContext { signal?: AbortSignal; progress?: (message: string) => void; }
/** Exact server text is needed only for write preconditions. Do not duplicate
 * every policy's JSON in tab messages, drafts, history and persisted receipts. */
export const rawPolicyText = new WeakMap<AccessRecord, string>();

export const literal = ecString;
/** Rows in the length-framed encoding of ec-parser: constant markers (the
 *  same question is the same script on the server), and multiline policy
 *  JSON, labels with pipes or text that contains a marker still come back
 *  unchanged. */
const ROW_START = '"~CREV_ACCESS_ROW~"';
export function frame() {
  const widths = new Set<number>();
  return {
    // Assemble fields once. Large catalogues calculate rows then join one chunk;
    // small nested lists can append rows without copying the buffer per field.
    row: (expressions: string[], append = true) => {
      const fields = expressions[0] === ROW_START ? expressions.slice(1) : expressions;
      widths.add(fields.length);
      const exprs = fields.map(e => e.startsWith('"') || e.startsWith('output(') ? e : `${e}.whenMissing("")`);
      return ['_row := ""', ...appendRowEc('_row', exprs), ...(append ? ['_out := _out + _row'] : [])].join('\n');
    },
    parse: (value: string) => {
      if (!value) return [];
      let rows: string[][];
      try { rows = splitFramedRows(value); } catch { throw new Error('BMP returned an incomplete row.'); }
      for (const fields of rows) if (widths.size && !widths.has(fields.length)) throw new Error('BMP returned an incomplete row.');
      return rows;
    },
    start: ROW_START,
  };
}
/** How a read's script is kept on the server (script-kinds.ts): `constant`
 *  (no question in the text; `builder` names it) or `varying` (a search
 *  text in the text: at most 1,200 characters). `objectRid`: the object the
 *  script reaches as `this.object` (the command's context). */
export interface ReadKind { kind: 'constant' | 'varying'; builder: string; objectRid?: string }
const UNNAMED: ReadKind = { kind: 'varying', builder: 'access read' };

const MARKER = 'ACCESS_COMPLETE_';
function wrap(code: string, how: ReadKind): string {
  // Constant: the body's length is checked exactly, and the last marker is
  // followed only by digits, so stored text cannot end the body early.
  const lines = code.split('\n'), last = lines.pop()!;
  // str(): text joined with a value that holds HTML tags (an object named `a <b>c</b>`) is no longer
  // plain text on the server, and `.size()` then fails ("Method size can only be on a list, text or map").
  const wrapped = [...lines, '_accessResult := str(' + last + ')',`${literal(MARKER)} + _accessResult + ${literal(MARKER)} + str(_accessResult.size())`].join('\n');
  return how.kind === 'constant' ? constantScript(how.builder, wrapped) : varyingScript(how.builder, wrapped);
}
function unwrap(value: string): string {
  const end = value.lastIndexOf(MARKER), body = value.slice(MARKER.length, end);
  if (!value.startsWith(MARKER) || end < MARKER.length || value.slice(end + MARKER.length) !== String(body.length)) throw new Error('BMP returned an incomplete configuration.');
  return body;
}
export async function readEc(client: BmpClient, code: string, signal?: AbortSignal, how: ReadKind = UNNAMED): Promise<string> {
  signal?.throwIfAborted();
  const wrapped = wrap(code, how);
  const value = completedValue(how.objectRid
    ? await client.executeEcOn(wrapped, validateRid(how.objectRid), signal, 120_000)
    : await client.executeEc(wrapped, undefined, false, signal, 120_000));
  return unwrap(value);
}

/** One constant script for each of `rids` (each the command's context),
 *  answers in the order of `rids`. A failed answer throws. */
export async function readEcEach(client: BmpClient, code: string, rids: readonly string[], how: Omit<ReadKind, 'objectRid'>, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const wrapped = wrap(code, how);
  const answers = await client.executeEcEach(wrapped, rids.map(validateRid), signal, 120_000);
  return rids.map(rid => unwrap(completedValue(answers.get(rid) ?? { ok: false, error: 'No answer' })));
}
export const ACCESS_PAGE_SIZE = 250;

/** Fix the RID inventory first, then fetch bounded pages. A removed RID fails the
 * load instead of silently shifting an offset and dropping a different record. */
export async function readAccess(client: BmpClient, environment: string, name: string, context: ReadContext = {}): Promise<AccessSnapshot> {
  context.progress?.('Reading access inventory…');
  const f = frame();
  const row = (kind: string, expr: string[]) => f.row([f.start, literal(kind), ...expr]);
  const code = ['_out := ""', row('roots', ['root.role.rid', 'root.accessPolicy.rid']),
    ...[['roles', 'root.role.descendants'], ['policies', 'root.accessPolicy.descendants'],
      ['principals', 'root.user.descendants.filter(className = "User" AND roles.size() > 0).union(root.group.descendants.filter(className = "Group" AND roles.size() > 0))']].flatMap(([kind, source]) => [
      `_nodes := ${source}`, row(kind + 'Ids', ['_nodes.as(rid).join(",")']),
    ]),
    'root.classConfig.children().forEach(_n:', row('class', ['_n.id', '_n.name']),
    row('subtypes', ['_n.id', '_n.configuredType.subTypes.as(simpleName).join(",")']), ')', '_out'].join('\n');
  const rows = f.parse(await readEc(client, code, context.signal, { kind: 'constant', builder: 'readAccess inventory' }));
  const pages: Array<{ kind: string; ids: string[]; offset: number }> = [];
  for (const kind of ['roles', 'policies', 'principals']) {
    const inventory = rows.find(r => r[0] === kind + 'Ids');
    if (!inventory) throw new Error('BMP returned an incomplete access inventory.');
    const ids = inventory[1] ? inventory[1].split(',').map(validateRid) : [];
    if (ids.length > 100_000 || new Set(ids).size !== ids.length) throw new Error('Access inventory is too large or contains duplicate records.');
    for (let offset = 0; offset < ids.length; offset += ACCESS_PAGE_SIZE) pages.push({ kind, ids: ids.slice(offset, offset + ACCESS_PAGE_SIZE), offset });
  }
  let completed = 0;
  // One transport stream per client: do not queue pages ahead of cancellation.
  const chunks = await pMap(pages, async page => {
    context.signal?.throwIfAborted();
    const rows = await readAccessPage(client, page.kind, page.ids, context.signal, page.offset);
    context.progress?.(`Loading access records · ${++completed} of ${pages.length} pages`);
    return rows;
  }, 1);
  rows.push(...chunks.flat());
  const snapshot: AccessSnapshot = { environment, name, loadedAt: new Date().toISOString(), roots: { roles: '', policies: '' }, model: emptyModel(), classes: {}, users: [], groups: [] };
  for (const [kind, rid, id, name, parent, type, value, content, source] of rows) {
    if (kind.endsWith('Ids')) continue;
    if (kind === 'roots') { snapshot.roots = { roles: rid, policies: id }; continue; }
    if (kind === 'class') { snapshot.classes[rid.split('.').at(-1)!] = []; continue; }
    if (kind === 'subtypes') { (snapshot.typeChildren ??= {})[rid.split('.').at(-1)!] = id ? id.split(',') : []; continue; }
    if (!/^\d+$/.test(rid)) throw new Error('Invalid object identifier in BMP response.');
    if (kind === 'user' || kind === 'group') snapshot[kind === 'user' ? 'users' : 'groups'].push({ rid, id, name, type });
    else if (kind === 'global') snapshot.model.globals.push({ rid: `global:${rid}:${parent}`, id: '', name: '', parent, mode: type, subject: rid, subjectId: id, subjectName: name });
    else if (kind === 'role') snapshot.model.roles.push({ rid, id, name, parent: parent === snapshot.roots.roles ? '' : parent });
    else if (kind === 'scope') snapshot.model.scope.push({ rid, id, name, parent, kind: type, referenceConfig: value, field: content?.split('.').at(-1) ?? '', source: source?.split('.').at(-1) ?? '' });
    else if (kind === 'folder' && type === 'Category') snapshot.model.folders.push({ rid, id, name, parent: parent === snapshot.roots.policies ? '' : parent });
    else if (kind === 'policy') {
      let parsed: Record<string, unknown> = {}; let invalidContent: string | undefined;
      try { parsed = JSON.parse(content); if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.Statement) || parsed.Statement.some(s => !s || typeof s !== 'object' || Array.isArray(s))) throw new Error(); } catch { parsed = {}; invalidContent = content; }
      const policy = { rid, id, name, parent: parent === snapshot.roots.policies ? '' : parent, enabled: value === 'true', valid: source === 'true', content: parsed, ...(invalidContent !== undefined ? { invalidContent } : {}) };
      rawPolicyText.set(policy, content);
      snapshot.model.policies.push(policy);
    }
  }
  if (!snapshot.roots.roles || !snapshot.roots.policies) throw new Error('BMP access roots are unavailable.');
  return snapshot;
}
/** The collection the inventory listed for `kind`, in its order. */
const INVENTORY_SOURCE: Readonly<Record<string, string>> = {
  roles: 'root.role.descendants',
  policies: 'root.accessPolicy.descendants',
  principals: 'root.user.descendants.filter(className = "User" AND roles.size() > 0).union(root.group.descendants.filter(className = "Group" AND roles.size() > 0))',
};

/** One page of the inventory's records, with no RID in the text: by its
 *  position in the same collection the inventory listed (`offset`; one
 *  constant script per kind and page), or, for RIDs of no page (new
 *  members during apply), one constant script per record with the record
 *  as the command's context. The rows must be exactly `ids`, in any order:
 *  a record added or removed meanwhile fails the load. */
async function readAccessPage(client: BmpClient, kind: string, ids: string[], signal?: AbortSignal, offset?: number): Promise<string[][]> {
  const f = frame();
  const row = (type: string, expr: string[]) => f.row([f.start, literal(type), ...expr], false);
  const identity = ['_n.rid', '_n.id', '_n.name', '_n.parent.rid', '_n.className'];
  const body = kind === 'roles' ? [
    'IF _n.className = "Role" THEN', row('role', identity), 'ELSE',
    row('scope', [...identity, '_n.referenceConfig.rid', '_n.referenceConfig.id', '_n.referenceConfig.parent.id']), 'ENDIF', '_row',
  ] : kind === 'policies' ? [
    'IF _n.className = "AccessPolicy" THEN', row('policy', [...identity, '_n.enabled', 'output(_n.contentAsString)', '_n.valid']),
    'ELSE', row('folder', identity), 'ENDIF', '_row',
  ] : [
    'IF _n.className != "User" AND _n.className != "Group" THEN', ' error("Principal no longer exists")', 'ENDIF',
    'IF _n.className = "User" THEN', row('user', [...identity, '_n.roles.size()']), 'ELSE', row('group', [...identity, '_n.roles.size()']), 'ENDIF', '_principal := _row',
    '_memberships := _n.roles.calculate(', '_role := self',
    row('global', ['_n.rid', '_n.id', '_n.name', '_role.rid', '_n.className']), '_row', ')', '_principal + _memberships.join("")',
  ];
  ids.forEach(validateRid);
  const each = (nodes: string) => [nodes,
    '_rows := _nodes.calculate(', '_n := self', 'IF _n = MISSING THEN', ' error("An access record was removed during loading. Reload from BMP.")', 'ENDIF',
    ...body, ')', '_rows.join("")'].join('\n');
  let rows: string[][];
  if (offset != null && INVENTORY_SOURCE[kind] && Number.isInteger(offset) && offset >= 0) {
    // Positions offset … offset + ACCESS_PAGE_SIZE - 1 of the collection.
    const code = each(`_all := ${INVENTORY_SOURCE[kind]}\n_nodes := LIST()\n_i := 0\n_all.forEach(_x:\n IF _i >= ${offset} AND _i < ${offset + ACCESS_PAGE_SIZE} THEN\n  _nodes := _nodes.union(LIST(_x))\n ENDIF\n _i := _i + 1\n)`);
    rows = f.parse(await readEc(client, code, signal, { kind: 'constant', builder: `readAccessPage ${kind}` }));
  } else {
    const code = each('_nodes := LIST(this.object)');
    rows = (await readEcEach(client, code, ids, { kind: 'constant', builder: `readAccessRecord ${kind}` }, signal)).flatMap(value => f.parse(value));
  }
  const primary = rows.filter(r => r[0] !== 'global'), returned = new Set(primary.map(r => r[1]));
  if (primary.length !== ids.length || returned.size !== ids.length || ids.some(id => !returned.has(id))) throw new Error('BMP returned an incomplete access page. Reload from BMP.');
  if (kind === 'principals') for (const principal of primary) {
    const memberships = rows.filter(r => r[0] === 'global' && r[1] === principal[1]);
    if (String(memberships.length) !== principal[6] || new Set(memberships.map(r => r[4])).size !== memberships.length) throw new Error('BMP returned incomplete memberships.');
  }
  return rows;
}

/** The directory is searched on demand; users without global roles never inflate boot. */
export async function searchAccessPrincipals(client: BmpClient, query: string, kind: 'User' | 'Group', signal?: AbortSignal) {
  if (!['User', 'Group'].includes(kind)) throw new Error('Choose users or groups.');
  if (query.length > 200) throw new Error('Search is limited to 200 characters.');
  const f = frame(), q = query.trim();
  // The query is bound once (`_q`, `_qw`): the varying script stays small.
  const matches = !q ? 'true' : '(id = _qw OR name = _qw)';
  const code = [`_q := ${literal(q)}`, '_qw := "*" + _q + "*"', `_nodes := root.${kind.toLowerCase()}.descendants.filter(className = ${literal(kind)})`,
    '_exact := _nodes.filter(id = _q).first(81)', `_matches := _nodes.filter(id != _q AND (${matches})).first(81)`,
    '_matches := _exact.union(_matches).first(81)', '_rows := _matches.calculate(', '_n := self',
    f.row([f.start, '_n.rid', '_n.id', '_n.name', '_n.className'], false), '_row', ')', '_rows.join("")'].join('\n');
  const choices = f.parse(await readEc(client, code, signal, { kind: 'varying', builder: 'searchAccessPrincipals' })).map(([rid, id, name, type]) => ({ rid: validateRid(rid), id, name, type }));
  return { choices: choices.slice(0, 80), hasMore: choices.length > 80 };
}

/** Resolve only new membership subjects during apply, independently of picker state. */
export async function readAccessPrincipals(client: BmpClient, ids: string[]): Promise<{ choices: AccessChoice[]; memberships: AccessRecord[] }> {
  if (!ids.length) return { choices: [], memberships: [] };
  const unique = [...new Set(ids)], pages: string[][] = [];
  for (let i = 0; i < unique.length; i += ACCESS_PAGE_SIZE) pages.push(unique.slice(i, i + ACCESS_PAGE_SIZE));
  const rows = (await pMap(pages, page => readAccessPage(client, 'principals', page), 1)).flat();
  return {
    choices: rows.filter(r => r[0] === 'user' || r[0] === 'group').map(([, rid, id, name, , type]) => ({ rid, id, name, type })),
    memberships: rows.filter(r => r[0] === 'global').map(([, rid, id, name, parent, type]) => ({ rid: `global:${rid}:${parent}`, id: '', name: '', parent, mode: type, subject: rid, subjectId: id, subjectName: name })),
  };
}
export async function readSchema(client: BmpClient, type: string, signal?: AbortSignal): Promise<AccessProperty[]> {
  validateEcIdentifier(type);
  const f = frame(); const row = (kind: string, expr: string[]) => f.row([f.start, literal(kind), ...expr], false);
  const code = [`_cls := c.get(${type}.name)`, '_properties := _cls.children().calculate(', '_p := self',
    ' _a := _p.linkedTo.id.whenMissing(_p.id)', ' _targets := ""',
    ' IF _p.className = "ReferenceMethodConfig" THEN', '  _targets := str(_p.types)', ' ENDIF',
    row('property', ['_p.rid', '_a', '_p.name', '_p.className', '_p.systemobject', '_targets']),
    '_property := _row',
    ' _set := MISSING',
    ' IF _p.className = "ListMethodConfig" OR _p.className = "HistoricalListMethodConfig" THEN', '  _set := _p.listPropertySet', ' ENDIF',
    ' IF _p.className = "TagMethodConfig" THEN', '  _set := _p.tagList', ' ENDIF',
    ' IF _set != MISSING THEN', row('set', ['_p.rid', '_set.rid', '_set.id', '_set.name']), '_property := _property + _row',
    ' ENDIF', '_property', ')', '_properties.join("")'].join('\n');
  // One constant script per type (a small, fixed set).
  const [nativeFields, log] = await Promise.all([readTypeFields(client, type, signal), readEc(client, code, signal, { kind: 'constant', builder: 'readSchema' })]);
  const properties = new Map<string, AccessProperty>();
  for (const [kind, rid, a, b, c, d, e] of f.parse(log)) {
    if (kind === 'property') properties.set(rid, { rid, accessor: a.split('.').at(-1)!, label: b || a, configClass: c, system: d === 'true', targets: e });
    else if (kind === 'set') properties.get(rid)!.listSet = { rid: a, id: b, name: c, partial: true, items: [] };
  }
  const fields = new Map(nativeFields.flatMap(f => [f.businessId, f.id, f.id.split('.').at(-1)!].map(key => [key, f] as const)));
  return [...properties.values()].map(p => {
    const field = fields.get(p.accessor);
    const targets = p.targets?.replace(/[[\]]/g, '').split(/[,\s]+/).filter(Boolean) ?? [];
    if (!targets.length) targets.push(...field?.targets ?? []);
    const allowed = p.configClass === 'SystemMethodConfig' ? ['User', 'Group', 'Principal'] : ['User', 'Group'];
    return { ...p, reference: field?.reference === true, multiselect: field?.multiselect === true, targets: '[' + targets.join(', ') + ']', principal: field?.reference === true && targets.length > 0 && targets.every(t => allowed.includes(t.split('.').at(-1)!)) };
  });
}
export const ROOTS = ['organisation', 'templateCategory', ...CE_ROOT_SECTIONS];
/** The RIDs of the access roots that exist on the server, read once per
 *  client with one constant script. */
const accessRootRids = new WeakMap<BmpClient, Promise<Map<string, string>>>();
function rootRidsOf(client: BmpClient, signal?: AbortSignal): Promise<Map<string, string>> {
  let p = accessRootRids.get(client);
  if (!p) {
    p = (async () => {
      const f = frame();
      const code = ['_out := ""', ...ROOTS.map(r => f.row([f.start, literal(r), `root.${r}.rid`])), '_out'].join('\n');
      const rows = f.parse(await readEc(client, code, signal, { kind: 'constant', builder: 'access roots' }));
      return new Map(rows.filter(([, rid]) => /^\d{1,20}$/.test(rid ?? '')).map(([r, rid]) => [r, rid] as [string, string]));
    })();
    accessRootRids.set(client, p);
    p.catch(() => accessRootRids.delete(client));
  }
  return p;
}

/** Rows a root answers per pass at first; a root that fills them while the
 *  80 are not reached is asked again with ten times as many. */
const ACCESS_SEARCH_CAP = 120;
const ACCESS_RESULTS = 80;

/**
 * The object search of the Access workspace. The query is text, so the
 * script varies: it binds the query once and filters ONE root, the root
 * being the command's context (the same script for every root). Which
 * classes may be chosen is decided here from each row's class, so the
 * script stays small; the first 80 in root order, exact matches first, are
 * the same objects the one script with every root and class in its text
 * gave.
 */
export async function searchAccessObjects(client: BmpClient, query: string, type?: string, prototypes = false, signal?: AbortSignal, containers = false, containerFor?: string): Promise<AccessChoice[]> {
  if (query.length > 200) throw new Error('Search is limited to 200 characters.');
  query = query.trim();
  if (type) validateEcIdentifier(type);
  if (containerFor) validateEcIdentifier(containerFor);
  const f = frame();
  const source = prototypes ? ['defaults'] : type && type !== 'Organisation' && type !== 'Scorecard' && type !== 'Category' ? ROOTS.filter(r => r.toLowerCase() === type.toLowerCase()) : type === 'Organisation' ? ['organisation'] : type === 'Scorecard' ? ['templateCategory', 'organisation'] : ROOTS;
  const orderedSource = containers && containerFor ? [...source].sort((a,b) => Number(b.toLowerCase() === containerFor.toLowerCase()) - Number(a.toLowerCase() === containerFor.toLowerCase())) : source;
  const q = '_q';
  const matches = (expr: string) => !query.trim() ? 'true' : /[*?{}]/.test(query) ? `${expr}.indexOf(${q}).whenMissing(-1) >= 0` : `${expr} = _qw`;
  const classes = new Set([...(containers ? ['Category', 'OrganisationRoot', 'ScorecardRoot'] : []), 'Organisation', 'Scorecard', ...ROOTS.filter(r => r.startsWith('ce')).map(r => 'C' + r.slice(1))]);
  const eligible = (className: string, rid: string, rootRid: string) => (prototypes ? className !== 'Category' : classes.has(className)) || (containers && rid === rootRid);
  const exact = `id = ${q} OR str(rid) = ${q}`;
  const passes = query ? [exact, `(id != ${q} AND str(rid) != ${q}) AND (${matches('id.whenMissing("")')} OR ${matches('name.whenMissing("")')})`] : ['true'];
  // The query is written once; the passes are one list (the exact matches,
  // then the others: they never overlap), so the row is written once.
  const filtered = (predicate: string, cap: number) => `_d.filter(${type ? `className = ${literal(type)} AND ` : ''}(${predicate})).first(${cap})`;
  // Rows are calculated per object and joined once: appending each row to one growing text copies
  // that text per row (ec-parser.ts).
  const script = (cap: number) => [`_q := ${literal(query)}`, '_qw := "*" + _q + "*"',
    `_d := ${containers ? 'LIST(this.object).union(this.object.descendants)' : 'this.object.descendants'}`,
    `_m := ${passes.map(p => filtered(p, cap)).join('.union(')}${')'.repeat(passes.length - 1)}`,
    // Which pass a row is from, by the server's own comparison.
    '_rs := _m.calculate(', '_n := self', ...(query ? ['_pt := (IF _n.id = _q OR str(_n.rid) = _q THEN "0" ELSE "1" ENDIF)'] : []),
    f.row([f.start, query ? '_pt' : '"0"', '_n.rid', '_n.id', '_n.name', '_n.className', '_n.parent.name'], false), '_row', ')',
    '_rs.join("")'].join('\n');
  const rids = await rootRidsOf(client, signal);
  const roots = orderedSource.filter(r => rids.has(r)).map(r => rids.get(r)!);
  type Row = { pass: number; rid: string; id: string; name: string; type: string; path: string };
  const answers = new Map<string, { rows: Row[]; cap: number }>();
  const ask = async (rootRids: readonly string[], cap: number) => {
    if (!rootRids.length) return;
    // One post: the same script for each root, each root the context.
    const values = await readEcEach(client, script(cap), rootRids, { kind: 'varying', builder: 'searchAccessObjects' }, signal);
    rootRids.forEach((rootRid, i) => answers.set(rootRid, { cap, rows: f.parse(values[i]).map(([pass, rid, id, name, type, path]) => ({ pass: Number(pass), rid, id, name, type, path })) }));
  };
  await ask(roots, ACCESS_SEARCH_CAP);
  for (;;) {
    const out: AccessChoice[] = [];
    let short: string | null = null;
    passes.forEach((_, pass) => {
      for (const rootRid of roots) {
        if (out.length >= ACCESS_RESULTS) return;
        const a = answers.get(rootRid)!;
        const rows = a.rows.filter(r => r.pass === pass);
        for (const r of rows) {
          if (out.length >= ACCESS_RESULTS) break;
          if (eligible(r.type, r.rid, rootRid)) out.push({ rid: r.rid, id: r.id, name: r.name, type: r.type, path: r.path });
        }
        // The root gave all it was asked for and the 80 are not reached:
        // its list may go on beyond the rows read.
        if (out.length < ACCESS_RESULTS && rows.length >= a.cap && short == null) short = rootRid;
      }
    });
    if (short == null || answers.get(short)!.cap >= ACCESS_SEARCH_CAP * 100) return out;
    await ask([short], answers.get(short)!.cap * 10);
  }
}

/** The list items and the selected tokens of a list property set: small
 *  varying scripts (the query, a group of tokens) with the set as the
 *  command's context. */
export async function searchListItems(client: BmpClient, set: string, query: string, signal?: AbortSignal, selected: string[] = []) {
  validateRid(set);
  if (query.length > 200) throw new Error('Search is limited to 200 characters.');
  if (selected.length > 100 || selected.some(token => typeof token !== 'string' || token.length > 600)) throw new Error('Resolve at most 100 selected list values at once.');
  const f = frame(), q = query.trim();
  const head = ['_set := this.object', 'IF _set.className != "ListPropertySet" THEN', ' error("The property list no longer exists")', 'ENDIF', '_nodes := _set.children()'];
  const match = q ? '(id = _qw OR name = _qw OR className + ":" + id = _q)' : 'true';
  const matchCode = [`_q := ${literal(q)}`, '_qw := "*" + _q + "*"', ...head,
    '_exact := _nodes.filter(id = _q OR className + ":" + id = _q).first(81)',
    `_matches := _exact.union(_nodes.filter(${match})).first(81)`, '_rows := _matches.calculate(', '_i := self',
    f.row([f.start, literal('match'), '_i.rid', '_i.id', '_i.name', '_i.className'], false), '_row', ')', '_rows.join("")'].join('\n');
  const rows = f.parse(await readEc(client, matchCode, signal, { kind: 'varying', builder: 'searchListItems', objectRid: set }));
  const selectedCode = (tokens: readonly string[]) => [...head, `_tokens := LIST(${tokens.map(literal).join(', ')})`,
    '_selected := _nodes.filter(_tokens CONTAINS (className + ":" + id) OR _tokens CONTAINS str(rid)).calculate(', '_i := self',
    f.row([f.start, literal('selected'), '_i.rid', '_i.id', '_i.name', '_i.className'], false), '_row', ')', '_selected.join("")'].join('\n');
  // Tokens in groups whose script stays within the varying limit.
  const groups: string[][] = [];
  for (const token of selected) {
    const last = groups.at(-1);
    if (last && selectedCode([...last, token]).length + 200 <= SCRIPT_LIMITS.varying) last.push(token); else groups.push([token]);
  }
  for (const g of groups) rows.push(...f.parse(await readEc(client, selectedCode(g), signal, { kind: 'varying', builder: 'searchListItems selected', objectRid: set })));
  const seen = new Set<string>();
  const choices = (kind: string) => rows.filter(row => row[0] === kind && !seen.has(`${kind}:${row[1]}`) && !!seen.add(`${kind}:${row[1]}`)).map(([, rid, id, name, type]) => ({ rid: validateRid(rid), id, name, type, token: `${type}:${id}` }));
  const matches = choices('match');
  return { choices: matches.slice(0, 80), hasMore: matches.length > 80, selected: choices('selected') };
}
