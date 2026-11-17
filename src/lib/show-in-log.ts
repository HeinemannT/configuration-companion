/**
 * "Show in Log" for an error toast, in the context that shows the toast.
 *
 * - Side panel: the Log tab is one click away. With the entry's id the panel
 *   switches to it directly; without one the worker records the error first.
 * - BMP page (content script): the worker opens the side panel from the click
 *   (Chrome carries the user's click through a runtime message) and shows the
 *   entry. When the worker cannot open the panel, the error details go to the
 *   clipboard instead and the toast says so.
 */

import type { InspectorMessage } from './types';
import { copyText } from './copy-feedback';
import { sendRequest } from './messaging';
import { setShowInLogHandler, showToast, type ShowInLogRequest } from './toast';

export const COPIED_ERROR_TEXT = 'Copied the error details: open the side panel’s Log to see more.';
export const COPY_ERROR_FAILED_TEXT = 'Could not open the Log or copy the error details.';

export interface PageShowInLogDeps {
  send: (msg: InspectorMessage) => Promise<InspectorMessage | undefined>;
  copy: (text: string) => Promise<boolean>;
  toast: typeof showToast;
}

const defaultDeps: PageShowInLogDeps = { send: (msg) => sendRequest(msg), copy: copyText, toast: showToast };

export function errorDetailText(request: ShowInLogRequest): string {
  return request.detail ? `${request.text}\n${request.detail}` : request.text;
}

/** Ask the worker to open the Log at the error; copy the details when it cannot. */
export async function showInLogFromPage(request: ShowInLogRequest, deps: PageShowInLogDeps = defaultDeps): Promise<boolean> {
  const reply = await deps.send({
    type: 'SHOW_IN_LOG',
    text: request.text,
    ...(request.detail ? { detail: request.detail } : {}),
    ...(request.logId != null ? { logId: request.logId } : {}),
  });
  if (reply?.type === 'SHOW_IN_LOG_RESULT' && reply.opened) return true;
  if (await deps.copy(errorDetailText(request))) {
    deps.toast(COPIED_ERROR_TEXT, 'info', undefined, { key: 'crev-show-in-log' });
  } else {
    deps.toast(COPY_ERROR_FAILED_TEXT, 'error', undefined, { key: 'crev-show-in-log', showInLog: false });
  }
  return false;
}

/** Content script: error toasts get the page-side action. */
export function installPageShowInLog(): void {
  setShowInLogHandler((request) => { void showInLogFromPage(request); });
}

/** Side panel: `reveal` switches to the Log tab at an entry; `ask` has the worker record the error first. */
export function installPanelShowInLog(
  reveal: (logId: number) => void,
  ask: (request: ShowInLogRequest) => void,
): void {
  setShowInLogHandler((request) => {
    if (request.logId != null) reveal(request.logId);
    else ask(request);
  });
}
