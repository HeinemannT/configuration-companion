import { icon } from './icons';
import { PBAC_ACTIONS, activePBACExpressions, pbacAction, pbacGrouping } from './pbac-syntax.js';
import { comparisonLabels } from './picker-model.js';
import { filterMatrix } from './matrix-model.js';
import { tokenizePBAC } from './pbac-highlighting.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const json = value => tokenizePBAC(JSON.stringify(value, null, 2)).map(line => line.map(t => t.type ? `<span class="pbac-${t.type}">${esc(t.text)}</span>` : esc(t.text)).join('')).join('\n');
const crud = (cell, showUnresolved = false) => cell.actions.map(a => `<span data-letter="${a[0]}" title="${a}${cell.conditionalActions?.includes(a)?' · Conditional coverage':''}">${a[0]}${cell.conditionalActions?.includes(a)?'<sup>*</sup>':''}</span>`).join('') +
  (showUnresolved && cell.unresolved ? '<span class="am-unresolved" title="Unresolved candidates · not counted as coverage">?</span>' : '') + (cell.deny ? '<sup class="am-deny" title="Includes a Deny rule">!</sup>' : '');
const key = (rid, type = '') => rid + '|' + type;

// Rendering replaces the controls. Restore the exact control and text selection,
// not just the grid cell, so repeated keyboard filtering stays in place.
function rememberFocus(host) {
  const el = document.activeElement;
  if (!host.contains(el)) return null;
  const attributes = [...el.attributes].filter(a => a.name.startsWith('data-matrix-') || a.name === 'data-grid-key');
  if (!attributes.length) return null;
  const scope = ['.am-section-menu', '.am-toolbar', '.am-inspector', '.am-rail'].find(s => el.closest(s));
  const selection = el.matches('input[type=text],input:not([type])')
    ? [el.selectionStart, el.selectionEnd, el.selectionDirection] : null;
  return { attributes, scope, selection };
}

function restoreFocus(host, bookmark) {
  if (!bookmark) return;
  const matches = [...host.querySelectorAll('button,input')].filter(el => bookmark.attributes.every(a => el.getAttribute(a.name) === a.value));
  const panelFallback = bookmark.attributes.some(a => a.name === 'data-matrix-panel')
    ? host.querySelector('.am-rail [data-matrix-panel],.am-inspector [data-matrix-panel]') : null;
  const target = matches.find(el => !bookmark.scope || el.closest(bookmark.scope)) || panelFallback || matches[0];
  target?.focus({ preventScroll: true });
  if (target && bookmark.selection) target.setSelectionRange(...bookmark.selection);
}

export function matrixState() {
  return { roleQ:'', typeQ:'', filters:[], sections:[], hideEmpty:true, unresolved:false, sort:'name', selected:null, collapsed:false,
    width:296, scroll:[0,0], inspectorScroll:0, closed:[], json:[], action:'Read', focus:'' };
}

function previewValue(value) {
  const values=Array.isArray(value)?value:[value];
  if(!values.length)return '<span>[]</span>';
  return values.map(v=>`<span>${esc(typeof v==='string'&&v!==''?v:JSON.stringify(v))}</span>`).join(', ');
}

export function conditionPreview(value, depth = 0) {
  if (depth > 12) return '<span>Further conditions · open JSON</span>';
  if (value === '*') return '<span>All objects</span>';
  if (!value || typeof value !== 'object') return '<span>Custom expression · open JSON</span>';
  for (const group of ['All', 'Any']) if (Array.isArray(value[group])) {
    // Associative groups can be flattened for reading without rewriting the policy.
    const flatten=(items,remaining)=>items.flatMap(v=>remaining>0 && v && typeof v==='object' &&
      activePBACExpressions(v).length===1 && Array.isArray(v[group]) ? flatten(v[group],remaining-1) : [v]);
    const items=flatten(value[group],12-depth);
    if(items.length===1)return conditionPreview(items[0],depth+1);
    return `<div class="am-condition-group"><div class="am-group-label">${group==='All'?'All conditions':'Any condition'}</div><div class="am-group-items">${items.map(v=>conditionPreview(v,depth+1)).join('')||'<span>Empty group</span>'}</div></div>`;
  }
  const c = value.Condition;
  if (c) return `<div class="am-condition"><div class="am-condition-head"><code>${esc(c.Left)}</code><span class="am-comparison" title="${esc(c.Comparison)}">${esc(comparisonLabels[c.Comparison]??c.Comparison)}</span></div>${['Empty','NotEmpty'].includes(c.Comparison)?'':`<div class="am-condition-values">${previewValue(c.Right)}</div>`}</div>`;
  const access=value.HasAccessTo, role=value.HasRole;
  if(access||role){
    const raw=access||role,expression=typeof raw==='string'?{Reference:raw}:raw,
      roles=Array.isArray(expression.Roles)?expression.Roles:[];
    const action=pbacAction(expression.Action)||expression.Action||'requested',grouping=pbacGrouping(expression.Grouping);
    return `<div class="am-condition"><div class="am-condition-head"><code>${esc(expression.Reference)}</code><span class="am-comparison" title="${access?'HasAccessTo':'HasRole'}">${access?'check '+esc(action)+' access':'has role'}</span></div>${roles.length?`<div class="am-condition-detail"><span>${roles.length===1?'Role':'Roles'}</span><code>${roles.map(esc).join(', ')}</code></div>`:''}${access&&grouping?`<div class="am-reference-match">${grouping==='All'?'All referenced objects':'Any referenced object'}</div>`:''}</div>`;
  }
  return '<div class="am-condition">Custom expression · open JSON</div>';
}

/** Local controller owns grid rendering, focus and sizing; the workspace owns
 * navigation, saved models and tests. No backend requests originate here. */
export function mountMatrix(host, { index, state: s, openRule, test, canOpen, changed, metadataStatus = '', retryEvidence, moreEvidence, hasDraftChanges = false }) {
  let data, frame = 0, disposed = false, resizeObserver, sectionsOpen = false;
  const sections=[...new Set(index.columns.map(t=>t.group))];
  s.sections=(s.sections??[]).filter(group=>sections.includes(group));
  const q = selector => host.querySelector(selector);
  function sectionButton(group, band = false) {
    const selected=s.sections.includes(group);
    return `<button type="button" data-matrix-section="${esc(group)}" aria-pressed="${selected}" title="${esc(selected?(s.sections.length===1?'Show all sections':'Remove '+group+' from filter'):'Filter by '+group)}">${band?'<span class="am-band-label">'+icon('filter')+'<span>'+esc(group)+'</span></span>':'<span>'+esc(group)+'</span>'}</button>`;
  }
  function sectionControl() {
    const label=s.sections.length===1?s.sections[0]:s.sections.length?s.sections.length+' sections':'All sections';
    return `<div class="am-section-control"><button type="button" data-matrix-sections aria-expanded="${sectionsOpen}" aria-label="Choose object sections" title="${esc(label)}">${icon('filter')}<span>${esc(label)}</span>${icon('down')}</button>${s.sections.length?`<button type="button" data-matrix-section="" aria-label="Clear section filter" title="All sections">${icon('close')}</button>`:''}${sectionsOpen?`<div class="am-section-menu" role="group" aria-label="Filter object sections"><button type="button" data-matrix-section="" aria-pressed="${!s.sections.length}">All sections</button>${sections.map(group=>sectionButton(group)).join('')}</div>`:''}</div>`;
  }
  function capture() {
    const grid = q('.am-grid');
    if (grid) s.scroll = [grid.scrollLeft, grid.scrollTop];
    if (q('.am-content')) s.inspectorScroll = q('.am-content').scrollTop;
  }
  function render() {
    data = filterMatrix(index, s);
    const focus = rememberFocus(host);
    host.innerHTML = `<div class="am-toolbar" aria-label="Matrix filters and sorting"><span class="am-tool-icon" title="Filter">${icon('filter')}</span>
      ${[['roleQ','role','Find role…'],['typeQ','type','Find type…']].map(([field,glyph,label]) => `<label class="am-search">${icon(glyph)}<input data-matrix-input="${field}" value="${esc(s[field])}" placeholder="${label}" aria-label="${label.replace('…','')}">${icon('search')}</label>`).join('')}
      <div class="am-segment" role="group" aria-label="Show cells containing any selected action"><button data-matrix-filter="All" aria-pressed="${!s.filters.length}">All</button>${PBAC_ACTIONS.map(a => `<button data-matrix-filter="${a}" data-letter="${a[0]}" aria-label="Filter ${a}" title="Show cells containing ${a}; keep their complete CRUD" aria-pressed="${s.filters.includes(a)}">${a[0]}</button>`).join('')}</div>
      <label class="am-check"><input type="checkbox" data-matrix-empty ${s.hideEmpty?'checked':''}>Hide empty</label>
      <label class="am-check" title="Include candidates that cannot establish coverage. A question mark is not a grant."><input type="checkbox" data-matrix-unresolved ${s.unresolved?'checked':''}>Show unresolved</label>
      <div class="am-sort"><span class="am-tool-icon" title="Sort roles">${icon('sort')}</span><div class="am-segment" role="group" aria-label="Sort roles">${[['name','A–Z','Role name'],['coverage','Most','Most covered actions']].map(([v,label,title])=>`<button data-matrix-sort="${v}" aria-label="${title}" aria-pressed="${s.sort===v}">${label}</button>`).join('')}</div></div>
      <button class="am-details" data-matrix-panel aria-expanded="${!!s.selected&&!s.collapsed}" ${s.selected?'':'disabled'}>${icon('panel')}Details</button></div>
      <div class="am-work"><div class="am-grid" aria-label="Access matrix"></div>${inspector()}</div>
      <div class="am-foot"><span>Saved policies${hasDraftChanges?' · Draft changes not included':''} · ${data.rows.length} roles · ${data.cols.length} types${metadataStatus?' · '+esc(metadataStatus):''}${retryEvidence?' <button data-matrix-retry>Retry evidence</button>':''}${moreEvidence?' <button data-matrix-more>Load next references</button>':''}</span><span title="Coverage for the selected Role entity, including ancestors. Local user assignments and unresolved candidates are not grants. Test an object for effective access.">* conditional · ? unresolved · ! Deny · Blank does not mean denied</span></div>`;
    renderGrid();
    const grid = q('.am-grid');
    [grid.scrollLeft, grid.scrollTop] = s.scroll;
    resizeObserver?.disconnect();
    if(typeof ResizeObserver!=='undefined'){
      resizeObserver=new ResizeObserver(()=>{
        if(disposed||frame)return;
        frame=requestAnimationFrame(()=>{frame=0;capture();renderRows();});
      });
      resizeObserver.observe(grid);
    }
    grid.addEventListener('scroll', () => {
      capture();
      if (!frame) frame = requestAnimationFrame(() => { frame=0; renderRows(); });
    }, {passive:true});
    if (q('.am-content')) q('.am-content').scrollTop = s.inspectorScroll;
    q('.am-content')?.addEventListener('scroll', capture, {passive:true});
    const resized = q('.am-resize');
    if (resized) installResize(resized);
    restoreFocus(host, focus);
  }
  function gridTarget(value) { return [...host.querySelectorAll('[data-grid-key]')].find(el => el.dataset.gridKey === value); }
  function revealGridTarget(target) {
    if (!target) return;
    const grid=q('.am-grid'), bounds=grid.getBoundingClientRect(), rect=target.getBoundingClientRect();
    const top=bounds.top+(q('.am-table thead')?.getBoundingClientRect().height??0);
    const left=bounds.left+(q('.am-role-heading')?.getBoundingClientRect().width??0);
    // Native scrollIntoView treats cells behind sticky headers as visible.
    // Scroll this pane only and leave both headers clear of the focused cell.
    if(rect.top<top)grid.scrollTop-=top-rect.top;
    else if(rect.bottom>bounds.top+grid.clientHeight)grid.scrollTop+=rect.bottom-bounds.top-grid.clientHeight;
    if(target.dataset.matrixCell){
      if(rect.left<left)grid.scrollLeft-=left-rect.left;
      else if(rect.right>bounds.left+grid.clientWidth)grid.scrollLeft+=rect.right-bounds.left-grid.clientWidth;
    }
  }
  function renderGrid() {
    const {rows, cols}=data;
    q('.am-grid').innerHTML = rows.length && cols.length ? `<table class="am-table" role="grid" aria-label="Role policy coverage" aria-rowcount="${rows.length+2}" style="width:${198+cols.reduce((n,t)=>n+t.width,0)}px"><colgroup><col style="width:198px">${cols.map(t=>`<col style="width:${t.width}px">`).join('')}</colgroup><thead><tr class="am-groups"><td class="am-corner">${sectionControl()}</td>${[...new Set(cols.map(t=>t.group))].map(g=>`<th scope="colgroup" colspan="${cols.filter(t=>t.group===g).length}">${sectionButton(g,true)}</th>`).join('')}</tr><tr><th scope="col" class="am-role-heading"><span>${icon('role')}Role</span></th>${cols.map(t=>`<th scope="col" title="${esc(t.id)}">${esc(t.id)}</th>`).join('')}</tr></thead><tbody></tbody></table>` : `<div class="am-empty-section">${sectionControl()}</div><p class="am-empty">No matching roles or types.</p>`;
    renderRows();
  }
  function renderRows() {
    const body=q('.am-table tbody'); if(!body)return;
    const active=host.contains(document.activeElement) ? document.activeElement.dataset.gridKey : null;
    const {rows,cols,matches}=data, start=rows.length>160?Math.max(0,Math.floor((s.scroll[1]-52)/26)-15):0,
      end=rows.length>160?Math.min(rows.length,start+Math.ceil((q('.am-grid').clientHeight||700)/26)+35):rows.length;
    // Keep the full header/column geometry, but instantiate only visible cells.
    // This bounds DOM work for wide live catalogues without extra BMP requests.
    let offset=0;
    const left=Math.max(0,s.scroll[0]-220),right=s.scroll[0]+(q('.am-grid').clientWidth||1000)+220;
    const visible=cols.map((t,i)=>{const x=offset;offset+=t.width;return {t,i,x};}).filter(c=>c.x+c.t.width>=left&&c.x<=right);
    const first=visible[0]?.i??0,last=(visible.at(-1)?.i??-1)+1;
    const gap=count=>count?`<td class="am-spacer" aria-hidden="true" colspan="${count}"></td>`:'';
    const spacer=height=>height?`<tr aria-hidden="true" class="am-spacer"><td colspan="${cols.length+1}" style="height:${height}px"></td></tr>`:'';
    body.innerHTML=spacer(start*26)+rows.slice(start,end).map((r,ri)=>`<tr aria-rowindex="${start+ri+3}" class="${s.highlight===r.rid?'am-highlight':''}"><th scope="row"><span class="am-role-name">${icon('role')}<button data-grid-key="${esc(key(r.rid))}" data-matrix-role="${esc(r.rid)}" tabindex="-1" title="${esc(r.name+' · '+r.id)}">${esc(r.name)}</button></span></th>${gap(first)}${visible.map(({t,i})=>{
      if(!matches(r.rid,t.id))return '<td class="am-filtered"></td>';
      const cell=(index.summary??index.cell)(r.rid,t.id), selected=s.selected?.role===r.rid&&s.selected?.type===t.id;
      return `<td class="${i===0||cols[i-1].group!==t.group?'am-group-start':''}"><button class="am-cell" data-grid-key="${esc(key(r.rid,t.id))}" data-matrix-cell="${esc(r.rid)}" data-type="${esc(t.id)}" data-grants="${cell.actions.length}" tabindex="-1" aria-pressed="${selected}" aria-label="${esc(r.name+', '+t.id+': '+(cell.actions.join(', ')||'no Allow coverage')+(cell.conditional?', conditional':'')+(cell.deny?', Deny rule present':'')+(s.unresolved&&cell.unresolved?', unresolved candidates available':''))}">${crud(cell,s.unresolved)}</button></td>`;
    }).join('')}${gap(cols.length-last)}</tr>`).join('')+spacer((rows.length-end)*26);
    const target=gridTarget(active??s.focus)||gridTarget(s.selected?key(s.selected.role,s.selected.type):'')||q('[data-grid-key]');
    if(target)target.tabIndex=0;
    if(active)target?.focus({preventScroll:true});
  }
  function inspector() {
    const selection=s.selected, role=selection&&index.roles.find(r=>r.rid===selection.role);
    if(!role)return '';
    if(s.collapsed)return `<aside class="am-rail"><button class="icon-button" data-matrix-panel aria-label="Expand policy details">${icon('down')}</button></aside>`;
    const cell=index.cell(role.rid,selection.type), shownRules=[...new Map([...cell.rules,...(s.unresolved?cell.unresolvedRules??[]:[])].map(rule=>[rule.key,rule])).values()], hidden=!data.rows.includes(role)||!data.cols.some(t=>t.id===selection.type)||!data.matches(role.rid,selection.type);
    return `<aside class="am-inspector" style="--am-width:${s.width}px" aria-label="Policy details"><div class="am-resize" role="separator" tabindex="0" aria-label="Resize policy details" aria-orientation="vertical" aria-valuemin="240" aria-valuemax="520" aria-valuenow="${s.width}"></div><div class="am-pane-head">${icon('role')}<div><button data-matrix-role="${esc(role.rid)}" title="Highlight role">${esc(role.name)}</button><small>${esc(selection.type)}</small></div><button class="icon-button am-collapse" data-matrix-panel aria-label="Collapse policy details">${icon('down')}</button></div>
      ${hidden?'<div class="am-hidden">Cell hidden by filters <button data-matrix-reveal>Reveal cell</button></div>':''}
      <div class="am-test"><span>Test</span><div class="am-segment" role="group" aria-label="Test action">${PBAC_ACTIONS.map(a=>`<button data-matrix-action="${a}" data-letter="${a[0]}" aria-pressed="${s.action===a}" aria-label="Test ${a}">${a[0]}</button>`).join('')}</div><button class="icon-button" data-matrix-test aria-label="Prepare ${s.action} test" title="Choose an object and test ${s.action}">${icon('run')}</button></div>
      <div class="am-content">${shownRules.length?shownRules.map(rule=>`<section class="am-rule"><div class="am-rule-head"><button class="am-disclosure" data-matrix-rule="${esc(rule.key)}" aria-expanded="${!s.closed.includes(rule.key)}" aria-label="Toggle rule ${rule.index+1}">${icon('down')}</button>${icon('policy')}<button class="am-rule-link" data-matrix-open="${esc(rule.policy.rid)}" data-statement="${rule.index}" ${canOpen(rule.policy.rid,rule.index)?'':'disabled title="Saved rule differs from the local draft; apply or reload to open safely"'}>${esc(rule.policy.name)}<small>Rule ${rule.index+1} · ${rule.effect}</small></button><span class="am-crud">${crud(rule)}${s.unresolved&&rule.unresolvedActions?.length?'<span class="am-unresolved" title="Unresolved candidates · not counted as coverage">? '+esc(rule.unresolvedActions.map(a=>a[0]).join(' '))+'</span>':''}</span></div>${s.closed.includes(rule.key)?'':`<div class="am-rule-body"><div class="am-subject"><span>Subject</span>${esc(rule.statement.Subject==='*'?'Everyone':listSubjects(rule.statement.Subject))}</div>${rule.reasons?.length?`<p class="am-evidence">${esc(rule.reasons.join(" · "))}</p>`:""}${s.unresolved&&rule.unresolvedReasons?.length?`<p class="am-evidence"><strong>Unresolved ${esc(rule.unresolvedActions.join(", "))}:</strong> ${esc(rule.unresolvedReasons.join(" · "))}</p>`:""}${conditionPreview(rule.statement.Resource)}<button class="am-json-toggle" data-matrix-json="${esc(rule.key)}" aria-expanded="${s.json.includes(rule.key)}">${icon('json')}JSON${icon('down')}</button>${s.json.includes(rule.key)?`<pre>${json(rule.statement)}</pre>`:''}</div>`}</section>`).join(''):'<p class="am-empty">No established coverage. Test an object to check effective access.</p>'}${!s.unresolved&&cell.unresolvedRules?.length?`<p class="am-empty">${cell.unresolvedRules.length} unresolved candidates omitted. <button data-matrix-show-unresolved>Show</button></p>`:''}</div></aside>`;
  }
  function listSubjects(value) {return (Array.isArray(value)?value:[value]).join(', ');}
  const toggle=(values,v)=>values.includes(v)?values.filter(x=>x!==v):[...values,v];
  function click(e) {
    const b=e.target.closest('button');if(!b||!host.contains(b))return;
    capture();
    if(b.hasAttribute('data-matrix-retry')){retryEvidence?.();return;}
    if(b.hasAttribute('data-matrix-more')){moreEvidence?.();return;}
    if(b.hasAttribute('data-matrix-sections')){sectionsOpen=!sectionsOpen;render();q('[data-matrix-sections]')?.focus({preventScroll:true});return;}
    if(b.hasAttribute('data-matrix-section')){if(!b.dataset.matrixSection)sectionsOpen=false;s.sections=b.dataset.matrixSection?toggle(s.sections,b.dataset.matrixSection):[];s.scroll=[0,0];}
    else if(b.hasAttribute('data-matrix-filter'))s.filters=b.dataset.matrixFilter==='All'?[]:toggle(s.filters,b.dataset.matrixFilter);
    else if(b.dataset.matrixSort)s.sort=b.dataset.matrixSort;
    else if(b.hasAttribute('data-matrix-show-unresolved'))s.unresolved=true;
    else if(b.dataset.matrixCell){s.selected={role:b.dataset.matrixCell,type:b.dataset.type};s.collapsed=false;s.inspectorScroll=0;s.focus=b.dataset.gridKey;}
    else if(b.dataset.matrixRole){
      s.highlight=b.dataset.matrixRole;s.focus=key(b.dataset.matrixRole);
      const row=data.rows.findIndex(r=>r.rid===b.dataset.matrixRole);
      if(!b.dataset.gridKey&&row>=0)s.scroll[1]=Math.max(0,52+row*26-q('.am-grid').clientHeight/2);
    }
    else if(b.hasAttribute('data-matrix-panel'))s.collapsed=!s.collapsed;
    else if(b.dataset.matrixRule)s.closed=toggle(s.closed,b.dataset.matrixRule);
    else if(b.dataset.matrixJson)s.json=toggle(s.json,b.dataset.matrixJson);
    else if(b.dataset.matrixAction)s.action=b.dataset.matrixAction;
    else if(b.hasAttribute('data-matrix-test')){test(s.selected,s.action);return;}
    else if(b.dataset.matrixOpen){openRule(b.dataset.matrixOpen,Number(b.dataset.statement));return;}
    else if(b.hasAttribute('data-matrix-reveal')){
      s.roleQ='';s.typeQ='';s.filters=[];s.sections=[];s.hideEmpty=false;
      const revealed=filterMatrix(index,s),col=revealed.cols.findIndex(t=>t.id===s.selected?.type),row=revealed.rows.findIndex(r=>r.rid===s.selected?.role);
      s.scroll=[revealed.cols.slice(0,Math.max(0,col)).reduce((n,t)=>n+t.width,0),Math.max(0,52+row*26-q('.am-grid').clientHeight/2)];
      if(s.selected)s.focus=key(s.selected.role,s.selected.type);
    }
    else return;
    render();changed();
    if(b.hasAttribute('data-matrix-section')){const option=sectionsOpen&&[...host.querySelectorAll('.am-section-menu [data-matrix-section]')].find(el=>el.dataset.matrixSection===b.dataset.matrixSection);(option||q('[data-matrix-sections]'))?.focus({preventScroll:true});}
    if(b.hasAttribute('data-matrix-reveal'))gridTarget(s.focus)?.focus({preventScroll:true});
  }
  function input(e) {if(!e.target.dataset.matrixInput)return;capture();s[e.target.dataset.matrixInput]=e.target.value;s.scroll=[0,0];render();changed();}
  function change(e) {
    const field=e.target.hasAttribute('data-matrix-empty')?'hideEmpty':e.target.hasAttribute('data-matrix-unresolved')?'unresolved':null;
    if(!field)return;capture();s[field]=e.target.checked;s.scroll=[0,0];render();changed();
  }
  function focus(e) {if(!e.target.dataset.gridKey)return;s.focus=e.target.dataset.gridKey;for(const el of host.querySelectorAll('[data-grid-key]'))el.tabIndex=el===e.target?0:-1;}
  function keyboard(e) {
    if(e.key==='Escape'&&sectionsOpen){e.preventDefault();e.stopPropagation();sectionsOpen=false;q('.am-section-menu')?.remove();q('[data-matrix-sections]')?.setAttribute('aria-expanded','false');q('[data-matrix-sections]')?.focus({preventScroll:true});return;}
    if(e.target.hasAttribute('data-matrix-sections')&&e.key==='ArrowDown'){
      e.preventDefault();e.stopPropagation();capture();sectionsOpen=true;render();
      (q('.am-section-menu [aria-pressed=true]')||q('.am-section-menu button'))?.focus({preventScroll:true});return;
    }
    if(e.target.closest('.am-section-menu')&&['ArrowUp','ArrowDown','Home','End'].includes(e.key)){
      e.preventDefault();e.stopPropagation();const options=[...host.querySelectorAll('.am-section-menu button')],at=options.indexOf(e.target);
      options[e.key==='Home'?0:e.key==='End'?options.length-1:(at+(e.key==='ArrowUp'?-1:1)+options.length)%options.length]?.focus({preventScroll:true});return;
    }
    if(!e.target.dataset.gridKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();capture();
    const [rid,type]=e.target.dataset.gridKey.split('|'), ri=data.rows.findIndex(r=>r.rid===rid), ci=type?data.cols.findIndex(t=>t.id===type)+1:0;
    let row=ri,col=ci;
    if(e.key==='ArrowLeft')col--;if(e.key==='ArrowRight')col++;
    if(e.key==='ArrowUp')row--;if(e.key==='ArrowDown')row++;
    if(e.key==='PageUp')row-=Math.max(1,Math.floor(q('.am-grid').clientHeight/26)-2);
    if(e.key==='PageDown')row+=Math.max(1,Math.floor(q('.am-grid').clientHeight/26)-2);
    if(e.key==='Home'){col=0;if(e.ctrlKey)row=0;}
    if(e.key==='End'){col=data.cols.length;if(e.ctrlKey)row=data.rows.length-1;}
    row=Math.max(0,Math.min(data.rows.length-1,row));col=Math.max(0,Math.min(data.cols.length,col));
    const vertical=['ArrowUp','ArrowDown','PageUp','PageDown'].includes(e.key);
    while(col>0&&!data.matches(data.rows[row].rid,data.cols[col-1].id)) {
      if(vertical) {
        row+=['ArrowUp','PageUp'].includes(e.key)?-1:1;
        if(row<0||row>=data.rows.length){row=ri;break;}
      } else {
        col+=e.key==='ArrowLeft'||e.key==='End'?-1:1;
        if(col>data.cols.length){col=0;break;}
      }
    }
    const destination=key(data.rows[row].rid,data.cols[col-1]?.id??'');
    if(!gridTarget(destination)){
      const grid=q('.am-grid');
      s.scroll[1]=row*26;
      if(col)s.scroll[0]=data.cols.slice(0,col-1).reduce((n,t)=>n+t.width,0);
      [grid.scrollLeft,grid.scrollTop]=s.scroll;
      renderRows();
    }
    s.focus=destination;
    const target=gridTarget(destination);target?.focus({preventScroll:true});revealGridTarget(target);capture();changed();
  }
  function outside(e) {
    if(!sectionsOpen||e.target.closest('.am-section-control'))return;
    sectionsOpen=false;q('.am-section-menu')?.remove();q('[data-matrix-sections]')?.setAttribute('aria-expanded','false');
  }
  function installResize(el) {
    const resize=n=>{s.width=Math.round(Math.max(240,Math.min(520,n)));q('.am-inspector').style.setProperty('--am-width',s.width+'px');el.setAttribute('aria-valuenow',s.width);};
    let start=0,width=0;
    el.onpointerdown=e=>{start=e.clientX;width=s.width;el.setPointerCapture(e.pointerId);};
    el.onpointermove=e=>{if(el.hasPointerCapture(e.pointerId))resize(width+start-e.clientX);};
    el.onpointerup=e=>{if(el.hasPointerCapture(e.pointerId))el.releasePointerCapture(e.pointerId);changed();};
    el.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?296:s.width+(e.key==='ArrowLeft'?16:-16));changed();}};
    el.ondblclick=()=>{resize(296);changed();};
  }
  host.addEventListener('click',click);host.addEventListener('input',input);host.addEventListener('change',change);host.addEventListener('focusin',focus);host.addEventListener('keydown',keyboard);
  document.addEventListener('pointerdown',outside);
  render();
  return {capture, destroy(){if(disposed)return;disposed=true;capture();cancelAnimationFrame(frame);resizeObserver?.disconnect();document.removeEventListener('pointerdown',outside);host.removeEventListener('click',click);host.removeEventListener('input',input);host.removeEventListener('change',change);host.removeEventListener('focusin',focus);host.removeEventListener('keydown',keyboard);}};
}
