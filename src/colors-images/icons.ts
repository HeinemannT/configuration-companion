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
  upload: '<path d="M8 10V2.5"/><path d="M5 5.5l3-3 3 3"/><path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/>',
  folderUp: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/><path d="M8 11.2V7.4"/><path d="M6.4 9 8 7.4 9.6 9"/>',
  drop: '<path d="M11 2.2a1.6 1.6 0 0 1 2.8 1.6L12.3 5.3l-1.6-1.6z"/><path d="m9.6 4.6 1.8 1.8"/><path d="M10.4 5.6 4 12l-.6 1.6L5 13l6.4-6.4"/>',
} as const;

export function pageIcon(name: keyof typeof PATHS): Node {
  return svg(`<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${PATHS[name]}</svg>`);
}

/** The library's mark: Phosphor "books" in the fill weight (MIT, phosphoricons.com), a quiet grey
 *  solid shape so it reads apart from the line icons of BMP's own folders. */
const BOOKS_FILL = 'M231.65,194.55,198.46,36.75a16,16,0,0,0-19-12.39L132.65,34.42a16.08,16.08,0,0,0-12.3,19l33.19,157.8A16,16,0,0,0,169.16,224a16.25,16.25,0,0,0,3.38-.36l46.81-10.06A16.09,16.09,0,0,0,231.65,194.55ZM136,50.15c0-.06,0-.09,0-.09l46.8-10,3.33,15.87L139.33,66Zm10,47.38-3.35-15.9,46.82-10.06,3.34,15.9Zm70,100.41-46.8,10-3.33-15.87L212.67,182,216,197.85C216,197.91,216,197.94,216,197.94ZM104,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32ZM56,48h48V64H56Zm48,160H56V192h48v16Z';
export function libraryIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', 'ic ci-libic');
  s.setAttribute('viewBox', '0 0 256 256');
  s.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', BOOKS_FILL);
  s.append(path);
  return s;
}
