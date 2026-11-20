/**
 * Point and tell: Screenshot. A picture of what the window shows, with the ink and the number badges on
 * it, ready to paste into an AI chat beside the copied text. The dock, the comment field, the list and the
 * highlight are hidden for the moment of the capture and come back after. The worker takes the picture
 * (`chrome.tabs.captureVisibleTab`, which needs `activeTab`: Chrome gives it when the user invokes the
 * extension on the tab, by shortcut or right-click menu); without it, Chrome's own capture of this tab from
 * the page. Only the visible part of the page is captured, there is no scrolling capture.
 *
 * The picture goes to the clipboard; when the browser refuses an image there, it is saved as a file.
 */
import { sendRequest } from '../lib/messaging';
import { showToast } from '../lib/toast';
import type { InspectorMessage } from '../lib/types';
import { syncShotButton } from './dock';
import { pt } from './state';

type CaptureResult = Extract<InspectorMessage, { type: 'POINT_TELL_CAPTURE_DATA' }>;

const nextFrame = (): Promise<void> => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (): Promise<void> => { await nextFrame(); await nextFrame(); await new Promise(r => setTimeout(r, 80)); };

/** Elements that must not be in the picture (`sent`: also the badges of marks sent before, for a picture that goes with the next sketch, whose numbers are its own). Returns what puts them back. */
function hideChrome(sent = false): () => void {
  const hidden: Array<{ el: HTMLElement; visibility: string }> = [];
  const hide = (el: Element | null | undefined): void => {
    if (!(el instanceof HTMLElement)) return;
    hidden.push({ el, visibility: el.style.visibility });
    el.style.visibility = 'hidden';
  };
  hide(pt.dock); hide(pt.fieldEl); hide(pt.hoverEl); hide(pt.panelEl); hide(pt.sentEl); hide(pt.replyEl);
  if (sent) pt.pinLayer?.querySelectorAll('.pt-badge.pt-sent').forEach(hide);
  pt.layer?.querySelectorAll('.pt-tip-badge').forEach(hide);
  hide(document.getElementById('crev-toast-container'));
  return () => { for (const h of hidden) h.el.style.visibility = h.visibility; };
}

function blobOf(dataUrl: string): Blob | null {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

const stamp = (): string => {
  const d = new Date(), p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function saveAsFile(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `point-and-tell-${stamp()}.png`;
  a.style.display = 'none';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Chrome refuses `captureVisibleTab` without `activeTab`, which only an invocation on the tab gives. */
export const isPermissionRefusal = (error: string | undefined): boolean => /activeTab|all_urls|permission/i.test(error ?? '');

export const NEEDS_INVOCATION = 'Open Point and tell with its shortcut or from the right-click menu to take pictures.';

export type CaptureOutcome = { blob: Blob } | { error: string };

/**
 * The decision: the worker's picture first. When Chrome refuses for lack of permission, Chrome's own capture
 * of this tab (`viaDisplay`, which throws when the user declines or the browser has none); when that fails
 * too, the sentence that says what to do. Any other failure of the worker is reported as it is.
 */
export async function captureWithFallback(deps: {
  viaWorker: () => Promise<{ ok: boolean; dataUrl?: string; error?: string } | undefined>;
  viaDisplay: () => Promise<Blob>;
}): Promise<CaptureOutcome> {
  const res = await deps.viaWorker();
  if (res?.ok && res.dataUrl) {
    const blob = blobOf(res.dataUrl);
    return blob ? { blob } : { error: 'Could not take a picture.' };
  }
  if (!isPermissionRefusal(res?.error)) return { error: `Could not take a picture: ${res?.error ?? 'no answer from Companion'}` };
  try { return { blob: await deps.viaDisplay() }; }
  catch { return { error: NEEDS_INVOCATION }; }
}

/** One frame of a tab stream as a PNG. The track is stopped before this returns. */
export async function frameFromStream(stream: MediaStream, whenReady: () => Promise<void>): Promise<Blob> {
  const video = document.createElement('video');
  video.muted = true; video.srcObject = stream;
  try {
    await new Promise<void>((ok, bad) => { video.onloadedmetadata = () => ok(); video.onerror = () => bad(new Error('no frame')); });
    await video.play();
    await whenReady();
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) throw new Error('no frame');
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no canvas');
    g.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('no frame');
    return blob;
  } finally {
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

/**
 * Chrome's own capture of the current tab. Nothing is hidden or held while its prompt is open; the page is
 * cleared only once the stream is granted. A stream that arrives after the mode was left is stopped at once.
 */
export async function viaDisplayMedia(isCurrent: () => boolean): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('unavailable');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true } as DisplayMediaStreamOptions);
  if (!isCurrent()) { stream.getTracks().forEach(t => t.stop()); throw new Error('left'); }
  const restore = hideChrome();
  try { return await frameFromStream(stream, settle); }
  finally { restore(); }
}

/**
 * One Screenshot press at a time, and nothing else is ever held: a second press while Chrome's prompt is open
 * does nothing, and whatever the prompt ends in (picture, decline, dismissal, error) the waiting mark is taken
 * off in a finally. Resolves with the outcome, or null when the press was ignored or the mode was left meanwhile.
 */
export function createShotRun(deps: {
  isCurrent: () => boolean;
  run: () => Promise<CaptureOutcome>;
  setWaiting: (waiting: boolean) => void;
}): { press: () => Promise<CaptureOutcome | null>; waiting: () => boolean } {
  let waiting = false;
  return {
    waiting: () => waiting,
    async press() {
      if (waiting || !deps.isCurrent()) return null;
      waiting = true;
      deps.setWaiting(true);
      let out: CaptureOutcome;
      try { out = await deps.run(); }
      catch { out = { error: NEEDS_INVOCATION }; }
      finally { waiting = false; deps.setWaiting(false); }
      return deps.isCurrent() ? out : null;
    },
  };
}

const setWaiting = (waiting: boolean): void => { pt.shotWaiting = waiting; syncShotButton(); };

/** The mode is on and is the same opening as when the press began. */
const shot = createShotRun({
  isCurrent: () => pt.active,
  run: () => {
    const gen = pt.gen;
    const current = (): boolean => pt.active && pt.gen === gen;
    return captureWithFallback({
      viaWorker: async () => {
        const restore = hideChrome();
        try { await settle(); return await sendRequest<CaptureResult>({ type: 'POINT_TELL_CAPTURE' }); }
        finally { restore(); }
      },
      viaDisplay: () => viaDisplayMedia(current),
    });
  },
  setWaiting,
});

/** Chrome's prompt is open: Copy says so when the browser keeps it from writing. */
export const screenshotWaiting = (): boolean => shot.waiting();

export async function takeScreenshot(): Promise<void> {
  const gen = pt.gen;
  const out = await shot.press();
  if (!out || pt.gen !== gen) return;
  if ('error' in out) { showToast(out.error, 'error', undefined, { key: 'crev-pt-shot' }); return; }
  pt.shot = true;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('no image clipboard');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': out.blob })]);
    showToast('Screenshot copied to the clipboard.', 'success', undefined, { key: 'crev-pt-shot' });
  } catch {
    saveAsFile(out.blob);
    showToast('Screenshot saved as a file.', 'info', undefined, { key: 'crev-pt-shot' });
  }
}

let refusedIn = -1;

/**
 * A picture for Send to Claude, without any prompt: the worker's picture only. Chrome refuses it when the mode was
 * not started by the shortcut or the right-click menu; the refusal is remembered for this opening so the dock does
 * not blink on every send. Null means send the text alone.
 */
export async function captureForSend(): Promise<Blob | null> {
  const gen = pt.gen;
  if (refusedIn === gen) return null;
  const restore = hideChrome(true);
  let res: CaptureResult | undefined;
  try { await settle(); res = await sendRequest<CaptureResult>({ type: 'POINT_TELL_CAPTURE' }); }
  finally { restore(); }
  if (res?.ok && res.dataUrl) return blobOf(res.dataUrl);
  if (isPermissionRefusal(res?.error)) refusedIn = gen;
  return null;
}
