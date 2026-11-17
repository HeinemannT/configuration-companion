import { describe, expect, it } from 'vitest'
import { canSave } from '../save-gate'

describe('canSave', () => {
  it('blocks the Save key when there are no unsaved changes', () => {
    expect(canSave(false, true)).toBe(false)
  })
  it('allows it with changes', () => {
    expect(canSave(true, true)).toBe(true)
  })
  it('blocks it without an editor surface', () => {
    expect(canSave(true, false)).toBe(false)
  })
})
