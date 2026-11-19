/**
 * @vitest-environment happy-dom
 *
 * The Utilities tab: what it lists, the message each row sends (the ones the
 * header buttons sent before), and when a row cannot open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type InspectorMessage, type ServerProfile } from '../../lib/types';
import { S } from '../state';
import { UtilitiesTab } from '../tabs/utilities-tab';
import { CHOOSE_SERVER_FIRST, UTILITIES, UTILITY_GROUPS, groupOf, utilityById, utilityView } from '../utilities';
import { ICON_SPRITE } from '../../lib/icon-sprite';

const repoRoot = join(__dirname, '../../..');
const shellSprite = readFileSync(join(repoRoot, 'src/sidepanel/icons.ts'), 'utf8');

const profile = (change: Partial<ServerProfile> = {}): ServerProfile => ({
  id: 'p1', label: 'Steadfast', bmpUrl: 'https://bmp.example.test/Steadfast/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal', ...change,
});

function mount() {
  const send = vi.fn<(msg: InspectorMessage) => void>();
  const tab = new UtilitiesTab(send);
  const container = document.createElement('div');
  tab.render(container);
  return { tab, send, container, row: (id: string) => container.querySelector<HTMLButtonElement>(`#open-${id}`)! };
}

beforeEach(() => {
  S.settings = { ...DEFAULT_SETTINGS, profiles: [profile()], activeProfileId: 'p1' };
});

describe('Utilities entries', () => {
  it('are the six, in two groups by where they open', () => {
    expect(UTILITIES.map(u => u.name)).toEqual(['Code Search', 'Transport', 'Numeric IDs', 'Access', 'Colors', 'Images']);
    expect(UTILITY_GROUPS.map(g => [g.label, g.ids])).toEqual([
      ['Over the BMP page', ['code-search', 'transport', 'numeric-ids']],
      ['In a browser tab', ['access', 'colors', 'images']],
    ]);
    // Every entry is in exactly one group.
    expect(UTILITY_GROUPS.flatMap(g => g.ids).sort()).toEqual(UTILITIES.map(u => u.id).sort());
    expect(groupOf('images').id).toBe('tab');
  });

  it('send what the header buttons sent, Colors and Images naming their tab', () => {
    expect(UTILITIES.map(u => [u.id, u.message])).toEqual([
      ['code-search', { type: 'OPEN_CODE_SEARCH' }],
      ['transport', { type: 'OPEN_TRANSPORT' }],
      ['numeric-ids', { type: 'OPEN_TRANSPORT', tab: 'numeric' }],
      ['access', { type: 'OPEN_ACCESS_WORKSPACE' }],
      ['colors', { type: 'OPEN_COLORS_IMAGES', tab: 'colors' }],
      ['images', { type: 'OPEN_COLORS_IMAGES', tab: 'images' }],
    ]);
  });

  it('each have a drawn icon, an own one, a name and one short line', () => {
    const icons = UTILITIES.map(u => u.icon);
    expect(new Set(icons).size).toBe(icons.length);
    for (const u of UTILITIES) {
      expect(ICON_SPRITE + shellSprite, u.id).toContain(`id="${u.icon}"`);
      expect(u.line.length, u.id).toBeLessThanOrEqual(42);
      expect(u.line, u.id).not.toMatch(/[.!]$/);
    }
  });

  it('say Transport and its second way in, Numeric IDs, are beta', () => {
    expect(utilityById('transport').tag).toBe('Beta');
    expect(utilityById('numeric-ids').tag).toBe('Beta');
    expect(utilityView(utilityById('transport'), { serverLabel: null }).title).toMatch(/^Transport \(beta\)/);
  });
});

describe('Utilities tab', () => {
  it('draws a row per entry, a group heading over each, and no request', () => {
    const { container, send } = mount();
    expect([...container.querySelectorAll('.ut-gh')].map(h => h.textContent)).toEqual(['Over the BMP page', 'In a browser tab']);
    expect([...container.querySelectorAll('.ut-row')].map(r => r.querySelector('.ut-nm')!.textContent)).toEqual(
      ['Code Search', 'Transport', 'Numeric IDs', 'Access', 'Colors', 'Images'],
    );
    for (const row of container.querySelectorAll('.ut-row')) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.querySelector('.ut-ic svg use')).not.toBeNull();
      expect(row.querySelector('.ut-ln')!.textContent).not.toBe('');
    }
    // Opening the tab reads nothing and sends nothing.
    expect(send).not.toHaveBeenCalled();
    const tab = new UtilitiesTab(send);
    tab.activate();
    tab.deactivate();
    expect(send).not.toHaveBeenCalled();
  });

  it('opens an entry with its message when the row is clicked', () => {
    const { send, row } = mount();
    for (const u of UTILITIES) row(u.id).click();
    expect(send.mock.calls.map(c => c[0])).toEqual(UTILITIES.map(u => u.message));
  });

  it('Transport and Numeric IDs open the same window; Colors and Images the same page on their tab', () => {
    const { send, row } = mount();
    row('transport').click();
    row('numeric-ids').click();
    row('colors').click();
    row('images').click();
    expect(send.mock.calls.map(c => c[0])).toEqual([
      { type: 'OPEN_TRANSPORT' }, { type: 'OPEN_TRANSPORT', tab: 'numeric' },
      { type: 'OPEN_COLORS_IMAGES', tab: 'colors' }, { type: 'OPEN_COLORS_IMAGES', tab: 'images' },
    ]);
  });

  it('shows Beta on Transport and Numeric IDs only', () => {
    const { container } = mount();
    const tagged = [...container.querySelectorAll('.ut-row')].filter(r => r.querySelector('.ut-tag')).map(r => r.querySelector('.ut-nm')!.textContent);
    expect(tagged).toEqual(['Transport', 'Numeric IDs']);
  });

  it('without a server: Access, Colors and Images cannot open and say why; the page windows can', () => {
    S.settings = { ...DEFAULT_SETTINGS, profiles: [], activeProfileId: '' };
    const { send, row } = mount();
    for (const id of ['access', 'colors', 'images']) {
      expect(row(id).getAttribute('aria-disabled'), id).toBe('true');
      expect(row(id).querySelector('.ut-ln')!.textContent, id).toBe(CHOOSE_SERVER_FIRST);
      row(id).click();
    }
    expect(send).not.toHaveBeenCalled();
    for (const id of ['code-search', 'transport', 'numeric-ids']) {
      expect(row(id).hasAttribute('aria-disabled'), id).toBe(false);
      row(id).click();
    }
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('names the server and where it opens in the tooltip of a browser-tab entry, as the header button did', () => {
    const { row } = mount();
    expect(row('access').title).toBe('Access\nSteadfast\nOpens in a browser tab');
    expect(row('colors').title).toBe('Colors\nSteadfast\nOpens in a browser tab');
    expect(row('code-search').title).toBe('Code Search\nOpens over the BMP page');
  });

  it('draws again for a settings change or a server switch, and for nothing else', () => {
    const { tab } = mount();
    expect(tab.handleMessage({ type: 'SETTINGS_DATA', settings: S.settings })).toBe(true);
    expect(tab.handleMessage({ type: 'PROFILE_SWITCHED', profileId: 'p2' } as InspectorMessage)).toBe(true);
    expect(tab.handleMessage({ type: 'CACHE_STATS', count: 3 })).toBe(false);
    expect(tab.handleMessage({ type: 'INSPECT_STATE', active: true })).toBe(false);
  });

  it('uses the label, else the address, of the server in the tooltip', () => {
    S.settings = { ...DEFAULT_SETTINGS, profiles: [profile({ label: '' })], activeProfileId: 'p1' };
    const { row } = mount();
    expect(row('access').title).toContain('https://bmp.example.test/Steadfast/');
  });
});
