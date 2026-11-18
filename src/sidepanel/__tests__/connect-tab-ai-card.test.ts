/**
 * Tests for the Connect tab's AI Assistant row (server-row twin). No READY/UNTESTED pills — status is
 * carried by one health dot and latency (present only when verified):
 *   - unconfigured → grey dot with a Set up button
 *   - configured + untested → grey dot, no latency, Edit
 *   - configured + last test ok → green dot + latency
 *   - Edit / Set up expands the configuration form; AI_TEST_RESULT persists
 *     the lastTest into shared settings for the collapsed card.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InspectorMessage, InspectorSettings, ServerProfile } from '../../lib/types';
import { DEFAULT_SETTINGS } from '../../lib/types';

vi.mock('../state', () => ({
  S: {
    activeTab: 'connect',
    settings: { schemaVersion: 3, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'template', enrichMode: 'widgets' },
    connState: {
      display: 'connected',
      identities: {
        portal: { status: 'connected', user: 'portal.user', source: 'portal-session' },
        command: { status: 'connected', user: 'config.user', source: 'stored-login' },
        sameUser: false,
      },
      version: null, responseMs: null, profileLabel: null, workspace: null,
      authError: null, networkOffline: false, lastUpdate: 0,
    },
    cacheCount: 0,
    context: null,
    lastEcMs: null,
  },
  getTabPanel: () => document.querySelector('[data-test-connect-panel]'),
  sendMessage: vi.fn(),
}));

// The update banner asks GitHub for the latest release; here no update is known.
vi.mock('../../lib/version-check', () => ({
  getUpdateStatus: vi.fn(async () => ({
    current: '0.0.0-test', latest: null, releasesUrl: 'https://example.test/releases', isUpdate: false, checkedAt: 0,
  })),
}));

import { ConnectTab, settingsWithoutProfile, firstRunCandidate } from '../tabs/connect-tab';
import { S as shared } from '../state';

// Minimal chrome surface the render path touches (update banner version).
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
};

function freshSettings(ai?: InspectorSettings['ai']): InspectorSettings {
  return { ...DEFAULT_SETTINGS, profiles: [], activeProfileId: '', ...(ai ? { ai } : {}) };
}

function renderTab(): { tab: ConnectTab; el: HTMLElement; sent: InspectorMessage[] } {
  const sent: InspectorMessage[] = [];
  const tab = new ConnectTab((m) => sent.push(m));
  // handleMessage(SETTINGS_DATA) is how aiConfigured normally syncs; mimic it.
  tab.handleMessage({ type: 'SETTINGS_DATA', settings: shared.settings });
  const el = document.createElement('div');
  el.dataset.testConnectPanel = '';
  document.body.appendChild(el);
  tab.render(el);
  return { tab, el, sent };
}

function expandAi(el: HTMLElement): void {
  (el.querySelector('[data-action="ai-expand"]') as HTMLButtonElement).click();
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('AI Assistant card states', () => {
  it('unconfigured: quiet row, Set up button, no pill, no keyline', () => {
    shared.settings = freshSettings();
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill')).toBeNull();
    expect(card.textContent).not.toContain('AI Assistant'); // the band already names it
    expect(card.textContent).toContain('Set up');
    expect(card.querySelector('[data-action="ai-expand"]')?.classList.contains('ui-btn')).toBe(true);
    expect(card.textContent).toContain('Bring your own API key');
    // Collapsed by default — no form.
    expect(el.querySelector('.ai-form')).toBeNull();
    expect(card.querySelector('.ai-card-health.idle')).toBeTruthy();
  });

  it('configured but untested: plain card (no keyline, no dot/latency), mono line, Edit', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill')).toBeNull(); // no pill — absence of the keyline/dot carries "untested"
    expect(card.querySelector('.ai-card-ln2')?.textContent).toBe('DeepSeek · deepseek-chat · key saved');
    expect(card.querySelector('.ai-card-edit')?.getAttribute('aria-label')).toBe('Edit AI settings');
    expect(card.querySelector('.ai-card-edit svg')).toBeTruthy();
    expect(card.querySelector('.ai-card-latency')).toBeNull();
    expect(card.querySelector('.ai-card-health.idle')).toBeTruthy();
  });

  it('configured + verified: green keyline, dot + latency, no pill', () => {
    shared.settings = freshSettings({
      provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnc: 'set',
      lastTest: { ok: true, ms: 412, at: Date.now() },
    });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(true);
    expect(card.querySelector('.ai-pill')).toBeNull();
    expect(card.querySelector('.ai-card-health.ready')).toBeTruthy();
    expect(card.querySelector('.ai-card-latency')?.textContent).toBe('412 ms');
  });

  it('a failed last test renders a plain card (no green keyline)', () => {
    shared.settings = freshSettings({
      provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'set',
      lastTest: { ok: false, ms: 900, at: Date.now() },
    });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill')).toBeNull();
    expect(card.querySelector('.ai-card-health.error')).toBeTruthy();
  });

  it('the Edit action expands the existing config form (provider/model/key)', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { el } = renderTab();
    expandAi(el);
    const form = el.querySelector('.ai-form')!;
    expect(form).toBeTruthy();
    expect(form.querySelector('#ai-provider')).toBeTruthy();
    expect(form.querySelector('#ai-model')).toBeTruthy();
    expect(form.textContent).toContain('saved'); // masked key row
    // Card button flips to Close.
    expect(el.querySelector('.ai-card-edit')?.getAttribute('aria-label')).toBe('Close AI settings');
  });

  it('renders a saved custom provider in the picker and redacts its key JSON', () => {
    shared.settings = freshSettings({
      provider: 'custom', model: 'agent', apiKeyEnc: 'set',
      customProvider: {
        name: 'Company Gateway', vendor: 'company', apiType: 'openai',
        models: [{ id: 'agent', name: 'Agent', url: 'https://ai.example.test/v1', toolCalling: true }],
      },
    });
    const { el } = renderTab();
    expandAi(el);
    expect(el.querySelector('.ai-card-ln2')?.textContent).toContain('Company Gateway');
    expect((el.querySelector('#ai-provider') as HTMLSelectElement).value).toBe('custom');
    const json = (el.querySelector('#ai-provider-json') as HTMLTextAreaElement).value;
    expect(json).toContain('"Company Gateway"');
    expect(json).toContain('"apiKey": ""');
    expect(json).not.toContain('set');
    const helpButton = el.querySelector('.ai-custom-help') as HTMLButtonElement;
    const helpText = el.querySelector('.ai-json-help-text') as HTMLElement;
    expect(helpButton.textContent).toBe('?');
    expect(helpButton.hasAttribute('title')).toBe(false);
    expect(helpButton.getAttribute('aria-expanded')).toBe('false');
    expect(helpText.hidden).toBe(true);
    helpButton.click();
    expect(helpButton.getAttribute('aria-expanded')).toBe('true');
    expect(helpText.hidden).toBe(false);
    expect(helpText.textContent).toContain('Advanced JSON');
    expect((el.querySelector('#ai-custom-name') as HTMLInputElement).value).toBe('Company Gateway');
    expect((el.querySelector('#ai-custom-url') as HTMLInputElement).value).toBe('https://ai.example.test/v1');
    expect((el.querySelector('#ai-custom-model') as HTMLInputElement).value).toBe('agent');
  });

  it('always offers Custom endpoint and expands its approachable fields', () => {
    shared.settings = freshSettings();
    const { el } = renderTab();
    expandAi(el);
    const provider = el.querySelector('#ai-provider') as HTMLSelectElement;
    expect(Array.from(provider.options).at(-1)?.textContent).toBe('Custom endpoint…');
    provider.value = 'custom';
    provider.dispatchEvent(new Event('change'));

    expect(el.querySelector('[data-action="ai-expand"]')?.textContent).toBe('Close');
    expect(el.querySelector('#ai-custom-name')).toBeTruthy();
    expect(el.querySelector('#ai-custom-api-type')).toBeTruthy();
    expect(el.querySelector('#ai-custom-url')).toBeTruthy();
    expect(el.querySelector('#ai-custom-model')).toBeTruthy();
    expect(el.querySelector('.ai-custom-help')).toBeTruthy();
    expect(el.querySelector('.ai-custom-fields')).toBeTruthy();
    expect(el.querySelector('.ai-custom')).toBeNull();
    expect(el.querySelector('#ai-model')).toBeNull();
  });

  it('keeps invalid advanced JSON visible and shows its error beside the editor', () => {
    shared.settings = freshSettings();
    const { el } = renderTab();
    expandAi(el);
    const provider = el.querySelector('#ai-provider') as HTMLSelectElement;
    provider.value = 'custom';
    provider.dispatchEvent(new Event('change'));
    const details = el.querySelector('.ai-json') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    const textarea = el.querySelector('#ai-provider-json') as HTMLTextAreaElement;
    textarea.value = '{bad';
    textarea.dispatchEvent(new Event('input'));
    const key = el.querySelector('#ai-key') as HTMLInputElement;
    key.value = 'test-key';
    key.dispatchEvent(new Event('input'));
    (el.querySelector('[data-action="ai-save"]') as HTMLElement).click();

    expect((el.querySelector('.ai-json') as HTMLDetailsElement).open).toBe(true);
    expect(el.querySelector('.ai-json-error')?.textContent).toContain('Invalid JSON');
    expect((el.querySelector('#ai-provider-json') as HTMLTextAreaElement).value).toBe('{bad');
  });

  it('saves a new custom endpoint from normal fields without repainting its plaintext key', () => {
    shared.settings = freshSettings();
    const { el, sent } = renderTab();
    expandAi(el);
    const provider = el.querySelector('#ai-provider') as HTMLSelectElement;
    provider.value = 'custom';
    provider.dispatchEvent(new Event('change'));

    const name = el.querySelector('#ai-custom-name') as HTMLInputElement;
    name.value = 'Internal Gateway';
    const url = el.querySelector('#ai-custom-url') as HTMLInputElement;
    url.value = 'https://ai.internal.test/v1';
    const model = el.querySelector('#ai-custom-model') as HTMLInputElement;
    model.value = 'agent-model';
    const key = el.querySelector('#ai-key') as HTMLInputElement;
    key.value = 'plaintext-secret';
    (el.querySelector('[data-action="ai-save"]') as HTMLButtonElement).click();

    const save = sent.find(message => message.type === 'AI_SAVE_CUSTOM_PROVIDER');
    expect(save?.type).toBe('AI_SAVE_CUSTOM_PROVIDER');
    if (save?.type === 'AI_SAVE_CUSTOM_PROVIDER') {
      expect(save.json).toContain('"name": "Internal Gateway"');
      expect(save.json).toContain('"id": "agent-model"');
      expect(save.json).toContain('"apiKey": "plaintext-secret"');
    }
    expect((el.querySelector('#ai-provider-json') as HTMLTextAreaElement).value)
      .not.toContain('plaintext-secret');
  });

  it('AI_TEST_RESULT persists lastTest into shared settings for the card', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { tab, el } = renderTab();
    tab.handleMessage({ type: 'AI_TEST_RESULT', ok: true, model: 'deepseek-chat', ms: 233 });
    expect(shared.settings.ai?.lastTest).toMatchObject({ ok: true, ms: 233 });
    tab.render(el);
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(true);
    expect(card.querySelector('.ai-card-latency')?.textContent).toBe('233 ms');
  });

  it('folds AI assistant, Preferences and Keyboard shortcuts into collapsed bands, with inline help', () => {
    shared.settings = freshSettings();
    shared.cacheCount = 27;
    const { tab, el } = renderTab();
    tab.handleMessage({ type: 'CACHE_BYTES', bytes: 9 * 1024 });
    tab.render(el);

    const sections = Array.from(el.querySelectorAll<HTMLDetailsElement>('details.cx-sec'));
    expect(sections.map(s => s.querySelector('summary .t')?.textContent)).toEqual(['AI assistant', 'Preferences', 'Keyboard shortcuts']);
    expect(sections.every(s => !s.open)).toBe(true);
    // The existing content sits inside, unchanged.
    expect(sections[0].querySelector('.ai-card')).toBeTruthy();
    const prefs = sections[1];
    expect(prefs.querySelector('#auto-detect')).toBeTruthy();
    expect(prefs.querySelector('.connect-local-data')?.textContent).toContain('9 KB stored in this browser');
    expect(prefs.querySelector('.connect-local-data')?.textContent).toContain('Clear cache');
    // The browser commands from the registry: four with defaults plus Search the configuration.
    expect(sections[2].querySelectorAll('.connect-shortcut-list dt')).toHaveLength(5);
    expect(sections[2].querySelector('.connect-shortcut-list')?.textContent).toContain('Search the configuration');
    expect(sections[2].querySelector('.connect-shortcut-tip')?.textContent).toBe('Open in the address bar: chrome://extensions/shortcuts');

    // Open state survives a re-render.
    sections[1].open = true;
    sections[1].dispatchEvent(new Event('toggle'));
    tab.render(el);
    expect(el.querySelectorAll<HTMLDetailsElement>('details.cx-sec')[1].open).toBe(true);

    // Help is inline (no popover) and uses the current copy scheme.
    expect(el.querySelector('.connect-more-info')).toBeNull();
    const help = el.querySelector<HTMLDetailsElement>('details.cx-help')!;
    expect(help.open).toBe(false);
    const text = help.querySelector('.cx-htext')!.textContent!;
    expect(text).toContain('a page badge to copy its ID and make it current');
    expect(text).toContain('Shift + click copies the RID');
    expect(text).toContain('Alt + click the Instance ID');
    expect(text).toContain('Cmd + click the Reference');
    expect(text).toContain('Double-click opens it in the object window');
    expect(text).toContain('Alt+Enter the object window');
    expect(help.querySelectorAll('.cx-htext p')).toHaveLength(5);
  });
});

function oneProfile(change: Partial<ServerProfile> = {}): InspectorSettings {
  return {
    ...freshSettings(),
    profiles: [{
      id: 'p1', label: 'Steadfast', bmpUrl: 'https://bmp.test/Steadfast/',
      bmpUser: '', bmpPass: '', commandAuthMode: 'portal', ...change,
    }],
    activeProfileId: 'p1',
  };
}

describe('Command identity profile UI', () => {
  it('patches quiet validation metadata without replacing the focused DOM', () => {
    shared.settings = oneProfile();
    shared.connState = { ...shared.connState, display: 'connected', responseMs: 100, validation: 'idle', verifiedAt: 1 };
    const { tab, el } = renderTab();
    const focused = el.querySelector<HTMLInputElement>('#auto-detect')!;
    focused.focus();

    shared.connState = { ...shared.connState, responseMs: 225, validation: 'validating', verifiedAt: 2 };
    const needsRender = tab.handleMessage({ type: 'CONNECTION_STATE', state: shared.connState });

    expect(needsRender).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(el.querySelector<HTMLElement>('.cx-row.cur .cx-dot')?.title).toContain('checking now');
  });

  it('shows one row per server: dot, name, host in mono, mode, and This window', () => {
    shared.settings = oneProfile({ bmpUser: 'config.user', bmpPass: 'encrypted-in-real-storage', commandAuthMode: 'stored' });
    const { el } = renderTab();
    const row = el.querySelector('.cx-row')!;
    expect(row.classList.contains('cur')).toBe(true);
    expect(row.querySelector('.cx-nm')?.textContent).toBe('Steadfast');
    expect(row.querySelector('.cx-host.ui-id')?.textContent).toBe('bmp.test/Steadfast');
    expect(row.querySelector('.cx-mode')?.getAttribute('title')).toBe('Stored login');
    expect(row.querySelector('.cx-here')?.textContent).toBe('This window');
    expect(row.querySelector('.cx-pick')?.getAttribute('aria-current')).toBe('true');
    expect(Array.from(row.querySelectorAll('.cx-acts button')).map(b => b.getAttribute('title'))).toEqual(['Edit', 'Test connection', 'Remove']);
  });

  it('marks only the stored login on the row; the default browser login has no icon', () => {
    shared.settings = oneProfile();
    const { el } = renderTab();
    expect(el.querySelector('.cx-mode')).toBeNull();
    expect(el.querySelector('.cx-pick .sr-only')?.textContent).toContain('Browser login');
  });

  it('uses an explicit browser/stored selector and expands credentials only for stored mode', () => {
    shared.settings = oneProfile();
    const { el } = renderTab();
    (el.querySelector('[data-action="edit-profile"]') as HTMLButtonElement).click();

    // The form opens in place under its row.
    expect(el.querySelector('.cx-row')?.nextElementSibling?.classList.contains('cx-form')).toBe(true);
    const browser = el.querySelector<HTMLInputElement>('input[value="portal"]')!;
    const stored = el.querySelector<HTMLInputElement>('input[value="stored"]')!;
    const credentials = el.querySelector<HTMLElement>('.command-auth-credentials')!;
    expect(browser.checked).toBe(true);
    expect(credentials.hidden).toBe(true);
    expect(el.textContent).toContain('Use browser login');
    expect(el.textContent).toContain('Use stored configuration login');
    expect(el.textContent).toContain('Commands run as the user signed into this BMP page. Supports SSO.');

    stored.click();
    expect(credentials.hidden).toBe(false);
    expect(el.textContent).toContain('workspace search, live CVO data, and downloads remain signed in as your browser user');
  });
});

describe('Connect tab: edit, test, remove', () => {
  it('validates the address and the empty password inline and does not save', () => {
    shared.settings = oneProfile();
    const { el, sent } = renderTab();
    (el.querySelector('[data-action="edit-profile"]') as HTMLButtonElement).click();
    (el.querySelector('#pf-url') as HTMLInputElement).value = 'qa example.com/Steadfast';
    (el.querySelector<HTMLInputElement>('input[value="stored"]')!).click();
    (el.querySelector('#pf-user') as HTMLInputElement).value = 'admin';
    (el.querySelector('#pf-pass') as HTMLInputElement).value = '';
    (el.querySelector('[data-action="pf-save"]') as HTMLButtonElement).click();

    expect(el.querySelector('#pf-url-error')?.textContent).toContain('The address contains a space');
    expect(el.querySelector('#pf-url')?.getAttribute('aria-invalid')).toBe('true');
    expect(el.querySelector('#pf-pass-error')?.textContent).toBe('Enter the password.');
    expect(el.querySelector('#pf-pass')?.getAttribute('aria-invalid')).toBe('true');
    expect(el.querySelector('#pf-user-error')?.textContent).toBe('');
    expect(sent.some(m => m.type === 'SAVE_PROFILE')).toBe(false);

    // Typing clears that field's error.
    const pass = el.querySelector('#pf-pass') as HTMLInputElement;
    pass.value = 'x';
    pass.dispatchEvent(new Event('input'));
    expect(el.querySelector('#pf-pass-error')?.textContent).toBe('');
  });

  it('saves a valid edit and shows the verdict on the row', async () => {
    shared.settings = oneProfile();
    const { tab, el, sent } = renderTab();
    (el.querySelector('[data-action="edit-profile"]') as HTMLButtonElement).click();
    (el.querySelector('[data-action="pf-save"]') as HTMLButtonElement).click();
    expect(sent.find(m => m.type === 'SAVE_PROFILE')).toBeTruthy();
    expect(el.querySelector('.cx-form')).toBeNull();
    // The result sits on its own line under the row; name and host stay whole.
    expect(el.querySelector('.cx-rowwrap .cx-verdict.pending')?.textContent).toBe('Checking the connection\u2026');
    expect(el.querySelector('.cx-row .cx-nm')?.textContent).toBe('Steadfast');

    vi.useFakeTimers();
    tab.handleMessage({ type: 'PROFILE_VERDICT', profileId: 'p1', ok: true, text: 'Connected as admin', detail: null });
    tab.render(el);
    expect(el.querySelector('.cx-verdict.ok')?.textContent).toBe('Connected as admin');
    shared.activeTab = 'connect';
    // The line is brought into view once, when it is drawn.
    const line = el.querySelector<HTMLElement>('.cx-verdict.ok')!;
    const scroll = vi.fn();
    line.scrollIntoView = scroll;
    document.body.append(el);
    await Promise.resolve();
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    vi.advanceTimersByTime(19_000);
    expect(el.querySelector('.cx-verdict.ok')).not.toBeNull();
    vi.advanceTimersByTime(1_100);
    vi.useRealTimers();
    expect(el.querySelector('.cx-verdict')).toBeNull();
  });

  it('Test connection checks the window server and puts the result on its row', () => {
    shared.settings = oneProfile();
    shared.connState = { ...shared.connState, display: 'connected', validation: 'idle' };
    const { tab, el, sent } = renderTab();
    (el.querySelector('[data-action="test-profile"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'CONNECTION_TEST' });
    expect(el.querySelector('.cx-verdict.pending')).toBeTruthy();

    shared.connState = { ...shared.connState, display: 'unreachable', validation: 'idle', detail: 'No answer within 5 seconds.' };
    expect(tab.handleMessage({ type: 'CONNECTION_STATE', state: shared.connState })).toBe(true);
    tab.render(el);
    const err = el.querySelector<HTMLElement>('.cx-verdict.err')!;
    expect(err.textContent).toMatch(/does not answer/);
    expect(err.title).toContain('No answer within 5 seconds.');
  });

  it('asks in place before removing, and Cancel keeps the server', () => {
    shared.settings = oneProfile();
    const { el, sent } = renderTab();
    (el.querySelector('[data-action="remove-ask"]') as HTMLButtonElement).click();
    const confirm = el.querySelector('.cx-confirm')!;
    expect(confirm.textContent).toContain('Remove Steadfast?');
    expect(confirm.textContent).toContain('gives back its site access');
    expect(document.activeElement?.getAttribute('data-action')).toBe('remove-cancel');
    expect(sent.some(m => m.type === 'DELETE_PROFILE')).toBe(false);

    expect(el.querySelector('.cx-row')?.classList.contains('confirming')).toBe(true); // row actions hidden
    // Escape cancels, like the edit form.
    el.querySelector('.cx-confirm')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.querySelector('.cx-confirm')).toBeNull();
    expect(shared.settings.profiles).toHaveLength(1);
    expect(document.activeElement?.getAttribute('data-action')).toBe('remove-ask');
  });

  it('Remove deletes the server and the window falls back to the next one', () => {
    shared.settings = {
      ...oneProfile(),
      profiles: [
        ...oneProfile().profiles,
        { id: 'p2', label: 'Sandbox', bmpUrl: 'https://sandbox.test/Lab/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
      ],
    };
    const { el, sent } = renderTab();
    (el.querySelector('[data-action="remove-ask"][data-profile-id="p1"]') as HTMLButtonElement).click();
    (el.querySelector('[data-action="remove-confirm"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'DELETE_PROFILE', profileId: 'p1' });
    expect(shared.settings.profiles.map(p => p.id)).toEqual(['p2']);
    expect(shared.settings.activeProfileId).toBe('p2');
    expect(el.querySelectorAll('.cx-row')).toHaveLength(1);
  });

  it('offers Grant access on a row whose site is not granted, and Password needed on an unreadable stored login', async () => {
    shared.settings = {
      ...oneProfile(),
      profiles: [
        ...oneProfile().profiles,
        { id: 'p2', label: 'Sandbox', bmpUrl: 'https://sandbox.test/Lab/', bmpUser: 'u', bmpPass: '', commandAuthMode: 'stored', passwordUnreadable: true },
        { id: 'p3', label: 'Lab', bmpUrl: 'https://lab.test/Lab/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
      ],
    };
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
      permissions: { contains: async ({ origins }: { origins: string[] }) => !origins[0].includes('lab.test') },
    };
    const { tab, el } = renderTab();
    tab.activate();
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
    const lab = el.querySelector('.cx-row[data-profile-id="p3"]')!;
    expect(lab.querySelector('[data-action="grant-access"]')?.textContent).toBe('Grant access');
    expect(lab.querySelector('.cx-dot')?.classList.contains('warn')).toBe(true);
    const sandbox = el.querySelector('.cx-row[data-profile-id="p2"]')!;
    expect(sandbox.querySelector('.cx-lnk')?.textContent).toBe('Password needed');
    (sandbox.querySelector('.cx-lnk') as HTMLButtonElement).click();
    expect(el.querySelector('.cx-form label')?.textContent).toContain('Name');
    expect(el.textContent).toContain('Password (enter it again)');
  });

  it('settingsWithoutProfile keeps another active server', () => {
    const base = { ...oneProfile(), profiles: [...oneProfile().profiles, { ...oneProfile().profiles[0], id: 'p2' }], activeProfileId: 'p2' };
    expect(settingsWithoutProfile(base, 'p1').activeProfileId).toBe('p2');
    expect(settingsWithoutProfile(base, 'p2').activeProfileId).toBe('p1');
    expect(settingsWithoutProfile(oneProfile(), 'p1').activeProfileId).toBe('');
  });
});

describe('Connect tab: first run', () => {
  const setChrome = (request: () => Promise<boolean>, url = 'https://bmp.test/Steadfast/?rid=1') => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: { query: async () => [{ id: 9, url }] },
      permissions: { request: vi.fn(request), contains: async () => false },
    };
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

  it('offers the front tab, waits for the prompt, and adds the site when allowed', async () => {
    shared.settings = freshSettings();
    shared.bmpDetected = null;
    let resolve!: (v: boolean) => void;
    setChrome(() => new Promise<boolean>(r => { resolve = r; }));
    const { tab, el, sent } = renderTab();
    tab.activate();
    await flush();
    expect(el.querySelector('.cx-drow .ui-id')?.textContent).toBe('bmp.test/Steadfast');
    expect(Array.from(el.querySelectorAll('.cx-dact button')).map(b => b.textContent)).toEqual(['Add this site', 'Enter an address instead']);
    expect(el.querySelector('.cx-how')?.textContent).toContain('for bmp.test only');

    (el.querySelector('[data-action="add-this-site"]') as HTMLButtonElement).click();
    expect(el.querySelector('.cx-stp.now')?.textContent).toBe('Waiting for your answer in the browser prompt');
    expect(el.querySelector('.cx-how')).toBeNull();

    resolve(true);
    await flush();
    const save = sent.find(m => m.type === 'SAVE_PROFILE');
    expect(save?.type === 'SAVE_PROFILE' && save.profile).toMatchObject({ bmpUrl: 'https://bmp.test/Steadfast/', label: 'Steadfast', commandAuthMode: 'portal' });
    expect(el.querySelector('.cx-row')).toBeTruthy();
  });

  it('returns to the start with one sentence when the prompt is dismissed', async () => {
    shared.settings = freshSettings();
    setChrome(async () => false);
    const { tab, el, sent } = renderTab();
    tab.activate();
    await flush();
    (el.querySelector('[data-action="add-this-site"]') as HTMLButtonElement).click();
    await flush();
    expect(sent.some(m => m.type === 'SAVE_PROFILE')).toBe(false);
    expect(el.querySelector('[data-action="add-this-site"]')).toBeTruthy();
    expect(el.querySelector('.cx-note')?.textContent).toBe('The browser prompt closed without access, so nothing was added.');
  });

  it('firstRunCandidate ignores pages known not to be BMP and non-web tabs', () => {
    expect(firstRunCandidate('https://bmp.test/Ws/web/x?rid=1', null)).toBe('https://bmp.test/Ws/');
    expect(firstRunCandidate('https://bmp.test/Ws/', false)).toBeNull();
    expect(firstRunCandidate('chrome://extensions', true)).toBeNull();
  });
});
