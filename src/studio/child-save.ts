/**
 * Studio data inputs (CVO children): what STUDIO_SAVE_CHILD is sent.
 *
 * The fields are sent as before, with two exceptions that keep the written
 * script identical to today's: a table reference that was empty and stays
 * empty, and a timeout that is unchanged and not a whole number, were
 * skipped by the handler before and are not sent now (the handler rejects
 * them with the field named instead of answering ok). `expect` carries the
 * opened value of every sent field and the key, for the changed-since-opened
 * check in the handler.
 *
 * Pure: no DOM, no chrome.*.
 */

import type { StudioChild, StudioChildField } from '../lib/types'

export type ChildFields = Partial<Record<StudioChildField, string>>

export interface ChildSaveRequest {
  fields: ChildFields
  expect: Partial<Record<'key' | StudioChildField, string>>
}

export function childSaveRequest(child: StudioChild, edited: ChildFields): ChildSaveRequest {
  const fields: ChildFields = {}
  const expect: ChildSaveRequest['expect'] = { key: child.key }
  for (const [field, value] of Object.entries(edited) as Array<[StudioChildField, string | undefined]>) {
    if (value == null) continue
    const opened = child[field] ?? ''
    if (field === 'table' && value === '' && opened === '') continue
    if (field === 'timeout' && value === opened && !/^\d+$/.test(value)) continue
    fields[field] = value
    expect[field] = opened
  }
  return { fields, expect }
}
