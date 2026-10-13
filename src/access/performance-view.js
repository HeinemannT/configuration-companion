import {icon} from './icons';
import {diagnose,sampleSummary} from './performance-model.js';
import {createPerformanceProjection} from './performance-projection.js';
import {comparePerformance} from './performance-plan.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ms=n=>Number.isFinite(n)?n>0&&n<.01?'&lt;0.01':n.toFixed(2):'—';
const outcome=v=>v==null?`<span class="pr-decision inconsistent">${icon('warning')}Inconsistent</span>`:`<span class="pr-decision ${v?'granted':'denied'}">${icon(v?'valid':'close')}${v?'Granted':'Denied'}</span>`;
export const performanceViewState=()=>({view:'checks',query:'',result:'all',selected:'',rule:'',filter:'actionable',scroll:0,listScroll:0,open:[]});

export function mountPerformance(host,{controller,state,getSnapshot,hasDraftChanges,canOpen,openRule,openRole,test}) {
  let checks=[],findings=[],totals=[],current=null,disposed=false,lastRender=[];
  const project=createPerformanceProjection();
  const lazyBodies=new Map();
  const root=document.createElement('section');root.className='performance-review';root.setAttribute('aria-label','Access performance');host.replaceChildren(root);
  const $=s=>root.querySelector(s);
  function capture(){state.scroll=$('.pr-scroll')?.scrollTop??state.scroll;state.listScroll=$('.pr-check-list')?.scrollTop??state.listScroll;const visible=new Set([...root.querySelectorAll('details[data-disclosure]')].map(d=>d.dataset.disclosure));state.open=[...state.open.filter(id=>!visible.has(id)),...[...root.querySelectorAll('details[open][data-disclosure]')].map(d=>d.dataset.disclosure)];}
  const disclosure=(id,label,body)=>{
    const open=state.open.includes(id),lazy=typeof body==='function';
    if(lazy)lazyBodies.set(id,body);
    return `<details data-disclosure="${esc(id)}" ${lazy&&!open?'data-lazy':''} ${open?'open':''}><summary>${icon('down')}${label}</summary>${lazy?(open?body():''):body}</details>`;
  };
  const ruleButton=r=>r.policy?`<button class="pr-icon" data-pr-policy="${esc(r.policy.rid)}" data-rule="${r.invalid?'':r.index}" aria-label="Open ${esc(r.policy.name)} · Rule ${r.index+1}" title="${canOpen(r.policy.rid,r.invalid?undefined:r.index,current?.snapshot)?'Open rule':'Saved rule differs from the current draft. Apply or reload before opening.'}" ${canOpen(r.policy.rid,r.invalid?undefined:r.index,current?.snapshot)?'':'disabled'}>${icon('open')}</button>`:'';
  function render(preserve=true){
    if(disposed)return;if(preserve)capture();
    lazyBodies.clear();
    const active=document.activeElement;
    const focus=root.contains(active)?{id:active.id,tag:active.tagName,data:JSON.stringify(active.dataset),disclosure:active.closest('details[data-disclosure]')?.dataset.disclosure,start:active.selectionStart,end:active.selectionEnd}:null;
    const run=controller.state;current=run.current;
    if(state.view==='comparison'&&!run.previous)state.view='checks';
    const snapshot=current?.snapshot||getSnapshot();({checks,findings,totals}=project(current,snapshot));
    if(!checks.some(c=>c.id===state.selected))state.selected=checks.toSorted((a,b)=>(b.indexedMedian??b.median)-(a.indexedMedian??a.median))[0]?.id||'';
    lastRender=renderKey();
    const longest=checks.length?Math.max(...checks.map(c=>c.indexedMedian??c.median)):null;
    root.innerHTML=`<header class="pr-toolbar">${icon('performance')}<h1>Access performance</h1><span class="pr-saved">Saved policies${hasDraftChanges()?' · local edits excluded':''}</span><span class="pr-spacer"></span>${run.running?'<button data-pr="stop">'+icon('close')+'Stop</button>':`${current?.plan?.checks?.length?'<button data-pr="rerun" title="Measure the same contexts again">'+icon('reset')+'Rerun sample</button>':''}<button class="primary" data-pr="analyze">${icon('run')}Analyze</button>`}</header>
      <section class="pr-metrics"><div><span>Access checks</span><b>${checks.length}</b><small>${checks.filter(c=>c.decision===true).length} granted · ${checks.filter(c=>c.decision===false).length} denied${checks.some(c=>!c.consistent)?' · '+checks.filter(c=>!c.consistent).length+' inconsistent':''}</small></div><div><span>Longest check</span><b>${ms(longest)} <small>ms</small></b><small>Server · median per context</small></div><div><span>Most expensive rule</span><b>${ms(totals[0]?.max)} <small>ms</small></b><small title="${esc(totals[0]?.name)}">Sequential · ${esc(totals[0]?.name||'No measurements')}</small></div><button data-pr-view="improvements"><span>Improvements</span><b>${findings.filter(f=>f.category!=='reviewed').length}${icon('arrow')}</b><small>Patterns to review</small></button></section>
      ${run.error?`<div class="pr-notice error" role="alert">${icon('warning')}${esc(run.error)}</div>`:''}${current?.stale||current?.historical?'<div class="pr-notice">'+icon('warning')+'Configuration changed. These are earlier measurements; rerun the sample to compare.</div>':''}
      <div class="pr-body"><aside class="pr-sidebar"><header><b>Access checks</b><button data-pr="scope" class="pr-icon" aria-label="Analysis scope">${icon('sliders')}</button></header><label class="pr-search">${icon('search')}<input id="performance-query" aria-label="Find access checks" placeholder="User, role, object…" value="${esc(state.query)}"></label><select aria-label="Access result filter" data-pr-result><option value="all">All results</option><option value="granted" ${state.result==='granted'?'selected':''}>Granted</option><option value="denied" ${state.result==='denied'?'selected':''}>Denied</option><option value="inconsistent" ${state.result==='inconsistent'?'selected':''}>Inconsistent</option></select><div class="pr-check-list"></div><nav><button data-pr-view="policies" aria-pressed="${state.view==='policies'}">${icon('policy')}Measured policies<span>${new Set(totals.map(r=>r.policy?.rid)).size}</span></button><button data-pr-view="improvements" aria-pressed="${state.view==='improvements'}">${icon('changes')}Improvements</button>${run.previous?`<button data-pr-view="comparison" aria-pressed="${state.view==='comparison'}">${icon('history')}Compare runs</button>`:''}</nav></aside><section class="pr-main"></section></div>
      <footer class="pr-status" role="status"><span>${esc(run.progress||'Analyze discovers a bounded sample and measures access. No objects or policies are changed.')}</span>${run.running?`<progress max="${run.total||1}" value="${run.completed}"></progress>`:''}</footer>`;
    renderList();renderMain();$('.pr-scroll')?.scrollTo?.(0,state.scroll);if($('.pr-scroll'))$('.pr-scroll').scrollTop=state.scroll;$('.pr-check-list').scrollTop=state.listScroll;
    if(focus){
      let input=[...root.querySelectorAll('button,input,select,summary')].find(el=>focus.id?el.id===focus.id:el.tagName===focus.tag&&JSON.stringify(el.dataset)===focus.data&&el.closest('details[data-disclosure]')?.dataset.disclosure===focus.disclosure);
      if(!input&&focus.data===JSON.stringify({pr:'stop'}))input=$('[data-pr="analyze"]');
      input?.focus({preventScroll:true});if(input?.setSelectionRange&&focus.start!=null)input.setSelectionRange(focus.start,focus.end);
    }
  }
  function renderList(){
    const rows=checks.filter(c=>(state.result==='all'||(state.result==='inconsistent'?c.decision===null:c.decision===(state.result==='granted')))&&[c.actor.id,c.actor.name,c.object.id,c.object.name,c.object.type,c.action].join(' ').toLowerCase().includes(state.query.toLowerCase())).toSorted((a,b)=>(b.indexedMedian??b.median)-(a.indexedMedian??a.median));
    $('.pr-check-list').innerHTML=rows.map(c=>`<button data-pr-check="${esc(c.id)}" aria-pressed="${state.view==='checks'&&state.selected===c.id}" title="${esc(c.actor.id+' · '+c.object.id)}">${icon(c.actor.kind==='role'?'role':'assignment')}<span><b>${esc(c.actor.name||c.actor.id)}</b><small>${esc(c.action)} · ${esc(c.object.type)}</small><small class="pr-object-id" title="${esc(c.object.id)}">${esc(c.object.id)}</small></span><span class="pr-time">${ms(c.indexedMedian??c.median)}<small>ms ${icon(c.decision==null?'warning':c.decision?'valid':'close')}</small></span></button>`).join('')||'<div class="pr-empty">'+(checks.length?'No matching checks.':'No measured checks yet.')+'</div>';
  }
  const bar=(n,max)=>`<span class="pr-timing"><i style="--cost:${Math.min(100,Math.max(0,(Number.isFinite(n)?n:0)/(max||1)*100))}%"></i><b>${ms(n)}</b></span>`;
  function traceStep(n,path){const label=n.details?.left?`${n.details.left} ${n.element} ${n.details.right||''}`:n.element==='HasAccessTo'?`HasAccessTo · ${n.details.reference}`:n.element==='Statement'?`${n.details.policyRid_name||'Policy'} · Rule ${Number(n.details.statementIndex)+1}`:n.element;
    const row=`<span>${esc(label)}</span><span class="pr-trace-result ${n.result?'yes':'no'}">${icon(n.result?'valid':'skipped')}</span><b>${ms(n.durationMs)} ms</b>`;
    return n.children?.length?disclosure('trace:'+state.selected+':'+state.rule+':'+path,row,()=>`<div class="pr-trace-children">${n.children.map((c,i)=>traceStep(c,path+'.'+i)).join('')}</div>`):`<div class="pr-trace-leaf">${row}</div>`;
  }
  function diagnosis(r,c){const d=diagnose(r,c),related=findings.filter(f=>f.rules.some(x=>x.policy.rid===r.policy?.rid&&x.index===r.index));
    const roles=[c.policyLookup.get(r.policy?.rid)?.content?.Statement?.[r.index]?.Subject].flat().filter(s=>typeof s==='string'&&s.startsWith('role:')).map(s=>current.snapshot.model.roles.find(x=>x.id===s.slice(5))).filter(Boolean);
    return `<div class="pr-diagnosis"><header>${icon('performance')}<strong>${esc(d.title)}</strong><span>${d.share!=null?d.share+'% of rule':''}</span><b>${ms(d.time)} ms</b></header>${d.reason?`<p>${esc(d.reason)}</p>`:''}${roles.length&&d.title==='Subject / role resolution'?`<div class="pr-role-links">${roles.map(r=>`<button data-pr-role="${esc(r.rid)}">${icon('role')}${esc(r.id)}</button>`).join('')}</div>`:''}${d.title==='Related-object access'?`<p><code>${esc(d.detail)}</code> · ${esc(d.extra)}</p>`:''}
      <section class="pr-suggestion"><header>${icon('search')}<b>${related.some(f=>f.category!=='reviewed')?'Improvements to review':'No optimization identified'}</b></header>${related.filter(f=>f.category!=='reviewed').map(f=>`<button data-pr-finding="${esc(f.id)}">${icon(f.category==='access'?'warning':'performance')}${esc(f.title)}<small>${f.category==='access'?'Access logic':'Not measured'}</small>${icon('arrow')}</button>`).join('')}${disclosure('considered:'+r.key,'What was checked',`<p>${d.title==='Subject / role resolution'?'The native trace times the subject as a whole; it does not identify a slow individual delegation. Extra resource guards did not consistently remove this work in validation.':'Recursive access, duplicated logic and comparison order were considered. Indexed evaluation can already share or reorder work.'}</p>${related.filter(f=>f.category==='reviewed').map(f=>`<p><b>${esc(f.title)}</b> — ${esc(f.limit)}</p>`).join('')}<p>A failed match does not establish that a rule is unused. Removing roles, assignments or delegations can change access.</p>`)}</section>
      ${disclosure('breakdown:'+r.key,'Execution breakdown',()=>`<div class="pr-trace">${r.node.children.map((n,i)=>traceStep(n,String(i))).join('')}</div>`)}</div>`;
  }
  function renderMain(){
    const main=$('.pr-main'),c=checks.find(c=>c.id===state.selected);
    if(state.view==='scope'){
      const s=sampleSummary(checks);main.innerHTML=`<header class="pr-heading">${icon('sliders')}<h2>Analysis scope</h2></header><div class="pr-scroll pr-info"><p>${s.runs} native timings · ${s.objects} existing objects · ${s.proposedTypes} prepared Create types</p><p>Up to 48 checks across 12 policy types. Subjects come from field assignments and global role memberships, or a small user sample when neither is available. Role simulations are separate subjects. This is a sample, not a complete permission audit.</p><p>Each context has one discarded warmup and five measured runs per mode. Server totals are shown first; sequential traces provide rule attribution. Indexing is requested for server totals, but BMP can disable it; each check shows the observed mode when its trace identifies it. Diagnostic result caching is bypassed. These are server evaluation times, not page-load timings. Measurements stay in this tab until it is closed or reloaded.</p><p>Update discovery tests a name change. Create requires a prepared test with meaningful submitted values; use “Profile this check” in Access test.</p>${current?`<p>${current.scope.prepared?'One prepared access check.':current.plan.needsCreate+' rules include Create.'} ${current.scope.unsampledTypes.length} types outside this sample. ${current.plan.capped?'The check limit was reached.':''}</p>`:''}${current?.problems.length?`<h3>Not measured / incomplete</h3><ul>${current.problems.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}</div>`;return;
    }
    if(state.view==='comparison'){
      const rows=comparePerformance(controller.state.previous,current);main.innerHTML=`<header class="pr-heading">${icon('history')}<h2>Compare runs</h2></header><div class="pr-scroll"><p class="pr-info">${rows.filter(r=>!r.missing).length} of ${rows.length} contexts compared · server medians. Observed changes are not controlled A/B proof; load, object data and memberships can also change.</p><table class="pr-table pr-comparison"><thead><tr><th>Context</th><th>Before ms</th><th>After ms</th><th>Δ ms</th><th>Access</th><th>Finding</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.changed?'pr-access-changed':r.slower?'pr-regression':''}"><td><button data-pr-check="${esc(r.id)}" ${r.canOpen?'':'disabled'}>${esc(r.actor.id)}<small>${esc(r.action+' · '+r.object.id)}</small></button></td><td>${ms(r.before)}</td><td>${ms(r.after)}</td><td>${Number.isFinite(r.before)&&Number.isFinite(r.after)?(r.after>r.before?'+':'')+ms(r.after-r.before):'—'}</td><td>${r.missing?'Not compared':r.changed?`${r.beforeResult?'Granted':'Denied'} → ${r.afterResult?'Granted':'Denied'}`:r.stable?'Unchanged':'Unstable'}</td><td title="${esc(r.error||'')}">${esc(r.status)}</td></tr>`).join('')}</tbody></table>${!rows.length?'<div class="pr-empty">Complete both runs with an unchanged configuration during each run to compare matching contexts.</div>':''}</div>`;return;
    }
    if(state.view==='improvements'){
      const rows=findings.filter(f=>state.filter==='actionable'?f.category!=='reviewed':f.category===state.filter);
      main.innerHTML=`<header class="pr-heading">${icon('changes')}<h2>Improvements</h2><span>${findings.filter(f=>f.category!=='reviewed').length} patterns</span></header><nav class="pr-filters">${icon('filter')}${[['actionable','To review'],['investigate','Needs measurement'],['access','Access logic'],['reviewed','Reviewed']].map(([id,label])=>`<button data-pr-filter="${id}" aria-pressed="${state.filter===id}">${label}</button>`).join('')}</nav><div class="pr-scroll">${rows.map(f=>disclosure('finding:'+f.id,`<b>${esc(f.title)}</b><span class="pr-tag ${f.category}">${f.category==='access'?'May change access':f.category==='reviewed'?'No speed recommendation':'Not measured'}</span>`,`<div class="pr-finding"><p>${esc(f.reason)}</p><p>${esc(f.limit)}</p>${f.coveredBy?'<h3>Must remain enabled</h3>'+f.coveredBy.map(r=>`<div class="pr-rule-link">${icon('policy')}<span>${esc(r.policy.name)} · Rule ${r.index+1}</span>${ruleButton(r)}</div>`).join(''):''}${f.rules.map(r=>`<div class="pr-rule-link">${icon('policy')}<span>${esc(r.policy.name)} · Rule ${r.index+1}</span>${ruleButton(r)}</div>`).join('')}</div>`)).join('')||'<div class="pr-empty">No findings in this category.</div>'}</div>`;return;
    }
    if(state.view==='policies'){
      const rows=totals;main.innerHTML=`<header class="pr-heading">${icon('policy')}<h2>Measured policies</h2><span>${rows.length} rules · sequential attribution</span></header><div class="pr-scroll"><table class="pr-table"><thead><tr><th>Policy / rule</th><th>Main cost</th><th>Checks</th><th>Longest ms</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><button data-pr-check="${esc(r.maxCheck)}" data-pr-rule="${esc(r.key)}">${esc(r.name)}<small>Rule ${r.index+1}</small></button></td><td>${esc(r.driver)}</td><td>${r.calls}</td><td>${bar(r.max,rows[0]?.max)}</td><td class="pr-action-cell">${ruleButton(r)}</td></tr>`).join('')}</tbody></table></div>`;return;
    }
    if(!c){main.innerHTML='<div class="pr-empty">'+icon('performance')+'<h2>Find costly access checks</h2><p>Analyze discovers sample objects and subjects, then measures the policies BMP evaluates.</p><button data-pr="analyze" class="primary" '+(controller.state.running?'disabled':'')+'>'+icon('run')+'Analyze</button></div>';return;}
    const selected=c.rules.find(r=>r.key===state.rule)||(!state.rule?c.slowest:null);if(selected)state.rule=selected.key;
    main.innerHTML=`<header class="pr-context"><div><b>${esc(c.action)}</b><h2 title="${esc(c.object.name)}">${esc(c.object.id)}</h2>${outcome(c.decision)}<strong>${ms(c.indexedMedian)} <small>ms · server</small></strong></div><div><span>${icon(c.actor.kind==='role'?'role':'assignment')}${esc(c.actor.id)}</span><span>${esc(c.object.type)} · ${esc(c.strategy)}${c.proposedLabel?' · '+esc(c.proposedLabel):''}</span><button data-pr="test" class="pr-test">${icon('run')}Open access test</button></div>${!c.consistent?'<p class="pr-notice error">Decisions differed between runs or modes. Do not treat this as an equivalent optimization.</p>':''}</header>
      <div class="pr-heading"><h3>Policies evaluated</h3><span>${c.rules.length} rules · sequential ${ms(c.median)} ms</span></div><div class="pr-scroll"><table class="pr-table"><thead><tr><th>Policy / rule</th><th>Result</th><th>Time · ms</th><th></th></tr></thead><tbody>${c.rules.toSorted((a,b)=>b.node.durationMs-a.node.durationMs).map(r=>`<tr class="${r.key===selected?.key?'selected':''}"><td><button data-pr-select="${esc(r.key)}" aria-expanded="${r.key===selected?.key}">${icon('down')}${icon('policy')}<span>${esc(r.name)}<small>Rule ${r.index+1}</small></span></button></td><td>${r.node.result?'<span class="pr-decision granted">'+icon('valid')+'Matches</span>':'No match'}</td><td>${bar(r.node.durationMs,c.trace.durationMs)}</td><td class="pr-action-cell">${ruleButton(r)}</td></tr>${r.key===selected?.key?`<tr><td colspan="4">${diagnosis(r,c)}</td></tr>`:''}`).join('')}</tbody></table></div><footer class="pr-check-footer">${!c.consistent?'Decisions differ between runs or modes':c.grant?`${icon('valid')} Granted by ${esc(c.grant.name)} · Rule ${c.grant.index+1}`:c.trace.result?'No policy grant recorded':'No granting rule'}<span>${c.runs.length} runs · ${ms(c.min)}–${ms(c.max)} ms sequential</span></footer>`;
  }
  function click(e){const b=e.target.closest('button');if(!b)return;
    if(b.dataset.prPolicy){openRule(b.dataset.prPolicy,b.dataset.rule===''?undefined:Number(b.dataset.rule),current?.snapshot);return;}
    if(b.dataset.prRole){openRole(b.dataset.prRole);return;}
    capture();
    if(b.dataset.prCheck){state.selected=b.dataset.prCheck;state.rule=b.dataset.prRule||'';state.view='checks';state.scroll=0;}
    else if(b.dataset.prSelect){state.rule=state.rule===b.dataset.prSelect?'__collapsed__':b.dataset.prSelect;}
    else if(b.dataset.prView){state.view=b.dataset.prView;state.scroll=0;}
    else if(b.dataset.prFilter){state.filter=b.dataset.prFilter;state.scroll=0;}
    else if(b.dataset.prFinding){state.view='improvements';state.filter='actionable';state.open.push('finding:'+b.dataset.prFinding);state.scroll=0;}
    else if(b.dataset.pr==='analyze'||b.dataset.pr==='rerun'){void controller.run(b.dataset.pr==='rerun');return;}
    else if(b.dataset.pr==='stop'){controller.stop();return;}
    else if(b.dataset.pr==='scope'){state.view='scope';state.scroll=0;}
    else if(b.dataset.pr==='test'){const c=checks.find(c=>c.id===state.selected);if(c)test(c);return;}
    render(false);
  }
  root.addEventListener('click',click);
  function expand(e){const d=e.target;if(!root.contains(d)||!d.open||!d.hasAttribute('data-lazy'))return;const body=lazyBodies.get(d.dataset.disclosure);d.removeAttribute('data-lazy');if(body)d.insertAdjacentHTML('beforeend',body());}
  root.addEventListener('toggle',expand,true);
  root.addEventListener('input',e=>{if(e.target.id==='performance-query'){state.query=e.target.value;renderList();}});
  root.addEventListener('change',e=>{if(e.target.matches('[data-pr-result]')){state.result=e.target.value;renderList();}});
  function renderKey(){const r=controller.state,c=r.current;return [c,c?.checks.length,c?.failures?.length,c?.stale,c?.historical,r.running,r.error,r.previous];}
  const unsubscribe=controller.subscribe(()=>{
    const key=renderKey();
    if(key.length===lastRender.length&&key.every((v,i)=>v===lastRender[i])){
      const status=$('.pr-status>span'),progress=$('.pr-status progress');
      if(status)status.textContent=controller.state.progress;
      if(progress){progress.max=controller.state.total||1;progress.value=controller.state.completed;}
    }else render();
  });render(false);
  return {capture,destroy(){capture();disposed=true;unsubscribe();root.removeEventListener('click',click);root.removeEventListener('toggle',expand,true);}};
}
