import { expect, it, vi } from 'vitest';
import type { BmpClient } from '../bmp-client';
import { readResult } from './test-response';
import { ACCESS_PAGE_SIZE, readAccess, readEc, readSchema, searchAccessPrincipals, searchListItems, searchAccessObjects } from './read';
import { framedText } from '../ec-parser';

const framed = (_code: string, rows: string[][]) => framedText(rows, false);
/** A client whose context reads (executeEcOn / executeEcEach) and plain
 *  reads are answered by `rows(code, rid)`. */
function contextClient(rows: (code: string, rid?: string) => string[][], extra: Record<string, unknown> = {}) {
  const calls: Array<{ code: string; rid?: string }> = [];
  const answer = (code: string, rid?: string) => { calls.push({ code, ...(rid ? { rid } : {}) }); return readResult(code, framed(code, rows(code, rid))); };
  const client = {
    executeEc: vi.fn(async (code: string) => answer(code)),
    executeEcOn: vi.fn(async (code: string, rid: string) => answer(code, rid)),
    executeEcEach: vi.fn(async (code: string, rids: readonly string[]) => new Map(rids.map(r => [r, answer(code, r)]))),
    ...extra,
  } as unknown as BmpClient;
  return { client, calls };
}
const ROOT_RIDS: Record<string, string> = { organisation: '101', ceComment: '9223372036854775806', templateCategory: '103' };
it('includes the native creation root and searches the selected child type first, without broadening ordinary object searches', async () => {
  const { client, calls } = contextClient((code, rid) => code.includes('root.organisation.rid') ? Object.entries(ROOT_RIDS).map(([r, id]) => [r, id])
    : rid === '9223372036854775806' ? [['0', '9223372036854775806','CECOMMENT','Enterprise comments','CeCommentRoot','']] : []);
  const rows = await searchAccessObjects(client, 'comment', undefined, false, undefined, true, 'CeComment');
  expect(rows[0].rid).toBe('9223372036854775806');
  // One script for every root, each root the command's context, the
  // selected child type's root first.
  const search = calls.filter(c => c.rid);
  expect(search.map(c => c.rid)).toEqual(['9223372036854775806', '101', '103']);
  expect(new Set(search.map(c => c.code)).size).toBe(1);
  expect(search[0].code).toContain('LIST(this.object).union(this.object.descendants)');
  expect(search[0].code).not.toContain('root.ceComment');
  calls.length = 0;
  await searchAccessObjects(client, 'comment');
  expect(calls.filter(c => c.rid)[0].code).not.toContain('LIST(this.object)');
});
it('chooses only eligible classes, the root itself only when containers are asked for, exact matches first, 80 at most', async () => {
  const rows = (pass: string, n: number, cls = 'CeIssue') => Array.from({ length: n }, (_, i) => [pass, String(5000 + i + (pass === '0' ? 0 : 1000)), `id${i}`, `Name ${i}`, cls, 'Parent']);
  const { client } = contextClient((code, rid) => code.includes('root.organisation.rid') ? [['organisation', '101'], ['ceIssue', '104']]
    : rid === '101' ? [['1', '101', 'org', 'Org root', 'OrganisationRoot', ''], ['1', '7', 'k', 'KPI', 'Kpi', 'P'], ...rows('1', 30, 'Organisation')]
    : rows('0', 2).concat(rows('1', 70)));
  const found = await searchAccessObjects(client, 'name');
  expect(found).toHaveLength(80);
  // Pass 1 of every root (the exact ones), then pass 2; no KPI, no root.
  expect(found.slice(0, 2).map(r => r.id)).toEqual(['id0', 'id1']);
  expect(found.some(r => r.type === 'Kpi' || r.type === 'OrganisationRoot')).toBe(false);
  expect(found[2].type).toBe('Organisation');
});
it('loads every record through bounded pages, including 20,000 global users and long RIDs', async () => {
  const roles = Array.from({ length: 800 }, (_, i) => String(9000000000000000000n + BigInt(i)));
  const policies = Array.from({ length: 3200 }, (_, i) => String(8000000000000000000n + BigInt(i)));
  const users = Array.from({ length: 20_000 }, (_, i) => String(7000000000000000000n + BigInt(i)));
  const roleSet = new Set(roles), policySet = new Set(policies);
  let active = 0, peak = 0;
  const executeEc = vi.fn(async (code: string) => {
    if (code.includes('rolesIds')) {
      expect(code).toContain('roles.size() > 0');
      return readResult(code, framed(code, [['roots', '1', '2'], ['rolesIds', roles.join(',')], ['policiesIds', policies.join(',')], ['principalsIds', users.join(',')]]));
    }
    active++; peak = Math.max(peak, active);
    // A page by its position in the inventory's own collection: no RID in the text.
    expect(code).not.toMatch(/lookup\(/);
    const [, from, to] = /_i >= (\d+) AND _i < (\d+)/.exec(code)!.map(Number);
    expect(to - from).toBe(ACCESS_PAGE_SIZE);
    const all = code.includes('root.role.descendants\n') ? roles : code.includes('root.accessPolicy.descendants\n') ? policies : users;
    const ids = all.slice(from, to);
    const rows = ids.flatMap(id => roleSet.has(id) ? [['role', id, 'r' + id, 'Role', '1', 'Role']]
      : policySet.has(id) ? [['policy', id, 'p' + id, 'Policy', '2', 'AccessPolicy', 'true', '{"Statement":[]}', 'true']]
      : [['user', id, 'u' + id, 'User', '', 'User', '1'], ['global', id, 'u' + id, 'User', roles[0], 'User']]);
    await new Promise(resolve => setTimeout(resolve, 0)); active--;
    return readResult(code, framed(code, rows));
  });
  const result = await readAccess({ executeEc } as unknown as BmpClient, 'test', 'Test');
  expect(result.model.roles).toHaveLength(800); expect(result.model.policies).toHaveLength(3200);
  expect(result.model.globals).toHaveLength(20_000); expect(result.users.at(-1)?.rid).toBe(users.at(-1));
  expect(peak).toBe(1); expect(executeEc).toHaveBeenCalledTimes(1 + 4 + 13 + 80);
});
it('rejects empty, truncated and spoofed log results instead of caching partial reads', async () => {
  for (const response of [{ ok: true, log: '' }, { ok: true, log: 'ACCESS_COMPLETE_fake' }]) {
    await expect(readEc({ executeEc: vi.fn().mockResolvedValue(response) } as unknown as BmpClient, '""')).rejects.toThrow('incomplete');
  }
  const executeEc = vi.fn(async (code: string) => {
    const result = readResult(code, 'content 🌍');
    result.outputEntries[0].message = result.outputEntries[0].message.slice(0, -1);
    return result;
  });
  await expect(readEc({ executeEc } as unknown as BmpClient, '""')).rejects.toThrow('incomplete');
});
it('rejects missing membership tails even when all principal rows are present', async () => {
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, code.includes('rolesIds')
    ? [['roots', '1', '2'], ['rolesIds', ''], ['policiesIds', ''], ['principalsIds', '3']]
    : [['user', '3', 'user', 'User', '', 'User', '1']])));
  await expect(readAccess({ executeEc } as unknown as BmpClient, 'test', 'Test')).rejects.toThrow('incomplete memberships');
});
it('stops dispatching pages after cancellation', async () => {
  const controller = new AbortController();
  const ids = Array.from({ length: 501 }, (_, i) => String(i + 3));
  const executeEc = vi.fn(async (code: string) => {
    if (code.includes('rolesIds')) return readResult(code, framed(code, [['roots', '1', '2'], ['rolesIds', ids.join(',')], ['policiesIds', ''], ['principalsIds', '']]));
    controller.abort();
    return readResult(code, framed(code, ids.slice(0, 250).map(id => ['role', id, 'r' + id, 'Role', '1', 'Role'])));
  });
  await expect(readAccess({ executeEc } as unknown as BmpClient, 'test', 'Test', { signal: controller.signal })).rejects.toThrow();
  expect(executeEc).toHaveBeenCalledTimes(2);
});
it('loads list metadata without enumerating items and searches only the opened set', async () => {
  const executeEc = vi.fn(async (code: string) => {
    expect(code).not.toContain('_set.children().calculate');
    return readResult(code, framed(code, [['property', '4', 'status', 'Status', 'ListMethodConfig', 'false', ''], ['set', '4', '5', 'statuses', 'Statuses']]));
  });
  const client = { executeEc, fetchTypeFields: vi.fn().mockResolvedValue([{ id: 'status', businessId: 'status', reference: false, targets: [] }]) } as unknown as BmpClient;
  expect((await readSchema(client, 'CeTask'))[0].listSet).toMatchObject({ rid: '5', partial: true, items: [] });
  const executeEcOn = vi.fn(async (code: string, rid: string) => {
    // The set is the command's context; the query is bound once.
    expect(rid).toBe('5'); expect(code).toContain('_set := this.object'); expect(code).toContain('.first(81)');
    expect(code).not.toContain('lookup(5)');
    return readResult(code, framed(code, Array.from({ length: 81 }, (_, i) => ['match', String(i + 10), 'status' + i, 'Status', 'ListPropertySetItem'])));
  });
  (client as unknown as { executeEcOn: typeof executeEcOn }).executeEcOn = executeEcOn;
  const result = await searchListItems(client, '5', 'status');
  expect(result.hasMore).toBe(true); expect(result.choices).toHaveLength(80);
  expect(result.choices[0].token).toBe('ListPropertySetItem:status0');
});
it('rejects incomplete pages rather than silently dropping deleted records', async () => {
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, code.includes('rolesIds')
    ? [['roots', '1', '2'], ['rolesIds', '3,4'], ['policiesIds', ''], ['principalsIds', '']]
    : [['role', '3', 'reader', 'Reader', '1', 'Role']])));
  await expect(readAccess({ executeEc } as unknown as BmpClient, 'test', 'Test')).rejects.toThrow('incomplete access page');
});
it('bounds principal results and gives exact IDs a separate first pass without duplicates', async () => {
  const executeEc = vi.fn(async (code: string) => {
    // The query is written once (`_q`), the passes refer to it.
    expect(code).toContain('_q := "user19999"');
    expect(code).toContain('_exact := _nodes.filter(id = _q).first(81)');
    expect(code).toContain('id != _q AND');
    return readResult(code, framed(code, Array.from({ length: 81 }, (_, i) => [String(7000000000000000000n + BigInt(i)), i === 0 ? 'user19999' : 'match' + i, 'Person', 'User'])));
  });
  const result = await searchAccessPrincipals({ executeEc } as unknown as BmpClient, ' user19999 ', 'User');
  expect(result.choices).toHaveLength(80); expect(result.hasMore).toBe(true);
  expect(result.choices[0].id).toBe('user19999');
});
it('builds the object search rows per object and joins them once, as plain text', async () => {
  const { client, calls } = contextClient(code => code.includes('root.organisation.rid') ? [['organisation', '101']] : []);
  await searchAccessObjects(client, '');
  const code = calls.find(c => c.rid)!.code;
  expect(code).toContain('_rs := _m.calculate(');
  expect(code).toContain('_accessResult := str(_rs.join(""))');
  expect(code).not.toContain('_out := _out +');
});
