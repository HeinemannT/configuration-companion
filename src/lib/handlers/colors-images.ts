/**
 * Colors and images: the page in its own tab (colors-images/colors-images.html)
 * is opened from the side panel or from the image picker of a button; its own
 * requests are answered here.
 *
 *  - OPEN_COLORS_IMAGES: open the page, or bring forward the tab that is
 *    already open for this server (as the Access workspace does);
 *  - IMAGE_INDEX: the folders and image files, a dated copy read on demand;
 *  - IMAGE_BYTES: the bytes of a few image files (thumbnails), from the
 *    download servlet; nothing else reads file content;
 *  - COLORS_IMAGES_WRITE: add and change colors, add and change files. The
 *    script is previewed on the server first and written only when the
 *    preview raises no warning. The page confirms with the user before it
 *    asks and reads again afterwards; this handler does not undo.
 */
import { register, type HandlerMeta } from '../handler-registry';
import { ctxOf, getCtx, type SwContext } from '../sw-context';
import { environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { buildImageIndexEc, parseImageIndexLog } from '../colors-images/image-files';
import { buildColorWriteEc, buildFileWriteEc, SCRIPT_BUDGET, type FileOp } from '../colors-images/write-ops';
import { bytesToBase64 } from '../colors-images/image-process';
import { loadImageIndex } from '../image-index-cache';
import { userScript } from '../script-kinds';
import { errorMessage } from '../logger';
import type { ColorsImagesTab } from '../messages';

let launching: Promise<void> | undefined;

/** Open the page for the server of `ctx`, or bring its open tab forward. */
export async function openColorsImages(tab: ColorsImagesTab | undefined, source: Pick<HandlerMeta, 'senderTabId' | 'panelWindowId'> = {}, requester: SwContext = getCtx()): Promise<void> {
  const ctx = requester, environment = environmentToken(ctx);
  if (!ctx.client || !ctx.settings.activeProfileId) throw new Error('Choose a BMP connection in Companion first.');
  // The initiating tab, before a queued launch changes the active one.
  const opener = source.senderTabId != null ? await chrome.tabs.get(source.senderTabId).catch(() => undefined)
    : (await chrome.tabs.query({ active: true, ...(source.panelWindowId != null ? { windowId: source.panelWindowId } : { lastFocusedWindow: true }) }))[0];
  const task = (launching ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (environmentToken(ctx) !== environment) throw new Error('The connection changed. Open Colors and images again.');
    const base = chrome.runtime.getURL('colors-images/colors-images.html') + '?environment=' + encodeURIComponent(environment);
    const url = tab ? `${base}#tab=${tab}` : base;
    const existing = (await chrome.tabs.query({})).find(t => (t.url ?? t.pendingUrl)?.split('#')[0] === base);
    const origin = opener?.id != null ? await chrome.tabs.get(opener.id).catch(() => undefined) : undefined;
    if (existing?.id != null) {
      if (tab) {
        // A message reaches the open page without reloading it (its unsaved changes stay).
        const reply = await chrome.runtime.sendMessage({ type: 'COLORS_IMAGES_NAVIGATE', tabId: existing.id, environment, tab }).catch(() => undefined) as { ok?: boolean } | undefined;
        if (!reply?.ok) await chrome.tabs.update(existing.id, { url });
      }
      if (origin?.id != null && origin.id !== existing.id) {
        const index = origin.index + (existing.windowId === origin.windowId && existing.index < origin.index ? 0 : 1);
        if (existing.windowId !== origin.windowId || existing.index !== index) await chrome.tabs.move(existing.id, { windowId: origin.windowId, index });
      }
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(origin?.windowId ?? existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url, ...(origin?.id != null ? { windowId: origin.windowId, index: origin.index + 1, openerTabId: origin.id } : {}) });
    }
  });
  launching = task;
  try { await task; } finally { if (launching === task) launching = undefined; }
}

register('OPEN_COLORS_IMAGES', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  try { await openColorsImages(msg.tab, meta, ctx); } catch (e) { ctx.toast(errorMessage(e), 'error'); }
});

register('IMAGE_INDEX', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  if (!ctx.client) { respond({ type: 'IMAGE_INDEX_DATA', ok: false, environment, error: 'Not connected' }); return; }
  const client = ctx.client;
  try {
    const loaded = await loadImageIndex(environment, async () => {
      const r = await client.executeEc(buildImageIndexEc());
      if (!r.ok) throw new Error(r.error || r.log || 'The image files could not be read');
      if (r.hasWarning) throw new Error(r.error || 'The image files were read with warnings and may be incomplete');
      return parseImageIndexLog(r.log ?? '');
    }, msg.force === true);
    if (environmentToken(ctx) !== environment) { respond({ type: 'IMAGE_INDEX_DATA', ok: false, environment, error: 'The connection changed' }); return; }
    respond({
      type: 'IMAGE_INDEX_DATA', ok: true, environment, fetchedAt: loaded.fetchedAt, folders: loaded.index.folders, files: loaded.index.files,
      ...(loaded.error ? { error: loaded.error } : {}),
    });
  } catch (e) {
    respond({ type: 'IMAGE_INDEX_DATA', ok: false, environment, error: errorMessage(e) });
  }
});

/** Thumbnails are read four at a time at most. */
const BYTES_PARALLEL = 4;
const BYTES_MAX_RIDS = 24;

register('IMAGE_BYTES', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  if (!client) { respond({ type: 'IMAGE_BYTES_DATA', ok: false, items: [], error: 'Not connected' }); return; }
  const rids = [...new Set(msg.rids)].filter(r => /^-?\d+$/.test(r)).slice(0, BYTES_MAX_RIDS);
  const items: Array<{ rid: string; mime?: string; base64?: string; error?: string }> = new Array(rids.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rids.length; i = next++) {
      const r = await client.downloadResourceBytes(rids[i]);
      items[i] = r.ok && r.bytes
        ? { rid: rids[i], base64: bytesToBase64(r.bytes), ...(r.contentType ? { mime: r.contentType } : {}) }
        : { rid: rids[i], error: r.error ?? 'The file could not be read' };
    }
  };
  await Promise.all(Array.from({ length: Math.min(BYTES_PARALLEL, rids.length) }, worker));
  respond({ type: 'IMAGE_BYTES_DATA', ok: true, items });
});

interface WriteResult { ok: boolean; error?: string; outcomeUnknown?: boolean }

/** Preview the script on the server, then write it. A warning in the
 *  preview (BMP would skip a value) stops it before anything is written. */
async function previewThenWrite(ctx: SwContext, code: string): Promise<WriteResult> {
  const client = ctx.client!;
  const script = userScript(code);
  if (script.length > SCRIPT_BUDGET + 1_000) return { ok: false, error: 'This change is too large to write in one step.' };
  const preview = await client.executeEc(script, undefined, false);
  if (!preview.ok) return { ok: false, error: preview.error || preview.log || 'The preview failed' };
  const warnings = (preview.outputEntries ?? []).filter(e => e.logType === 'WARNING').map(e => e.message);
  if (preview.hasWarning || warnings.length) return { ok: false, error: `BMP would not write all of it: ${warnings[0] ?? 'warning in the preview'}` };
  const res = await client.executeEc(script, undefined, true);
  if (!res.ok) return { ok: false, error: res.error || res.log || 'The write failed', ...(res.outcomeUnknown ? { outcomeUnknown: true } : {}) };
  return { ok: true };
}

register('COLORS_IMAGES_WRITE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const fail = (error: string, written = 0, outcomeUnknown = false) =>
    respond({ type: 'COLORS_IMAGES_WRITE_RESULT', ok: false, written, error, ...(outcomeUnknown ? { outcomeUnknown: true } : {}) });
  if (!ctx.client) { fail('Not connected'); return; }
  if (!environmentMatches(ctx, msg.environment)) { fail(environmentMismatchError(ctx, msg.environment)); return; }
  const startedAt = Date.now();
  let written = 0;
  try {
    if (msg.colors?.length) {
      const r = await previewThenWrite(ctx, buildColorWriteEc(msg.colors));
      if (!r.ok) {
        ctx.logActivity('error', 'Colors: the change was not written', r.error, { category: 'change', action: 'save-colors' });
        fail(r.error ?? 'The change was not written', 0, r.outcomeUnknown);
        return;
      }
      written += msg.colors.length;
    }
    // One script per file, so a file that fails does not hold back the others.
    for (const op of (msg.files ?? []) as FileOp[]) {
      const r = await previewThenWrite(ctx, buildFileWriteEc(op));
      if (!r.ok) {
        ctx.logActivity('error', `Images: ${op.name} was not written`, r.error, { category: 'change', action: 'save-images' });
        fail(`${op.name}: ${r.error ?? 'not written'}`, written, r.outcomeUnknown);
        return;
      }
      written += 1;
    }
    const durationMs = Date.now() - startedAt;
    ctx.logActivity('success', `Colors and images: wrote ${written} change${written === 1 ? '' : 's'} (${durationMs}ms)`, undefined, { category: 'change', action: 'save-colors-images', durationMs });
    respond({ type: 'COLORS_IMAGES_WRITE_RESULT', ok: true, written });
  } catch (e) {
    ctx.logActivity('error', 'Colors and images: the write failed', errorMessage(e), { category: 'change', action: 'save-colors-images' });
    fail(errorMessage(e), written);
  }
});
