/**
 * The server's search command is safe on a large server
 * (object-name-command, handlers/object-search):
 *  - names are searched in the configuration roots only; a data root
 *    (organisation, risks, action plans, process management) is reached
 *    only by the exact business-ID lookup, in a post of its own, whatever
 *    the query ("risk" has four characters);
 *  - no other request shape can reach a data root (dataRootCommandSafe);
 *  - only the types the caller needs; a failed data lookup leaves the
 *    configuration search alone.
 */
import { describe, expect, it } from 'vitest';
import { commandNameSearch, dataRootCommandSafe, type NameCommandPort } from '../object-name-command';
import { CommandCapabilities, type SearchCommandOptions } from '../search-command';

const DATA = ['9'];
function port(sent: Array<{ commands: SearchCommandOptions[]; scope?: string }>, failData = false): NameCommandPort {
  return {
    profile: 'p', session: 's',
    scope: async () => ({ roots: ['1', '2'], models: ['config'], dataRoots: DATA, dataModels: ['data'], typeModels: { ExtendedTable: ['config', 'data'], Kpi: ['data'] } }),
    search: async (commands, _signal, scope) => {
      sent.push({ commands, scope });
      if (failData && scope === 'data') throw new Error('BMP timed out');
      return commands.map(() => ({ ok: true as const, hits: [], complete: true }));
    },
    identities: async () => new Map(),
  };
}

describe('the search command on a large server', () => {
  it('never searches a data root by name: only the exact ID lookup, in its own post', async () => {
    const queries = ['risk', 'ab', 'a b c', 'kpi_1', 'Risk register', 'org.north', 'x'.repeat(30)];
    for (const q of queries) {
      for (const opts of [{}, { dataExact: true }, { dataExact: true, config: false }]) {
        const sent: Array<{ commands: SearchCommandOptions[]; scope?: string }> = [];
        await commandNameSearch(port(sent), new CommandCapabilities(), q, ['ExtendedTable', 'Kpi'], new AbortController().signal, opts);
        for (const p of sent) {
          for (const c of p.commands) {
            if (!c.roots.includes('9')) { expect(c.roots).toEqual(['1', '2']); continue; }
            expect(p.scope).toBe('data');
            expect(c).toMatchObject({ exact: true, fields: ['id'], roots: DATA, searchFor: q });
            expect(q).toMatch(/^[A-Za-z0-9_.:-]+$/);
          }
        }
      }
    }
    // Any other shape over a data root is refused.
    const base = { searchFor: 'risk', roots: ['9'], types: ['Kpi'] };
    expect(dataRootCommandSafe([{ ...base, fields: ['name'] }], DATA)).toBe(false);
    expect(dataRootCommandSafe([{ ...base, fields: ['id'] }], DATA)).toBe(false);
    expect(dataRootCommandSafe([{ ...base, fields: ['id', 'name'], exact: true }], DATA)).toBe(false);
    expect(dataRootCommandSafe([{ ...base, searchFor: 'a b', fields: ['id'], exact: true }], DATA)).toBe(false);
    expect(dataRootCommandSafe([{ ...base, fields: ['id'], exact: true }], DATA)).toBe(true);
    expect(dataRootCommandSafe([{ ...base, roots: ['1'], fields: ['name'] }], DATA)).toBe(true);
  });

  it('only the types the caller needs; a failed data lookup leaves the configuration search', async () => {
    const sent: Array<{ commands: SearchCommandOptions[]; scope?: string }> = [];
    const r = await commandNameSearch(port(sent, true), new CommandCapabilities(), 'risk', ['ExtendedTable', 'Kpi'], new AbortController().signal, { dataExact: true });
    expect(r).not.toBeNull();
    const config = sent.find(p => p.scope === 'config')!;
    expect(config.commands.map(c => c.types)).toEqual([['ExtendedTable'], ['ExtendedTable']]);
    expect(sent.find(p => p.scope === 'data')!.commands[0].types).toEqual(['ExtendedTable', 'Kpi']);
  });
});
