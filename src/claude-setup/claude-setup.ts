/**
 * Claude Desktop: the page in its own tab that sets up Send to Claude in three steps. Get the desktop extension
 * (the .mcpb this build ships, saved to Downloads by a plain link: no download permission), install it in Claude
 * Desktop, start a working chat. Opened from Utilities, from the toast when Send to Claude finds nothing, and from
 * the sent list.
 *
 * The state line asks the desktop extension (through the worker, one short loopback socket) when the page opens,
 * when its tab is shown again and on Check again; nothing else.
 */
import { el, btn } from '../lib/dom';
import { markSvg, setMarkMood } from '../lib/companion-mark';
import { sendRequest } from '../lib/messaging';
import { DESKTOP_BUNDLE_NAME } from '../lib/claude-link';
import { workingChatLink } from '../lib/point-tell/desktop-policy';
import { chatWaiting, factLines, getButton, setupState, statusView, type SetupState } from '../lib/point-tell/desktop-setup';
import type { InspectorMessage } from '../lib/types';

type StatusData = Extract<InspectorMessage, { type: 'POINT_TELL_STATUS_DATA' }>;

/** What Claude Desktop's install warning means for this extension. One sentence. */
export const WARNING_NOTE = 'Claude Desktop warns about access to your computer; this extension only listens on this computer and only writes to Configuration Companion/Sessions.';

const mark = el('span', 'cs-mark crev-mark');
mark.innerHTML = markSvg();
mark.setAttribute('aria-hidden', 'true');

const dot = el('span', 'dot idle');
const statusText = el('span', 'cs-status-t');
const statusVersion = el('span', 'ui-id');
const check = btn('ui-tbtn', undefined, () => { void look(); }, 'Check again');

const get = el('a', 'ui-btn primary cs-btn', 'Get the extension') as HTMLAnchorElement;
// Packed from claude-desktop/ by the build (vite.config.ts); the package check fails when it is missing.
get.href = chrome.runtime.getURL('claude-setup/configuration-companion.mcpb');
get.download = DESKTOP_BUNDLE_NAME;

const chat = el('a', 'ui-btn cs-btn', 'Start working chat') as HTMLAnchorElement;
chat.href = workingChatLink();
const waiting = el('span', 'cs-waiting', el('span', 'dot'), 'Claude is taking sketches');
/** Which copies answered, whether a chat takes sketches, the settings Companion gave. */
const facts = el('ul', 'cs-facts');

function step(n: number, ...kids: Array<Node | null>): HTMLElement {
  return el('li', 'cs-step', el('span', 'cs-n', String(n)), el('div', 'cs-body', ...kids));
}

function draw(s: SetupState): void {
  const v = statusView(s);
  dot.className = `dot${v.dot === 'ok' ? '' : ` ${v.dot}`}`;
  statusText.textContent = v.text;
  statusVersion.textContent = v.version ?? '';
  statusVersion.hidden = !v.version;
  facts.replaceChildren(...factLines(s).map(line => el('li', '', line)));
  const g = getButton(s);
  get.textContent = g.label;
  get.classList.toggle('primary', g.primary);
  const w = chatWaiting(s);
  chat.hidden = w;
  waiting.hidden = !w;
  chat.classList.toggle('primary', s.kind === 'connected' && !s.update && !w);
}

let asking = 0;
async function look(): Promise<void> {
  const mine = ++asking;
  check.disabled = true;
  setMarkMood(mark, true);
  draw({ kind: 'checking' });
  const res = await sendRequest<StatusData>({ type: 'POINT_TELL_STATUS' });
  if (mine !== asking) return;
  setMarkMood(mark, false);
  check.disabled = false;
  draw(setupState(res?.result ?? { ok: false }));
}

function mount(): void {
  const app = document.getElementById('app')!;
  const head = el('header', 'cs-head', mark, el('h1', 'cs-h1', 'Claude Desktop'));
  const status = el('div', 'cs-status', dot, statusText, statusVersion, el('span', 'cs-grow'), check);
  status.setAttribute('role', 'status');
  const steps = el('ol', 'cs-steps',
    step(1, el('div', 'cs-row', get, el('span', 'cs-file ui-id', DESKTOP_BUNDLE_NAME))),
    step(2,
      el('div', 'cs-title', 'In Claude Desktop'),
      el('ol', 'cs-path',
        el('li', '', 'Open Settings, then Extensions'),
        el('li', '', 'Open Advanced settings'),
        el('li', '', 'Choose Install extension… and pick the file')),
      el('p', 'cs-note', 'Or drag the file onto the Claude Desktop window.'),
      el('p', 'cs-note', WARNING_NOTE)),
    step(3, el('div', 'cs-row', chat, waiting), el('p', 'cs-note', 'Claude takes your sketches one after another.')),
  );
  const main = el('main', 'cs', el('p', 'cs-lede', 'Send to Claude needs a small extension in Claude Desktop.'), status, facts, steps);
  app.append(head, main);
}

mount();
void look();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void look(); });
