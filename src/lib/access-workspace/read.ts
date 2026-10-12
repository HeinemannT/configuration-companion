import type { BmpClient } from '../bmp-client';
import { formatEcLiteral, validateEcIdentifier, validateRid } from '../ec-guards';
import { emptyModel, type AccessSnapshot, type AccessChoice, type AccessProperty, type AccessRecord } from './model';
import { readTypeFields } from './requests';
import { pMap } from '../util';
import { completedValue } from './response';

export interface ReadContext { signal?: AbortSignal; progress?: (message: string) => void; }
/** Exact server text is needed only for write preconditions. Do not duplicate
 * every policy's JSON in tab messages, drafts, history and persisted receipts. */
export const rawPolicyText = new WeakMap<AccessRecord, string>();

export const literal = (s: string): string => '"' + formatEcLiteral(s) + '"';
/** Random framing also preserves multiline policy JSON and labels containing pipes. */
export function frame() {
  const delimiter = 'CREV_ACCESS_' + crypto.randomUUID().replaceAll('-', '') + '_';
  const widths = new Set<number>();
  return {
    delimiter,
    // Assemble fields once. Large catalogues calculate rows then join one chunk;
    // small nested lists can append rows without copying the buffer per field.
    row: (expressions: string[], append = true) => {
      widths.add(expressions.length - 1);
      return '_row := ' + expressions.map(e => e.startsWith('"') || e.startsWith('output(') ? e : `str(${e}.whenMissing(""))`).join(' + ' + literal(delimiter) + ' + ') + ' + ' + literal(delimiter + 'END' + delimiter) + (append ? '\n_out := _out + _row' : '');
    },
    parse: (value: string) => {
      if (!value) return [];
      const start = delimiter + 'ROW' + delimiter, end = delimiter + 'END' + delimiter;
      if (!value.endsWith(end)) throw new Error('BMP returned an incomplete row.');
      return value.slice(0, -end.length).split(end).map(row => {
        if (!row.startsWith(start)) throw new Error('BMP returned an invalid row.');
        const fields = row.slice(start.length).split(delimiter);
        if (widths.size && !widths.has(fields.length)) throw new Error('BMP returned an incomplete row.');
        return fields;
      });
    },
    start: literal(delimiter + 'ROW'),
  };
}
export async function readEc(client: BmpClient, code: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const marker = 'ACCESS_COMPLETE_' + crypto.randomUUID().replaceAll('-', '') + '_';
  const lines = code.split('\n'), last = lines.pop()!;
  const wrapped = [...lines, '_accessResult := ' + last, `${literal(marker)} + _accessResult + ${literal(marker)} + str(_accessResult.size())`].join('\n');
  const value = completedValue(await client.executeEc(wrapped, undefined, false, signal, 120_000));
  const end = value.lastIndexOf(marker), body = value.slice(marker.length, end);
  if (!value.startsWith(marker) || end < marker.length || value.slice(end + marker.length) !== String(body.length)) throw new Error('BMP returned an incomplete configuration.');
  return body;
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
  const rows = f.parse(await readEc(client, code, context.signal));
  const pages: Array<{ kind: string; ids: string[] }> = [];
  for (const kind of ['roles', 'policies', 'principals']) {
    const inventory = rows.find(r => r[0] === kind + 'Ids');
    if (!inventory) throw new Error('BMP returned an incomplete access inventory.');
    const ids = inventory[1] ? inventory[1].split(',').map(validateRid) : [];
    if (ids.length > 100_000 || new Set(ids).size !== ids.length) throw new Error('Access inventory is too large or contains duplicate records.');
    for (let offset = 0; offset < ids.length; offset += ACCESS_PAGE_SIZE) pages.push({ kind, ids: ids.slice(offset, offset + ACCESS_PAGE_SIZE) });
  }
  let completed = 0;
  // One transport stream per client: do not queue pages ahead of cancellation.
  const chunks = await pMap(pages, async page => {
    context.signal?.throwIfAborted();
    const rows = await readAccessPage(client, page.kind, page.ids, context.signal);
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
async function readAccessPage(client: BmpClient, kind: string, ids: string[], signal?: AbortSignal): Promise<string[][]> {
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
  const code = [`_nodes := LIST(${ids.map(id => 'lookup(' + validateRid(id) + ')').join(', ')})`,
    '_rows := _nodes.calculate(', '_n := self', 'IF _n = MISSING THEN', ' error("An access record was removed during loading. Reload from BMP.")', 'ENDIF',
    ...body, ')', '_rows.join("")'].join('\n');
  const rows = f.parse(await readEc(client, code, signal));
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
  const matches = !q ? 'true' : `(id = ${literal('*' + q + '*')} OR name = ${literal('*' + q + '*')})`;
  const code = [`_nodes := root.${kind.toLowerCase()}.descendants.filter(className = ${literal(kind)})`,
    `_exact := _nodes.filter(id = ${literal(q)}).first(81)`, `_matches := _nodes.filter(id != ${literal(q)} AND (${matches})).first(81)`,
    '_matches := _exact.union(_matches).first(81)', '_rows := _matches.calculate(', '_n := self',
    f.row([f.start, '_n.rid', '_n.id', '_n.name', '_n.className'], false), '_row', ')', '_rows.join("")'].join('\n');
  const choices = f.parse(await readEc(client, code, signal)).map(([rid, id, name, type]) => ({ rid: validateRid(rid), id, name, type }));
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
  const [nativeFields, log] = await Promise.all([readTypeFields(client, type, signal), readEc(client, code, signal)]);
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
export const ROOTS = ['organisation', 'templateCategory', 'ceRiskAssessment', 'ceControlMeasure', 'ceIssue', 'ceIncident', 'ceTask', 'ceAsset', 'ceVendor', 'ceIndicator', 'cePolicy', 'ceProject', 'ceContract', 'ceQuestionnaire', 'ceRegulation', 'ceWorkflow', 'cePrivacy', 'ceProcedure', 'ceService', 'ceProduct', 'ceComplianceRequirement', 'ceInquiry', 'ceDPIA', 'ceComment', 'ceAttachment', 'ceDistribution', 'ceAssuranceActivity', 'ceTIA', 'cePreScreening'];
export async function searchAccessObjects(client: BmpClient, query: string, type?: string, prototypes = false, signal?: AbortSignal, containers = false, containerFor?: string): Promise<AccessChoice[]> {
  if (query.length > 200) throw new Error('Search is limited to 200 characters.');
  query = query.trim();
  if (type) validateEcIdentifier(type);
  if (containerFor) validateEcIdentifier(containerFor);
  const f = frame();
  const source = prototypes ? ['defaults'] : type && type !== 'Organisation' && type !== 'Scorecard' && type !== 'Category' ? ROOTS.filter(r => r.toLowerCase() === type.toLowerCase()) : type === 'Organisation' ? ['organisation'] : type === 'Scorecard' ? ['templateCategory', 'organisation'] : ROOTS;
  const orderedSource = containers && containerFor ? [...source].sort((a,b) => Number(b.toLowerCase() === containerFor.toLowerCase()) - Number(a.toLowerCase() === containerFor.toLowerCase())) : source;
  const q = literal(query);
  const matches = (expr: string) => !query.trim() ? 'true' : /[*?{}]/.test(query) ? `${expr}.indexOf(${q}).whenMissing(-1) >= 0` : `${expr} = ${literal('*' + query + '*')}`;
  const eligible = prototypes ? 'className != "Category"' : [...(containers ? ['Category', 'OrganisationRoot', 'ScorecardRoot'] : []), 'Organisation', 'Scorecard', ...ROOTS.filter(r => r.startsWith('ce')).map(r => 'C' + r.slice(1))].map(t => `className = ${literal(t)}`).join(' OR ');
  const exact = `id = ${q} OR str(rid) = ${q}`;
  const passes = query ? [exact, `(id != ${q} AND str(rid) != ${q}) AND (${matches('id.whenMissing("")')} OR ${matches('name.whenMissing("")')})`] : ['true'];
  const code = ['_out := ""', '_count := 0', ...passes.flatMap(predicate => orderedSource.flatMap(root => [
    'IF _count < 80 THEN',
    ` _matches := ${containers ? `LIST(root.${root}).union(root.${root}.descendants)` : `root.${root}.descendants`}.filter(${type ? `className = ${literal(type)} AND ` : ''}(${eligible}${containers ? ` OR rid = root.${root}.rid` : ''}) AND (${predicate}))`,
    ' _matches := _matches.first(80 - _count)',
    ' _matches.forEach(_n:',
    f.row([f.start, '_n.rid', '_n.id', '_n.name', '_n.className', '_n.parent.name']), '  _count := _count + 1', ' )', 'ENDIF',
  ])), '_out'].join('\n');
  return f.parse(await readEc(client, code, signal)).map(([rid, id, name, type, path]) => ({ rid, id, name, type, path }));
}

/** Fetch only the opened list and a bounded search page, including exact tokens. */
export async function searchListItems(client: BmpClient, set: string, query: string, signal?: AbortSignal, selected: string[] = []) {
  validateRid(set);
  if (query.length > 200) throw new Error('Search is limited to 200 characters.');
  if (selected.length > 100 || selected.some(token => typeof token !== 'string' || token.length > 600)) throw new Error('Resolve at most 100 selected list values at once.');
  const f = frame(), q = query.trim();
  const match = q ? `(id = ${literal('*' + q + '*')} OR name = ${literal('*' + q + '*')} OR className + ":" + id = ${literal(q)})` : 'true';
  const code = [`_set := lookup(${set})`, 'IF _set.className != "ListPropertySet" THEN', ' error("The property list no longer exists")', 'ENDIF',
    '_nodes := _set.children()', `_exact := _nodes.filter(id = ${literal(q)} OR className + ":" + id = ${literal(q)}).first(81)`,
    `_matches := _exact.union(_nodes.filter(${match})).first(81)`, '_rows := _matches.calculate(', '_i := self',
    f.row([f.start, literal('match'), '_i.rid', '_i.id', '_i.name', '_i.className'], false), '_row', ')',
    `_tokens := LIST(${selected.map(literal).join(', ')})`, '_selected := _nodes.filter(_tokens CONTAINS (className + ":" + id) OR _tokens CONTAINS str(rid)).calculate(', '_i := self',
    f.row([f.start, literal('selected'), '_i.rid', '_i.id', '_i.name', '_i.className'], false), '_row', ')', '_rows.join("") + _selected.join("")'].join('\n');
  const rows = f.parse(await readEc(client, code, signal));
  const choices = (kind: string) => rows.filter(row => row[0] === kind).map(([, rid, id, name, type]) => ({ rid: validateRid(rid), id, name, type, token: `${type}:${id}` }));
  const matches = choices('match');
  return { choices: matches.slice(0, 80), hasMore: matches.length > 80, selected: choices('selected') };
}
