/**
 * Colors and images: the workspace's color sets and image files on a page of
 * their own in a browser tab (colors-images/colors-images.html), opened from
 * the side panel or from the image picker of a button. One tab is kept per
 * server (handlers/colors-images.ts). Like the Access workspace it names its
 * server in its URL and every request it sends goes to that server.
 *
 * The header: the Companion mark, whose eyes read while the page waits for
 * the server, the title, the server name, then the two tabs.
 */
import { el } from '../lib/dom';
import { ICON_SPRITE } from '../lib/icon-sprite';
import { markSvg, setMarkMood } from '../lib/companion-mark';
import { sendRequest, setRouteHint } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import type { PageCtx } from './common';
import { commandUserOf } from '../lib/identity-map';
import { createColorsTab } from './colors-tab';
import { createImagesTab } from './images-tab';

type TabName = 'colors' | 'images';

const environment = new URL(location.href).searchParams.get('environment') ?? '';
// Every request of this page goes to the server it was opened for.
if (environment.includes('@')) setRouteHint({ profileId: environment.slice(0, environment.indexOf('@')) });

const mark = el('span', 'ci-mark crev-mark');
mark.innerHTML = markSvg();
mark.setAttribute('aria-hidden', 'true');
const serverName = el('span', 'ci-server ui-id', '');
const userName = el('span', 'ci-user ui-id', '');
let waiting = 0;

const ctx: PageCtx = {
  environment,
  async work<T>(task: Promise<T>): Promise<T> {
    waiting += 1;
    setMarkMood(mark, true);
    try { return await task; } finally {
      waiting -= 1;
      if (waiting === 0) setMarkMood(mark, false);
    }
  },
  openTab: name => select(name),
};

const colors = createColorsTab(ctx);
const images = createImagesTab(ctx);
const tabs: Record<TabName, { button: HTMLButtonElement; view: { root: HTMLElement; show(): void; hasUnsaved(): boolean } }> = {
  colors: { button: tabButton('colors', 'Colors'), view: colors },
  images: { button: tabButton('images', 'Images'), view: images },
};

function tabButton(name: TabName, label: string): HTMLButtonElement {
  const b = el('button', 'ci-tab', label) as HTMLButtonElement;
  b.type = 'button';
  b.setAttribute('role', 'tab');
  b.id = `tab-${name}`;
  b.addEventListener('click', () => select(name));
  return b;
}

function select(name: TabName): void {
  for (const [key, t] of Object.entries(tabs) as Array<[TabName, typeof tabs[TabName]]>) {
    const on = key === name;
    t.button.classList.toggle('on', on);
    t.button.setAttribute('aria-selected', String(on));
    t.view.root.hidden = !on;
    if (on) t.view.show();
  }
  history.replaceState(history.state, '', `${location.pathname}${location.search}#tab=${name}`);
}

function tabFromHash(): TabName {
  return /[#&]tab=images/.test(location.hash) ? 'images' : 'colors';
}

function mount(): void {
  const host = document.getElementById('app')!;
  const sprite = document.createElement('div');
  sprite.innerHTML = ICON_SPRITE;
  document.body.prepend(sprite.firstElementChild!);
  const header = el('header', 'ci-head', mark, el('h1', 'ci-h1', 'Colors and images'), serverName, userName);
  const tablist = el('nav', 'ci-tabs', tabs.colors.button, tabs.images.button);
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Colors and images');
  const body = el('div', 'ci-body', colors.root, images.root);
  host.append(header, tablist, body);
  select(tabFromHash());
}

mount();

if (!environment) {
  document.getElementById('app')?.prepend(el('div', 'ci-state', 'Open Colors and images from the Companion side panel to use the selected connection.'));
}

// The server name, from the same answer the side panel uses.
void (async () => {
  const reply = await sendRequest({ type: 'GET_CONNECTION_STATE' } satisfies InspectorMessage);
  if (reply?.type === 'CONNECTION_STATE') {
    const label = reply.state.profileLabel || reply.state.workspace || '';
    serverName.textContent = label;
    userName.textContent = commandUserOf(reply.state);
    document.title = `Colors and images${label ? ` · ${label}` : ''} · Companion`;
  }
})();

// A link from an open window (the image picker of a button) names the tab to show.
void chrome.tabs.getCurrent().then(tab => {
  chrome.runtime.onMessage.addListener((msg: InspectorMessage, _sender, respond) => {
    if (msg.type !== 'COLORS_IMAGES_NAVIGATE' || msg.tabId !== tab?.id || msg.environment !== environment) return;
    select(msg.tab);
    respond({ ok: true });
  });
});
window.addEventListener('hashchange', () => select(tabFromHash()));

window.addEventListener('beforeunload', e => {
  if (colors.hasUnsaved() || images.hasUnsaved()) e.preventDefault();
});
