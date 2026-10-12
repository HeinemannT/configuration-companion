/** Shared Companion controls, with access glyphs inspired by Config Studio's motifs. */
import {
  ICON_FOLDER, ICON_SLIDERS_HORIZONTAL, ICON_PENCIL, ICON_CUBE, ICON_ARROW_LEFT,
  ICON_SHIELD_PH, ICON_SEARCH, ICON_PLUS, ICON_X,
  ICON_ARROW_UNDO, ICON_ARROW_REDO, ICON_PLAY, ICON_NOTE_PENCIL, ICON_DOTS_THREE_V,
  ICON_INFO, ICON_COLUMNS, ICON_TRASH, ICON_COPY, ICON_ARROW_RIGHT, ICON_CARET_DOWN,
  ICON_LINK, ICON_CODE, ICON_SAVE, ICON_CROSSHAIR,
  ICON_WARNING, ICON_CHECK, ICON_REVERT, ICON_GLOBE, ICON_LIST, ICON_CLOCK, ICON_ARROW_OUT, ICON_MINUS,
} from '../lib/icons';

const accessGlyph = (body: string): string => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const person = '<circle cx="7" cy="5.2" r="2.5"/><path d="M9 16H2.5v-1.7A4.5 4.5 0 0 1 7 9.8h1"/>';
const role = accessGlyph(person + '<path d="m13 9 .5-1.3h1.6l.5 1.3 1.3.8 1.4-.2.8 1.4-.9 1.1v1.5l.9 1.1-.8 1.4-1.4-.2-1.3.8-.5 1.3h-1.6l-.5-1.3-1.3-.8-1.4.2-.8-1.4.9-1.1v-1.5l-.9-1.1.8-1.4 1.4.2Z"/><circle cx="14.3" cy="12.9" r="1.5"/>');
const assignment = accessGlyph(person + '<path d="M14.5 9v7m-3.5-3.5h7"/>');
const delegation = (arrow: string): string => accessGlyph('<circle cx="4" cy="10" r="2"/><path d="M6 10h3m0 0V5h7m-7 5v5h7"/>' + arrow);

const artwork: Record<string, string> = {
  folder: ICON_FOLDER, filter: accessGlyph('<path d="M2.5 3.5h15l-6 7V16l-3 1v-6.5Z"/>'), edit: ICON_PENCIL,
  sort: accessGlyph('<path d="M2.5 4h9M2.5 9h6M2.5 14h3M15 4v12m-3-3 3 3 3-3"/>'),
  panel: accessGlyph('<rect x="2" y="3" width="16" height="14" rx="1"/><path d="M12 3v14"/>'),
  matrix: accessGlyph('<rect x="2" y="3" width="16" height="14" rx="1"/><path d="M2 8h16M2 12.5h16M8 3v14M13 3v14"/>'),
  locate: ICON_CROSSHAIR, run: ICON_PLAY,
  object: ICON_CUBE, type: ICON_CUBE, role, policy: ICON_SHIELD_PH,
  search: ICON_SEARCH, plus: ICON_PLUS, close: ICON_X, undo: ICON_ARROW_UNDO, redo: ICON_ARROW_REDO,
  check: ICON_PLAY, changes: ICON_NOTE_PENCIL, more: ICON_DOTS_THREE_V, help: ICON_INFO,
  explorer: ICON_COLUMNS, trash: ICON_TRASH, copy: ICON_COPY, arrow: ICON_ARROW_RIGHT, back: ICON_ARROW_LEFT,
  down: ICON_CARET_DOWN, assignment: accessGlyph('<circle cx="10" cy="5" r="3"/><path d="M4 17v-2a6 6 0 0 1 12 0v2Z"/>'), fieldAssignment: assignment,
  scope: delegation('<path d="m14 3 2 2-2 2m0 6 2 2-2 2"/>'),
  'delegation-in': delegation('<path d="m12 3-2 2 2 2m0 6-2 2 2 2"/>'),
  'delegation-out': delegation('<path d="m14 3 2 2-2 2m0 6 2 2-2 2"/>'),
  'delegation-down': accessGlyph('<circle cx="10" cy="3.5" r="2"/><path d="M10 5.5V10H4v6m6-6h6v6m-14-2 2 2 2-2m8 0 2 2 2-2"/>'),
  'delegation-up': accessGlyph('<circle cx="4" cy="16.5" r="2"/><circle cx="16" cy="16.5" r="2"/><path d="M4 14.5V10h12v4.5m-6-4.5V3m-3 3 3-3 3 3"/>'),
  link: ICON_LINK,
  json: ICON_CODE, save: ICON_SAVE, warning: ICON_WARNING, valid: ICON_CHECK, skipped: ICON_MINUS, reset: ICON_REVERT,
  globe: ICON_GLOBE, sliders: ICON_SLIDERS_HORIZONTAL, list: ICON_LIST, history: ICON_CLOCK, open: ICON_ARROW_OUT,
  grip: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="7" cy="5" r="1"/><circle cx="13" cy="5" r="1"/><circle cx="7" cy="10" r="1"/><circle cx="13" cy="10" r="1"/><circle cx="7" cy="15" r="1"/><circle cx="13" cy="15" r="1"/></svg>',
};
const icons = Object.fromEntries(Object.entries(artwork).map(([name, svg]) => [name,
  svg.replace(/<svg\b[^>]*>/, tag => tag.replace(/\s(?:width|height|aria-hidden|focusable)="[^"]*"/g, '').replace('<svg ', `<svg data-access-icon="${name}" width="18" height="18" aria-hidden="true" focusable="false" `)),
]));
export const icon = (name: string): string => icons[name] ?? icons.policy;
