import {
  DEFAULT_PORTABLE_ID_CONFIG,
  portableIdPatternError,
  type PortableIdConfig,
} from '../lib/layout/portable-ids';
import type { BlueprintCtx } from '../lib/layout/sync';
import { sendRequest } from '../lib/messaging';
import { showToast } from '../lib/toast';
import type { InspectorMessage } from '../lib/types';
import { bp } from './state';
import { render } from './view';

/** Global by design: a portable-ID recipe should remain identical while the user moves between
 * environments. Storing it per server would recreate the very drift this feature prevents. The worker
 * keeps it (handlers/page-prefs.ts): extension storage is closed to content scripts. */
type PortableIdsData = Extract<InspectorMessage, { type: 'PORTABLE_IDS_DATA' }>;
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastValidPattern = DEFAULT_PORTABLE_ID_CONFIG.pattern;
let storageWriteQueue: Promise<void> = Promise.resolve();

/** Portable IDs are safe for shared template structures and for children
 * created directly under a standalone EditPage. */
export function portableIdsAvailable(ctx: BlueprintCtx | null | undefined): boolean {
  return ctx?.target === 'template' || ctx?.surface === 'edit-page';
}

/** Preserve call order when a debounced pattern write and an immediate toggle save overlap. */
function storeConfig(config: PortableIdConfig): Promise<void> {
  const write = storageWriteQueue
    .catch(() => {})
    .then(async () => {
      const res = await sendRequest<PortableIdsData>({ type: 'PORTABLE_IDS_SAVE', config: { enabled: config.enabled, pattern: config.pattern } });
      if (res?.type !== 'PORTABLE_IDS_DATA') throw new Error('Blueprint IDs: the setting was not saved.');
    });
  storageWriteQueue = write;
  return write;
}

function normalize(raw: unknown): PortableIdConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PORTABLE_ID_CONFIG };
  const candidate = raw as Partial<PortableIdConfig>;
  const pattern = typeof candidate.pattern === 'string' && !portableIdPatternError(candidate.pattern)
    ? candidate.pattern
    : DEFAULT_PORTABLE_ID_CONFIG.pattern;
  return { enabled: candidate.enabled === true, pattern };
}

export async function loadPortableIdConfig(): Promise<void> {
  bp.idConfigStatus = 'loading';
  try {
    const res = await sendRequest<PortableIdsData>({ type: 'PORTABLE_IDS_GET' });
    if (res?.type !== 'PORTABLE_IDS_DATA') throw new Error('no answer');
    bp.idConfig = normalize(res.config);
    lastValidPattern = bp.idConfig.pattern;
    bp.idConfigStatus = 'ready';
  } catch {
    bp.idConfigStatus = 'error';
    bp.idConfig = { ...DEFAULT_PORTABLE_ID_CONFIG };
    lastValidPattern = bp.idConfig.pattern;
  }
  if (bp.active) render();
}

export function setPortableIdPatternDraft(pattern: string): string | null {
  bp.idConfig = { ...bp.idConfig, pattern };
  const error = portableIdPatternError(pattern);
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  if (!error) {
    lastValidPattern = pattern;
    const snapshot = { ...bp.idConfig };
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      void storeConfig(snapshot)
        .catch(() => showToast('Blueprint IDs: could not save the setting.', 'error'));
    }, 350);
  }
  return error;
}

export async function savePortableIdConfig(next: PortableIdConfig): Promise<boolean> {
  const error = portableIdPatternError(next.pattern);
  if (error) {
    showToast(`Blueprint IDs: ${error}`, 'error');
    return false;
  }
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
  bp.idConfig = { ...next };
  bp.idConfigStatus = 'ready';
  if (bp.active) render();
  try {
    await storeConfig(bp.idConfig);
    lastValidPattern = bp.idConfig.pattern;
    return true;
  } catch {
    showToast('Blueprint IDs: could not save the setting.', 'error');
    return false;
  }
}

export function setPortableIdsEnabled(enabled: boolean): void {
  const pattern = portableIdPatternError(bp.idConfig.pattern)
    ? lastValidPattern
    : bp.idConfig.pattern;
  void savePortableIdConfig({ enabled, pattern });
}

export function persistPortableIdPattern(): void {
  void savePortableIdConfig(bp.idConfig);
}
