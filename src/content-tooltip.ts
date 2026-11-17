/**
 * The hover card of a badge: rendering, placement and its popover contract.
 */

import { isTypingIn, matchesShortcut, whichShortcut } from './lib/shortcuts';
import { getTypeColor } from './lib/types';
import { buildObjectCard, fitCardLegend, supportsObjectCardCode } from './lib/object-card';
import { hasStudio } from './lib/studio-mode';
import { render } from './lib/dom';
import { sendRequest, sendFireForget } from './lib/messaging';
import { openObject } from './lib/open-object';
import { updateOverlayBlockState } from './content-frame-overlay';
import type { ContentState } from './content-state';
import { copyIdentity } from './content-copy';
import { updateLabels } from './content-overlays';
import { objectName } from './content-object-name';
import { sendToSW } from './lib/content-port';

/** Layer of the hover card: above outlines and badges, below task surfaces
 *  and toasts (see the layer table in content-overlay.css). Set inline. */
export const TOOLTIP_Z_INDEX = '2147483644';
/** Space between the badge and the card, and the card's margin to the
 *  viewport edge. */
const CARD_GAP = 4;
const CARD_MARGIN = 8;
const POPOVER_FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
export const OBJECT_CARD_INITIAL_DELAY = 450;
export const OBJECT_CARD_WARM_DELAY = 100;
export const OBJECT_CARD_WARM_WINDOW = 300;
export const OBJECT_CARD_LEAVE_DELAY = 220;

function popoverTrigger(label: HTMLElement): HTMLElement {
  return label.querySelector<HTMLElement>('.crev-stub') ?? label;
}

function focusableIn(tooltip: HTMLElement): HTMLElement[] {
  return [...tooltip.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE)];
}

function nextFocusableAfter(trigger: HTMLElement, tooltip: HTMLElement): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE)]
    .filter(el => !tooltip.contains(el) && el.getAttribute('aria-hidden') !== 'true');
  const index = all.indexOf(trigger);
  return index >= 0 ? all[index + 1] ?? null : null;
}

function clearHideTimer(s: ContentState): void {
  if (!s.tooltipHideTimer) return;
  clearTimeout(s.tooltipHideTimer);
  s.tooltipHideTimer = null;
}

function clearShowTimer(s: ContentState): void {
  if (!s.tooltipShowTimer) return;
  clearTimeout(s.tooltipShowTimer);
  s.tooltipShowTimer = null;
}

/** Whether the latest input was the keyboard. Focus that follows a pointer
 *  click must not open or hold the card: a card held open by a clicked
 *  badge's focus once covered the next badge and swallowed its clicks. */
let keyboardModality = false;
/** For tests. */
export function setInputModality(keyboard: boolean): void { keyboardModality = keyboard; }

/** Focus that keeps the card open: inside the card, or on its badge when it
 *  got there from the keyboard. */
function holdsCard(s: ContentState, tooltip: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (tooltip.contains(active)) return true;
  return keyboardModality && !!s.tooltipLabelEl?.contains(active);
}

/** Focus the next or previous Inspect badge in page order (wrapping).
 *  False when the page shows no badge. */
function focusBadge(from: Element, step: 1 | -1): boolean {
  const stubs = [...document.querySelectorAll<HTMLElement>('.crev-label .crev-stub')]
    .filter(el => el.isConnected && !el.closest('[hidden]'));
  if (!stubs.length) return false;
  const at = stubs.indexOf(from as HTMLElement);
  const next = at < 0
    ? (step === 1 ? stubs.find(el => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ?? stubs[0] : [...stubs].reverse().find(el => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) ?? stubs[stubs.length - 1])
    : stubs[(at + step + stubs.length) % stubs.length];
  next.focus();
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

function moveInCard(tooltip: HTMLElement, from: HTMLElement | null, step: 1 | -1): void {
  const controls = focusableIn(tooltip);
  if (controls.length === 0) return;
  const i = from ? controls.indexOf(from) : -1;
  const next = i < 0 ? (step === 1 ? 0 : controls.length - 1) : (i + step + controls.length) % controls.length;
  controls[next].focus();
}

/** Give the portalled rich object card proper popover semantics and a complete
 * mouse + keyboard contract. Wired once per content-script lifetime.
 *
 * Keyboard: a badge is one tab stop. Focusing it shows the card; Enter or
 * ArrowDown moves into the card; arrow keys move between its controls; Escape
 * closes it and returns to the badge; Tab leaves it for the next page control. */
export function wireObjectPopover(s: ContentState, tooltip: HTMLElement): void {
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-label', 'Object details');
  tooltip.setAttribute('aria-modal', 'false');
  const opts = { signal: s.listenerLifetime.signal };

  // Input modality only; passive, never stops the page's own handling.
  document.addEventListener('keydown', () => { keyboardModality = true; }, { capture: true, passive: true, ...opts });
  document.addEventListener('pointerdown', () => { keyboardModality = false; }, { capture: true, passive: true, ...opts });

  tooltip.addEventListener('mouseenter', () => clearHideTimer(s), opts);
  tooltip.addEventListener('mouseleave', () => hideTooltip(s), opts);

  document.addEventListener('focusin', (event) => {
    if (s.tooltipRestoreInProgress) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (tooltip.contains(target)) {
      clearHideTimer(s);
      return;
    }
    if (!keyboardModality) return;
    const label = target.closest<HTMLElement>('.crev-label');
    const rid = label?.dataset.crevLabel;
    if (label && rid) showTooltipForElement(s, label, rid);
  }, opts);

  document.addEventListener('focusout', () => {
    if (!tooltip.classList.contains('crev-visible')) return;
    setTimeout(() => {
      if (holdsCard(s, tooltip) || tooltip.matches(':hover')) return;
      hideTooltip(s);
    }, 0);
  }, opts);

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const onBadge = target.classList.contains('crev-stub') && !!target.closest('.crev-label');
    // F8 / Shift+F8: next / previous badge, only while Inspect is on and the
    // focus is not in one of the page's fields. Nothing else on the page
    // is handled here; the page keeps every other key.
    const badgeStep = s.inspectActive ? whichShortcut(event, ['inspect.next', 'inspect.prev']) : null;
    if (badgeStep) {
      // Moving by keyboard closes the card of the previous badge first (a
      // card opened by hovering stayed open and covered the next badge); the
      // next badge's card then opens only by the keyboard focus rule.
      const hadCard = tooltip.classList.contains('crev-visible');
      if (hadCard) dismissTooltip(s);
      if (focusBadge(target, badgeStep === 'inspect.next' ? 1 : -1)) {
        event.preventDefault();
        return;
      }
    }
    // Enter / ArrowDown on a badge: open its card (if needed) and go in.
    if (onBadge && matchesShortcut(event, 'inspect.card')) {
      const label = target.closest<HTMLElement>('.crev-label')!;
      const rid = label.dataset.crevLabel;
      if (!rid) return;
      event.preventDefault();
      if (!tooltip.classList.contains('crev-visible') || s.tooltipLabelEl !== label) showTooltipForElement(s, label, rid);
      moveInCard(tooltip, null, 1);
      return;
    }
    if (!tooltip.classList.contains('crev-visible')) return;
    const trigger = s.tooltipTriggerEl;
    if (matchesShortcut(event, 'inspectCard.close')) {
      event.preventDefault();
      dismissTooltip(s, tooltip.contains(target) || target === trigger);
      return;
    }
    if (!tooltip.contains(target) || isTypingIn(event)) return;
    if (matchesShortcut(event, 'inspectCard.move')) {
      event.preventDefault();
      moveInCard(tooltip, target, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (matchesShortcut(event, 'inspectCard.leave') && trigger) {
      event.preventDefault();
      const next = event.shiftKey ? trigger : nextFocusableAfter(trigger, tooltip);
      dismissTooltip(s);
      (next ?? trigger).focus();
    }
  }, opts);

  document.addEventListener('pointerdown', (event) => {
    if (!tooltip.classList.contains('crev-visible')) return;
    const target = event.target as Node | null;
    if (!target || tooltip.contains(target) || s.tooltipLabelEl?.contains(target)) return;
    // A card holding an unsaved name or ID is not closed by a click outside: it says so instead.
    const unsaved = tooltip.querySelector<HTMLElement>('[data-unsaved="true"]');
    if (unsaved) { unsaved.dispatchEvent(new CustomEvent('crev-card-keep')); return; }
    dismissTooltip(s);
  }, { capture: true, signal: s.listenerLifetime.signal });
}

export function showTooltipForElement(s: ContentState, el: HTMLElement, rid: string) {
  clearShowTimer(s);
  clearHideTimer(s);

  const tooltip = document.getElementById('crev-tooltip');
  if (!tooltip) return;

  const trigger = popoverTrigger(el);
  if (s.tooltipTriggerEl && s.tooltipTriggerEl !== trigger) {
    s.tooltipTriggerEl.setAttribute('aria-expanded', 'false');
  }
  s.tooltipLabelEl = el;
  s.tooltipTriggerEl = trigger;
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', 'crev-tooltip');
  trigger.setAttribute('aria-expanded', 'true');

  const enrichment = s.enrichments.get(rid);
  const type = enrichment?.type;
  const color = getTypeColor(type);
  // Open EC only for code-bearing types; route to the studio when the type
  // has one (CVO / TextElement), else the floating editor — same rule the
  // stub's code square uses.
  const codeBearing = supportsObjectCardCode(type);
  tooltip.setAttribute('aria-label', `Details of ${objectName(rid, enrichment)}`);
  render(tooltip, buildObjectCard(
    {
      name: enrichment?.name,
      type,
      typeFallback: s.requestedRids.has(rid) ? 'Loading\u2026' : 'Not read yet',
      // An answer with nothing in it: the read failed (or the object is gone), which must not look like a type.
      ...(enrichment && !enrichment.type && !enrichment.name && !enrichment.businessId
        ? { unread: 'Companion asked BMP for this object but got no name or type back (not signed in, no permission, or the object is gone).' } : {}),
      businessId: enrichment?.businessId,
      templateBusinessId: enrichment?.templateBusinessId,
      rid,
      color,
      showCopyLegend: true,
    },
    {
      onRetryRead: () => {
        s.retryFailedEnrichments();
        s.requestedRids.add(rid);
        sendToSW({ type: 'ENRICH_BADGES', rids: [rid] });
        showTooltipForElement(s, el, rid);
      },
      onCopy: async kind => {
        const current = s.enrichments.get(rid);
        const { ok } = await copyIdentity({ rid, ...current }, kind, { loading: !current });
        return ok;
      },
      onOpenFull: () => openObject(rid),
      onOpenEc: codeBearing
        ? () => sendFireForget(hasStudio(type) ? { type: 'OPEN_STUDIO', rid } : { type: 'OPEN_EDITOR', rid })
        : undefined,
      onSaveIdentity: type
        ? async (identity, expect) => {
          const response = await sendRequest({
            type: 'SAVE_IDENTITY',
            rid,
            environment: s.environment ?? undefined,
            ...identity,
            expect,
            objectLabel: { name: enrichment?.name, businessId: enrichment?.businessId, type },
          });
          if (response?.type !== 'SAVE_IDENTITY_RESULT') {
            return { ok: false, error: 'The extension did not return a save result.' };
          }
          if (response.ok) {
            s.enrichments.set(rid, {
              ...enrichment,
              businessId: response.businessId ?? identity.businessId,
              name: response.name ?? identity.name,
              templateBusinessId: response.templateBusinessId ?? identity.templateBusinessId,
            });
            updateLabelsAfterIdentitySave(s);
          }
          return response;
        }
        : undefined,
    },
  ));
  tooltip.style.top = '-9999px';
  tooltip.style.left = '-9999px';
  tooltip.style.maxHeight = '';
  tooltip.style.overflowY = '';
  tooltip.style.display = 'block';
  tooltip.classList.add('crev-visible');
  s.tooltipWarmUntil = Date.now() + OBJECT_CARD_WARM_WINDOW;
  // One hint row that never wraps or overflows (measured now it is laid out).
  const card = tooltip.querySelector<HTMLElement>('.crev-tt-card');
  if (card) fitCardLegend(card);

  const ttRect = tooltip.getBoundingClientRect();
  const place = placeCard(el.getBoundingClientRect(), ttRect.width, ttRect.height, window.innerWidth, window.innerHeight);
  tooltip.style.top = `${place.top}px`;
  tooltip.style.left = `${place.left}px`;
  tooltip.style.maxHeight = place.maxHeight ? `${place.maxHeight}px` : '';
  tooltip.style.overflowY = place.maxHeight ? 'auto' : '';
  tooltip.dataset.side = place.side;

  // A frame overlay (Object View / editor / diff) may sit over the tooltip's
  // new spot. The overlay gate only re-runs on DOM mutations, but we just
  // moved an existing node via inline styles — so it never fired and the
  // tooltip lingered on top of the popout. Nudge the gate here (only when an
  // overlay is actually open) so an intersecting tooltip gets hidden.
  if (document.body.classList.contains('crev-task-open')) {
    updateOverlayBlockState();
  }
}

/** Pointer-intent entry point. Keyboard focus calls showTooltipForElement
 * directly, while pointer fly-over must dwell before any card work begins. */
export function scheduleTooltipForElement(s: ContentState, el: HTMLElement, rid: string): void {
  clearShowTimer(s);
  clearHideTimer(s);
  const visible = document.getElementById('crev-tooltip')?.classList.contains('crev-visible') ?? false;
  const delay = visible || Date.now() < s.tooltipWarmUntil
    ? OBJECT_CARD_WARM_DELAY
    : OBJECT_CARD_INITIAL_DELAY;
  s.tooltipShowTimer = setTimeout(() => {
    s.tooltipShowTimer = null;
    if (!el.isConnected || s.hoveredLabelEl !== el) return;
    showTooltipForElement(s, el, rid);
  }, delay);
}

function updateLabelsAfterIdentitySave(s: ContentState): void {
  updateLabels(s);
}

export interface CardPlacement {
  top: number;
  left: number;
  side: 'below' | 'above' | 'right' | 'left' | 'over';
  /** Set when the card is taller than the room it has; it then scrolls. */
  maxHeight?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** Where the card goes for a badge at `anchor`: below it, else above, else
 *  beside it, never over it while any side has room, always inside the
 *  viewport. Pure, for tests. */
export function placeCard(anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>, width: number, height: number, vw: number, vh: number): CardPlacement {
  const g = CARD_GAP, m = CARD_MARGIN;
  const alignedLeft = clamp(anchor.left, m, vw - width - m);
  if (anchor.bottom + g + height <= vh - m) return { top: anchor.bottom + g, left: alignedLeft, side: 'below' };
  if (anchor.top - g - height >= m) return { top: anchor.top - g - height, left: alignedLeft, side: 'above' };
  const top = clamp(anchor.top, m, vh - height - m);
  if (anchor.right + g + width <= vw - m) return { top, left: anchor.right + g, side: 'right' };
  if (anchor.left - g - width >= m) return { top, left: anchor.left - g - width, side: 'left' };
  // No side has room for the whole card: use the larger of below/above and
  // let the card scroll.
  const roomBelow = vh - m - (anchor.bottom + g);
  const roomAbove = anchor.top - g - m;
  if (roomBelow >= roomAbove && roomBelow >= 80) return { top: anchor.bottom + g, left: alignedLeft, side: 'below', maxHeight: roomBelow };
  if (roomAbove >= 80) return { top: m, left: alignedLeft, side: 'above', maxHeight: roomAbove };
  return { top: m, left: alignedLeft, side: 'over', maxHeight: vh - 2 * m };
}

export function hideTooltip(s: ContentState) {
  clearShowTimer(s);
  clearHideTimer(s);
  s.tooltipHideTimer = setTimeout(() => {
    const tooltip = document.getElementById('crev-tooltip');
    // Last-line defence: never hide while the cursor is ON the card —
    // timer-vs-mouseenter races (and any listener that re-arms the hide
    // mid-transit) can't kill an actively used card this way.
    if (tooltip?.matches(':hover') || (tooltip && holdsCard(s, tooltip)) || tooltip?.querySelector('[data-unsaved="true"]')) {
      s.tooltipHideTimer = null;
      return;
    }
    dismissTooltip(s);
  }, OBJECT_CARD_LEAVE_DELAY);
}

export function dismissTooltip(s: ContentState, restoreFocus = false): void {
  clearShowTimer(s);
  clearHideTimer(s);
  const tooltip = document.getElementById('crev-tooltip');
  const trigger = s.tooltipTriggerEl;
  // Restore focus while the current relationship is still intact. The
  // delegated focus listener may refresh the card once; the cleanup below
  // then closes it and leaves the trigger focused.
  if (restoreFocus && trigger?.isConnected) {
    s.tooltipRestoreInProgress = true;
    try {
      trigger.focus();
    } finally {
      s.tooltipRestoreInProgress = false;
    }
  }
  if (tooltip) {
    tooltip.style.display = 'none';
    tooltip.classList.remove('crev-visible');
  }
  s.tooltipWarmUntil = Date.now() + OBJECT_CARD_WARM_WINDOW;
  trigger?.setAttribute('aria-expanded', 'false');
  s.hoveredLabelEl = null;
  s.tooltipLabelEl = null;
  s.tooltipTriggerEl = null;
}
