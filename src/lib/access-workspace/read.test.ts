import { expect, it, vi } from 'vitest';
import type { BmpClient } from '../bmp-client';
import { readResult } from './test-response';
import { ACCESS_PAGE_SIZE, readAccess, readEc, readSchema, searchAccessPrincipals, searchListItems, searchAccessObjects } from './read';

const framed = (code: string, rows: string[][]) => {
  const delimiter = code.match(/CREV_ACCESS_[a-f0-9]+_/)![0];
  return rows.map(row => delimiter + 'ROW' + delimiter + row.join(delimiter) + delimiter + 'END' + delimiter).join('');
};
it('includes the native creation root and searches the selected child type first, without broadening ordinary object searches', async () => {
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, [['9223372036854775806','CECOMMENT','Enterprise comments','CeCommentRoot','']])));
  const client = { executeEc } as unknown as BmpClient;
  const rows = await searchAccessObjects(client, 'comment', undefined, false, undefined, true, 'CeComment');
  expect(rows[0].rid).toBe('9223372036854775806');
  const createCode = executeEc.mock.calls[0][0];
  expect(createCode.indexOf('LIST(root.ceComment)')).toBeLessThan(createCode.indexOf('LIST(root.organisation)'));
  expect(createCode).toContain('OR rid = root.ceComment.rid');
  await searchAccessObjects(client, 'comment');
  expect(executeEc.mock.calls[1][0]).not.toContain('OR rid = root.ceComment.rid');
  expect(executeEc.mock.calls[1][0]).not.toContain('LIST(root.ceComment)');
});
it('loads every record through bounded pages, including 20,000 global users and long RIDs', async () => {
  const roles = Array.from({ length: 800 }, (_, i) => String(9000000000000000000n + BigInt(i)));
  const policies = Array.from({ length: 3200 }, (_, i) => String(8000000000000000000n + BigInt(i)));
  const users = Array.from({ length: 20_000 }, (_, i) => String(7000000000000000000n + BigInt(i)));
  const roleSet = new Set(roles), policySet = new Set(policies);
  let active = 0, peak = 0;
  const executeEc = vi.fn(async (code: string) => {
    if (code.includes('"rolesIds"')) {
      expect(code).toContain('roles.size() > 0');
      return readResult(code, framed(code, [['roots', '1', '2'], ['rolesIds', roles.join(',')], ['policiesIds', policies.join(',')], ['principalsIds', users.join(',')]]));
    }
    active++; peak = Math.max(peak, active);
    const ids = [...code.matchAll(/lookup\((\d+)\)/g)].map(m => m[1]);
    expect(ids.length).toBeLessThanOrEqual(ACCESS_PAGE_SIZE);
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
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, code.includes('"rolesIds"')
    ? [['roots', '1', '2'], ['rolesIds', ''], ['policiesIds', ''], ['principalsIds', '3']]
    : [['user', '3', 'user', 'User', '', 'User', '1']])));
  await expect(readAccess({ executeEc } as unknown as BmpClient, 'test', 'Test')).rejects.toThrow('incomplete memberships');
});
it('stops dispatching pages after cancellation', async () => {
  const controller = new AbortController();
  const ids = Array.from({ length: 501 }, (_, i) => String(i + 3));
  const executeEc = vi.fn(async (code: string) => {
    if (code.includes('"rolesIds"')) return readResult(code, framed(code, [['roots', '1', '2'], ['rolesIds', ids.join(',')], ['policiesIds', ''], ['principalsIds', '']]));
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
  executeEc.mockImplementation(async code => {
    expect(code).toContain('_set := lookup(5)'); expect(code).toContain('.first(81)');
    return readResult(code, framed(code, Array.from({ length: 81 }, (_, i) => ['match', String(i + 10), 'status' + i, 'Status', 'ListPropertySetItem'])));
  });
  const result = await searchListItems(client, '5', 'status');
  expect(result.hasMore).toBe(true); expect(result.choices).toHaveLength(80);
  expect(result.choices[0].token).toBe('ListPropertySetItem:status0');
});
it('rejects incomplete pages rather than silently dropping deleted records', async () => {
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, code.includes('"rolesIds"')
    ? [['roots', '1', '2'], ['rolesIds', '3,4'], ['policiesIds', ''], ['principalsIds', '']]
    : [['role', '3', 'reader', 'Reader', '1', 'Role']])));
  await expect(readAccess({ executeEc } as unknown as BmpClient, 'test', 'Test')).rejects.toThrow('incomplete access page');
});
it('bounds principal results and gives exact IDs a separate first pass without duplicates', async () => {
  const executeEc = vi.fn(async (code: string) => {
    expect(code).toContain('_exact := _nodes.filter(id = "user19999").first(81)');
    expect(code).toContain('id != "user19999" AND');
    return readResult(code, framed(code, Array.from({ length: 81 }, (_, i) => [String(7000000000000000000n + BigInt(i)), i === 0 ? 'user19999' : 'match' + i, 'Person', 'User'])));
  });
  const result = await searchAccessPrincipals({ executeEc } as unknown as BmpClient, ' user19999 ', 'User');
  expect(result.choices).toHaveLength(80); expect(result.hasMore).toBe(true);
  expect(result.choices[0].id).toBe('user19999');
});
