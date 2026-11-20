/**
 * The few icons only this page uses (turn, flip, shapes, pick from screen),
 * drawn like the shared sprite: 16 grid, 1.5 stroke, currentColor.
 */
import { svg } from '../lib/dom';

const PATHS = {
  rotl: '<path d="M3 3v4h4"/><path d="M3.5 7A5 5 0 1 1 5 11.5"/>',
  rotr: '<path d="M13 3v4H9"/><path d="M12.5 7A5 5 0 1 0 11 11.5"/>',
  fliph: '<path d="M8 2v12" stroke-dasharray="1.5 1.5"/><path d="M6 4 2 12h4z"/><path d="M10 4l4 8h-4z"/>',
  flipv: '<path d="M2 8h12" stroke-dasharray="1.5 1.5"/><path d="M4 6 12 2v4z"/><path d="M4 10l8 4v-4z"/>',
  none: '<path d="M3.5 12.5 12.5 3.5"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  square: '<rect x="2.5" y="2.5" width="11" height="11" rx="3"/>',
  drop: '<path d="M11 2.2a1.6 1.6 0 0 1 2.8 1.6L12.3 5.3l-1.6-1.6z"/><path d="m9.6 4.6 1.8 1.8"/><path d="M10.4 5.6 4 12l-.6 1.6L5 13l6.4-6.4"/>',
} as const;

export function pageIcon(name: keyof typeof PATHS): Node {
  return svg(`<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${PATHS[name]}</svg>`);
}
