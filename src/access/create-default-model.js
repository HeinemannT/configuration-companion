import { readCreateValues, createFieldValue, setCreateValue } from './create-test-model.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function useCreateDefault(check, source, values) {
  const current=readCreateValues(check.proposed), previous=check.createDefault?.values;
  for(const kind of ['properties','references']){
    const before=previous?.[kind]??{}, after=values[kind]??{};
    current[kind]??={};
    for(const field of new Set([...Object.keys(before),...Object.keys(after)])){
      const entry=createFieldValue(current,field);
      // Omission and unfinished numeric input are explicit test cases too.
      // A different default must not silently turn either back into a value.
      if((!entry.supplied&&Object.hasOwn(check.omittedValues??{},field))||Object.hasOwn(check.createNumberDrafts??{},field))continue;
      // Switching defaults replaces inherited values and retains explicit overrides.
      if(entry.supplied&&(!Object.hasOwn(before,field)||entry.kind!==kind||!same(entry.value,before[field])))continue;
      if(Object.hasOwn(after,field))current[kind][field]=structuredClone(after[field]);
      else delete current[kind][field];
    }
  }
  check.proposed=JSON.stringify(current,null,2);
  check.createDefault={source,values:structuredClone(values)};
  if(check.result)check.result.stale=true;
}
export function defaultFieldState(check,field) {
  if(!check.createDefault)return null;
  const original=createFieldValue(check.createDefault.values,field),current=createFieldValue(readCreateValues(check.proposed),field);
  if(!original.supplied)return null;
  return {inherited:current.supplied&&original.kind===current.kind&&same(original.value,current.value),...original};
}
export function resetCreateDefault(check,field) {
  const entry=defaultFieldState(check,field);if(!entry)return;
  setCreateValue(check,field,entry.kind,structuredClone(entry.value));
}
export function changeCreateType(check,type) {
  const before=readCreateValues(check.proposed);if(before.type===type)return;
  check.createRevision=(check.createRevision??0)+1;
  delete check.defaultLoading;
  const keys=['proposed','resource','createDefault','createFields','createLabels','omittedValues','createNumberDrafts','createRootLoaded','createContextError','createContextErrorSource','defaultReadFields','defaultUnsupported'];
  check.createTypes??={};
  if(before.type)check.createTypes[before.type]=Object.fromEntries(keys.filter(k=>check[k]!==undefined).map(k=>[k,structuredClone(check[k])]));
  for(const k of keys)delete check[k];
  // Saved scenarios are snapshots, not mutable aliases of the active inputs.
  Object.assign(check,structuredClone(check.createTypes[type]??{proposed:JSON.stringify({type}),resource:''}));
  check.createInitialized=true;
  if(check.result)check.result.stale=true;
}
