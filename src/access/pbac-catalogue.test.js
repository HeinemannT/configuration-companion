import {expect,it,vi} from 'vitest';
import {createPBACCatalogue} from './pbac-catalogue.js';
import {clarityFixture} from './__fixtures__/clarity.js';

function fixture() {
  const {snapshot,classes}=clarityFixture();
  let current=snapshot;
  const loadSchema=vi.fn(async type=>{current.classes[type]=classes[type];});
  const api=vi.fn(async()=>({choices:[]}));
  const catalogue=createPBACCatalogue({getSnapshot:()=>current,getRoles:()=>current.model.roles,getClasses:()=>current.classes,loadSchema,api});
  return {catalogue,snapshot,classes,loadSchema,api,refresh:()=>{current={...current};}};
}
const signal=()=>new globalThis.AbortController().signal;

it('loads only an inferred type and searches property labels while inserting native accessors',async()=>{
  const f=fixture();
  const rows=await f.catalogue({kind:'properties',types:['CeRiskAssessment'],scope:'resource',query:'resource.Risk'},signal());
  expect(f.loadSchema).toHaveBeenCalledExactlyOnceWith('CeRiskAssessment');
  expect(rows).toEqual([expect.objectContaining({value:'resource.owners',detail:'Risk owners'})]);
  f.loadSchema.mockClear();
  const ambiguous=await f.catalogue({kind:'properties',types:['CeRiskAssessment','CeTask'],scope:'new',query:'new.'},signal());
  expect(ambiguous.map(r=>r.value)).toEqual(['new.type','new.id','new.name','new.parent']);
  expect(f.loadSchema).not.toHaveBeenCalled();expect(f.api).not.toHaveBeenCalled();
});

it('disambiguates equally named list items with business ID tokens and searches only that list',async()=>{
  const f=fixture(),request={kind:'values',types:['CeRiskAssessment'],field:'scope',query:'Central'};
  const rows=await f.catalogue(request,signal());
  expect(rows.map(r=>r.value)).toEqual(['ListPropertySetItem:scope_global','ListPropertySetItem:scope_regional']);
  expect(f.api).not.toHaveBeenCalled();
  f.classes.CeRiskAssessment[1].listSet.partial=true;
  f.api.mockResolvedValue({choices:[{id:'scope_remote',name:'Remote',token:'ListPropertySetItem:scope_remote'}]});
  const abort=signal();
  expect(await f.catalogue({...request,query:'ListPropertySetItem:remote'},abort)).toEqual([{value:'ListPropertySetItem:scope_remote',detail:'Remote',info:''}]);
  expect(f.api).toHaveBeenCalledWith({operation:'listItems',set:'9000000000000000903',query:'remote',selected:[]},{signal:abort});
  expect(await f.catalogue({...request,query:''},abort)).toHaveLength(1);
  expect(f.api).toHaveBeenLastCalledWith({operation:'listItems',set:'9000000000000000903',query:'',selected:[]},{signal:abort});
});

it('never enumerates users and discards cancelled or refreshed remote results',async()=>{
  const f=fixture(),request={kind:'subjects',rolePrefix:true,query:'user:a'};
  expect(await f.catalogue(request,signal())).toEqual([]);expect(f.api).not.toHaveBeenCalled();
  f.api.mockResolvedValue({choices:[{rid:'9000000000000000199',id:'alice_1',name:'Alice'}]});
  expect((await f.catalogue({...request,query:'user:alice'},signal()))[0].value).toBe('user:alice_1');
  for(const invalidate of ['cancel','refresh']) {
    let resolve;f.api.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    const controller=new globalThis.AbortController(),pending=f.catalogue({...request,query:'user:alice'},controller.signal);
    if(invalidate==='cancel')controller.abort();else f.refresh();
    resolve({choices:[{id:'old_user',name:'Stale'}]});expect(await pending).toEqual([]);
  }
});

it('scopes reference searches to a known target and offers current-user semantics for principal properties',async()=>{
  const f=fixture();f.api.mockResolvedValue([{type:'CeRiskAssessment',id:'risk_01',name:'Quarterly risk'}]);
  expect((await f.catalogue({kind:'values',types:['CeTask'],field:'relatedRisk',query:'quarterly'},signal()))[0].value).toBe('CeRiskAssessment:risk_01');
  expect(f.api.mock.calls[0][0]).toEqual({operation:'search',query:'quarterly',type:'CeRiskAssessment'});
  f.api.mockClear();f.classes.CeTask[0].targets='[CeRiskAssessment, CeTask]';
  expect(await f.catalogue({kind:'values',types:['CeTask'],field:'relatedRisk',query:'quarterly'},signal())).toEqual([]);
  expect(await f.catalogue({kind:'values',types:['CeRiskAssessment'],field:'owners',query:''},signal())).toEqual([{value:'user',detail:'Current user',info:''}]);
  expect(f.api).not.toHaveBeenCalled();
});

it('does not start an object lookup if the workspace refreshed during a property load',async()=>{
  const f=fixture();let resolve;
  f.loadSchema.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const pending=f.catalogue({kind:'values',types:['CeTask'],field:'relatedRisk',query:'quarterly'},signal());
  f.refresh();resolve();expect(await pending).toEqual([]);expect(f.api).not.toHaveBeenCalled();
});
