/**
 * Deleting a server profile and "Reset all" (local-data.ts): what each
 * removes and what must survive, one seeded key per stored key family, with
 * fake extension storage and a fake IndexedDB. The source scan at the end
 * fails when a key the code writes is missing from STORED_KEYS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mockChromeStorage } from './chrome-mock';
import { NOT_STORAGE_KEYS, STORED_KEYS, storedKeyFor, LAUNCH_CONTEXT_MAX_AGE_MS } from '../local-data';

const NOW = Date.now();
const ENV1 = 'p1@https://a.test';
const ENV2 = 'p2@https://b.test';

type After = 'removed' | 'kept' | 'rewritten';
interface Seed { area: 'local' | 'session'; key: string; value: unknown; afterDelete: After; afterReset: 'removed' | 'kept'; kept?: unknown }

/** One row per stored key family; profile-scoped families get a p1 row (the
 *  deleted profile) and a p2 row (which must survive). */
const SEEDS: Seed[] = [
  { area: 'local', key: 'crev_settings', value: { profiles: [] }, afterDelete: 'kept', afterReset: 'kept' },
  { area: 'local', key: 'crev_settings_backup', value: { profiles: [] }, afterDelete: 'kept', afterReset: 'kept' },
  ...['cache', 'cache_date', 'history', 'script_history'].flatMap((s): Seed[] => [
    { area: 'local', key: `crev_p1_${s}`, value: [1], afterDelete: 'removed', afterReset: 'removed' },
    { area: 'local', key: `crev_p2_${s}`, value: [2], afterDelete: 'kept', afterReset: 'removed' },
  ]),
  ...['favorites', 'style_presets'].flatMap((s): Seed[] => [
    { area: 'local', key: `crev_p1_${s}`, value: [1], afterDelete: 'removed', afterReset: 'kept' },
    { area: 'local', key: `crev_p2_${s}`, value: [2], afterDelete: 'kept', afterReset: 'kept' },
  ]),
  { area: 'local', key: 'crev_object_cache', value: {}, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: 'crev_inspect_active', value: true, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: 'crev_activity', value: { entries: [] }, afterDelete: 'kept', afterReset: 'removed' },
  ...['crev_objectview_ctx_', 'crev_editor_ctx_', 'crev_cvo_studio_ctx_'].flatMap((prefix): Seed[] => [
    { area: 'local', key: `${prefix}1000001`, value: { environment: ENV1, savedAt: NOW }, afterDelete: 'removed', afterReset: 'removed' },
    { area: 'local', key: `${prefix}1000002`, value: { environment: ENV2, savedAt: NOW }, afterDelete: 'kept', afterReset: 'removed' },
  ]),
  { area: 'local', key: 'crev_objectview_ctx_1000003', value: { name: 'no environment', savedAt: NOW }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: 'crev_color_sets_v2', value: { [ENV1]: { version: 2, fetchedAt: NOW, sets: [] }, [ENV2]: { version: 2, fetchedAt: NOW, sets: [] } },
    afterDelete: 'rewritten', kept: { [ENV2]: { version: 2, fetchedAt: NOW, sets: [] } }, afterReset: 'removed' },
  { area: 'local', key: 'crev_schema_cache_v2', value: {
    [`${ENV1}::risk`]: { serverId: ENV1, className: 'Risk', fetchedAt: NOW, props: [] },
    [`${ENV2}::risk`]: { serverId: ENV2, className: 'Risk', fetchedAt: NOW, props: [] },
  }, afterDelete: 'rewritten', kept: { [`${ENV2}::risk`]: { serverId: ENV2, className: 'Risk', fetchedAt: NOW, props: [] } }, afterReset: 'removed' },
  { area: 'local', key: 'crev_root_category_cache_v1', value: {
    [`${ENV1}::risks`]: { serverId: ENV1, category: 'risks', className: 'Risk', resolvedAt: NOW },
    [`${ENV2}::risks`]: { serverId: ENV2, category: 'risks', className: 'Risk', resolvedAt: NOW },
  }, afterDelete: 'rewritten', kept: { [`${ENV2}::risks`]: { serverId: ENV2, category: 'risks', className: 'Risk', resolvedAt: NOW } }, afterReset: 'removed' },
  { area: 'local', key: 'crev_script_ledger:https://a.test/', value: { scripts: [] }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: 'crev_script_ledger:https://b.test', value: { scripts: [] }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'local', key: 'crev_update_check', value: { version: '1' }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'local', key: `access-pending:${ENV1}`, value: { id: 'a' }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: `access-pending:${ENV2}`, value: { id: 'b' }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'local', key: `crev_transport_draft:${ENV1}`, value: { v: 1 }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: `crev_transport_draft:${ENV2}`, value: { v: 1 }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'local', key: `crev_transport_undo:${ENV1}|${ENV2}`, value: { v: 1 }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'local', key: `crev_transport_undo:${ENV2}|${ENV1}`, value: { v: 1 }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'local', key: 'crev_access_mode_recents', value: { p1: ['1000001'], p2: ['1000002'] },
    afterDelete: 'rewritten', kept: { p2: ['1000002'] }, afterReset: 'removed' },
  { area: 'local', key: 'crev_overlay_bounds_editor', value: { left: 1, top: 1, width: 9, height: 9 }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'local', key: 'crev_blueprint_portable_ids', value: { enabled: true, pattern: '{name}' }, afterDelete: 'kept', afterReset: 'removed' },
  ...['crev_editor_output_height', 'crev_editor_wrap', 'crev_editor_decode', 'crev_editor_table'].map((key): Seed => (
    { area: 'local', key, value: 1, afterDelete: 'kept', afterReset: 'kept' })),
  // Session
  ...['crev_editor_ctx_', 'crev_editor_launch_', 'crev_editor_session_'].flatMap((prefix): Seed[] => [
    { area: 'session', key: `${prefix}one`, value: { environment: ENV1 }, afterDelete: 'removed', afterReset: 'removed' },
    { area: 'session', key: `${prefix}two`, value: { environment: ENV2 }, afterDelete: 'kept', afterReset: 'removed' },
  ]),
  { area: 'session', key: 'crev_access_mode_subjects', value: { environment: ENV1, subjects: [] }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'session', key: `crev_access_mode_subject:${ENV1}`, value: { rid: '1' }, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'session', key: `crev_access_mode_subject:${ENV2}`, value: { rid: '2' }, afterDelete: 'kept', afterReset: 'removed' },
  { area: 'session', key: 'crev_compare_pivot_p1', value: {}, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'session', key: 'crev_conn_snapshot_by_profile', value: { p1: { a: 1 }, p2: { b: 2 } }, afterDelete: 'rewritten', kept: { p2: { b: 2 } }, afterReset: 'kept' },
  ...['crev_command_auth_v2_', 'crev_jwt_'].flatMap((prefix): Seed[] => [
    { area: 'session', key: `${prefix}p1`, value: 'token-1', afterDelete: 'removed', afterReset: 'kept' },
    { area: 'session', key: `${prefix}p2`, value: 'token-2', afterDelete: 'kept', afterReset: 'kept' },
  ]),
  { area: 'session', key: 'crev_page_diagnostics', value: {}, afterDelete: 'removed', afterReset: 'removed' },
  { area: 'session', key: 'crev_connection_trace', value: [], afterDelete: 'kept', afterReset: 'removed' },
  ...['crev_conn_snapshot', 'crev_settings_snapshot', 'crev_debug', 'crev_connection_trace_enabled', 'crev_tab_detection',
    'crev_inspect_active_by_window', 'crev_blueprint_active_by_window', 'crev_blueprint_tab_by_window', 'crev_display_by_window',
    'crev_frame_served', 'crev_active_tab', 'crev_conn_recovery'].map((key): Seed => ({ area: 'session', key, value: 1, afterDelete: 'kept', afterReset: 'kept' })),
  // Not ours: never touched.
  { area: 'local', key: 'someone_else', value: 1, afterDelete: 'kept', afterReset: 'kept' },
];

// ── A small IndexedDB: open / one store / cursor delete / deleteDatabase ──

interface FakeDb { stores: Map<string, Map<string, { key: IDBValidKey; value: unknown }>> }
const databases = new Map<string, FakeDb>();
const deleted: string[] = [];

function fakeIndexedDb() {
  const later = (fn: () => void) => setTimeout(fn, 0);
  return {
    open(name: string) {
      const req: any = {};
      later(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) { db = { stores: new Map() }; databases.set(name, db); }
        req.result = {
          createObjectStore: (store: string) => { db!.stores.set(store, new Map()); },
          close: () => {},
          transaction: (store: string) => {
            const tx: any = {};
            const records = db!.stores.get(store) ?? new Map();
            tx.objectStore = () => ({
              openCursor() {
                const cur: any = {};
                const entries = [...records.entries()];
                let i = 0;
                const step = () => later(() => {
                  if (i >= entries.length) { cur.result = null; cur.onsuccess?.(); later(() => tx.oncomplete?.()); return; }
                  const [id, rec] = entries[i++];
                  cur.result = { key: rec.key, value: rec.value, delete: () => records.delete(id), continue: step };
                  cur.onsuccess?.();
                });
                step();
                return cur;
              },
            });
            return tx;
          },
        };
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string) {
      const req: any = {};
      later(() => { deleted.push(name); databases.delete(name); req.onsuccess?.(); });
      return req;
    },
  };
}

function seedIdb() {
  databases.clear();
  deleted.length = 0;
  const put = (db: string, store: string, records: Array<{ key: IDBValidKey; value: unknown }>) => {
    databases.set(db, { stores: new Map([[store, new Map(records.map(r => [JSON.stringify(r.key), r]))]]) });
  };
  put('companion-access', 'workspaces', [{ key: ['ws', ENV1], value: 1 }, { key: ['ws', ENV2], value: 2 }]);
  put('companion-access-operations', 'applies', [{ key: 'op1', value: { environment: ENV1 } }, { key: 'op2', value: { environment: ENV2 } }]);
  put('crev-code-index', 'objects', [{ key: [ENV1, '1'], value: 1 }]);
}
const idbKeys = (db: string) => [...(databases.get(db)?.stores.values().next().value?.values() ?? [])].map(r => r.key);

async function seeded() {
  vi.resetModules();
  mockChromeStorage();
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  for (const s of SEEDS) (s.area === 'local' ? local : session)[s.key] = structuredClone(s.value);
  await chrome.storage.local.set(local);
  await chrome.storage.session.set(session);
  seedIdb();
  (globalThis as any).indexedDB = fakeIndexedDb();
  return import('../local-data');
}

async function stored(area: 'local' | 'session'): Promise<Record<string, unknown>> {
  return chrome.storage[area].get(null);
}

afterEach(() => { delete (globalThis as any).indexedDB; });

describe('the stored-key table', () => {
  it('every local and session family has a seeded row here', () => {
    const covered = new Set(SEEDS.map(s => storedKeyFor(s.area, s.key)).filter(Boolean));
    const missing = STORED_KEYS.filter(e => (e.area === 'local' || e.area === 'session') && !covered.has(e)).map(e => `${e.area}:${e.key}${e.suffix ?? ''}`);
    expect(missing).toEqual([]);
  });

  it('covers every storage key the source writes', () => {
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === '__tests__' || name === 'integration' ? [] : walk(path);
        return /\.(ts|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name) && !/eval-/.test(name) ? [path] : [];
      });
    })('src');
    const literals = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/['"`](crev_[A-Za-z0-9_:]*|access-pending:)/g)) literals.add(m[1]);
      for (const m of text.matchAll(/indexedDB\.open\(\s*['"`]([^'"`]+)/g)) literals.add(`idb:${m[1]}`);
      for (const m of text.matchAll(/DB_NAME\s*=\s*['"`]([^'"`]+)/g)) literals.add(`idb:${m[1]}`);
    }
    const covered = (literal: string): boolean => {
      if (literal.startsWith('idb:')) return STORED_KEYS.some(e => e.area === 'indexeddb' && e.key === literal.slice(4));
      if (NOT_STORAGE_KEYS.includes(literal)) return true;
      // `crev_${profileId}_…` templates: the literal is the bare `crev_` prefix.
      if (literal === 'crev_') return STORED_KEYS.some(e => e.key === 'crev_' && e.suffix);
      // The bare-prefix family above covers only that template, not every `crev_` key.
      return STORED_KEYS.some(e => e.key !== 'crev_' && (e.match === 'exact' ? e.key === literal : literal.startsWith(e.key) || e.key.startsWith(literal)));
    };
    expect([...literals].filter(l => !covered(l)).sort()).toEqual([]);
  });
});

describe('deleting a server profile', () => {
  beforeEach(() => vi.useRealTimers());

  it('removes everything stored for it and keeps the other profile and the settings', async () => {
    const { clearProfileLocalData } = await seeded();
    await clearProfileLocalData('p1', { serverUrl: 'https://a.test', remainingServerUrls: ['https://b.test/'] });
    const after = { local: await stored('local'), session: await stored('session') };
    for (const s of SEEDS) {
      const now = after[s.area][s.key];
      const label = `${s.area}:${s.key}`;
      if (s.afterDelete === 'removed') expect(now, label).toBeUndefined();
      else if (s.afterDelete === 'kept') expect(now, label).toEqual(s.value);
      else expect(now, label).toEqual(s.kept);
    }
    expect(idbKeys('companion-access')).toEqual([['ws', ENV2]]);
    expect(idbKeys('companion-access-operations')).toEqual(['op2']);
    expect(idbKeys('crev-code-index')).toHaveLength(1); // the caller clears the code index
  });

  it('keeps a server script ledger another profile still uses', async () => {
    const { clearProfileLocalData } = await seeded();
    await clearProfileLocalData('p1', { serverUrl: 'https://a.test', remainingServerUrls: ['https://A.test/'] });
    expect((await stored('local'))['crev_script_ledger:https://a.test/']).toBeDefined();
  });
});

describe('Reset all', () => {
  it('removes every working copy and keeps settings, profiles, sign-ins and preferences', async () => {
    const { clearAllLocalData } = await seeded();
    await clearAllLocalData(['p1', 'p2']);
    const after = { local: await stored('local'), session: await stored('session') };
    for (const s of SEEDS) {
      const label = `${s.area}:${s.key}`;
      if (s.afterReset === 'removed') expect(after[s.area][s.key], label).toBeUndefined();
      else expect(after[s.area][s.key], label).toEqual(s.value);
    }
    expect(deleted.sort()).toEqual(['companion-access', 'companion-access-operations']);
  });
});

describe('launch context expiry', () => {
  it('sweeps launch contexts older than a week or without savedAt, keeps recent ones', async () => {
    const { sweepLaunchContexts } = await seeded();
    await chrome.storage.local.set({
      crev_objectview_ctx_2000001: { savedAt: NOW - LAUNCH_CONTEXT_MAX_AGE_MS - 1 },
      crev_editor_ctx_2000002: { environment: ENV1 },
      crev_cvo_studio_ctx_2000003: { savedAt: NOW - 1_000 },
    });
    await sweepLaunchContexts(NOW);
    const after = await stored('local');
    expect(after.crev_objectview_ctx_2000001).toBeUndefined();
    expect(after.crev_editor_ctx_2000002).toBeUndefined();
    expect(after.crev_cvo_studio_ctx_2000003).toBeDefined();
    expect(after.crev_objectview_ctx_1000001).toBeDefined();
    expect(after.crev_settings).toBeDefined();
  });
});
