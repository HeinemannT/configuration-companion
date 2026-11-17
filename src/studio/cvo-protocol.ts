/**
 * CVO studio ⇄ sandbox protocol — the single source of truth for the messages
 * exchanged between the privileged studio page and its sandboxed preview
 * iframe.
 *
 * Transport: each preview frame posts CVO_SANDBOX_READY once to its parent
 * window. The studio answers with CVO_PORT, which transfers one MessagePort;
 * the render request and every result after that travel on that port only.
 * A document that later replaces the frame's content does not hold the port,
 * so it receives nothing.
 *
 * This module is deliberately DEPENDENCY-FREE: no chrome.* typings, no imports
 * at all. That is what lets the sandbox entry (a separate, locked-down build
 * target) import it without dragging the privileged `lib/types` graph in — the
 * exact reason the two sides used to carry hand-copied, drift-prone duplicates.
 * Keep it that way; if you need a richer type here, inline it.
 */

/** Console levels the sandbox forwards to the studio's console panel. */
export type CvoConsoleLevel = 'log' | 'warn' | 'error' | 'info'

/** A hosted FileResource dependency, identified by rid so the sandbox can both
 *  run it as a global script (UMD libs) AND mint a blob URL to rewrite the CVO's
 *  own `web/download?...rid=<rid>` references to (so dynamic import()/script-src
 *  of that resource resolve in the sandbox instead of 404-ing on the ext origin). */
export interface CvoLib {
  rid: string
  content: string
}

/** studio → sandbox: render this CVO. `data` is the `_data` contract minus
 *  `.element`, which the sandbox attaches. `libs` are hosted-FileResource JS
 *  sources to run before the CVO so their globals are ready. */
export interface CvoRenderRequest {
  type: 'CVO_RENDER'
  /** Monotonic id so late console/errors from a superseded run can be dropped. */
  runId: number
  html: string
  javascript: string
  data: Record<string, unknown>
  libs?: CvoLib[]
}

/** sandbox → studio: a forwarded console call. */
export interface CvoConsoleMessage {
  type: 'CVO_CONSOLE'
  runId: number
  level: CvoConsoleLevel
  text: string
}

/** sandbox → studio: a thrown error / unhandled rejection from the CVO. */
export interface CvoErrorMessage {
  type: 'CVO_ERROR'
  runId: number
  message: string
  stack?: string
  line?: number
  column?: number
}

/** sandbox → studio: terminal signal for one render. */
export interface CvoRenderedMessage {
  type: 'CVO_RENDERED'
  runId: number
  ok: boolean
}

/** sandbox → studio: the one-shot handshake the sandbox posts once it's wired
 *  and ready to receive renders (no runId — it precedes any run). */
export interface CvoSandboxReady {
  type: 'CVO_SANDBOX_READY'
}

/** sandbox → studio: the rendered content height (px), so the studio grows the iframe to fit instead
 *  of clipping it to the pane. Sent after each render AND on later growth (a chart that lays out a tick
 *  later) via a ResizeObserver, so async content isn't cut off. */
export interface CvoHeightMessage {
  type: 'CVO_HEIGHT'
  runId: number
  height: number
}

/** studio → sandbox, sent once on the window channel right after the frame
 *  announced readiness: carries the MessagePort (in `ports`) that every later
 *  message uses. Holds no data itself. */
export interface CvoPortHandoff {
  type: 'CVO_PORT'
}

/** Everything the studio can receive from the sandbox. */
export type CvoSandboxOutbound =
  | CvoConsoleMessage
  | CvoErrorMessage
  | CvoRenderedMessage
  | CvoSandboxReady
  | CvoHeightMessage

/** Longest console text, error message or stack the studio accepts; longer
 *  text is cut to this length. */
export const CVO_TEXT_LIMIT = 20_000
/** Reported preview heights are clamped to 0..CVO_HEIGHT_MAX px. */
export const CVO_HEIGHT_MAX = 10_000

const CONSOLE_LEVELS: readonly CvoConsoleLevel[] = ['log', 'warn', 'error', 'info']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRunId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function clip(v: string): string {
  return v.length > CVO_TEXT_LIMIT ? `${v.slice(0, CVO_TEXT_LIMIT)}…` : v
}

/** A line or column number, or undefined when it is not a sane positive integer. */
function position(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 10_000_000 ? v : undefined
}

/** Clamp a reported content height to 0..CVO_HEIGHT_MAX px (whole pixels).
 *  Not a finite number → null (the message is dropped). */
export function clampPreviewHeight(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(CVO_HEIGHT_MAX, Math.max(0, Math.ceil(v)))
}

/** Validate an untrusted message from the preview frame. Returns a NEW object
 *  that holds only the known fields (strings cut to CVO_TEXT_LIMIT, height
 *  clamped), or null when the shape is wrong. Nothing from the input object is
 *  passed through by reference. */
export function parseCvoSandboxOutbound(v: unknown): CvoSandboxOutbound | null {
  if (!isRecord(v)) return null
  switch (v.type) {
    case 'CVO_SANDBOX_READY':
      return { type: 'CVO_SANDBOX_READY' }
    case 'CVO_CONSOLE': {
      if (!isRunId(v.runId) || typeof v.text !== 'string') return null
      const level = CONSOLE_LEVELS.find(l => l === v.level)
      if (!level) return null
      return { type: 'CVO_CONSOLE', runId: v.runId, level, text: clip(v.text) }
    }
    case 'CVO_ERROR': {
      if (!isRunId(v.runId) || typeof v.message !== 'string') return null
      if (v.stack !== undefined && typeof v.stack !== 'string') return null
      const out: CvoErrorMessage = { type: 'CVO_ERROR', runId: v.runId, message: clip(v.message) }
      if (typeof v.stack === 'string') out.stack = clip(v.stack)
      const line = position(v.line)
      const column = position(v.column)
      if (line !== undefined) out.line = line
      if (column !== undefined) out.column = column
      return out
    }
    case 'CVO_RENDERED':
      if (!isRunId(v.runId) || typeof v.ok !== 'boolean') return null
      return { type: 'CVO_RENDERED', runId: v.runId, ok: v.ok }
    case 'CVO_HEIGHT': {
      if (!isRunId(v.runId)) return null
      const height = clampPreviewHeight(v.height)
      if (height === null) return null
      return { type: 'CVO_HEIGHT', runId: v.runId, height }
    }
    default:
      return null
  }
}

/** Shape check only; parseCvoSandboxOutbound also returns the cleaned copy. */
export function isCvoSandboxOutbound(v: unknown): v is CvoSandboxOutbound {
  return parseCvoSandboxOutbound(v) !== null
}

/** The port hand-off message (the port itself travels in `MessageEvent.ports`). */
export function isCvoPortHandoff(v: unknown): v is CvoPortHandoff {
  return isRecord(v) && v.type === 'CVO_PORT'
}

/** Validate a render request on the sandbox side. Returns a new object with
 *  only the known fields, or null when the shape is wrong. */
export function parseCvoRenderRequest(v: unknown): CvoRenderRequest | null {
  if (!isRecord(v) || v.type !== 'CVO_RENDER') return null
  if (!isRunId(v.runId) || typeof v.html !== 'string' || typeof v.javascript !== 'string' || !isRecord(v.data)) return null
  let libs: CvoLib[] | undefined
  if (v.libs !== undefined) {
    if (!Array.isArray(v.libs)) return null
    libs = []
    for (const l of v.libs as unknown[]) {
      if (!isRecord(l) || typeof l.rid !== 'string' || !/^\d{1,20}$/.test(l.rid) || typeof l.content !== 'string') return null
      libs.push({ rid: l.rid, content: l.content })
    }
  }
  return { type: 'CVO_RENDER', runId: v.runId, html: v.html, javascript: v.javascript, data: v.data, ...(libs ? { libs } : {}) }
}
