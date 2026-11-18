/**
 * CodeMirror wrapper for the WHERE property check (see whereProperties.ts).
 *
 * Fields come from the same cached type schema the property completions use
 * (FETCH_TYPE_SCHEMA through typeInference). A type counts as known only when
 * its schema loaded and lists built-in fields (`systemobject`, or `name` / `id`),
 * so an empty, failed or partial schema never produces a warning. A missing
 * schema is requested without blocking; the linter re-runs when it arrives.
 */
import { linter, forceLinting, type Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { TypeSchemaProp } from '../../lib/types'
import { canonicalType, ensureSchemaNow, getSchema, getSchemaError, subscribe } from './typeInference'
import { computeWherePropertyDiagnostics } from './whereProperties'

/** Accessors and business IDs of a fully loaded schema, else undefined. */
export function completeFields(props: TypeSchemaProp[] | undefined): string[] | undefined {
  if (!props || props.length === 0) return undefined
  const hasBuiltIns = props.some(p => p.systemobject || /^(name|id)$/i.test(p.accessor))
  if (!hasBuiltIns) return undefined
  const out: string[] = []
  for (const p of props) {
    if (p.accessor) out.push(p.accessor)
    if (p.propertyId) out.push(p.propertyId)
  }
  return out
}

const waiting = new WeakMap<EditorView, () => void>()

/** Re-run the linter once, after the next schema arrival. */
function relintOnArrival(view: EditorView): void {
  if (waiting.has(view)) return
  const unsubscribe = subscribe(() => {
    unsubscribe()
    waiting.delete(view)
    if (view.dom.isConnected) forceLinting(view)
  })
  waiting.set(view, unsubscribe)
}

export const wherePropertyLinter = linter((view: EditorView): Diagnostic[] => {
  let pending = false
  const diags = computeWherePropertyDiagnostics(view.state.doc.toString(), (type) => {
    const cls = canonicalType(type)
    const props = getSchema(cls)
    if (props) return completeFields(props)
    if (!getSchemaError(cls)) {
      pending = true
      ensureSchemaNow(cls)
    }
    return undefined
  })
  if (pending) relintOnArrival(view)
  return diags
})
