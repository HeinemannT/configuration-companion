/**
 * Studio — privileged page (mounted as an in-page overlay iframe, same
 * path as the EC editor). A mode-driven shell (see studio-mode.ts): the CVO
 * mode owns the sandbox relay + `_data` machinery; the TextElement mode edits
 * the two HTML bodies with a static preview. Everything below branches on the
 * mode's capabilities, never on the object type directly.
 *
 * Keystone scope (Phase 1): open a CustomVisualization's html + javascript as
 * files, edit with real syntax, and see it render live in the sandbox against a
 * MOCK `_data`, with console + thrown errors surfaced. Build-on-edit + a manual
 * Run, show/hide preview, and Save/Discard of the active code field through the
 * existing SAVE_PROPERTY handler. Live `_data`, editable children, and the
 * dependency/resource panels arrive in later phases.
 *
 * The CodeMirror wiring here is intentionally minimal — when the shared
 * code-surface engine is extracted (against this studio + the EC editor), this
 * file adopts it and the local createEditor goes away.
 */
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { lintGutter } from '@codemirror/lint'
import { indentUnit } from '@codemirror/language'
import { baseEditingExtensions, baseKeymapBindings, languageExtension, codeTheme, type CodeLang } from '../editor-core/cm-scaffold'
import { CodeSurface, isProgrammaticSwap } from '../editor-core/code-surface'
import { ariaKeyShortcuts, cmBindings, shortcutLabel, withShortcut } from '../lib/shortcuts'
import { installCheatSheetKey, toggleCheatSheet } from '../lib/cheat-sheet'
import { closeOverlayKeyBinding, installDirtyGuards, installWindowEscape } from '../editor-core/overlay'
import { detectFileResourceRids, detectCdnUrls } from './dep-detect'
import { h, svg, render as renderDom } from '../lib/dom'
import { typeBadge, wireBadgeCopy } from '../lib/type-badge';
import { objectChip } from '../lib/object-chip'
import { sendRequest, sendFireForget } from '../lib/messaging'
import { openObject } from '../lib/open-object'
import { describeFailure } from '../lib/connection-copy'
import { failureBlock } from '../lib/failure-form'
import { choiceModal, confirmCommandModal, confirmModal } from '../lib/modal'
import { conflictBody, conflictChoices, conflictTitle, runCodeSave } from '../editor-core/code-save'
import { CHANGED_IN_BMP, MAY_HAVE_SAVED, storedDiffersLine, unknownOutcomeLine } from '../lib/save-check'
import { childSaveRequest, type ChildFields } from './child-save'
import { type StudioChild, type StudioChildType, type InspectorMessage } from '../lib/types'
import { ICON_PLAY, ICON_REFRESH, ICON_CHECK, ICON_X, ICON_WARNING, ICON_WRAP, ICON_BRACKETS, ICON_SPARKLE, ICON_REVERT, ICON_TRAY_ARROW_DOWN } from '../lib/icons'
import { fetchAiConfig } from '../editor-core/ai-config'
import type { AiAssist } from '../editor-core/ai-assist'
import type { AiLang, AiObjectContext, AiContextSource } from '../lib/ai/types'
import { STUDIO_CTX_PREFIX, type StudioContext, type StudioCodeProp } from '../lib/studio-types'
import { STUDIO_MODES, type StudioMode, type StudioFile } from '../lib/studio-mode'
import { type CvoRenderRequest, type CvoConsoleLevel, type CvoLib } from './cvo-protocol'
import { PreviewHost, formatCvoError } from './preview-host'
import { dataModeSwitch, type PreviewDataMode } from './preview-data-mode'
import { StudioConsole } from './studio-console'
import { syntaxErrorLinter, makeCvoApiSource } from './studio-editor-ext'
import { formatCode } from './studio-format'
import { studioSheet, showStudioPanelHelp } from './studio-help'
import { makeDataHover } from './data-hover'
import { watchWindowEnvironment } from '../lib/window-environment'
import { copyTextResult, copyFailureMessage } from '../lib/copy-feedback'

const PREVIEW_DEBOUNCE_MS = 400

// ── State ────────────────────────────────────────────────────────
let ctx: StudioContext | null = null
/** Studio's code came from one server: a page now on another is said in a
 *  banner (the worker refuses every write for another server). */
watchWindowEnvironment(() => ctx?.environment || undefined)
/** The active mode — set once in init() from ctx.mode; every capability
 *  branch below reads this, never the object type. */
let mode: StudioMode = STUDIO_MODES.cvo
const codeProps = (): readonly StudioCodeProp[] => mode.files.map(f => f.prop)
const fileFor = (prop: StudioCodeProp): StudioFile =>
  mode.files.find(f => f.prop === prop) ?? mode.files[0]
/** Shared multi-slot editing engine (html + javascript slots). Owns the view,
 *  per-slot dirty, stash/restore, and save/discard baselines. */
let surface: CodeSurface | null = null
let activeProp: StudioCodeProp = 'html' // re-seeded in init() from the mode
/** AI assistant — built in init() only when a provider key is configured.
 *  Null ⇒ nothing AI renders (zero-footprint rule). */
let aiAssist: AiAssist | null = null
let aiConfigured = false
// Pane layout: editor only / both / preview only — one control, one enum
// (replaces the old show-preview + maximize booleans). 'code' has no preview
// pane (so toggling to/from it rebuilds the shell + remounts the iframe);
// 'split' <-> 'preview' just shows/hides the editor pane in place.
type Layout = 'code' | 'split' | 'preview'
let layout: Layout = 'split'
const previewPresent = () => layout !== 'code'
// In-flight lock for doSave — prevents a second Cmd+S/click from stacking a
// confirm dialog or a duplicate save while the round-trips are awaited.
let saving = false
// Timestamp of the last successful save; drives the brief "Saved" pulse on the
// Save button (mirrors the EC editor).
let lastSavedAt = 0
const SAVED_FLASH_MS = 4000

// Preview data source. 'mock' uses the local mockData; 'live' fetches the real
// `_data` from BMP's data servlet for renderContextRid (org-rooted). liveData
// caches the last successful fetch; liveError holds the last failure (e.g. the
// org-gating 400) for display. Every studio window starts on mock data and is
// never switched to live except by the user choosing Live in the strip; the
// choice is not stored.
let dataMode: PreviewDataMode = 'mock'
let renderContextRid = ''       // the resolved rid the servlet needs
let renderContextRef = ''       // what the configurator typed (a business id or a rid)
let renderCtxLabel = ''         // resolved "id · name" for display, '' until resolved
let liveData: Record<string, unknown> | null = null
let liveError: string | null = null
// Generation token for fetchLiveData — two rapid fetches (rid edit while a
// refresh is in flight) must not let the slower-resolving (older) one win.
let fetchGen = 0

// The CVO's data-input children (CustomVisualizationExpression). Each defines a
// `_data.expressions[key]` slot; editable here. Seeded into mockData so the mock
// preview carries the real slot keys.
let children: StudioChild[] = []

// Hosted FileResource libraries the CVO depends on, cached by rid (null =
// fetched but unavailable). lastLibs is the resolved set passed to the sandbox.
const libCache = new Map<string, string | null>()

// Dependency rid -> {id, name} for the Deps panel, so configurators see the
// business id/name not a bare rid. Empty id = resolved-but-not-found (don't refetch).
const refCache = new Map<string, { id: string; name: string }>()
let lastLibs: CvoLib[] = []

// The bottom panel is a single toggleable area with three tabs; null = collapsed
// so the canvas owns the preview pane. Auto-opens to 'console' on a CVO error.
type PanelTab = 'console' | 'inputs' | 'deps'
let panelTab: PanelTab | null = null
/** Static (inert) modes: the persistent srcdoc preview iframe, created once and
 *  re-attached across shell re-renders. */
let staticFrame: HTMLIFrameElement | null = null
/** CVO mode: a new sandbox frame per render, connected by a MessagePort (see
 *  preview-host.ts). Created on first use. */
let previewHost: PreviewHost | null = null

// Preview width for breakpoint testing (0 = full). The CVO re-renders at the
// chosen width, since container width changes how a responsive CVO lays out.
let previewWidth = 0
const PREVIEW_WIDTHS: ReadonlyArray<[string, number]> = [['Full', 0], ['1280', 1280], ['768', 768], ['375', 375]]

// Draggable layout: editor width (% of the split) and bottom-panel height (px).
let editorPct = 50
let panelHeight = 150

// Soft-wrap long lines (off by default, like the EC editor). Toggled from the
// editor bar; CodeSurface owns the actual wrap reconfigure.
let wrapLines = false

// Auto-render the preview on edit (on by default). Off lets the author work on
// a heavy CVO without a full re-execution after every pause — Re-render / ⌘Enter
// drives it manually.
let autoRender = true

let runCounter = 0
/** Bumped on each runPreview so an in-flight one can bail if superseded during
 *  its async lib fetch (avoids two concurrent renders racing the ready-gate). */
let renderGen = 0
/** Console + error lines from the current run (owns its own buffer). */
const studioConsole = new StudioConsole()

/** Mock `_data` used until live data lands (Phase 3). Mirrors the shape the
 *  data servlet returns; `.element` is attached inside the sandbox. */
const mockData = {
  // A real (non-zero-width) period so a CVO that buckets/ranges by date sees a
  // plausible window in preview. Last 365 days ending now.
  context: { orgid: 'org_demo', period: 'M', start: Date.now() - 365 * 24 * 3600 * 1000, end: Date.now(), yearToDate: false },
  expressions: {} as Record<string, string>,
  tables: {} as Record<string, unknown>,
  serverConnections: {} as Record<string, string>,
  queryEndpoint: '',
}

/** The data object currently feeding the preview — live when fetched, else mock.
 *  Shared by postRender and the `_data` hover so they always agree. */
function currentData(): Record<string, unknown> {
  return dataMode === 'live' && liveData ? liveData : mockData
}

const root = document.getElementById('studio-root')!

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  renderDom(root, h('div', { class: 'studio-loading' }, 'Loading…'))
  const rid = location.hash.slice(1)
  try {
    const key = `${STUDIO_CTX_PREFIX}${rid}`
    const result = await chrome.storage.local.get([key])
    ctx = (result[key] as StudioContext | null) ?? null
  } catch {
    renderDom(root, h('div', { class: 'studio-loading' }, 'Failed to load studio context'))
    return
  }
  if (!ctx) {
    renderDom(root, h('div', { class: 'studio-loading' }, 'No studio context found'))
    return
  }
  if (ctx.loadError) {
    // No editor and no Save: the stored code was never loaded, so nothing
    // here may be written back to BMP.
    const label = ctx.instance.name || ctx.instance.businessId || ctx.instance.rid
    renderDom(root, h('div', { class: 'studio-loading studio-load-error', role: 'alert' },
      h('div', {}, `Could not load the code of ${label}.`),
      failureBlock(describeFailure({ error: ctx.loadError, ...(ctx.loadErrorKind ? { kind: ctx.loadErrorKind } : {}) })),
      h('div', {}, 'Close this window and open it again to retry. Nothing was changed in BMP.'),
    ))
    return
  }

  mode = STUDIO_MODES[ctx.mode] ?? STUDIO_MODES.cvo
  activeProp = ctx.property && codeProps().includes(ctx.property) ? ctx.property : codeProps()[0]
  renderContextRid = ctx.renderContextRid ?? ''
  renderContextRef = renderContextRid
  document.title = ctx.instance.name ? `${mode.title} · ${ctx.instance.name}` : mode.title

  await setupAiAssist()
  renderShell()
  ensureSurface()
  schedulePreview()
  if (mode.hasSandbox) void fetchChildren()
}

// ── AI assistant ─────────────────────────────────────────────────

/** Probe for a configured AI provider and subscribe to config changes so the
 *  assistant appears / disappears live (zero-footprint). Nothing AI renders
 *  otherwise (refreshActions gates the button), and the merge-heavy ai-assist
 *  module is never loaded until a key exists. */
async function setupAiAssist(): Promise<void> {
  chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
    if (msg.type === 'AI_CONFIG_CHANGED') void applyAiConfig(msg.configured)
    // Chat-tab Apply: when the proposal targets this studio's object + the
    // active file, raise the standard merge-diff Accept/Reject on the live doc.
    if ((msg.type === 'AI_APPLY_PROPOSAL' || msg.type === 'AI_INSERT_AT_CURSOR') && aiAssist && ctx) {
      if (msg.target.rid === ctx.instance.rid && msg.target.slot === activeProp) {
        if (msg.type === 'AI_APPLY_PROPOSAL') aiAssist.propose(msg.code)
        else aiAssist.insertAtCursor(msg.code)
      }
    }
  })
  // Tell the sidepanel this studio is gone so its 'editor' context chip drops.
  window.addEventListener('pagehide', () => {
    if (aiConfigured) sendFireForget({ type: 'AI_EDITOR_CONTEXT_UPDATE', source: null })
  })
  try {
    const cfg = await fetchAiConfig()
    await applyAiConfig(cfg.configured)
  } catch {
    aiConfigured = false
  }
}

/** React to the current AI-configured state: lazily build the assistant (which
 *  pulls in @codemirror/merge) on first need, or tear it down + close anything
 *  open when the key is removed. Repaints the toolbar so the sparkle follows. */
async function applyAiConfig(configured: boolean): Promise<void> {
  if (configured) {
    if (!aiAssist) {
      const { createAiAssist } = await import('../editor-core/ai-assist')
      aiAssist = createAiAssist({
        surface: () => surface,
        lang: () => (fileFor(activeProp).lang === 'javascript' ? 'javascript' : 'html') as AiLang,
        context: () => aiContext(),
        anchorEl: () => document.getElementById('studio-ai'),
        contextSource: () => aiContextSource(),
      })
    }
    aiConfigured = true
  } else {
    aiConfigured = false
    aiAssist?.close()
    aiAssist = null
  }
  broadcastEditorContext()
  refreshActions()
}

function openAiAssist(): void {
  if (aiConfigured) aiAssist?.open()
}

/** The 'editor' context source for the chat envelope: the open object's
 *  identity + the active file's full code (+ selection). */
function aiContextSource(): AiContextSource | null {
  if (!ctx) return null
  const id = ctx.instance
  const view = surface?.view
  const code = view ? view.state.doc.toString() : (activeCode()[activeProp] ?? '')
  const lang: AiLang = fileFor(activeProp).lang === 'javascript' ? 'javascript' : 'html'
  const source: AiContextSource = {
    kind: 'editor',
    object: {
      rid: id.rid,
      businessId: id.businessId ?? '',
      name: id.name ?? '',
      type: id.type ?? '',
      ...(ctx.template?.businessId ? { templateBusinessId: ctx.template.businessId } : {}),
    },
    slot: { name: activeProp, lang, code },
  }
  const sel = view?.state.selection.main
  if (sel && sel.from !== sel.to && source.slot) {
    source.slot.selection = { from: sel.from, to: sel.to }
  }
  return source
}

/** Broadcast which object+file this studio has open (the sidepanel AI chat
 *  tab's 'editor' chip). Zero-footprint: only while a key is configured. */
function broadcastEditorContext(): void {
  if (!aiConfigured) return
  sendFireForget({ type: 'AI_EDITOR_CONTEXT_UPDATE', source: aiContextSource() })
}

/** Object grounding for the prompt: identity + sibling files + (CVO) a `_data`
 *  sample so the model knows the data shape. */
function aiContext(): AiObjectContext {
  if (!ctx) return {}
  const id = ctx.instance
  const codeMap = activeCode()
  const otherSlots = Object.entries(codeMap)
    .filter(([prop]) => prop !== activeProp)
    .map(([name, code]) => ({ name, code: (code ?? '').slice(0, 1500) }))
    .filter(s => s.code.trim() !== '')
  let dataSample: string | undefined
  if (mode.hasSandbox) {
    try { dataSample = JSON.stringify(currentData()).slice(0, 2000) } catch { dataSample = undefined }
  }
  return {
    objectType: id.type,
    businessId: id.businessId || id.rid,
    name: id.name,
    templateBusinessId: ctx.template?.businessId,
    slotName: activeProp,
    otherSlots: otherSlots.length ? otherSlots : undefined,
    dataSample,
  }
}

/** Create the editing surface (once) with the html + javascript slots, or
 *  re-attach its view after a shell re-render. */
function ensureSurface() {
  if (surface) { surface.reattach(); return }
  surface = new CodeSurface(() => document.getElementById('studio-cm'), {
    buildExtensions: (slot) => [
      // Web 2-space indent (the base scaffold defaults to EC's 5). indentUnit
      // takes the first value, so this must precede baseEditingExtensions.
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      ...baseEditingExtensions(),
      languageExtension(slot.lang as CodeLang),
      codeTheme,
      // CVO-API autocomplete on the javascript slot (_data.* + the live child
      // keys); plain CM completion elsewhere. Plus a dep-free syntax-error
      // linter (flags parse errors inline) + the lint gutter.
      slot.lang === 'javascript' ? autocompletion({ override: [cvoApiSource] }) : autocompletion(),
      // Hover a `_data.…` path (in the JS slot) to see its resolved value.
      slot.lang === 'javascript' ? makeDataHover(currentData, () => dataMode) : [],
      syntaxErrorLinter,
      lintGutter(),
      // The studio's keys first (lib/shortcuts.ts), so CodeMirror's Mod-Enter
      // (insert blank line) cannot shadow Re-render; Escape after the defaults.
      Prec.high(keymap.of(cmBindings([
        { id: 'studio.save', run: () => { void doSave(); return true } },
        { id: 'studio.preview', run: () => { void runPreview({ retryDeps: true }); return true } },
        { id: 'studio.format', run: () => { void doFormat(); return true } },
        { id: 'studio.ai', run: () => { openAiAssist(); return true } },
      ]))),
      keymap.of([
        ...baseKeymapBindings,
        closeOverlayKeyBinding,
      ]),
      // Re-render on user edits only — a programmatic slot-swap (tab switch)
      // carries CodeSurface's annotation and must not trigger a preview rebuild.
      EditorView.updateListener.of(u => { if (u.docChanged && !isProgrammaticSwap(u) && autoRender) schedulePreview() }),
    ],
    onDirtyChange: () => { refreshActions(); updateFileSwitch() },
  })
  const code = activeCode()
  surface.setSlots(mode.files.map(f => ({ key: f.prop, lang: f.lang, code: code[f.prop] ?? '' })))
  surface.activate(activeProp)
}

/** CVO-API autocomplete source — reads the live child keys lazily. */
const cvoApiSource = makeCvoApiSource(() => children.map(c => c.key).filter(Boolean))

/** Code map for the current save target (keystone always edits the instance;
 *  a template/instance toggle arrives with the rest of the edit loop). */
function activeCode(): Record<string, string> {
  if (!ctx) return {}
  return ctx.saveTarget === 'template' && ctx.template ? ctx.templateCode : ctx.instanceCode
}

// ── Shell ────────────────────────────────────────────────────────
// renderShell does the FULL build (init + preview toggle only). The frequent
// interactions (panel toggle, data mode, width, tab switch, dirty) update their
// own sub-container in place — so the sandbox iframe (created once, appended to
// #studio-canvas here) is never detached, never reloads, and never flashes.
function renderShell() {
  if (!ctx) return
  const id = ctx.instance

  renderDom(root,
    h('div', { class: 'studio-header' },
      h('div', { class: 'studio-id' },
        h('span', { class: 'studio-id-icon', title: `${mode.title}: ${mode.files.map(f => f.label).join(' + ')}` }, svg(mode.files[mode.files.length - 1].icon)),
        wireBadgeCopy(typeBadge(id.type, { size: 'xs' }), () => id.businessId || id.rid),
        h('span', { class: 'studio-id-name' }, id.name || '(unnamed)'),
        h('span', { class: 'studio-id-bid' }, id.businessId || id.rid),
      ),
      h('div', { class: 'studio-actions code-action-row', id: 'studio-actions' }),
    ),
    h('div', { class: `studio-split studio-split--${layout}`, id: 'studio-split' },
      // The editor pane carries its own header — the HTML / JavaScript file
      // switch — mirroring the preview pane's strip. Inline flex-basis applies
      // only in split; --code takes it full width, --preview hides it.
      h('div', { class: 'studio-editor-pane', id: 'studio-editor-pane', style: layout === 'split' ? `flex: 0 0 ${editorPct}%` : '' },
        h('div', { class: 'studio-file-switch', id: 'studio-file-switch', role: 'tablist', 'aria-label': 'Edit file' }),
        h('div', { class: 'studio-editor', id: 'studio-cm' }),
      ),
      previewPresent() ? h('div', { class: 'studio-divider', id: 'studio-divider', title: 'Drag to resize' }) : null,
      previewPresent()
        ? h('div', { class: 'studio-preview' },
            h('div', { class: 'studio-strip', id: 'studio-strip' }),
            h('div', { class: `studio-canvas-outer${mode.hasSandbox ? ' studio-canvas-outer--live' : ''}${previewWidth ? ' studio-canvas-outer--framed' : ''}`, id: 'studio-canvas-outer' },
              h('div', { class: 'studio-canvas', id: 'studio-canvas', style: previewWidth ? `max-width:${previewWidth}px` : '' }),
            ),
            h('div', { class: 'studio-ptabs', id: 'studio-ptabs' }),
            h('div', { class: `studio-panel-resize${panelTab ? '' : ' studio-panel-resize--hidden'}`, id: 'studio-panel-resize', title: 'Drag to resize' }),
            h('div', { class: `studio-panel${panelTab ? '' : ' studio-panel--collapsed'}`, id: 'studio-panel', style: `height:${panelHeight}px` }),
          )
        : null,
    ),
  )

  surface?.reattach()
  // The rebuild dropped the old canvas: close the CVO frames' ports; the
  // scheduled preview below renders into a new frame.
  previewHost?.reset()
  if (previewPresent() && !mode.hasSandbox) {
    document.getElementById('studio-canvas')?.appendChild(ensureStaticFrame())
  }
  refreshActions()
  updateFileSwitch()
  if (previewPresent()) updateStrip()
  updatePanelTabs()
  renderPanelContent()
  if (previewPresent()) wireDividers()
  if (previewPresent() && surface) schedulePreview()
}

/** Attach the drag handlers to the two resizers (rebuilt each renderShell).
 *  Pointer events + setPointerCapture, mirroring the EC editor's handle. */
function wireDividers() {
  const split = document.getElementById('studio-divider')
  if (split) split.onpointerdown = e => startDrag(e, split, 'col', m => {
    const row = document.getElementById('studio-split')
    if (!row) return
    const pct = ((m.clientX - row.getBoundingClientRect().left) / row.clientWidth) * 100
    editorPct = Math.max(15, Math.min(85, pct))
    const pane = document.getElementById('studio-editor-pane')
    if (pane) pane.style.flex = `0 0 ${editorPct}%`
  })
  const ph = document.getElementById('studio-panel-resize')
  if (ph) ph.onpointerdown = e => startDrag(e, ph, 'row', m => {
    const panel = document.getElementById('studio-panel')
    if (!panel) return
    const next = panel.getBoundingClientRect().bottom - m.clientY
    panelHeight = Math.max(60, Math.min(window.innerHeight * 0.8, next))
    panel.style.height = `${panelHeight}px`
  })
}

/** Shared pointer-drag loop for both dividers. */
function startDrag(e: PointerEvent, handle: HTMLElement, axis: 'col' | 'row', onMove: (e: PointerEvent) => void) {
  if (e.button !== 0) return
  e.preventDefault()
  handle.classList.add('dragging')
  document.body.style.cursor = axis === 'col' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  try { handle.setPointerCapture(e.pointerId) } catch { /* fine */ }
  const finish = () => {
    handle.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', finish)
    handle.removeEventListener('pointercancel', finish)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
}

/** Static modes: one persistent inert frame, driven purely via srcdoc. */
function ensureStaticFrame(): HTMLIFrameElement {
  if (!staticFrame) {
    staticFrame = h('iframe', { id: 'studio-sandbox', class: 'studio-sandbox', sandbox: true, title: 'Preview' }) as HTMLIFrameElement
  }
  return staticFrame
}

/** CVO mode: the frame host, created on first render. */
function ensurePreviewHost(): PreviewHost {
  previewHost ??= new PreviewHost({
    mountPoint: () => document.getElementById('studio-canvas'),
    createFrame: () => h('iframe', { class: 'studio-sandbox', src: 'sandbox.html', title: 'Preview' }) as HTMLIFrameElement,
    onOutput: msg => {
      if (msg.type === 'CVO_CONSOLE') logConsole(msg.level, msg.text)
      else logConsole('error', formatCvoError(msg))
    },
  })
  return previewHost
}

/** Header action buttons + their enabled state — re-rendered in place on dirty
 *  change (never touches the canvas). */
function refreshActions() {
  const el = document.getElementById('studio-actions')
  if (!el) return
  const isDirty = anyDirty()
  const n = dirtyCount()
  // Mirror the EC editor's Save affordance: green when there are changes, a
  // brief "Saved" pulse after a commit, ghost (de-emphasised) when idle-clean.
  const justSaved = !isDirty && !saving && lastSavedAt > 0 && Date.now() - lastSavedAt < SAVED_FLASH_MS
  const saveClass = `btn ${isDirty || saving ? 'btn-success' : justSaved ? 'btn-success btn-saved' : 'btn-ghost'}`
  renderDom(el,
    h('button', { class: 'btn btn-accent', id: 'studio-run', title: withShortcut('Re-render preview (retries failed dependencies)', 'studio.preview'), 'aria-keyshortcuts': ariaKeyShortcuts('studio.preview'), onClick: () => void runPreview({ retryDeps: true }) },
      svg(ICON_PLAY), h('span', { class: 'code-action-compact-label' }, 'Re-render'), h('kbd', null, shortcutLabel('studio.preview'))),
    h('button', { class: saveClass, id: 'studio-save', disabled: saving || !isDirty, title: withShortcut(`Save every changed field (${mode.files.map(f => f.prop).join(' + ')})`, 'studio.save'), 'aria-keyshortcuts': ariaKeyShortcuts('studio.save'), onClick: doSave },
      justSaved ? svg(ICON_CHECK) : null,
      h('span', null, saving ? 'Saving…' : justSaved ? 'Saved' : n > 1 ? `Save ${n}` : 'Save'),
      isDirty ? h('kbd', null, shortcutLabel('studio.save')) : null),
    h('button', { class: 'btn btn-ghost code-action-tertiary', id: 'studio-discard', disabled: !surface?.isDirty(activeProp), title: 'Revert this field to the saved BMP value', 'aria-label': 'Discard changes', onClick: doDiscard },
      svg(ICON_REVERT), h('span', { class: 'code-action-label' }, 'Discard')),
    h('button', { class: 'btn btn-ghost code-action-secondary', id: 'studio-download', title: `Download the source (${mode.files.map(f => f.prop).join(' + ')}) as a .${mode.key}.json bundle`, 'aria-label': 'Download source', onClick: doDownload },
      svg(ICON_TRAY_ARROW_DOWN), h('span', { class: 'code-action-label' }, 'Download')),
    h('div', { class: 'studio-actions-spacer code-action-spacer' }),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' },
      h('button', { class: `seg-btn${layout === 'code' ? ' active' : ''}`, title: 'Editor only', onClick: () => setLayout('code') }, 'Code'),
      h('button', { class: `seg-btn${layout === 'split' ? ' active' : ''}`, title: 'Editor and preview', onClick: () => setLayout('split') }, 'Split'),
      h('button', { class: `seg-btn${layout === 'preview' ? ' active' : ''}`, title: 'Preview only', onClick: () => setLayout('preview') }, 'Preview'),
    ),
    aiConfigured ? h('button', { class: 'btn-micro studio-ai-btn code-action-ai', id: 'studio-ai', title: withShortcut('Ask or edit with AI', 'studio.ai'), 'aria-label': 'AI assistant', 'aria-keyshortcuts': ariaKeyShortcuts('studio.ai'), onClick: openAiAssist }, svg(ICON_SPARKLE), h('span', { class: 'ai-button-label' }, 'AI')) : null,
    h('button', { class: 'btn-micro help-btn', title: withShortcut('Keyboard shortcuts and controls', 'sheet.open'), 'aria-label': 'Keyboard shortcuts and controls', 'aria-haspopup': 'dialog', onClick: () => toggleCheatSheet(studioSheet(mode)) }, '?'),
  )
}

/** The file switch — the editor pane's header. The studio's signature
 *  control: which of the mode's source files you're editing, with a language
 *  icon and a per-file unsaved dot. */
function updateFileSwitch() {
  const el = document.getElementById('studio-file-switch')
  if (!el) return
  renderDom(el,
    ...mode.files.map(f => h('button', {
      class: `studio-file-tab${f.prop === activeProp ? ' active' : ''}`,
      role: 'tab',
      'data-prop': f.prop,
      'aria-selected': f.prop === activeProp ? 'true' : 'false',
      title: `Edit the ${f.label}`,
      onClick: () => switchProp(f.prop),
    }, svg(f.icon), h('span', null, f.label),
      surface?.isDirty(f.prop) ? h('span', { class: 'studio-file-dot', 'aria-label': 'unsaved changes' }) : null)),
    // Editor tools live with the editor: reflow and soft-wrap.
    h('div', { class: 'studio-file-spacer' }),
    h('button', { class: 'studio-file-tool', title: withShortcut(`Format the ${fileFor(activeProp).label}`, 'studio.format'), 'aria-label': 'Format', onClick: () => void doFormat() }, svg(ICON_BRACKETS)),
    h('button', { class: `studio-file-tool${wrapLines ? ' active' : ''}`, title: 'Wrap long lines', 'aria-label': 'Wrap long lines', 'aria-pressed': wrapLines ? 'true' : 'false', onClick: toggleWrap }, svg(ICON_WRAP)),
  )
}

function toggleWrap() {
  wrapLines = !wrapLines
  surface?.setWrap(wrapLines)
  updateFileSwitch()
}

/** Pretty-print the active file in place (lazy-loads the formatter). */
async function doFormat() {
  if (!surface) return
  const prop = activeProp
  try {
    const formatted = await formatCode(fileFor(prop).lang, surface.textFor(prop))
    if (prop !== activeProp) return // user switched files during the async import
    surface.replaceActive(formatted)
  } catch (e) {
    logConsole('error', `Format failed: ${(e as Error).message}`)
  }
}

const anyDirty = () => !!surface?.isDirty()
const dirtyCount = () => codeProps().filter(p => surface?.isDirty(p)).length

let previewTimer: ReturnType<typeof setTimeout> | null = null

function switchProp(p: StudioCodeProp) {
  if (p === activeProp) return
  activeProp = p
  updateFileSwitch()
  refreshActions()
  surface?.activate(p)
  broadcastEditorContext()
}

/** Pull the `.error` off any studio response (all error-bearing replies carry
 *  an optional `error`), with a fallback when absent — collapses the repeated
 *  `resp?.type === 'X' ? resp.error : …` casts. */
function respError(resp: unknown, fallback = ''): string {
  const e = resp && typeof resp === 'object' && 'error' in resp ? (resp as { error?: unknown }).error : undefined
  return (typeof e === 'string' ? e : undefined) ?? fallback
}

// ── Preview (sandbox) ────────────────────────────────────────────
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => { void runPreview() }, PREVIEW_DEBOUNCE_MS)
}

async function runPreview(opts: { retryDeps?: boolean } = {}) {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (!previewPresent()) return
  // Static modes: no sandbox handshake, no libs, no console lifecycle — the
  // preview document is rebuilt wholesale from the current slot texts.
  if (!mode.hasSandbox) { renderStaticPreview(); return }
  const gen = ++renderGen
  clearConsole()
  // An explicit Re-render retries deps that previously failed to load (e.g. the
  // BMP session came up since); auto-renders don't, to avoid re-warning on
  // every keystroke. Resolve libraries before the ready-gate so a queued render
  // flushes with them ready.
  if (opts.retryDeps) for (const [rid, v] of libCache) if (v === null) libCache.delete(rid)
  const libs = await ensureLibs()
  if (gen !== renderGen) return // a newer runPreview started during the await
  lastLibs = libs // commit only after winning the gen race (no clobber by a stale ensureLibs)
  postRender()
}

/** Detect the FileResource libraries the CVO loads and fetch their bytes via
 *  the SW (cookie-authed download), caching by rid. A transport failure (e.g.
 *  no BMP session) is cached as null and warned once so the CVO degrades rather
 *  than blocking; an explicit Re-render clears those nulls to retry. Returns the
 *  resolved set (the caller commits it after winning the render-gen race). */
async function ensureLibs(): Promise<CvoLib[]> {
  const rids = detectFileResourceRids(surface?.textFor('html') ?? '', surface?.textFor('javascript') ?? '')
  for (const rid of rids) {
    if (libCache.has(rid)) continue
    const resp = await sendRequest({ type: 'STUDIO_FETCH_RESOURCE', rid })
    if (resp?.type === 'STUDIO_RESOURCE' && resp.ok && resp.text != null) {
      libCache.set(rid, resp.text)
    } else {
      libCache.set(rid, null)
      logConsole('warn', `Dependency ${rid} unavailable (${respError(resp, 'no response')}). Preview runs without it.`)
    }
  }
  return rids
    .map(rid => ({ rid, content: libCache.get(rid) }))
    .filter((l): l is CvoLib => typeof l.content === 'string')
}

/** Static-mode preview: build the document from the mode's template and swap
 *  the persistent iframe's srcdoc (a full reload of an inert local doc). */
function renderStaticPreview(): void {
  const frame = staticFrame
  if (!frame || !mode.buildPreviewDoc) return
  const code: Record<string, string> = {}
  for (const p of codeProps()) code[p] = surface?.textFor(p) ?? ''
  frame.srcdoc = mode.buildPreviewDoc(code)
}

function postRender() {
  const runId = ++runCounter
  // textFor() pulls the live doc for the active slot and the stashed text for
  // the inactive one — so a render always uses the latest of both fields.
  // In live mode render against the real servlet `_data` (falling back to mock
  // until the first successful fetch); otherwise the mock. The request goes to
  // a new frame over its own MessagePort, never to a window by '*'.
  const data = currentData()
  const req: CvoRenderRequest = {
    type: 'CVO_RENDER',
    runId,
    html: surface?.textFor('html') ?? '',
    javascript: surface?.textFor('javascript') ?? '',
    data,
    libs: lastLibs,
  }
  ensurePreviewHost().render(req)
}

// ── Control strip (one dense row: data source + width) ───────────
function updateStrip(): void {
  const el = document.getElementById('studio-strip')
  if (!el) return
  const ctxInput = h('input', {
    class: 'studio-ctx-input',
    placeholder: 'scorecard/page ID or RID',
    value: renderContextRef,
    spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'Live preview context',
  }) as HTMLInputElement
  ctxInput.addEventListener('change', () => { renderContextRef = ctxInput.value.trim(); void resolveRenderContext() })
  const live = dataMode === 'live'
  const sandbox = mode.hasSandbox
  renderDom(el,
    ...(sandbox ? dataModeSwitch(dataMode, setDataMode) : []),
    sandbox && live ? h('span', { class: 'studio-strip-label' }, 'Context') : null,
    sandbox && live ? ctxInput : null,
    sandbox && live ? h('button', { class: 'icon-btn', title: 'Re-fetch live data', onClick: () => fetchLiveData() }, svg(ICON_REFRESH)) : null,
    sandbox && live && !renderContextRef ? h('span', { class: 'studio-strip-hint' }, 'paste a scorecard id or rid to load real data') : null,
    sandbox && live && renderContextRef && !renderContextRid ? h('span', { class: 'studio-strip-err', title: liveError ?? 'not found' }, h('span', { class: 'studio-status-dot studio-status-dot--err' }), liveError ?? 'not found') : null,
    sandbox && live && renderCtxLabel ? h('span', { class: 'studio-strip-ref', title: 'rid ' + renderContextRid }, renderCtxLabel) : null,
    sandbox && live && renderContextRid && liveError ? h('span', { class: 'studio-strip-err', title: liveError }, h('span', { class: 'studio-status-dot studio-status-dot--err' }), 'Live failed') : null,
    sandbox && live && renderContextRid && !liveError && liveData ? h('span', { class: 'studio-strip-ok', title: 'Rendering against live BMP data' }, h('span', { class: 'studio-status-dot studio-status-dot--ok' }), 'Live') : null,
    mode.rewriteSemantics === 'sanitizer'
      ? h('span', { class: 'studio-strip-hint' }, 'Preview is inert. BMP removes active content and unsupported styling on save.')
      : null,
    h('div', { class: 'studio-strip-spacer' }),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Auto-render' },
      h('button', {
        class: `seg-btn${autoRender ? ' active' : ''}`,
        title: autoRender ? 'Auto-rendering on edit. Click to render only on demand (Re-render / ⌘Enter)' : 'Manual render. Click to re-render automatically as you edit',
        'aria-pressed': autoRender ? 'true' : 'false',
        onClick: () => setAutoRender(!autoRender),
      }, 'Auto'),
    ),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Preview width' },
      ...PREVIEW_WIDTHS.map(([label, w]) => h('button', { class: `seg-btn${previewWidth === w ? ' active' : ''}`, title: w ? `Render at ${w}px container width` : 'Full container width', onClick: () => setPreviewWidth(w) }, label)),
    ),
  )
}

function setAutoRender(on: boolean): void {
  autoRender = on
  updateStrip()
  if (on) void runPreview() // catch up to edits made while manual
}

/** Switch the pane layout. Crossing the preview-present boundary (to/from
 *  'code') adds or removes the preview pane, so it rebuilds the shell;
 *  'split' <-> 'preview' just shows/hides the editor pane in place, keeping the
 *  persistent iframe mounted. */
function setLayout(next: Layout): void {
  if (next === layout) return
  const wasPreview = previewPresent()
  layout = next
  if (wasPreview !== previewPresent()) {
    renderShell()
    if (previewPresent()) schedulePreview()
    return
  }
  // In place (split <-> preview): re-class the split + restore the editor's
  // dragged width when it reappears, then re-render at the new canvas width.
  const split = document.getElementById('studio-split')
  if (split) split.className = `studio-split studio-split--${layout}`
  const pane = document.getElementById('studio-editor-pane')
  if (pane) pane.style.flex = layout === 'split' ? `0 0 ${editorPct}%` : ''
  refreshActions()
  void runPreview()
}

function setPreviewWidth(w: number): void {
  if (w === previewWidth) return
  previewWidth = w
  // In place: resize the canvas (the persistent iframe stays mounted) + re-render
  // the CVO at the new width (a responsive CVO lays out per container width).
  const canvas = document.getElementById('studio-canvas')
  if (canvas) canvas.style.maxWidth = w ? `${w}px` : ''
  // Frame (grey gutter) only when a width preset centers the canvas.
  document.getElementById('studio-canvas-outer')?.classList.toggle('studio-canvas-outer--framed', !!w)
  updateStrip()
  void runPreview()
}

function setDataMode(mode: PreviewDataMode): void {
  if (mode === dataMode) return
  dataMode = mode
  liveError = null
  updateStrip()
  // Switching to live resolves the context ref (id or rid) first, which then
  // fetches; switching to mock just re-renders against the mock _data.
  if (mode === 'live') void resolveRenderContext()
  else void runPreview()
}

/** Resolve the configurator-typed render context (a business id or a rid) to
 *  the rid the data servlet needs, and show its id · name. */
async function resolveRenderContext(): Promise<void> {
  const ref = renderContextRef.trim()
  if (!ref) { renderContextRid = ''; renderCtxLabel = ''; liveError = null; updateStrip(); return }
  const resp = await sendRequest({ type: 'STUDIO_RESOLVE_REF', ref })
  if (resp?.type === 'STUDIO_REF_RESOLVED' && resp.ok && resp.rid) {
    renderContextRid = resp.rid
    renderCtxLabel = resp.name ? `${resp.id} · ${resp.name}` : (resp.id ?? '')
    liveError = null
    updateStrip()
    if (dataMode === 'live') void fetchLiveData()
  } else {
    renderContextRid = ''
    renderCtxLabel = ''
    liveError = resp?.type === 'STUDIO_REF_RESOLVED' ? (resp.error ?? 'not found') : 'resolve failed'
    updateStrip()
  }
}

async function fetchLiveData(): Promise<void> {
  if (!ctx) return
  if (!renderContextRid) {
    liveData = null
    liveError = 'no render context'
    logConsole('error', 'Live data needs an org-rooted render context. Paste a scorecard or page rid in the Live field.')
    updateStrip()
    return
  }
  liveError = null
  const gen = ++fetchGen
  const resp = await sendRequest({ type: 'STUDIO_FETCH_DATA', cvoRid: ctx.instance.rid, businessObjectRid: renderContextRid })
  if (gen !== fetchGen) return // a newer fetch started during the await — its result wins
  if (resp?.type === 'STUDIO_DATA' && resp.ok && resp.data) {
    liveData = resp.data as Record<string, unknown>
    liveError = null
  } else {
    liveData = null
    liveError = respError(resp, 'Live data fetch failed')
    logConsole('error', `Live data: ${liveError}`)
  }
  updateStrip()
  void runPreview()
}

// ── Bottom panel (Console · Inputs · Deps), one toggleable area ──
function togglePanel(tab: PanelTab): void {
  panelTab = panelTab === tab ? null : tab
  updatePanelTabs()
  renderPanelContent()
}

function updatePanelTabs(): void {
  const el = document.getElementById('studio-ptabs')
  if (!el) return
  const errCount = studioConsole.errorCount
  const tab = (id: PanelTab, label: string, count: number, err = false) =>
    h('button', { class: `studio-ptab${panelTab === id ? ' active' : ''}`, role: 'tab', onClick: () => togglePanel(id) },
      label,
      count ? h('span', { class: 'studio-ptab-n' }, String(count)) : null,
      err ? h('span', { class: 'studio-ptab-err', 'aria-label': 'errors' }) : null,
    )
  if (!mode.hasSandbox) {
    // Static modes have no JS run and no `_data` children — the console still
    // carries save/format feedback, so it stays.
    renderDom(el, tab('console', 'Console', studioConsole.count, errCount > 0))
    return
  }
  const html = surface?.textFor('html') ?? ''
  const js = surface?.textFor('javascript') ?? ''
  const depCount = detectFileResourceRids(html, js).length + detectCdnUrls(html, js).length
  renderDom(el,
    tab('console', 'Console', studioConsole.count, errCount > 0),
    tab('inputs', 'Inputs', children.length),
    tab('deps', 'Deps', depCount),
    h('span', { class: 'studio-ptabs-spacer' }),
    h('button', {
      class: 'studio-panel-help',
      title: 'About Inputs and Deps',
      'aria-label': 'About Inputs and Deps',
      'aria-expanded': 'false',
      'aria-controls': 'studio-panel-help-popover',
      onClick: (event: Event) => showStudioPanelHelp(event.currentTarget as HTMLElement),
    }, '?'),
  )
}

function renderPanelContent(): void {
  const el = document.getElementById('studio-panel')
  if (!el) return
  el.className = `studio-panel${panelTab ? '' : ' studio-panel--collapsed'}`
  // The resize handle lives above the panel; hide it in step with the panel
  // (togglePanel doesn't rebuild the shell, so sync it here).
  document.getElementById('studio-panel-resize')?.classList.toggle('studio-panel-resize--hidden', !panelTab)
  if (panelTab === 'console') studioConsole.renderInto(el)
  else if (panelTab === 'inputs') renderInputsInto(el)
  else if (panelTab === 'deps') renderDepsInto(el)
  else renderDom(el)
}

/** Push a console line and reflect it (auto-opens the Console tab on error). */
function logConsole(level: CvoConsoleLevel, text: string): void {
  studioConsole.push(level, text)
  if (level === 'error' && panelTab !== 'console') panelTab = 'console'
  updatePanelTabs()
  renderPanelContent()
}

function clearConsole(): void {
  studioConsole.clear()
  updatePanelTabs()
  renderPanelContent()
}

// ── Data inputs (CVO children → _data.expressions) ───────────────
async function fetchChildren(): Promise<boolean> {
  if (!ctx?.instance.businessId) return false
  const resp = await sendRequest({ type: 'STUDIO_FETCH_CHILDREN', cvoBid: ctx.instance.businessId })
  if (resp?.type === 'STUDIO_CHILDREN' && resp.ok && resp.children) {
    children = resp.children
    seedMockFromChildren()
    updatePanelTabs()
    renderPanelContent()
    void runPreview() // the mock _data shape changed (new slot keys)
    return true
  }
  return false
}

/** A child write whose answer did not arrive may have been applied: re-read
 *  the inputs and say whether `childId` is there now. Never retried. */
async function settleUnknownChildWrite(childId: string, expectPresent: boolean, what: string): Promise<void> {
  const read = await fetchChildren()
  if (!read) { logConsole('warn', `${MAY_HAVE_SAVED} Could not check: reload the inputs before trying to ${what} again.`); return }
  const present = children.some(c => c.id === childId)
  logConsole(present === expectPresent ? 'info' : 'warn', present === expectPresent
    ? `${MAY_HAVE_SAVED} The re-read shows it was applied after all (${what}).`
    : `${MAY_HAVE_SAVED} The re-read shows it was not applied (${what}).`)
}

// Which _data map each child type populates, its row badge, and its id prefix.
const CHILD_MAP: Record<StudioChildType, string> = { expression: 'expressions', table: 'tables', connection: 'serverConnections' }
const CHILD_BADGE: Record<StudioChildType, string> = { expression: 'EXPR', table: 'TABLE', connection: 'CONN' }
const CHILD_PREFIX: Record<StudioChildType, string> = { expression: 'cve', table: 'cvt', connection: 'csc' }

/** Seed the mock `_data` maps with the real child keys so a mock-mode preview
 *  sees the same shape (keys) as live, per child type. */
function seedMockFromChildren(): void {
  const ex: Record<string, string> = {}
  const tables: Record<string, unknown> = {}
  const conns: Record<string, string> = {}
  for (const c of children) {
    if (!c.key) continue
    if (c.type === 'table') tables[c.key] = mockData.tables[c.key] ?? []
    else if (c.type === 'connection') conns[c.key] = mockData.serverConnections[c.key] ?? ''
    else ex[c.key] = mockData.expressions[c.key] ?? ''
  }
  mockData.expressions = ex
  mockData.tables = tables
  mockData.serverConnections = conns
}

function renderInputsInto(el: HTMLElement): void {
  renderDom(el,
    children.length === 0 ? h('div', { class: 'studio-panel-empty' }, 'No data inputs yet. Add an expression, table, or connection to populate _data.') : null,
    ...children.map(renderChildRow),
    h('div', { class: 'studio-child-adds' },
      h('button', { class: 'studio-panel-add', title: 'Add an expression input (_data.expressions)', onClick: () => doAddChild('expression') }, '+ Expression'),
      h('button', { class: 'studio-panel-add', title: 'Add a table reference (_data.tables)', onClick: () => doAddChild('table') }, '+ Table'),
      h('button', { class: 'studio-panel-add', title: 'Add a server connection (_data.serverConnections)', onClick: () => doAddChild('connection') }, '+ Connection'),
    ),
  )
}

function renderChildRow(c: StudioChild): HTMLElement {
  const inputs: HTMLInputElement[] = []
  const mk = (cls: string, val: string, ph: string, title: string) => {
    const i = h('input', { class: cls, value: val, spellcheck: 'false', autocomplete: 'off', placeholder: ph, title }) as HTMLInputElement
    inputs.push(i); return i
  }
  const keyInput = mk('studio-child-key-input', c.key, 'key', `JS key for _data.${CHILD_MAP[c.type]}.${c.key || '?'}`)
  inputs.pop() // key is rendered explicitly, not among the type fields
  let collect: () => ChildFields
  if (c.type === 'table') {
    const t = mk('studio-child-expr', c.table ?? '', 'table business id (e.g. tbl_top_risks)', 'Business id of a table object (ExtendedTable, StandardTable, …)')
    collect = () => ({ table: t.value.trim() })
  } else if (c.type === 'connection') {
    const u = mk('studio-child-expr', c.url ?? '', 'upstream url', 'Upstream URL (stays server-side; JS gets a proxy path)')
    const p = mk('studio-child-sub', c.urlParameters ?? '', 'urlParameters: a=b&c=d', 'Preconfigured query params')
    const hd = mk('studio-child-sub', c.headers ?? '', 'headers: Name: v; Name2: v', 'Semicolon-separated header lines')
    const to = mk('studio-child-sub', c.timeout ?? '', 'timeout ms', 'Connection timeout in milliseconds')
    collect = () => ({ url: u.value, urlParameters: p.value, headers: hd.value, timeout: to.value.trim() })
  } else {
    const e = mk('studio-child-expr', c.expression ?? '', 'Reporter token, e.g. ${t.my_expr.expression}', 'Reporter token whose value fills this input')
    collect = () => ({ expression: e.value })
  }
  return h('div', { class: `studio-child-row studio-child-row--${c.type}` },
    h('span', { class: `studio-child-badge studio-child-badge--${c.type}`, title: `_data.${CHILD_MAP[c.type]}` }, CHILD_BADGE[c.type]),
    keyInput,
    ...inputs,
    h('button', { class: 'btn-micro', title: 'Save this input', onClick: () => doSaveChild(c, keyInput.value.trim(), collect()) }, 'Save'),
    h('button', { class: 'btn-micro studio-child-del', title: 'Remove this input', 'aria-label': 'Remove this input', onClick: () => doRemoveChild(c) }, svg(ICON_X)),
  )
}

async function doSaveChild(c: StudioChild, key: string, edited: ChildFields, force = false): Promise<void> {
  const current = ctx
  if (!current) return
  const finalKey = key || c.key
  const { fields, expect } = childSaveRequest(c, edited)
  const resp = await sendRequest({
    type: 'STUDIO_SAVE_CHILD', childId: c.id, childType: c.type, key: finalKey, fields, environment: current.environment,
    ...(!force && current.instance.businessId ? { cvoBid: current.instance.businessId, expect } : {}),
  })
  if (resp?.type === 'STUDIO_CHILD_SAVED' && resp.ok) {
    // Read back: "Saved" only when the inputs show what was sent.
    if (!(await fetchChildren())) { logConsole('warn', `Wrote input "${finalKey}", but the re-read failed, so the stored values are not confirmed.`); return }
    const stored = children.find(x => x.id === c.id)
    const differs = stored
      ? (Object.entries({ key: finalKey, ...fields }) as Array<[keyof StudioChild, string]>).find(([f, v]) => String(stored[f] ?? '') !== v)
      : undefined
    if (!stored) logConsole('warn', `Wrote input "${finalKey}", but it is not in the re-read inputs.`)
    else if (differs) logConsole('warn', storedDiffersLine(`${finalKey} ${differs[0]}`, String(stored[differs[0]] ?? '')))
    else logConsole('info', `Saved input "${finalKey}"`)
    return
  }
  if (resp?.type === 'STUDIO_CHILD_SAVED' && (resp.conflict?.length || resp.checkFailed)) {
    const check = resp.conflict?.length
      ? { state: 'changed' as const, changes: resp.conflict }
      : { state: 'unreadable' as const, error: resp.error ?? 'the read failed' }
    const choice = (await choiceModal({
      title: conflictTitle(check, `Input "${c.key}"`),
      body: check.state === 'changed'
        ? [`Nothing was written. ${check.changes.map(x => `${x.prop}: opened "${x.opened}", in BMP now "${x.current}"`).join('; ')}.`]
        : conflictBody(check, () => undefined),
      choices: conflictChoices(check),
    })) ?? 'cancel'
    if (choice === 'overwrite') { await doSaveChild(c, key, edited, true); return }
    if (choice === 'review' && check.state === 'changed') {
      // The current BMP values become the comparison; the typed values stay.
      for (const x of check.changes) if (x.prop !== 'id') (c as unknown as Record<string, string>)[x.prop] = x.current
      logConsole('warn', `Input "${c.key}" ${CHANGED_IN_BMP}. The comparison now uses the current BMP values; your typed values are kept. Save again to write them.`)
      return
    }
    logConsole('warn', `Not saved: input "${c.key}" ${check.state === 'changed' ? CHANGED_IN_BMP : 'could not be checked for changes in BMP'}.`)
    return
  }
  if (resp?.type === 'STUDIO_CHILD_SAVED' && resp.field) { logConsole('error', `Not saved: ${resp.error ?? `${resp.field} was rejected`}`); return }
  if (!resp || (resp.type === 'STUDIO_CHILD_SAVED' && resp.outcomeUnknown)) {
    const read = await fetchChildren()
    const stored = read ? children.find(x => x.id === c.id) : undefined
    const all = stored && (Object.entries({ key: finalKey, ...fields }) as Array<[keyof StudioChild, string]>).every(([f, v]) => String(stored[f] ?? '') === v)
    logConsole(all ? 'info' : 'warn', unknownOutcomeLine(!read ? 'unverified' : all ? 'saved' : 'not-saved'))
    return
  }
  logConsole('error', `Save failed: ${respError(resp)}`)
}

async function doAddChild(childType: StudioChildType): Promise<void> {
  if (!ctx?.instance.businessId) return
  const n = children.filter(c => c.type === childType).length + 1
  const key = `${childType === 'expression' ? 'input' : childType}_${n}`
  const childId = `${CHILD_PREFIX[childType]}_${(ctx.instance.businessId || 'cvo').replace(/[^\w-]/g, '')}_${key}`
  const resp = await sendRequest({ type: 'STUDIO_ADD_CHILD', cvoBid: ctx.instance.businessId, childId, key, childType, environment: ctx.environment })
  if (resp?.type === 'STUDIO_CHILD_ADDED' && resp.ok) { logConsole('info', `Added ${childType} "${key}"`); await fetchChildren() }
  else if (!resp || (resp.type === 'STUDIO_CHILD_ADDED' && resp.outcomeUnknown)) await settleUnknownChildWrite(childId, true, `add ${childType} "${key}"`)
  else logConsole('error', `Add failed: ${respError(resp)}`)
}

async function doRemoveChild(c: StudioChild): Promise<void> {
  const current = ctx
  if (!current) return
  const ok = await confirmCommandModal({
    title: 'Remove input?',
    body: `Delete the "${c.key}" ${c.type} input (${c.id}) from this CVO? This removes the _data.${CHILD_MAP[c.type]}.${c.key} slot.`,
    confirmLabel: 'Remove',
    confirmVariant: 'danger',
  })
  if (!ok) return
  const resp = await sendRequest({ type: 'STUDIO_DELETE_CHILD', childId: c.id, environment: current.environment })
  if (resp?.type === 'STUDIO_CHILD_DELETED' && resp.ok) { logConsole('info', `Removed input "${c.key}"`); await fetchChildren() }
  else if (!resp || (resp.type === 'STUDIO_CHILD_DELETED' && resp.outcomeUnknown)) await settleUnknownChildWrite(c.id, false, `remove input "${c.key}"`)
  else logConsole('error', `Remove failed: ${respError(resp)}`)
}

// ── Dependencies + resource hosting ──────────────────────────────
function renderDepsInto(el: HTMLElement): void {
  const html = surface?.textFor('html') ?? ''
  const js = surface?.textFor('javascript') ?? ''
  const fileRes = detectFileResourceRids(html, js)
  const cdns = detectCdnUrls(html, js)
  renderDom(el,
    fileRes.length + cdns.length === 0 ? h('div', { class: 'studio-panel-empty' }, 'No external dependencies') : null,
    ...fileRes.map(rid => {
      const cached = libCache.get(rid)
      const status = cached === undefined ? '…' : cached ? [svg(ICON_CHECK), ' loaded'] : [svg(ICON_X), ' unavailable']
      const ref = refCache.get(rid)
      return h('div', { class: 'studio-dep-row' },
        objectChip({
          rid,
          type: 'FileResource',
          businessId: ref?.id,
          name: ref?.name,
        }, {
          size: 'xs',
          className: 'studio-dep-object',
          showId: true,
          onActivate: () => openObject(rid),
        }),
        h('span', { class: `studio-dep-status${cached === null ? ' studio-dep-warn' : ''}` }, status),
      )
    }),
    ...cdns.map(u => h('div', { class: 'studio-dep-row' },
      h('span', { class: 'studio-dep-kind studio-dep-kind--cdn' }, 'CDN'),
      h('span', { class: 'studio-dep-id', title: u }, u),
      h('span', { class: 'studio-dep-status studio-dep-warn' }, svg(ICON_WARNING), " won't load if air-gapped"),
    )),
    h('button', { class: 'studio-panel-add', title: 'Host a JS/asset file as a BMP FileResource', onClick: doHostResource }, '+ Host resource'),
  )
  if (fileRes.length) void resolveDepRefs(fileRes)
}

/** Resolve dependency rids to id/name (once each) and re-render the panel. */
async function resolveDepRefs(rids: string[]): Promise<void> {
  const missing = rids.filter(r => !refCache.has(r))
  if (missing.length === 0) return
  const resp = await sendRequest({ type: 'STUDIO_RESOLVE_RIDS', rids: missing })
  if (resp?.type !== 'STUDIO_RIDS_RESOLVED' || !resp.ok) return
  for (const r of resp.refs ?? []) refCache.set(r.rid, { id: r.id, name: r.name })
  // Mark unresolved (deleted/inaccessible) so we don't refetch them forever.
  for (const r of missing) if (!refCache.has(r)) refCache.set(r, { id: '', name: '' })
  if (panelTab === 'deps') renderPanelContent()
}

/** Base64-encode bytes in chunks (avoids the arg-count limit of a single
 *  String.fromCharCode(...bytes) on large files). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

function doHostResource(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.onchange = async () => {
    input.onchange = null // release the closure; the detached input is then GC-able
    const file = input.files?.[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const current = ctx
    if (!current) return
    const resId = 'fr_' + file.name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    const mime = file.type || 'application/octet-stream'
    logConsole('info', `Hosting ${file.name} (${Math.round(bytes.length / 1024)} KB)…`)
    const resp = await sendRequest({ type: 'STUDIO_WRITE_RESOURCE', resId, name: file.name, mime, base64: bytesToBase64(bytes), environment: current.environment })
    if (resp?.type === 'STUDIO_RESOURCE_WRITTEN' && resp.ok && resp.rid) {
      const resourceId = resp.id || resId
      // The download servlet keys on rid (a hard BMP constraint), so the URL
      // stays rid-based — but lead with the business id as a comment so the
      // configurator can find the resource in Config Studio.
      const snippet = `<!-- ${resourceId} -->\n<script src="/<workspace>/web/download?propName=content&rid=${resp.rid}"></script>`
      const copied = await copyTextResult(snippet)
      logConsole('info', `Hosted "${file.name}" as id "${resourceId}" (rid ${resp.rid}). Reference snippet ${copied.ok ? 'copied' : `not copied (${copyFailureMessage(copied.reason)})`} (set <workspace>):\n${snippet}`)
    } else if (!resp || (resp.type === 'STUDIO_RESOURCE_WRITTEN' && resp.outcomeUnknown)) {
      // No answer: the upload may have been applied. Re-reading would mean
      // searching the whole resource tree, so say so instead of guessing.
      logConsole('warn', `${MAY_HAVE_SAVED} Could not check: look for resource "${resId}" in BMP before uploading again.`)
    } else {
      logConsole('error', `Host failed: ${respError(resp)}`)
    }
  }
  input.click()
}

// ── Save / discard / preview toggle ──────────────────────────────
async function doSave() {
  // Never save content that was not loaded from BMP.
  if (!ctx || ctx.loadError || !surface || saving) return
  // A CVO is html + javascript as ONE object. Commit every dirty code field in
  // one gesture — saving only the active field silently stranded the other,
  // an easy way to lose edits when switching tabs before saving.
  const dirty = codeProps().filter(p => surface!.isDirty(p))
  if (!dirty.length) return
  const target = ctx.saveTarget === 'template' && ctx.template ? ctx.template : ctx.instance
  // Lock before the confirm so a second Cmd+S can't stack a dialog or a save.
  saving = true
  refreshActions()
  try {
    await doSaveInner(target, dirty)
  } finally {
    saving = false
    refreshActions()
  }
}

async function doSaveInner(target: StudioContext['instance'], dirty: StudioCodeProp[]): Promise<void> {
  const current = ctx
  if (!surface || !current) return
  const containsScript = mode.key === 'text'
    && dirty.some(prop => /<\s*script\b/i.test(surface!.textFor(prop)))
  const saveBody = containsScript
    ? `Write ${dirty.join(' and ')} to "${target.name || target.businessId || target.rid}"?\n\nTextElements cannot store <script>. BMP will remove it on save; use a Custom Visualization for executable HTML and JavaScript.`
    : `Write ${dirty.join(' and ')} to "${target.name || target.businessId || target.rid}"?`
  const ok = await confirmCommandModal({
    title: dirty.length > 1 ? `Save ${dirty.join(' + ')}` : `Save ${dirty[0]}`,
    body: saveBody,
    confirmLabel: 'Save',
    confirmVariant: 'success',
  })
  if (!ok) return

  // Check (one read of every saved field), write each as before, read back
  // once (editor-core/code-save.ts).
  const values: Record<string, { value: string; opened: string }> = {}
  for (const p of dirty) values[p] = { value: surface.textFor(p), opened: surface.loadedFor(p) ?? activeCode()[p] ?? '' }
  const environment = current.environment
  const result = await runCodeSave(values, {
    fetch: async props => {
      const r = await sendRequest({ type: 'STUDIO_FETCH_CODE', rid: target.rid, props, ...(environment ? { environment } : {}) })
      return r?.type === 'STUDIO_CODE_DATA' && r.ok && r.code
        ? { ok: true, code: r.code }
        : { ok: false, error: respError(r, 'no response') }
    },
    write: async (prop, value) => {
      const r = await sendRequest({
        type: 'SAVE_PROPERTY',
        environment,
        rid: target.rid,
        objectType: target.type || (mode.key === 'text' ? 'TextElement' : 'CustomVisualization'),
        property: prop,
        value,
        objectLabel: { name: target.name, businessId: target.businessId },
      })
      return r?.type === 'SAVE_RESULT' ? r : undefined
    },
    decide: async check => (await choiceModal({
      title: conflictTitle(check, dirty.join(' and ')),
      body: conflictBody(check, p => values[p]?.value),
      choices: conflictChoices(check),
    })) ?? 'cancel',
  })
  if (result.kind === 'cancelled') {
    logConsole('warn', result.check.state === 'changed'
      ? `Not saved: ${result.check.changes.map(c => c.prop).join(' and ')} ${CHANGED_IN_BMP}. Your edits are kept.`
      : 'Not saved: the check for changes in BMP could not be made. Your edits are kept.')
    return
  }
  if (result.kind === 'review') {
    for (const [p, v] of Object.entries(result.current)) surface.rebase(p, v)
    logConsole('warn', `${Object.keys(result.current).join(' and ')} ${CHANGED_IN_BMP}. Discard and the comparison now use the current BMP value; your edits are kept. Save again to write them.`)
    return
  }

  let adoptedStored = false
  let verified = false
  for (const o of result.props) {
    const p = o.prop as StudioCodeProp
    const submitted = values[p].value
    if (o.kind === 'failed') { logConsole('error', `Save failed for ${p}: ${o.error}`); continue }
    if (o.kind === 'saved-unverified') {
      surface.completeSave(p, { submitted, stored: submitted })
      activeCode()[p] = submitted
      logConsole('warn', `Wrote ${p}, but could not re-read it from BMP to confirm it: ${o.error}`)
      continue
    }
    if (o.kind === 'unknown') {
      if (o.outcome === 'saved') {
        const completion = surface.completeSave(p, { submitted, stored: submitted })
        activeCode()[p] = submitted
        adoptedStored ||= completion.adoptedStored
        verified = true
      }
      logConsole(o.outcome === 'saved' ? 'info' : 'warn', `${p}: ${unknownOutcomeLine(o.outcome)}`)
      continue
    }
    // The editor remains writable while BMP handles the request. Complete
    // against the submitted snapshot so text typed during the await remains
    // dirty instead of being mistaken for the value BMP stored.
    const completion = surface.completeSave(p, { submitted, stored: o.stored })
    activeCode()[p] = o.stored
    adoptedStored ||= completion.adoptedStored
    if (o.kind === 'saved') { verified = true; logConsole('info', `Saved ${p} to BMP`); continue }
    // What a server-side rewrite MEANS is mode-specific: a CVO save that
    // comes back different is a silent in-script rollback (error); a
    // TextElement save that comes back different is the sanitizer doing its
    // documented job (info). CodeSurface adopts the stored version only
    // when doing so cannot overwrite a newer edit.
    if (mode.rewriteSemantics === 'sanitizer') {
      verified = true
      logConsole('info', completion.newerEdits
        ? `BMP sanitized ${p} on save (active content and unsupported styling were removed). Your newer edit remains unsaved.`
        : `BMP sanitized ${p} on save (active content and unsupported styling were removed). The editor now shows the stored version.`)
    } else {
      logConsole('error', completion.newerEdits
        ? `${storedDiffersLine(p, o.stored)} Your newer edit remains unsaved; Discard returns to BMP's stored value.`
        : `${storedDiffersLine(p, o.stored)} Possible silent rollback; the editor now shows BMP's value.`)
    }
  }
  if (verified) {
    // Arm the "Saved" pulse only after the read-back confirmed it.
    lastSavedAt = Date.now()
    setTimeout(() => refreshActions(), SAVED_FLASH_MS)
  }
  if (adoptedStored) void runPreview() // show the server-canonical result
}

/** Export the object's source (every mode file) as a single round-trippable
 *  bundle — one download (no multi-file browser prompt), for backup/sharing. */
function doDownload() {
  if (!ctx || !surface) return
  const base = ctx.instance.businessId || ctx.instance.rid || mode.key
  const bundle: Record<string, unknown> = {
    schema: `crev-${mode.key}-source/1`,
    id: ctx.instance.businessId || null,
    rid: ctx.instance.rid,
    name: ctx.instance.name || null,
  }
  for (const f of mode.files) bundle[f.prop] = surface.textFor(f.prop)
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.${mode.key}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function doDiscard() {
  if (!ctx || !surface || !surface.isDirty(activeProp)) return
  const ok = await confirmModal({
    title: 'Discard changes?',
    body: `Revert ${activeProp} to the value BMP last reported. Your edits will be lost.`,
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  })
  if (!ok) return
  surface.discard()
  refreshActions()
  updateFileSwitch()
  void runPreview()
}

// Guard the overlay close when there are unsaved edits.
installDirtyGuards({ isDirty: anyDirty, count: dirtyCount, bodyText: 'Closing Studio loses the unsaved changes. Nothing has been written to BMP.' })
// Escape backs out one layer (the studio last); `?` lists the keys.
installWindowEscape()
installCheatSheetKey(() => studioSheet(mode))

void init()
