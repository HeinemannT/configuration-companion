import { expect, it, vi } from 'vitest';
import type { BmpClient } from '../bmp-client';
import { readMatrixMetadata } from './matrix-metadata';

const catalogue = { types: { Widget: { parents: [], concrete: false, idSpace: 'PAGE' } }, models: {} };
function client(resolvePolicyReferences = vi.fn().mockResolvedValue({references:{},problems:[],unavailable:[]})) {
  return { fetchTypeCatalogue: vi.fn().mockResolvedValue(catalogue), resolvePolicyReferences };
}
it('resolves known namespaces once and leaves unknown references unavailable', async () => {
  const c = client();
  await readMatrixMetadata(c as unknown as BmpClient, ['Widget:shared', 'Widget:shared', 'Unknown:other', 'dynamic.value']);
  expect(c.resolvePolicyReferences).toHaveBeenCalledWith([{ token: 'Widget:shared', space: 'PAGE', id: 'shared' }], undefined);
});
it('does not turn a failed lookup into confirmed missing objects', async () => {
  const c = client(vi.fn().mockRejectedValue(new Error('Connection lost')));
  const result = await readMatrixMetadata(c as unknown as BmpClient, ['Widget:shared']);
  expect(result.references['Widget:shared']).toBeUndefined();
  expect(result.problems[0]).toContain('Connection lost');
  expect(result.unavailable).toEqual(['Widget:shared']);
  expect(result.types).toBe(catalogue.types);
});

it('preserves partial identities and distinguishes unsupported namespaces from retryable failures',async()=>{
  const references={'Widget:good':{rid:'9000000000000000001',type:'InputView',model:'PAGE'},'Widget:missing':null};
  const c=client(vi.fn().mockResolvedValue({references,unavailable:['Widget:failed'],problems:['Connection lost']}));
  const result=await readMatrixMetadata(c as unknown as BmpClient,['Widget:good','Widget:missing','Widget:failed','Unknown:other']);
  expect(result.references).toEqual(references);
  expect(result.unavailable).toEqual(['Widget:failed']);expect(result.unsupported).toEqual(['Unknown:other']);
});
it('propagates cancellation instead of returning incomplete metadata', async () => {
  const abort = new AbortController();
  const c = client(vi.fn().mockImplementation(() => { abort.abort(); throw new Error('aborted'); }));
  await expect(readMatrixMetadata(c as unknown as BmpClient, ['Widget:shared'], abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
