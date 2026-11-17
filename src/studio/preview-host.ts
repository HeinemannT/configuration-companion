/**
 * CVO preview frames, studio side.
 *
 * Every render gets a NEW sandbox frame; the frame it replaces is removed. The
 * new frame loads hidden next to the shown one and takes its place when it
 * reports CVO_RENDERED, so the preview does not flash. Each frame announces
 * readiness once (CVO_SANDBOX_READY on the window); the host then transfers one
 * MessagePort to that frame and sends the render request, including any live
 * `_data`, on the port only. Results come back on the same port and are
 * validated (parseCvoSandboxOutbound) before use.
 *
 * Why a frame that navigated away gets nothing: the render data is sent once,
 * on a port held by the sandbox document that asked for it. A document that
 * replaces it does not have the port, and the next render goes to a different,
 * new frame. The port is handed over before any CVO or library code has run in
 * that frame, so no code of the CVO can navigate the frame before the hand-off.
 */
import {
  parseCvoSandboxOutbound,
  type CvoConsoleMessage,
  type CvoErrorMessage,
  type CvoPortHandoff,
  type CvoRenderRequest,
} from './cvo-protocol'

/** Class of a frame that is still loading behind the shown one. */
export const PENDING_FRAME_CLASS = 'studio-sandbox--pending'

/** The line for preview code that navigated its own frame. */
export const LEFT_PREVIEW_MESSAGE = 'The preview code tried to leave the preview. That is blocked.'

export interface PreviewHostOptions {
  /** Where frames are mounted (null: no preview pane, nothing is rendered). */
  mountPoint: () => HTMLElement | null
  /** A new, unattached frame that loads the sandbox page. */
  createFrame: () => HTMLIFrameElement
  /** Console and error output of the newest run. */
  onOutput: (msg: CvoConsoleMessage | CvoErrorMessage) => void
  /** Window that receives the frames' readiness messages. */
  win?: Window
  /** Origin a sandbox page posts from. A manifest sandbox page is an opaque
   *  origin, which serialises as "null". */
  sandboxOrigin?: string
}

interface FrameEntry {
  frame: HTMLIFrameElement
  req: CvoRenderRequest
  port: MessagePort | null
  /** Load events of the frame: the first is the sandbox page itself. */
  loads: number
  /** This frame replaces one whose code navigated it. */
  replacement?: true
}

export class PreviewHost {
  private current: FrameEntry | null = null
  private pending: FrameEntry | null = null
  private readonly win: Window
  private readonly sandboxOrigin: string

  constructor(private readonly opts: PreviewHostOptions) {
    this.win = opts.win ?? window
    this.sandboxOrigin = opts.sandboxOrigin ?? 'null'
    this.win.addEventListener('message', this.onWindowMessage)
  }

  /** Render in a new frame. A frame still loading for an older request is
   *  dropped; the shown frame stays until the new one has rendered. */
  render(req: CvoRenderRequest): void {
    this.mount(req)
  }

  private mount(req: CvoRenderRequest, replacement = false): void {
    this.discard(this.pending)
    this.pending = null
    const mount = this.opts.mountPoint()
    if (!mount) return
    const frame = this.opts.createFrame()
    if (this.current) frame.classList.add(PENDING_FRAME_CLASS)
    const entry: FrameEntry = { frame, req, port: null, loads: 0, ...(replacement ? { replacement: true as const } : {}) }
    frame.addEventListener('load', () => this.onFrameLoad(entry))
    this.pending = entry
    mount.appendChild(frame)
  }

  /** A load after the sandbox page's own, once the frame holds its port:
   *  the preview code navigated the frame (the navigation is blocked and
   *  the frame would show the browser's error page). The frame is replaced
   *  at once by a fresh render of the same request, with one line in the
   *  error output. Code that navigates again in the replacement leaves the
   *  preview empty instead of rendering in a loop. */
  private onFrameLoad(entry: FrameEntry): void {
    entry.loads++
    if (entry.loads < 2 || !entry.port) return
    if (entry !== this.current && entry !== this.pending) return
    const wasCurrent = entry === this.current
    this.discard(entry)
    if (wasCurrent) this.current = null
    else this.pending = null
    if (entry.replacement) return
    this.opts.onOutput({ type: 'CVO_ERROR', runId: entry.req.runId, message: LEFT_PREVIEW_MESSAGE })
    // A newer render already loading takes the place; otherwise render again.
    if (!this.pending) this.mount(entry.req, true)
  }

  /** Remove every frame and close every port (the shell was rebuilt, or the
   *  preview pane closed). */
  reset(): void {
    this.discard(this.pending)
    this.discard(this.current)
    this.pending = null
    this.current = null
  }

  dispose(): void {
    this.reset()
    this.win.removeEventListener('message', this.onWindowMessage)
  }

  /** The frames currently in the DOM (tests and layout code). */
  frames(): HTMLIFrameElement[] {
    return [this.current?.frame, this.pending?.frame].filter((f): f is HTMLIFrameElement => !!f)
  }

  private discard(entry: FrameEntry | null): void {
    if (!entry) return
    entry.port?.close()
    entry.port = null
    entry.frame.remove()
  }

  private readonly onWindowMessage = (ev: MessageEvent): void => {
    const entry = this.pending
    // Only the frame waiting for its port, only once, only from the sandbox
    // origin, and only the readiness message.
    if (!entry || entry.port) return
    const target = entry.frame.contentWindow
    if (!target || ev.source !== target) return
    if (ev.origin !== this.sandboxOrigin) return
    if (parseCvoSandboxOutbound(ev.data)?.type !== 'CVO_SANDBOX_READY') return
    const channel = new MessageChannel()
    entry.port = channel.port1
    channel.port1.onmessage = (e: MessageEvent) => this.onPortMessage(entry, e.data)
    // The target origin must be '*': the sandbox document has an opaque
    // origin, which cannot be named. The message carries only the port.
    const handoff: CvoPortHandoff = { type: 'CVO_PORT' }
    target.postMessage(handoff, '*', [channel.port2])
    channel.port1.postMessage(entry.req)
  }

  private onPortMessage(entry: FrameEntry, data: unknown): void {
    if (entry !== this.current && entry !== this.pending) return
    const msg = parseCvoSandboxOutbound(data)
    if (!msg || msg.type === 'CVO_SANDBOX_READY' || msg.runId !== entry.req.runId) return
    if (msg.type === 'CVO_HEIGHT') { entry.frame.style.height = `${msg.height}px`; return }
    if (msg.type === 'CVO_RENDERED') { if (entry === this.pending) this.promote(entry); return }
    // While a newer frame is loading, output of the shown (older) one is stale.
    if (this.pending && entry !== this.pending) return
    this.opts.onOutput(msg)
  }

  private promote(entry: FrameEntry): void {
    this.discard(this.current)
    entry.frame.classList.remove(PENDING_FRAME_CLASS)
    this.current = entry
    this.pending = null
  }
}

/** One console line for a CVO error, with the user's line number when known. */
export function formatCvoError(msg: CvoErrorMessage): string {
  const text = msg.message || 'Error'
  if (!msg.line) return text
  return `${text} (line ${msg.line}${msg.column ? `, column ${msg.column}` : ''})`
}
