/**
 * In-page floating-frame overlay. Generalizes the editor overlay to mount
 * any extension page (editor / diff / objectview / codesearch) as a
 * draggable, resizable iframe inside the current tab — replaces
 * chrome.windows.create popup windows for code-bearing surfaces.
 *
 * Keyed by `kind`: at most one frame per kind, and switching to a new URL
 * within the same kind swaps the iframe src.
 */

import { matchesShortcut, withShortcut } from './lib/shortcuts';
import { h, svg } from './lib/dom';
import { log } from './lib/logger';
import { sendFireForget, sendRequest } from './lib/messaging';
import { showToast } from './lib/toast';
import { ICON_ARROWS_OUT_SIMPLE, ICON_ARROWS_IN_SIMPLE, ICON_X } from './lib/icons';
import { ensureOverlayStyle } from './content-overlay-style';
import type { FrameActivation, FrameKind, FrameMountDisposition, InspectorMessage } from './lib/types';
import {
  centeredFrameBounds,
  detectFrameSnapZone,
  fitFrameBounds,
  maximizedFrameBounds,
  moveFrameBounds,
  resizeFrameBounds,
  snapFrameBounds,
  type FrameBounds as Bounds,
  type FrameResizeDirection as ResizeDir,
  type FrameSnapZone as SnapZone,
  type FrameViewport,
} from './lib/frame-geometry';
/** The front frame's z-index: the `.crev-eo-host` layer of the table in
 *  content-overlay.css (#crev-tooltip). It must stay above the Blueprint layer
 *  (2147483600): Blueprint can be opened from the object window ("Edit in
 *  Blueprint") and must not cover it. Frames behind the front one step down by
 *  one each and stay above Blueprint too. */
const MAX_Z = 2_147_483_646;

const HOST_ID_PREFIX = 'crev-frame-overlay-';

interface FrameState {
  kind: FrameKind;
  url: string;
  resourceKey: string;
  label: string;
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  bounds: Bounds;
  /** Pre-maximize bounds to restore to; set only while maximized. */
  restoreBounds?: Bounds;
  cleanupGestures: () => void;
  onKeydown: (e: KeyboardEvent) => void;
  onViewportResize: () => void;
  onFocusIn: () => void;
  replacementPending: boolean;
  pendingReplacement?: MountFrameOptions;
  ready: boolean;
  pendingActivation?: FrameActivation;
  /** The window said it holds unsaved changes (CREV_FRAME_DIRTY). Such a window is never
   *  force-closed by the no-answer fallback. */
  dirty: boolean;
  /** The page element that had focus when the window opened; focus returns there on close. */
  opener: HTMLElement | null;
  /** Close and replace handshakes waiting for the frame's answer, and whether the frame
   *  acknowledged them (CREV_OVERLAY_CLOSE_PENDING). Handed over on re-injection. */
  inflight: Set<InflightAsk>;
}

interface InflightAsk { purpose: 'close' | 'replace'; acknowledged: boolean }

const frames = new Map<FrameKind, FrameState>();
/** Close/replace handshakes waiting for a frame's answer: cancelled by
 *  teardown, so their window listeners do not outlive this instance. */
const handshakes = new Set<() => void>();

// Kinds with a mount in flight. mountFrameOverlay awaits readBounds()
// before it can register in `frames`, so two MOUNT_FRAME messages for the
// same kind arriving back-to-back would both pass the `frames.get` guard
// and each append a host → two identical overlays. Reserve the slot
// synchronously here to close that window.
const mounting = new Set<FrameKind>();
/** Latest request received while a kind is still reading its saved bounds.
 * Replayed after the first mount so rapid clicks never disappear. */
interface PendingMount {
  opts: MountFrameOptions;
  resolve: (disposition: FrameMountDisposition) => void;
}

const pendingMounts = new Map<FrameKind, PendingMount>();

// Set by teardownFrameOverlayModule(). A mount that was awaiting readBounds()
// when re-injection tore the module down must NOT append its host afterwards —
// that host (and its document/window listeners) would belong to a dead module
// and never get cleaned. Checked right after the await.
let moduleTorn = false;

// ── Geometric overlap gate ────────────────────────────────────────
//
// Companion injects several floating elements onto the BMP page:
//
//   .crev-label          pills (one per inspected widget, BMP's DOM)
//   #crev-tooltip        hover info popup
//
// Earlier releases used a blanket rule: when ANY frame overlay was
// open we made every pill click-through, hid the tooltip and quick
// inspector entirely, and left the rest alone — that "fixed" the rare
// case where BMP's transformed ancestors built a stacking context
// that let a pill float visually above the overlay, but it also
// punished every pill / tooltip / inspector that wasn't anywhere near
// the overlay.
//
// `updateOverlayBlockState()` replaces the blanket rule with a per-
// element geometric check: each candidate's bounding rect is tested
// against each open frame's host rect, and we toggle
// `crev-overlay-blocked` accordingly. CSS scopes the response per
// element (pill → click-through; tooltip → hide).
//
// We re-run on every overlay mount / unmount / drag tick / resize tick /
// snap / viewport resize, AND on body subtree mutations (BMP re-paints
// the pill DOM on every Inspect refresh and a fresh pill arrives with
// the class unset).

interface GateTarget {
  selector: string;
  /** Default `getBoundingClientRect`. Override if a wrapper element
   *  bounds don't match the user-visible region (none today). */
  bounds?: (el: HTMLElement) => DOMRect;
}

const GATE_TARGETS: ReadonlyArray<GateTarget> = [
  { selector: '.crev-label' },
  { selector: '#crev-tooltip' },
];

let overlapGateRafScheduled = false;
let overlapObserver: MutationObserver | null = null;

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

export function updateOverlayBlockState(): void {
  if (overlapGateRafScheduled) return;
  overlapGateRafScheduled = true;
  requestAnimationFrame(() => {
    overlapGateRafScheduled = false;
    // Cheap path — nothing open. Clear stale flags so a leftover
    // class can't persist after the last overlay closes.
    if (frames.size === 0) {
      for (const el of document.querySelectorAll<HTMLElement>('.crev-overlay-blocked')) {
        el.classList.remove('crev-overlay-blocked');
      }
      return;
    }
    const overlayRects: DOMRect[] = [];
    for (const f of frames.values()) overlayRects.push(f.host.getBoundingClientRect());
    for (const target of GATE_TARGETS) {
      for (const el of document.querySelectorAll<HTMLElement>(target.selector)) {
        const r = (target.bounds ?? ((x: HTMLElement) => x.getBoundingClientRect()))(el);
        // Off-screen / collapsed elements never intersect; toggle is
        // a no-op when the class isn't present, so safe to call.
        const blocked = r.width > 0 && r.height > 0 && overlayRects.some(o => rectsIntersect(r, o));
        el.classList.toggle('crev-overlay-blocked', blocked);
      }
    }
  });
}

function ensureOverlapObserver(): void {
  if (overlapObserver) return;
  // BMP re-renders pills + its own DOM on every Inspect refresh, and
  // Companion's tooltip / inspector / banner appear and disappear with
  // user interaction. A subtree childList observer catches both —
  // we recompute on any mutation so newly inserted elements get
  // their initial gate state.
  overlapObserver = new MutationObserver(() => updateOverlayBlockState());
  overlapObserver.observe(document.body, { childList: true, subtree: true });
}

function teardownOverlapObserver(): void {
  if (!overlapObserver) return;
  overlapObserver.disconnect();
  overlapObserver = null;
}

export interface MountFrameOptions {
  kind: FrameKind;
  /** chrome.runtime.getURL(...) of the page to load inside the iframe. */
  url: string;
  /** Used for aria-label and the close-confirmation prompt. */
  label: string;
  defaultWidth: number;
  defaultHeight: number;
  resourceKey?: string;
  replaceExisting?: boolean;
  activation?: FrameActivation;
}

/** Frames that post CREV_FRAME_TITLE whenever the object they show changes. */
const SELF_TITLED_KINDS: ReadonlySet<FrameKind> = new Set<FrameKind>(['objectview']);
const MAX_TITLE_LENGTH = 300;

// ── Public API ─────────────────────────────────────────────────

export async function mountFrameOverlay(opts: MountFrameOptions): Promise<FrameMountDisposition> {
  const existing = frames.get(opts.kind);
  if (existing) {
    const resourceKey = opts.resourceKey ?? opts.url;
    if (!opts.replaceExisting && existing.resourceKey === resourceKey) {
      // A frame that titles itself may still decline the activation (its
      // dirty guard): its label changes only when it reports the new title.
      if (!SELF_TITLED_KINDS.has(existing.kind)) updateFrameLabel(existing, opts.label);
      activateFrame(existing, opts.activation);
      focus(existing);
      return 'activated';
    }
    requestReplace(existing, opts);
    return 'replacement-pending';
  }

  // Another mount for this kind is already resolving its bounds. Retain only
  // the latest intent and replay it once the reserved frame exists.
  if (mounting.has(opts.kind)) {
    pendingMounts.get(opts.kind)?.resolve('superseded');
    return new Promise(resolve => pendingMounts.set(opts.kind, { opts, resolve }));
  }
  mounting.add(opts.kind);
  let disposition: FrameMountDisposition = 'mounted';
  try {
    const bounds = await readBounds(opts);
    // Re-injection tore the module down while we were resolving bounds —
    // drop this mount so we don't append a host to a dead module.
    if (moduleTorn) {
      disposition = 'dropped';
      return disposition;
    }
    // Guarantee the overlay stylesheet exists before the host enters the DOM: `.crev-eo-host` is
    // position:fixed in that sheet, and a frame surface (EC editor / diff / object view / code
    // search) can be opened WITHOUT Inspect — which is what used to inject it. Without this the host
    // drops into normal page flow at the bottom-left. Idempotent (DOM-guarded).
    ensureOverlayStyle();
    const state = createFrame(opts, bounds);
    state.opener = pageFocusOwner();
    document.documentElement.appendChild(state.host);
    attachFrame(state);
    focus(state);
    return disposition;
  } finally {
    mounting.delete(opts.kind);
    const pending = pendingMounts.get(opts.kind);
    if (pending) {
      pendingMounts.delete(opts.kind);
      if (moduleTorn) pending.resolve('dropped');
      else {
        void mountFrameOverlay(pending.opts).then(pending.resolve, () => pending.resolve('failed'));
      }
    }
  }
}

/** Register a frame whose host is in the page: this module's bookkeeping and
 *  its page listeners (Escape, viewport resize, focus-to-front). */
function attachFrame(state: FrameState): void {
  frames.set(state.kind, state);
  document.addEventListener('keydown', state.onKeydown, true);
  window.addEventListener('resize', state.onViewportResize);
  state.host.addEventListener('focusin', state.onFocusIn);
  // Mark the body so CSS can hide stacking-context-trapped overlays
  // (the in-page widget labels) that BMP renders inside transformed
  // ancestors. z-index alone can't escape those — the labels would
  // float above the task surface despite our 2147483646 setting.
  document.body.classList.add('crev-task-open');
  ensureOverlapObserver();
  updateOverlayBlockState();
}

/** Remove this module's bookkeeping and listeners of a frame; its host stays. */
function detachFrame(s: FrameState): void {
  frames.delete(s.kind);
  s.cleanupGestures();
  document.removeEventListener('keydown', s.onKeydown, true);
  window.removeEventListener('resize', s.onViewportResize);
  s.host.removeEventListener('focusin', s.onFocusIn);
}

export function unmountFrameOverlay(kind: FrameKind): void {
  const s = frames.get(kind);
  if (!s) return;
  detachFrame(s);
  const hadFocus = s.host.contains(document.activeElement) || document.activeElement === document.body || document.activeElement == null;
  s.host.remove();
  // Focus returns to the control that opened the window (when the user did not move it elsewhere).
  if (hadFocus && s.opener?.isConnected) {
    try { s.opener.focus({ preventScroll: true }); } catch (e) { log.swallow('overlay:focusReturn', e); }
  }
  if (frames.size === 0) teardownOverlapObserver();
  syncTaskOpenFlag();
  updateOverlayBlockState();
}

/** `crev-task-open` on the body while any Companion window is in the page. */
function syncTaskOpenFlag(): void {
  const open = frames.size > 0 || !!document.documentElement.querySelector('.crev-eo-host');
  document.body.classList.toggle('crev-task-open', open);
}

export function unmountAllFrameOverlays(): void {
  for (const kind of [...frames.keys()]) unmountFrameOverlay(kind);
}

/** Data attributes a torn-down module leaves on each frame host for the next
 *  instance (adoptMountedFrames). Present only between the two. */
const HANDOVER = {
  marker: 'data-crev-handover',
  state: 'data-crev-handover-state',
} as const;

interface HandoverState {
  url: string;
  resourceKey: string;
  label: string;
  bounds: Bounds;
  restoreBounds?: Bounds;
  ready: boolean;
  dirty: boolean;
  pendingActivation?: FrameActivation;
  /** A close asked of the frame and not answered yet. */
  close?: { acknowledged: boolean };
  /** A replacement waiting for the frame's answer, with the latest request. */
  replace?: { acknowledged: boolean; opts: MountFrameOptions };
  /** The server, user and session kind the title bar showed. */
  identity?: FrameIdentity;
}

/** Marks the control that opened a handed-over window (its kinds, space separated). */
const OPENER_ATTR = 'data-crev-opener';

/** Module teardown for content-script re-injection (the service worker
 *  restarted and injected content.js again, the old instance's teardown runs
 *  first). The frames are NOT closed: an object window, code search or
 *  editor may hold unsaved edits and the user did not ask to close it. Each
 *  frame is detached from this module (its listeners, gestures and close
 *  handshakes) and its state written onto the host, where the next instance
 *  adopts it (adoptMountedFrames). The iframe is never moved or reloaded.
 *  The module-level message listener goes too, so a re-injection never
 *  stacks a second one. */
export function teardownFrameOverlayModule(): void {
  moduleTorn = true;
  const asks = new Map<FrameState, InflightAsk[]>();
  for (const s of frames.values()) asks.set(s, [...s.inflight]);
  // Handshakes in flight stop listening here and are handed over below.
  for (const cancel of [...handshakes]) cancel();
  for (const s of [...frames.values()]) {
    const mine = asks.get(s) ?? [];
    const close = mine.filter(a => a.purpose === 'close');
    const replace = mine.find(a => a.purpose === 'replace');
    const handover: HandoverState = {
      url: s.url, resourceKey: s.resourceKey, label: s.label, bounds: s.bounds,
      ...(s.restoreBounds ? { restoreBounds: s.restoreBounds } : {}),
      ready: s.ready, dirty: s.dirty,
      ...(s.pendingActivation ? { pendingActivation: s.pendingActivation } : {}),
      ...(close.length ? { close: { acknowledged: close.some(a => a.acknowledged) } } : {}),
      ...(replace && s.pendingReplacement ? { replace: { acknowledged: replace.acknowledged, opts: s.pendingReplacement } } : {}),
      ...(frameIdentity.server ? { identity: frameIdentity } : {}),
    };
    detachFrame(s);
    if (s.opener?.isConnected) s.opener.setAttribute(OPENER_ATTR, `${s.opener.getAttribute(OPENER_ATTR) ?? ''} ${s.kind}`.trim());
    s.host.setAttribute(HANDOVER.marker, '1');
    s.host.setAttribute(HANDOVER.state, JSON.stringify(handover));
  }
  teardownOverlapObserver();
  window.removeEventListener('message', onFrameMessage);
}

/** Every frame kind, checked against the FrameKind union by the compiler: a
 *  kind missing here, or one that is not a FrameKind, does not compile. */
const FRAME_KIND_RECORD: Readonly<Record<FrameKind, true>> = { editor: true, diff: true, objectview: true, codesearch: true, transport: true, 'cvo-studio': true };
const FRAME_KINDS: ReadonlySet<string> = new Set(Object.keys(FRAME_KIND_RECORD));

const isBounds = (b: unknown): b is Bounds => !!b && typeof b === 'object'
  && (['left', 'top', 'width', 'height'] as const).every(k => typeof (b as Record<string, unknown>)[k] === 'number' && Number.isFinite((b as Record<string, number>)[k]));

/** Re-injection: take over the frames the previous instance of this content
 *  script handed over (teardownFrameOverlayModule), with their bookkeeping,
 *  Escape, drag, resize, maximize and close. The host and its iframe stay
 *  where they are (moving an iframe reloads it); the title bar and resize
 *  handles are rebuilt, because their listeners belonged to the old
 *  instance. The control that opened a window is carried over (focus
 *  returns there on close). A close or replace still waiting for the
 *  frame's answer is carried over too: this instance listens for that
 *  answer and does not ask again, so a "Discard?" prompt open in the frame
 *  is answered once and acted on. A handed-over host that cannot be adopted
 *  (a second host of a kind already open, bad data) keeps a close button
 *  that asks the frame first; one without an iframe is removed.
 *  Returns the number of frames adopted. */
export function adoptMountedFrames(): number {
  let adopted = 0;
  for (const host of [...document.documentElement.querySelectorAll<HTMLElement>(`.crev-eo-host[${HANDOVER.marker}]`)]) {
    const raw = host.getAttribute(HANDOVER.state);
    host.removeAttribute(HANDOVER.marker);
    host.removeAttribute(HANDOVER.state);
    const kind = host.dataset.kind ?? '';
    const opener = takeOpener(kind);
    const iframe = host.querySelector<HTMLIFrameElement>(':scope > iframe.crev-eo-iframe');
    let data: HandoverState | null = null;
    try { data = raw ? JSON.parse(raw) as HandoverState : null; } catch (e) { log.swallow('overlay:adopt', e); }
    if (!iframe) { host.remove(); continue; }
    // The identity the old instance showed, until this page's connection state arrives.
    if (!frameIdentity.server && data?.identity) frameIdentity = toFrameIdentity(data.identity);
    for (const el of host.querySelectorAll(':scope > .crev-eo-titlebar, :scope > .crev-eo-resize')) el.remove();
    host.classList.remove('crev-eo--dragging', 'crev-eo--resizing');
    iframe.style.pointerEvents = '';
    if (!FRAME_KINDS.has(kind) || frames.has(kind as FrameKind) || !data || !isBounds(data.bounds)) {
      keepWithCloseOnly(host, iframe, data?.dirty !== false);
      continue;
    }
    const state: FrameState = {
      kind: kind as FrameKind,
      url: typeof data.url === 'string' ? data.url : iframe.src,
      resourceKey: typeof data.resourceKey === 'string' ? data.resourceKey : iframe.src,
      label: typeof data.label === 'string' ? data.label : host.getAttribute('aria-label') ?? '',
      host, iframe, bounds: data.bounds,
      ...(isBounds(data.restoreBounds) ? { restoreBounds: data.restoreBounds } : {}),
      cleanupGestures: () => {},
      onKeydown: () => {},
      onViewportResize: () => {},
      onFocusIn: () => {},
      replacementPending: false,
      ready: data.ready === true,
      ...(data.pendingActivation ? { pendingActivation: data.pendingActivation } : {}),
      dirty: data.dirty === true,
      opener,
      inflight: new Set(),
    };
    wireFrame(state);
    attachFrame(state);
    if (data.replace?.opts) requestReplace(state, data.replace.opts, { acknowledged: data.replace.acknowledged === true });
    if (data.close) requestClose(state.kind, { acknowledged: data.close.acknowledged === true });
    adopted++;
  }
  // The old instance's reset removed the stylesheet: the chrome needs it
  // (positioning is inline and does not).
  if (document.documentElement.querySelector('.crev-eo-host')) ensureOverlayStyle();
  syncTaskOpenFlag();
  return adopted;
}

/** The control that opened the handed-over window of `kind`, if it is still in the page. */
function takeOpener(kind: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[${OPENER_ATTR}]`)) {
    const kinds = (el.getAttribute(OPENER_ATTR) ?? '').split(' ').filter(Boolean);
    if (!kinds.includes(kind)) continue;
    const rest = kinds.filter(k => k !== kind);
    if (rest.length) el.setAttribute(OPENER_ATTR, rest.join(' '));
    else el.removeAttribute(OPENER_ATTR);
    return el.isConnected ? el : null;
  }
  return null;
}

/** A handed-over host this instance cannot adopt: a title and one close
 *  button. Close asks the frame first, like every close; with no answer the
 *  host is removed only when it was handed over as clean. */
function keepWithCloseOnly(host: HTMLElement, iframe: HTMLIFrameElement, dirty: boolean): void {
  const label = host.getAttribute('aria-label') ?? 'Companion window';
  const state: FrameState = {
    kind: (host.dataset.kind ?? 'editor') as FrameKind, url: iframe.src, resourceKey: iframe.src, label, host, iframe,
    bounds: { left: 0, top: 0, width: 0, height: 0 },
    cleanupGestures: () => {}, onKeydown: () => {}, onViewportResize: () => {}, onFocusIn: () => {},
    replacementPending: false, ready: true, dirty, opener: null, inflight: new Set(),
  };
  const titlebar = h('div', { class: 'crev-eo-titlebar' },
    h('div', { class: 'crev-eo-titlebar-label' }, label),
    h('div', { class: 'crev-eo-titlebar-spacer' }),
    h('button', {
      class: 'crev-eo-btn crev-eo-close',
      title: 'Close',
      'aria-label': `Close ${label}`,
      onClick: () => requestFramePermission(state, 'close', allowed => {
        if (!allowed) return;
        host.remove();
        syncTaskOpenFlag();
      }),
    }, svg(ICON_X)),
  );
  host.insertBefore(titlebar, iframe);
}

// ── Construction ──────────────────────────────────────────────

function createFrame(opts: MountFrameOptions, bounds: Bounds): FrameState {
  const host = h('div', {
    id: HOST_ID_PREFIX + opts.kind,
    class: 'crev-eo-host',
    'data-kind': opts.kind,
    role: 'dialog',
    'aria-modal': 'false', // multiple overlays can be open; not modal
    'aria-label': opts.label,
    tabindex: '-1',
    // `position` is set INLINE (not left to `.crev-eo-host` in the stylesheet) so the host can NEVER fall
    // into normal page flow if that stylesheet is missing, injected late, wiped by the SPA's <head>
    // management, or removed by a re-injection teardown — the "bottom-left leak". z-index uses MAX_Z (the
    // exact value focus() assigns the front frame, called on mount) as a floor until focus() runs. The
    // stylesheet still supplies all the visual chrome (border, shadow, radius, animation).
    style: `position:fixed;z-index:${MAX_Z};left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px`,
  });

  const iframe = createIframe(opts.url, opts.label);
  host.appendChild(iframe);
  const state: FrameState = {
    kind: opts.kind,
    url: opts.url,
    resourceKey: opts.resourceKey ?? opts.url,
    label: opts.label,
    host, iframe, bounds,
    cleanupGestures: () => {},
    onKeydown: () => {},
    onViewportResize: () => {},
    onFocusIn: () => {},
    replacementPending: false,
    ready: false,
    pendingActivation: opts.activation,
    dirty: false,
    opener: null,
    inflight: new Set(),
  };
  wireFrame(state);
  return state;
}

/** The title bar, the resize handles and the handlers of a frame, around its
 *  iframe (which is never moved: that would reload it). Used for a new frame
 *  and for one adopted from a previous instance (adoptMountedFrames). */
function wireFrame(state: FrameState): void {
  const { kind, host, iframe, label } = state;
  // Titlebar has `cursor: grab` (set in content-overlay.css), which is
  // the standard desktop-OS affordance for "you can drag this". A
  // native `title="Drag to move"` would paint a redundant tooltip
  // after the half-second hover delay and disappear mid-drag.
  const maximized = !!state.restoreBounds;
  const maxBtn = h('button', {
    class: 'crev-eo-btn crev-eo-max',
    title: maximized ? 'Restore' : 'Maximize',
    'aria-label': `${maximized ? 'Restore' : 'Maximize'} ${label}`,
    onClick: () => toggleMaximize(kind),
  });
  maxBtn.innerHTML = maximized ? ICON_ARROWS_IN_SIMPLE : ICON_ARROWS_OUT_SIMPLE;
  const titlebar = h('div', { class: 'crev-eo-titlebar' },
    h('div', { class: 'crev-eo-grip' }),
    h('div', { class: 'crev-eo-titlebar-label' }, label),
    identityElement(),
    h('div', { class: 'crev-eo-titlebar-spacer' }),
    maxBtn,
    h('button', {
      class: 'crev-eo-btn crev-eo-close',
      title: withShortcut('Close', 'frame.close'),
      'aria-label': `Close ${label}`,
      onClick: () => requestClose(kind),
    }, svg(ICON_X)),
  );

  // Eight directional resize handles — four edge strips + four
  // corner squares. Corners overlap the edges so they win the
  // hit-test; the absolute positioning + z-index in CSS handles it.
  const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  // Each resize handle's CSS already sets the matching directional
  // cursor (e.g. `cursor: ns-resize` / `cursor: nesw-resize`), which
  // is the universal "you can resize from this edge/corner" affordance
  // on every desktop OS. `aria-label` carries the accessible name; a
  // native `title="Resize"` would just paint a redundant tooltip.
  const resizeHandles: Array<{ el: HTMLElement; dir: ResizeDir }> = RESIZE_DIRS.map(dir => ({
    el: h('div', {
      class: `crev-eo-resize crev-eo-resize--${dir}`,
      role: 'separator',
      'aria-label': `Resize ${label} (${dir})`,
    }),
    dir,
  }));

  host.insertBefore(titlebar, iframe);
  for (const { el } of resizeHandles) host.appendChild(el);

  // Raise z-order when focus enters the frame (titlebar/resize/close OR the
  // iframe body via cross-frame focus). The browser fires a focus event on
  // the iframe element when its content gains focus, which bubbles as
  // focusin on the host. Without this, a buried frame stayed buried even
  // after the user clicked into it. Added by attachFrame.
  state.onFocusIn = () => {
    if (frames.get(kind) === state) focus(state);
  };
  const dragCleanup = wireDrag(state, titlebar);
  const resizeCleanups = resizeHandles.map(({ el, dir }) => wireResize(state, el, dir));
  state.cleanupGestures = () => { dragCleanup(); for (const c of resizeCleanups) c(); };
  state.onKeydown = (e: KeyboardEvent) => {
    // Escape closes only the focused frame — multiple can be open
    if (matchesShortcut(e, 'frame.close') && frames.get(kind) === state && isFocused(state)) {
      requestClose(kind);
      e.stopPropagation();
    }
  };
  state.onViewportResize = () => {
    const viewport = currentViewport();
    if (state.restoreBounds) {
      state.restoreBounds = fitFrameBounds(state.restoreBounds, viewport);
      state.bounds = maximizedFrameBounds(viewport);
    } else {
      state.bounds = fitFrameBounds(state.bounds, viewport);
      persistBounds(state.kind, state.bounds);
    }
    applyBounds(state);
    updateOverlayBlockState();
  };
}

/** The server, user and session kind every window of this page works on,
 *  from the page's own connection state: one quiet place in every window's
 *  title bar. The server name reads normal; the user and the session kind
 *  are muted. A narrow title bar drops the session kind first, then the
 *  user, and only then truncates the server name (content-overlay.css:
 *  the parts wrap onto a hidden second line). */
export interface FrameIdentity {
  server: string;
  user: string;
  /** "browser session" or "stored configuration login"; empty without a user. */
  kind: string;
}

type CommandSource = 'portal-session' | 'stored-login';

/** The session kind in the product's words (command-actor.ts). */
export function sessionKindLabel(source: CommandSource | undefined): string {
  return source === 'stored-login' ? 'stored configuration login' : 'browser session';
}

const NO_IDENTITY: FrameIdentity = { server: '', user: '', kind: '' };
let frameIdentity: FrameIdentity = NO_IDENTITY;

const toFrameIdentity = (v: unknown): FrameIdentity => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  const server = str(o.server);
  const user = server ? str(o.user) : '';
  return { server, user, kind: user ? str(o.kind) : '' };
};

/** One line for the tooltip: "Workspace · admin · browser session". */
function identityText(id: FrameIdentity): string {
  return [id.server, id.user, id.kind].filter(Boolean).join(' · ');
}

function fillIdentity(el: HTMLElement, id: FrameIdentity): void {
  const parts: Array<[string, string]> = [['name', id.server], ['user', id.user], ['kind', id.kind]];
  el.replaceChildren(...parts.filter(([, text]) => text)
    .map(([part, text]) => h('span', { class: `crev-eo-srv-${part}` }, text)));
  const text = identityText(id);
  el.title = text ? `Works on ${text}` : '';
}

function identityElement(): HTMLElement {
  const el = h('div', { class: 'crev-eo-titlebar-server' });
  fillIdentity(el, frameIdentity);
  return el;
}

export function setFrameServer(state: {
  profileLabel: string | null;
  identities?: { command?: { status?: string; user?: string | null; source?: CommandSource } };
} | null): void {
  const server = state?.profileLabel ?? '';
  const actor = state?.identities?.command;
  const user = server && actor?.status === 'connected' ? actor.user ?? '' : '';
  frameIdentity = server ? { server, user, kind: user ? sessionKindLabel(actor?.source) : '' } : NO_IDENTITY;
  for (const state of frames.values()) {
    const el = state.host.querySelector<HTMLElement>('.crev-eo-titlebar-server');
    if (el) fillIdentity(el, frameIdentity);
  }
}

/** Companion's own origin: messages to its windows go nowhere else (a page
 *  script that navigated the frame away must not receive them). */
function extensionOrigin(): string {
  try { return new URL(chrome.runtime.getURL('')).origin; } catch { return '*'; }
}

function createIframe(url: string, label: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'crev-eo-iframe';
  iframe.src = url;
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  iframe.setAttribute('title', label);
  return iframe;
}

function updateFrameLabel(state: FrameState, label: string): void {
  state.label = label;
  state.host.setAttribute('aria-label', label);
  state.iframe.setAttribute('title', label);
  const title = state.host.querySelector<HTMLElement>('.crev-eo-titlebar-label');
  if (title) title.textContent = label;
  const max = state.host.querySelector<HTMLElement>('.crev-eo-max');
  if (max) max.setAttribute('aria-label', `${state.restoreBounds ? 'Restore' : 'Maximize'} ${label}`);
  const close = state.host.querySelector<HTMLElement>('.crev-eo-close');
  if (close) close.setAttribute('aria-label', `Close ${label}`);
  for (const handle of state.host.querySelectorAll<HTMLElement>('.crev-eo-resize')) {
    const direction = [...handle.classList]
      .find(name => name.startsWith('crev-eo-resize--'))
      ?.slice('crev-eo-resize--'.length);
    handle.setAttribute('aria-label', `Resize ${label}${direction ? ` (${direction})` : ''}`);
  }
}

function activateFrame(state: FrameState, activation?: FrameActivation): void {
  if (!activation) return;
  if (!state.ready) {
    state.pendingActivation = activation;
    return;
  }
  state.iframe.contentWindow?.postMessage({ type: 'CREV_FRAME_ACTIVATE', activation }, extensionOrigin());
}

function replaceFrame(state: FrameState, opts: MountFrameOptions): void {
  if (frames.get(state.kind) !== state) return;
  const nextIframe = createIframe(opts.url, opts.label);
  state.iframe.replaceWith(nextIframe);
  state.iframe = nextIframe;
  state.url = opts.url;
  state.resourceKey = opts.resourceKey ?? opts.url;
  state.ready = false;
  state.dirty = false;
  state.pendingActivation = opts.activation;
  updateFrameLabel(state, opts.label);
  focus(state);
}

function requestReplace(state: FrameState, opts: MountFrameOptions, resume?: { acknowledged: boolean }): void {
  state.pendingReplacement = opts;
  if (state.replacementPending) return;
  state.replacementPending = true;
  requestFramePermission(state, 'replace', (allowed) => {
    state.replacementPending = false;
    if (!allowed || frames.get(state.kind) !== state) {
      state.pendingReplacement = undefined;
      return;
    }
    const latest = state.pendingReplacement;
    state.pendingReplacement = undefined;
    if (latest) replaceFrame(state, latest);
  }, resume);
}

function focus(state: FrameState): void {
  // Highest z among the open frames; old top moves down by 1.
  let maxZ = MAX_Z - frames.size;
  for (const f of frames.values()) {
    if (f === state) continue;
    f.host.style.zIndex = String(maxZ);
    maxZ++;
  }
  state.host.style.zIndex = String(MAX_Z);
  // Focus order doesn't change geometry, but it does change which
  // overlay is intuitively "active" — leaving the gate stale here
  // is harmless, just refresh so the user can interact with the
  // newly-fronted frame's region immediately.
  updateOverlayBlockState();
  requestAnimationFrame(() => {
    try { state.iframe.contentWindow?.focus(); } catch (e) { log.swallow('overlay:focus', e); }
  });
}

function isFocused(state: FrameState): boolean {
  // If the iframe owns the active element, treat as focused.
  return document.activeElement === state.iframe;
}

// Iframes can ASK to be closed (e.g. Esc inside CodeMirror, which never
// bubbles to the outer document because keyboard events don't cross
// frame boundaries). They post CREV_OVERLAY_CLOSE_PLEASE; we look up
// which kind owns the source contentWindow and run the normal close
// handshake. Without this, the help text "Close (Esc)" lies — the
// shortcut only works when the iframe DOESN'T have focus.
function onFrameMessage(e: MessageEvent): void {
  const msg = e.data as { type?: string } | undefined;
  for (const [kind, state] of frames) {
    if (state.iframe.contentWindow === e.source) {
      if (msg?.type === 'CREV_FRAME_READY') {
        state.ready = true;
        const activation = state.pendingActivation;
        state.pendingActivation = undefined;
        activateFrame(state, activation);
      } else if (msg?.type === 'CREV_FRAME_DIRTY') {
        state.dirty = (msg as { dirty?: unknown }).dirty === true;
      } else if (msg?.type === 'CREV_OVERLAY_CLOSE_PLEASE') {
        requestClose(kind);
      } else if (msg?.type === 'CREV_FRAME_TITLE' && SELF_TITLED_KINDS.has(kind)) {
        const label = (msg as { label?: unknown }).label;
        if (typeof label === 'string' && label.trim()) updateFrameLabel(state, label.trim().slice(0, MAX_TITLE_LENGTH));
      }
      return;
    }
  }
}
window.addEventListener('message', onFrameMessage);

/** Ask the iframe whether it is safe to close or replace its content.
 *
 *  Two-phase handshake:
 *   1. We start a 1.5s fallback timeout. If we hear nothing back,
 *      the iframe is genuinely dead and we force-close so the user
 *      isn't stranded with an unresponsive overlay.
 *   2. If the iframe sends CREV_OVERLAY_CLOSE_PENDING (it's alive
 *      and asking the user via a modal), we clear the fallback.
 *      The user might take seconds or minutes to decide — we wait.
 *   3. CREV_OVERLAY_CLOSE_RESPONSE carries the final yes/no.
 *
 *  Before the PENDING phase existed the fallback could fire while the
 *  iframe's "Discard unsaved changes?" modal was still open.
 */
function requestFramePermission(state: FrameState, purpose: InflightAsk['purpose'], done: (allowed: boolean) => void, resume?: { acknowledged: boolean }): void {
  const ask: InflightAsk = { purpose, acknowledged: resume?.acknowledged === true };
  let settled = false;
  const finish = (allowed: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    done(allowed);
  };
  const onMsg = (e: MessageEvent) => {
    if (e.source !== state.iframe.contentWindow) return;
    const type = (e.data as { type?: string } | undefined)?.type;
    if (type === 'CREV_OVERLAY_CLOSE_PENDING') {
      ask.acknowledged = true;
      clearTimeout(fallback);
      return;
    }
    if (type !== 'CREV_OVERLAY_CLOSE_RESPONSE') return;
    finish(!!(e.data as { ok?: boolean }).ok);
  };
  // No answer in 1.5 s: a dead frame is closed so the user is not stranded, but a window that said it
  // holds unsaved changes is only busy. It stays open and the user is told why.
  // A handshake the frame already acknowledged (handed over on re-injection)
  // waits for the user's answer without a fallback.
  const fallback = ask.acknowledged ? undefined : setTimeout(() => {
    if (closeFallbackDecision(state) === 'close') { finish(true); return; }
    finish(false);
    showToast('The window is busy and holds unsaved changes, so it stays open. Try closing it again in a moment.', 'info');
  }, 1500);
  const cleanup = () => {
    clearTimeout(fallback);
    window.removeEventListener('message', onMsg);
    handshakes.delete(cancel);
    state.inflight.delete(ask);
  };
  // Teardown (re-injection) stops listening without an answer. The ask is
  // handed over with the frame (state.inflight is read first), and the
  // adopting instance listens for the answer (`resume`: no second request).
  const cancel = () => { settled = true; cleanup(); };
  handshakes.add(cancel);
  state.inflight.add(ask);
  window.addEventListener('message', onMsg);
  if (!resume) state.iframe.contentWindow?.postMessage({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, extensionOrigin());
}

/** What the no-answer fallback does: close a frame that never reported unsaved changes, keep one
 *  that did. Exported for tests. */
export function closeFallbackDecision(state: { dirty: boolean }): 'close' | 'keep' {
  return state.dirty ? 'keep' : 'close';
}

/** The element that has focus now (a page control, or another window's frame that opened this
 *  one), if it is a real control and not the body. Read before the new window is in the page. */
function pageFocusOwner(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return null;
  return el;
}

function requestClose(kind: FrameKind, resume?: { acknowledged: boolean }): void {
  const state = frames.get(kind);
  if (!state) return;
  requestFramePermission(state, 'close', (allowed) => {
    if (allowed) unmountFrameOverlay(kind);
  }, resume);
}

// ── Drag / resize ─────────────────────────────────────────────

function currentViewport(): FrameViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function detectSnapZone(clientX: number, clientY: number): SnapZone {
  return detectFrameSnapZone(clientX, clientY, window.innerWidth);
}

function snapBoundsFor(zone: SnapZone): Bounds | null {
  return snapFrameBounds(zone, currentViewport());
}

function wireDrag(state: FrameState, handle: HTMLElement): () => void {
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  let dragging = false;
  let pointerId: number | null = null;
  let snapGhost: HTMLElement | null = null;
  let pendingSnap: SnapZone = null;

  const ensureGhost = (): HTMLElement => {
    if (snapGhost) return snapGhost;
    const g = document.createElement('div');
    g.className = 'crev-eo-snap-ghost';
    g.style.position = 'fixed'; // leak floor — never fall into page flow if the stylesheet is absent
    document.documentElement.appendChild(g);
    snapGhost = g;
    return g;
  };
  const removeGhost = () => {
    if (snapGhost) { snapGhost.remove(); snapGhost = null; }
    pendingSnap = null;
  };
  const updateSnapPreview = (zone: SnapZone) => {
    pendingSnap = zone;
    if (!zone) { removeGhost(); return; }
    const bounds = snapBoundsFor(zone);
    if (!bounds) return;
    const g = ensureGhost();
    g.style.left = `${bounds.left}px`;
    g.style.top = `${bounds.top}px`;
    g.style.width = `${bounds.width}px`;
    g.style.height = `${bounds.height}px`;
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    state.bounds = moveFrameBounds(
      { ...state.bounds, left: startLeft, top: startTop },
      e.clientX - startX,
      e.clientY - startY,
      currentViewport(),
    );
    applyBounds(state);
    updateSnapPreview(detectSnapZone(e.clientX, e.clientY));
    updateOverlayBlockState();
  };

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (pointerId != null) {
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    // Commit snap if the pointer ended in a snap zone — apply the
    // ghost bounds to the host. Otherwise keep wherever the user
    // dragged to.
    if (pendingSnap) {
      const target = snapBoundsFor(pendingSnap);
      if (target) {
        Object.assign(state.bounds, target);
        state.host.style.left = `${target.left}px`;
        state.host.style.top = `${target.top}px`;
        state.host.style.width = `${target.width}px`;
        state.host.style.height = `${target.height}px`;
      }
    }
    removeGhost();
    persistBounds(state.kind, state.bounds);
    state.host.classList.remove('crev-eo--dragging');
    state.iframe.style.pointerEvents = '';
    // Final position may differ from the last `onMove` tick (snap
    // commit jumped the host to the snap-zone rect). Recompute so
    // pills inside the new region pick up the gate state.
    updateOverlayBlockState();
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.crev-eo-btn')) return;
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = state.bounds.left;
    startTop = state.bounds.top;
    handle.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    state.host.classList.add('crev-eo--dragging');
    state.iframe.style.pointerEvents = 'none';
    focus(state);
  });

  return finish;
}

function wireResize(state: FrameState, handle: HTMLElement, dir: ResizeDir): () => void {
  let startX = 0, startY = 0;
  let startW = 0, startH = 0, startLeft = 0, startTop = 0;
  let resizing = false;
  let pointerId: number | null = null;

  const onMove = (e: PointerEvent) => {
    if (!resizing) return;
    state.bounds = resizeFrameBounds(
      { left: startLeft, top: startTop, width: startW, height: startH },
      dir,
      e.clientX - startX,
      e.clientY - startY,
      currentViewport(),
    );
    applyBounds(state);
    updateOverlayBlockState();
  };

  const finish = () => {
    if (!resizing) return;
    resizing = false;
    if (pointerId != null) {
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    persistBounds(state.kind, state.bounds);
    state.host.classList.remove('crev-eo--resizing');
    state.iframe.style.pointerEvents = '';
    updateOverlayBlockState();
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    resizing = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startW = state.bounds.width;
    startH = state.bounds.height;
    startLeft = state.bounds.left;
    startTop = state.bounds.top;
    handle.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    state.host.classList.add('crev-eo--resizing');
    state.iframe.style.pointerEvents = 'none';
    focus(state);
  });

  return finish;
}

// ── Maximize / restore ────────────────────────────────────────

/** Push the frame's bounds to its host's style. */
function applyBounds(state: FrameState): void {
  state.host.style.left = `${state.bounds.left}px`;
  state.host.style.top = `${state.bounds.top}px`;
  state.host.style.width = `${state.bounds.width}px`;
  state.host.style.height = `${state.bounds.height}px`;
}

/** Toggle a frame between its current size and (near-)full viewport. The
 *  pre-maximize bounds are remembered for restore. Not persisted — maximize is
 *  a transient view state, so reopening uses the last manually-sized bounds. */
function toggleMaximize(kind: FrameKind): void {
  const state = frames.get(kind);
  if (!state) return;
  const btn = state.host.querySelector<HTMLElement>('.crev-eo-max');
  if (state.restoreBounds) {
    state.bounds = fitFrameBounds(state.restoreBounds, currentViewport());
    state.restoreBounds = undefined;
    if (btn) { btn.innerHTML = ICON_ARROWS_OUT_SIMPLE; btn.title = 'Maximize'; btn.setAttribute('aria-label', `Maximize ${state.label}`); }
  } else {
    state.restoreBounds = { ...state.bounds };
    state.bounds = maximizedFrameBounds(currentViewport());
    if (btn) { btn.innerHTML = ICON_ARROWS_IN_SIMPLE; btn.title = 'Restore'; btn.setAttribute('aria-label', `Restore ${state.label}`); }
  }
  applyBounds(state);
}

// ── Bounds persistence ────────────────────────────────────────

/** Last placement of a window kind. Extension storage is closed to content
 *  scripts (storage-access.ts): the worker answers this one value
 *  (handlers/page-prefs.ts). */
async function readBounds(opts: MountFrameOptions): Promise<Bounds> {
  try {
    const res = await sendRequest<Extract<InspectorMessage, { type: 'FRAME_BOUNDS_DATA' }>>({ type: 'FRAME_BOUNDS_GET', kind: opts.kind });
    const b = res?.type === 'FRAME_BOUNDS_DATA' ? res.bounds : null;
    if (b) {
      const restored = fitFrameBounds(b, currentViewport());
      if (restored.left !== b.left || restored.top !== b.top
          || restored.width !== b.width || restored.height !== b.height) {
        persistBounds(opts.kind, restored);
      }
      return restored;
    }
  } catch (e) {
    log.swallow('overlay:readBounds', e);
  }
  // Stagger when multiple frames are already open so a second/third overlay
  // doesn't land exactly on top of the first one. Persisted bounds take over
  // on subsequent opens — this only matters the very first time per kind.
  const offset = frames.size * 28;
  return centeredFrameBounds(opts.defaultWidth, opts.defaultHeight, currentViewport(), offset);
}

const persistTimers = new Map<FrameKind, ReturnType<typeof setTimeout>>();
function persistBounds(kind: FrameKind, bounds: Bounds): void {
  const prev = persistTimers.get(kind);
  if (prev) clearTimeout(prev);
  persistTimers.set(kind, setTimeout(() => {
    persistTimers.delete(kind);
    sendFireForget({ type: 'FRAME_BOUNDS_SAVE', kind, bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } });
  }, 400));
}
