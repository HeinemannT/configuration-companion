import { beforeAll, expect, it } from 'vitest';
import { JavaWriter, JavaReader } from '../java-serial';
import { registerBmpTypes, makeReferenceIdentityCommand } from '../bmp-types';
import { parseTypeCatalogue, parseReferenceIdentity, commandResults } from '../bmp-type-catalogue';
beforeAll(registerBmpTypes);
const type = (typeId:string) => ({$type:'com.corporater.base.generation.system.TypeKey',typeId});
function roundtrip(value:unknown):any {
  const writer=new JavaWriter();writer.writeStreamHeader();writer.writeObject(value);
  const reader=new JavaReader(writer.toBytes().buffer as ArrayBuffer);reader.readStreamHeader();return reader.readObject();
}
it('preserves typed keys in mutable and immutable maps alongside legacy string keys',()=>{
  const entries=[[type('Scorecard'),'one'],[type('CeTIA'),'two'],['plain','three']];
  for(const raw of [{$type:'java.util.HashMap',$size:3,$entries:entries},{$type:'java.util.CollSer',tag:3,$elements:entries.flat()}]) {
    const result=roundtrip(raw);
    expect(result.$entries.map(([k,v]:[any,any])=>[k.typeId??k,v])).toEqual([['Scorecard','one'],['CeTIA','two'],['plain','three']]);
    expect(result.$map.plain).toBe('three');
  }
  expect(()=>roundtrip({$type:'java.util.CollSer',tag:3,$elements:['orphan']})).toThrow();
});
it('serializes native identity lookup with an actual Java String array',()=>{
  const command=roundtrip(makeReferenceIdentityCommand('TEMPLATECATEGORY','tax_landing'));
  expect(command.properties).toEqual(['getRid','getTypeKey','getModel']);
  expect(command.space.name).toBe('TEMPLATECATEGORY');
  expect(command.id).toBe('tax_landing');
});
it('rejects lossy catalogue maps and incomplete/misaligned batch replies',()=>{
  expect(()=>parseTypeCatalogue({types:{$map:{'[object Object]':{key:{typeId:'CeTIA'}}}}})).toThrow();
  expect(()=>commandResults([{$elements:[{response:1}]}],2)).toThrow();
  expect(()=>commandResults([{$class:'ServerExceptionResponse',message:'failed'}],1)).toThrow('failed');
  expect(()=>parseReferenceIdentity({$entries:[['getTypeKey',{typeId:'CeTIA'}]]})).toThrow();
  expect(parseReferenceIdentity(null)).toBeNull();
});

it('distinguishes a valid empty parent list from unavailable ancestry metadata',()=>{
  const dto=(overrides:Record<string,unknown>={})=>({types:{$entries:[[{typeId:'Identifiable'},
    {key:{typeId:'Identifiable'},concrete:false,directSuperTypes:[],...overrides}]]},concreteTypesPerModel:{$entries:[]}});
  expect(parseTypeCatalogue(dto()).types.Identifiable.parents).toEqual([]);
  expect(parseTypeCatalogue(dto({directSuperTypes:{$elements:[]}})).types.Identifiable.parents).toEqual([]);
  for(const bad of [undefined,null,{},'Base',{$elements:'Base'},[{}]])
    expect(()=>parseTypeCatalogue(dto({directSuperTypes:bad}))).toThrow();
  for(const bad of [undefined,null,'false',0]) expect(()=>parseTypeCatalogue(dto({concrete:bad}))).toThrow();
});
