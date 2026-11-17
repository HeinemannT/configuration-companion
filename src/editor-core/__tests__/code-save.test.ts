// @vitest-environment happy-dom
/**
 * The Extended Code editor's and the Studio's save flow (code-save.ts) and
 * the editor's Execute wording: check, write, read back.
 */
import { describe, expect, it, vi } from 'vitest'
import { conflictBody, conflictChoices, executeOutcome, runCodeSave, type CodeSavePort } from '../code-save'
import { checkCodeBase, compareOpened, isOutcomeUnknown, outcomeAfterReread } from '../../lib/save-check'

/** A fake BMP holding code; `answer` decides what each write returns. */
function bmp(stored: Record<string, string>, opts: {
  answer?: (prop: string, value: string) => { ok: boolean; error?: string; outcomeUnknown?: boolean } | undefined
  apply?: boolean
  fetchFails?: (call: number) => boolean
  decide?: CodeSavePort['decide']
} = {}) {
  let fetches = 0
  const writes: Array<[string, string]> = []
  const port: CodeSavePort = {
    fetch: vi.fn(async (props: string[]) => {
      fetches++
      if (opts.fetchFails?.(fetches)) return { ok: false as const, error: 'Code read failed' }
      return { ok: true as const, code: Object.fromEntries(props.filter(p => stored[p] !== undefined && stored[p] !== '').map(p => [p, stored[p]])) }
    }),
    write: vi.fn(async (prop: string, value: string) => {
      writes.push([prop, value])
      const a = opts.answer ? opts.answer(prop, value) : { ok: true }
      if (opts.apply ?? (a?.ok ?? false)) stored[prop] = value
      return a
    }),
    decide: opts.decide ?? vi.fn(async () => 'cancel' as const),
    pause: vi.fn(async () => {}),
  }
  return { port, writes, stored, fetchCount: () => fetches }
}

describe('code save: changed since opened', () => {
  it('unchanged: one check read, the write exactly as given, one read-back, then saved', async () => {
    const b = bmp({ expression: '_sum := 2 + 3' })
    const res = await runCodeSave({ expression: { value: '_sum := 2 + 4', opened: '_sum := 2 + 3' } }, b.port)
    expect(b.writes).toEqual([['expression', '_sum := 2 + 4']])
    expect(b.fetchCount()).toBe(2)
    expect(b.port.decide).not.toHaveBeenCalled()
    expect(res).toEqual({ kind: 'done', checked: true, props: [{ prop: 'expression', kind: 'saved', stored: '_sum := 2 + 4' }] })
  })

  it('an empty opened value matches a missing stored value (no false alarm)', async () => {
    const b = bmp({})
    const res = await runCodeSave({ afterExpression: { value: 'x := 1', opened: '' } }, b.port)
    expect(b.port.decide).not.toHaveBeenCalled()
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'saved' }] })
  })

  it('changed in BMP: nothing is written; Cancel', async () => {
    const b = bmp({ expression: 'changed elsewhere' })
    const res = await runCodeSave({ expression: { value: 'mine', opened: 'original' } }, b.port)
    expect(b.writes).toEqual([])
    expect(b.port.decide).toHaveBeenCalledWith({ state: 'changed', changes: [{ prop: 'expression', opened: 'original', current: 'changed elsewhere' }] })
    expect(res).toMatchObject({ kind: 'cancelled' })
  })

  it('changed in BMP: Review returns the current value and writes nothing', async () => {
    const b = bmp({ expression: 'changed elsewhere' }, { decide: vi.fn(async () => 'review' as const) })
    const res = await runCodeSave({ expression: { value: 'mine', opened: 'original' } }, b.port)
    expect(b.writes).toEqual([])
    expect(res).toEqual({ kind: 'review', changes: [{ prop: 'expression', opened: 'original', current: 'changed elsewhere' }], current: { expression: 'changed elsewhere' } })
  })

  it('changed in BMP: Overwrite writes the user value and reads it back', async () => {
    const b = bmp({ expression: 'changed elsewhere' }, { decide: vi.fn(async () => 'overwrite' as const) })
    const res = await runCodeSave({ expression: { value: 'mine', opened: 'original' } }, b.port)
    expect(b.writes).toEqual([['expression', 'mine']])
    expect(res).toMatchObject({ kind: 'done', checked: false, props: [{ kind: 'saved', stored: 'mine' }] })
  })

  it('the check cannot read: Save anyway or Cancel, never a silent write', async () => {
    const decide = vi.fn(async () => 'cancel' as const)
    const b = bmp({ expression: 'x' }, { fetchFails: n => n === 1, decide })
    const res = await runCodeSave({ expression: { value: 'mine', opened: 'x' } }, b.port)
    expect(decide).toHaveBeenCalledWith({ state: 'unreadable', error: 'Code read failed' })
    expect(conflictChoices({ state: 'unreadable', error: 'e' })).toEqual([{ id: 'overwrite', label: 'Save anyway', variant: 'danger' }])
    expect(b.writes).toEqual([])
    expect(res).toMatchObject({ kind: 'cancelled', check: { state: 'unreadable' } })
  })

  it('Studio: several properties of one object share one check read and one read-back', async () => {
    const b = bmp({ html: '<p>a</p>', javascript: 'x()' })
    const res = await runCodeSave({
      html: { value: '<p>b</p>', opened: '<p>a</p>' },
      javascript: { value: 'y()', opened: 'x()' },
    }, b.port)
    expect(b.fetchCount()).toBe(2)
    expect(b.writes).toEqual([['html', '<p>b</p>'], ['javascript', 'y()']])
    expect(res).toMatchObject({ kind: 'done', props: [{ prop: 'html', kind: 'saved' }, { prop: 'javascript', kind: 'saved' }] })
  })
})

describe('code save: read-back', () => {
  it('BMP stored something else: stored-differs with the stored value', async () => {
    const b = bmp({ html: '<p>a</p>' }, { answer: () => ({ ok: true }), apply: false })
    b.port.write = vi.fn(async (prop: string) => { b.stored[prop] = '<p>sanitised</p>'; return { ok: true } })
    const res = await runCodeSave({ html: { value: '<p>b</p><script>x</script>', opened: '<p>a</p>' } }, b.port)
    expect(res).toMatchObject({ kind: 'done', props: [{ prop: 'html', kind: 'stored-differs', stored: '<p>sanitised</p>' }] })
  })

  it('write ok but the read-back fails: saved-unverified, never "saved"', async () => {
    const b = bmp({ expression: 'a' }, { fetchFails: n => n === 2 })
    const res = await runCodeSave({ expression: { value: 'b', opened: 'a' } }, b.port)
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'saved-unverified', error: 'Code read failed' }] })
  })

  it('a refused write is a plain failure', async () => {
    const b = bmp({ expression: 'a' }, { answer: () => ({ ok: false, error: 'EC error', notSent: false }) })
    const res = await runCodeSave({ expression: { value: 'b', opened: 'a' } }, b.port)
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'failed', error: 'EC error' }] })
    expect(b.fetchCount()).toBe(1)
  })
})

describe('code save: the answer did not arrive', () => {
  it('time-out, then the re-read shows the value: saved after all', async () => {
    const b = bmp({ expression: 'a' }, { answer: () => ({ ok: false, outcomeUnknown: true, error: 'timed out' }), apply: true })
    const res = await runCodeSave({ expression: { value: 'b', opened: 'a' } }, b.port)
    expect(b.writes).toHaveLength(1)
    expect(b.port.pause).toHaveBeenCalledWith(2000) // a commit may outlast the lost answer
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'unknown', outcome: 'saved', stored: 'b' }] })
  })

  it('no answer at all, then the re-read shows the old value: not saved', async () => {
    const b = bmp({ expression: 'a' }, { answer: () => undefined, apply: false })
    const res = await runCodeSave({ expression: { value: 'b', opened: 'a' } }, b.port)
    expect(b.writes).toHaveLength(1)
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'unknown', outcome: 'not-saved', stored: 'a' }] })
  })

  it('a write that throws is a lost answer: re-read, never written twice', async () => {
    const b = bmp({ expression: 'a' })
    b.port.write = vi.fn(async (prop: string, value: string) => { b.writes.push([prop, value]); b.stored[prop] = value; throw new Error('port closed') })
    const res = await runCodeSave({ expression: { value: 'b', opened: 'a' } }, b.port)
    expect(b.writes).toEqual([['expression', 'b']])
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'unknown', outcome: 'saved', stored: 'b' }] })
  })

  it('a read-back that throws: written is unverified, a lost answer could not be checked', async () => {
    const b = bmp({ html: 'a', javascript: 'x' }, { answer: prop => prop === 'html' ? { ok: true } : undefined })
    const fetch = b.port.fetch
    let n = 0
    b.port.fetch = vi.fn(async (props: string[]) => { if (++n === 2) throw new Error('worker gone'); return fetch(props) })
    const res = await runCodeSave({ html: { value: 'b', opened: 'a' }, javascript: { value: 'y', opened: 'x' } }, b.port)
    expect(res).toMatchObject({ kind: 'done', props: [
      { prop: 'html', kind: 'saved-unverified', error: 'worker gone' },
      { prop: 'javascript', kind: 'unknown', outcome: 'unverified' },
    ] })
  })

  it('several properties with different fates keep the order they were given in', async () => {
    const b = bmp({ a: '1', b: '1', c: '1' }, {
      answer: prop => prop === 'a' ? { ok: false, outcomeUnknown: true } : prop === 'b' ? { ok: false, error: 'refused' } : { ok: true },
      apply: true,
    })
    const res = await runCodeSave({ a: { value: '2', opened: '1' }, b: { value: '2', opened: '1' }, c: { value: '2', opened: '1' } }, b.port)
    expect(b.writes.map(w => w[0])).toEqual(['a', 'b', 'c'])
    // One check read and one read-back of the written and the unknown property.
    expect(b.port.fetch).toHaveBeenLastCalledWith(['c', 'a'])
    expect(res).toMatchObject({ kind: 'done', checked: true, props: [
      { prop: 'a', kind: 'unknown', outcome: 'saved' },
      { prop: 'b', kind: 'failed', error: 'refused' },
      { prop: 'c', kind: 'saved' },
    ] })
  })

  it('time-out and the re-read fails: could not check', async () => {
    const b = bmp({ expression: 'a' }, { answer: () => ({ ok: false, outcomeUnknown: true }), fetchFails: n => n === 2 })
    const res = await runCodeSave({ expression: { value: 'b', opened: 'a' } }, b.port)
    expect(res).toMatchObject({ kind: 'done', props: [{ kind: 'unknown', outcome: 'unverified' }] })
  })
})

describe('code save: dialog and execute wording', () => {
  it('the dialog shows the BMP change as a line diff and the size of the user edit', () => {
    const el = document.createElement('div')
    el.append(...conflictBody({ state: 'changed', changes: [{ prop: 'expression', opened: 'a\nb', current: 'a\nc' }] }, () => 'a\nb\nd'))
    expect(el.textContent).toContain('expression · changed in BMP')
    expect(el.textContent).toContain('In BMP now: 2 lines (+1 −1) · yours: 3 lines (+1 −0)')
    expect(el.querySelector('.ow-ld-row.del')?.textContent).toContain('b')
    expect(el.querySelector('.ow-ld-row.add')?.textContent).toContain('c')
  })

  it('an Execute whose answer did not arrive may have been applied', () => {
    expect(executeOutcome(undefined, true)).toEqual({ ok: false, failed: false, text: 'No answer from BMP. The run may have been applied; look in BMP before running it again.' })
    expect(executeOutcome({ type: 'EC_RESULT', ok: false, outcomeUnknown: true, error: 'EC execution timed out (60s)' }, true).text)
      .toBe('No answer from BMP. The run may have been applied; look in BMP before running it again. (EC execution timed out (60s))')
    expect(executeOutcome({ type: 'EC_RESULT', ok: false, error: 'Syntax error at line 2' }, true)).toEqual({ ok: false, failed: true, text: 'Syntax error at line 2' })
    expect(executeOutcome({ type: 'EC_RESULT', ok: true, log: '5' }, true)).toEqual({ ok: true, failed: false, text: '5' })
    expect(executeOutcome(undefined, false)).toEqual({ ok: false, failed: true, text: 'No response from service worker' })
  })
})

describe('save-check helpers', () => {
  it('compares exactly within one read form', () => {
    expect(compareOpened({ a: 'x', b: '' }, p => (p === 'a' ? 'x' : ''))).toEqual({ state: 'unchanged' })
    expect(compareOpened({ a: 'x\n' }, () => 'x')).toEqual({ state: 'changed', changes: [{ prop: 'a', opened: 'x\n', current: 'x' }] })
  })

  it('treats a thrown read as unreadable', async () => {
    await expect(checkCodeBase(async () => { throw new Error('gone') }, { a: '' })).resolves.toEqual({ state: 'unreadable', error: 'gone' })
  })

  it('a time-out or a network failure leaves the outcome unknown; other failures do not', () => {
    expect(isOutcomeUnknown('timeout')).toBe(true)
    expect(isOutcomeUnknown('network')).toBe(true)
    expect(isOutcomeUnknown('server')).toBe(false)
    expect(isOutcomeUnknown(undefined)).toBe(false)
    expect(outcomeAfterReread('b', 'b')).toBe('saved')
    expect(outcomeAfterReread('b', 'a')).toBe('not-saved')
    expect(outcomeAfterReread('b', undefined)).toBe('unverified')
  })
})
