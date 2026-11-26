/**
 * Atlas's model of a workspace (atlas/model.ts) kept per environment in
 * storage.local, so the window opens without a read. A stored copy is a dated
 * snapshot: it is read again only when asked for (force), never by itself. A
 * failed read never replaces a good copy.
 */
import type { AtlasModel } from './model';
import { log } from '../logger';

const STORAGE_KEY = 'crev_atlas_model_v1';
/** 2: the model carries object counts and how many objects fill each reference. */
const VERSION = 2;

interface Entry { version: typeof VERSION; fetchedAt: number; model: AtlasModel }
type Store = Record<string, Entry>;

export interface AtlasModelLoad { model: AtlasModel; fetchedAt: number; source: 'cache' | 'network' | 'stale-fallback'; error?: string }

const mem = new Map<string, Entry>();
const pending = new Map<string, Promise<AtlasModelLoad>>();
let loadPromise: Promise<void> | null = null;
let generation = 0;

function load(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const store = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Store | undefined;
      for (const [environment, entry] of Object.entries(store ?? {})) {
        if (entry?.version === VERSION && Array.isArray(entry.model?.edges) && Array.isArray(entry.model?.reverses) && Number.isFinite(entry.fetchedAt)) mem.set(environment, entry);
      }
    } catch (e) { log.swallow('atlasModel:load', e); }
  })();
  return loadPromise;
}

async function persist(): Promise<void> {
  const store: Store = {};
  for (const [environment, entry] of mem) store[environment] = entry;
  try { await chrome.storage.local.set({ [STORAGE_KEY]: store }); } catch (e) { log.swallow('atlasModel:persist', e); }
}

export async function getAtlasModel(environment: string): Promise<{ model: AtlasModel; fetchedAt: number } | null> {
  await load();
  const entry = mem.get(environment);
  return entry ? { model: entry.model, fetchedAt: entry.fetchedAt } : null;
}

/** The stored copy; a read only on the first miss or when `force`. Callers
 *  of one environment share one read. */
export async function loadAtlasModel(environment: string, fetcher: () => Promise<AtlasModel>, force = false): Promise<AtlasModelLoad> {
  const cached = await getAtlasModel(environment);
  if (!force && cached) return { ...cached, source: 'cache' };
  const existing = pending.get(environment);
  if (existing) return existing;
  const requested = generation;
  const request = (async (): Promise<AtlasModelLoad> => {
    try {
      const model = await fetcher();
      if (generation !== requested) throw new Error('Atlas read invalidated during environment change');
      const fetchedAt = Date.now();
      await load();
      mem.set(environment, { version: VERSION, fetchedAt, model });
      await persist();
      return { model, fetchedAt, source: 'network' };
    } catch (e) {
      if (cached) return { ...cached, source: 'stale-fallback', error: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  })();
  pending.set(environment, request);
  try { return await request; } finally { if (pending.get(environment) === request) pending.delete(environment); }
}

/** Drop every environment of one profile, or all (Reset all). */
export async function forgetProfileAtlasModel(profileId?: string): Promise<void> {
  generation += 1;
  await load();
  for (const environment of [...mem.keys()]) if (profileId === undefined || environment.startsWith(`${profileId}@`)) mem.delete(environment);
  await persist();
}
