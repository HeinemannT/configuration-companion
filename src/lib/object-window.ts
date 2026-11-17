/**
 * Object window read path (service-worker side).
 *
 * `openObjectRoot` turns one rid into everything the window paints:
 * the root read, its structure listing and the structure nodes' reads.
 * Round trips:
 *  - type known up front with a structure rule: EC listing, then ONE batched
 *    read of root + nodes (2 posts);
 *  - otherwise: root read, then (if its type has a rule) listing + batch.
 * The transport serialises posts, so nothing here fans out per child.
 *
 * Only the root read is fatal. A failed listing or a failed node batch is
 * reported in the payload and the window shows the root alone. A batch that
 * fails because of one object is halved and retried until that object is
 * isolated; its error goes to `nodeErrors` and the other nodes still load.
 */

import type { FullObject } from './object-read';
import { STRUCTURE_MAX_NODES, type StructureRow, type StructureRows, type StructureRule } from './object-structure';
import { typeInfo } from './object-window-table';
import { errorMessage } from './logger';
import { readIsolating, isObjectLevelError } from './batch-isolate';
import { errorKindOf, isConnectionKind } from './error-kind';
import type { RowFactsRead } from './object-row-facts';
import { rowFactsFailure, type RowFactsFailure } from './row-facts-status';

export interface ObjectRootPayload {
  rid: string;
  root: FullObject;
  /** null when no structure applies or the listing failed. */
  rows: StructureRow[] | null;
  structureError?: string;
  /** Set to the cap when the listing had more nodes than the cap; `rows`
   *  then holds the first ones only. */
  structureTruncatedAt?: number;
  /** Set when the root's binary read failed on the server and the window
   *  shows identity and known properties from the Extended Code fallback. */
  rootFallback?: string;
  /** Batched reads of the listed nodes, keyed by rid. */
  nodes: Record<string, FullObject>;
  nodeErrors?: Record<string, string>;
  /** The rows' facts (names, types, markers) could not be read for some
   *  rows: why, in a form the tree turns into one line with Retry. */
  rowFactsError?: RowFactsFailure;
  /** Number of HTTP posts and total time (diagnostics). */
  posts: number;
  ms: number;
}

/** Result of a batched object read. `failedChunks` lists the server chunks
 *  that BMP rejected as a whole; their rids are also in `errors`. */
export interface FullObjectsRead {
  objects: Record<string, FullObject>;
  errors: Record<string, string>;
  failedChunks?: Array<{ rids: string[]; error: string }>;
}

export interface ObjectReader {
  readFullObjects(rids: readonly string[], signal?: AbortSignal): Promise<FullObjectsRead>;
  fetchStructureRows(rid: string, rule: StructureRule, signal?: AbortSignal): Promise<StructureRows>;
  /** Extended Code fallback for the root when the binary read fails on the
   *  server (some objects on older servers). Optional. */
  readRootFallback?(rid: string, signal?: AbortSignal): Promise<FullObject | null>;
  /** The facts tree rows need (object-row-facts.ts), instead of full reads
   *  of every node. Optional: without it the nodes are read in full. */
  readRowFacts?(rids: readonly string[], signal?: AbortSignal): Promise<RowFactsRead>;
}

export class RootReadError extends Error {
  constructor(message: string, readonly serverSide = false) {
    super(message);
  }
}

/** Line shown in the window when the root came from the fallback read. */
export const ROOT_FALLBACK_NOTE = 'The full property list is unavailable on this server.';

/** A whole-batch failure: thrown inside the isolating read so it halves. */
class ChunkReadError extends Error {}

export interface IsolatedObjectsRead {
  objects: Record<string, FullObject>;
  /** Per-rid failures, including rids isolated by halving. */
  errors: Record<string, string>;
  /** Rids not answered because the request budget ran out. */
  unresolved: string[];
  error?: string;
  requests: number;
}

/** Read `ids` in batches; when BMP rejects a whole batch because of one
 *  object, halve and retry only that batch (see batch-isolate.ts). Chunks
 *  that already succeeded are never read again. Connection errors throw. */
export async function readObjectsIsolating(reader: ObjectReader, ids: readonly string[], signal?: AbortSignal): Promise<IsolatedObjectsRead> {
  const acc: IsolatedObjectsRead = { objects: {}, errors: {}, unresolved: [], requests: 0 };
  const readSome = async (batch: string[]): Promise<FullObjectsRead> => {
    const result = await reader.readFullObjects(batch, signal);
    const failed = result.failedChunks ?? [];
    const failedCount = failed.reduce((n, c) => n + c.rids.length, 0);
    // Nothing of this batch was read: let the isolating read halve it.
    if (failed.length && failedCount >= batch.length) throw new ChunkReadError(failed[0].error);
    return result;
  };
  const run = async (list: readonly string[]): Promise<void> => {
    const isolated = await readIsolating(list, readSome, { signal });
    acc.requests += isolated.requests;
    const retry: string[][] = [];
    for (const result of isolated.results) {
      Object.assign(acc.errors, result.errors);
      Object.assign(acc.objects, result.objects);
      for (const chunk of result.failedChunks ?? []) {
        for (const r of chunk.rids) delete acc.errors[r];
        retry.push(chunk.rids);
      }
    }
    Object.assign(acc.errors, isolated.failed);
    acc.unresolved.push(...isolated.unresolved);
    if (isolated.error) acc.error = isolated.error;
    // Only the chunk BMP rejected is read again; each one is one post, so it
    // either succeeds or fails whole and is halved.
    for (const chunk of retry) await run(chunk);
  };
  await run(ids);
  return acc;
}

export async function openObjectRoot(
  reader: ObjectReader,
  rid: string,
  typeHint?: string,
  signal?: AbortSignal,
): Promise<ObjectRootPayload> {
  const started = Date.now();
  let posts = 0;
  let rows: StructureRow[] | null = null;
  let structureError: string | undefined;
  let structureTruncatedAt: number | undefined;
  let rootFallback: string | undefined;
  const nodeErrors: Record<string, string> = {};
  let rowFactsError: RowFactsFailure | undefined;

  const listStructure = async (rule: StructureRule): Promise<void> => {
    posts++;
    try {
      const listed = await reader.fetchStructureRows(rid, rule, signal);
      rows = listed;
      if (listed.truncated) structureTruncatedAt = STRUCTURE_MAX_NODES;
    } catch (e) {
      signal?.throwIfAborted();
      structureError = errorMessage(e);
    }
  };

  /** The root could not be read. A server-side failure (not a connection
   *  failure) tries the Extended Code fallback before giving up. */
  const failRoot = async (message: string, serverSide: boolean): Promise<FullObject> => {
    if (serverSide && reader.readRootFallback) {
      posts++;
      let fallback: FullObject | null = null;
      try {
        fallback = await reader.readRootFallback(rid, signal);
      } catch (e) {
        signal?.throwIfAborted();
        throw new RootReadError(`${message} (fallback read failed: ${errorMessage(e)})`, true);
      }
      if (fallback) {
        rootFallback = ROOT_FALLBACK_NOTE;
        return fallback;
      }
    }
    throw new RootReadError(message, serverSide);
  };

  const readRootAlone = async (): Promise<FullObject> => {
    posts++;
    let result: FullObjectsRead;
    try {
      result = await reader.readFullObjects([rid], signal);
    } catch (e) {
      signal?.throwIfAborted();
      return failRoot(errorMessage(e), isObjectLevelError(e) && !isConnectionKind(errorKindOf(e)));
    }
    const obj = result.objects[rid];
    if (obj) return obj;
    const error = result.errors[rid];
    // No error means BMP answered without data: the object does not exist.
    return error ? failRoot(error, true) : failRoot('Object not found', false);
  };

  /** Batch-read the listed nodes (plus the root when `withRoot`). A failed
   *  batch leaves the nodes unread; only the root is required. */
  const readBatch = async (withRoot: boolean): Promise<{ root?: FullObject; nodes: Record<string, FullObject> }> => {
    const nodeRids = (rows ?? []).map(r => r.rid).filter(r => r !== rid);
    if (!withRoot && nodeRids.length === 0) return { nodes: {} };
    // Only the root is read in full; the rows get their facts from one
    // small script per 50 nodes (object-row-facts.ts). A node is read in
    // full when it is selected.
    if (reader.readRowFacts) {
      const root = withRoot ? await readRootAlone() : undefined;
      if (!nodeRids.length) return { root, nodes: {} };
      try {
        const facts = await reader.readRowFacts(nodeRids, signal);
        posts += facts.posts;
        if (facts.error) rowFactsError = facts.error;
        for (const r of nodeRids) if (!facts.objects[r]) nodeErrors[r] = facts.error?.message ?? 'Object not found';
        return { root, nodes: facts.objects };
      } catch (e) {
        posts++;
        signal?.throwIfAborted();
        rowFactsError = rowFactsFailure(e, nodeRids.length);
        for (const r of nodeRids) nodeErrors[r] = errorMessage(e);
        return { root, nodes: {} };
      }
    }
    const ids = withRoot ? [rid, ...nodeRids] : nodeRids;
    let isolated: IsolatedObjectsRead;
    try {
      // BMP fails the whole batch when one object cannot be read: halve and
      // retry until the failing rids are isolated (see batch-isolate.ts).
      isolated = await readObjectsIsolating(reader, ids, signal);
    } catch (e) {
      posts++;
      signal?.throwIfAborted();
      for (const r of nodeRids) nodeErrors[r] = errorMessage(e);
      return withRoot ? { root: await readRootAlone(), nodes: {} } : { nodes: {} };
    }
    posts += isolated.requests;
    Object.assign(nodeErrors, isolated.errors);
    for (const r of isolated.unresolved) nodeErrors[r] = isolated.error ?? 'Object read failed';
    const { [rid]: read, ...nodes } = isolated.objects;
    let root = read;
    // The budget ran out before the root was read on its own: read it alone.
    if (withRoot && !root && isolated.unresolved.includes(rid)) {
      delete nodeErrors[rid];
      root = await readRootAlone();
    }
    // The batch already read the root: a second binary read would only
    // repeat the same answer. A server-side failure tries the fallback.
    if (withRoot && !root) {
      const error = nodeErrors[rid];
      delete nodeErrors[rid];
      root = await (error ? failRoot(error, true) : failRoot('Object not found', false));
    }
    delete nodeErrors[rid];
    return { root, nodes };
  };

  const hinted = typeHint ? typeInfo(typeHint).structure : undefined;
  let root: FullObject;
  let nodes: Record<string, FullObject>;
  if (hinted) {
    await listStructure(hinted);
    const batch = await readBatch(true);
    root = batch.root!;
    nodes = batch.nodes;
    // The hint can be stale; drop the listing if the root's type disagrees.
    if (root.type && typeHint && root.type !== typeHint && !typeInfo(root.type).structure) {
      rows = null;
      nodes = {};
      structureTruncatedAt = undefined;
      rowFactsError = undefined;
    }
  } else {
    root = await readRootAlone();
    const rule = typeInfo(root.type).structure;
    if (rule) {
      await listStructure(rule);
      nodes = (await readBatch(false)).nodes;
    } else {
      nodes = {};
    }
  }

  return {
    rid,
    root,
    rows,
    ...(structureError ? { structureError } : {}),
    ...(structureTruncatedAt ? { structureTruncatedAt } : {}),
    ...(rootFallback ? { rootFallback } : {}),
    nodes,
    ...(Object.keys(nodeErrors).length ? { nodeErrors } : {}),
    ...(rowFactsError ? { rowFactsError } : {}),
    posts,
    ms: Date.now() - started,
  };
}
