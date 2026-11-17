/**
 * Edit-reply parsing for the AI edit assistant: pull the code out of a model
 * reply, detect a whole-script rewrite of a partial selection, and decide the
 * outcome. Pure (no DOM), so the editor surface (editor-core/ai-assist) and
 * tests share one implementation.
 */
import { scrubToolMarkup } from './scrub'
import type { AiSelection } from './types'

// ── Edit-reply parsing (pure, shared with tests) ─────────────────

/** Compose the full document a replacement would produce — used both to apply
 *  an edit proposal and to detect a no-op (result byte-identical to the
 *  original). A selection scopes the replacement; otherwise it is the whole
 *  document. Exported for tests. */
export function composeReplacement(before: string, replacement: string, selection: AiSelection | null): string {
  return selection
    ? before.slice(0, selection.from) + replacement + before.slice(selection.to)
    : replacement
}

/** Every fenced code block's inner text, in document order. */
function extractFences(reply: string): string[] {
  const re = /```[^\n]*\n([\s\S]*?)```/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(reply)) !== null) out.push(m[1].replace(/\n$/, ''))
  return out
}

/** Pull the code out of an edit reply. With multiple fenced blocks, prefer the
 *  LAST one — on "fix this" instructions models often quote the broken original
 *  first and the corrected code second. If the chosen block is byte-identical to
 *  the code we sent (`current`), fall back to the last block that differs; a
 *  same-as-input block is not a real proposal. Falls back to the whole reply
 *  only when there is no fence and it doesn't read as prose. This frame-side
 *  function is the sole production owner of editor reply resolution. */
export function extractReplyCode(reply: string, current?: string): { code: string | null; error?: string } {
  // A DSML tool-markup leak (some providers emit their tool-call DSL as plain
  // text when the tool budget is spent) must never be spliced into the doc.
  // Scrub first so fence extraction sees clean text. Harmless for clean replies.
  reply = scrubToolMarkup(reply)
  const fences = extractFences(reply)
  if (fences.length) {
    let chosen = fences[fences.length - 1]
    // Skip a trailing EMPTY fence (whitespace-only). Splicing "" would silently
    // delete the selection — or WIPE the whole document on a whole-script scope,
    // one Accept away. Prefer the last non-empty block; if every fence is empty,
    // report no code rather than propose an erasure.
    if (chosen.trim() === '') {
      const nonEmpty = [...fences].reverse().find(f => f.trim() !== '')
      if (nonEmpty === undefined) return { code: null, error: 'The reply did not contain code.' }
      chosen = nonEmpty
    }
    if (current != null && chosen === current) {
      for (let i = fences.length - 2; i >= 0; i--) {
        if (fences[i] !== current && fences[i].trim() !== '') { chosen = fences[i]; break }
      }
    }
    return { code: chosen }
  }
  const trimmed = reply.trim()
  if (!trimmed) return { code: null, error: 'The reply was empty.' }
  if (looksLikeProse(trimmed)) return { code: null, error: 'The reply did not contain code.' }
  return { code: trimmed }
}

function looksLikeProse(text: string): boolean {
  const s = text.trim()
  if (!s) return true
  if (/^(here('s| is)\b|the\s|this\s|sure\b|i\s|to\s|note\b|you\s|sorry\b)/i.test(s)) return true
  const codeSignals = /[{};]|:=|=>|\bforEach\b|\bSELECT\b|\bfunction\b|<\/?[a-z]|\bconst\b|\blet\b|\breturn\b/i.test(s)
  const sentences = s.split(/[.!?](\s|$)/).filter(Boolean).length
  return !codeSignals && sentences >= 2
}

// ── Whole-doc-rewrite detection for scoped edits ─────────────────
//
// The CONFIRMED failure: the user selects a couple of lines and asks for a
// change that logically touches the whole script ("rename X everywhere"). The
// model helpfully returns the ENTIRE rewritten script. If we splice that whole
// script into the 2-line selection range, we duplicate the body — the diff is
// honest but the result is useless. This detects that case so the UI can offer
// "apply to the whole script" instead of silently corrupting the selection.
//
// Only ever fires for a PARTIAL selection (a whole-script scope already targets
// the full doc, so a full-length reply is exactly right). Two cheap signals,
// with a guard so it never fires when the selection already IS most of the doc:
//
//   Guard   — selection covers >= 50% of the document's lines → never fire
//             (a full-length reply is expected; this is the "selection IS most
//             of the doc" case the heuristic must NOT touch).
//   Signal A — the reply reproduces document text that lies OUTSIDE the
//             selection (the normalized leading and/or trailing context, when
//             that context is non-trivial: >= 12 normalized chars). If the model
//             echoed code we did not ask it to touch, it rewrote the whole doc.
//   Signal B — the reply is nearly as long as the whole document (>= 90% of its
//             lines) while the selection is only a small slice of it.
//
// Normalization collapses runs of whitespace and trims, so reflowed indentation
// or a reformatted body still matches. Thresholds are deliberately conservative:
// a false negative just falls back to the honest splice-and-diff path.
const WHOLE_DOC_MIN_CONTEXT = 12
const WHOLE_DOC_SELECTION_MAX_FRACTION = 0.5
const WHOLE_DOC_LINE_RATIO = 0.9

function normWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function countLines(s: string): number {
  if (s === '') return 0
  return s.split('\n').length
}

export function detectWholeDocRewrite(before: string, replacement: string, selection: AiSelection | null): boolean {
  if (!selection || selection.from === selection.to) return false
  const docLines = countLines(before)
  if (docLines === 0) return false
  const selLines = countLines(selection.text)

  // Guard: the selection already covers most of the document — a full-length
  // reply is expected, so the heuristic must not fire.
  if (selLines / docLines >= WHOLE_DOC_SELECTION_MAX_FRACTION) return false

  const body = normWhitespace(replacement)

  // Signal A: the reply echoes out-of-selection context (leading and/or
  // trailing document text). Non-trivial context only.
  const leading = normWhitespace(before.slice(0, selection.from))
  const trailing = normWhitespace(before.slice(selection.to))
  if (leading.length >= WHOLE_DOC_MIN_CONTEXT && body.includes(leading)) return true
  if (trailing.length >= WHOLE_DOC_MIN_CONTEXT && body.includes(trailing)) return true

  // Signal B: the reply is nearly the whole document by line count.
  if (countLines(replacement) >= WHOLE_DOC_LINE_RATIO * docLines) return true

  return false
}

// ── Edit-outcome resolver (pure, shared with tests) ──────────────

/** The full decision an edit reply produces, independent of DOM. finishEdit()
 *  is a thin consumer of this; the interaction matrix drives it directly so the
 *  document is provably never silently corrupted. */
export type EditOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'no-change' }
  /** Splice `replacement` into the selection (or replace the whole doc when the
   *  scope had no selection). `after` is the resulting document. */
  | { kind: 'proposal'; replacement: string; after: string }
  /** The model rewrote the whole script for a partial-selection scope. The UI
   *  must NOT splice into the selection; it offers "apply to whole script",
   *  which proposes `replacement` as the FULL document. */
  | { kind: 'whole-doc-choice'; replacement: string; wholeDocAfter: string }

/** Resolve a raw edit reply against the captured baseline + scope. Pure. */
export function resolveEdit(reply: string, before: string, selection: AiSelection | null): EditOutcome {
  const current = selection ? selection.text : before
  const { code, error } = extractReplyCode(reply, current)
  if (code == null) return { kind: 'error', message: error ?? 'The reply did not contain code.' }
  if (detectWholeDocRewrite(before, code, selection)) {
    return { kind: 'whole-doc-choice', replacement: code, wholeDocAfter: code }
  }
  const after = composeReplacement(before, code, selection)
  if (after === before) return { kind: 'no-change' }
  return { kind: 'proposal', replacement: code, after }
}
