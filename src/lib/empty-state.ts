/**
 * The empty state: the mascot, one sentence, an optional action.
 *
 * Used where a surface has nothing to show yet and has room for an
 * illustration (about 160 px of free height). Small "nothing here" lines
 * inside lists and panels stay plain text, and error states never get the
 * mascot. Styles: `.ui-empty*` in src/styles/ui.css.
 *
 * The art is `icons/mascot.svg`, inlined at build time (one source, no
 * copies). It is decorative: the wrapper is `aria-hidden` and the sentence
 * is the accessible content. No animation.
 */
import mascotSource from '../../icons/mascot.svg?raw';
import { h, svg, type Child } from './dom';

export type EmptyArtSize = 'md' | 'sm';

/** Pixel size of the art: 80 (md, the default) or 64 (sm, narrow panels). */
export const EMPTY_ART_PX: Record<EmptyArtSize, number> = { md: 80, sm: 64 };

const MASCOT = mascotSource
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\s(?:role|aria-label)="[^"]*"/g, '')
  .replace(/>\s+</g, '><')
  .trim();

/** The mascot's markup at a size (focusable off for old engines). */
function mascotMarkup(size: EmptyArtSize): string {
  const px = EMPTY_ART_PX[size];
  return MASCOT.replace('<svg ', `<svg width="${px}" height="${px}" focusable="false" `);
}

/** The decorative mascot alone, for a surface that keeps its own card
 *  (Blueprint draws on the page, without ui.css: the size is on the svg). */
export function mascotArt(size: EmptyArtSize = 'md'): HTMLElement {
  return h('span', { class: 'ui-empty-art', 'aria-hidden': 'true' }, svg(mascotMarkup(size)));
}

export interface EmptyStateOptions {
  /** The sentence that says what is (not) here. */
  title?: Child;
  /** A second, quieter line: what to do or why. Inline content only. */
  text?: Child;
  /** Buttons or links under the text. */
  actions?: Child;
  /** A quiet last line under the actions. */
  note?: Child;
  /** Element for the title (a heading where the page outline needs one). */
  titleTag?: 'b' | 'h1' | 'h2' | 'h3';
  /** Art size; `false` for the same block without the mascot. */
  art?: EmptyArtSize | false;
  /** Extra classes for the surface's own spacing. */
  className?: string;
  role?: 'status';
}

export function emptyState(o: EmptyStateOptions): HTMLElement {
  const size = o.art === undefined ? 'md' : o.art;
  return h('div', { class: ['ui-empty', size === 'sm' ? 'sm' : '', o.className ?? ''].filter(Boolean).join(' '), role: o.role },
    size ? mascotArt(size) : null,
    o.title != null && o.title !== '' ? h(o.titleTag ?? 'b', { class: 'ui-empty-title' }, o.title) : null,
    o.text != null && o.text !== '' ? h('p', { class: 'ui-empty-text' }, o.text) : null,
    o.actions ? h('div', { class: 'ui-empty-actions' }, o.actions) : null,
    o.note != null && o.note !== '' ? h('p', { class: 'ui-empty-note' }, o.note) : null,
  );
}

export interface EmptyStateHtmlOptions {
  /** Already escaped HTML. */
  titleHtml?: string;
  textHtml?: string;
  actionsHtml?: string;
  noteHtml?: string;
  titleTag?: 'b' | 'h1' | 'h2' | 'h3';
  art?: EmptyArtSize | false;
  className?: string;
  role?: 'status';
}

/** The same block as markup, for the views that render HTML strings
 *  (Access workspace). The caller escapes its own text. */
export function emptyStateHtml(o: EmptyStateHtmlOptions): string {
  const size = o.art === undefined ? 'md' : o.art;
  const tag = o.titleTag ?? 'b';
  const cls = ['ui-empty', size === 'sm' ? 'sm' : '', o.className ?? ''].filter(Boolean).join(' ');
  return `<div class="${cls}"${o.role ? ` role="${o.role}"` : ''}>`
    + (size ? `<span class="ui-empty-art" aria-hidden="true">${mascotMarkup(size)}</span>` : '')
    + (o.titleHtml ? `<${tag} class="ui-empty-title">${o.titleHtml}</${tag}>` : '')
    + (o.textHtml ? `<p class="ui-empty-text">${o.textHtml}</p>` : '')
    + (o.actionsHtml ? `<div class="ui-empty-actions">${o.actionsHtml}</div>` : '')
    + (o.noteHtml ? `<p class="ui-empty-note">${o.noteHtml}</p>` : '')
    + '</div>';
}
