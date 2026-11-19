/**
 * Entry point for content-blueprint.js — the lazily-injected Blueprint layout editor.
 * Split out of the always-on content bundle: Blueprint (~150 KB, 58% of the old content.js — the
 * `content-blueprint/*` modules + the shared `lib/layout/*` they pull in) is a Blueprint-command tool, not
 * something every page load of a granted BMP origin needs. content.ts requests this file via the SW's
 * `chrome.scripting.executeScript` on the tab's FIRST blueprint activation; every activation after
 * that just talks to the already-injected script.
 *
 * Bridge to content.ts: every content script the extension injects into one tab shares ONE
 * ISOLATED-world `window` (confirmed in live browser testing). content.ts can't hand this script a
 * live JS reference any other way (module closures don't cross a separate `chrome.scripting`
 * injection), so:
 *   - the page-rid RESOLVER is a closure content.ts publishes onto `window.__crevBpResolver` — it
 *     closes over content.ts's own ContentState (fiberPageContext), so this script always sees the
 *     current page context by calling through the reference, not by copying a value.
 *   - ACTIVATION is a call of `window.__crevBpCmd`, which this file publishes on that isolated-world
 *     `window`. Page script shares the DOM but not this `window`, so it cannot send commands (a DOM
 *     event on `document` could be forged by the page). Commands issued before this file publishes the
 *     function are buffered in `window.__crevBpPendingCmds`, then drained in order on initialization.
 */
import { enableBlueprint, disableBlueprint, setBlueprintRidResolver, setBlueprintResumePrefer, selectBlueprintRid, isBlueprintActive } from './content-blueprint';
import { requestExit } from './content-blueprint/actions';
import { resetColorSets } from './content-blueprint/colors';
import { resetFlowRefsCache } from './content-blueprint/service';
import { enablePointTell, disablePointTell, startNewPage } from './content-pointtell/index';
import { log } from './lib/logger';

type BlueprintCmd =
  | { cmd: 'enable' }
  | { cmd: 'disable' }
  | { cmd: 'resetOverlayCaches' }
  | { cmd: 'setResumePrefer'; prefer: 'template' | 'instance' }
  | { cmd: 'select'; rid: string }
  | { cmd: 'pointTellEnable' }
  | { cmd: 'pointTellNewPage' }
  | { cmd: 'pointTellDisable' };

declare global {
  interface Window {
    /** Published by content.ts — resolves "what BMP object is this page showing", same URL ⊕ fiber
     *  rule as the Page tab. Read once at init; the reference itself stays live (content.ts's closure
     *  reads fresh ContentState on every call), so re-reading it here per-call isn't needed. */
    __crevBpResolver?: () => string | undefined;
    /** One-shot edit-target override for the NEXT enable, set by content.ts's post-apply resume
     *  before this script has necessarily loaded — consumed (and cleared) on init. */
    __crevBpResumePrefer?: 'template' | 'instance';
    /** True once THIS script has published `__crevBpCmd`. content.ts reads it to decide
     *  whether to run a command live or buffer it in `__crevBpPendingCmds`. */
    __crevBpEntryReady?: boolean;
    /** Order-preserving buffer of commands content.ts issued before the entry existed (the very
     *  first activation, whose injection request fires before this file finishes loading). Drained in
     *  order on init below; every command after that runs live through `__crevBpCmd`. */
    __crevBpPendingCmds?: BlueprintCmd[];
    /** This script's command entry (see the header): validates and runs one command. */
    __crevBpCmd?: (detail: unknown) => void;
    /** Re-injection guard (mirrors `window.__crev_content_loaded` in content.ts) — a second
     *  chrome.scripting.executeScript into the same tab re-runs this file with a FRESH module scope
     *  (a new `bp` singleton, new resize/keydown/mutation listeners), so the previous instance must
     *  tear itself down first or its listeners leak and double-fire. */
    __crevBpEntryLoaded?: boolean;
    __crevBpEntryTeardown?: () => void;
    /** Published by this script: the one Blueprint exit check (content-blueprint/actions.ts
     *  `requestExit`). content.ts asks it before every way out the worker or the page starts;
     *  true means Blueprint may close (nothing unsaved, or the user chose Discard). */
    __crevBpRequestExit?: () => Promise<boolean>;
  }
}

/** Shape-guard for a command. Commands arrive only through `window.__crevBpCmd`, a function on the
 *  content scripts' isolated-world `window`, which page script cannot reach. (They used to arrive as a
 *  `crev-bp-cmd` DOM event on the shared `document`, where a page could forge them.) None of them
 *  applies or confirms anything: a layout commit goes only through Blueprint's own Review and
 *  Confirm & apply buttons, which act on real mouse presses only (geometry.ts `mkUserBtn`). The
 *  allowlist still validates every shape, so a stale caller cannot pass anything else. */
function parseBlueprintCmd(detail: unknown): BlueprintCmd | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (d.cmd === 'enable' || d.cmd === 'disable' || d.cmd === 'resetOverlayCaches' || d.cmd === 'pointTellEnable' || d.cmd === 'pointTellNewPage' || d.cmd === 'pointTellDisable') {
    return { cmd: d.cmd };
  }
  if (d.cmd === 'setResumePrefer' && (d.prefer === 'template' || d.prefer === 'instance')) {
    return { cmd: 'setResumePrefer', prefer: d.prefer };
  }
  if (d.cmd === 'select' && typeof d.rid === 'string' && /^-?\d+$/.test(d.rid)) {
    return { cmd: 'select', rid: d.rid };
  }
  return null;
}

function handleCmd(detail: BlueprintCmd): void {
  switch (detail.cmd) {
    // Blueprint and Point and tell never share a page: whichever turns on first sends the other away.
    case 'enable': disablePointTell(); enableBlueprint(); break;
    case 'disable': disableBlueprint(); break;
    case 'resetOverlayCaches': resetColorSets(); resetFlowRefsCache(); break;
    case 'setResumePrefer': setBlueprintResumePrefer(detail.prefer); break;
    case 'select': selectBlueprintRid(detail.rid); break;
    case 'pointTellEnable': if (!isBlueprintActive()) enablePointTell(); break;
    case 'pointTellNewPage': if (!isBlueprintActive()) startNewPage(); break;
    case 'pointTellDisable': disablePointTell(); break;
  }
}

/** This instance's command entry. A re-injection (executeScript re-runs this file in the same
 *  isolated world with a FRESH module scope + its own `bp` singleton) replaces it; the previous
 *  instance's teardown removes it only while it is still its own. */
const runCmd = (detail: unknown): void => {
  const cmd = parseBlueprintCmd(detail);
  if (cmd) handleCmd(cmd);
};

function teardown(): void {
  if (window.__crevBpCmd === runCmd) window.__crevBpCmd = undefined;
  disableBlueprint();
  disablePointTell();
}

// Re-injection guard — see window.__crevBpEntryLoaded above.
if (window.__crevBpEntryLoaded) {
  try { window.__crevBpEntryTeardown?.(); } catch (e) { log.swallow('contentBlueprint:teardownPrev', e); }
}
window.__crevBpEntryLoaded = true;
window.__crevBpEntryTeardown = teardown;
window.__crevBpRequestExit = () => requestExit();

if (window.__crevBpResolver) setBlueprintRidResolver(window.__crevBpResolver);

// Resume-prefer must land BEFORE the pending-enable check below — enableBlueprint() reads it
// synchronously at call time (see content-blueprint.ts's `resumePrefer` one-shot).
if (window.__crevBpResumePrefer) {
  setBlueprintResumePrefer(window.__crevBpResumePrefer);
  window.__crevBpResumePrefer = undefined;
}

// Drain any commands content.ts buffered before this listener existed (the first-injection window),
// in the order they were issued, then let subsequent commands flow live. Snapshot + clear the queue
// and flip the ready flag BEFORE replaying, so a command that arrives mid-drain is dispatched live
// (through the already-attached listener above) rather than lost or double-run — an on→off toggle
// that raced injection therefore ends in the user's LAST intent, not a hardcoded enable.
const pendingCmds = window.__crevBpPendingCmds ?? [];
window.__crevBpPendingCmds = undefined;
window.__crevBpCmd = runCmd;
window.__crevBpEntryReady = true;
for (const cmd of pendingCmds) handleCmd(cmd);
