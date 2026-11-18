/**
 * History, favorites, and activity handlers.
 *
 * All handlers are gated on settingsReady at the router level —
 * no per-handler .then() wrappers needed.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { getActivityLog } from '../activity';
import { holdLogEntryForPanel, logIdForError } from '../toast-log';
import { log } from '../logger';
import { isRidShaped } from '../validate-inbound';
import { clearChanges, readChanges, recordChanges, type ChangeRecord } from '../change-record';
import { currentCommandActor } from '../command-actor';

register('GET_HISTORY', (msg, respond, meta) => {
  respond({ type: 'HISTORY_DATA', entries: ctxOf(meta).history.getAll() });
});

// The object window opened a root: it is a recent object for Browse.
register('RECORD_RECENT', (msg, _respond, meta) => {
  if (typeof msg.rid !== 'string' || !isRidShaped(msg.rid)) return;
  const ctx = ctxOf(meta);
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 400 && v ? v : undefined);
  ctx.history.record({
    rid: msg.rid,
    name: str(msg.name),
    type: str(msg.objectType),
    businessId: str(msg.businessId),
    templateBusinessId: str(msg.templateBusinessId),
    action: 'viewed',
    timestamp: Date.now(),
  });
  ctx.sendToPanel({ type: 'HISTORY_DATA', entries: ctx.history.getAll() });
});

register('TOGGLE_FAVORITE', (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  // Snapshot pre-state so we can tell the user whether they pinned or unpinned —
  // toggle returns the new state but the activity log reads better as a verb.
  const wasPinned = ctx.favorites.getAll().some(f => f.rid === msg.rid);
  ctx.favorites.toggle(msg.rid, {
    name: msg.name,
    type: msg.objectType,
    businessId: msg.businessId,
    templateBusinessId: msg.templateBusinessId,
  });
  respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
  // A pin from outside the panel (the object window) refreshes Browse's list.
  if (meta.isOneShot) ctx.sendToPanel({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
  const label = msg.name || msg.businessId || msg.rid;
  ctx.logActivity('info', wasPinned ? `Unpinned ${label}` : `Pinned ${label}`, undefined, {
    category: 'change',
    action: wasPinned ? 'unpin' : 'pin',
    object: {
      rid: msg.rid,
      ...(msg.name ? { name: msg.name } : {}),
      ...(msg.businessId ? { businessId: msg.businessId } : {}),
      ...(msg.objectType ? { type: msg.objectType } : {}),
    },
  });
});

register('GET_FAVORITES', (msg, respond, meta) => {
  respond({ type: 'FAVORITES_DATA', entries: ctxOf(meta).favorites.getAll() });
});

// ── Saved style presets (blueprint paintbrush library) ───────────
register('LIST_STYLE_PRESETS', (msg, respond, meta) => {
  respond({ type: 'STYLE_PRESETS_DATA', presets: ctxOf(meta).stylePresets.getAll() });
});

register('SAVE_STYLE_PRESET', (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const saved = ctx.stylePresets.save(msg.name, msg.style);
  respond({ type: 'STYLE_PRESETS_DATA', presets: ctx.stylePresets.getAll() });
  if (saved) ctx.logActivity('info', `Saved style "${saved.name}"`, undefined, {
    category: 'change', action: 'save-style-preset',
  });
});

register('DELETE_STYLE_PRESET', (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  ctx.stylePresets.remove(msg.id);
  respond({ type: 'STYLE_PRESETS_DATA', presets: ctx.stylePresets.getAll() });
});

// Change record: per server profile, written only by the object window's saves.
register('RECORD_CHANGES', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  const profileId = ctx.profileId;
  if (!profileId || !Array.isArray(msg.changes) || !msg.changes.length) return;
  try {
    const entries = await recordChanges(profileId, msg.changes, currentCommandActor(profileId)?.user);
    ctx.sendToPanel({ type: 'CHANGES_DATA', profileId, entries });
  } catch (e) { log.swallow('changes:record', e); }
});

register('GET_CHANGES', async (_msg, respond, meta) => {
  const profileId = ctxOf(meta).profileId ?? '';
  let entries: ChangeRecord[] = [];
  try { if (profileId) entries = await readChanges(profileId); } catch (e) { log.swallow('changes:read', e); }
  respond({ type: 'CHANGES_DATA', profileId, entries });
});

register('CLEAR_CHANGES', async (_msg, respond, meta) => {
  const profileId = ctxOf(meta).profileId ?? '';
  try { if (profileId) await clearChanges(profileId); } catch (e) { log.swallow('changes:clear', e); }
  respond({ type: 'CHANGES_DATA', profileId, entries: [] });
});

register('GET_ACTIVITY', (msg, respond, meta) => {
  respond({ type: 'ACTIVITY_LOG', entries: getActivityLog() });
});

// An error toast's "Show in Log" in a page or window. sidePanel.open needs the
// user's click, which Chrome carries through the runtime message, so it is the
// first call. A panel that is already open is told to show the entry; one that
// is still opening gets it when it says hello. When the panel can be reached
// by neither, "opened" is false and the sender copies the error instead.
register('SHOW_IN_LOG', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const tabId = meta.senderTabId;
  // A side-panel sender needs no opening: its panel is the one to show the entry.
  const opening = meta.panelWindowId != null ? Promise.resolve() : tabId != null ? chrome.sidePanel.open({ tabId }) : Promise.reject(new Error('no tab'));
  const text = typeof msg.text === 'string' ? msg.text.slice(0, 600) : '';
  const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 4000) : undefined;
  const known = typeof msg.logId === 'number' && getActivityLog().some(e => e.id === msg.logId);
  const logId = known ? msg.logId as number : logIdForError(text || 'Error', ctx.settings?.activeProfileId, detail);
  let openedNow = false;
  try { await opening; openedNow = true; } catch (e) { log.swallow('history:showInLog:open', e); }
  let windowId: number | undefined = meta.panelWindowId;
  try { if (windowId == null && tabId != null) windowId = (await chrome.tabs.get(tabId)).windowId; } catch (e) { log.swallow('history:showInLog:tab', e); }
  const alreadyOpen = windowId != null && ctx.panelPortByWindow.has(windowId);
  if (windowId != null && (alreadyOpen || openedNow)) {
    if (alreadyOpen) ctx.sendToPanelByWindow(windowId, { type: 'SHOW_LOG_ENTRY', id: logId });
    else holdLogEntryForPanel(windowId, logId);
  }
  respond({ type: 'SHOW_IN_LOG_RESULT', opened: alreadyOpen || openedNow, logId });
});

register('GET_SCRIPT_HISTORY', (msg, respond, meta) => {
  respond({ type: 'SCRIPT_HISTORY_DATA', entries: ctxOf(meta).scriptHistory.getAll() });
});
