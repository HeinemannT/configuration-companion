import { pickedCompletion, startCompletion } from '@codemirror/autocomplete';
import { PBAC_ACTIONS } from './pbac-syntax.js';
import { comparisonRows } from './picker-model.js';
import { completionSite, completionTarget } from './pbac-assist.js';
import { rankCompletions } from './completion-ranking.js';

const row = (value,detail='',info='') => ({value,detail,info});

/** The source owns cancellation. The host owns its environment and metadata caches. */
export function pbacCompletionSource(analysisFor, catalogue=async()=>[]) {
  return async context => {
    const text=context.state.doc.toString(), site=completionSite(text,analysisFor(context.state),context.pos);
    if(!site) return null;
    const target=completionTarget(site);
    let rows=[];
    if(target.kind==='keys') rows=target.keys.filter(key=>!site.keys?.includes(key)||key===site.keyName).map(key=>row(key,'PBAC field'));
    if(target.kind==='version') rows=[row('1.0')];
    if(target.kind==='actions') rows=PBAC_ACTIONS.map(action=>row(action));
    if(target.kind==='effects') rows=[row('Allow','Grant when this rule matches'),row('Deny','Does not override another rule’s grant')];
    if(target.kind==='grouping') rows=[row('All','Every referenced object'),row('Any','At least one referenced object')];
    if(target.kind==='comparisons') rows=comparisonRows().map(r=>row(r.rid,r.label,r.secondary));
    if(target.kind==='properties') {
      rows=[{...row('resource.','Saved object fields'),continue:true},{...row('new.','Request fields'),continue:true}];
      if(target.reference) rows.push({...row('reversed.','Incoming reference'),continue:true});
      if(!target.reference && target.scope==='resource') rows.push(row('resource','Object itself'));
    }
    if(['subjects','properties','types','values'].includes(target.kind)) {
      const controller=new globalThis.AbortController();
      context.addEventListener('abort',()=>controller.abort(),{onDocChange:true});
      try {
        rows.push(...await catalogue({...target,query:site.prefix},controller.signal));
      } catch { /* Local syntax choices stay available; another completion retries metadata. */ }
      if(context.aborted) return null;
    }
    if(target.kind==='subjects' && target.rolePrefix) {
      rows.unshift({...row('user:','Type a user name or ID to search'),continue:true});
      if(target.bare) rows.unshift(row('*','Everyone'));
    }
    if(!rows.length) return null;
    rows=rankCompletions(rows,site.prefix);
    const options=rows.map(r=>({
      label:String(r.value),detail:r.detail,type:target.kind==='keys'?'property':r.type??'constant',info:r.info||undefined,
      glyph:target.kind==='subjects'?(String(r.value).startsWith('user:')?'assignment':'role'):
        ({keys:'json',actions:'check',effects:'policy',grouping:'list',comparisons:'sliders',properties:'filter',types:'object',values:'list'})[target.kind]??'json',
      apply(view,completion,from,to) {
        const value=target.bare && r.value!=='*'?[r.value]:r.value,
          insert=JSON.stringify(value)+(site.kind==='key'&&!site.colon?': ':''),
          anchor=from+insert.length-(r.continue?(target.bare?2:1):0);
        view.dispatch({changes:{from,to,insert},selection:{anchor},annotations:pickedCompletion.of(completion),userEvent:'input.complete'});
        if(r.continue || site.kind==='key'&&!site.colon) startCompletion(view);
      }
    }));
    return {from:site.from,to:site.to,options,filter:false};
  };
}
