import type { AccessRequest, AccessSnapshot, AccessModel } from '../lib/access-workspace/model';
import type { AccessDestination } from '../lib/access-workspace/entry';
export interface SavedWorkspace {
  version: 1; snapshot: AccessSnapshot; model: AccessModel; baseline: AccessModel;
  /** Session-local configuration revision. View-only changes retain this value. */
  revision?: number;
  context?: unknown;
  state?: unknown; history?: number[]; future?: number[]; journal?: unknown[]; historySequence?: number;
}
export function mountWorkspace(options: {
  snapshot: AccessSnapshot; saved?: SavedWorkspace;
  api: (request: AccessRequest, options?: { signal?: AbortSignal }) => Promise<unknown>;
  persist: (data: () => SavedWorkspace, immediate?: boolean) => Promise<void>;
  busy: (text: string) => void; notice: (text: string) => void;
}): { flush(): Promise<void>; hasDraft(): boolean; enter(destination: AccessDestination): void; focusArrival(): void };
