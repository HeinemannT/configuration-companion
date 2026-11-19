/**
 * The page context menu entries. Chrome usually keeps them across worker and browser restarts, but an entry
 * added by a later build, or lost with a profile, would stay missing until the next install or update. So they
 * are replaced on install or update, and ensured (created where missing, never duplicated) once per browser
 * session, not on every worker wake.
 */

export const POINT_TELL_MENU_ID = 'crev-point-tell';
export const NEW_PAGE_MENU_ID = 'crev-new-page';

export const CONTEXT_MENU_ITEMS: ReadonlyArray<chrome.contextMenus.CreateProperties> = [
  { id: 'crev-copy-primary-id', title: 'Copy Primary ID (template first)' },
  { id: 'crev-copy-bid', title: 'Copy Instance ID' },
  { id: 'crev-copy-rid', title: 'Copy RID' },
  { id: 'crev-copy-name', title: 'Copy Name' },
  { id: 'crev-sep-1', type: 'separator' },
  { id: 'crev-view-props', title: 'Open in Object Window' },
  { id: 'crev-open-editor', title: 'Open Editor' },
  { id: 'crev-sep-2', type: 'separator' },
  { id: 'crev-compare', title: 'Compare with…' },
  { id: 'crev-search-code', title: 'Search Code' },
  { id: 'crev-sep-3', type: 'separator' },
  { id: POINT_TELL_MENU_ID, title: 'Point and tell' },
  { id: NEW_PAGE_MENU_ID, title: 'New page here' },
];

/** A create that finds the entry already there is fine: read the error so Chrome does not log it. */
const ignoreExisting = (): void => { void chrome.runtime?.lastError; };

/** Replace the menu entries with the current list. */
export function installContextMenus(menus: Pick<typeof chrome.contextMenus, 'removeAll' | 'create'> = chrome.contextMenus): void {
  menus.removeAll(() => {
    for (const item of CONTEXT_MENU_ITEMS) menus.create({ ...item, contexts: ['all'] }, ignoreExisting);
  });
}

export const MENUS_READY_KEY = 'crev_menus_ready';

/**
 * Make sure every entry exists, once per browser session: after a browser restart (the flag in session storage is
 * gone) or an extension reload, each entry is created if it is missing. An id that exists already is an error that
 * is read and dropped, so there are never duplicates. Worker restarts inside a session find the flag and do nothing.
 */
export async function ensureContextMenus(
  menus: Pick<typeof chrome.contextMenus, 'create'> = chrome.contextMenus,
  session: Pick<chrome.storage.StorageArea, 'get' | 'set'> = chrome.storage.session,
): Promise<boolean> {
  try {
    const got = await session.get(MENUS_READY_KEY);
    if (got?.[MENUS_READY_KEY]) return false;
  } catch { /* no session storage: create anyway */ }
  for (const item of CONTEXT_MENU_ITEMS) menus.create({ ...item, contexts: ['all'] }, ignoreExisting);
  try { await session.set({ [MENUS_READY_KEY]: true }); } catch { /* next start creates them again, harmlessly */ }
  return true;
}

/** On install or update the entries are replaced; at every worker start they are ensured (see ensureContextMenus). */
export function registerContextMenus(runtime: Pick<typeof chrome.runtime, 'onInstalled'> = chrome.runtime, ensure: () => Promise<unknown> = () => ensureContextMenus()): void {
  runtime.onInstalled.addListener(() => installContextMenus());
  void ensure();
}
