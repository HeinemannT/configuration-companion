import type { SwContext } from './sw-context';

export const ENVIRONMENT_CHANGED_ERROR =
  'This window was opened for another server than the one its page belongs to now. Nothing was saved. Reload the window to continue.';

/** Stable identity of a profile-bound context: its profile and resolved
 *  server. Every write carries the token of the data it was read from. */
export function environmentToken(ctx: SwContext): string {
  return `${ctx.settings?.activeProfileId ?? ''}@${ctx.client?.serverUrl ?? ''}`;
}

export function environmentMatches(ctx: SwContext, expected: string | undefined): boolean {
  if (expected) return expected === environmentToken(ctx);
  // Unit-test and migration harnesses may provide a deliberately partial
  // SwContext. A real service worker always binds a profile; there,
  // omitting the token remains a hard failure.
  return !ctx.settings?.activeProfileId;
}

/** The sentence for a write whose environment is not the one its window's
 *  page belongs to now: names both servers and says nothing was written. */
export function environmentMismatchError(ctx: SwContext, expected: string | undefined): string {
  const profiles = ctx.settings?.profiles ?? [];
  const label = (token: string | undefined) => {
    const id = token?.split('@')[0];
    return profiles.find(p => p.id === id)?.label;
  };
  const from = label(expected);
  const now = label(environmentToken(ctx));
  if (from && now && from !== now) {
    return `This window was opened for “${from}”, but its page now belongs to “${now}”. Nothing was saved. Reload the window to work on “${now}”.`;
  }
  return ENVIRONMENT_CHANGED_ERROR;
}
