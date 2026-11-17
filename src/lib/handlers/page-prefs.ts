/**
 * The page layer's own preferences, served by the worker.
 *
 * Extension storage is closed to content scripts (storage-access.ts), so a
 * content script asks here for the one value it needs: where an in-page
 * window was last placed, and the Blueprint portable-ID recipe. Each request
 * reads or writes exactly one fixed key; every value is validated on the way
 * in and on the way out, so nothing else in storage can be reached this way.
 */

import { register } from '../handler-registry';
import { log } from '../logger';
import {
  DEFAULT_PORTABLE_ID_CONFIG,
  portableIdPatternError,
  type PortableIdConfig,
} from '../layout/portable-ids';
import type { FrameKind } from '../types';

export const FRAME_BOUNDS_KEY_PREFIX = 'crev_overlay_bounds_';
export const PORTABLE_IDS_KEY = 'crev_blueprint_portable_ids';

const FRAME_KINDS: ReadonlySet<string> = new Set<FrameKind>(['editor', 'diff', 'objectview', 'codesearch', 'transport', 'cvo-studio']);
/** Larger than any screen; anything beyond is not a window position. */
const MAX_COORD = 100_000;
const MAX_PATTERN = 200;

type Bounds = { left: number; top: number; width: number; height: number };

export function isFrameKind(kind: unknown): kind is FrameKind {
  return typeof kind === 'string' && FRAME_KINDS.has(kind);
}

/** Four finite numbers in screen range, sizes positive; null otherwise. */
export function validBounds(value: unknown): Bounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const out: Partial<Bounds> = {};
  for (const k of ['left', 'top', 'width', 'height'] as const) {
    const n = v[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_COORD) return null;
    out[k] = n;
  }
  if (out.width! <= 0 || out.height! <= 0) return null;
  return out as Bounds;
}

/** A stored or submitted recipe, reduced to its two known fields. A bad
 *  pattern falls back to the default; `enabled` is true only when it is. */
export function validPortableIdConfig(value: unknown): PortableIdConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_PORTABLE_ID_CONFIG };
  const v = value as Record<string, unknown>;
  const pattern = typeof v.pattern === 'string' && v.pattern.length <= MAX_PATTERN && !portableIdPatternError(v.pattern)
    ? v.pattern
    : DEFAULT_PORTABLE_ID_CONFIG.pattern;
  return { enabled: v.enabled === true, pattern };
}

register('FRAME_BOUNDS_GET', async (msg, respond) => {
  if (!isFrameKind(msg.kind)) { respond({ type: 'FRAME_BOUNDS_DATA', bounds: null }); return; }
  const key = FRAME_BOUNDS_KEY_PREFIX + msg.kind;
  try {
    const stored = await chrome.storage.local.get(key);
    respond({ type: 'FRAME_BOUNDS_DATA', bounds: validBounds(stored[key]) });
  } catch (e) {
    log.swallow('pagePrefs:boundsGet', e);
    respond({ type: 'FRAME_BOUNDS_DATA', bounds: null });
  }
});

register('FRAME_BOUNDS_SAVE', async (msg, respond) => {
  const bounds = validBounds(msg.bounds);
  if (!isFrameKind(msg.kind) || !bounds) { respond({ type: 'FRAME_BOUNDS_DATA', bounds: null }); return; }
  try {
    await chrome.storage.local.set({ [FRAME_BOUNDS_KEY_PREFIX + msg.kind]: bounds });
    respond({ type: 'FRAME_BOUNDS_DATA', bounds });
  } catch (e) {
    log.swallow('pagePrefs:boundsSave', e);
    respond({ type: 'FRAME_BOUNDS_DATA', bounds: null });
  }
});

register('PORTABLE_IDS_GET', async (_msg, respond) => {
  const stored = await chrome.storage.local.get(PORTABLE_IDS_KEY);
  respond({ type: 'PORTABLE_IDS_DATA', config: validPortableIdConfig(stored[PORTABLE_IDS_KEY]) });
});

register('PORTABLE_IDS_SAVE', async (msg, respond) => {
  const raw = msg.config as unknown;
  const config = validPortableIdConfig(raw);
  // A pattern that does not survive validation is refused, not replaced by
  // the default: the caller shows its own error and keeps the stored recipe.
  if (typeof raw !== 'object' || raw === null || (raw as { pattern?: unknown }).pattern !== config.pattern) {
    throw new Error('Not a valid ID pattern.');
  }
  await chrome.storage.local.set({ [PORTABLE_IDS_KEY]: config });
  respond({ type: 'PORTABLE_IDS_DATA', config });
});
