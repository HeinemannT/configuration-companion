/** The same artwork as Companion's sidebar and editors, sized by this surface. */
import {
  ICON_FOLDER, ICON_SLIDERS_HORIZONTAL, ICON_PENCIL, ICON_CUBE, ICON_ARROW_LEFT,
  ICON_IDENTIFICATION_CARD, ICON_SHIELD_PH, ICON_SEARCH, ICON_PLUS, ICON_X,
  ICON_ARROW_UNDO, ICON_ARROW_REDO, ICON_PLAY, ICON_NOTE_PENCIL, ICON_DOTS_THREE_V,
  ICON_INFO, ICON_COLUMNS, ICON_TRASH, ICON_COPY, ICON_ARROW_RIGHT, ICON_CARET_DOWN,
  ICON_PROP_REFERENCE, ICON_PROP_LIST, ICON_FLOW_ARROW, ICON_LINK, ICON_CODE, ICON_SAVE,
  ICON_WARNING, ICON_CHECK, ICON_REVERT, ICON_GLOBE, ICON_LIST, ICON_CLOCK, ICON_ARROW_OUT,
} from '../lib/icons';

const artwork: Record<string, string> = {
  folder: ICON_FOLDER, filter: ICON_SLIDERS_HORIZONTAL, edit: ICON_PENCIL,
  object: ICON_CUBE, type: ICON_CUBE, role: ICON_IDENTIFICATION_CARD, policy: ICON_SHIELD_PH,
  search: ICON_SEARCH, plus: ICON_PLUS, close: ICON_X, undo: ICON_ARROW_UNDO, redo: ICON_ARROW_REDO,
  check: ICON_PLAY, changes: ICON_NOTE_PENCIL, more: ICON_DOTS_THREE_V, help: ICON_INFO,
  explorer: ICON_COLUMNS, trash: ICON_TRASH, copy: ICON_COPY, arrow: ICON_ARROW_RIGHT, back: ICON_ARROW_LEFT,
  down: ICON_CARET_DOWN, assignment: ICON_PROP_REFERENCE, fieldAssignment: ICON_PROP_LIST, scope: ICON_FLOW_ARROW, link: ICON_LINK,
  json: ICON_CODE, save: ICON_SAVE, warning: ICON_WARNING, valid: ICON_CHECK, reset: ICON_REVERT,
  globe: ICON_GLOBE, sliders: ICON_SLIDERS_HORIZONTAL, list: ICON_LIST, history: ICON_CLOCK, open: ICON_ARROW_OUT,
  grip: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="7" cy="5" r="1"/><circle cx="13" cy="5" r="1"/><circle cx="7" cy="10" r="1"/><circle cx="13" cy="10" r="1"/><circle cx="7" cy="15" r="1"/><circle cx="13" cy="15" r="1"/></svg>',
};
const icons = Object.fromEntries(Object.entries(artwork).map(([name, svg]) => [name,
  svg.replace(/<svg\b[^>]*>/, tag => tag.replace(/\s(?:width|height|aria-hidden|focusable)="[^"]*"/g, '').replace('<svg ', '<svg width="18" height="18" aria-hidden="true" focusable="false" ')),
]));
export const icon = (name: string): string => icons[name] ?? icons.policy;
