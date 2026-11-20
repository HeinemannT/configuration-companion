/**
 * The Utilities tab's entries: what each one is, what it sends when opened,
 * and when it cannot be opened yet. The tab (tabs/utilities-tab.ts) only
 * draws these. The messages are the ones the header buttons sent before the
 * tab existed.
 */

import type { InspectorMessage } from '../lib/types';

export type UtilityId = 'code-search' | 'transport' | 'numeric-ids' | 'access' | 'colors' | 'images' | 'claude-desktop';

export interface UtilityEntry {
  id: UtilityId;
  name: string;
  /** One line: what it is for. */
  line: string;
  /** A sprite id (shell sprite, or the shared one). */
  icon: string;
  message: InspectorMessage;
  /** Small word after the name. */
  tag?: string;
  /** The tooltip's first line, when the name alone is not enough. */
  titleName?: string;
  /** Opens on the server this panel shows, so it needs one. */
  needsServer: boolean;
}

export interface UtilityGroup {
  id: 'page' | 'tab';
  label: string;
  /** Where its entries open. */
  opens: string;
  ids: readonly UtilityId[];
}

export const UTILITIES: readonly UtilityEntry[] = [
  { id: 'code-search', name: 'Code Search', line: 'Search the Extended Code of this server', icon: 's-codesearch', message: { type: 'OPEN_CODE_SEARCH' }, needsServer: false },
  { id: 'transport', name: 'Transport', line: 'Move objects between servers', icon: 's-transport', message: { type: 'OPEN_TRANSPORT' }, tag: 'Beta', titleName: 'Transport (beta)', needsServer: false },
  { id: 'numeric-ids', name: 'Numeric IDs', line: 'Change numbers used as IDs', icon: 's-numids', message: { type: 'OPEN_TRANSPORT', tab: 'numeric' }, tag: 'Beta', titleName: 'Numeric IDs (a tab of Transport, beta)', needsServer: false },
  { id: 'access', name: 'Access', line: 'Roles, policies and access tests', icon: 'i-shield', message: { type: 'OPEN_ACCESS_WORKSPACE' }, needsServer: true },
  { id: 'colors', name: 'Colors', line: 'Add and change colors', icon: 's-palette', message: { type: 'OPEN_COLORS_IMAGES', tab: 'colors' }, needsServer: true },
  { id: 'images', name: 'Images', line: 'Add and change image files', icon: 'i-image', message: { type: 'OPEN_COLORS_IMAGES', tab: 'images' }, needsServer: true },
  { id: 'claude-desktop', name: 'Claude Desktop', line: 'Send sketches from Point and tell', icon: 's-pointtell', message: { type: 'OPEN_CLAUDE_SETUP' }, needsServer: false },
];

export const UTILITY_GROUPS: readonly UtilityGroup[] = [
  { id: 'page', label: 'Over the BMP page', opens: 'Opens over the BMP page', ids: ['code-search', 'transport', 'numeric-ids'] },
  { id: 'tab', label: 'In a browser tab', opens: 'Opens in a browser tab', ids: ['access', 'colors', 'images', 'claude-desktop'] },
];

export const CHOOSE_SERVER_FIRST = 'Choose a server first';

export interface UtilityContext {
  /** The label of the server this panel shows; null when none is chosen. */
  serverLabel: string | null;
}

export interface UtilityView {
  /** Cannot be opened now (aria-disabled; the click does nothing). */
  disabled: boolean;
  /** The second line: the entry's own, or the reason it cannot open. */
  line: string;
  /** The tooltip. */
  title: string;
}

export function utilityById(id: UtilityId): UtilityEntry {
  const entry = UTILITIES.find(u => u.id === id);
  if (!entry) throw new Error(`Unknown utility ${id}`);
  return entry;
}

export function groupOf(id: UtilityId): UtilityGroup {
  return UTILITY_GROUPS.find(g => g.ids.includes(id))!;
}

export function utilityView(entry: UtilityEntry, ctx: UtilityContext): UtilityView {
  const group = groupOf(entry.id);
  const disabled = entry.needsServer && !ctx.serverLabel;
  const title = [
    entry.titleName ?? entry.name,
    ...(entry.needsServer ? [ctx.serverLabel ?? CHOOSE_SERVER_FIRST] : []),
    group.opens,
  ].join('\n');
  return { disabled, line: disabled ? CHOOSE_SERVER_FIRST : entry.line, title };
}
