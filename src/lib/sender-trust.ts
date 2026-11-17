/**
 * Who sent a message, and whether that sender may send it.
 *
 * Content scripts run inside BMP pages; a page bug or a hostile page script
 * that reaches the content world must not read saved passwords, rewrite server
 * profiles, run arbitrary Extended Code or write to the server outside the
 * flows the content script owns. The allow-list per sender kind lives in
 * message-access.ts; anything not listed is refused and logged once.
 */
import type { SenderKind } from './message-access';

/** True for a sender that is one of this extension's own pages (top-level or
 *  embedded). A content script shares the extension ID but reports the web
 *  page's URL. */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const base = chrome.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(base);
}

/** Classify a sender. An extension page with a tab and a non-zero frame id is
 *  a window embedded in a page (object window, editor, Studio, code search,
 *  Compare); an extension page without a tab (side panel), or as the top
 *  frame of its own tab (Access workspace), is a full extension page. */
export function senderKindOf(sender: chrome.runtime.MessageSender | undefined): SenderKind | null {
  if (!sender) return null;
  if (typeof chrome !== 'undefined' && chrome.runtime?.id && sender.id !== chrome.runtime.id) return null;
  if (!isExtensionPageSender(sender)) return sender.tab ? 'content' : null;
  if (sender.tab && (sender.frameId ?? 0) > 0) return 'frame';
  return 'extension';
}

/** The code search page, relative to the extension root. */
export const CODE_SEARCH_PAGE = 'codesearch/codesearch.html';

/** May this sender hold the code search keep-alive port (keep-alive.ts)?
 *  Only the extension's own code search page, embedded in a page or opened
 *  on its own. Content scripts and the side panel are refused, so nothing
 *  but an open code search window keeps the worker running, or keeps the
 *  change feed of its tab's server profile polled (code-feed holdFeed). */
export function mayHoldKeepAlivePort(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!isExtensionPageSender(sender) || typeof sender?.url !== 'string') return false;
  const page = chrome.runtime.getURL(CODE_SEARCH_PAGE);
  return sender.url === page || sender.url.startsWith(`${page}?`) || sender.url.startsWith(`${page}#`);
}

// ── Objects a window inside a page may write ─────────────────────────

/**
 * Per object window document (tab + frame + the frame's document id) and
 * server environment: every object the worker served to that window: the
 * root of each OPEN_OBJECT_ROOT answer (also after in-frame navigation), the
 * tree nodes and the template of that answer, and every object a
 * READ_FULL_OBJECTS answer returned to it (templates, referenced objects,
 * re-reads). A frame may send a custom property write only for one of these.
 * At most FRAME_SERVED_PER_KEY objects per window (oldest dropped); the
 * root of each OPEN_OBJECT_ROOT answer is pinned and never dropped by that
 * cap (at most FRAME_ROOTS_PER_KEY roots; the oldest root over that becomes
 * an ordinary entry). A new document in the same frame drops the old
 * document's record. The document is the sender's `documentId`; on a Chrome
 * that sends none, the frame's URL (`sender.url`), so a frame that loads
 * another URL drops the record too, while a reload of the SAME URL cannot be
 * told apart there and keeps it until the tab loads a new page. A tab that
 * loads a new page or closes drops all of its records (`forgetFrameTab`,
 * wired by `watchFrameTabs`). The record lives in session storage, so a
 * restarted worker keeps it; it is written only when a record's set of
 * objects changed, at most once per tick.
 *
 * Only an object window frame (an extension page under `objectview/`) is
 * recorded; any other frame, a page or an unknown sender has no record.
 *
 * What it protects against: a window writing an object the worker never
 * served to it, an object served to another window or tab, or an object on
 * another server profile. What it does NOT protect against: a window (or
 * code that controls it) opening an object first and then writing it; the
 * window is an extension page and opening objects is its job. The real
 * limits of every write are the gate (custom-property-gate.ts: only custom,
 * editable, plainly stored properties of the object's own type, values that
 * fit) and the user's own rights on the server.
 */
/** One window document's record: pinned roots and the other served objects. */
interface FrameRecord { roots: string[]; rids: string[] }
const frameServed = new Map<string, FrameRecord>();
export const FRAME_SERVED_PER_KEY = 500;
export const FRAME_ROOTS_PER_KEY = 50;
const FRAME_KEYS = 64;
const FRAME_STORE = 'crev_frame_served';
let frameLoaded: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export interface FrameSender { tabId?: number; frameId?: number; documentId?: string; url?: string }

/** The object window page: `<extension origin>/objectview/…`. */
const OBJECT_WINDOW_URL = /^[a-z-]+:\/\/[^/]+\/objectview\//;
const RID_TEXT = /^\d{1,20}$/;

/** `<tab>|f:<frame>|` — the prefix of every record of one frame. */
function framePrefix(s: FrameSender): string | null {
  if (s.tabId == null || s.frameId == null) return null;
  if (typeof s.url !== 'string' || !OBJECT_WINDOW_URL.test(s.url)) return null;
  return `${s.tabId}|f:${s.frameId}|`;
}

/** `<prefix>d:<documentId>|`, or `<prefix>u:<frame URL>|` without a documentId. */
function documentPrefix(s: FrameSender): string | null {
  const prefix = framePrefix(s);
  if (!prefix) return null;
  return typeof s.documentId === 'string' && s.documentId
    ? `${prefix}d:${s.documentId}|`
    : `${prefix}u:${encodeURIComponent(s.url!)}|`;
}

function frameKey(s: FrameSender, environment: string): string | null {
  const doc = documentPrefix(s);
  return doc && environment ? `${doc}${environment}` : null;
}

function sessionStore(): chrome.storage.StorageArea | undefined {
  try { return typeof chrome !== 'undefined' ? chrome.storage?.session : undefined; } catch { return undefined; }
}

const ridList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string' && RID_TEXT.test(r)) : []);

function loadFrameServed(): Promise<void> {
  frameLoaded ??= (async () => {
    try {
      const got = (await sessionStore()?.get(FRAME_STORE))?.[FRAME_STORE] as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(got ?? {})) {
        if (frameServed.has(k)) continue;
        // `{ p: roots, r: rids }`; a plain array is the earlier form.
        const rec: FrameRecord | null = Array.isArray(v) ? { roots: [], rids: ridList(v) } : v && typeof v === 'object'
          ? { roots: ridList((v as { p?: unknown }).p), rids: ridList((v as { r?: unknown }).r) } : null;
        if (rec) frameServed.set(k, rec);
      }
    } catch { /* session storage unavailable: memory only */ }
  })();
  return frameLoaded;
}

/** Write the records once, after this tick: the served reads of one tick
 *  share one write. */
function saveFrameServed(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = Object.fromEntries([...frameServed].map(([k, r]) => [k, { p: r.roots, r: r.rids }]));
    void sessionStore()?.set({ [FRAME_STORE]: snapshot }).catch(() => { /* best effort */ });
  }, 0);
}

/** The worker served `rids` to the window in `sender` on `environment`.
 *  `root`: the root of an OPEN_OBJECT_ROOT answer, pinned in the record. */
export async function noteFrameServed(sender: FrameSender, environment: string, rids: Iterable<string | undefined>, opts: { root?: string } = {}): Promise<void> {
  const key = frameKey(sender, environment);
  if (!key) return;
  const root = typeof opts.root === 'string' && RID_TEXT.test(opts.root) ? opts.root : undefined;
  const fresh = [...new Set([...rids].filter((r): r is string => typeof r === 'string' && RID_TEXT.test(r)))];
  if (!fresh.length && !root) return;
  await loadFrameServed();
  let changed = false;
  // Another document in this frame (the window was reloaded or replaced):
  // what the old document was served no longer counts.
  const prefix = framePrefix(sender)!;
  const doc = documentPrefix(sender)!;
  for (const k of [...frameServed.keys()]) if (k.startsWith(prefix) && !k.startsWith(doc)) { frameServed.delete(k); changed = true; }
  const old = frameServed.get(key) ?? { roots: [], rids: [] };
  const before = new Set([...old.roots, ...old.rids]);
  let roots = old.roots;
  if (root) {
    roots = [...roots.filter(r => r !== root), root];
    // The oldest root over the cap becomes an ordinary entry again.
    if (roots.length > FRAME_ROOTS_PER_KEY) {
      fresh.unshift(...roots.slice(0, roots.length - FRAME_ROOTS_PER_KEY));
      roots = roots.slice(-FRAME_ROOTS_PER_KEY);
    }
  }
  const pinned = new Set(roots);
  const keep = new Set(fresh);
  const list = old.rids.filter(r => !keep.has(r) && !pinned.has(r));
  list.push(...fresh.filter(r => !pinned.has(r)));
  const rest = list.slice(-Math.max(0, FRAME_SERVED_PER_KEY - roots.length));
  const after = new Set([...roots, ...rest]);
  if (after.size !== before.size || [...after].some(r => !before.has(r)) || roots.length !== old.roots.length || roots.some(r => !old.roots.includes(r))) changed = true;
  frameServed.delete(key);
  frameServed.set(key, { roots, rids: rest });
  while (frameServed.size > FRAME_KEYS) { frameServed.delete(frameServed.keys().next().value!); changed = true; }
  if (changed) saveFrameServed();
}

/** May the window in `sender` write `rid` on `environment`? Only an object
 *  the worker served to that window document there. */
export async function frameMayWrite(sender: FrameSender, environment: string, rid: string): Promise<boolean> {
  const key = frameKey(sender, environment);
  if (!key || typeof rid !== 'string') return false;
  await loadFrameServed();
  const rec = frameServed.get(key);
  return !!rec && (rec.roots.includes(rid) || rec.rids.includes(rid));
}

/** A tab loads a new page or closes: forget what its windows were served. */
export async function forgetFrameTab(tabId: number): Promise<void> {
  await loadFrameServed();
  let changed = false;
  for (const k of [...frameServed.keys()]) if (k.startsWith(`${tabId}|`)) { frameServed.delete(k); changed = true; }
  if (changed) saveFrameServed();
}

/** The tab events that end a tab's records, as `chrome.tabs` offers them. */
export interface FrameTabEvents {
  onRemoved: { addListener(fn: (tabId: number) => void): void };
  onUpdated: { addListener(fn: (tabId: number, info: { status?: string }) => void): void };
}

/** Wire `forgetFrameTab` to the tab events (service-worker.ts): a tab that
 *  closes, or that starts loading a new page (`status: 'loading'`). */
export function watchFrameTabs(tabs: FrameTabEvents): void {
  tabs.onRemoved.addListener(tabId => { void forgetFrameTab(tabId); });
  tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') void forgetFrameTab(tabId); });
}

/** Test hook. */
export function resetFrameReads(): void {
  frameServed.clear();
  frameLoaded = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

const refusalsLogged = new Set<string>();

/** Log a refused message once per sender kind and type. */
export function noteRefusal(
  kind: SenderKind | null,
  type: string,
  where: string | undefined,
  logActivity?: (level: 'warn', message: string, detail: string, meta: { category: 'system'; action: string }) => void,
): void {
  const key = `${kind ?? 'unknown'}|${type}`;
  if (refusalsLogged.has(key)) return;
  refusalsLogged.add(key);
  const who = kind === 'content' ? 'a page’s content script'
    : kind === 'frame' ? 'a Companion window inside a page'
      : 'an unknown sender';
  try {
    logActivity?.('warn', `Refused ${type} from ${who}`,
      `${type} is not on the list of messages ${who} may send${where ? ` (${where})` : ''}. Nothing was run.`,
      { category: 'system', action: 'message-refused' });
  } catch { /* logging must not break routing */ }
}
