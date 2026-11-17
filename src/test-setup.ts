/**
 * Unit-test setup: pin the EC frame (ec-parser.ts createEcFrame) to the
 * static one, so canned EC logs can be written without knowing the random
 * per-request markers. Tests of the random path delete the pin locally.
 */
import { STATIC_EC_FRAME } from './lib/ec-parser';

(globalThis as { __crevTestEcFrame?: unknown }).__crevTestEcFrame = STATIC_EC_FRAME;

// The index pacer (lib/index-budget.ts) pauses between posts; unit tests
// record the pauses without waiting.
(globalThis as { __crevTestPacerSleep?: (ms: number) => Promise<void> }).__crevTestPacerSleep = () => Promise.resolve();

// Every test starts with fresh load-governor budgets (lib/load-governor.ts):
// one test's time-out must not stop another test's background posts.
import { afterEach, beforeEach } from 'vitest';
import { resetLoadGovernors } from './lib/load-governor';
beforeEach(() => { resetLoadGovernors(); });

// happy-dom fires `selectionchange` synchronously from inside
// Selection.collapse/addRange. The Selection API spec, and every browser,
// queue it as a task instead. CodeMirror writes the DOM selection during
// EditorView.update and handles `selectionchange` by flushing, which may call
// EditorView.update again; a synchronous event therefore re-enters the update
// ("Calls to EditorView.update are not allowed while an update is in
// progress"). Queue the event as the browser does. The timer is captured here
// so fake timers in a test do not hold the event back.
deferSelectionChange();
function deferSelectionChange(): void {
  if (typeof document === 'undefined') return; // node environment: no DOM
  // happy-dom builds the document from a per-window subclass, so patch the
  // prototype the document actually uses rather than the global `Document`.
  const proto = Object.getPrototypeOf(document) as Document;
  const dispatch = proto.dispatchEvent;
  const queueTask = globalThis.setTimeout.bind(globalThis);
  proto.dispatchEvent = function (this: Document, event: Event): boolean {
    // happy-dom re-enters dispatchEvent for each phase of an event already in
    // flight (eventPhase != NONE); only the first call is queued.
    if (event.type !== 'selectionchange' || event.eventPhase !== Event.NONE) return dispatch.call(this, event);
    queueTask(() => { dispatch.call(this, event); }, 0);
    return true;
  };
}

// Unit tests never reach the network. Until a test replaces it, `fetch` (and
// XMLHttpRequest / WebSocket) rejects and records the address; the test then
// fails after it ends, naming the address. The failure is reported from
// afterEach because callers often swallow a rejected fetch (fire-and-forget
// checks). A test that needs an answer assigns or stubs `globalThis.fetch`.
const networkAttempts: string[] = [];
function blockedNetwork(kind: string, url: unknown): Error {
  const target = url instanceof Request ? `${url.method} ${url.url}` : String(url);
  networkAttempts.push(`${kind} ${target}`);
  return new Error(`Unit test reached the network (${kind} ${target}); stub globalThis.fetch in this test.`);
}
const g = globalThis as Record<string, unknown>;
g.fetch = (input: unknown) => Promise.reject(blockedNetwork('fetch', input));
for (const name of ['XMLHttpRequest', 'WebSocket'] as const) {
  if (typeof g[name] !== 'function') continue;
  g[name] = class {
    constructor(url?: unknown) { throw blockedNetwork(name, url ?? '(no address yet)'); }
  };
}
afterEach(() => {
  if (!networkAttempts.length) return;
  const attempts = networkAttempts.splice(0);
  throw new Error(`Unit test reached the network ${attempts.length}× — stub what it needs:\n  ${[...new Set(attempts)].join('\n  ')}`);
});
