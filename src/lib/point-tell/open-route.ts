// Not used by the interface at present: Point and tell is one way. Kept for a later two-way channel.
/**
 * What a change that Blueprint cannot stage opens: code goes to the editor (on that property) as a diff to
 * accept or reject, text to the object window as a draft. The user reviews and saves there, with that window's
 * own checks; nothing is written from here.
 */
import { sendFireForget } from '../messaging';
import { openObject } from '../open-object';
import type { Route } from './routes';

export function openRoute(rid: string, route: { kind: Route; property: string; value: string; name?: string; className?: string }): void {
  if (route.kind === 'code') sendFireForget({ type: 'OPEN_EDITOR', rid, property: route.property, proposal: route.value });
  else openObject(rid, { name: route.name, type: route.className }, { draft: { prop: route.property, value: route.value } });
}
