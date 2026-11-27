/**
 * How far a read of the Atlas model is, in words, and how often the service
 * worker tells the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { asOf, elapsedText, progressLine, progressReporter, progressShare, readSummary, type AtlasReadProgress } from '../progress';

const at = (step: AtlasReadProgress['step'], done: number, total: number): AtlasReadProgress => ({ step, done, total, startedAt: 0 });

describe('Atlas read progress', () => {
  it('names the step and counts the types where the step has a count', () => {
    expect(progressLine(at('properties', 0, 0))).toBe('Step 1 of 3: Reference properties');
    expect(progressLine(at('held', 12, 140))).toBe('Step 2 of 3: What the references hold, 12 of 140 types');
    expect(progressLine(at('counts', 1, 1))).toBe('Step 3 of 3: Objects per type, 1 of 1 type');
    expect(progressLine(at('held', 1200, 1400))).toContain('1,200 of 1,400');
  });

  it('only grows over the whole read', () => {
    const shares = [at('properties', 0, 0), at('held', 0, 10), at('held', 5, 10), at('held', 10, 10), at('counts', 0, 4), at('counts', 4, 4)].map(progressShare);
    for (let i = 1; i < shares.length; i++) expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1]);
    expect(shares[0]).toBe(0);
    expect(shares.at(-1)).toBe(1);
    expect(progressShare(at('held', 50, 10))).toBe(progressShare(at('held', 10, 10)));
  });

  it('words the time and the result of a read', () => {
    expect(elapsedText(420)).toBe('0.4 s');
    expect(elapsedText(6240)).toBe('6.2 s');
    expect(elapsedText(42_400)).toBe('42 s');
    expect(elapsedText(125_000)).toBe('2 min 5 s');
    expect(readSummary(284, 1912, 6200)).toBe('284 types, 1,912 references, read in 6.2 s');
    expect(readSummary(1, 1, null)).toBe('1 type, 1 reference');
  });

  it('says the time of the read, with the day when it was not today', () => {
    const read = new Date(2026, 10, 27, 14, 32).getTime();
    expect(asOf(read, new Date(2026, 10, 27, 18, 0).getTime())).toBe('as of 14:32');
    expect(asOf(read, new Date(2026, 10, 28, 9, 0).getTime())).toBe('as of 27 Nov 14:32');
  });

  it('passes on a new step and the last type of a step at once, and the rest at most every interval', () => {
    let now = 0;
    const send = vi.fn();
    const report = progressReporter(send, () => now, 200);
    report(at('properties', 0, 0));
    report(at('held', 0, 10));
    now = 50; report(at('held', 1, 10));
    now = 120; report(at('held', 2, 10));
    now = 260; report(at('held', 3, 10));
    now = 270; report(at('held', 10, 10));
    expect(send.mock.calls.map(c => [(c[0] as AtlasReadProgress).step, (c[0] as AtlasReadProgress).done])).toEqual([
      ['properties', 0], ['held', 0], ['held', 3], ['held', 10],
    ]);
  });
});

describe('Atlas model read reports its steps', () => {
  it('reports the properties, each type of what the references hold, and each referenced type counted', async () => {
    vi.resetModules();
    vi.doMock('../../handler-registry', () => ({ register: vi.fn() }));
    const { ATLAS_FIELD: F, ATLAS_ROW: R } = await import('../atlas-ec');
    const { readAtlasModel } = await import('../../handlers/atlas');
    const link = (cls: string) => `com.corporater.bmp.model.model.enterprise.${cls}\u0003${cls}\u0003Label\u0004`;
    const properties = [
      ['controls', 'Controls', 'ReferenceMethodConfig', 'true', '[CeTarget]', '', link('CeA')],
      ['owner', 'Owner', 'ReferenceMethodConfig', 'false', '[]', '', link('CeB')],
    ].map(r => r.join(F)).join(R) + R;
    const executeEc = vi.fn(async (code: string) => {
      if (code.includes('root.property.descendants()')) return { ok: true, log: properties };
      return { ok: true, log: `#${F}3${F}3${R}` };
    });
    const seen: AtlasReadProgress[] = [];
    await readAtlasModel({ executeEc } as never, p => seen.push(p));
    expect(seen.map(p => `${p.step} ${p.done}/${p.total}`)).toEqual([
      'properties 0/0', 'held 0/2', 'held 1/2', 'held 2/2', 'counts 0/1', 'counts 1/1',
    ]);
    expect(new Set(seen.map(p => p.startedAt)).size).toBe(1);
  });
});
