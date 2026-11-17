import type { AccessModel, AccessSnapshot } from '../lib/access-workspace/model';
import type { SavedWorkspace } from './workspace.js';

export function encodeWorkspaceState(state: Record<string, unknown>): unknown;
export function decodeWorkspaceState(state: unknown): Record<string, unknown>;
export function stateAfterApply(state: Record<string, unknown>, model: AccessModel, mapping?: Record<string, string>): Record<string, unknown>;
export function recoverAppliedWorkspace(saved: SavedWorkspace, receipt: {
  draft: AccessModel; snapshot: AccessSnapshot; mapping: Record<string, string>;
}): SavedWorkspace | undefined;
