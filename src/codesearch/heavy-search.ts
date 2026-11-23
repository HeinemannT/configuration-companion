/**
 * The warning before a broad search that reads the BMP server.
 *
 * Nothing builds a copy of the code by itself (code-index-service.ts): without
 * a complete copy on this computer, a search is a live scan. The worker lists
 * every object with code in the chosen places and reads the new or changed
 * ones in batches (code-scope-read.ts). It keeps what it read for
 * READ_CACHE_IDLE_MS after the last search, so the same places searched again
 * ask the server only what changed. A search answered from the copy, or one
 * limited to "Under an object" or to a few places, reads little or nothing:
 * no warning there.
 */

import { attrs, btn, el } from '../lib/dom';
import type { EscapeLayer } from '../lib/escape-layers';
import { READ_CACHE_IDLE_MS } from '../lib/code-scope-read';

/** A search of this many places or more is broad. */
export const BROAD_PLACES = 3;
const ORG_ROOT = 'root:organisation';
const SKIP_KEY = 'crev-code-search-skip-server-note';

export interface PlaceFacts {
  /** "Under an object" is set. */
  scope: boolean;
  /** The chosen places (Where); empty means everywhere. */
  where: readonly string[];
  /** The places are the default: the configuration roots. */
  defaultWhere: boolean;
}

/** A place that holds much code: everywhere, the defaults, the organisation
 *  root or several places. Under an object, or one or two places, is not. */
export function isBroadPlace(p: PlaceFacts): boolean {
  if (p.scope) return false;
  return !p.where.length || p.defaultWhere || p.where.length >= BROAD_PLACES || p.where.includes(ORG_ROOT);
}

/** The places searched on one server, as one key. */
export const placeKey = (environment: string, where: readonly string[]): string => `${environment}|${[...where].sort().join(',')}`;

/** Places this window searched on the server lately: the worker still keeps
 *  what it read there, so a search of them is not a first read. */
export class ReadPlaces {
  private at = new Map<string, number>();
  constructor(private readonly keepMs = READ_CACHE_IDLE_MS) {}
  /** Every search of the place keeps its code for another keepMs. */
  note(key: string, now = Date.now()): void { this.at.set(key, now); }
  recent(key: string, now = Date.now()): boolean {
    const t = this.at.get(key);
    return t !== undefined && now - t < this.keepMs;
  }
}

/** Whether to ask before this search: it reads the server (no usable copy),
 *  the place is broad, the place was not read lately, the user did not turn
 *  the note off. */
export function needsWarning(a: { readsServer: boolean; broad: boolean; readLately: boolean; muted: boolean }): boolean {
  return a.readsServer && a.broad && !a.readLately && !a.muted;
}

export async function loadMuted(): Promise<boolean> {
  try { return (await chrome.storage.local.get(SKIP_KEY))[SKIP_KEY] === true; } catch { return false; }
}
export async function saveMuted(muted: boolean): Promise<void> {
  try { await chrome.storage.local.set({ [SKIP_KEY]: muted }); } catch { /* storage blocked: it asks again */ }
}

export type HeavyChoice = 'search' | 'narrow' | 'cancel';

/** The dialog's sentences. `canCopy`: this server can keep a copy. */
export function heavyCopy(canCopy: boolean): { title: string; paragraphs: string[] } {
  const minutes = Math.round(READ_CACHE_IDLE_MS / 60_000);
  return {
    title: 'This search reads the server',
    paragraphs: [
      'There is no complete copy of this server\'s code on this computer, so Companion reads the code of every object in these places from BMP. Nothing is changed.',
      `The first search can take a while and puts load on the server. Companion keeps what it read for ${minutes} minutes after your last search, up to a size limit, so searching the same places again asks the server only what changed.`,
      canCopy
        ? 'To read less, choose a smaller place, for example Under an object. Or keep a copy on this computer: searches then read the copy, not the server.'
        : 'To read less, choose a smaller place, for example Under an object.',
    ],
  };
}

export interface HeavyHost {
  /** Where the dialog goes (inside the window's root, which carries the styles). */
  parent: () => HTMLElement;
  /** Escape closes it (cancel): the window's Escape layers. */
  escape: (layer: EscapeLayer) => () => void;
}

/** Ask. Resolves when the user chooses; Escape is Cancel. `dontAsk` is the
 *  state of the checkbox at that moment. */
export function askHeavySearch(host: HeavyHost, o: { canCopy: boolean }): Promise<{ choice: HeavyChoice; dontAsk: boolean }> {
  return new Promise(resolve => {
    const copy = heavyCopy(o.canCopy);
    const box = attrs(el('input'), { type: 'checkbox', id: 'cs-heavy-mute' }) as HTMLInputElement;
    let open = true;
    let unregister: () => void = () => {};
    const done = (choice: HeavyChoice) => {
      if (!open) return;
      open = false;
      unregister();
      scrim.remove();
      resolve({ choice, dontAsk: box.checked });
    };
    const ok = btn('ui-btn primary', undefined, () => done('search'), 'Search');
    const dlg = attrs(el('div', 'rp-dlg hv-dlg',
      attrs(el('h2', '', copy.title), { id: 'cs-heavy-title' }),
      ...copy.paragraphs.map(t => el('p', 'hv-p', t)),
      el('label', 'hv-mute', box, ' Don\'t show this again'),
      el('div', 'rp-acts', btn('ui-btn', undefined, () => done('cancel'), 'Cancel'), btn('ui-btn', undefined, () => done('narrow'), 'Choose a place'), ok),
    ), { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cs-heavy-title' });
    const scrim = el('div', 'rp-scrim', dlg);
    unregister = host.escape({ kind: 'dialog', name: 'server-read-note', isOpen: () => open, close: () => { done('cancel'); }, phase: 'capture' });
    host.parent().append(scrim);
    ok.focus();
  });
}
