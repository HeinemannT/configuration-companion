import type { BmpObject } from './types';

/** Compare source priority: server > fiber > dom. */
function prioritySource(a: BmpObject['source'], b: BmpObject['source']): BmpObject['source'] {
  const order: Record<string, number> = { server: 3, fiber: 1, dom: 0 };
  return (order[a] ?? 0) >= (order[b] ?? 0) ? a : b;
}

/** A record a page reported (DOM or React fiber), not one the server answered. */
function fromPage(o: BmpObject): boolean {
  return o.source !== 'server';
}

/** The identity fields only a server read may set or replace. */
const SERVER_IDENTITY = ['name', 'type', 'typename', 'businessId', 'templateBusinessId', 'cascade'] as const;

/** A page record as it may enter the cache: it never carries the markers of a
 *  server read, whatever the page sent. */
export function admitObject(incoming: BmpObject): BmpObject {
  if (!fromPage(incoming)) return incoming;
  const { identityEnriched: _ie, enrichedAt: _ea, templateBusinessId: _tb, cascade: _c, ...rest } = incoming;
  return rest;
}

/** Merge incoming object data into an existing entry, preferring non-null fields and higher-priority source.
 *  A page record never replaces what the server read: once an entry holds a server identity, a page
 *  may only fill fields that are still empty, and never sets `identityEnriched` / `enrichedAt`. */
export function mergeBmpObject(existing: BmpObject, incoming: BmpObject): BmpObject {
  const pageOverServer = fromPage(incoming) && (existing.source === 'server' || existing.identityEnriched === true);
  const page = fromPage(incoming);
  const merged: BmpObject = {
    rid: incoming.rid,
    name: incoming.name ?? existing.name,
    type: incoming.type ?? existing.type,
    typename: incoming.typename ?? existing.typename,
    businessId: incoming.businessId ?? existing.businessId,
    templateBusinessId: page ? existing.templateBusinessId : incoming.templateBusinessId ?? existing.templateBusinessId,
    identityEnriched: page ? existing.identityEnriched : incoming.identityEnriched ?? existing.identityEnriched,
    enrichedAt: page ? existing.enrichedAt : incoming.enrichedAt ?? existing.enrichedAt,
    cascade: page ? existing.cascade : incoming.cascade ?? existing.cascade,
    webParentRid: incoming.webParentRid ?? existing.webParentRid,
    webParentName: incoming.webParentName ?? existing.webParentName,
    pageRid: incoming.pageRid ?? existing.pageRid,
    pageName: incoming.pageName ?? existing.pageName,
    tabRid: incoming.tabRid ?? existing.tabRid,
    hasChildren: incoming.hasChildren ?? existing.hasChildren,
    properties: page ? existing.properties : incoming.properties ?? existing.properties,
    treePath: incoming.treePath ?? existing.treePath,
    source: prioritySource(incoming.source, existing.source),
    discoveredAt: existing.discoveredAt,
    updatedAt: Date.now(),
  };
  if (pageOverServer) {
    // The server's answer stands; the page only fills what the server left empty.
    // After a full identity read even an empty field is the server's answer.
    for (const k of SERVER_IDENTITY) {
      if (existing[k] !== undefined || existing.identityEnriched === true) (merged as unknown as Record<string, unknown>)[k] = existing[k];
    }
    merged.webParentRid = existing.webParentRid ?? incoming.webParentRid;
    merged.hasChildren = existing.hasChildren ?? incoming.hasChildren;
  }
  return merged;
}
