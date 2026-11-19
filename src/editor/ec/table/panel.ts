/**
 * The "Table" tab of the bottom panel: the last preview's table as a grid, the
 * property under each header, a footer per column, and the column under the
 * cursor highlighted. Clicking a column moves the cursor to its line.
 */
import { h } from '../../../lib/dom'
import { activeColumn, tableAt, type TableModel } from './model'
import { columnStats, columnValues, footerText, type Freshness, type PreviewData } from './preview'

export interface TablePanelInput {
  preview: PreviewData | null
  freshness: Freshness | null
  /** Tables of the code as it is now, and which one the preview belongs to. */
  tables: readonly TableModel[]
  target: number
  cursor: number
  onPreview(): void
  /** Move the editor cursor to this offset. */
  onJump(offset: number): void
}

/** What the panel highlights, so the editor re-renders it only when this changes. */
export function panelSignature(i: Pick<TablePanelInput, 'preview' | 'freshness' | 'tables' | 'target' | 'cursor'>): string {
  const col = highlightedColumn(i)
  return `${i.preview?.preview.at ?? 0}|${i.freshness?.state ?? '-'}|${col ?? '-'}|${i.tables.length}`
}

function highlightedColumn(i: Pick<TablePanelInput, 'tables' | 'target' | 'cursor' | 'freshness'>): number | null {
  if (!i.freshness || i.freshness.state === 'stale') return null
  const t = i.tables[i.target]
  if (!t || !tableAt([t], i.cursor)) return null
  return activeColumn(t, i.cursor)
}

/** Rows drawn in the grid. The footers still describe every row of the preview. */
const MAX_ROWS = 500

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function renderTablePanel(i: TablePanelInput): HTMLElement {
  const data = i.preview
  if (!data || !data.table) {
    return h('div', { class: 'cm-tbl-empty' },
      h('div', null, data ? 'The last preview has no table in its output.' : 'No preview of a table yet.'),
      h('button', { class: 'btn btn-accent', type: 'button', onClick: () => i.onPreview() }, 'Preview'),
    )
  }
  const table = data.table
  const prevTable = data.tables[data.target]
  const active = highlightedColumn(i)
  const current = i.tables[i.target]
  const canJump = i.freshness !== null && i.freshness.state !== 'stale' && current !== undefined

  // Output column -> column of the code (when the output was mapped).
  const codeColumn = new Map<number, number>()
  data.mapping?.forEach((out, ci) => { if (out !== null) codeColumn.set(out, ci) })

  const jump = (outIndex: number): void => {
    const ci = codeColumn.get(outIndex)
    if (ci === undefined || !canJump) return
    const col = current.columns[ci]
    if (!col) return
    i.onJump(col.call ? col.call.nameFrom : col.from)
  }

  const meta: Array<HTMLElement | string> = [
    h('span', { class: 'cm-tbl-tab-k' }, 'Preview'),
    h('span', { class: 'cm-tbl-tab-dim' }, `${table.rows.length} rows`),
  ]
  if (data.preview.durationMs != null) meta.push(h('span', { class: 'cm-tbl-tab-dim' }, `${(data.preview.durationMs / 1000).toFixed(1)} s`))
  meta.push(h('span', { class: 'cm-tbl-tab-dim' }, clock(data.preview.at)))
  const edited = i.freshness !== null && i.freshness.state !== 'fresh'

  const head = table.headers.map((hd, oi) => {
    const ci = codeColumn.get(oi)
    const col = ci !== undefined ? prevTable?.columns[ci] : undefined
    const sub = col?.propIdent ?? col?.prop ?? ''
    return h('th', {
      class: `${ci !== undefined && ci === active ? 'cm-tbl-col-active ' : ''}${canJump && ci !== undefined ? 'cm-tbl-col-link' : ''}`,
      title: canJump && ci !== undefined ? 'Go to this column in the code' : '',
      onClick: () => jump(oi),
    },
      h('div', { class: 'cm-tbl-th-label' }, hd || ' '),
      sub ? h('div', { class: 'cm-tbl-th-prop' }, sub) : null,
    )
  })

  const body = table.rows.slice(0, MAX_ROWS).map(r => h('tr', null, ...table.headers.map((_, oi) =>
    h('td', { class: ci(codeColumn, oi) === active && active !== null ? 'cm-tbl-col-active' : '' }, r[oi] ?? ''),
  )))
  if (table.rows.length > MAX_ROWS) {
    body.push(h('tr', { class: 'cm-tbl-more' }, h('td', { colspan: table.headers.length }, `Showing the first ${MAX_ROWS} of ${table.rows.length} rows. The footers describe all rows.`)))
  }

  const foot = table.headers.map((_, oi) => {
    const stats = columnStats(columnValues(table, oi))
    return h('td', { class: ci(codeColumn, oi) === active && active !== null ? 'cm-tbl-col-active' : '' }, footerText(stats))
  })

  return h('div', { class: 'cm-tbl-tab' },
    h('div', { class: 'cm-tbl-tab-head' }, ...meta,
      edited ? h('span', { class: 'cm-tbl-tab-stale' }, 'The code changed after this preview') : null,
      h('span', { class: 'cm-tbl-lens-spacer' }),
      h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => i.onPreview() }, 'Preview again'),
    ),
    h('div', { class: 'cm-tbl-scroll' },
      h('table', { class: 'cm-tbl-grid' },
        h('thead', null, h('tr', null, ...head)),
        h('tbody', null, ...body),
        h('tfoot', null, h('tr', null, ...foot)),
      ),
    ),
  )
}

function ci(map: Map<number, number>, outIndex: number): number | undefined {
  return map.get(outIndex)
}
