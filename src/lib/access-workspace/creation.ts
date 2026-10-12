import type { BmpClient } from '../bmp-client';
import { validateEcIdentifier, validateRid } from '../ec-guards';
import type { AccessChoice, ProposedValues } from './model';
import { frame, literal, readEc, readSchema, ROOTS } from './read';

export interface CreationContext {
  root?: AccessChoice;
  source?: AccessChoice;
  values?: ProposedValues;
  missing?: string[];
  unsupported?: string[];
  labels?: Record<string, string>;
}

/** Read-only inputs for a CREATE trace. A default supplies selected policy
 * operands, never creates/copies an object or invents reference IDs. */
export async function readCreationContext(client: BmpClient, type: string, source?: string, requested: string[] = [], signal?: AbortSignal): Promise<CreationContext> {
  validateEcIdentifier(type);
  if (source) validateRid(source);
  if (requested.length > 80) throw new Error('Read at most 80 default fields at once.');
  requested.forEach(validateEcIdentifier);
  const root = ROOTS.find(r => r.startsWith('ce') && r.toLowerCase() === type.toLowerCase());
  if (!root && !source) return {};
  const schema = source ? await readSchema(client,type,signal) : [];
  const selected = [...new Set(requested)].filter(name => !['type','parent'].includes(name)).map(name=>schema.find(p=>p.accessor===name)).filter(p=>!!p);
  const unsupported = requested.filter(name=>!['type','parent'].includes(name)&&!selected.some(p=>p.accessor===name));
  const f=frame(), code=['_out := ""'];
  const identity=(kind:string,expr:string)=>f.row([f.start,literal(kind),`${expr}.rid`,`${expr}.id`,`${expr}.name`,`${expr}.className`]);
  if(root)code.push(identity('root',`root.${root}`));
  if(source){
    code.push(`_source := lookup(${source})`, `IF _source.className != ${literal(type)} OR _source.model != root.defaults.model THEN`, ' error("Choose a default object of the selected type")', 'ENDIF',identity('source','_source'));
    for(const prop of selected){
      if(!prop.reference&&!/Text|Boolean|Number|Integer|Decimal|System/.test(prop.configClass)){unsupported.push(prop.accessor);continue;}
      code.push(f.row([f.start,literal('field'),literal(prop.accessor),`_source.${prop.accessor}.isMissing()`,prop.reference?`_source.${prop.accessor}.rid`:`_source.${prop.accessor}`]));
      if(prop.reference){
        code.push(`IF _source.${prop.accessor}.isMissing() = false THEN`);
        if(prop.multiselect)code.push(`_source.${prop.accessor}.first(80).forEach(_ref:`,identity('label','_ref'),')');
        else code.push(identity('label',`_source.${prop.accessor}`));
        code.push('ENDIF');
      }
    }
  }
  code.push('_out');
  const result:CreationContext={};
  if(source){result.values={type,properties:{},references:{}};result.missing=[];result.unsupported=unsupported;}
  for(const [kind,a,b,c,d] of f.parse(await readEc(client,code.join('\n'),signal))){
    if(kind==='root'||kind==='source'){result[kind]={rid:validateRid(a),id:b,name:c,type:d};continue;}
    if(kind==='label'){result.labels??={};result.labels[validateRid(a)]=c+(b?' · '+b:'');continue;}
    if(kind!=='field'||!result.values)continue;
    const prop=selected.find(p=>p.accessor===a)!;
    if(b==='true'){result.missing!.push(a);continue;}
    if(prop.reference){
      const raw=c.replace(/[[\]\s]/g,''), ids=raw?raw.split(',').map(validateRid):[];
      result.values.references![a]=prop.multiselect?ids:ids[0]??null;
    }else if(/Boolean/.test(prop.configClass)){
      if(!['true','false'].includes(c))throw new Error(`Invalid boolean default for ${a}.`);
      result.values.properties![a]=c==='true';
    }else if(/Number|Integer|Decimal/.test(prop.configClass)){
      const value=Number(c);if(!c.trim()||!Number.isFinite(value))throw new Error(`Invalid numeric default for ${a}.`);
      result.values.properties![a]=value;
    }else result.values.properties![a]=c;
  }
  return result;
}
