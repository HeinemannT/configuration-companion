/** The one-shot post-apply resume payload (sessionStorage[BP_RESUME_KEY]): the edit target to restore,
 *  plus a short result message to show once Blueprint is back. Pure so content.ts can import it without
 *  pulling in the Blueprint editor. */
export const BP_RESUME_TTL_MS = 30_000;

export interface ResumeNote { prefer: 'template' | 'instance'; message?: string }

export function encodeResume(prefer: 'template' | 'instance', message: string | undefined, now: number): string {
  return JSON.stringify({ prefer, t: now, ...(message ? { message } : {}) });
}

/** Parse a stored payload; null when malformed or older than the TTL. */
export function readResume(raw: string, now: number): ResumeNote | null {
  try {
    const r = JSON.parse(raw) as { prefer?: string; t?: number; message?: unknown };
    if (typeof r?.t !== 'number' || now - r.t >= BP_RESUME_TTL_MS) return null;
    return {
      prefer: r.prefer === 'instance' ? 'instance' : 'template',
      ...(typeof r.message === 'string' && r.message ? { message: r.message } : {}),
    };
  } catch { return null; }
}

export function appliedMessage(changes: number | undefined): string {
  return changes && changes > 0
    ? `Blueprint: ${changes} ${changes === 1 ? 'change' : 'changes'} applied.`
    : 'Blueprint: changes applied.';
}

/** The edit target the user chose for a page (page sessionStorage, this tab): a page set to
 *  "This instance" opens there again instead of on the shared template. */
export const BP_TARGET_KEY = 'crev_bp_target:';

export function rememberTarget(rid: string, prefer: 'template' | 'instance'): void {
  try { sessionStorage.setItem(BP_TARGET_KEY + rid, prefer); } catch { /* storage blocked: the default applies */ }
}

export function rememberedTarget(rid: string): 'template' | 'instance' | null {
  try {
    const v = sessionStorage.getItem(BP_TARGET_KEY + rid);
    return v === 'instance' || v === 'template' ? v : null;
  } catch { return null; }
}
