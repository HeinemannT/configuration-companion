import { describe, expect, it, vi } from 'vitest';
import { EcQueryService } from '../ec-query-service';
import { framedBlocks } from '../ec-parser';

describe('EcQueryService selected property reads', () => {
  it('reads scalar and reference properties in one bounded EC round trip', async () => {
    const executeEc = vi.fn(async (_code: string) => ({ ok: true, log: framedBlocks({
      state_visible: 'value',
      value_visible: 'true',
      state_card: 'value',
      value_card: 'Risk card',
      rid_card: '99',
      id_card: 'risk_card',
      name_card: 'Risk card',
      type_card: 'Card',
    }) }));
    const service = new EcQueryService(executeEc, vi.fn(async () => 't.selected'), []);

    const result = await service.fetchSelectedProperties('42', [
      { accessor: 'visible', reference: false },
      { accessor: 'card', reference: true },
    ]);

    expect(result).toEqual([
      { accessor: 'visible', state: 'value', value: 'true' },
      { accessor: 'card', state: 'value', value: 'Risk card', reference: { rid: '99', businessId: 'risk_card', name: 'Risk card', type: 'Card' } },
    ]);
    const code = executeEc.mock.calls[0][0];
    expect(code).toContain('_v := _o.visible');
    expect(code).toContain('_v := _o.card');
    expect(code).toContain('IF _v.isMissing() THEN');
    expect(code).toContain('_v.rid.whenMissing("")');
    // No per-request marker: the same question is the same script.
    const again = vi.fn(async (_code: string) => ({ ok: true, log: framedBlocks({ state_visible: 'missing', state_card: 'missing' }) }));
    await new EcQueryService(again, vi.fn(async () => 't.selected'), []).fetchSelectedProperties('42', [
      { accessor: 'card', reference: true },
      { accessor: 'visible', reference: false },
    ]);
    expect(again.mock.calls[0][0]).toBe(code);
    expect(executeEc).toHaveBeenCalledOnce();
  });

  it('preserves explicit missing state instead of conflating it with an empty string', async () => {
    const service = new EcQueryService(vi.fn(async () => ({ ok: true, log: framedBlocks({ state_visible: 'missing' }) })), vi.fn(async () => 't.selected'), []);
    await expect(service.fetchSelectedProperties('42', [{ accessor: 'visible', reference: false }]))
      .resolves.toEqual([{ accessor: 'visible', state: 'missing', value: '' }]);
  });

  it('rejects an incomplete successful response instead of inventing a value state', async () => {
    const service = new EcQueryService(vi.fn(async () => ({ ok: true, log: framedBlocks({ value_visible: 'true' }) })), vi.fn(async () => 't.selected'), []);

    await expect(service.fetchSelectedProperties('42', [{ accessor: 'visible', reference: false }]))
      .rejects.toThrow('incomplete result');
    const cut = new EcQueryService(vi.fn(async () => ({ ok: true, log: framedBlocks({ state_visible: 'value', value_visible: 'true' }, false) })), vi.fn(async () => 't.selected'), []);
    await expect(cut.fetchSelectedProperties('42', [{ accessor: 'visible', reference: false }]))
      .rejects.toThrow('incomplete result');
  });

  it('preserves scalar content that resembles a wire marker', async () => {
    const dangerousValue = 'user text ~CREV_R~5:state~CREV_D~ <<<CREV_PROPERTY_SEP>>>missing';
    const service = new EcQueryService(vi.fn(async () => ({ ok: true, log: framedBlocks({
      state_text: 'value',
      value_text: dangerousValue,
    }) })), vi.fn(async () => 't.selected'), []);

    await expect(service.fetchSelectedProperties('42', [{ accessor: 'text', reference: false }]))
      .resolves.toEqual([{ accessor: 'text', state: 'value', value: dangerousValue }]);
  });
});
