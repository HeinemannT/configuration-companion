/**
 * Connect tab — server rows, the in-place edit form, first run, and the
 * collapsed AI assistant / Preferences / Keyboard shortcuts / Help sections.
 */

import { shortcutDef, shortcutLabel, shortcutsInScope } from '../../lib/shortcuts';
import { openCheatSheet } from '../../lib/cheat-sheet';
import type { InspectorMessage, InspectorSettings, ServerProfile, CommandAuthMode } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { ICON_WARNING, ICON_CHEVRON, ICON_PENCIL, ICON_X } from '../../lib/icons';
import { S as shared, getTabPanel } from '../state';
import { FLASH_INVALID_DURATION } from '../../lib/constants';
import { confirmModal } from '../../lib/modal';
import { discardTitle, mustAskBeforeLeaving, DISCARD_LABEL, KEEP_EDITING_LABEL } from '../../lib/unsaved';
import { getUpdateStatus, type UpdateStatus } from '../../lib/version-check';
import { originPatternFor } from '../../lib/site-access';
import { requestOriginsInGesture, onSiteAccessChanged } from '../site-access-strip';
import { PROVIDERS, AI_PROVIDER_IDS, parseCustomProviderJson, resolveProvider, isPlainTextAiAddress, PLAIN_TEXT_AI_ADDRESS_WARNING } from '../../lib/ai/providers';
import type { AiApiType, AiCustomProvider, AiProviderId } from '../../lib/ai/types';
import type { Tab, SendFn } from './tab-types';
import { describeConnection, saveVerdict } from '../../lib/connection-copy';
import { parseServerUrl, workspaceLabelFor } from '../../lib/server-url';
import { selectProfileOptimistically } from '../optimistic-profile';
import { dotTone, type DotTone } from '../connection-view';
import { icon, mountShellSprites } from '../icons';
import { announce } from '../announce';
import { copyText } from '../../lib/copy-feedback';
import { VOICE_KEY, readVoicePrefs, type VoicePrefs } from '../../lib/point-tell/voice';
import { statusFlash } from '../../lib/dom';
import { emptyState } from '../../lib/empty-state';

/** Settings after removing a server: the window falls back to the first remaining one. */
export function settingsWithoutProfile(settings: InspectorSettings, profileId: string): InspectorSettings {
  const profiles = settings.profiles.filter(p => p.id !== profileId);
  const activeProfileId = settings.activeProfileId === profileId ? (profiles[0]?.id ?? '') : settings.activeProfileId;
  return { ...settings, profiles, activeProfileId };
}

/** `host/Workspace` for a server address, without scheme or trailing slash. */
export function displayHost(bmpUrl: string): string {
  return bmpUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** The address a first run offers: the front tab's web page, unless it is known not to be BMP. */
export function firstRunCandidate(tabUrl: string | undefined, bmpDetected: boolean | null): string | null {
  if (!tabUrl || bmpDetected === false || !/^https?:\/\//i.test(tabUrl)) return null;
  const parsed = parseServerUrl(tabUrl);
  return parsed.ok ? parsed.url : null;
}

type SectionKey = 'ai' | 'prefs' | 'keys' | 'help';

/** How long a successful save or test result stays under its row. */
const VERDICT_SHOW_MS = 20_000;

interface FieldErrors { url?: string; user?: string; pass?: string }

type EditingProfile = {
  id: string | null;
  label: string;
  bmpUrl: string;
  bmpUser: string;
  bmpPass: string;
  commandAuthMode: CommandAuthMode;
  commandAuthRevision?: string;
  /** A password is stored for this profile. The panel never receives it:
   *  an empty field keeps it, "Remove" clears it (clearPassword). */
  hasStoredPassword?: boolean;
  clearPassword?: boolean;
};

const CUSTOM_PROVIDER_TEMPLATE = `{
  "name": "OpenRouter",
  "vendor": "openrouter",
  "apiKey": "",
  "apiType": "openai",
  "models": [
    {
      "id": "anthropic/claude-sonnet-4",
      "name": "Claude Sonnet 4",
      "url": "https://openrouter.ai/api/v1",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 200000,
      "maxOutputTokens": 64000,
      "maxTokensParam": "max_completion_tokens"
    }
  ]
}`;

function customProviderJson(provider?: AiCustomProvider): string {
  if (!provider) return CUSTOM_PROVIDER_TEMPLATE;
  return JSON.stringify({
    name: provider.name,
    vendor: provider.vendor,
    apiKey: '',
    apiType: provider.apiType,
    models: provider.models,
  }, null, 2);
}

interface AiCustomDraft {
  name: string;
  apiType: AiApiType;
  baseUrl: string;
  modelId: string;
}

function customDraftFromProvider(provider?: AiCustomProvider): AiCustomDraft {
  const source = provider ?? parseCustomProviderJson(CUSTOM_PROVIDER_TEMPLATE).provider;
  const model = source.models.find(item => item.toolCalling) ?? source.models[0];
  return {
    name: source.name,
    apiType: source.apiType,
    baseUrl: model.url,
    modelId: model.id,
  };
}

/** Apply the approachable single-endpoint fields to the advanced JSON without
 *  discarding extra model metadata a technical user may have added there. */
function mergeCustomProviderDraft(json: string, draft: AiCustomDraft, apiKey: string): string {
  const parsed = parseCustomProviderJson(json);
  const models = parsed.provider.models.map(model => ({ ...model }));
  const primaryIndex = Math.max(0, models.findIndex(model => model.toolCalling));
  const primary = models[primaryIndex];
  models[primaryIndex] = {
    ...primary,
    id: draft.modelId.trim(),
    name: primary.name === primary.id ? draft.modelId.trim() : primary.name,
    url: draft.baseUrl.trim(),
    toolCalling: true,
  };
  return JSON.stringify({
    name: draft.name.trim(),
    vendor: parsed.provider.vendor,
    apiKey: apiKey.trim(),
    apiType: draft.apiType,
    models,
  }, null, 2);
}

export class ConnectTab implements Tab {
  private editing: EditingProfile | null = null;
  private lastConnectionRenderKey: string | null = null;
  private send: SendFn;
  private updateStatus: UpdateStatus | null = null;
  private updatePanel: HTMLElement | null = null;
  /** Authoritative shortcut bindings from chrome.commands.getAll(). Empty
   *  string in the map means "user cleared it"; missing key means "not yet
   *  loaded" (we don't have the API result back). */
  private commandShortcuts = new Map<string, string>();
  private shortcutsLoaded = false;
  /** Approximate persisted-cache byte size — requested on activate, updated
   *  via CACHE_BYTES response. Surfaces a "~X MB" hint next to the cache count
   *  so the user can see when they're approaching the 10 MB quota. */
  private cacheBytes: number | null = null;
  /** Set true when the SW reports a CACHE_QUOTA_WARNING; renders a banner. */
  private cacheQuotaWarning = false;

  /** Open disclosure sections; kept across re-renders. */
  private openSections = new Set<SectionKey>();
  /** First run: the front tab's address on offer, and the permission step. */
  private frontUrl: string | null = null;
  private firstRun: { phase: 'start' | 'waiting'; note: string | null; token: number } = { phase: 'start', note: null, token: 0 };
  /** Server whose removal waits for the in-place confirmation. */
  private removing: string | null = null;
  /** Server whose manual connection test is running. */
  private testing: { profileId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Per-profile host-permission state (origin pattern → granted). Refreshed on activate/save;
   *  drives the "no site access" chip on profile cards. Unknown origins simply render no chip. */
  private accessByOrigin = new Map<string, boolean>();

  // ── AI assistant settings state ────────────────────────────────
  /** True once a provider key is stored (derived from SETTINGS_DATA + updated
   *  by AI_CONFIG_SAVED). Drives "Key saved" vs the key input. */
  private aiConfigured = false;
  /** Draft provider/model while the user is choosing, before Save. Null ⇒
   *  derive from the stored config (or the provider default). */
  private aiProviderDraft: AiProviderId | null = null;
  private aiModelDraft: string | null = null;
  /** Unsaved custom-provider JSON. Plaintext keys live here only until Save. */
  private aiJsonDraft: string | null = null;
  /** Human-facing fields for the primary custom endpoint. The advanced JSON
   *  remains the lossless source for extra models/capabilities. */
  private aiCustomDraft: AiCustomDraft | null = null;
  private aiJsonOpen = false;
  private aiJsonHelpOpen = false;
  private aiJsonError: string | null = null;
  private aiJsonSaving = false;
  /** Draft of the unsaved API key, carried across re-renders so an async
   *  repaint (provider change, a status/model-list tick) can't wipe a key the
   *  user typed but hasn't Saved yet. Cleared once the key is saved/removed. */
  private aiKeyDraft = '';
  /** True when replacing an already-saved key (shows the key input again). */
  private aiReplacingKey = false;
  private aiTestStatus: { ok: boolean; text: string } | null = null;
  private aiTesting = false;
  private aiModelOptions: string[] = [];
  private aiModelsLoading = false;   // "Load list" is in flight — button shows a spinner label
  private aiModelMenuOpen = false;   // the unfiltered "browse all models" menu is open
  /** Collapsed server-row card vs the expanded config form. */
  private aiExpanded = false;
  /** Voice comments in Point and tell: off until turned on here. Stored apart from the server settings. */
  private voice: VoicePrefs = readVoicePrefs(undefined);

  /** Result of the connection test that follows a profile save, shown under
   *  that profile's row until the next save or a different selection. */
  private verdict: { profileId: string; pending: boolean; ok: boolean; text: string; detail: string | null; display?: string } | null = null;
  /** Inline validation messages for the open form. */
  private fieldErrors: FieldErrors = {};

  constructor(send: SendFn) {
    this.send = send;
    // The band's "Edit server" opens the active profile's form.
    document.addEventListener('crev:edit-active-profile', () => {
      const profile = shared.settings.profiles.find(p => p.id === shared.settings.activeProfileId);
      if (profile) this.openEditor(profile);
    });
    onSiteAccessChanged(() => { void this.refreshAccess(); });
    try {
      void chrome.storage.local.get(VOICE_KEY).then(r => {
        this.voice = readVoicePrefs(r[VOICE_KEY]);
        const panel = getTabPanel('connect');
        if (panel && !this.editing) this.render(panel);
      }).catch(() => {});
      // Voice comments can also be turned on from the comment field on a page: the setting shown here follows.
      chrome.storage.onChanged.addListener((changes, area) => {
        const change = changes[VOICE_KEY];
        if (area !== 'local' || !change) return;
        this.voice = readVoicePrefs(change.newValue);
        const panel = getTabPanel('connect');
        if (panel && !this.editing) this.render(panel);
      });
    } catch { /* no extension storage here */ }
  }

  /** The open server form's fields that differ from what it opened with (none: no form). */
  private unsavedFormFields(): number {
    if (!this.editing) return 0;
    const panel = getTabPanel('connect');
    const val = (sel: string): string | null => panel?.querySelector<HTMLInputElement>(sel)?.value ?? null;
    const e = this.editing;
    const pairs: Array<[string | null, string]> = [[val('#pf-label'), e.label ?? ''], [val('#pf-url'), e.bmpUrl ?? ''], [val('#pf-user'), e.bmpUser ?? ''], [val('#pf-pass'), '']];
    return pairs.filter(([now, was]) => now !== null && now !== was).length;
  }

  /** Opening another server form drops the open one: ask once when it holds unsaved changes. */
  private async mayLeaveForm(): Promise<boolean> {
    const n = this.unsavedFormFields();
    if (!mustAskBeforeLeaving(n)) return true;
    return confirmModal({
      title: discardTitle(n),
      body: 'The server form you are editing has unsaved changes. Opening another form drops them.',
      confirmLabel: DISCARD_LABEL, cancelLabel: KEEP_EDITING_LABEL, confirmVariant: 'danger',
    });
  }

  private openEditor(profile: ServerProfile): void {
    if (this.editing && this.editing.id !== profile.id && this.unsavedFormFields() > 0) {
      void this.mayLeaveForm().then(ok => { if (ok) { this.editing = null; this.openEditor(profile); } });
      return;
    }
    this.editing = {
      ...profile,
      bmpPass: '',
      hasStoredPassword: !!profile.hasStoredPassword && !profile.passwordUnreadable,
      clearPassword: false,
      commandAuthMode: profile.commandAuthMode ?? 'portal',
    };
    this.fieldErrors = {};
    this.removing = null;
    const panel = getTabPanel('connect');
    if (panel) this.render(panel);
    const unreadable = profile.passwordUnreadable && (profile.commandAuthMode ?? 'portal') === 'stored';
    panel?.querySelector<HTMLInputElement>(unreadable ? '#pf-pass' : '#pf-label')?.focus();
  }

  /** The front tab's address for a first run (no server saved yet). */
  private async detectFront(): Promise<void> {
    if (shared.settings.profiles.length) return;
    let url: string | null = null;
    try {
      const win = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      url = firstRunCandidate(tab?.url, shared.bmpDetected);
    } catch { url = null; }
    if (url === this.frontUrl) return;
    this.frontUrl = url;
    if (shared.activeTab === 'connect' && !this.editing && this.firstRun.phase === 'start') {
      const panel = getTabPanel('connect');
      if (panel) this.render(panel);
    }
  }

  /** Store a profile and start the save verdict (the worker tests it). */
  private saveProfile(profile: ServerProfile): void {
    const profiles = [...shared.settings.profiles];
    const idx = profiles.findIndex(p => p.id === profile.id);
    const previous = idx >= 0 ? profiles[idx] : undefined;
    // The panel keeps no password in its copy of the settings.
    const shown: ServerProfile = {
      ...profile,
      bmpPass: '',
      hasStoredPassword: !!profile.bmpPass || (!!previous?.hasStoredPassword && !profile.clearPassword),
    };
    if (idx >= 0) profiles[idx] = shown; else profiles.push(shown);
    shared.settings = { ...shared.settings, profiles, activeProfileId: shared.settings.activeProfileId || profile.id };
    this.send({ type: 'SAVE_PROFILE', profile });
    this.verdict = { profileId: profile.id, pending: true, ok: true, text: 'Checking the connection…', detail: null };
  }

  /** Address of the BMP page in front of this panel's window, when it is a
   *  BMP page and no saved server covers it yet. Used to prefill "Add server". */
  private async frontBmpUrl(): Promise<string | null> {
    if (shared.bmpDetected !== true) return null;
    try {
      const win = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (!tab?.url) return null;
      const parsed = parseServerUrl(tab.url);
      if (!parsed.ok) return null;
      // Already saved: nothing to prefill.
      const saved = shared.settings.profiles.map(p => parseServerUrl(p.bmpUrl));
      if (saved.some(p => p.ok && p.url === parsed.url)) return null;
      return parsed.url;
    } catch {
      return null;
    }
  }

  activate() {
    this.aiConfigured = !!shared.settings.ai?.apiKeyEnc;
    this.send({ type: 'GET_SETTINGS' });
    this.send({ type: 'GET_CACHE_BYTES' });
    void this.refreshAccess();
    // Update check is fire-and-forget; the banner shows whatever we have
    // cached immediately, then re-renders when the response lands. Read once
    // here on activate so opening the panel always gets fresh-ish data.
    void this.loadUpdateStatus();
    void this.loadCommandShortcuts();
    void this.detectFront();
  }

  /** Pull the user's actual key bindings from Chrome (which is authoritative —
   *  manifest values are only DEFAULTS, the user can clear or remap at
   *  chrome://extensions/shortcuts). Re-renders Quick reference on response so
   *  the displayed keys match reality. */
  private async loadCommandShortcuts(): Promise<void> {
    try {
      const commands = await chrome.commands.getAll();
      for (const c of commands) {
        if (c.name) this.commandShortcuts.set(c.name, c.shortcut ?? '');
      }
      this.shortcutsLoaded = true;
      // Cheap re-render of just the reference card would require holding a
      // ref to it; instead, signal a full rerender from the tab if we're the
      // active tab. SKIP re-render when the user is mid-edit of a server
      // profile — wiping their half-typed password to repaint a shortcut
      // chip is worse than waiting for the next render.
      if (shared.activeTab === 'connect' && !this.editing) {
        const panel = getTabPanel('connect');
        if (panel) this.render(panel);
      }
    } catch (e) {
      // chrome.commands unavailable (rare) — fall back to manifest defaults.
      this.shortcutsLoaded = true;
    }
  }

  /** Re-check host-permission state for every configured profile origin. Follows the same
   *  re-render etiquette as loadCommandShortcuts: repaint only when active and not mid-edit. */
  private async refreshAccess(): Promise<void> {
    const next = new Map<string, boolean>();
    for (const p of shared.settings.profiles) {
      const origin = originPatternFor(p.bmpUrl);
      if (!origin) continue;
      try { next.set(origin, await chrome.permissions.contains({ origins: [origin] })); }
      catch { /* permissions API unavailable — no chips */ }
    }
    const changed = next.size !== this.accessByOrigin.size
      || [...next].some(([k, v]) => this.accessByOrigin.get(k) !== v);
    this.accessByOrigin = next;
    if (changed && shared.activeTab === 'connect' && !this.editing) {
      const panel = getTabPanel('connect');
      if (panel) this.render(panel);
    }
  }

  private async loadUpdateStatus(): Promise<void> {
    const status = await getUpdateStatus();
    this.updateStatus = status;
    if (this.updatePanel && document.body.contains(this.updatePanel)) {
      // Swap the banner in place without forcing a whole-tab re-render —
      // avoids losing scroll position / form focus when the check returns
      // while the user is editing a server profile.
      const mounted = this.updatePanel;
      const fresh = this.renderUpdateBanner();
      mounted.replaceWith(fresh);
      this.updatePanel = fresh;
    }
  }

  deactivate() {
    // nothing to close: the sections and the help are inline
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'SETTINGS_DATA':
        this.aiConfigured = !!shared.settings.ai?.apiKeyEnc;
        if (this.removing && !shared.settings.profiles.some(p => p.id === this.removing)) this.removing = null;
        if (!shared.settings.profiles.length) void this.detectFront();
        void this.refreshAccess();
        return !this.editing;
      case 'DETECTION_STATE':
      case 'PAGE_INFO':
        if (!shared.settings.profiles.length) void this.detectFront();
        return false;
      case 'CONNECTION_STATE': {
        // A manual test settles on the first answer that is not mid-check.
        const s = shared.connState;
        if (this.testing && s.validation !== 'validating' && s.display !== 'checking') {
          clearTimeout(this.testing.timer);
          const v = saveVerdict(s);
          this.verdict = { profileId: this.testing.profileId, pending: false, ...v, display: s.display };
          this.testing = null;
          announce(v.text, !v.ok);
          return !this.editing;
        }
        // A verdict describes the state right after saving; once the live
        // state moves on (for example it healed), the row shows the live one.
        if (this.verdict && !this.verdict.pending && this.verdict.display
          && this.verdict.display !== shared.connState.display) this.verdict = null;
        const nextKey = this.connectionRenderKey();
        if (nextKey === this.lastConnectionRenderKey) {
          this.refreshConnectionMetadata();
          return false;
        }
        return !this.editing;
      }
      case 'PROFILE_SWITCHED':
        return !this.editing; // re-render unless user is editing a form
      case 'PROFILE_VERDICT':
        this.verdict = {
          profileId: msg.profileId, pending: false, ok: msg.ok, text: msg.text, detail: msg.detail,
          display: msg.profileId === shared.settings.activeProfileId ? shared.connState.display : undefined,
        };
        announce(msg.text, !msg.ok);
        return !this.editing;
      case 'AI_CONFIG_SAVED':
        this.aiConfigured = msg.configured;
        if (msg.ok) {
          if (this.aiJsonSaving) this.aiJsonError = null;
          this.aiReplacingKey = false;
          this.aiTestStatus = null;
          this.aiKeyDraft = '';   // key is stored now — drop the unsaved draft
          this.aiProviderDraft = msg.provider ?? null;
          this.aiModelDraft = msg.model ?? null;
          if (msg.provider) shared.settings = {
            ...shared.settings,
            ai: {
              provider: msg.provider,
              model: msg.model ?? '',
              apiKeyEnc: msg.configured ? 'set' : '',
              ...(msg.customProvider ? { customProvider: msg.customProvider } : shared.settings.ai?.customProvider ? { customProvider: shared.settings.ai.customProvider } : {}),
            },
          };
          if (msg.customProvider) {
            this.aiJsonDraft = customProviderJson(msg.customProvider);
            this.aiCustomDraft = customDraftFromProvider(msg.customProvider);
          }
          if (!msg.configured) shared.settings = { ...shared.settings, ai: undefined };
        } else {
          if (this.aiJsonSaving) {
            this.aiJsonError = msg.error ?? 'Could not save provider JSON';
            this.aiJsonOpen = true;
          } else {
            this.aiTestStatus = { ok: false, text: msg.error ?? 'Could not save' };
          }
        }
        this.aiJsonSaving = false;
        return !this.editing;
      case 'AI_TEST_RESULT':
        this.aiTesting = false;
        this.aiTestStatus = msg.ok ? { ok: true, text: 'Connected' } : { ok: false, text: msg.error ?? 'Failed' };
        // Mirror the persisted last-test into shared settings so the collapsed
        // card renders READY + latency immediately (the SW also persisted it).
        if (shared.settings.ai) {
          shared.settings = {
            ...shared.settings,
            ai: { ...shared.settings.ai, lastTest: { ok: msg.ok, ms: msg.ms ?? 0, at: Date.now() } },
          };
        }
        return !this.editing;
      case 'AI_MODELS_RESULT':
        this.aiModelsLoading = false;
        if (msg.ok && msg.models) { this.aiModelOptions = msg.models; this.aiModelMenuOpen = true; } // reveal the list on arrival
        else this.aiTestStatus = { ok: false, text: msg.error ?? 'Could not load models' };
        return !this.editing;
      case 'CACHE_BYTES':
        // Update the "~X MB" hint next to the cache count. If we're editing
        // a profile form we skip the re-render so the user's keystrokes
        // aren't disrupted; the next activate() will refresh it.
        if ('bytes' in msg) this.cacheBytes = msg.bytes;
        return !this.editing;
      case 'CACHE_QUOTA_WARNING':
        this.cacheQuotaWarning = true;
        return !this.editing;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    this.lastConnectionRenderKey = this.connectionRenderKey();
    mountShellSprites(container.ownerDocument);
    const rerender = () => this.render(container);
    // Re-renders replace the DOM; keep keyboard focus on the same control.
    const focusKey = (container.ownerDocument.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-fk]');
    const keepFocus = focusKey && container.contains(focusKey) ? focusKey.dataset.fk : null;

    const children: (HTMLElement | false | null)[] = [];
    const firstRun = shared.settings.profiles.length === 0 && !this.editing;

    if (firstRun) {
      children.push(...this.renderFirstRun());
    } else {
      children.push(this.band('Servers', this.editing?.id === null ? null : h('button', {
        class: 'ui-tbtn cx-add', type: 'button', 'data-action': 'add-profile', 'data-fk': 'add',
        title: 'Add a server',
      }, icon('i-plus', 'ic-sm'), 'Add')));
      const list = h('div', { class: 'cx-list', role: 'list', 'aria-label': 'Servers' });
      if (this.editing?.id === null) list.append(this.renderProfileForm(rerender));
      for (const profile of shared.settings.profiles) {
        list.append(this.renderProfileRow(profile));
        if (this.removing === profile.id) list.append(this.renderRemoveConfirm(profile));
        if (this.editing?.id === profile.id) list.append(this.renderProfileForm(rerender));
      }
      children.push(list);
    }

    const prefs = h('div', { class: 'cx-sec-body' },
      this.settingRow('auto-detect', 'Auto-detect server from page URL',
        null, shared.settings.autoDetect),
      this.settingRow('enrich-all', 'Include non-widget objects',
        'Also labels inline elements (tables, others)',
        shared.settings.enrichMode === 'all'),
      this.settingRow('voice-on', 'Voice comments',
        "Speech is turned into text by the browser's speech service",
        this.voice.on),
      h('label', { class: 'setting-row', id: 'voice-lang-row' },
        h('span', { class: 'setting-text' }, h('span', { class: 'setting-name' }, 'Voice language')),
        h('select', { class: 'field-input', id: 'voice-lang', 'aria-label': 'Voice language' },
          h('option', { value: 'auto' }, 'Browser language'),
          h('option', { value: 'en-US' }, 'English'),
          h('option', { value: 'de-DE' }, 'Deutsch'))),
      // Local extension data belongs with Preferences. The persistent status
      // bar already carries the cache count, so this row only explains and
      // manages the stored data.
      this.renderLocalData(),
    );

    children.push(
      this.section('ai', 'AI assistant', h('div', { class: 'cx-sec-body' }, this.renderAiSection())),
      this.section('prefs', 'Preferences', prefs),
      this.section('keys', 'Keyboard shortcuts', h('div', { class: 'cx-sec-body' }, this.renderKeyboardShortcuts())),
      this.cacheQuotaWarning
        ? h('div', { class: 'cache-quota-banner' },
            'Storage quota reached. Older cache entries are being evicted. ',
            h('button', { class: 'btn btn-small btn-ghost', 'data-action': 'reset-all', title: 'Clear the object cache and the badge names to free space' }, 'Reset'),
          )
        : null,
      this.renderUpdateBanner(),
      this.renderHelp(),
    );

    render(container, h('div', { class: 'cx ui' }, ...children));
    if (keepFocus) container.querySelector<HTMLElement>(`[data-fk="${keepFocus.replace(/"/g, '')}"]`)?.focus();

    container.querySelectorAll<HTMLDetailsElement>('details[data-sec]').forEach((details) => {
      details.addEventListener('toggle', () => {
        const key = details.dataset.sec as SectionKey;
        if (details.open) this.openSections.add(key); else this.openSections.delete(key);
      });
    });

    // Inline validation clears as soon as the field changes.
    for (const [id, key] of [['#pf-url', 'url'], ['#pf-user', 'user'], ['#pf-pass', 'pass']] as const) {
      container.querySelector(id)?.addEventListener('input', () => {
        if (!this.fieldErrors[key]) return;
        delete this.fieldErrors[key];
        this.paintFieldError(container, key);
      });
    }
    // The access hint follows the typed address.
    const hint = container.querySelector<HTMLElement>('#pf-access-hint');
    container.querySelector<HTMLInputElement>('#pf-url')?.addEventListener('input', (e) => {
      if (hint) this.paintAccessHint(hint, (e.target as HTMLInputElement).value);
    });

    container.querySelector('#auto-detect')?.addEventListener('change', (e) => {
      const autoDetect = (e.target as HTMLInputElement).checked;
      shared.settings = { ...shared.settings, autoDetect };
      this.send({ type: 'SAVE_SETTINGS', settings: { autoDetect } });
    });

    const langSel = container.querySelector<HTMLSelectElement>('#voice-lang');
    if (langSel) langSel.value = this.voice.lang;
    const saveVoice = (next: VoicePrefs): void => { this.voice = next; try { void chrome.storage.local.set({ [VOICE_KEY]: next }); } catch { /* not stored */ } };
    container.querySelector('#voice-on')?.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      // Turning it on again says once more where the audio goes.
      saveVoice({ ...this.voice, on, ...(on ? { noticed: false } : {}) });
    });
    langSel?.addEventListener('change', () => saveVoice({ ...this.voice, lang: langSel.value as VoicePrefs['lang'] }));

    container.querySelector('#enrich-all')?.addEventListener('change', (e) => {
      const enrichMode = (e.target as HTMLInputElement).checked ? 'all' as const : 'widgets' as const;
      shared.settings = { ...shared.settings, enrichMode };
      this.send({ type: 'SAVE_SETTINGS', settings: { enrichMode } });
    });

    // AI provider select — switching provider resets the model draft to that
    // provider's default and clears any loaded model list / test status.
    container.querySelector('#ai-provider')?.addEventListener('change', (e) => {
      const provider = (e.target as HTMLSelectElement).value as AiProviderId;
      this.aiProviderDraft = provider;
      if (provider === 'custom') {
        this.aiCustomDraft = customDraftFromProvider(shared.settings.ai?.customProvider);
        this.aiJsonDraft ??= customProviderJson(shared.settings.ai?.customProvider);
        this.aiModelDraft = this.aiCustomDraft.modelId;
      } else {
        this.aiModelDraft = PROVIDERS[provider].defaultModel;
      }
      this.aiModelOptions = [];
      this.aiModelsLoading = false;
      this.aiModelMenuOpen = false;
      this.aiTestStatus = null;
      rerender();
    });
    // Model input — keep the typed value across re-renders (test/model-list
    // responses re-render the tab) without churning on every keystroke.
    container.querySelector('#ai-model')?.addEventListener('input', (e) => {
      this.aiModelDraft = (e.target as HTMLInputElement).value;
    });
    // API key input — same race protection as the model: keep the typed value
    // in a draft so an async re-render (provider switch, test/model-list tick)
    // can't recreate the input empty before the user hits Save.
    container.querySelector('#ai-key')?.addEventListener('input', (e) => {
      this.aiKeyDraft = (e.target as HTMLInputElement).value;
    });
    const updateCustomDraft = () => {
      const name = (container.querySelector('#ai-custom-name') as HTMLInputElement | null)?.value ?? '';
      const apiType = (container.querySelector('#ai-custom-api-type') as HTMLSelectElement | null)?.value as AiApiType | undefined;
      const baseUrl = (container.querySelector('#ai-custom-url') as HTMLInputElement | null)?.value ?? '';
      const modelId = (container.querySelector('#ai-custom-model') as HTMLInputElement | null)?.value ?? '';
      if (apiType) this.aiCustomDraft = { name, apiType, baseUrl, modelId };
      const warn = container.querySelector('#ai-custom-url-warn');
      if (warn) {
        warn.textContent = '';
        if (isPlainTextAiAddress(baseUrl)) warn.append(svg(ICON_WARNING), ` ${PLAIN_TEXT_AI_ADDRESS_WARNING}`);
      }
    };
    for (const id of ['#ai-custom-name', '#ai-custom-api-type', '#ai-custom-url', '#ai-custom-model']) {
      container.querySelector(id)?.addEventListener('input', updateCustomDraft);
      container.querySelector(id)?.addEventListener('change', updateCustomDraft);
    }
    container.querySelector('#ai-provider-json')?.addEventListener('input', (e) => {
      this.aiJsonDraft = (e.target as HTMLTextAreaElement).value;
      this.aiJsonError = null;
    });
    container.querySelector('.ai-json')?.addEventListener('toggle', (e) => {
      this.aiJsonOpen = (e.currentTarget as HTMLDetailsElement).open;
    });

    // Live update for the HTTP-downgrade warning while editing the URL. We
    // don't re-render the whole tab on every keystroke (that would blur the
    // input + lose focus); just update the warning span in place.
    const urlInput = container.querySelector('#pf-url') as HTMLInputElement | null;
    const urlWarn = container.querySelector('#pf-url-warn');
    if (urlInput && urlWarn) {
      urlInput.addEventListener('input', () => {
        urlWarn.textContent = '';
        const storedSelected = (container.querySelector('input[name="pf-command-auth"]:checked') as HTMLInputElement | null)?.value === 'stored';
        if (storedSelected && isInsecureUrl(urlInput.value)) {
          urlWarn.append(svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.');
        }
      });
    }

    delegate(container, {
      'add-profile': () => {
        if (this.editing && this.unsavedFormFields() > 0) {
          void this.mayLeaveForm().then(ok => { if (ok) { this.editing = null; (container.querySelector('[data-fk="add"]') as HTMLElement | null)?.click(); } });
          return;
        }
        this.editing = { id: null, label: '', bmpUrl: '', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' };
        this.fieldErrors = {};
        this.removing = null;
        rerender();
        container.querySelector<HTMLInputElement>('#pf-label')?.focus();
        // A BMP page is in front: offer its workspace as the new server.
        void this.frontBmpUrl().then((url) => {
          if (!url || !this.editing || this.editing.id !== null) return;
          const urlField = container.querySelector<HTMLInputElement>('#pf-url');
          const labelField = container.querySelector<HTMLInputElement>('#pf-label');
          if (urlField && !urlField.value) {
            urlField.value = url;
            this.editing.bmpUrl = url;
          }
          if (labelField && !labelField.value) {
            labelField.value = workspaceLabelFor(url);
            this.editing.label = labelField.value;
          }
        });
      },
      'select-profile': (el) => {
        const id = el.dataset.profileId;
        if (!id || id === shared.settings.activeProfileId) return;
        // A finished verdict is superseded by the live state of the selection.
        if (this.verdict && !this.verdict.pending) this.verdict = null;
        selectProfileOptimistically(id);
        rerender();
      },
      'edit-profile': (el) => {
        const profile = shared.settings.profiles.find(p => p.id === el.dataset.profileId);
        if (profile) this.openEditor(profile);
      },
      'test-profile': (el) => {
        const id = el.dataset.profileId;
        if (!id || id !== shared.settings.activeProfileId) return;
        if (this.testing) clearTimeout(this.testing.timer);
        this.send({ type: 'CONNECTION_TEST' });
        // Bounded: a lost answer cannot leave the row checking forever.
        const timer = setTimeout(() => {
          if (this.testing?.profileId !== id) return;
          this.testing = null;
          if (this.verdict?.profileId === id && this.verdict.pending) this.verdict = null;
          const panel = getTabPanel('connect');
          if (panel && !this.editing) this.render(panel);
        }, 35_000);
        this.testing = { profileId: id, timer };
        this.verdict = { profileId: id, pending: true, ok: true, text: 'Checking the connection…', detail: null };
        rerender();
      },
      'grant-access': (el) => {
        // Re-request a profile origin whose grant was declined/revoked. Runs INSIDE this click —
        // the standard browser prompt requires the user gesture.
        const origin = el.dataset.grantOrigin;
        if (!origin) return;
        void requestOriginsInGesture([origin]).then(() => this.refreshAccess());
      },
      'remove-ask': (el) => {
        const id = el.dataset.profileId;
        if (!id) return;
        this.removing = id;
        if (this.editing?.id === id) this.editing = null;
        rerender();
        container.querySelector<HTMLElement>('[data-fk="remove-cancel"]')?.focus();
      },
      'remove-cancel': () => {
        const id = this.removing;
        this.removing = null;
        rerender();
        if (id) container.querySelector<HTMLElement>(`[data-fk="remove:${id}"]`)?.focus();
      },
      'remove-confirm': () => {
        const deletedId = this.removing;
        if (!deletedId) return;
        const target = shared.settings.profiles.find(p => p.id === deletedId);
        shared.settings = settingsWithoutProfile(shared.settings, deletedId);
        this.send({ type: 'DELETE_PROFILE', profileId: deletedId });
        if (this.verdict?.profileId === deletedId) this.verdict = null;
        if (this.editing?.id === deletedId) this.editing = null;
        this.removing = null;
        rerender();
        announce(`Removed ${target?.label ?? 'the server'}.`);
        container.querySelector<HTMLElement>('[data-fk="add"]')?.focus();
        // The SW revokes the orphaned origin asynchronously — refresh the chips after it lands.
        setTimeout(() => { void this.refreshAccess(); }, 500);
      },
      'add-this-site': () => {
        const url = this.frontUrl;
        if (!url) return;
        const origin = originPatternFor(url);
        // The browser prompt must be requested inside this click.
        const request = requestOriginsInGesture(origin ? [origin] : []);
        const token = this.firstRun.token + 1;
        this.firstRun = { phase: 'waiting', note: null, token };
        rerender();
        container.querySelector<HTMLElement>('[data-fk="first-cancel"]')?.focus();
        void request.then((granted) => {
          if (this.firstRun.token !== token || this.firstRun.phase !== 'waiting') return; // cancelled
          if (!granted) {
            const note = 'The browser prompt closed without access, so nothing was added.';
            this.firstRun = { phase: 'start', note, token };
            announce(note);
          } else {
            this.firstRun = { phase: 'start', note: null, token };
            this.saveProfile({
              id: crypto.randomUUID(), label: workspaceLabelFor(url) || 'Unnamed', bmpUrl: url,
              bmpUser: '', bmpPass: '', commandAuthMode: 'portal',
            });
            void this.refreshAccess();
          }
          const panel = getTabPanel('connect');
          if (panel) this.render(panel);
        });
      },
      'first-cancel': () => {
        this.firstRun = { phase: 'start', note: null, token: this.firstRun.token + 1 };
        rerender();
      },
      'enter-address': () => {
        this.editing = { id: null, label: '', bmpUrl: '', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' };
        this.fieldErrors = {};
        this.firstRun = { phase: 'start', note: null, token: this.firstRun.token + 1 };
        rerender();
        container.querySelector<HTMLInputElement>('#pf-url')?.focus();
      },
      'pf-save': () => {
        if (!this.editing) return;
        const urlInput = container.querySelector('#pf-url') as HTMLInputElement | null;
        const userInput = container.querySelector('#pf-user') as HTMLInputElement | null;
        const passInput = container.querySelector('#pf-pass') as HTMLInputElement | null;
        if (!urlInput || !userInput || !passInput) return;
        const commandAuthMode = ((container.querySelector('input[name="pf-command-auth"]:checked') as HTMLInputElement | null)?.value
          ?? 'portal') as CommandAuthMode;
        const bmpUser = userInput.value || '';
        const bmpPass = passInput.value || '';
        const parsedUrl = parseServerUrl(urlInput.value || '');
        // Say why in place; no permission prompt can be asked for a value
        // that is not a web address.
        const errors: FieldErrors = {};
        if (!parsedUrl.ok) errors.url = parsedUrl.error;
        if (commandAuthMode === 'stored' && !bmpUser.trim()) errors.user = 'Enter the user name.';
        const keepsStored = !!this.editing.hasStoredPassword && !this.editing.clearPassword;
        if (commandAuthMode === 'stored' && !bmpPass && !keepsStored) errors.pass = 'Enter the password.';
        this.fieldErrors = errors;
        for (const key of ['url', 'user', 'pass'] as const) this.paintFieldError(container, key);
        if (!parsedUrl.ok || errors.user || errors.pass) {
          flashInvalid(errors.url ? urlInput : errors.user ? userInput : passInput);
          return;
        }
        const bmpUrl = parsedUrl.url;
        urlInput.value = bmpUrl;
        const label = (container.querySelector('#pf-label') as HTMLInputElement)?.value.trim() || workspaceLabelFor(bmpUrl) || 'Unnamed';
        const previous = this.editing.id
          ? shared.settings.profiles.find(p => p.id === this.editing?.id)
          : undefined;
        const profile: ServerProfile = {
          id: this.editing.id ?? crypto.randomUUID(),
          label,
          bmpUrl,
          bmpUser,
          bmpPass,
          commandAuthMode,
          commandAuthRevision: previous?.commandAuthRevision,
          // Empty password on an existing profile: keep the stored one,
          // unless the user removed it.
          ...(this.editing.clearPassword && !bmpPass ? { clearPassword: true } : {}),
        };
        // Ask for the server origin's host permission INSIDE this click — saving a server IS the
        // moment the extension needs its site, and the standard browser prompt requires the user
        // gesture. An already-granted origin resolves silently (no prompt), so re-saves are free.
        const origin = originPatternFor(bmpUrl);
        if (origin) void requestOriginsInGesture([origin]).then(() => this.refreshAccess());
        this.saveProfile(profile);
        this.editing = null;
        rerender();
        container.querySelector<HTMLElement>(`[data-fk="pick:${profile.id}"]`)?.focus();
      },
      'pf-cancel': () => {
        const id = this.editing?.id;
        this.editing = null;
        this.fieldErrors = {};
        rerender();
        container.querySelector<HTMLElement>(id ? `[data-fk="edit:${id}"]` : '[data-fk="add"]')?.focus();
      },
      'clear-cache': () => {
        this.send({ type: 'CLEAR_CACHE' });
        shared.cacheCount = 0;
        rerender();
      },
      'dismiss-auth-migration': (el) => {
        const profileId = el.dataset.profileId;
        if (!profileId) return;
        const notices = (shared.settings.commandAuthMigrationNotices ?? [])
          .filter(notice => notice.profileId !== profileId);
        shared.settings = { ...shared.settings, commandAuthMigrationNotices: notices };
        this.send({ type: 'SAVE_SETTINGS', settings: { commandAuthMigrationNotices: notices } });
        rerender();
      },
      'ai-save': () => {
        const provider = (container.querySelector('#ai-provider') as HTMLSelectElement | null)?.value as AiProviderId | undefined;
        const keyInput = container.querySelector('#ai-key') as HTMLInputElement | null;
        const apiKey = keyInput?.value ?? '';
        if (!provider) return;
        // Keys are provider-specific. Keep the encrypted key only while editing
        // the current provider; switching provider requires an explicit key.
        const needsProviderKey = !this.aiConfigured || provider !== shared.settings.ai?.provider;
        if (needsProviderKey && !apiKey.trim()) {
          if (keyInput) flashInvalid(keyInput);
          return;
        }
        this.aiTestStatus = null;
        if (provider === 'custom') {
          const textarea = container.querySelector('#ai-provider-json') as HTMLTextAreaElement | null;
          const draft: AiCustomDraft = {
            name: (container.querySelector('#ai-custom-name') as HTMLInputElement | null)?.value ?? '',
            apiType: (container.querySelector('#ai-custom-api-type') as HTMLSelectElement | null)?.value as AiApiType,
            baseUrl: (container.querySelector('#ai-custom-url') as HTMLInputElement | null)?.value ?? '',
            modelId: (container.querySelector('#ai-custom-model') as HTMLInputElement | null)?.value ?? '',
          };
          try {
            const json = mergeCustomProviderDraft(
              textarea?.value ?? this.aiJsonDraft ?? CUSTOM_PROVIDER_TEMPLATE,
              draft,
              apiKey,
            );
            const parsed = parseCustomProviderJson(json);
            if (!parsed.apiKey && shared.settings.ai?.provider !== 'custom') {
              throw new Error('Add an API key the first time you save this endpoint');
            }
            const model = parsed.provider.models.find(item => item.toolCalling)?.id
              ?? parsed.provider.models[0].id;
            const origin = resolveProvider({
              provider: 'custom',
              model,
              customProvider: parsed.provider,
            }).origin;
            // Do not repaint plaintext credentials back into the form while
            // the service worker encrypts them.
            this.aiJsonDraft = customProviderJson(parsed.provider);
            this.aiCustomDraft = draft;
            this.aiModelDraft = model;
            this.aiJsonError = null;
            this.aiJsonSaving = true;
            void requestOriginsInGesture([origin]).then((granted) => {
              if (!granted) {
                this.aiJsonError = 'Site access to the custom endpoint was declined';
                rerender();
              }
            });
            this.send({ type: 'AI_SAVE_CUSTOM_PROVIDER', json });
            rerender();
          } catch (e) {
            this.aiJsonError = e instanceof Error ? e.message : String(e);
            this.aiJsonOpen = true;
            this.aiJsonSaving = false;
            rerender();
          }
          return;
        }
        const model = (container.querySelector('#ai-model') as HTMLInputElement | null)?.value.trim();
        if (!model) return;
        // Request the provider API origin's host permission INSIDE this click —
        // the SW's cross-origin fetch needs it, and the browser prompt requires
        // a user gesture. Already-granted origins resolve silently; a denial
        // surfaces as an inline status so the user knows why calls will fail.
        const origin = PROVIDERS[provider].origin;
        void requestOriginsInGesture([origin]).then((granted) => {
          if (!granted) {
            this.aiTestStatus = { ok: false, text: 'Site access to the provider was declined' };
            const panel = getTabPanel('connect');
            if (panel && !this.editing) this.render(panel);
          }
        });
        this.send({ type: 'AI_SAVE_CONFIG', provider, model, ...(apiKey.trim() ? { apiKey } : {}) });
        this.aiModelDraft = model;
        this.aiProviderDraft = provider;
      },
      'ai-expand': () => { this.aiExpanded = !this.aiExpanded; this.aiTestStatus = null; rerender(); },
      'ai-replace': () => { this.aiReplacingKey = true; this.aiTestStatus = null; this.aiKeyDraft = ''; rerender(); },
      'ai-replace-cancel': () => { this.aiReplacingKey = false; this.aiKeyDraft = ''; rerender(); },
      'ai-remove': () => {
        void (async () => {
          const ok = await confirmModal({
            title: 'Remove AI key?',
            body: 'Clears the stored provider and API key. The AI assistant will disappear from the editor and studio.',
            confirmLabel: 'Remove',
            confirmVariant: 'danger',
          });
          if (!ok) return;
          this.aiProviderDraft = null;
          this.aiModelDraft = null;
          this.aiCustomDraft = null;
          this.aiKeyDraft = '';
          this.aiModelOptions = [];
          this.aiModelsLoading = false;
          this.aiModelMenuOpen = false;
          this.aiTestStatus = null;
          this.aiExpanded = false;
          this.send({ type: 'AI_REMOVE_CONFIG' });
        })();
      },
      'ai-test': () => {
        this.aiTesting = true;
        this.aiTestStatus = null;
        this.send({ type: 'AI_TEST' });
        rerender();
      },
      'ai-load-models': () => {
        if (this.aiModelsLoading) return;
        const provider = (this.aiProviderDraft ?? shared.settings.ai?.provider ?? 'anthropic');
        this.aiModelsLoading = true;
        this.send({ type: 'AI_LIST_MODELS', provider });
        rerender(); // show the "Loading…" state immediately (cleared on AI_MODELS_RESULT)
      },
      'ai-model-browse': () => { this.aiModelMenuOpen = !this.aiModelMenuOpen; rerender(); },
      'ai-model-pick': (el) => {
        const m = el.dataset.model;
        if (m) this.aiModelDraft = m;
        this.aiModelMenuOpen = false;
        rerender();
      },
      'reset-all': () => {
        void (async () => {
          const ok = await confirmModal({
            title: 'Reset all Companion state?',
            body: 'Clears the object cache, the badge names, the activity log, history, and per-tab context.\n\nFavorites + server profiles are kept. Use this when the extension is in a bad state.',
            confirmLabel: 'Reset',
            confirmVariant: 'danger',
          });
          if (!ok) return;
          // Optimistically clear local UI state so the user sees the reset
          // land immediately, before the SW round trip + downstream broadcasts.
          shared.cacheCount = 0;
          shared.context = null;
          shared.lastEcMs = null;
          this.send({ type: 'RESET_ALL' });
          rerender();
        })();
      },
    });
  }

  /** A tinted section band: title left, an optional control right. */
  private band(title: string, right: HTMLElement | null = null): HTMLElement {
    return h('div', { class: 'ui-band cx-band' }, h('span', { class: 't' }, title), h('span', { class: 'cx-sp' }), right);
  }

  /** A collapsed disclosure band around existing content. */
  private section(key: SectionKey, title: string, body: HTMLElement): HTMLElement {
    return h('details', { class: 'cx-sec', 'data-sec': key, open: this.openSections.has(key) },
      h('summary', { class: 'ui-band ui-disc cx-band', 'data-fk': `sec:${key}` },
        h('span', { class: 't' }, title),
        h('span', { class: 'cx-sp' }),
        icon('i-chev', 'ui-disc-chev'),
      ),
      body,
    );
  }

  /** Short help: the page-badge gestures and what each tab is for. */
  private renderHelp(): HTMLElement {
    const k = (text: string) => h('kbd', { class: 'cx-kbd' }, text);
    return h('details', { class: 'cx-help', 'data-sec': 'help', open: this.openSections.has('help') },
      h('summary', { class: 'cx-hrow', 'data-fk': 'sec:help' },
        icon('s-help'), h('span', null, 'Help'), h('span', { class: 'cx-sp' }), icon('i-chev', 'ic-sm cx-hc')),
      h('div', { class: 'cx-htext' },
        h('p', null, k('Click'), ' a page badge to copy its ID and make it current; ', k('Double-click'), ' opens it in the object window.'),
        h('p', null, k('Shift'), ' + click copies the RID, ', k('Alt'), ' + click the Instance ID, ', k('Ctrl'), ' / ', k('Cmd'), ' + click the Reference.'),
        h('p', null, 'On a focused badge: ', k(shortcutLabel('inspect.copy')), ' copies, ', k(shortcutLabel('inspect.card')), ' opens the details, ', k(shortcutLabel('inspect.open')), ' the object window; ', k(shortcutLabel('inspect.next')), ' / ', k(shortcutLabel('inspect.prev')), ' move between badges.'),
        h('p', null, 'Browse finds objects by name, ID or RID. Log lists your saves, runs and errors.'),
        h('p', null, 'Companion cannot see a site until you allow it, and gives the access back when you remove the server.'),
      ),
    );
  }

  /** No server yet: offer the front tab's site, then the two steps of site access. */
  private renderFirstRun(): HTMLElement[] {
    const url = this.frontUrl;
    const host = url ? new URL(url).host : null;
    // The mascot says hello once, above the steps (shared empty state).
    const out: HTMLElement[] = [
      emptyState({ title: 'No server yet', text: 'Add the BMP workspace you work on.', art: 'sm', className: 'cx-hello' }),
      this.band('Add a server'),
    ];
    const card = h('div', { class: 'cx-detect' });
    if (url) {
      card.append(h('div', { class: 'cx-drow' },
        icon('s-globe'),
        h('span', { class: 'cx-lbl' },
          h('span', { class: 'cx-nm' }, workspaceLabelFor(url) || host),
          h('span', { class: 'ui-id cx-host', title: url }, displayHost(url))),
        h('span', { class: 'cx-src' }, 'Open tab'),
      ));
    }
    if (this.firstRun.phase === 'waiting' && url) {
      card.append(
        h('div', { class: 'cx-steps', role: 'status' },
          h('div', { class: 'cx-stp done' }, icon('s-check', 'ic-sm'), h('span', null, 'Address ', h('span', { class: 'ui-id' }, displayHost(url)))),
          h('div', { class: 'cx-stp now' }, h('span', { class: 'cx-spin', 'aria-hidden': 'true' }), h('span', null, 'Waiting for your answer in the browser prompt')),
          h('div', { class: 'cx-stp' }, icon('s-dot', 'ic-sm'), h('span', null, 'Check the connection')),
        ),
        h('div', { class: 'cx-dact' },
          h('button', { class: 'ui-btn ghost cx-sm', type: 'button', 'data-action': 'first-cancel', 'data-fk': 'first-cancel' }, 'Cancel')),
      );
      out.push(card);
      return out;
    }
    if (!url) card.append(h('p', { class: 'cx-note' }, 'Open your BMP workspace in this window, or enter its address.'));
    if (this.firstRun.note) card.append(h('p', { class: 'cx-note', role: 'status' }, this.firstRun.note));
    card.append(h('div', { class: 'cx-dact' },
      url
        ? h('button', { class: 'ui-btn primary', type: 'button', 'data-action': 'add-this-site', 'data-fk': 'add-this-site' }, 'Add this site')
        : null,
      h('button', { class: url ? 'ui-btn ghost' : 'ui-btn primary', type: 'button', 'data-action': 'enter-address', 'data-fk': 'enter-address' },
        url ? 'Enter an address instead' : 'Enter an address'),
    ));
    out.push(card);
    out.push(this.band('What happens next'));
    out.push(h('ol', { class: 'cx-how' },
      h('li', null, h('span', { class: 'cx-n' }, '1'), h('span', null,
        'Companion cannot see any site until you allow it. Your browser asks once, for ',
        host ? h('span', { class: 'ui-id' }, host) : 'that site', ' only. Choose Allow.')),
      h('li', null, h('span', { class: 'cx-n' }, '2'), h('span', null, 'Companion checks the connection and signs in with your BMP session.')),
    ));
    return out;
  }

  /** In-place confirmation under a row; removing gives the site access back. */
  private renderRemoveConfirm(profile: ServerProfile): HTMLElement {
    return h('div', {
      class: 'cx-confirm', role: 'group', 'aria-label': `Remove ${profile.label}`,
      onKeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-action="remove-cancel"]')?.click();
      },
    },
      h('p', { class: 'cx-confirm-t' }, `Remove ${profile.label}?`),
      h('p', { class: 'cx-help1' }, 'Its saved login, cache, history and favorites are deleted, and Companion gives back its site access.'),
      h('div', { class: 'cx-fact' },
        h('button', { class: 'ui-btn cx-sm', type: 'button', 'data-action': 'remove-confirm', 'data-fk': 'remove-confirm' }, 'Remove'),
        h('button', { class: 'ui-btn ghost cx-sm', type: 'button', 'data-action': 'remove-cancel', 'data-fk': 'remove-cancel' }, 'Cancel'),
      ),
    );
  }

  /** Live connection status for the active profile's row. */
  private connectionRenderKey(): string {
    const s = shared.connState;
    return JSON.stringify({
      display: s.display,
      identities: s.identities,
      version: s.version,
      blueprintSupported: s.blueprintSupported,
      profileLabel: s.profileLabel,
      workspace: s.workspace,
      authError: s.authError,
      networkOffline: s.networkOffline,
      environment: s.environment,
    });
  }

  /** Validation/freshness/latency updates do not alter the row's structure.
   *  Patch the active row's dot in place so a quiet reconnect check cannot
   *  clear focus, selection, scroll position, or an unrelated draft. */
  private refreshConnectionMetadata(): void {
    const row = getTabPanel('connect')?.querySelector<HTMLElement>('.cx-row.cur');
    const id = row?.dataset.profileId;
    const profile = shared.settings.profiles.find(p => p.id === id);
    if (!row || !profile) return;
    const state = this.rowState(profile);
    const dot = row.querySelector<HTMLElement>('.cx-dot');
    if (dot) {
      dot.className = `cx-dot dot ${state.dot}`;
      dot.title = state.title;
    }
  }

  /** The active row's live title: the state sentence, when it was verified, and a running check. */
  private liveTitle(): string {
    const s = shared.connState;
    const copy = describeConnection(s);
    const bits: string[] = [copy.sentence];
    if (copy.detail) bits.push(copy.detail);
    if (s.display === 'connected' && s.verifiedAt) bits.push(`last verified ${new Date(s.verifiedAt).toLocaleTimeString()}`);
    if (s.validation === 'validating') bits.push('checking now');
    return bits.join(' · ');
  }

  /** What a server row shows: its dot, its right-hand state, and its words for a screen reader. */
  private rowState(profile: ServerProfile): {
    dot: DotTone; title: string;
    rs: { kind: 'none' | 'here' | 'grant' | 'password'; text: string; origin?: string };
  } {
    const isActive = profile.id === shared.settings.activeProfileId;
    const origin = originPatternFor(profile.bmpUrl);
    const noAccess = !!origin && this.accessByOrigin.get(origin) === false;
    const passwordNeeded = profile.commandAuthMode === 'stored' && !!profile.passwordUnreadable && !profile.bmpPass;
    const v = this.verdict?.profileId === profile.id ? this.verdict : null;

    let dot: DotTone = 'idle';
    let title = 'Not the server of this window';
    if (isActive) {
      dot = dotTone(describeConnection(shared.connState), shared.connState.display);
      title = this.liveTitle();
    } else if (noAccess || passwordNeeded) {
      dot = 'warn';
      title = noAccess ? 'Companion has no access to this site' : 'The saved password cannot be read in this browser';
    } else if (v && !v.pending && v.display) {
      // Only a real connection result colours another server's dot.
      dot = v.ok ? 'ok' : 'fail';
      title = v.text;
    }

    if (noAccess && origin) return { dot, title, rs: { kind: 'grant', text: 'Grant access', origin } };
    if (passwordNeeded && !isActive) return { dot, title, rs: { kind: 'password', text: 'Password needed' } };
    if (isActive) return { dot, title, rs: { kind: 'here', text: 'This window' } };
    return { dot, title, rs: { kind: 'none', text: '' } };
  }

  /** One server: state dot, name, host in muted mono, state or action, and
   *  edit / test / remove on hover and on keyboard focus. */
  private renderProfileRow(profile: ServerProfile): HTMLElement {
    const isActive = profile.id === shared.settings.activeProfileId;
    const stored = profile.commandAuthMode === 'stored';
    const mode = stored ? 'Stored login' : 'Browser login';
    const { dot, title, rs } = this.rowState(profile);

    let right: HTMLElement | null = null;
    switch (rs.kind) {
      case 'here': right = h('span', { class: 'cx-here' }, rs.text); break;
      case 'grant':
        right = h('button', {
          class: 'cx-lnk', type: 'button', 'data-action': 'grant-access', 'data-grant-origin': rs.origin ?? '',
          'data-fk': `grant:${profile.id}`, title: 'Allow Companion on this site (browser prompt)',
        }, rs.text);
        break;
      case 'password':
        right = h('button', {
          class: 'cx-lnk', type: 'button', 'data-action': 'edit-profile', 'data-profile-id': profile.id,
          'data-fk': `pw:${profile.id}`, title: 'Edit the server and enter the password again',
        }, rs.text);
        break;
      default: break;
    }

    const live = shared.connState.display === 'connected' ? 'connected' : describeConnection(shared.connState).label;
    const srState = [mode, rs.kind === 'here' ? 'this window' : '', isActive ? live : '']
      .filter(Boolean).join(', ');
    const act = (action: string, iconId: string, label: string, fk: string) => h('button', {
      class: 'ui-ibtn', type: 'button', 'data-action': action, 'data-profile-id': profile.id,
      'data-fk': `${fk}:${profile.id}`, title: label, 'aria-label': `${label} ${profile.label}`,
    }, icon(iconId));

    const row = h('div', {
      class: `cx-row ui-row${isActive ? ' cur' : ''}${this.editing?.id === profile.id ? ' editing' : ''}${this.removing === profile.id ? ' confirming' : ''}`,
      role: 'listitem',
      'data-profile-id': profile.id,
    },
      h('button', {
        class: 'cx-pick', type: 'button', 'data-action': 'select-profile', 'data-profile-id': profile.id,
        'data-fk': `pick:${profile.id}`,
        title: isActive ? `${profile.label} is the server of this window` : `Use ${profile.label} in this window`,
        ...(isActive ? { 'aria-current': 'true' } : {}),
      },
        h('span', { class: `cx-dot dot ${dot}`, title }),
        h('span', { class: 'cx-lbl' },
          h('span', { class: 'cx-nm' }, profile.label),
          h('span', { class: 'ui-id cx-host', title: profile.bmpUrl }, displayHost(profile.bmpUrl))),
        h('span', { class: 'sr-only' }, `, ${srState}`),
      ),
      right ? h('span', { class: 'cx-rs' }, right) : null,
      stored ? h('span', { class: 'cx-mode', title: mode, 'aria-hidden': 'true' }, icon('s-key', 'ic-sm')) : null,
      h('span', { class: 'cx-acts' },
        act('edit-profile', 'i-pencil', 'Edit', 'edit'),
        isActive ? act('test-profile', 's-pulse', 'Test connection', 'test') : null,
        act('remove-ask', 's-trash', 'Remove', 'remove'),
      ),
    );
    const notice = this.renderAuthMigrationNotice(profile);
    const verdict = this.renderVerdictLine(profile);
    if (verdict) {
      row.removeAttribute('role');
      return h('div', { class: 'cx-rowwrap', role: 'listitem' }, row, verdict, notice);
    }
    if (!notice) return row;
    row.removeAttribute('role');
    return h('div', { class: 'cx-rowwrap', role: 'listitem' }, row, notice);
  }

  /** The save or test result, on its own line under the row so the server's
   *  name and host stay whole. A success clears itself after a few seconds. */
  private renderVerdictLine(profile: ServerProfile): HTMLElement | null {
    const v = this.verdict?.profileId === profile.id ? this.verdict : null;
    if (!v) return null;
    if (!v.pending && v.ok) this.scheduleVerdictClear(v);
    const title = [v.text, v.detail].filter(Boolean).join('\n');
    if (v.pending) {
      return h('div', { class: 'cx-verdict pending' }, h('span', { class: 'cx-spin', 'aria-hidden': 'true' }), h('span', { class: 'cx-ell' }, v.text));
    }
    const line = h('div', { class: `cx-verdict ${v.ok ? 'ok' : 'err'}`, title },
      v.ok ? icon('s-check', 'ic-sm') : icon('s-xc', 'ic-sm'),
      h('span', { class: 'cx-verdict-t' }, v.text));
    if (this.verdictSeen !== v) {
      // Once per verdict, after the line is in the panel: bring it into view.
      this.verdictSeen = v;
      queueMicrotask(() => {
        if (line.isConnected && typeof line.scrollIntoView === 'function') line.scrollIntoView({ block: 'nearest' });
      });
    }
    return line;
  }

  private verdictSeen: ConnectTab['verdict'] = null;

  private verdictTimer: { verdict: NonNullable<ConnectTab['verdict']>; timer: ReturnType<typeof setTimeout> } | null = null;

  private scheduleVerdictClear(v: NonNullable<ConnectTab['verdict']>): void {
    if (this.verdictTimer?.verdict === v) return;
    if (this.verdictTimer) clearTimeout(this.verdictTimer.timer);
    const timer = setTimeout(() => {
      this.verdictTimer = null;
      if (this.verdict !== v) return;
      this.verdict = null;
      const panel = getTabPanel('connect');
      if (panel && shared.activeTab === 'connect' && !this.editing) this.render(panel);
    }, VERDICT_SHOW_MS);
    this.verdictTimer = { verdict: v, timer };
  }

  private renderAuthMigrationNotice(profile: ServerProfile): HTMLElement | null {
    const notice = shared.settings.commandAuthMigrationNotices?.find(item => item.profileId === profile.id);
    if (!notice) return null;
    return h('div', { class: 'prof-auth-migration', role: 'status' },
      h('span', null,
        `Configuration commands now use the stored login ${notice.user}. Your BMP page remains signed in as the browser user.`),
      h('button', {
        type: 'button',
        'data-action': 'dismiss-auth-migration',
        'data-profile-id': profile.id,
        title: 'Dismiss this migration notice',
      }, 'Dismiss'),
    );
  }

  /** Show or clear one field's inline error. */
  private paintFieldError(container: HTMLElement, key: keyof FieldErrors): void {
    const input = container.querySelector<HTMLInputElement>(`#pf-${key === 'url' ? 'url' : key}`);
    const msg = container.querySelector<HTMLElement>(`#pf-${key}-error`);
    const text = this.fieldErrors[key] ?? '';
    if (msg) msg.textContent = text;
    if (input) {
      if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }

  /** "Saving asks the browser for access to host" while that site is not granted yet. */
  private paintAccessHint(hint: HTMLElement, rawUrl: string): void {
    const parsed = parseServerUrl(rawUrl);
    const origin = parsed.ok ? originPatternFor(parsed.url) : null;
    const known = origin ? this.accessByOrigin.get(origin) : undefined;
    hint.replaceChildren();
    if (!parsed.ok || !origin || known === true) return;
    hint.append('Saving asks the browser for access to ', h('span', { class: 'ui-id' }, new URL(parsed.url).host));
  }

  /** A boolean setting as a label-left / toggle-right row — our control style,
   *  replacing the raw browser checkbox. The input keeps its id so the existing
   *  change listeners bind unchanged. */
  private settingRow(
    id: string,
    name: string,
    hint: string | null,
    checked: boolean,
    hintTitle?: string,
  ): HTMLElement {
    return h('label', { class: 'setting-row' },
      h('span', { class: 'setting-text' },
        h('span', { class: 'setting-name' }, name),
        hint
          ? h('span', { class: 'setting-hint', ...(hintTitle ? { title: hintTitle } : {}) }, hint)
          : null,
      ),
      h('span', { class: 'toggle' },
        h('input', { type: 'checkbox', class: 'toggle-input', id, checked }),
        h('span', { class: 'toggle-track', 'aria-hidden': 'true' }),
      ),
    );
  }

  /** AI assistant — a server-row-twin row (collapsed) that expands the config
   *  form. The assistant only appears in the editor / studio once a key is
   *  stored. Card shows READY / UNTESTED + last-test latency; the row / Edit /
   *  Set up expands the existing provider / model / key / test form. */
  private renderAiSection(): HTMLElement {
    const wrap = h('div', { class: 'ai-settings' }, this.renderAiCard());
    if (this.aiExpanded) wrap.appendChild(this.renderAiForm());
    return wrap;
  }

  /** The collapsed row: one health dot, name + provider/model metadata, and
   *  right-side latency + Edit / Set up. */
  private renderAiCard(): HTMLElement {
    const stored = shared.settings.ai;
    const configured = this.aiConfigured;
    const lastTest = stored?.lastTest;
    const verified = configured && !!lastTest?.ok;
    const providerLabel = stored
      ? (stored.provider === 'custom' ? stored.customProvider?.name ?? 'Custom' : PROVIDERS[stored.provider].label)
      : '';
    const model = stored?.model ?? '';


    const ln2 = configured
      ? `${providerLabel} · ${model} · key saved`
      : 'Not set up. Bring your own API key.';

    const state = h('div', { class: 'ai-card-state connect-card-state' });
    const right = h('div', { class: 'ai-card-right connect-card-right' }, state);
    if (configured) {
      if (verified) {
        state.appendChild(h('span', { class: 'ai-card-latency' }, lastTest ? `${lastTest.ms} ms` : ''));
      }
      right.appendChild(h('button', {
        class: 'ui-ibtn ai-card-edit connect-card-edit', type: 'button', 'data-action': 'ai-expand',
        title: this.aiExpanded ? 'Close' : 'Edit AI settings',
        'aria-label': this.aiExpanded ? 'Close AI settings' : 'Edit AI settings',
      }, svg(this.aiExpanded ? ICON_X : ICON_PENCIL)));
    } else {
      state.remove();
      right.classList.add('ai-card-right--setup');
      right.appendChild(h('button', {
        class: 'ui-btn cx-sm',
        type: 'button',
        'data-action': 'ai-expand',
        title: this.aiExpanded ? 'Close AI settings' : 'Set up the AI assistant',
      }, this.aiExpanded ? 'Close' : 'Set up'));
    }

    const health = verified ? 'ready' : (lastTest && !lastTest.ok ? 'error' : 'idle');
    const healthLabel = verified
      ? 'AI connection verified'
      : health === 'error' ? 'Last AI connection test failed'
        : configured ? 'AI connection not tested' : 'AI assistant not configured';

    return h('div', {
      class: `ai-card ${health}${this.aiExpanded ? ' expanded' : ''}`,
      title: configured ? 'AI assistant settings' : 'Set up the AI assistant',
    },
      h('span', { class: `ai-card-health ${health}`, title: healthLabel, 'aria-label': healthLabel }),
      h('div', { class: 'ai-card-meta' }, h('div', { class: 'ai-card-ln2', title: ln2 }, ln2)),
      right,
    );
  }

  /** Expanded provider configuration. Built-ins use model + key; selecting
   *  Custom reveals approachable endpoint fields and optional advanced JSON. */
  private renderAiForm(): HTMLElement {
    const stored = shared.settings.ai;
    const provider: AiProviderId = this.aiProviderDraft ?? stored?.provider ?? 'anthropic';
    const custom = stored?.customProvider;
    const customDraft = this.aiCustomDraft ?? customDraftFromProvider(custom);
    const model = provider === 'custom'
      ? customDraft.modelId
      : this.aiModelDraft ?? stored?.model ?? PROVIDERS[provider].defaultModel;
    const meta = provider === 'custom' ? null : PROVIDERS[provider];
    const providerChanged = provider !== stored?.provider;
    const showKeyInput = !this.aiConfigured || this.aiReplacingKey || providerChanged;

    const providerSelect = h('select', { class: 'field-input ai-select', id: 'ai-provider' },
      ...([...AI_PROVIDER_IDS, 'custom' as const]).map(id => h('option', {
        value: id,
        ...(id === provider ? { selected: 'selected' } : {}),
      }, id === 'custom' ? 'Custom endpoint…' : PROVIDERS[id].label)),
    );
    (providerSelect as HTMLSelectElement).value = provider;

    // Model list — provider suggestions plus any live-loaded ids. A native <datalist> FILTERS its
    // options by the input's current value, so once a model is typed you can't see the others; this
    // custom menu (toggled by the caret) always lists them ALL, unfiltered.
    const modelOptions = meta ? [...new Set([...meta.suggestedModels, ...this.aiModelOptions])] : [];
    const modelMenu = (this.aiModelMenuOpen && modelOptions.length)
      ? h('div', { class: 'ai-model-menu' },
          ...modelOptions.map(m => {
            return h('button', {
              class: 'ai-model-opt' + (m === model ? ' sel' : ''), type: 'button',
              'data-action': 'ai-model-pick', 'data-model': m,
            },
              m,
            );
          }))
      : null;

    const statusEl = this.aiTestStatus
      ? h('span', { class: `ai-conn-status ${this.aiTestStatus.ok ? 'ok' : 'err'}` }, this.aiTestStatus.text)
      : this.aiTesting
        ? h('span', { class: 'ai-conn-status' }, 'Testing…')
        : null;

    const keyRow = showKeyInput
      ? h('div', { class: 'field-group' },
          h('label', { class: 'field-label' }, this.aiConfigured ? 'New API key' : 'API key'),
          h('div', { class: 'field-row ai-key-row' },
            h('input', { class: 'field-input', id: 'ai-key', type: 'password', placeholder: 'paste key', autocomplete: 'off', value: this.aiKeyDraft }),
            this.aiReplacingKey ? h('button', { class: 'btn btn-small', 'data-action': 'ai-replace-cancel' }, 'Cancel') : null,
          ),
          h('span', { class: 'field-hint' }, 'Stored encrypted on this device. Sent only to the provider you choose.'),
        )
      : h('div', { class: 'field-group' },
          h('label', { class: 'field-label' }, 'API key'),
          h('div', { class: 'field-row ai-key-row' },
            h('span', { class: 'ai-key-saved' }, '•••••••••••• saved'),
            h('button', { class: 'btn btn-small', 'data-action': 'ai-replace' }, 'Replace'),
            h('button', { class: 'btn btn-danger btn-small', 'data-action': 'ai-remove' }, 'Remove'),
          ),
        );

    const customFields = provider === 'custom'
      ? h('div', { class: 'ai-custom-fields' },
          h('div', { class: 'ai-custom-intro' },
            h('span', { class: 'field-hint' }, 'Connect one OpenAI- or Anthropic-compatible endpoint.'),
            h('button', {
              class: 'btn-micro help-btn ai-custom-help',
              type: 'button',
              'aria-label': 'Custom endpoint help',
              'aria-expanded': this.aiJsonHelpOpen ? 'true' : 'false',
              'aria-controls': 'ai-provider-json-help',
              onClick: (event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                this.aiJsonHelpOpen = !this.aiJsonHelpOpen;
                const button = event.currentTarget as HTMLButtonElement;
                button.setAttribute('aria-expanded', this.aiJsonHelpOpen ? 'true' : 'false');
                const help = button.closest('.ai-custom-fields')?.querySelector<HTMLElement>('#ai-provider-json-help');
                if (help) help.hidden = !this.aiJsonHelpOpen;
              },
            }, '?'),
          ),
          h('div', {
            class: 'ai-json-help-text',
            id: 'ai-provider-json-help',
            hidden: !this.aiJsonHelpOpen,
          },
            h('p', {}, 'Choose the request format the endpoint implements. The base URL should stop before ', h('code', {}, '/chat/completions'), ' or ', h('code', {}, '/v1/messages'), '.'),
            h('p', {}, 'Advanced JSON supports additional models, vision limits and token-parameter overrides.'),
          ),
          h('div', { class: 'ai-custom-grid' },
            h('div', { class: 'field-group' },
              h('label', { class: 'field-label', for: 'ai-custom-name' }, 'Name'),
              h('input', { class: 'field-input', id: 'ai-custom-name', value: customDraft.name, placeholder: 'Company Gateway' }),
            ),
            h('div', { class: 'field-group' },
              h('label', { class: 'field-label', for: 'ai-custom-api-type' }, 'API format'),
              h('select', { class: 'field-input', id: 'ai-custom-api-type' },
                h('option', { value: 'openai', ...(customDraft.apiType === 'openai' ? { selected: 'selected' } : {}) }, 'OpenAI compatible'),
                h('option', { value: 'anthropic', ...(customDraft.apiType === 'anthropic' ? { selected: 'selected' } : {}) }, 'Anthropic compatible'),
              ),
            ),
          ),
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label', for: 'ai-custom-url' }, 'Base URL'),
            h('input', { class: 'field-input', id: 'ai-custom-url', value: customDraft.baseUrl, placeholder: 'https://api.example.com/v1', 'aria-describedby': 'ai-custom-url-warn' }),
            h('span', { class: 'field-hint field-hint--security', id: 'ai-custom-url-warn' },
              isPlainTextAiAddress(customDraft.baseUrl) ? [svg(ICON_WARNING), ` ${PLAIN_TEXT_AI_ADDRESS_WARNING}`] : '',
            ),
          ),
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label', for: 'ai-custom-model' }, 'Model ID'),
            h('input', { class: 'field-input', id: 'ai-custom-model', value: customDraft.modelId, placeholder: 'model-name' }),
          ),
          h('details', { class: 'ai-json', ...(this.aiJsonOpen ? { open: true } : {}) },
            h('summary', {}, 'Advanced provider JSON'),
            h('textarea', {
              class: 'field-input ai-json-input',
              id: 'ai-provider-json',
              spellcheck: 'false',
              value: this.aiJsonDraft ?? customProviderJson(custom),
            }),
            this.aiJsonError ? h('div', { class: 'ai-json-error', role: 'alert' }, this.aiJsonError) : null,
            h('span', { class: 'field-hint ai-json-note' }, 'Extra models and capabilities are preserved when you save the fields above.'),
          ),
        )
      : null;

    return h('div', { class: 'ai-form' },
      h('div', { class: 'field-group' },
        h('label', { class: 'field-label' }, 'Provider'),
        providerSelect,
        h('span', { class: 'field-hint' }, 'Messages and attached BMP context are sent directly to this provider.'),
      ),
      customFields,
      meta
        ? h('div', { class: 'field-group' },
            h('label', { class: 'field-label' }, 'Model'),
            h('div', { class: 'field-row ai-key-row' },
              h('div', { class: 'ai-model-combo' },
                h('input', { class: 'field-input', id: 'ai-model', value: model, autocomplete: 'off', placeholder: meta.defaultModel }),
                modelOptions.length
                  ? h('button', { class: 'ai-model-caret' + (this.aiModelMenuOpen ? ' open' : ''), type: 'button', 'data-action': 'ai-model-browse', title: 'Browse all models', 'aria-label': 'Browse all models' }, svg(ICON_CHEVRON))
                  : null,
                modelMenu,
              ),
              meta.openAiCompat
                ? h('button', { class: 'footer-action', 'data-action': 'ai-load-models', title: 'Load the provider model list', ...(this.aiModelsLoading ? { disabled: 'disabled' } : {}) }, this.aiModelsLoading ? 'Loading…' : 'Load list')
                : null,
            ),
          )
        : null,
      keyRow,
      h('div', { class: 'field-row ai-conn-row' },
        h('button', {
          class: 'btn btn-accent btn-small',
          'data-action': 'ai-save',
          ...(this.aiJsonSaving ? { disabled: true } : {}),
        }, this.aiJsonSaving ? 'Saving…' : 'Save configuration'),
        this.aiConfigured
          ? h('button', { class: 'footer-action', 'data-action': 'ai-test' }, 'Test connection')
          : null,
        statusEl,
      ),
    );
  }

  /** Local extension state is a Preferences row; the fixed status bar already
   *  owns the always-visible object count. */
  private renderLocalData(): HTMLElement {
    const storage = shared.cacheCount === 0
      ? 'No cached objects stored'
      : this.cacheBytes != null && this.cacheBytes > 0
        ? `${formatBytes(this.cacheBytes)} stored in this browser`
        : 'Stored in this browser';
    return h('div', { class: 'connect-local-data', role: 'group', 'aria-label': 'Local inspection data' },
      h('span', { class: 'setting-text' },
        h('span', { class: 'setting-name' }, 'Local inspection data'),
        h('span', {
          class: 'setting-hint',
          title: this.cacheBytes != null ? `${this.cacheBytes.toLocaleString()} bytes of ~10 MB quota` : '',
        }, storage),
      ),
      h('span', { class: 'connect-local-actions' },
        h('button', {
          class: 'ui-tbtn',
          type: 'button',
          'data-action': 'clear-cache',
          // Also deletes the local code copies, which the object count does not show.
          title: `Clear ${shared.cacheCount} cached objects and the local code copies (keeps activity log, favorites, settings)`,
        }, 'Clear cached objects'),
        h('button', {
          class: 'ui-tbtn',
          type: 'button',
          'data-action': 'reset-all',
          title: 'Reset the object cache, badge names, activity log, context, and history. Favorites and server profiles are kept.',
        }, 'Reset Companion…'),
      ),
    );
  }

  /** Current/up-to-date is deliberately absent. The slot becomes visible only
   *  when the background check finds something the user can act on. */
  private renderUpdateBanner(): HTMLElement {
    const s = this.updateStatus;
    const panel = h('div', { class: 'connect-update-slot' });
    if (s?.isUpdate && s.latest) {
      panel.appendChild(h('a', {
        class: 'connect-update-notice',
        href: s.releasesUrl ?? 'https://github.com/HeinemannT/configuration-companion/releases',
        target: '_blank',
        rel: 'noopener',
        title: s.checkedAt ? `Last checked ${new Date(s.checkedAt).toLocaleString()}` : 'View release',
      },
        h('span', null, `Configuration Companion v${s.latest} is available`),
        h('span', { class: 'connect-update-action' }, 'View release →'),
      ));
    }
    this.updatePanel = panel;
    return panel;
  }

  /** The browser commands, from the shortcut registry (lib/shortcuts.ts),
   *  showing the user's actual Chrome bindings rather than merely the
   *  manifest defaults. The keys inside each window are on its `?` sheet. */
  private renderKeyboardShortcuts(): HTMLElement {
    const rows = shortcutsInScope('browser').map(id => {
      const def = shortcutDef(id);
      return { action: def.label, command: def.command ?? '', defaultKey: shortcutLabel(id) };
    });
    return h('div', { class: 'connect-shortcuts' },
      h('dl', { class: 'connect-shortcut-list' },
        ...rows.flatMap(row => [
          h('dt', null, row.action),
          h('dd', null, this.renderLiveShortcut(row.command, row.defaultKey)),
        ]),
      ),
      h('p', { class: 'connect-shortcut-sheet' },
        h('span', null, `Press ${shortcutLabel('sheet.open')} in any Companion window for its own keys. `),
        h('button', {
          class: 'ui-tbtn', type: 'button', 'aria-haspopup': 'dialog',
          onClick: () => { openCheatSheet({ window: 'sidepanel', title: 'Side panel: keyboard shortcuts' }); },
        }, 'Show the side panel keys'),
      ),
      h('div', { class: 'connect-shortcut-tip' },
        h('span', null, 'Open in the address bar: '),
        h('code', null, 'chrome://extensions/shortcuts'),
        h('button', {
          class: 'ui-ibtn ui-ibtn-sm', type: 'button', title: 'Copy the address', 'aria-label': 'Copy the address',
          onClick: () => { void copyText('chrome://extensions/shortcuts').then(ok => statusFlash(ok ? 'Copied' : 'Copy failed')); },
        }, icon('i-copy')),
      ),
    );
  }

﻿

  /** Render a single command's live binding — actually-set key bold, default
   *  greyed underneath when different/unset. Updated asynchronously by
   *  loadCommandShortcuts() on activate(). */
  private renderLiveShortcut(command: string, defaultKey: string): HTMLElement {
    const wrap = h('div', { class: 'kbd-stack' });
    if (!this.shortcutsLoaded) {
      // Pre-load: show the default as a hint without claiming the user
      // hasn't bound it. The render() pass that follows loadCommandShortcuts
      // will swap in the authoritative value.
      wrap.appendChild(defaultKey ? h('kbd', { class: 'kbd kbd--pending' }, defaultKey) : h('span', { class: 'kbd-unbound' }, 'Not set'));
      return wrap;
    }
    const liveKey = this.commandShortcuts.get(command);
    if (liveKey) {
      wrap.appendChild(h('kbd', { class: 'kbd' }, liveKey));
      if (liveKey !== defaultKey) wrap.title = defaultKey ? `Default: ${defaultKey}` : 'No default key';
    } else {
      // Binding cleared — show the default greyed so the user knows what
      // it WOULD be and can re-set it via chrome://extensions/shortcuts.
      wrap.appendChild(h('span', { class: 'kbd-unbound', title: defaultKey ? `Default: ${defaultKey}` : 'No default key: set one at chrome://extensions/shortcuts' }, 'Not set'));
    }
    return wrap;
  }

  /** The edit form, in place under its row (or under the band for a new server). */
  private renderProfileForm(_rerender: () => void): HTMLElement {
    if (!this.editing) return h('div');
    const ep = this.editing;
    const stored = ep.commandAuthMode === 'stored';
    const unreadable = !!ep.id && !!shared.settings.profiles.find(p => p.id === ep.id)?.passwordUnreadable;
    const err = this.fieldErrors;
    const errorLine = (key: keyof FieldErrors) => h('span', { class: 'cx-err', id: `pf-${key}-error`, role: 'alert' }, err[key] ?? '');
    const invalid = (key: keyof FieldErrors) => (err[key] ? { 'aria-invalid': 'true' } : {});

    const keepsStored = !!ep.hasStoredPassword && !ep.clearPassword;
    const passInput = h('input', {
      class: 'ui-input cx-in', id: 'pf-pass', type: 'password', value: ep.bmpPass,
      ...(keepsStored ? { placeholder: 'Stored (leave empty to keep it)' } : {}),
      autocomplete: 'current-password', 'aria-describedby': 'pf-pass-error pf-pass-stored', ...invalid('pass'),
    }) as HTMLInputElement;
    // The stored password never reaches the panel. Say that one exists and
    // offer to remove it.
    const storedText = h('span', null, '');
    const removeBtn = h('button', { type: 'button', class: 'ui-btn ghost ui-btn-sm', 'data-fk': 'pf-pass-remove' }, '') as HTMLButtonElement;
    const paintStored = () => {
      storedText.textContent = ep.clearPassword ? 'The stored password will be removed when you save. ' : 'A password is stored. ';
      removeBtn.textContent = ep.clearPassword ? 'Keep it' : 'Remove stored password';
      passInput.placeholder = ep.clearPassword ? '' : 'Stored (leave empty to keep it)';
    };
    // In place: the user's other typed values stay as they are.
    removeBtn.addEventListener('click', () => { ep.clearPassword = !ep.clearPassword; paintStored(); });
    const storedNote = ep.hasStoredPassword
      ? h('span', { class: 'cx-hint', id: 'pf-pass-stored' }, storedText, removeBtn)
      : h('span', { id: 'pf-pass-stored' });
    if (ep.hasStoredPassword) paintStored();
    const passToggle = h('button', {
      type: 'button', class: 'ui-ibtn ui-ibtn-sm pass-toggle', title: 'Show password', 'aria-label': 'Show password', 'aria-pressed': 'false',
      onClick: () => {
        const show = passInput.type === 'password';
        passInput.type = show ? 'text' : 'password';
        passToggle.setAttribute('aria-pressed', String(show));
        passToggle.title = show ? 'Hide password' : 'Show password';
        passToggle.setAttribute('aria-label', passToggle.title);
      },
    }, icon('s-eye', 'ic-sm'));

    const option = (value: CommandAuthMode, name: string, hint: string) => h('label', { class: `command-auth-option${(value === 'stored') === stored ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'pf-command-auth', value, checked: (value === 'stored') === stored }),
      h('span', { class: 'command-auth-copy' }, h('strong', null, name), h('span', null, hint)),
    );
    const commandMode = h('div', {
      class: 'command-auth-options',
      role: 'radiogroup',
      'aria-labelledby': 'pf-mode-label',
    },
      option('portal', 'Use browser login', 'Commands run as the user signed into this BMP page. Supports SSO.'),
      option('stored', 'Use stored configuration login', 'Commands run as this account without changing the BMP page user.'),
    );

    const hint = h('span', { class: 'cx-hint', id: 'pf-access-hint' });
    this.paintAccessHint(hint, ep.bmpUrl);

    const card = h('div', { class: 'cx-form profile-form', role: 'group', 'aria-label': ep.id ? `Edit ${ep.label}` : 'New server' },
      h('label', { class: 'cx-fl' }, 'Name',
        h('input', { class: 'ui-input cx-in', id: 'pf-label', value: ep.label, placeholder: 'e.g. Production', autocomplete: 'off' })),
      h('label', { class: 'cx-fl' }, 'Address',
        h('input', {
          class: 'ui-input cx-in mono', id: 'pf-url', value: /^https:\/\//i.test(ep.bmpUrl) ? displayHost(ep.bmpUrl) : ep.bmpUrl, placeholder: 'host/Workspace',
          autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'pf-url-error pf-url-warn', ...invalid('url'),
        }),
        errorLine('url'),
        // HTTP downgrade hint: advisory, never blocks save. Some intranet BMP
        // servers only listen on http.
        h('span', { class: 'cx-warnline field-hint--security', id: 'pf-url-warn' },
          stored && isInsecureUrl(ep.bmpUrl)
            ? [svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.']
            : '',
        ),
      ),
      h('div', { class: 'cx-fl command-auth-group' },
        h('span', { id: 'pf-mode-label' }, 'Configuration commands'),
        commandMode,
      ),
      h('div', { class: 'cx-two command-auth-credentials', hidden: !stored },
        h('label', { class: 'cx-fl' }, 'Username',
          h('input', { class: 'ui-input cx-in', id: 'pf-user', value: ep.bmpUser, autocomplete: 'username', 'aria-describedby': 'pf-user-error', ...invalid('user') }),
          errorLine('user')),
        h('label', { class: 'cx-fl' }, unreadable ? 'Password (enter it again)' : 'Password',
          h('span', { class: 'cx-pw' }, passInput, passToggle),
          storedNote,
          errorLine('pass')),
      ),
      h('span', { class: 'cx-help1 command-auth-credentials-note', hidden: !stored },
        'The BMP page, workspace search, live CVO data, and downloads remain signed in as your browser user.'),
      h('div', { class: 'cx-fact' },
        h('button', { class: 'ui-btn primary', type: 'button', 'data-action': 'pf-save', 'data-fk': 'pf-save' }, 'Save'),
        h('button', { class: 'ui-btn ghost', type: 'button', 'data-action': 'pf-cancel', 'data-fk': 'pf-cancel' }, 'Cancel'),
        h('span', { class: 'cx-sp' }),
        hint,
      ),
    );
    // Enter in a field saves, Escape cancels.
    card.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Enter' && t instanceof HTMLInputElement && t.type !== 'radio') {
        e.preventDefault();
        card.querySelector<HTMLElement>('[data-action="pf-save"]')?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        card.querySelector<HTMLElement>('[data-action="pf-cancel"]')?.click();
      }
    });
    commandMode.querySelectorAll<HTMLInputElement>('input[name="pf-command-auth"]').forEach(input => {
      input.addEventListener('change', () => {
        const useStored = input.value === 'stored';
        if (this.editing) this.editing.commandAuthMode = useStored ? 'stored' : 'portal';
        card.querySelectorAll<HTMLElement>('.command-auth-credentials, .command-auth-credentials-note')
          .forEach(el => { el.hidden = !useStored; });
        commandMode.querySelectorAll('.command-auth-option').forEach(o => o.classList.remove('selected'));
        input.closest('.command-auth-option')?.classList.add('selected');
        const warning = card.querySelector('#pf-url-warn');
        const url = (card.querySelector('#pf-url') as HTMLInputElement | null)?.value ?? '';
        if (warning) {
          warning.textContent = '';
          if (useStored && isInsecureUrl(url)) {
            warning.append(svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.');
          }
        }
      });
    });
    return card;
  }
}

function flashInvalid(input: HTMLElement) {
  input.classList.add('field-input--invalid');
  setTimeout(() => { input.classList.remove('field-input--invalid'); }, FLASH_INVALID_DURATION);
  input.focus();
}

/** True when the URL has an explicit `http://` scheme. Bare hostnames are
 *  treated as safe — normalizeUrl() upgrades them to https:// before any
 *  request goes out, so the warning shouldn't fire for "example.com". Only
 *  when the user explicitly downgrades. Exported for tests. */
export function isInsecureUrl(raw: string): boolean {
  return /^\s*http:\/\//i.test(raw);
}

/** Human-readable bytes formatter. Used by the connect-tab cache size hint
 *  next to "N cached". Resolves at 1 KB / 1 MB boundaries (binary-ish KiB
 *  rather than decimal — close enough for the user's mental model). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
