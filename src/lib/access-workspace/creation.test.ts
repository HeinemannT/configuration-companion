import { expect, it, vi } from 'vitest';
import type { BmpClient } from '../bmp-client';
import { readResult } from './test-response';
import { readCreationContext } from './creation';

const framed = (code: string, rows: string[][]) => {
  const d = code.match(/CREV_ACCESS_[a-f0-9]+_/)![0];
  return rows.map(row => d + 'ROW' + d + row.join(d) + d + 'END' + d).join('');
};

it('reads only requested defaults, retaining typed values, missing fields and 64-bit references', async () => {
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, code.includes('_cls :=') ? [
    ['property','1','name','Name','TextMethodConfig','true',''],
    ['property','2','enabled','Enabled','BooleanMethodConfig','false',''],
    ['property','3','score','Score','NumberMethodConfig','false',''],
    ['property','4','owner','Owner','ReferenceMethodConfig','false','User'],
    ['property','5','empty','Empty','TextMethodConfig','false',''],
  ] : [
    ['root','9000000000000000001','root','Risks','CeRiskAssessmentRoot'],
    ['source','9000000000000000002','default','Default risk','CeRiskAssessment'],
    ['field','name','false','Default risk'], ['field','enabled','false','false'],
    ['field','score','false','0'], ['field','owner','false','9000000000000000003'],
    ['field','empty','true',''],
    ['label','9000000000000000003','ownerId','Owner name','User'],
  ])));
  const client = { executeEc, fetchTypeFields: vi.fn().mockResolvedValue([
    {id:'owner',businessId:'owner',reference:true,multiselect:false,targets:['User']},
  ]) } as unknown as BmpClient;
  const result = await readCreationContext(client,'CeRiskAssessment','9000000000000000002',['name','enabled','score','owner','empty','unknown']);
  expect(result.values).toEqual({type:'CeRiskAssessment',properties:{name:'Default risk',enabled:false,score:0},references:{owner:'9000000000000000003'}});
  expect(result.missing).toEqual(['empty']); expect(result.unsupported).toEqual(['unknown']);
  expect(result.labels).toEqual({'9000000000000000003':'Owner name · ownerId'});
  const code = executeEc.mock.calls.at(-1)![0];
  expect(code).toContain('_source.model != root.defaults.model');
  expect(code).not.toContain('_source.unknown'); expect(code).not.toContain('.descendants');
});

it('rejects invalid identifiers before contacting BMP and reads enterprise roots directly', async () => {
  const executeEc = vi.fn(async (code: string) => readResult(code, framed(code, [['root','9000000000000000001','root','Risks','CeRiskAssessmentRoot']])));
  const client = { executeEc } as unknown as BmpClient;
  await expect(readCreationContext(client,'CeRiskAssessment','1',['name;error()'])).rejects.toThrow();
  expect(executeEc).not.toHaveBeenCalled();
  expect((await readCreationContext(client,'CeRiskAssessment')).root?.rid).toBe('9000000000000000001');
  expect(executeEc.mock.calls[0][0]).toContain('root.ceRiskAssessment');
  expect(await readCreationContext(client,'Organisation')).toEqual({});
  expect(executeEc).toHaveBeenCalledTimes(1);
});
