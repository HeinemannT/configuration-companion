/**
 * Content script overlay rendering — badge creation, label updates, code buttons.
 * All functions receive ContentState explicitly instead of reading module-level vars.
 */

import { matchesShortcut } from './lib/shortcuts';
import type { BmpObject } from './lib/types';
import { getTypeColor, getTypeAbbr } from './lib/types';
import { typeAffordances } from './lib/widget-metadata';
import { hasStudio, modeForType } from './lib/studio-mode';
import { typeIcon } from './lib/type-badge';
import { isHistoricalPropertyConfigClass, isPropertyConfigClass } from './lib/property-config';
import { getAllRidElements } from './lib/dom-scanner';
import { log } from './lib/logger';
import { ICON_CODE, ICON_ARROW_FAT_LINE, ICON_VARIABLE, ICON_PROP_HISTORY } from './lib/icons';
import { svg } from './lib/dom';
import { DISCOVERED_RIDS_CAP } from './lib/constants';
import { BADGE_DESCRIPTION, COPY_KIND_FOR_MODIFIER, getModifier, type CopyKind } from './lib/namespace';
import { objectName } from './content-object-name';
import { clearOutlineColor, ensureFrame, removeFrame, setOutlineColor } from './content-outline';
import { PLACING_CLASS, placeNewBadges } from './content-badge-layout';
import { applyCurrent, clearCurrent, markCurrent } from './content-current';
import { copyIdentity } from './content-copy';
import { sendToSW } from './lib/content-port';
import { sendFireForget } from './lib/messaging';
import { openObject, type KnownIdentity } from './lib/open-object';
import { resolveDisplayIdentity } from './lib/object-identity';
import type { CascadeTarget, ContentState } from './content-state';
import {
  resolvedOverlayType,
  type OverlayPresentation,
} from './lib/overlay-presentation';

export interface AdditionalOverlayTarget extends OverlayPresentation {
  element: Element;
  rid: string;
  propertyTarget?: CascadeTarget;
}

const labelPropertyTargets = new WeakMap<HTMLElement, CascadeTarget>();

/** How long a plain click waits for a second click before it copies. Short
 *  enough to read as immediate; long enough to catch a normal double-click,
 *  so opening the object window does not also copy. */
export const SINGLE_CLICK_DELAY = 200;

/** Make `rid` the tab's current position (lib/current-position.ts). */
export function pointAt(rid: string, known?: KnownIdentity, source: 'badge' | 'contextmenu' = 'badge'): void {
  sendFireForget({
    type: 'SET_CONTEXT_RID', rid, source,
    ...(known?.name ? { name: known.name } : {}),
    ...(known?.type ? { objectType: known.type } : {}),
    ...(known?.businessId ? { businessId: known.businessId } : {}),
  });
}

function overlayVisualType(label: Element, objectType?: string): string | undefined {
  return label instanceof HTMLElement && label.dataset.crevVisualType
    ? label.dataset.crevVisualType
    : objectType;
}

/** Is there room above `el` for an upward-overhanging edge pill (~11px), or
 *  would it be clipped? Clipping happens when the host sits flush against the
 *  top of a scroll/overflow-clipping ancestor (tab strips, header, breadcrumb
 *  bar) or the viewport. Walks ancestors checking for a clip boundary within
 *  the needed gap; returns false if any is too close. */
function hasRoomAbove(el: Element, needed = 11): boolean {
  const top = el.getBoundingClientRect().top;
  if (top < needed) return false; // viewport top
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    // A vertical clip boundary slices the upward overhang. Check overflowY
    // (resolves the `overflow` shorthand). Note CSS couples the axes:
    // overflow-x:hidden/auto + overflow-y:visible computes overflow-y to
    // `auto` — but such an element IS then a scroll container that clips
    // vertically too, so counting it is correct. The `needed`-px distance
    // check keeps elements far from any boundary on the overhang variant.
    const oy = getComputedStyle(a).overflowY;
    if ((oy === 'hidden' || oy === 'clip' || oy === 'auto' || oy === 'scroll')
        && top - a.getBoundingClientRect().top < needed) return false;
  }
  return true;
}

/** The cascade jump chip — lives in the label's meta row. Shows the next link
 *  in the chain (InputView → inputSet, ActionButton → actionObject); clicking
 *  it opens THAT object in the object window. */
function createCascadeChip(cascade: { rid: string; businessId?: string; type?: string; name?: string }): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'crev-cascade';
  chip.setAttribute('data-crev-cascade-rid', cascade.rid);
  chip.style.background = getTypeColor(cascade.type);
  chip.textContent = cascade.businessId ?? cascade.name ?? getTypeAbbr(cascade.type);
  // The chip carries no `data-crev-label`, so the hover info card never fires
  // for it — a native `title` is safe here and is the only thing explaining
  // that this small secondary chip is a clickable link.
  const cascadeId = cascade.name ?? cascade.businessId ?? cascade.type ?? 'object';
  chip.title = `Linked ${cascade.type ?? 'object'}: ${cascadeId}. Click to open it in the object window`;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openObject(cascade.rid, cascade);
  });
  return chip;
}

/**
 * Fill an inspect corner label with the approved "stub + squares" layout:
 *
 *   .crev-stub  — full-bleed type stub: colour tile (role glyph) welded to a
 *                 light identity chip (businessId / name)
 *   .crev-meta  — the squares BESIDE it on one rail: violet `</>`
 *                 (opens the editor / CVO studio — folds the old dark action
 *                 strip into the design), teal link (references indicator),
 *                 and the cascade jump chip when the widget has a chain.
 *
 * Idempotent: the create path and the late-enrichment path in updateLabels()
 * share this ONE implementation. The text element persists across re-renders
 * so the click handler bound in syncOverlays survives. Square presence comes
 * from the single `typeAffordances` seam, not ad-hoc type checks.
 */
function renderLabelContent(
  label: HTMLElement,
  rid: string,
  enrichment?: { type?: string; businessId?: string; templateBusinessId?: string; name?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } },
): void {
  const type = enrichment?.type;
  const visualType = overlayVisualType(label, type);

  let stub = label.querySelector<HTMLElement>('.crev-stub');
  if (!stub) {
    stub = document.createElement('span');
    stub.className = 'crev-stub';
    const existingText = label.querySelector<HTMLElement>('.crev-label-text');
    label.prepend(stub);
    if (existingText) stub.appendChild(existingText);
  }
  const propertyType = isPropertyConfigClass(type ?? '');
  const historicalProperty = isHistoricalPropertyConfigClass(type ?? '');
  stub.classList.toggle('crev-stub--property', propertyType);
  stub.classList.toggle('crev-stub--historical', historicalProperty);

  let tile = stub.querySelector<HTMLElement>('.crev-tile');
  if (!tile) {
    tile = document.createElement('span');
    tile.className = 'crev-tile';
    stub.prepend(tile);
  }
  tile.replaceChildren(svg(typeIcon(visualType)));
  if (historicalProperty) {
    const history = document.createElement('span');
    history.className = 'crev-history-indicator';
    history.setAttribute('aria-label', 'Historical property');
    history.appendChild(svg(ICON_PROP_HISTORY));
    tile.appendChild(history);
  }

  const text = stub.querySelector<HTMLElement>('.crev-label-text');
  const display = resolveDisplayIdentity({ rid, ...enrichment });
  if (text) text.textContent = display.primary || enrichment?.name || getTypeAbbr(visualType);
  // Name first, so 25 badges are 25 different stops for a screen reader; the
  // click scheme is the description.
  if (!label.classList.contains('crev-page-label')) {
    stub.setAttribute('aria-label', `Copy ID of ${objectName(rid, enrichment)}`);
    stub.setAttribute('aria-description', BADGE_DESCRIPTION);
  }

  // Meta row — rebuilt every call so late enrichment can only ever add the
  // correct squares (never stale ones from a previous unknown-type render).
  label.querySelector('.crev-meta')?.remove();
  const aff = typeAffordances(type);
  const cascade = enrichment?.cascade;
  const property = labelPropertyTargets.get(label);
  if (!aff.code && !aff.flow && !cascade && !property) return;

  const meta = document.createElement('span');
  meta.className = 'crev-meta';

  if (aff.flow) {
    // Teal fat-arrow square: "this widget has a chain to walk" (replaces the
    // ⇢ that was welded onto the stub). The object window shows the chain as
    // its structure tree, so the arrow opens the object there.
    const sub = document.createElement('button');
    sub.className = 'crev-sub crev-sub--flow';
    sub.setAttribute('aria-label', 'Open the flow in the object window');
    sub.appendChild(svg(ICON_ARROW_FAT_LINE));
    sub.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openObject(rid, enrichment);
    });
    meta.appendChild(sub);
  }

  if (aff.code) {
    // The violet code square IS the open-in-editor affordance. No native
    // `title` — it would paint a browser tooltip over the hover info card;
    // `aria-label` keeps it discoverable to screen readers.
    // (No reference square: it carried no action, and the flow ⇢ + the panel
    // sections already say "this links elsewhere" — user cut it as noise.)
    const studio = hasStudio(type);
    const btn = document.createElement('button');
    btn.className = 'crev-sub crev-sub--code';
    btn.setAttribute('aria-label', studio ? `Open in the ${modeForType(type).title}` : 'Open in the editor');
    btn.appendChild(svg(ICON_CODE));
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      sendFireForget(studio ? { type: 'OPEN_STUDIO', rid } : { type: 'OPEN_EDITOR', rid });
    });
    meta.appendChild(btn);
  }
  if (property) {
    const btn = document.createElement('button');
    btn.className = 'crev-sub crev-sub--property';
    btn.setAttribute('aria-label', `Open property ${property.businessId ?? property.name ?? ''} in the object window`.replace(/\s+/g, ' '));
    btn.title = `Property: ${property.businessId ?? property.name ?? property.rid}. Click to open it in the object window`;
    btn.style.setProperty('--crev-property-color', getTypeColor(property.type));
    btn.appendChild(svg(property.type ? typeIcon(property.type) : ICON_VARIABLE));
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openObject(property.rid, property);
    });
    meta.appendChild(btn);
  }
  if (cascade) meta.appendChild(createCascadeChip(cascade));

  label.appendChild(meta);
}

/** Tiny hosts (tab links, breadcrumb chips) can't fit the full stub — it
 *  overlaps neighbours or clips against the host's overflow. Degrade to the
 *  tile-only compact form when the stub outgrows its host. */
function applyCompactMode(label: HTMLElement, host: HTMLElement): void {
  if (label.dataset.crevCompact === 'true') {
    label.classList.add('crev-label--compact');
    return;
  }
  label.classList.remove('crev-label--compact');
  const hostW = host.clientWidth;
  // The stub alone: the sub-badges on the rail beside it may run past the
  // host (the layout pass keeps them in the viewport).
  const stubW = label.querySelector<HTMLElement>('.crev-stub')?.offsetWidth ?? label.offsetWidth;
  if (hostW > 0 && stubW > hostW - 4) {
    label.classList.add('crev-label--compact');
  }
}

/**
 * Build one interactive identity label. Widget overlays and the synthetic page
 * header identity share this exact renderer and gesture contract; placement is
 * deliberately left to the caller.
 */
export function createIdentityLabel(
  s: ContentState,
  rid: string,
  presentation: OverlayPresentation = {},
  propertyTarget?: CascadeTarget,
): HTMLElement {
  const enrichment = s.enrichments.get(rid);
  const label = document.createElement('span');
  label.className = ['crev-label', presentation.labelClassName].filter(Boolean).join(' ');
  if (presentation.visualType) label.dataset.crevVisualType = presentation.visualType;
  if (presentation.compact) {
    label.dataset.crevCompact = 'true';
    label.classList.add('crev-label--compact');
  }
  if (presentation.placement === 'inline-start') label.classList.add('crev-label--inline-start');
  if (!enrichment) label.classList.add('crev-label-loading');
  label.setAttribute('data-crev-label', rid);

  const labelText = document.createElement('span');
  labelText.className = 'crev-label-text';
  // The click-modifier hints live in the hover info card. A native title
  // paints over that card, so the label intentionally has none.
  label.appendChild(labelText);
  if (propertyTarget) labelPropertyTargets.set(label, propertyTarget);

  renderLabelContent(label, rid, enrichment);
  const stubEl = label.querySelector<HTMLElement>('.crev-stub')!;
  stubEl.setAttribute('role', 'button');
  stubEl.tabIndex = 0;
  if (!label.classList.contains('crev-page-label')) {
    stubEl.setAttribute('aria-label', `Copy ID of ${objectName(rid, enrichment)}`);
    stubEl.setAttribute('aria-description', BADGE_DESCRIPTION);
  }

  // The stub copies an ID (content-copy.ts: plain = business ID, Shift = RID,
  // Alt = instance ID, Ctrl/Cmd = instance reference) and makes the object
  // the tab's current position. It never opens or switches the side panel.
  //
  // A double-click opens the object window and copies nothing: the plain
  // copy waits SINGLE_CLICK_DELAY for a second click, and the second click
  // of a pair (detail 2) cancels it. Modifier clicks and keyboard activation
  // copy at once.
  let pendingCopy: ReturnType<typeof setTimeout> | null = null;
  const cancelPendingCopy = () => {
    if (pendingCopy) { clearTimeout(pendingCopy); pendingCopy = null; }
  };
  const copy = (kind: CopyKind) => {
    const enriched = s.enrichments.get(rid);
    void copyIdentity({ rid, ...enriched }, kind, { loading: !enriched }).then(({ ok }) => {
      if (!ok) return;
      label.classList.add('crev-label--copied');
      setTimeout(() => label.classList.remove('crev-label--copied'), 600);
    });
  };
  stubEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.detail > 1) { cancelPendingCopy(); return; }
    const kind = COPY_KIND_FOR_MODIFIER[getModifier(e)];
    pointAt(rid, s.enrichments.get(rid));
    markCurrent(rid);
    cancelPendingCopy();
    if (kind === 'id' && e.detail === 1) {
      pendingCopy = setTimeout(() => { pendingCopy = null; copy(kind); }, SINGLE_CLICK_DELAY);
    } else {
      copy(kind);
    }
  });

  // Pressed state at once, though a plain copy waits for a second click.
  stubEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    label.classList.add('crev-label--pressed');
    const release = () => setTimeout(() => label.classList.remove('crev-label--pressed'), 120);
    stubEl.addEventListener('pointerup', release, { once: true });
    stubEl.addEventListener('pointerleave', release, { once: true });
  });

  // Space copies (with the same modifiers as a click); Alt+Enter opens the
  // object window, as a double-click does. Enter and ArrowDown open the card
  // and move into it (content-tooltip.ts). Keys from lib/shortcuts.ts.
  stubEl.addEventListener('keydown', (e) => {
    if (matchesShortcut(e, 'inspect.open')) {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingCopy();
      markCurrent(rid);
      openObject(rid, s.enrichments.get(rid));
      return;
    }
    if (!matchesShortcut(e, 'inspect.copy', { anyModifiers: true })) return;
    e.preventDefault();
    // Keyboard activation carries the same modifiers as a click.
    stubEl.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, detail: 0,
      shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
    }));
  });

  // Double-click upgrades the cheap single-click selection to full object view.
  label.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest?.('.crev-meta')) return;
    e.preventDefault();
    e.stopPropagation();
    cancelPendingCopy();
    markCurrent(rid);
    // The badge already knows the object: pass it on so the window paints
    // its title at once and the service worker takes the hinted two-post read.
    openObject(rid, s.enrichments.get(rid));
  });

  return label;
}

/** Incremental overlay sync: clean stale, add new badges, request enrichment.
 *  `additionalTargets` supplies identities known through React/configuration
 *  joins even though BMP did not place a RID on the rendered DOM element. */
export function syncOverlays(s: ContentState, additionalTargets: readonly AdditionalOverlayTarget[] = []) {
  const additionalByElement = new Map(additionalTargets.map(target => [target.element, target]));

  // 1. Clean stale labels (detached parents or elements no longer in DOM)
  for (const label of document.querySelectorAll('.crev-label')) {
    if (!label.parentElement || !document.body.contains(label.parentElement)) {
      label.remove();
      continue;
    }
    if (label.classList.contains('crev-edit-field-label')) {
      const target = additionalByElement.get(label.parentElement);
      if (!target || target.rid !== label.getAttribute('data-crev-label')) {
        const parent = label.parentElement;
        label.remove();
        s.badgedElements.delete(parent);
        if (!parent.querySelector('.crev-label')) {
          parent.classList.remove('crev-outline');
          removeFrame(parent);
          clearOutlineColor(parent);
        }
      }
    }
  }

  const includeLinks = s.enrichMode === 'all';
  const elements: AdditionalOverlayTarget[] = [...getAllRidElements(includeLinks)];
  const seenElements = new Set(elements.map(item => item.element));
  for (const target of additionalTargets) {
    if (!seenElements.has(target.element)) {
      elements.push(target);
      seenElements.add(target.element);
    }
  }
  const linkCount = includeLinks ? elements.filter(({ element }) => element.tagName === 'A').length : 0;
  log.debug('sync', `syncOverlays: ${elements.length} elements (${linkCount} links), enrichMode=${s.enrichMode}`);
  const ridsToEnrich: string[] = [];

  // Filter to new elements only. The WeakSet is the fast path, while the
  // direct-child check is the recovery path when state was reset but BMP kept
  // a navigation host alive. Identity is per host (the same RID may appear in
  // several places), so never dedupe document-wide by RID.
  const newElements = elements.filter(({ element, rid }) => {
    if (s.badgedElements.has(element)) return false;
    const owned = Array.from(element.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('crev-label'),
    );
    const matching = owned.find(label => label.dataset.crevLabel === rid);
    if (matching) {
      for (const duplicate of owned) {
        if (duplicate !== matching) duplicate.remove();
      }
      s.badgedElements.add(element);
      return false;
    }
    // A reused BMP host can change identity in place. Remove its stale
    // Companion label before mounting the new identity and handlers.
    for (const stale of owned) stale.remove();
    return true;
  });

  // Write pass: apply DOM changes
  for (const { element, rid, labelClassName, visualType, placement, compact, propertyTarget } of newElements) {
    const enrichment = s.enrichments.get(rid);
    const presentation = { labelClassName, visualType, placement, compact } satisfies OverlayPresentation;
    const color = getTypeColor(resolvedOverlayType(enrichment?.type, presentation));

    element.classList.add('crev-outline');
    // The outline is our own frame child (content-outline.ts): ticks at rest,
    // the full line on hover, never the page's own border or outline.
    ensureFrame(element as HTMLElement);
    setOutlineColor(element as HTMLElement, color, enrichment?.type ?? visualType);

    const label = createIdentityLabel(s, rid, presentation, propertyTarget);

    // Every badge hangs on the top-left edge of its outline, half above the
    // line, its sub-badges beside it on one rail (content-overlay.css), so
    // the widget's own controls at the top right stay free. Short, inline
    // targets (breadcrumbs, tabs, menu buttons, nav links) are mostly text:
    // they keep a tile on the top-right corner, half outside
    // (.crev-label--edge), and the layout pass keeps it off their text.
    const elHeight = (element as HTMLElement).offsetHeight;
    if (placement !== 'inline-start' && (
      labelClassName === 'crev-edit-field-label'
      || element.tagName === 'A'
      || (elHeight > 0 && elHeight <= 26)
    )) {
      // The overhang gets sliced off when the host is flush against a
      // clipping ancestor's top (tab strips, the BMP header, breadcrumb
      // bars) or the viewport top. Detect that and tuck the pill just
      // inside the top edge instead, so it stays fully visible. Kept as a
      // child-of-host placement (not a portal layer) so it scrolls with the
      // element and doesn't fight the editor/objectview frame overlays.
      label.classList.add(hasRoomAbove(element) ? 'crev-label--edge' : 'crev-label--edge-inside');
    }

    if (placement === 'inline-start') element.prepend(label);
    else {
      // Hidden until the layout pass has placed it (content-badge-layout.ts),
      // so it does not show in its corner first and then move.
      label.classList.add(PLACING_CLASS);
      element.appendChild(label);
    }
    applyCompactMode(label, element as HTMLElement);
    s.badgedElements.add(element);

    // Track RIDs that need enrichment (with dedup)
    if (!s.enrichments.has(rid) && !s.requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      s.requestedRids.add(rid);
    }
  }

  // Single pass over every element for the two cache concerns, instead of two
  // separate full walks of a dense page's rid set per sync:
  //   (a) re-request enrichment for any rid still missing it — this also covers
  //       already-badged elements whose enrichment never landed (the write pass
  //       above only handles brand-new elements), and
  //   (b) discover new rids for the object cache.
  const now = Date.now();
  const newDiscovered: BmpObject[] = [];
  for (const { rid } of elements) {
    if (!s.enrichments.has(rid) && !s.requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      s.requestedRids.add(rid);
    }
    if (!s.discoveredRids.has(rid) && s.discoveredRids.size < DISCOVERED_RIDS_CAP) {
      s.discoveredRids.add(rid);
      newDiscovered.push({ rid, source: 'dom' as const, discoveredAt: now, updatedAt: now });
    }
  }

  // The current object keeps its ring on badges added since; the new
  // badges, hidden until placed, are placed in the next frame.
  if (newElements.length) { applyCurrent(); placeNewBadges(); }

  // Request enrichment for unknown RIDs
  if (ridsToEnrich.length > 0) {
    log.debug('sync', `ENRICH_BADGES: sending ${ridsToEnrich.length} RIDs`, ridsToEnrich);
    sendToSW({ type: 'ENRICH_BADGES', rids: ridsToEnrich });
  }
  if (newDiscovered.length > 0) {
    sendToSW({ type: 'OBJECTS_DISCOVERED', objects: newDiscovered });
  }
}

/** Remove all overlays and reset badge tracking */
export function removeOverlays(s: ContentState) {
  for (const label of document.querySelectorAll('.crev-label')) {
    label.remove();
  }
  for (const strip of document.querySelectorAll('.crev-actions')) {
    strip.remove();
  }
  for (const el of document.querySelectorAll('.crev-has-cascade')) {
    el.classList.remove('crev-has-cascade');
  }
  for (const el of document.querySelectorAll('.crev-outline')) {
    el.classList.remove('crev-outline');
    removeFrame(el);
    clearOutlineColor(el as HTMLElement);
  }
  clearCurrent();
  const tooltip = document.getElementById('crev-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  s.resetOverlays();
}

/** Labels whose identity text changed and whose tiny-host fit is checked in
 *  the next frame, all at once (one layout for every chunk of names that
 *  arrived in that frame, not one per label per chunk). */
const fitPending = new Set<HTMLElement>();
let fitFrame = 0;

function scheduleFit(label: HTMLElement): void {
  fitPending.add(label);
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(flushFit);
}

/** Check the fit of every waiting label: writes, then reads, then writes. */
export function flushFit(): void {
  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = 0;
  const labels = [...fitPending].filter(l => l.isConnected && l.parentElement);
  fitPending.clear();
  const fluid = labels.filter(l => l.dataset.crevCompact !== 'true');
  for (const l of labels) if (l.dataset.crevCompact === 'true') l.classList.add('crev-label--compact');
  for (const l of fluid) l.classList.remove('crev-label--compact');
  const tooWide = fluid.map(l => {
    const hostW = l.parentElement!.clientWidth;
    const stubW = l.querySelector<HTMLElement>('.crev-stub')?.offsetWidth ?? l.offsetWidth;
    return hostW > 0 && stubW > hostW - 4;
  });
  fluid.forEach((l, i) => { if (tooWide[i]) l.classList.add('crev-label--compact'); });
}

/** Update badge labels from enrichment data. `rids`: only the labels of
 *  these objects (the names that just arrived); every label when left out. */
export function updateLabels(s: ContentState, rids?: Iterable<string>) {
  const want = rids ? new Set(rids) : null;
  if (want && !want.size) return;
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    const rid = label.getAttribute('data-crev-label');
    if (!rid || (want && !want.has(rid))) continue;
    const enrichment = s.enrichments.get(rid);
    if (enrichment) {
      // Rebuild stub + identity + meta squares from the (now-known) type.
      renderLabelContent(label, rid, enrichment);
      label.classList.remove('crev-label-loading');
      const parent = label.parentElement;
      if (parent) {
        const visual = overlayVisualType(label, enrichment.type);
        setOutlineColor(parent, getTypeColor(visual), enrichment.type ?? visual);
        // The identity text just changed width — re-check the tiny-host fit.
        if (!label.classList.contains('crev-page-label')) scheduleFit(label);
      }
    }
  }
}
