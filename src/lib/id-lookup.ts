/**
 * Exact business-ID lookup without Extended Code: GetPropertiesByIdCommand
 * (IdSpace, id) per ID space, in as few posts as resolvePolicyReferences
 * needs. The ID spaces and which types live in them come from the type
 * catalogue (LoadTypeConfigCommand), kept per connection.
 *
 * The script lookup (browse-tree idLookupPlan) put the typed ID into the
 * script text, so every query was a new varying script on the server; this
 * one sends no script. The order of preference is the script's: for
 * `ns.rest`, `rest` in the ID spaces of namespace `ns` first; then the whole
 * text in every space, the common namespaces (namespace ID_SPACES order)
 * first. The first space that knows the ID wins.
 */

import type { BmpTypeCatalogue } from './bmp-type-catalogue';
import { ID_SPACES, isValidNamespace, resolveNamespace } from './namespace';

export interface IdCandidate { space: string; id: string }

/** The ID spaces of the catalogue per namespace prefix. */
export function spacesByNamespace(catalogue: Pick<BmpTypeCatalogue, 'types'>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [type, fact] of Object.entries(catalogue.types)) {
    if (!fact.idSpace) continue;
    const ns = resolveNamespace(type);
    const list = out.get(ns) ?? [];
    if (!list.includes(fact.idSpace)) list.push(fact.idSpace);
    out.set(ns, list);
  }
  return out;
}

/** What to ask, in order of preference (see the file comment). */
export function idLookupCandidates(query: string, catalogue: Pick<BmpTypeCatalogue, 'types'>): IdCandidate[] {
  const byNs = spacesByNamespace(catalogue);
  const all = [...new Set([...byNs.values()].flat())];
  const ordered = [...new Set([...ID_SPACES.flatMap(ns => byNs.get(ns) ?? []), ...all])];
  const out: IdCandidate[] = [];
  const dot = query.indexOf('.');
  if (dot > 0) {
    const ns = query.slice(0, dot);
    const rest = query.slice(dot + 1);
    if (rest && isValidNamespace(ns)) for (const space of byNs.get(ns) ?? []) out.push({ space, id: rest });
  }
  for (const space of ordered) out.push({ space, id: query });
  return out;
}

/** The first candidate the server knows: its RID, or null when none is
 *  known. Undefined when the lookup could not be made (every post failed):
 *  the caller may fall back to the script lookup. */
export async function lookupIdByCommand(
  client: { fetchTypeCatalogue(signal?: AbortSignal): Promise<BmpTypeCatalogue>; resolvePolicyReferences(refs: Array<{ token: string; space: string; id: string }>, signal?: AbortSignal): Promise<{ references: Record<string, { rid: string } | null>; unavailable: string[] }> },
  query: string,
  catalogue: () => Promise<BmpTypeCatalogue>,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  let cat: BmpTypeCatalogue;
  try { cat = await catalogue(); } catch { signal?.throwIfAborted(); return undefined; }
  const candidates = idLookupCandidates(query, cat);
  if (!candidates.length) return undefined;
  const refs = candidates.map((c, i) => ({ token: String(i), space: c.space, id: c.id }));
  const res = await client.resolvePolicyReferences(refs, signal);
  const lost = new Set(res.unavailable);
  for (const r of refs) {
    if (lost.has(r.token)) return undefined; // not asked: no answer to trust beyond here
    const f = res.references[r.token];
    if (f?.rid) return f.rid;
  }
  return null;
}

/** A reference as written in code: `ns.id` (namespace and business ID). */
export interface IdRef { key: string; ns: string; id: string }

/**
 * RIDs of code references (`t.some_id`, `t.get("x-1")`) without Extended
 * Code: the ID in each ID space of its namespace (the order of the
 * catalogue), as Extended Code reads `ns.id`; every reference of the call in
 * the same posts (32 lookups a post). Per key: the RID, null (no object with
 * that ID in the namespace) or undefined (not answered: the namespace has no
 * ID space in the catalogue, or its post was lost; the caller's script
 * lookup answers those). The whole call is undefined when the catalogue
 * cannot be read.
 */
export async function lookupRefsByCommand(
  client: { resolvePolicyReferences(refs: Array<{ token: string; space: string; id: string }>, signal?: AbortSignal): Promise<{ references: Record<string, { rid: string; model?: string } | null>; unavailable: string[] }> },
  refs: readonly IdRef[],
  catalogue: () => Promise<Pick<BmpTypeCatalogue, 'types'>>,
  signal?: AbortSignal,
  /** Filled with key → model key for every found reference: the same
   *  answer carries it (no extra command). */
  models?: Map<string, string>,
): Promise<Map<string, string | null | undefined> | undefined> {
  let cat: Pick<BmpTypeCatalogue, 'types'>;
  try { cat = await catalogue(); } catch { signal?.throwIfAborted(); return undefined; }
  const byNs = spacesByNamespace(cat);
  const asks: Array<{ token: string; space: string; id: string }> = [];
  const plan = new Map<string, string[]>();
  for (const r of refs) {
    if (plan.has(r.key) || !isValidNamespace(r.ns) || !r.id) continue;
    const tokens = (byNs.get(r.ns) ?? []).map(space => {
      const token = String(asks.length);
      asks.push({ token, space, id: r.id });
      return token;
    });
    plan.set(r.key, tokens);
  }
  const out = new Map<string, string | null | undefined>();
  const res = asks.length ? await client.resolvePolicyReferences(asks, signal) : { references: {}, unavailable: [] as string[] };
  const lost = new Set(res.unavailable);
  for (const r of refs) {
    const tokens = plan.get(r.key);
    if (!tokens?.length) { out.set(r.key, undefined); continue; }
    let answer: string | null | undefined = null;
    for (const t of tokens) {
      if (lost.has(t)) { answer = undefined; break; }
      const f = res.references[t];
      if (f?.rid) {
        answer = f.rid;
        if (models && typeof f.model === 'string' && f.model) models.set(r.key, f.model);
        break;
      }
    }
    out.set(r.key, answer);
  }
  return out;
}

const catalogues = new WeakMap<object, { epoch: number; p: Promise<BmpTypeCatalogue> }>();
/** The type catalogue of a connection (one LoadTypeConfigCommand, about
 *  300 KB), kept while its command session lasts; a failed read is asked
 *  again next time. */
export function cachedTypeCatalogue(client: { fetchTypeCatalogue(signal?: AbortSignal): Promise<BmpTypeCatalogue>; sessionEpoch?: number }): Promise<BmpTypeCatalogue> {
  const epoch = client.sessionEpoch ?? 0;
  const hit = catalogues.get(client);
  if (hit && hit.epoch === epoch) return hit.p;
  const p = client.fetchTypeCatalogue(AbortSignal.timeout(60_000));
  catalogues.set(client, { epoch, p });
  p.catch(() => { if (catalogues.get(client)?.p === p) catalogues.delete(client); });
  return p;
}
