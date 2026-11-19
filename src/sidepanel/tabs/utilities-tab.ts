/**
 * Utilities tab: the windows and pages the panel launches besides the four
 * header actions. A calm list of launch rows in two groups by where they
 * open. No server calls and no reads: it draws from settings the panel
 * already holds, and a click sends the same message the header buttons did.
 */

import type { InspectorMessage } from '../../lib/types';
import { el, attrs, icon } from '../../lib/dom';
import { S } from '../state';
import type { Tab, SendFn } from './tab-types';
import { UTILITY_GROUPS, utilityById, utilityView, type UtilityContext, type UtilityEntry } from '../utilities';

/** Messages after which the rows' reasons may have changed. */
const SERVER_CHANGES = new Set<InspectorMessage['type']>(['SETTINGS_DATA', 'PROFILE_SWITCHED']);

export function utilityContext(): UtilityContext {
  const profile = S.settings.profiles.find(p => p.id === S.settings.activeProfileId);
  return { serverLabel: profile ? (profile.label || profile.bmpUrl) : null };
}

export class UtilitiesTab implements Tab {
  constructor(private readonly send: SendFn) {}

  handleMessage(msg: InspectorMessage): boolean {
    return SERVER_CHANGES.has(msg.type);
  }

  activate(): void { /* nothing to read: the list is static */ }
  deactivate(): void { /* nothing to stop */ }

  render(container: HTMLElement): void {
    const ctx = utilityContext();
    const root = el('div', 'ut ui');
    for (const group of UTILITY_GROUPS) {
      const rows = group.ids.map(id => this.row(utilityById(id), ctx));
      const heading = el('h2', 'ut-gh', group.label);
      heading.id = `ut-g-${group.id}`;
      const list = attrs(el('div', 'ut-list', ...rows), { role: 'group', 'aria-labelledby': heading.id });
      root.append(el('section', 'ut-grp', heading, list));
    }
    container.replaceChildren(root);
  }

  private row(entry: UtilityEntry, ctx: UtilityContext): HTMLElement {
    const view = utilityView(entry, ctx);
    const row = el('button', 'ut-row',
      el('span', 'ut-ic', icon(entry.icon)),
      el('span', 'ut-tx',
        el('span', 'ut-nm', entry.name),
        el('span', view.disabled ? 'ut-ln ut-why' : 'ut-ln', view.line)),
      entry.tag ? el('span', 'ut-tag', entry.tag) : null,
    ) as HTMLButtonElement;
    row.type = 'button';
    row.id = `open-${entry.id}`;
    row.title = view.title;
    if (view.disabled) row.setAttribute('aria-disabled', 'true');
    row.addEventListener('click', () => {
      if (row.getAttribute('aria-disabled') === 'true') return;
      this.send(entry.message);
    });
    return row;
  }
}
