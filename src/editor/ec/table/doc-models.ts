/**
 * Memoised table models per document version. One parse per `Text`, shared by
 * the lens, the inline plugin, the linter, completion and the Table tab.
 */
import type { Text } from '@codemirror/state'
import { parseTables, type TableModel } from './model'

const memo = new WeakMap<Text, { text: string; tables: TableModel[] }>()

export function getTableModels(doc: Text): { text: string; tables: TableModel[] } {
  let hit = memo.get(doc)
  if (!hit) {
    const text = doc.toString()
    hit = { text, tables: parseTables(text) }
    memo.set(doc, hit)
  }
  return hit
}
