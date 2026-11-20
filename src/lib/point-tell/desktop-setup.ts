/**
 * The Claude Desktop page (claude-setup/): what the status call says about the desktop extension, in the page's
 * words. Pure: the page draws it, the worker asks (short loopback sockets, see claude-link.ts).
 *
 * "Update" is offered only when the installed desktop extension is below the minimum Send to Claude needs
 * (DESKTOP_MIN_VERSION), not because this build ships a newer one: an install is done by hand, so it is asked for
 * only when it is needed.
 */
import { needsUpdate, type StatusResult } from '../claude-link';
import { chatTaking } from './sent-model';

export type SetupState =
  | { kind: 'checking' }
  | { kind: 'none' }
  | {
    kind: 'connected';
    version?: string;
    /** Below the minimum (or too old to say its version): Send to Claude needs a newer one. */
    update: boolean;
    /** A chat takes sketches now. */
    taking: boolean;
    /** The copies that answered on the range, newest first. */
    copies: Array<{ port: number; version?: string }>;
    /** The settings revision it holds; absent when it takes no settings (before 0.3.0). */
    configRev?: number;
  };

export function setupState(res: StatusResult | null | undefined, now = Date.now()): SetupState {
  if (!res) return { kind: 'checking' };
  if (!res.ok) return { kind: 'none' };
  const takesConfig = !!res.caps?.includes('config');
  return {
    kind: 'connected',
    ...(res.version ? { version: res.version } : {}),
    update: needsUpdate(res.version, res.caps ?? []),
    taking: chatTaking({ agent: res.agent, ...(res.copies ? { copies: res.copies } : {}), ...(res.wait ? { wait: res.wait } : {}) }, now),
    copies: res.answered ?? [{ port: res.port, ...(res.version ? { version: res.version } : {}) }],
    ...(takesConfig ? { configRev: res.configRev ?? 0 } : {}),
  };
}

export interface StatusView {
  dot: 'idle' | 'ok' | 'warn';
  text: string;
  /** The installed version, shown after the text. */
  version?: string;
}

export function statusView(s: SetupState): StatusView {
  if (s.kind === 'checking') return { dot: 'idle', text: 'Looking for Claude Desktop…' };
  if (s.kind === 'none') return { dot: 'idle', text: 'Claude Desktop not found' };
  if (s.update) return { dot: 'warn', text: 'Older version connected', ...(s.version ? { version: s.version } : {}) };
  return { dot: 'ok', text: 'Connected', ...(s.version ? { version: s.version } : {}) };
}

/** The facts under the state line: which copies answered, whether a chat takes sketches, the settings. */
export function factLines(s: SetupState): string[] {
  if (s.kind !== 'connected') return [];
  const copies = s.copies.map(c => `${c.version ?? 'unknown version'} on port ${c.port}`);
  return [
    `${s.copies.length === 1 ? 'One copy' : `${s.copies.length} copies`} answered: ${copies.join(', ')}`,
    s.taking ? 'A chat is taking sketches' : 'No chat is taking sketches',
    ...(s.configRev !== undefined ? [s.configRev ? `Settings from Companion: ${s.configRev}` : 'Built-in settings'] : []),
  ];
}

/** The download button: "Update" when Send to Claude needs a newer desktop extension, and the main action until one is connected. */
export function getButton(s: SetupState): { label: string; primary: boolean } {
  if (s.kind === 'connected') return s.update ? { label: 'Update', primary: true } : { label: 'Get the extension', primary: false };
  return { label: 'Get the extension', primary: true };
}

/** A chat already takes sketches: step 3 shows that instead of the button. */
export const chatWaiting = (s: SetupState): boolean => s.kind === 'connected' && s.taking;
