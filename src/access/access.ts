import type { AccessSnapshot, AccessModel } from '../lib/access-workspace/model';
import { changes } from '../lib/access-workspace/model';
import { recoverAppliedWorkspace } from './workspace-state.js';
import { mountWorkspace, type SavedWorkspace } from './workspace.js';
import { loadDraft, saveDraft, openDraftStore } from './storage';
import { createAccessApi } from './api';
import { createWorkspacePersistence } from './persistence';
import { parseAccessDestination, type AccessDestination } from '../lib/access-workspace/entry';
import type { InspectorMessage } from '../lib/messages';
import { renderNotice, type NoticeContext } from './notice';

const environment = new URL(location.href).searchParams.get('environment') ?? '';
const banner = document.getElementById('connection-banner')!;
const progress = document.getElementById('access-busy')!;
const surface = document.querySelector<HTMLElement>('.workspace')!;
let workspace: ReturnType<typeof mountWorkspace> | undefined;
let pendingEntry: AccessDestination | undefined;
function receiveEntry(destination: AccessDestination): void {
  if (workspace) workspace.enter(destination);
  else pendingEntry = destination;
}
function readEntry(): void {
  if (!location.hash.startsWith('#open=')) return;
  try {
    const target = parseAccessDestination(JSON.parse(decodeURIComponent(location.hash.slice(6))));
    history.replaceState(history.state, '', location.pathname + location.search);
    if (target) receiveEntry(target);
  } catch { notice('This Access link is invalid. Use search to find the record.'); }
}
// Install before the catalogue request: a link received while loading is retained.
void chrome.tabs.getCurrent().then(tab => {
  chrome.runtime.onMessage.addListener((msg: InspectorMessage, _sender, respond) => {
    if (msg.type !== 'ACCESS_WORKSPACE_NAVIGATE' || msg.tabId !== tab?.id || msg.environment !== environment) return;
    const destination = parseAccessDestination(msg.destination);
    if (!destination) { respond({ ok: false }); return; }
    receiveEntry(destination); respond({ ok: true });
  });
});
window.addEventListener('hashchange', readEntry);
const notice = (text: string, context?: NoticeContext) => renderNotice(banner, text, context);
const busy = (text: string) => { progress.textContent = text; progress.hidden = !text; surface.inert = !!text; };
const api = createAccessApi(environment, text => { progress.textContent = text; });
const persistence = createWorkspacePersistence(() => openDraftStore(environment),
  error => notice('Draft could not be saved on this browser: ' + String(error), { tone: 'error', title: 'Draft could not be saved' }));

async function start(): Promise<void> {
  if (!environment) throw new Error('Open Access from the Companion toolbar to use the selected connection.');
  readEntry();
  busy('Loading roles, policies and assignments…');
  let saved: SavedWorkspace | undefined;
  try { saved = await loadDraft(environment); } catch (e) { notice('Local draft recovery failed: ' + String(e)); }
  let snapshot: AccessSnapshot;
  try {
    const result = await api({ operation: 'load' }) as { snapshot: AccessSnapshot; recoveryRequired?: boolean; receipt?: { snapshot: AccessSnapshot; mapping: Record<string, string>; operationId: string; draft: AccessModel } };
    snapshot = result.snapshot;
    if (result.receipt) {
      const receipt = result.receipt;
      const recovered = saved && recoverAppliedWorkspace(saved, receipt);
      if (recovered) {
        // Restore the verified result only for the exact submitted draft. A newer
        // local draft must remain available for deliberate reconciliation.
        await saveDraft(environment, recovered);
        saved = recovered;
        await api({ operation: 'acknowledge', id: receipt.operationId });
        notice('The previous apply completed. Its verified result has been recovered.');
      } else if (!saved || !changes(saved.baseline, saved.model).length) {
        await api({ operation: 'acknowledge', id: receipt.operationId });
      } else notice('A previous apply completed, but this local draft differs. Reload from BMP to reconcile it before applying again.');
    }
    const raw = (saved?.state as { raw?: { $map?: unknown[] } } | undefined)?.raw?.$map;
    if (saved && !changes(saved.baseline, saved.model).length && !raw?.length) saved = { ...saved, model: snapshot.model, baseline: snapshot.model, snapshot };
    if (result.recoveryRequired) notice('A previous apply has an uncertain outcome. Use Connection → Reload from BMP to reconcile before applying again.');
  } catch (e) {
    if (!saved) throw e;
    snapshot = saved.snapshot;
    notice('Showing the saved draft. ' + (e instanceof Error ? e.message : String(e)));
  }
  document.title = 'Access · ' + snapshot.name + ' · Companion';
  const view = mountWorkspace({ snapshot, saved, api, persist: persistence.persist, busy, notice });
  workspace = view;
  window.addEventListener('beforeunload', e => {
    // IndexedDB is asynchronous; flush continuously and guard closing during a write.
    if (persistence.pending && view.hasDraft()) { void view.flush().catch(error => notice(String(error))); e.preventDefault(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void view.flush().catch(error => notice(String(error))); });
  busy('');
  if (pendingEntry) { const target = pendingEntry; pendingEntry = undefined; view.enter(target); }
  else view.focusArrival();
}
void start().catch(e => {
  busy(''); surface.inert = true;
  notice(e instanceof Error ? e.message : String(e));
  const retry = document.createElement('button'); retry.textContent = 'Retry';
  retry.addEventListener('click', () => location.reload()); banner.append(' ', retry);
});
