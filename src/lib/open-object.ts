/**
 * Opening an object in the object window: the one builder of the
 * OPEN_OBJECT_VIEW message, used by every surface (content script badges and
 * hover card, Blueprint, code search, Compare, editor, Studio, side panel).
 */
import type { InspectorMessage, ObjectWindowFocus, ObjectWindowOrigin } from './types';
import { sendFireForget } from './messaging';

/** What the opener already knows of the object; the window paints its title
 *  at once and the worker takes the hinted read. Empty values are left out
 *  (the launcher fills them from its cache). */
export interface KnownIdentity { name?: string; type?: string; businessId?: string }

/** Where the object window opens and how it was reached. */
export interface OpenObjectOptions {
  /** Scroll to and mark this code line. */
  focus?: ObjectWindowFocus;
  /** The object (and line) the user came from, for the trail's back step. */
  from?: { rid: string; name?: string; line?: number };
  /** "Reached from" a search: the trail's first step. */
  origin?: ObjectWindowOrigin;
  /** Reveal the object in its parent's tree. */
  reveal?: boolean;
}

/** The one builder of OPEN_OBJECT_VIEW. The server environment is not part of
 *  the message: the page's route hint (setRouteHint) binds it. */
export function openObjectViewMessage(rid: string, known?: KnownIdentity | null, opts: OpenObjectOptions = {}): Extract<InspectorMessage, { type: 'OPEN_OBJECT_VIEW' }> {
  return {
    type: 'OPEN_OBJECT_VIEW', rid,
    ...(known?.name ? { name: known.name } : {}),
    ...(known?.type ? { objectType: known.type } : {}),
    ...(known?.businessId ? { businessId: known.businessId } : {}),
    ...(opts.reveal ? { reveal: true } : {}),
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.focus ? { focus: opts.focus } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
}

/** Open `rid` in the object window (fire and forget). */
export function openObject(rid: string, known?: KnownIdentity | null, opts?: OpenObjectOptions): void {
  sendFireForget(openObjectViewMessage(rid, known, opts));
}
