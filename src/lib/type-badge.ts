/**
 * Type badge — the signature "full-bleed stub": a domain-coloured tile (icon,
 * white) welded to a neutral code chip (the 3-letter abbreviation). The icon
 * (lib/object-glyphs.ts, the same glyph every surface shows) carries the object's role; the tile colour carries its domain band. Colour
 * lives on the tile ONLY, so a wall of badges reads as a colour-keyed column
 * without shouting.
 *
 * Shared across Browse rows, the object tree, the object header, the inspect
 * overlay, and the EC window so every surface labels a type identically.
 *
 * Sub-badges (opts.sub) stack UNDERNEATH the stub — a violet `</>` when the
 * object carries Extended Code, a teal link when it references other objects
 * (its jump target). Used on the inspect corner label + detail header.
 */
import { h, svg } from './dom';
import { copyTextResult, copyFailureMessage } from './copy-feedback';
import { ICON_CODE, ICON_LINK, ICON_PROP_HISTORY } from './icons';
import { glyphSvg, hasGlyph, typeGlyphSvg } from './object-glyphs';
import { getTypeAbbr, getTypeColor, hasTypeAbbr, CHART_TYPES } from './types';
import { isHistoricalPropertyConfigClass, isPropertyConfigClass } from './property-config';

const CHART_SET = new Set<string>(CHART_TYPES);

/** The badge glyph of a type: the shared object glyph (lib/object-glyphs.ts, the same icon the
 *  rows of Browse, the object window and Blueprint show). Property objects are in the same set,
 *  one glyph per value kind; a chart type without an entry of its own gets the chart; anything
 *  unknown the plain object. */
export function typeIcon(type?: string): string {
  if (type && !hasGlyph(type) && CHART_SET.has(type)) return glyphSvg('chart');
  return typeGlyphSvg(type);
}

/** True when the type has a code of its own to show. Any other type reads 'OBJ' beside its
 *  icon: a code cut from a class name ("Card" → CAR) would look curated and is not. */
function isMapped(type?: string): boolean {
  return !!type && (hasTypeAbbr(type) || CHART_SET.has(type));
}

export interface BadgeOpts {
  /** Compact 18px variant for dense rows (tree, Browse results, references). */
  size?: 'xs';
  /** Icon-only role marker for space-constrained compound controls. */
  iconOnly?: boolean;
  /** Sub-badges stacked under the stub (inspect corner label / detail header). */
  sub?: { code?: boolean; ref?: boolean };
}

export interface BadgeCopyOpts {
  /** Optional surface feedback after the clipboard write succeeds. */
  onCopied?: (id: string) => void;
  /** Optional surface feedback when clipboard access is unavailable or blocked. */
  onCopyError?: (message: string) => void;
}

/**
 * Wire the panel-wide badge gesture onto a stub badge: click copies the
 * surface-resolved identity with a brief, non-layout-shifting green tint.
 * The badge label stays stable; the host surface announces the result through
 * `onCopied` / `onCopyError` (normally the panel's polite live status line).
 */
export function wireBadgeCopy(
  badge: HTMLElement,
  id: (event?: Event) => string,
  opts: BadgeCopyOpts = {},
): HTMLElement {
  badge.classList.add('bdg-copy');
  badge.setAttribute('role', 'button');
  badge.tabIndex = 0;
  const current = (event?: Event) => id(event);
  badge.setAttribute('aria-label', `Copy ${current()}`);
  badge.title = `${badge.title} \u00b7 Click to copy ${current()}`;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const showCopied = (val: string): void => {
    opts.onCopied?.(val);
    badge.classList.add('bdg-copied');
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      badge.classList.remove('bdg-copied');
      copiedTimer = undefined;
    }, 700);
  };

  const copy = (e: Event): void => {
    e.stopPropagation();
    const val = current(e);
    if (!val) return;
    void copyTextResult(val).then(result => {
      if (result.ok) showCopied(val);
      else opts.onCopyError?.(copyFailureMessage(result.reason));
    });
  };
  badge.addEventListener('click', copy);
  badge.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    copy(e);
  });
  return badge;
}

/**
 * Build a type badge element. Default is the 20px stub; `size: 'xs'` is the
 * compact row variant. Pass `sub` to weld code / reference indicator squares
 * underneath (the inspect-overlay corner label).
 */
export function typeBadge(type?: string, opts: BadgeOpts = {}): HTMLElement {
  const mapped = isMapped(type);
  const property = isPropertyConfigClass(type ?? '');
  const historical = isHistoricalPropertyConfigClass(type ?? '');
  const tile = h('span', { class: 'tile' }, svg(typeIcon(type)));
  if (historical) {
    tile.appendChild(h('span', {
      class: 'bdg-history',
      'aria-label': 'Historical property',
    }, svg(ICON_PROP_HISTORY)));
  }
  const badge = h('span', {
    class: [
      'bdg',
      property ? 'bdg-property' : '',
      historical ? 'bdg-historical' : '',
      opts.size === 'xs' ? 'xs' : '',
      opts.iconOnly ? 'icon-only' : '',
    ].filter(Boolean).join(' '),
    style: `--c:${getTypeColor(type)}`,
    title: type ?? '',
  },
    tile,
    ...(opts.iconOnly ? [] : [h('span', { class: 'lbl' }, mapped ? getTypeAbbr(type) : 'OBJ')]),
  );

  const hasSub = opts.sub && (opts.sub.code || opts.sub.ref);
  if (!hasSub) return badge;

  const row = h('span', { class: 'sbrow' });
  if (opts.sub!.code) {
    row.appendChild(h('span', { class: 'sq code', title: 'Carries Extended Code' }, svg(ICON_CODE)));
  }
  if (opts.sub!.ref) {
    row.appendChild(h('span', { class: 'sq ref', title: 'References other objects' }, svg(ICON_LINK)));
  }
  return h('span', { class: `bdg-stack${opts.size === 'xs' ? ' xs' : ''}` }, badge, row);
}
