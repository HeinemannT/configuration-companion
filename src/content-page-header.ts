/**
 * Inspect-mode identity for BMP's page title.
 *
 * Normal page headings do not carry a RID, so the generic DOM scanner cannot
 * badge them. This module joins the already-resolved page context to a
 * high-confidence semantic heading without adding fake BMP data attributes.
 */

import { createIdentityLabel } from './content-overlays';
import type { ContentState } from './content-state';
import { detectPageHeader } from './lib/page-header-detection';
import { sendToSW } from './lib/content-port';
import { getTypeColor } from './lib/types';
import { PAGE_HEADER_PRESENTATION } from './lib/overlay-presentation';

export function removePageHeaderIdentity(s: ContentState): void {
  s.pageHeaderLabel?.remove();
  s.pageHeaderElement?.style.removeProperty('--crev-color');
  s.pageHeaderElement = null;
  s.pageHeaderLabel = null;
  s.pageHeaderRid = null;
}

/**
 * Where the badge goes. In BMP's title bar the heading is one item of a row, and BMP sizes it to
 * the title text (5.6.20 gives it a fixed width and cuts the rest off with an ellipsis): a badge
 * inside it is cut off or wraps under the title. There the badge follows the heading in the row.
 * A heading that is not in a row keeps the badge inside, after the title text. The rule looks only
 * at the row, never at the heading's current size, so it cannot flip while BMP resizes the title.
 */
export function placePageHeaderLabel(heading: HTMLElement, label: HTMLElement): void {
  const row = heading.parentElement;
  const view = heading.ownerDocument.defaultView;
  let after = false;
  if (row && view) {
    const rowStyle = view.getComputedStyle(row);
    after = /flex/.test(rowStyle.display) && !/column/.test(rowStyle.flexDirection);
  }
  if (after) {
    if (heading.nextSibling !== label) heading.after(label);
    label.style.setProperty('flex', 'none');
    label.style.setProperty('align-self', 'center');
  } else {
    if (label.parentElement !== heading) heading.appendChild(label);
    label.style.removeProperty('flex');
    label.style.removeProperty('align-self');
  }
}

export function syncPageHeaderIdentity(s: ContentState, rid: string | undefined): void {
  if (!rid) {
    removePageHeaderIdentity(s);
    return;
  }

  if (
    s.pageHeaderRid === rid
    && s.pageHeaderElement?.isConnected
    && s.pageHeaderLabel?.isConnected
  ) {
    // BMP can rebuild the title bar around the heading: check the place again.
    placePageHeaderLabel(s.pageHeaderElement, s.pageHeaderLabel);
    const name = s.enrichments.get(rid)?.name;
    s.pageHeaderLabel.querySelector<HTMLElement>('.crev-stub')?.setAttribute(
      'aria-label',
      name ? `Inspect page object ${name}` : 'Inspect this page object',
    );
    return;
  }

  removePageHeaderIdentity(s);
  const enrichment = s.enrichments.get(rid);
  const match = detectPageHeader({ expectedName: enrichment?.name });
  if (!match) return;

  const label = createIdentityLabel(s, rid, PAGE_HEADER_PRESENTATION);
  const stub = label.querySelector<HTMLElement>('.crev-stub');
  stub?.setAttribute(
    'aria-label',
    enrichment?.name ? `Inspect page object ${enrichment.name}` : 'Inspect this page object',
  );
  placePageHeaderLabel(match.element, label);
  match.element.style.setProperty('--crev-color', getTypeColor('Page'));

  s.pageHeaderElement = match.element;
  s.pageHeaderLabel = label;
  s.pageHeaderRid = rid;

  if (!enrichment && !s.requestedRids.has(rid)) {
    s.requestedRids.add(rid);
    sendToSW({ type: 'ENRICH_BADGES', rids: [rid] });
  }
}
