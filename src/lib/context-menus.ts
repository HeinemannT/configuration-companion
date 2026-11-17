/**
 * The page context menu entries. Chrome keeps an extension's menu entries
 * across worker restarts and browser restarts, so they are created once when
 * the extension is installed or updated (or Chrome is updated), not on every
 * worker wake (which cost one removeAll and ten creates per wake).
 */

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
];

/** Replace the menu entries with the current list. */
export function installContextMenus(menus: Pick<typeof chrome.contextMenus, 'removeAll' | 'create'> = chrome.contextMenus): void {
  menus.removeAll(() => {
    for (const item of CONTEXT_MENU_ITEMS) menus.create({ ...item, contexts: ['all'] });
  });
}

/** Create the entries on install and update only. Call once at worker start. */
export function registerContextMenus(runtime: Pick<typeof chrome.runtime, 'onInstalled'> = chrome.runtime): void {
  runtime.onInstalled.addListener(() => installContextMenus());
}
