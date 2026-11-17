/**
 * Shared command-actor disclosure.
 *
 * The service worker and content script keep the current identity map warm.
 * Separate editor/studio windows fall back to the sanitized connection
 * snapshot in session storage. No auth material is read or exposed here.
 */

import type { CommandAuthSource, ConnectionState, IdentityMap, InspectorSettings } from './types';
import { provisionalConnectionSnapshot } from './connection-snapshot';

export interface CommandActorDisclosure {
  user: string;
  source: CommandAuthSource;
  text: string;
}

export type CommandActorState =
  | { status: 'checking' }
  | { status: 'verified'; actor: CommandActorDisclosure }
  | { status: 'unavailable' };

/** The identities this page last learned. Kept on the global object, not in
 *  the module: the content script (content.js) and the lazily injected
 *  Blueprint bundle (content-blueprint.js) share one isolated world but each
 *  has its own copy of this module. Only content.js receives the worker's
 *  CONNECTION_STATE pushes (for its own tab's profile), so a module-local
 *  value left Blueprint's review without the acting user. */
const SHARED_KEY = '__crevCommandIdentities';
/** Fired on `document` when the shared identities change (content world). */
export const COMMAND_ACTOR_EVENT = 'crev-command-actor';
type SharedHolder = { [SHARED_KEY]?: IdentityMap | null };
const shared = globalThis as SharedHolder;
/** The worker keeps one identity map per server profile. */
const byProfile = new Map<string, IdentityMap>();

export function setCurrentIdentities(identities: IdentityMap, profileId?: string): void {
  shared[SHARED_KEY] = identities;
  if (profileId) byProfile.set(profileId, identities);
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
    try { document.dispatchEvent(new CustomEvent(COMMAND_ACTOR_EVENT)); } catch { /* no listeners needed */ }
  }
}

/** Call `listener` whenever this page learns new identities (pushed by the
 *  worker to content.js). Returns the unsubscribe. */
export function onCommandActorChange(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener(COMMAND_ACTOR_EVENT, listener);
  return () => document.removeEventListener(COMMAND_ACTOR_EVENT, listener);
}

export function disclosureFromIdentities(identities: IdentityMap | null | undefined): CommandActorDisclosure | null {
  const actor = identities?.command;
  if (!actor || actor.status !== 'connected' || !actor.user) return null;
  return {
    user: actor.user,
    source: actor.source,
    text: actor.source === 'stored-login'
      ? `Runs as ${actor.user} · stored configuration login`
      : `Runs as ${actor.user} · browser session`,
  };
}

/** The verified command actor: of `profileId` when given (worker), else the
 *  one this page last learned (content script). */
export function currentCommandActor(profileId?: string): CommandActorDisclosure | null {
  return disclosureFromIdentities(profileId && byProfile.size > 0 ? byProfile.get(profileId) ?? null : shared[SHARED_KEY] ?? null);
}

/** What a window's own content strip says about the acting user. The
 *  window's title bar names the server and the user, so a verified (or still
 *  checking) actor needs no second line here; only an unconfirmed one is
 *  said, since saves then run with whatever BMP sign-in the browser has. */
export const ACTOR_NOT_CONFIRMED = 'BMP user not confirmed: saves run with your current BMP sign-in';
export function actorStripText(state: CommandActorState): string {
  return state.status === 'unavailable' ? ACTOR_NOT_CONFIRMED : '';
}

function stateFromConnection(connection: ConnectionState | null | undefined): CommandActorState {
  const actor = disclosureFromIdentities(connection?.identities);
  if (actor) return { status: 'verified', actor };
  if (connection?.validation === 'validating'
    || connection?.display === 'checking'
    || connection?.display === 'reconnecting'
    || connection?.display === 'online') {
    return { status: 'checking' };
  }
  return { status: 'unavailable' };
}

async function readCommandActorState(): Promise<CommandActorState> {
  const warm = currentCommandActor();
  if (warm) return { status: 'verified', actor: warm };
  try {
    // The worker answers for this page's own server (the session snapshot
    // is the last published state of whichever profile wrote it last).
    const live = typeof chrome.runtime?.sendMessage === 'function'
      ? await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' })
        .catch(() => undefined) as { type?: string; state?: ConnectionState } | undefined
      : undefined;
    if (live?.type === 'CONNECTION_STATE') return stateFromConnection(live.state);
    const stored = await chrome.storage.session.get(['crev_conn_snapshot', 'crev_settings_snapshot']);
    const settings = stored.crev_settings_snapshot as InspectorSettings | undefined;
    const snapshot = settings
      ? provisionalConnectionSnapshot(stored.crev_conn_snapshot, settings)
      : null;
    return snapshot ? stateFromConnection(snapshot) : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function readCommandActor(): Promise<CommandActorDisclosure | null> {
  const state = await readCommandActorState();
  return state.status === 'verified' ? state.actor : null;
}

/** Observe verified command-actor changes without polling. Separate extension
 * pages (notably the EC editor iframe) do not share the worker's in-memory
 * identity map, but every definitive connection transition refreshes the
 * sanitized session snapshot. */
export function watchCommandActor(
  listener: (state: CommandActorState) => void,
): () => void {
  let revision = 0;
  let disposed = false;
  let lastKey: string | undefined;
  const refresh = () => {
    const requestedRevision = ++revision;
    void readCommandActorState().then(state => {
      if (disposed || requestedRevision !== revision) return;
      const key = state.status === 'verified'
        ? `${state.status}\u0000${state.actor.source}\u0000${state.actor.user}`
        : state.status;
      if (key === lastKey) return;
      lastKey = key;
      listener(state);
    });
  };
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'session'
      || (!changes.crev_conn_snapshot && !changes.crev_settings_snapshot)) return;
    refresh();
  };
  // Subscribe before the initial read so a snapshot publication during cold
  // editor startup cannot fall into a read/listen gap.
  chrome.storage?.onChanged?.addListener(onChanged);
  refresh();
  return () => {
    disposed = true;
    revision++;
    chrome.storage?.onChanged?.removeListener(onChanged);
  };
}
