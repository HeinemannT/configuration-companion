/**
 * The workspace's image files (folders and image FileResources, no content)
 * kept per environment in storage.local, so the Images tab and the image
 * picker on a button open without a read. A stored copy is a dated snapshot:
 * it is read again only when asked for (force), never by itself. A failed
 * read never replaces a good copy.
 */
import type { ImageIndex } from './colors-images/image-files';
import { log } from './logger';

const STORAGE_KEY = 'crev_image_index_v1';
const VERSION = 1;

interface Entry { version: typeof VERSION; fetchedAt: number; index: ImageIndex }
type Store = Record<string, Entry>;

export interface ImageIndexLoad { index: ImageIndex; fetchedAt: number; source: 'cache' | 'network' | 'stale-fallback'; error?: string }

const mem = new Map<string, Entry>();
const pending = new Map<string, Promise<ImageIndexLoad>>();
let loadPromise: Promise<void> | null = null;
let generation = 0;

function load(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const store = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Store | undefined;
      for (const [environment, entry] of Object.entries(store ?? {})) {
        if (entry?.version === VERSION && Array.isArray(entry.index?.files) && Array.isArray(entry.index?.folders) && Number.isFinite(entry.fetchedAt)) mem.set(environment, entry);
      }
    } catch (e) { log.swallow('imageIndex:load', e); }
  })();
  return loadPromise;
}

async function persist(): Promise<void> {
  const store: Store = {};
  for (const [environment, entry] of mem) store[environment] = entry;
  try { await chrome.storage.local.set({ [STORAGE_KEY]: store }); } catch (e) { log.swallow('imageIndex:persist', e); }
}

export async function getImageIndex(environment: string): Promise<{ index: ImageIndex; fetchedAt: number } | null> {
  await load();
  const entry = mem.get(environment);
  return entry ? { index: entry.index, fetchedAt: entry.fetchedAt } : null;
}

/** The stored copy; a read only on the first miss or when `force`. Callers
 *  of one environment share one read. */
export async function loadImageIndex(environment: string, fetcher: () => Promise<ImageIndex>, force = false): Promise<ImageIndexLoad> {
  const cached = await getImageIndex(environment);
  if (!force && cached) return { ...cached, source: 'cache' };
  const existing = pending.get(environment);
  if (existing) return existing;
  const requested = generation;
  const request = (async (): Promise<ImageIndexLoad> => {
    try {
      const index = await fetcher();
      if (generation !== requested) throw new Error('Image request invalidated during environment change');
      const fetchedAt = Date.now();
      await load();
      mem.set(environment, { version: VERSION, fetchedAt, index });
      await persist();
      return { index, fetchedAt, source: 'network' };
    } catch (e) {
      if (cached) return { ...cached, source: 'stale-fallback', error: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  })();
  pending.set(environment, request);
  try { return await request; } finally { if (pending.get(environment) === request) pending.delete(environment); }
}

/** Drop every environment of one profile, or all (Reset all). */
export async function forgetProfileImageIndex(profileId?: string): Promise<void> {
  generation += 1;
  await load();
  for (const environment of [...mem.keys()]) if (profileId === undefined || environment.startsWith(`${profileId}@`)) mem.delete(environment);
  await persist();
}
