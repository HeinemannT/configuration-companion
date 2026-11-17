/**
 * editor-core / overlay — shared wiring for an editor that lives in an in-page
 * frame overlay (the EC editor and the CVO studio): the Esc→close keybinding
 * and the unsaved-changes guards. Both surfaces had byte-identical copies of
 * this safety-critical code; one home prevents them drifting apart.
 */
import type { KeyBinding } from '@codemirror/view'
import { installCloseHandshake, watchDirtyForHost } from '../lib/frame-close-handshake'
import { confirmModal } from '../lib/modal'
import { escapeLayers } from '../lib/escape-layers'
import { discardTitle, DISCARD_LABEL, KEEP_EDITING_LABEL } from '../lib/unsaved'
import { postToParent } from '../lib/frame-parent'

/** postMessage type the in-page frame host listens for to close the overlay. */
export const OVERLAY_CLOSE_MESSAGE = 'CREV_OVERLAY_CLOSE_PLEASE'

/** Ask the host page to close this frame (the host runs the dirty check). */
export function requestOverlayClose(): void {
  try { postToParent({ type: OVERLAY_CLOSE_MESSAGE }) } catch { /* ignore */ }
}

/** Register the frame window as the outermost Escape layer and listen for
 *  Escape outside the code editor. Inner layers (cards, peeks, dialogs) are
 *  registered by their owners on the same stack. */
export function installWindowEscape(): void {
  const layers = escapeLayers()
  layers.register({ kind: 'window', name: 'frame', isOpen: () => true, close: () => { requestOverlayClose() } })
  layers.listen(document)
}

/** CodeMirror Esc binding: backs out one layer (the window last). CM's own
 *  Esc handlers (search panel, completion, multi-cursor, the reference card
 *  and peeks) run earlier in the keymap chain and consume the key first. */
export const closeOverlayKeyBinding: KeyBinding = {
  key: 'Escape',
  run: () => escapeLayers().escape(),
}

/** Wire the two unsaved-changes guards an overlay editor needs: the host
 *  close-request handshake (an in-app confirm) and the browser `beforeunload`
 *  prompt (the only reliable signal when the BMP host page navigates and the
 *  overlay iframe is about to be destroyed). */
export function installDirtyGuards(opts: {
  isDirty: () => boolean;
  /** How many unsaved changes, for the title ("Discard 3 unsaved changes?"). */
  count?: () => number;
  bodyText: string;
  onClose?: () => void | Promise<void>;
}): void {
  installCloseHandshake(async () => {
    if (!opts.isDirty()) return true
    try {
      return await confirmModal({ title: discardTitle(opts.count?.()), body: opts.bodyText, confirmLabel: DISCARD_LABEL, cancelLabel: KEEP_EDITING_LABEL, confirmVariant: 'danger' })
    } catch {
      // The prompt itself failed: a window with unsaved changes stays open rather than losing them.
      return false
    }
  }, opts.onClose)
  watchDirtyForHost(opts.isDirty)
  window.addEventListener('beforeunload', e => {
    if (!opts.isDirty()) return
    e.preventDefault()
    e.returnValue = ''
  })
}
