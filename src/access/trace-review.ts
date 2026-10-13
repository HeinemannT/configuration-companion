import type { AccessTraceNode } from '../lib/types';
import { icon } from './icons';
import { traceRules } from './trace-summary';
import { traceLabel } from './trace-view';
import { renderTraceTiming } from './trace-timing';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
type CanOpen = (rid: string, index: number) => boolean;
export interface TraceReviewState { open?: string[]; groups?: string[]; closedGroups?: string[]; groupUnmatched?: boolean; query?: string; }
type Rule = ReturnType<typeof traceRules>[number];
const labels = {matched:'Matched',failed:'Did not match',skipped:'Not evaluated',unknown:'Incomplete'};
const outcome = (value: Rule['subject']) => `<span class="er-outcome" data-state="${value}" title="${labels[value]}">${icon(value==='matched'?'valid':value==='failed'?'close':value==='skipped'?'skipped':'warning')}<span class="sr-only">${labels[value]}</span></span>`;
const result = (n: AccessTraceNode): Rule['subject'] => n.timedOut || n.result == null ? 'unknown' : n.result ? 'matched' : 'failed';
const validTarget = (rule: Rule) => /^\d+$/.test(rule.node.details.policyRid??'') && /^\d+$/.test(rule.node.details.statementIndex??'') && Number.isSafeInteger(Number(rule.node.details.statementIndex));
function openButton(rule: Rule, canOpen: CanOpen): string {
  const d=rule.node.details;
  return validTarget(rule) ? `<button type="button" class="er-open" data-command="open-trace-policy" data-rid="${esc(d.policyRid)}" data-statement="${d.statementIndex}" aria-label="Open ${esc(d.policyRid_name||d.policyRid)}, rule ${Number(d.statementIndex)+1}" ${canOpen(d.policyRid,Number(d.statementIndex))?'title="Open saved rule"':'disabled title="Saved rule differs from the local draft; apply or reload to open safely"'}>${icon('open')}</button>` : '';
}

function predicate(node: AccessTraceNode, path: string, depth = 0): string {
  const d=node.details;
  const expr=d.left || d.reference || d.original;
  const omitted=new Set(['left','reference','original']);
  if(Number(d.numberOfAccessChecks)===0)omitted.add('numberOfAccessChecks');
  const names: Record<string,string>={right:'Compared with',leftResolved:'Actual',globalMatchEntity:'Matched globally',localMatchEntity:'Matched on object',requestedAction:'Requested',roleId:'Role ID',userId:'User ID'};
  const values=Object.entries(d).filter(([k])=>!omitted.has(k)&&!k.endsWith('_name')).map(([k,v])=>{
    const name=d[k+'_name'];
    return `<div><dt>${esc(names[k]??k)}</dt><dd>${name?`<strong>${esc(name)}</strong> <small>${esc(v)}</small>`:esc(v||'(empty)')}</dd></div>`;
  }).join('');
  return `<div class="er-predicate" data-engine-path="${esc(path)}"><div class="er-predicate-head">${outcome(result(node))}<strong>${esc(traceLabel(node))}</strong>${expr?`<code>${esc(expr)}</code>`:''}${node.timedOut?'<span>Timed out</span>':''}${renderTraceTiming(node.durationMs)}</div>${values?`<dl>${values}</dl>`:''}${depth<32?node.children.map((c,i)=>predicate(c,path+'.'+i,depth+1)).join(''):'<span>Further detail is available in the raw trace.</span>'}</div>`;
}

function ruleRow(rule: Rule, i: number, canOpen: CanOpen, state: TraceReviewState, grouped = false): string {
  const {node,path}=rule,d=node.details,expanded=state.open?.includes(path),number=/^\d+$/.test(d.statementIndex??'')?Number(d.statementIndex)+1:'?';
  return `<tr class="er-rule${grouped?' er-group-child':''}" data-state="${result(node)}" data-engine-row="${esc(path)}"><td>${i+1}</td><th scope="row"><button data-engine-toggle="${esc(path)}" aria-expanded="${!!expanded}"><span class="er-disclosure">${icon('down')}</span>${icon('policy')}<span>${esc(d.policyRid_name||d.policyRid||'Policy')}</span><small>Rule ${number}</small></button></th>${(['subject','action','resource'] as const).map(k=>`<td>${outcome(rule[k])}</td>`).join('')}<td class="er-decision" data-state="${result(node)}">${node.timedOut?'Timed out':node.result===true?'Granted':node.result===false?'No grant':'Unknown'}</td><td class="er-time">${renderTraceTiming(node.durationMs)||'—'}</td><td>${openButton(rule,canOpen)}</td></tr>${expanded?`<tr class="er-detail${grouped?' er-group-child':''}"><td></td><td colspan="7"><div class="er-rule-meta">Rule ${number} · ${esc(d.effect||'Effect not reported')}${rule.action==='failed'?' · Action not included · conditions not evaluated':rule.subject==='failed'?' · Subject did not match':''}</div>${node.children.map((c,j)=>predicate(c,path+'.'+j)).join('')||'<p>No predicate details were returned.</p>'}</td></tr>`:''}`;
}

function ruleTable(rows: string, label: string): string {
  return `<table class="er-table" aria-label="${label}"><colgroup><col class="er-number-column"><col><col class="er-stage-column" span="3"><col class="er-result-column"><col class="er-time-column"><col class="er-open-column"></colgroup><thead><tr><th>#</th><th>Policy / rule</th><th>Subject</th><th>Action</th><th>Resource</th><th>Result</th><th class="er-time" title="BMP elapsed time including nested evaluations">Time</th><th><span class="sr-only">Open rule</span></th></tr></thead><tbody>${rows||'<tr><td colspan="8">No matching rules in this trace.</td></tr>'}</tbody></table>`;
}

function table(rules: Rule[], canOpen: CanOpen, state: TraceReviewState): string {
  const query=(state.query??'').trim().toLowerCase();
  let rows=rules.flatMap((rule,i)=>rule.node.result===true&&!rule.node.timedOut?[ruleRow(rule,i,canOpen,state)]:[]).join(''), group: Array<{rule:Rule;i:number}>=[];
  function flush() {
    if(!group.length)return;
    const id=group[0].rule.path,expanded=state.groups?.includes(id)||!state.closedGroups?.includes(id)&&group.some(r=>state.open?.includes(r.rule.path)),grouped=group.length>1&&!query&&state.groupUnmatched!==false;
    if(grouped) rows+=`<tr class="er-group"><td>${group[0].i+1}–${group.at(-1)!.i+1}</td><td colspan="7"><button data-engine-group="${esc(id)}" aria-expanded="${!!expanded}"><span class="er-disclosure">${icon('down')}</span>${group.length} rules · subject did not match</button></td></tr>`;
    if(expanded||!grouped)rows+=group.map(({rule,i})=>ruleRow(rule,i,canOpen,state,grouped)).join('');
    group=[];
  }
  rules.forEach((r,i)=>{
    if(r.node.result===true&&!r.node.timedOut){flush();return;}
    if(query&&!((r.node.details.policyRid_name??'')+' '+(r.node.details.policyRid??'')).toLowerCase().includes(query)){flush();return;}
    if(r.subject==='failed'&&r.node.result!==true)group.push({rule:r,i});
    else {flush();rows+=ruleRow(r,i,canOpen,state);}
  });flush();
  return ruleTable(rows,'Engine trace · granting rule first, original evaluation numbers retained');
}

export function renderEngineTrace(trace: AccessTraceNode, canOpen: CanOpen, state: TraceReviewState = {}): string {
  const rules=traceRules(trace);
  return `<section class="engine-review" aria-label="Engine trace"><div class="er-toolbar">${icon('list')}<strong>Engine trace</strong><small>${rules.length} evaluated rules · ${rules.some(r=>r.node.result===true&&!r.node.timedOut)?'granting rule first':'engine order'}</small><label class="er-grouping" title="Group consecutive rules whose subjects did not match"><input type="checkbox" data-engine-grouping ${state.groupUnmatched!==false?'checked':''}>Group unmatched</label><label class="er-search">${icon('search')}<input type="search" data-engine-search placeholder="Find policy…" aria-label="Find policy in trace" value="${esc(state.query??'')}"></label></div><div class="er-scroll" data-engine-section="all">${table(rules,canOpen,state)}</div><p class="er-note">${trace.timedOut||trace.result==null?'The trace is incomplete. No final decision is implied.':trace.result===true?'Evaluation stops at the first grant. Later rules are not shown.':'Only returned evaluations are shown. A dash means not evaluated.'}</p></section>`;
}

/** Bind after a test rerender. Expansion belongs to the test result, so following
 * a policy and returning preserves both input values and the trace view. */
export function mountEngineTrace(host: HTMLElement, trace: AccessTraceNode, canOpen: CanOpen, state: TraceReviewState, changed: () => void): void {
  const root=host.querySelector<HTMLElement>('.engine-review');if(!root)return;
  const rules=traceRules(trace);
  const update=()=>{
    root.querySelector('[data-engine-section="all"]')!.innerHTML=table(rules,canOpen,state);changed();
  };
  root.addEventListener('click',event=>{
    const b=(event.target as Element).closest<HTMLButtonElement>('button');if(!b)return;
    const key=b.dataset.engineToggle??b.dataset.engineGroup;if(key===undefined)return;
    const section=b.closest<HTMLElement>('[data-engine-section]')!;
    const scroll=host.closest<HTMLElement>('.test-body'), top=b.getBoundingClientRect().top;
    if(b.dataset.engineGroup!==undefined){
      const closing=b.getAttribute('aria-expanded')==='true';
      state.groups=closing?(state.groups??[]).filter(v=>v!==key):[...new Set([...(state.groups??[]),key])];
      state.closedGroups=closing?[...new Set([...(state.closedGroups??[]),key])]:(state.closedGroups??[]).filter(v=>v!==key);
    } else state.open=state.open?.includes(key)?state.open.filter(v=>v!==key):[...(state.open??[]),key];
    update();
    const target=[...section.querySelectorAll<HTMLButtonElement>('[data-engine-toggle],[data-engine-group]')].find(el=>(el.dataset.engineToggle??el.dataset.engineGroup)===key);
    target?.focus({preventScroll:true});
    // Keep the disclosure in place, including native scroll anchoring.
    if(scroll&&target)scroll.scrollTop+=target.getBoundingClientRect().top-top;
  });
  root.querySelector<HTMLInputElement>('[data-engine-search]')?.addEventListener('input',event=>{state.query=(event.target as HTMLInputElement).value;update();});
  root.querySelector<HTMLInputElement>('[data-engine-grouping]')?.addEventListener('change',event=>{state.groupUnmatched=(event.target as HTMLInputElement).checked;update();});
}
