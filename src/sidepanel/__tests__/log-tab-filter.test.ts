/**
 * @vitest-environment happy-dom
 *
 * Log tab: server scope (this server by default when several are set up),
 * Activity / Problems / All filters, day bands, the expanded detail, the
 * "Latest N of M" footer, the empty states, and the copy / save menu.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LogTab } from '../tabs/log-tab';
import { S } from '../state';
import type { InspectorMessage, ActivityEntry } from '../../lib/types';
import { DEFAULT_SETTINGS } from '../../lib/types';
import { closeMenu } from '../menu';
import { clockTime } from '../tabs/log-model';

function pushEntries(tab: LogTab, entries: ActivityEntry[]) {
  const msg: InspectorMessage = { type: 'ACTIVITY_LOG', entries };
  tab.handleMessage(msg);
}

const NOW = Date.now();

function entries(): ActivityEntry[] {
  return [
    { id: 1, time: NOW - 5000, level: 'info', category: 'change', message: 'sbx-1', profileId: 'sbx' },
    { id: 2, time: NOW - 4000, level: 'info', category: 'change', message: 'dev-1', profileId: 'dev' },
    { id: 3, time: NOW - 3000, level: 'info', category: 'change', message: 'prod-1', profileId: 'prod' },
    { id: 4, time: NOW - 2000, level: 'info', category: 'change', message: 'legacy-no-tag' }, // no profileId
    { id: 5, time: NOW - 1000, level: 'info', category: 'change', message: 'sbx-2', profileId: 'sbx' },
  ];
}

function configureProfiles(active: string, ids: string[] = ['sbx', 'dev', 'prod']) {
  S.settings = {
    ...DEFAULT_SETTINGS,
    profiles: ids.map(id => ({
      id, label: id.toUpperCase(), bmpUrl: `https://${id}.x.de/`, bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal',
    })),
    activeProfileId: active,
  };
}

function shown(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.lg-row')).map(el => el.title);
}

function pickMenu(label: string) {
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menu"] button'))
    .find(b => b.textContent?.includes(label));
  expect(item, label).toBeTruthy();
  item!.click();
}

function mount(tab: LogTab): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  tab.render(container);
  return container;
}

beforeEach(() => {
  closeMenu();
  document.body.innerHTML = '';
});

describe('LogTab — server scope', () => {
  it('defaults to this server when several servers exist', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = mount(tab);

    expect(shown(container)).toEqual(['sbx-2', 'legacy-no-tag', 'sbx-1']); // newest first; untagged stays visible
    expect(container.querySelector('.lg-scope')?.textContent).toBe('This server');
  });

  it('All servers reveals every entry, This server filters back', () => {
    configureProfiles('dev');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = mount(tab);

    (container.querySelector('.lg-scope') as HTMLElement).click();
    expect(document.querySelector('[role="menu"] [aria-checked="true"]')?.textContent).toContain('This server');
    pickMenu('All servers');
    expect(shown(container)).toEqual(['sbx-2', 'legacy-no-tag', 'prod-1', 'dev-1', 'sbx-1']);
    expect(container.querySelector('.lg-scope')?.textContent).toBe('All servers');

    (container.querySelector('.lg-scope') as HTMLElement).click();
    pickMenu('This server');
    expect(shown(container)).toEqual(['legacy-no-tag', 'dev-1']);
  });

  it('has no scope control with one server', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = mount(tab);
    expect(container.querySelector('.lg-scope')).toBeNull();
    expect(shown(container)).toHaveLength(5);
  });

  it('follows a change of the active server on re-render', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = mount(tab);
    expect(shown(container)).toContain('sbx-1');
    S.settings = { ...S.settings, activeProfileId: 'dev' };
    tab.render(container);
    expect(shown(container)).toContain('dev-1');
    expect(shown(container)).not.toContain('sbx-1');
  });
});

describe('LogTab — filters and rows', () => {
  it('defaults to user activity while All keeps diagnostics', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [
      { id: 1, time: NOW - 3000, level: 'info', category: 'system', message: 'Detection: BMP page' },
      { id: 2, time: NOW - 2000, level: 'success', category: 'execution', message: 'Executed EC', durationMs: 412 },
      { id: 3, time: NOW - 1000, level: 'error', category: 'system', message: 'Connection failed' },
    ]);
    const container = mount(tab);
    expect(shown(container)).toEqual(['Connection check failed', 'Executed EC']); // older wording is shown in the current form
    (container.querySelector('[data-event-filter="all"]') as HTMLElement).click();
    expect(shown(container)).toContain('Detection: BMP page');
  });

  it('Problems shows warnings and errors and carries their count', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [
      { id: 1, time: NOW - 3000, level: 'success', category: 'change', message: 'Saved expression' },
      { id: 2, time: NOW - 2000, level: 'warn', category: 'blueprint', message: 'Apply unverified' },
      { id: 3, time: NOW - 1000, level: 'error', category: 'execution', message: 'EC failed' },
    ]);
    const container = mount(tab);
    const problems = container.querySelector('[data-event-filter="problems"]') as HTMLElement;
    expect(problems.querySelector('.lg-cnt')?.textContent).toBe('2');
    problems.click();
    expect(shown(container)).toEqual(['EC failed', 'Apply unverified']);
    expect(container.querySelector('[data-event-filter="problems"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows clock time, result and duration in their own columns, under a day band', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    const t = new Date(NOW);
    t.setHours(14, 32, 7, 0);
    pushEntries(tab, [ // the worker keeps entries oldest first
      { id: 2, time: t.getTime() - 86_400_000, level: 'error', category: 'execution', message: 'Execute failed', durationMs: 1200 },
      { id: 1, time: t.getTime(), level: 'success', category: 'change', message: 'Saved Rating', durationMs: 186 },
    ]);
    const container = mount(tab);
    const bands = Array.from(container.querySelectorAll('.lg-day .t')).map(b => b.textContent);
    expect(bands).toEqual(['Today', 'Yesterday']);
    const row = container.querySelector('.lg-row')!;
    expect(row.querySelector('.lg-t')?.textContent).toBe('14:32:07');
    expect(row.querySelector('.lg-r')?.getAttribute('title')).toBe('Succeeded');
    expect(row.querySelector('.lg-d')?.textContent).toBe('186 ms');
    expect(container.querySelectorAll('.lg-row')[1].querySelector('.lg-d')?.textContent).toBe('1.2 s');
  });

  it('opens a new warning detail so the BMP execution log is visible at once', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    tab.handleMessage({
      type: 'ACTIVITY_ENTRY',
      entry: {
        id: 6, time: NOW, level: 'warn', category: 'blueprint', message: 'Blueprint apply unverified',
        detail: 'BMP execution log\nWould addTabSet: 1', profileId: 'sbx',
        commandActor: 'admin', commandAuthSource: 'stored-login',
      },
    });
    const container = mount(tab);
    const row = container.querySelector('.lg-row') as HTMLElement;
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.lg-pre')?.textContent).toContain('Would addTabSet: 1');
    expect(container.querySelector('.lg-meta')?.textContent).toBe('Blueprint · as admin (stored login)'); // one server: no server name, level is the icon
    // Enter closes it again and keeps focus on the row.
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const again = container.querySelector('.lg-row') as HTMLElement;
    expect(again.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.lg-detail')).toBeNull();
    expect(document.activeElement).toBe(again);
  });

  it('says "Latest N of M" when more entries match than are shown', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, Array.from({ length: 64 }, (_, i) => ({
      id: i + 1, time: NOW - (64 - i) * 1000, level: 'success' as const, category: 'change' as const, message: `Saved ${i}`,
    })));
    const container = mount(tab);
    expect(container.querySelectorAll('.lg-row')).toHaveLength(50);
    expect(container.querySelector('.lg-more')?.textContent).toBe('Latest 50 of 64 entries');
  });

  it('empty Activity offers all events when other events exist', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [{ id: 1, time: NOW, level: 'info', category: 'system', message: 'Detection: BMP page (95%)' }]);
    const container = mount(tab);
    expect(container.querySelector('.lg-empty b')?.textContent).toBe('Nothing in Activity yet');
    expect(container.querySelector('.lg-empty p')?.textContent).toContain('1 background event hidden.');
    (container.querySelector('.lg-empty [data-event-filter="all"]') as HTMLElement).click();
    expect(shown(container)).toEqual(['Found a BMP page']);
  });

  it('empty Problems says so', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, []);
    const container = mount(tab);
    (container.querySelector('[data-event-filter="problems"]') as HTMLElement).click();
    expect(container.querySelector('.lg-empty b')?.textContent).toBe('No problems');
    expect(container.querySelector('.lg-empty [data-event-filter]')).toBeNull();
  });
});

describe('LogTab — copy and save', () => {
  it('copies the filtered entries as text or JSON and saves them as a .json file', async () => {
    configureProfiles('sbx', ['sbx']);
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [
      { id: 1, time: NOW - 2000, level: 'success', category: 'change', message: 'Saved expression', durationMs: 90 },
      { id: 2, time: NOW - 1000, level: 'info', category: 'system', message: 'Detection: BMP page' },
    ]);
    const container = mount(tab);

    (container.querySelector('.lg-export') as HTMLElement).click();
    expect(Array.from(document.querySelectorAll('[role="menu"] button')).map(b => b.textContent))
      .toEqual(['Copy as text', 'Copy as JSON', 'Save as .json']);
    pickMenu('Copy as text');
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Succeeded  Saved expression  (90 ms)'));
    expect(writeText.mock.calls.at(-1)![0]).not.toContain('Detection'); // Activity filter applies

    (container.querySelector('.lg-export') as HTMLElement).click();
    pickMenu('Copy as JSON');
    await Promise.resolve();
    expect(JSON.parse(writeText.mock.calls.at(-1)![0])).toEqual([
      { id: 1, time: NOW - 2000, level: 'success', category: 'change', message: 'Saved expression', durationMs: 90 },
    ]);

    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:log'; });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    let downloaded = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    (container.querySelector('.lg-export') as HTMLElement).click();
    pickMenu('Save as .json');
    expect(downloaded).toMatch(/^companion-log-\d{8}-\d{4}\.json$/);
    expect(JSON.parse(await created[0].text())).toHaveLength(1);
    click.mockRestore();
  });
});

describe('LogTab — focus, counts and merged repeats', () => {
  it('keeps keyboard focus on the chosen filter and on a focused row through a live entry', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [{ id: 1, time: NOW - 1000, level: 'success', category: 'change', message: 'Saved A' }]);
    const container = mount(tab);
    const problems = container.querySelector<HTMLElement>('[data-event-filter="problems"]')!;
    problems.focus();
    problems.click();
    expect(document.activeElement?.getAttribute('data-fk')).toBe('filter:problems');

    (container.querySelector('[data-event-filter="activity"]') as HTMLElement).click();
    container.querySelector<HTMLElement>('.lg-row')!.focus();
    tab.handleMessage({ type: 'ACTIVITY_ENTRY', entry: { id: 2, time: NOW, level: 'success', category: 'change', message: 'Saved B' } });
    tab.render(container);
    expect(document.activeElement?.getAttribute('data-fk')).toBe('row:1');
  });

  it('disables export on an empty list and colours the Problems count only for errors', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [{ id: 1, time: NOW, level: 'warn', category: 'blueprint', message: 'Apply unverified' }]);
    const container = mount(tab);
    expect(container.querySelector('.lg-cnt')?.classList.contains('err')).toBe(false);
    (container.querySelector('[data-event-filter="all"]') as HTMLElement).click();
    expect((container.querySelector('.lg-export') as HTMLButtonElement).disabled).toBe(false);

    pushEntries(tab, [{ id: 2, time: NOW, level: 'error', category: 'execution', message: 'EC failed' }]);
    tab.render(container);
    expect(container.querySelector('.lg-cnt')?.classList.contains('err')).toBe(true);

    pushEntries(tab, []);
    tab.render(container);
    expect((container.querySelector('.lg-export') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a merged repeat replaces its earlier copy and shows its count', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    const base = { id: 7, level: 'info' as const, category: 'system' as const, message: 'Found a BMP page' };
    pushEntries(tab, [{ ...base, time: NOW - 5000 }]);
    tab.handleMessage({ type: 'ACTIVITY_ENTRY', entry: { ...base, time: NOW, count: 3 } });
    const container = mount(tab);
    (container.querySelector('[data-event-filter="all"]') as HTMLElement).click();
    expect(container.querySelectorAll('.lg-row')).toHaveLength(1);
    expect(container.querySelector('.lg-rep')?.textContent).toBe('×3 (3 times)');
    // no row has a duration: no duration column
    expect(container.querySelector('.lg-list')?.classList.contains('nodur')).toBe(true);
  });

  it('shows an old "completed under load" read as a diagnostic with its run time', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [{ id: 1, time: NOW, level: 'warn', message: 'BMP 9×IntegrationGetObjectCommand completed under load', detail: 'run 512ms · queue 0ms (depth 0) · 1 attempt · 2206B request · 4324730B response' }]);
    const container = mount(tab);
    expect(container.querySelector('[data-event-filter="problems"] .lg-cnt')).toBeNull();
    (container.querySelector('[data-event-filter="all"]') as HTMLElement).click();
    expect(shown(container)).toEqual(['Read 9 objects']);
    expect(container.querySelector('.lg-d')?.textContent).toBe('512 ms');
  });
});

describe('Log tab: reveal an entry (Show in Log)', () => {
  it('opens and highlights the entry, even when the filter hides it', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [
      ...entries(),
      { id: 6, time: NOW, level: 'error', category: 'system', message: 'Save failed', profileId: 'dev' },
    ]);
    const container = mount(tab);
    expect(shown(container)).not.toContain('Save failed');

    tab.reveal(6);
    tab.render(container);

    const item = container.querySelector('.lg-item.revealed');
    expect(item?.querySelector('.lg-row')?.getAttribute('data-key')).toBe('6');
    expect(item?.classList.contains('open')).toBe(true);
  });

  it('waits for an entry that has not arrived yet', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    const container = mount(tab);
    tab.reveal(8);
    tab.render(container);
    expect(container.querySelector('.lg-item.revealed')).toBeNull();

    pushEntries(tab, [{ id: 8, time: NOW, level: 'error', category: 'system', message: 'Late', profileId: 'sbx' }]);
    tab.render(container);
    expect(container.querySelector('.lg-item.revealed .lg-row')?.getAttribute('data-key')).toBe('8');
  });

  it('removes the highlight after a few seconds', () => {
    vi.useFakeTimers();
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, [{ id: 8, time: NOW, level: 'error', category: 'system', message: 'Boom', profileId: 'sbx' }]);
    const container = mount(tab);
    tab.reveal(8);
    tab.render(container);
    expect(container.querySelector('.lg-item.revealed')).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(container.querySelector('.lg-item.revealed')).toBeNull();
    vi.useRealTimers();
  });
});

describe('LogTab — the script pause entry', () => {
  it('offers "Server was restarted"; after one confirm it resets that entry\'s server only', async () => {
    configureProfiles('dev');
    const send = vi.fn();
    const tab = new LogTab(send);
    pushEntries(tab, [
      { id: 7, time: NOW - 1000, level: 'warn', category: 'system', action: 'script-pause', message: 'Companion holds about 935 of the 2,000 parsed scripts this server keeps.', profileId: 'dev' },
      { id: 8, time: NOW - 500, level: 'warn', category: 'system', message: 'Lost the connection to the server', profileId: 'dev' },
    ]);
    const container = mount(tab);
    (container.querySelector('[data-event-filter="all"]') as HTMLElement).click();
    for (const id of [7, 8]) (container.querySelector(`.lg-row[data-key="${id}"]`) as HTMLElement).click();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-act="reset-scripts"]')];
    expect(buttons.map(b => [b.dataset.key, b.textContent])).toEqual([['7', 'Server was restarted']]);
    buttons[0].click();
    await Promise.resolve();
    expect(document.body.textContent).toContain('Reset the count for DEV? Use this only if the server was restarted.');
    expect(send).not.toHaveBeenCalled();
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Reset count')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledWith({ type: 'RESET_SCRIPT_COUNT', profileId: 'dev' });
  });

  it('a resume line of the same server ends the pause: uncounted in Problems, "ended <time>", no reset button', () => {
    configureProfiles('dev', ['dev', 'sbx']);
    const tab = new LogTab(vi.fn());
    const pause = (id: number, time: number, profileId: string): ActivityEntry =>
      ({ id, time, level: 'warn', category: 'system', action: 'script-pause', message: `Background work paused (${id}).`, profileId });
    pushEntries(tab, [
      pause(1, NOW - 9000, 'dev'),
      pause(2, NOW - 8000, 'dev'),
      pause(3, NOW - 7000, 'sbx'),
      { id: 4, time: NOW - 6000, level: 'warn', category: 'system', message: 'Lost the connection to the server', profileId: 'dev' },
    ]);
    const container = mount(tab);
    (container.querySelector('[data-event-filter="problems"]') as HTMLElement).click();
    expect(container.querySelector('[data-event-filter="problems"] .lg-cnt')?.textContent).toBe('3');

    const end = NOW - 5000;
    tab.handleMessage({ type: 'ACTIVITY_ENTRY', entry: { id: 5, time: end, level: 'info', category: 'system', action: 'script-resume', message: 'Background work resumed: you reset the count after a server restart; Companion now holds about 0 parsed scripts (under 1 MB) in this server\'s memory.', profileId: 'dev' } });
    tab.render(container);
    // Only the open warning of this server is counted; the ended pauses stay listed, marked.
    expect(container.querySelector('[data-event-filter="problems"] .lg-cnt')?.textContent).toBe('1');
    const ended = [...container.querySelectorAll<HTMLElement>('.lg-item.ended')];
    expect(ended.map(i => i.querySelector('.lg-end')?.textContent)).toEqual(Array(2).fill(`ended ${clockTime(end)}`));
    for (const id of [1, 2]) (container.querySelector(`.lg-row[data-key="${id}"]`) as HTMLElement).click();
    expect(container.querySelectorAll('[data-act="reset-scripts"]')).toHaveLength(0);

    // The other server's pause is still open.
    (container.querySelector('[data-act="scope"]') as HTMLElement).click();
    pickMenu('All servers');
    (container.querySelector('.lg-row[data-key="3"]') as HTMLElement).click();
    expect(container.querySelectorAll('[data-act="reset-scripts"]')).toHaveLength(1);
    expect(container.querySelector('.lg-item.ended .lg-row[data-key="3"]')).toBeNull();
  });
});
