/**
 * The in-page copy scheme: one implementation for the badges and the hover
 * card, so both copy the same value for the same gesture and report it the
 * same way (one toast, replaced by the next copy).
 *
 *   click          ID (the template ID when there is one)
 *   Shift-click    RID
 *   Alt-click      Instance ID (the ID when they are the same)
 *   Ctrl/Cmd-click Reference
 *
 * A kind the object has no value for copies nothing and says so.
 */

import { loadingMessage, resolveCopyKind, type CopyableIdentity, type CopyKind } from './lib/namespace';
import { copyTextResult, copyFailureMessage, type CopyResult } from './lib/copy-feedback';
import { showToast } from './lib/toast';

/** Toast key: every copy replaces the previous copy toast. */
const COPY_TOAST_KEY = 'crev-copy';

export interface CopyOutcome {
  ok: boolean;
  /** What was put on the clipboard; empty when nothing was. */
  text: string;
}

/**
 * Copy one kind of `identity` and show the result as a toast.
 * `loading`: the object's details have not arrived yet, so a missing value
 * means "not known yet" rather than "this object has none".
 */
export async function copyIdentity(
  identity: CopyableIdentity,
  kind: CopyKind,
  options: { loading?: boolean; write?: (text: string) => Promise<boolean> } = {},
): Promise<CopyOutcome> {
  const choice = resolveCopyKind(identity, kind);
  if (!choice.text) {
    const message = options.loading && kind !== 'rid' ? loadingMessage(kind) : choice.missing;
    showToast(message, 'info', undefined, { key: COPY_TOAST_KEY });
    return { ok: false, text: '' };
  }
  const result: CopyResult = options.write
    ? { ok: await options.write(choice.text), reason: 'blocked' }
    : await copyTextResult(choice.text);
  const ok = result.ok;
  if (ok) {
    showToast(`Copied ${choice.label}`, 'success', undefined, { key: COPY_TOAST_KEY, detail: choice.text });
  } else {
    showToast(copyFailureMessage(result.reason), 'error', undefined, { key: COPY_TOAST_KEY });
  }
  return { ok, text: ok ? choice.text : '' };
}
