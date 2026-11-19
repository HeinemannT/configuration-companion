/**
 * Point and tell: what it asks the service worker for. The page layout (one read, the same one
 * Blueprint makes, so the target rule is Blueprint's), on a templated page the link map, and the
 * workspace colours (the worker's own cached copy, read once). None of them touches Blueprint's state.
 */
import { sendRequest } from '../lib/messaging';
import type { ColorSetData, InspectorMessage } from '../lib/types';
import { WorkspaceColorCatalogue } from '../lib/workspace-color-catalogue';

type LoadResult = Extract<InspectorMessage, { type: 'LAYOUT_LOAD_RESULT' }>;
type LinksResult = Extract<InspectorMessage, { type: 'LAYOUT_LINKS_RESULT' }>;
type ColorSetsResult = Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>;
type NowResult = Extract<InspectorMessage, { type: 'POINT_TELL_NOW_DATA' }>;

export const fetchModel = (rid: string, prefer: 'template' | 'instance'): Promise<LoadResult | undefined> =>
  sendRequest<LoadResult>({ type: 'LAYOUT_LOAD', rid, prefer, for: 'point-tell' });

export async function fetchLinks(rid: string): Promise<Record<string, string> | null> {
  const res = await sendRequest<LinksResult>({ type: 'LAYOUT_LINKS', rid });
  return res?.ok && res.links ? res.links : null;
}

/** The text properties and code the noted objects hold, one batched read (null when it could not be made). */
export async function fetchNow(items: Array<{ rid: string; className: string }>): Promise<NonNullable<NowResult['objects']> | null> {
  const res = await sendRequest<NowResult>({ type: 'POINT_TELL_READ_NOW', items });
  return res?.ok && res.objects ? res.objects : null;
}

type BlastResult = Extract<InspectorMessage, { type: 'LAYOUT_BLAST_RESULT' }>;

/** How many pages use the template (its instances), one read; null when it could not be told. */
export async function fetchFanout(pageId: string): Promise<number | null> {
  const res = await sendRequest<BlastResult>({ type: 'LAYOUT_BLAST', pageId, containers: [], flowContainers: [] });
  return res?.fanout ? res.fanout.total : null;
}

// The colors an answer may name. One catalogue per session; the worker serves its cached copy.
const catalogue = new WorkspaceColorCatalogue();

/** Read the colours once (a no-op when read or on its way). */
export function ensureColors(): Promise<boolean> {
  return catalogue.load(force => sendRequest<ColorSetsResult>({ type: 'FETCH_COLOR_SETS', ...(force ? { force: true } : {}) }));
}

/** The colour sets read so far, or null. */
export const colorSets = (): ColorSetData[] | null => catalogue.snapshot().sets;

/** A color's name, from the colors read so far. */
export const colorName = (bid: string): string | undefined => catalogue.lookup(bid)?.name;

export function resetColors(): void { catalogue.reset(); }
