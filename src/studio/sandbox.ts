/**
 * CVO Studio — sandbox runtime.
 *
 * Runs inside an MV3 *sandboxed* page (manifest `sandbox.pages`): a unique
 * opaque origin with NO access to chrome.* or the privileged extension. It is
 * the only place CVO code runs. The studio creates a fresh frame of this page
 * for every render. The page announces readiness once, receives one
 * MessagePort, receives exactly one render request on that port, reproduces
 * BMP's CVO contract — `_data` whose `.element` is the container div — runs the
 * CVO's html + javascript, and reports console output, errors and height back
 * on the same port. Nothing is ever posted to `'*'` with data in it.
 *
 * No eval: the CVO javascript is wrapped in a function expression and run as
 * the text of a <script> element (the sandbox policy allows inline script but
 * not 'unsafe-eval'). Code or libraries that call eval / new Function get a
 * CSP error, which is reported with EVAL_BLOCKED_MESSAGE.
 *
 * The render core (freshRoot / runCvo / defineCvoFunction / installConsoleCapture)
 * and the shell (bootSandbox) are exported and exercised by the sandbox tests.
 */

import {
  isCvoPortHandoff,
  parseCvoRenderRequest,
  type CvoErrorMessage,
  type CvoLib,
  type CvoRenderRequest,
  type CvoSandboxOutbound,
} from './cvo-protocol'

/** Local alias kept for readability in this file's render core. */
export type RenderRequest = CvoRenderRequest
export type Emit = (msg: CvoSandboxOutbound) => void
/** Runs a classic script text in `doc` (the default appends a <script>). Tests
 *  pass a stand-in because the unit-test DOM does not execute scripts. */
export type ScriptRunner = (doc: Document, text: string) => void

/** Shown when CVO code or one of its libraries calls eval / new Function. */
export const EVAL_BLOCKED_MESSAGE = 'This code uses eval, which the preview does not allow. It still runs in the portal.'

/** Source name of the wrapped CVO script; stack frames name it, which is how
 *  an error position is found and mapped back to the user's line. */
export const CVO_SOURCE_URL = 'cvo-preview.js'
/** Lines the wrapper adds above the user's first line. */
export const CVO_LINE_OFFSET = 1
const DEFINE_SLOT = '__cvoPreviewDefine'

/** Serialise a console argument compactly for the studio's console strip. */
export function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}

/** Default ScriptRunner: a classic inline <script>. Its text is set through
 *  the DOM, never parsed as HTML, so a `</script>` sequence inside the code is
 *  plain JavaScript text and needs no escaping. Inline scripts inserted this
 *  way run synchronously during appendChild. */
export const appendScript: ScriptRunner = (doc, text) => {
  const s = doc.createElement('script')
  s.textContent = text
  ;(doc.head ?? doc.documentElement).appendChild(s)
  s.remove()
}

/** Inject hosted libraries as classic <script> elements (global scope, so UMD
 *  globals like `echarts` attach to window) BEFORE the CVO runs. Tagged
 *  `data-cvo-lib`; each carries a sourceURL naming its rid so stack traces say
 *  which library failed. */
export function injectLibs(doc: Document, libs: CvoLib[]): void {
  for (const lib of libs) {
    const s = doc.createElement('script')
    s.setAttribute('data-cvo-lib', lib.rid)
    s.textContent = `${lib.content}\n//# sourceURL=cvo-lib-${lib.rid}.js`
    doc.head.appendChild(s)
  }
}

/** A fetched lib paired with the blob URL minted for it (see rewriteDownloadUrls). */
export interface SandboxLib extends CvoLib {
  blobUrl: string
}

/** Rewrite a CVO's own `web/download?...&rid=<rid>` references to the blob URL
 *  of the fetched lib content, for every lib by rid. CVOs load hosted resources
 *  with a RELATIVE url (the portal resolves it under /<workspace>/); in the
 *  sandbox that same url resolves under the extension origin and 404s — fatally
 *  so for a dynamic `import()`, which a global <script> injection can't satisfy.
 *  Rewriting to a same-content blob URL makes import() resolve (the sandbox
 *  policy allows `blob:` scripts). Matches a contiguous url token (no
 *  quotes/space/parens) so it works whether the url is absolute
 *  (`/web/download?...`) or relative (`web/...`).
 *
 *  Known gap: a url assembled at runtime (`import("web/download?rid=" + ridVar)`)
 *  has no literal token to rewrite, so it still fails. */
export function rewriteDownloadUrls(text: string, libs: SandboxLib[]): string {
  let out = text
  for (const lib of libs) {
    const re = new RegExp(
      `[^"'\`()\\s]*\\bweb/download\\?[^"'\`()\\s]*\\brid=${lib.rid}\\b[^"'\`()\\s]*`,
      'g',
    )
    out = out.replace(re, lib.blobUrl)
  }
  return out
}

/** Replace the render container wholesale so teardown is total — no stale
 *  nodes, listeners, or `dataset` guard flags survive between runs. */
export function freshRoot(doc: Document): HTMLElement {
  const old = doc.getElementById('cvo-root')
  if (old) old.remove()
  const root = doc.createElement('div')
  root.id = 'cvo-root'
  doc.body.appendChild(root)
  return root
}

/** Message tag an injected inner-iframe height reporter posts up to the sandbox. */
export const CVO_INNER_FRAME_HEIGHT = '__cvoInnerFrameHeight'

/** A common CVO pattern wraps its content in a self-sizing `<iframe srcdoc>` that
 *  grows itself with `window.frameElement.style.height = documentElement.scrollHeight`.
 *  In the portal that works (the CVO iframe is same-origin with the page); in OUR
 *  sandbox it can't — the sandbox is an opaque origin (manifest `sandbox`, no
 *  `allow-same-origin`), so the inner document's `frameElement` access is cross-origin
 *  and throws. The CVO's own `try/catch` swallows it and the inner iframe stays stuck
 *  at its `min-height`, clipping everything below.
 *
 *  We must NOT add `allow-same-origin` (that would hand CVO code the extension
 *  origin). Instead a tiny reporter is injected into each inner srcdoc — an
 *  opaque-origin child CAN `postMessage` up to this sandbox document — and the
 *  inner iframe is sized from the height it reports. The reporter only sends a
 *  height. */
export function wireSelfSizingIframes(root: HTMLElement): void {
  const frames = root.querySelectorAll('iframe[srcdoc]')
  frames.forEach((el, i) => {
    const iframe = el as HTMLIFrameElement
    iframe.dataset.cvoFrame = String(i)
    const reporter =
      `<script>(function(){var p=function(){try{parent.postMessage(` +
      `{t:'${CVO_INNER_FRAME_HEIGHT}',i:${i},h:document.documentElement.scrollHeight},'*')}catch(e){}};` +
      `if(window.ResizeObserver){new ResizeObserver(p).observe(document.documentElement)}` +
      `addEventListener('load',p);setTimeout(p,50);setTimeout(p,400)})()</script>`
    iframe.setAttribute('srcdoc', (iframe.getAttribute('srcdoc') || '') + reporter)
  })
}

/** The script text that defines the CVO function. The user's code is the body
 *  of `function (_data) { … }`, the same shape `new Function('_data', code)`
 *  had: top-level `return` is allowed, top-level `var` and function
 *  declarations stay local, a leading 'use strict' still applies. The wrapper
 *  line is above the user's first line (CVO_LINE_OFFSET) and the closing line
 *  below the last, so a user line N is script line N + CVO_LINE_OFFSET.
 *
 *  One difference from the Function constructor: code with an unbalanced `}`
 *  that closes the wrapper early is not a syntax error here; the code after it
 *  runs at global scope of the same sandbox document. That gives the code no
 *  reach it does not already have. */
export function buildCvoScript(javascript: string): string {
  return `window.${DEFINE_SLOT}(function (_data) {\n${javascript}\n});\n//# sourceURL=${CVO_SOURCE_URL}`
}

/** Map a line of the wrapped script to the user's line (1-based), clamped to
 *  the user's code. Undefined when the line is unknown. */
export function mapCvoLine(scriptLine: number | undefined, javascript: string): number | undefined {
  if (!scriptLine || scriptLine < 1) return undefined
  const userLines = javascript.split('\n').length
  return Math.min(userLines, Math.max(1, scriptLine - CVO_LINE_OFFSET))
}

const CVO_FRAME = /cvo-preview\.js:(\d+):(\d+)/

/** Position of the first stack frame in the CVO's own code, in user lines. */
export function cvoPositionFromStack(stack: string | undefined, javascript: string): { line: number; column: number } | undefined {
  const m = stack ? CVO_FRAME.exec(stack) : null
  if (!m) return undefined
  const line = mapCvoLine(Number(m[1]), javascript)
  return line === undefined ? undefined : { line, column: Number(m[2]) }
}

/** Rewrite every `cvo-preview.js:L:C` in a stack to the user's line numbers. */
export function remapCvoStack(stack: string | undefined, javascript: string): string | undefined {
  if (!stack) return stack
  return stack.replace(/cvo-preview\.js:(\d+):(\d+)/g, (_m, l: string, c: string) =>
    `${CVO_SOURCE_URL}:${mapCvoLine(Number(l), javascript) ?? l}:${c}`)
}

/** True when an error (or its message) is the CSP refusal of eval / new Function. */
export function isEvalBlocked(err: unknown, message = ''): boolean {
  if (typeof EvalError !== 'undefined' && err instanceof EvalError) return true
  const text = `${message} ${err instanceof Error ? err.message : typeof err === 'string' ? err : ''}`
  return /Refused to evaluate a string as JavaScript|'unsafe-eval'/i.test(text)
}

/** Build the CVO_ERROR for a thrown value: eval refusals get the plain
 *  EVAL_BLOCKED_MESSAGE; positions in the CVO's code are given in user lines. */
export function errorMessageFor(runId: number, err: unknown, javascript: string, fallback = 'Uncaught error'): CvoErrorMessage {
  const e = err instanceof Error ? err : undefined
  const message = isEvalBlocked(err, fallback) ? EVAL_BLOCKED_MESSAGE : e?.message || (typeof err === 'string' ? err : fallback)
  const out: CvoErrorMessage = { type: 'CVO_ERROR', runId, message }
  const stack = remapCvoStack(e?.stack, javascript)
  if (stack) out.stack = stack
  const pos = cvoPositionFromStack(e?.stack, javascript)
  if (pos) { out.line = pos.line; out.column = pos.column }
  return out
}

/** The JavaScript error message alone: without the browser's "Uncaught "
 *  and the DOM call Chrome names for a script inserted with appendChild
 *  ("Failed to execute 'appendChild' on 'Node': "), which is the preview's
 *  own mechanism, not the user's code. */
export function plainScriptError(raw: string): string {
  return raw.replace(/^Uncaught /, '').replace(/Failed to execute '[^']{1,40}' on '[^']{1,40}': /, '')
}

let defining = false
/** True while the CVO script is being defined; the shell's global error
 *  listener ignores that window so a syntax error is reported once. */
export const isDefiningCvo = (): boolean => defining

type DefineResult =
  | { fn: (data: unknown) => unknown }
  | { error: { message: string; line?: number; column?: number } }

/** Define the CVO function by running the wrapped script. A syntax error fires
 *  the window `error` event during the run (not a throw), so it is caught by a
 *  listener held for exactly that run. When neither the function nor an error
 *  appears, the policy blocked the inline script. */
export function defineCvoFunction(doc: Document, javascript: string, run: ScriptRunner = appendScript): DefineResult {
  const win = doc.defaultView as (Window & Record<string, unknown>) | null
  if (!win) return { error: { message: 'The preview has no window to run the code in.' } }
  let fn: ((data: unknown) => unknown) | null = null
  let syntax: ErrorEvent | null = null
  win[DEFINE_SLOT] = (f: unknown) => { if (!fn && typeof f === 'function') fn = f as (data: unknown) => unknown }
  const onError = (ev: ErrorEvent) => { syntax ??= ev; ev.preventDefault() }
  win.addEventListener('error', onError)
  defining = true
  try {
    run(doc, buildCvoScript(javascript))
  } finally {
    defining = false
    win.removeEventListener('error', onError)
    delete win[DEFINE_SLOT]
  }
  if (fn) return { fn }
  const ev = syntax as ErrorEvent | null
  if (ev) {
    const raw = ev.message || 'SyntaxError'
    const message = isEvalBlocked(ev.error, raw) ? EVAL_BLOCKED_MESSAGE : plainScriptError(raw)
    const line = mapCvoLine(ev.lineno, javascript)
    return { error: { message, ...(line ? { line } : {}), ...(line && ev.colno ? { column: ev.colno } : {}) } }
  }
  return { error: { message: 'The preview did not run the code: the preview security policy blocked the script.' } }
}

/** Run one CVO into `root`: reproduce the `_data` contract (`.element` = root),
 *  inject the html, then run the javascript with `_data` in scope. Reports a
 *  thrown or syntax error (the silent-blank-widget failure, surfaced) and the
 *  terminal CVO_RENDERED. Console capture is installed separately so it also
 *  catches async logs after this returns. */
export function runCvo(root: HTMLElement, req: RenderRequest, emit: Emit, run: ScriptRunner = appendScript): void {
  const runId = req.runId
  // `_data` is a parameter of the wrapper function — equivalent to BMP's
  // eval-with-_data-in-scope for code that reads it, and scoped to this call.
  const data = { ...req.data, element: root }

  try {
    // innerHTML deliberately does NOT execute inline <script> or inline event
    // handlers in the html — this matches BMP (dangerouslySetInnerHTML). All
    // behaviour comes from the `javascript` field run below. Do NOT switch to
    // a method that runs inline scripts from the html.
    root.innerHTML = req.html
  } catch (e) {
    emit({ type: 'CVO_ERROR', runId, message: `Failed to set html: ${(e as Error).message}` })
  }

  wireSelfSizingIframes(root)

  if (req.javascript.trim()) {
    const defined = defineCvoFunction(root.ownerDocument, req.javascript, run)
    if ('error' in defined) {
      emit({ type: 'CVO_ERROR', runId, ...defined.error })
      emit({ type: 'CVO_RENDERED', runId, ok: false })
      return
    }
    try {
      // A plain call, like the Function constructor result was called: `this`
      // is the global object in sloppy code and undefined under 'use strict'.
      const fn = defined.fn
      fn(data)
    } catch (e) {
      emit(errorMessageFor(runId, e, req.javascript))
      emit({ type: 'CVO_RENDERED', runId, ok: false })
      return
    }
  }
  emit({ type: 'CVO_RENDERED', runId, ok: true })
}

/** Forward the sandbox's console to the studio so a CVO's logs/warnings are
 *  visible. Permanent (not scoped to one run) so async logs are caught too.
 *  Returns a restore fn (used by tests). */
export function installConsoleCapture(emit: Emit, getRunId: () => number): () => void {
  const levels = ['log', 'warn', 'error', 'info'] as const
  const originals = levels.map(l => console[l])
  levels.forEach((level, i) => {
    console[level] = (...args: unknown[]) => {
      originals[i](...args)
      emit({ type: 'CVO_CONSOLE', runId: getRunId(), level, text: args.map(fmtArg).join(' ') })
    }
  })
  return () => { levels.forEach((level, i) => { console[level] = originals[i] }) }
}

/** Pass on only the first EVAL_BLOCKED_MESSAGE error: the thrown EvalError and
 *  the policy-violation event both report the same refusal. */
export function onceForEval(emit: Emit): Emit {
  let sent = false
  return msg => {
    if (msg.type === 'CVO_ERROR' && msg.message === EVAL_BLOCKED_MESSAGE) {
      if (sent) return
      sent = true
    }
    emit(msg)
  }
}

/** The fields of a `securitypolicyviolation` event this module reads. */
export interface ViolationLike { blockedURI: string; effectiveDirective: string }

/** Report policy violations: an eval refusal as EVAL_BLOCKED_MESSAGE (also when
 *  the code caught the EvalError itself), anything else once per directive and
 *  origin as a warning. */
export function violationReporter(emit: Emit, getRunId: () => number): (ev: ViolationLike) => void {
  const seen = new Set<string>()
  return ev => {
    const runId = getRunId()
    if (ev.blockedURI === 'eval') { emit({ type: 'CVO_ERROR', runId, message: EVAL_BLOCKED_MESSAGE }); return }
    let where = ev.blockedURI || 'a resource'
    try { where = new URL(ev.blockedURI).origin } catch { /* inline, data, … */ }
    const key = `${ev.effectiveDirective} ${where}`
    if (seen.has(key)) return
    seen.add(key)
    emit({ type: 'CVO_CONSOLE', runId, level: 'warn', text: `The preview blocked ${where} (${ev.effectiveDirective}). Preview code has no network access.` })
  }
}

export interface SandboxShellOptions {
  /** The embedder; defaults to `win.parent`. */
  parent?: Pick<Window, 'postMessage'>
  run?: ScriptRunner
}

/** Wire the render core to the embedder. Announces readiness once (no data),
 *  takes the first port the parent hands over, and accepts exactly one render
 *  request on it. Every result goes out on that port. Returns a teardown used
 *  by tests. */
export function bootSandbox(win: Window, opts: SandboxShellOptions = {}): () => void {
  const doc = win.document
  const parent = opts.parent ?? win.parent
  let port: MessagePort | null = null
  let runId = 0
  let rendered = false
  let javascript = ''
  const post: Emit = onceForEval(msg => { port?.postMessage(msg) })
  const cleanups: Array<() => void> = []
  const listen = <K extends keyof WindowEventMap>(type: K, fn: (ev: WindowEventMap[K]) => void) => {
    win.addEventListener(type, fn)
    cleanups.push(() => win.removeEventListener(type, fn))
  }

  cleanups.push(installConsoleCapture(post, () => runId))

  // Report the rendered content height so the studio grows the iframe to fit.
  // `document.body.scrollHeight` is the true content height, so it grows and
  // shrinks correctly; rAF-coalesced; a ResizeObserver catches async growth.
  let heightRaf = 0
  const reportHeight = () => {
    if (heightRaf || !port) return
    heightRaf = win.requestAnimationFrame(() => {
      heightRaf = 0
      post({ type: 'CVO_HEIGHT', runId, height: Math.ceil(doc.body.scrollHeight) })
    })
  }
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(reportHeight)
    ro.observe(doc.body)
    cleanups.push(() => ro.disconnect())
  }

  // Self-sizing inner `<iframe srcdoc>` CVOs report their content height here
  // (see wireSelfSizingIframes). Accepted only from that inner frame's window.
  listen('message', ev => {
    const d = ev.data as { t?: unknown; i?: unknown; h?: unknown } | undefined
    if (!d || d.t !== CVO_INNER_FRAME_HEIGHT || typeof d.i !== 'number' || typeof d.h !== 'number' || !Number.isFinite(d.h)) return
    const inner = doc.querySelector<HTMLIFrameElement>(`iframe[data-cvo-frame="${d.i}"]`)
    if (!inner || inner.contentWindow !== ev.source) return
    inner.style.height = `${Math.min(100_000, Math.max(0, Math.ceil(d.h)))}px`
  })

  listen('error', ev => {
    if (isDefiningCvo()) return
    const msg = errorMessageFor(runId, ev.error, javascript, ev.message || 'Uncaught error')
    if (msg.message !== EVAL_BLOCKED_MESSAGE && ev.message) msg.message = plainScriptError(ev.message)
    // No stack (a non-Error was thrown): fall back to the event's position
    // when it names the CVO script.
    if (msg.line === undefined && ev.filename?.endsWith(CVO_SOURCE_URL)) {
      const line = mapCvoLine(ev.lineno, javascript)
      if (line) { msg.line = line; if (ev.colno) msg.column = ev.colno }
    }
    post(msg)
  })
  listen('unhandledrejection', ev => {
    const reason: unknown = ev.reason
    post(reason instanceof Error
      ? errorMessageFor(runId, reason, javascript)
      : { type: 'CVO_ERROR', runId, message: `Unhandled rejection: ${fmtArg(reason)}` })
  })
  const onViolation = violationReporter(post, () => runId)
  const violationListener = (ev: Event) => onViolation(ev as unknown as ViolationLike)
  doc.addEventListener('securitypolicyviolation', violationListener)
  cleanups.push(() => doc.removeEventListener('securitypolicyviolation', violationListener))

  const render = (req: RenderRequest) => {
    runId = req.runId
    javascript = req.javascript
    // Libs first (sync <script> execution defines globals), then the CVO with
    // its download-url references rewritten to the libs' blob URLs. The frame
    // is discarded after this render, so the blob URLs die with it.
    const libs = req.libs ?? []
    const sandboxLibs: SandboxLib[] = libs.map(l => ({
      ...l,
      blobUrl: URL.createObjectURL(new Blob([l.content], { type: 'text/javascript' })),
    }))
    injectLibs(doc, libs)
    runCvo(freshRoot(doc), {
      ...req,
      html: rewriteDownloadUrls(req.html, sandboxLibs),
      javascript: rewriteDownloadUrls(req.javascript, sandboxLibs),
    }, post, opts.run)
    reportHeight()
  }

  // The port arrives once, from the parent. A later hand-off, a message from
  // anywhere else, and anything posted on the window are ignored.
  listen('message', ev => {
    if (port || ev.source !== parent || !isCvoPortHandoff(ev.data) || ev.ports.length !== 1) return
    port = ev.ports[0]
    port.onmessage = (e: MessageEvent) => {
      if (rendered) return
      const req = parseCvoRenderRequest(e.data)
      if (!req) return
      rendered = true
      render(req)
    }
  })
  cleanups.push(() => { port?.close() })

  // Readiness carries no data, so the wildcard target exposes nothing.
  parent.postMessage({ type: 'CVO_SANDBOX_READY' }, '*')

  return () => { cleanups.forEach(fn => fn()) }
}

// Skipped under test (no parent embedder); the exports above are tested directly.
if (typeof window !== 'undefined' && window.parent !== window) {
  bootSandbox(window)
}
