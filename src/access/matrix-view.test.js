// @vitest-environment happy-dom
import { expect,it,vi } from 'vitest';
import { mountMatrix,matrixState,conditionPreview } from './matrix-view.js';
import { createMatrixIndex } from './matrix-model.js';

it('shows saved context, recovery controls and mixed evidence once with accessible uncertainty',()=>{
  document.body.innerHTML='<div id="matrix"></div>';
  const c=(Left,Comparison,Right)=>({Condition:{Left,Comparison,Right}});
  const Resource={Any:[{All:[c('resource.type','Equal','Scorecard'),c('resource.parent','NotEmpty')]},{HasAccessTo:{Reference:'resource.owner'}}]};
  const model={roles:[{rid:'1',id:'reader',name:'Reader',parent:''}],policies:[{rid:'2',name:'Access',enabled:true,content:{Statement:[{Subject:'*',Effect:'Allow',Action:['Read'],Resource}]}}]};
  const index=createMatrixIndex(model,{Scorecard:[]});
  const state={...matrixState(),selected:{role:'1',type:'Scorecard'},unresolved:true};
  const retry=vi.fn(),more=vi.fn(),host=document.querySelector('#matrix');
  const view=mountMatrix(host,{index,state,changed:vi.fn(),canOpen:()=>true,retryEvidence:retry,moreEvidence:more,hasDraftChanges:true,metadataStatus:'1 reference unavailable'});
  expect(host.querySelector('.am-foot').textContent).toContain('Saved policies · Draft changes not included');
  expect(host.querySelectorAll('.am-rule')).toHaveLength(1);
  expect(host.querySelector('.am-rule').textContent).toContain('Unresolved Read: Related-object access requires an engine test');
  expect(host.querySelector('.am-cell').getAttribute('aria-label')).toContain('unresolved candidates available');
  host.querySelector('[data-matrix-retry]').click();expect(retry).toHaveBeenCalledTimes(1);
  host.querySelector('[data-matrix-more]').click();expect(more).toHaveBeenCalledTimes(1);
  const checkbox=host.querySelector('[data-matrix-unresolved]');checkbox.checked=false;checkbox.dispatchEvent(new Event('change',{bubbles:true}));
  expect(host.querySelectorAll('.am-rule')).toHaveLength(1);
  expect(host.querySelector('.am-rule').textContent).not.toContain('Unresolved Read:');
  expect(host.querySelector('.am-cell').textContent).toBe('R*');
  view.destroy();
});

it('filters from group bands, combines sections, and keeps hidden selections recoverable',()=>{
  document.body.innerHTML='<div id="matrix"></div>';
  const rule={key:'9:0',policy:{rid:'9',name:'Access'},index:0,effect:'Allow',actions:['Read','Update'],statement:{Subject:'*',Resource:'*'}};
  const index={roles:[{rid:'1',id:'one',name:'One'}],columns:[
    {id:'Scorecard',group:'Structure',width:100},{id:'CeTask',group:'Enterprise objects',width:100},{id:'ActionButton',group:'Interface objects',width:100}],
    cell:()=>({actions:['Read','Update'],rules:[rule]})};
  const state=matrixState();state.selected={role:'1',type:'Scorecard'};state.filters=['Read'];state.scroll=[400,300];
  const host=document.querySelector('#matrix'),changed=vi.fn();
  let view=mountMatrix(host,{index,state,openRule:vi.fn(),test:vi.fn(),canOpen:()=>true,changed});
  host.querySelector('.am-groups [data-matrix-section="Enterprise objects"]').click();
  expect(state.sections).toEqual(['Enterprise objects']);
  expect(state.scroll).toEqual([0,0]);
  expect([...host.querySelectorAll('.am-cell')].map(e=>e.dataset.type)).toEqual(['CeTask']);
  expect(host.querySelector('.am-cell').textContent).toBe('RU');
  expect(host.querySelector('.am-hidden')).not.toBeNull();
  expect(document.activeElement.hasAttribute('data-matrix-sections')).toBe(true);
  expect(host.querySelector('.am-sections')).toBeNull();
  host.querySelector('[data-matrix-sections]').click();
  host.querySelector('.am-section-menu [data-matrix-section="Structure"]').click();
  expect(state.sections).toEqual(['Enterprise objects','Structure']);
  expect(host.querySelector('.am-hidden')).toBeNull();
  view.destroy();
  view=mountMatrix(host,{index,state,openRule:vi.fn(),test:vi.fn(),canOpen:()=>true,changed});
  host.querySelector('[data-matrix-sections]').click();
  expect(host.querySelectorAll('.am-section-menu [aria-pressed="true"]')).toHaveLength(2);
  host.querySelector('.am-section-menu [data-matrix-section="Structure"]').click();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(host.querySelector('.am-section-menu')).toBeNull();
  host.querySelector('[data-matrix-reveal]').click();
  expect(state.sections).toEqual([]);
  expect(host.querySelector('.am-cell[aria-pressed="true"]').dataset.type).toBe('Scorecard');
  expect(document.activeElement.dataset.gridKey).toBe('1|Scorecard');
  host.querySelector('.am-groups [data-matrix-section="Enterprise objects"]').click();
  host.querySelector('.am-section-control>[data-matrix-section=""]').click();
  expect(host.querySelectorAll('.am-cell')).toHaveLength(3);
  const search=host.querySelector('[data-matrix-input="typeQ"]');search.value='no matches';search.dispatchEvent(new Event('input',{bubbles:true}));
  host.querySelector('[data-matrix-sections]').click();
  expect(host.querySelector('.am-section-menu')).not.toBeNull();
  document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));
  expect(host.querySelector('.am-section-menu')).toBeNull();
  expect(changed).toHaveBeenCalled();
  view.destroy();
});

it('simplifies associative preview groups while retaining mixed logic and the original policy',()=>{
  const condition=(left,right)=>({Condition:{Left:left,Comparison:'=',Right:right}});
  const value={All:[{All:[condition('resource.type','CeRiskAssessment'),condition('resource.active',true)]},
    {Any:[condition('resource.owner','user.id'),condition('resource.team','team.id')]}]};
  const original=JSON.stringify(value);
  document.body.innerHTML=conditionPreview(value);
  expect([...document.querySelectorAll('.am-group-label')].map(el=>el.textContent)).toEqual(['All conditions','Any condition']);
  expect(document.querySelectorAll('.am-condition')).toHaveLength(4);
  expect(JSON.stringify(value)).toBe(original);
});

it('renders reference access as a readable check with the correct referenced-object grouping',()=>{
  document.body.innerHTML=conditionPreview({HasAccessTo:{Reference:'resource.tax_entity',Action:'Read',Grouping:'All',Roles:['original_tax_role_control_manager']}});
  expect(document.querySelector('.am-condition-head').textContent).toBe('resource.tax_entitycheck Read access');
  expect(document.querySelector('.am-condition-detail').textContent).toBe('Roleoriginal_tax_role_control_manager');
  expect(document.querySelector('.am-reference-match').textContent).toBe('All referenced objects');
  expect(document.body.textContent).not.toContain('HasAccessTo');
  document.body.innerHTML=conditionPreview({HasAccessTo:'resource.parent'});
  expect(document.querySelector('.am-comparison').textContent).toBe('check requested access');
  expect(document.querySelector('.am-reference-match')).toBeNull();
  document.body.innerHTML=conditionPreview({HasAccessTo:{Reference:'resource.parent',Grouping:'any'}});
  expect(document.querySelector('.am-reference-match').textContent).toBe('Any referenced object');
});

it('keeps comparator meaning and empty values visible and escapes policy text',()=>{
  document.body.innerHTML=conditionPreview({Condition:{Left:'resource.<img>',Comparison:'NotContainsAny',Right:['<svg onload="bad()">','']}});
  expect(document.querySelector('.am-comparison').textContent).toBe('contains none');
  expect(document.querySelector('.am-condition-values').textContent).toBe('<svg onload="bad()">, ""');
  expect(document.querySelector('svg,img')).toBeNull();
  document.body.innerHTML=conditionPreview({Condition:{Left:'resource.labels',Comparison:'ContainsAny',Right:[]}});
  expect(document.querySelector('.am-condition-values').textContent).toBe('[]');
  document.body.innerHTML=conditionPreview({Condition:{Left:'resource.labels',Comparison:'NotEmpty'}});
  expect(document.querySelector('.am-comparison').textContent).toBe('is not empty');
  expect(document.querySelector('.am-condition-values')).toBeNull();
});

it('windows large matrices and keeps vertical keyboard navigation in the same type across filtered gaps',()=>{
  document.body.innerHTML='<div id="matrix"></div>';
  HTMLElement.prototype.scrollIntoView=vi.fn();
  const rows=Array.from({length:500},(_,i)=>({rid:String(i),name:String(i).padStart(3,'0'),id:'role'+i}));
  const index={roles:rows,columns:[{id:'A',group:'Other types',width:80},{id:'B',group:'Other types',width:80}],
    cell:(rid,type)=>({actions:rid==='1'&&type==='A'?['Update']:['Read','Update'],rules:[{}]})};
  const state=matrixState();state.filters=['Read'];state.hideEmpty=false;
  const host=document.querySelector('#matrix'),view=mountMatrix(host,{index,state,openRule:vi.fn(),test:vi.fn(),canOpen:()=>true,changed:vi.fn()});
  expect(host.querySelectorAll('.am-table tbody tr').length).toBeLessThan(100);
  const start=host.querySelector('[data-grid-key="0|A"]');start.focus();
  start.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  expect(document.activeElement.dataset.gridKey).toBe('2|A');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',ctrlKey:true,bubbles:true}));
  expect(document.activeElement.dataset.gridKey).toBe('499|B');
  expect(host.querySelectorAll('.am-table tbody tr').length).toBeLessThan(100);
  expect(host.querySelector('[data-grid-key="499|B"]').textContent).toBe('RU');
  view.destroy();
});

it('windows wide catalogues while preserving keyboard access to the final column',()=>{
  document.body.innerHTML='<div id="matrix"></div>';
  HTMLElement.prototype.scrollIntoView=vi.fn();
  const index={roles:[{rid:'1',id:'one',name:'One'}],
    columns:Array.from({length:180},(_,i)=>({id:'Type'+i,group:'Other types',width:100})),
    cell:()=>({actions:['Read'],rules:[{}]})};
  const host=document.querySelector('#matrix'),view=mountMatrix(host,{index,state:matrixState(),openRule:vi.fn(),test:vi.fn(),canOpen:()=>true,changed:vi.fn()});
  expect(host.querySelectorAll('.am-cell').length).toBeLessThan(20);
  const start=host.querySelector('[data-grid-key="1|Type0"]');start.focus();
  start.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
  expect(document.activeElement.dataset.gridKey).toBe('1|Type179');
  expect(host.querySelectorAll('.am-cell').length).toBeLessThan(20);
  view.destroy();
});

it('keeps keyboard focus on filters, sorting and inspector controls across rerenders',()=>{
  document.body.innerHTML='<div id="matrix"></div>';
  const rule={key:'9:0',policy:{rid:'9',name:'Access'},index:0,effect:'Allow',actions:['Read'],statement:{Subject:'*',Resource:'*'}};
  const index={roles:[{rid:'1',id:'one',name:'One'}],columns:[{id:'CeTask',group:'Enterprise objects',width:100}],cell:()=>({actions:['Read'],rules:[rule]})};
  const host=document.querySelector('#matrix'),state=matrixState();state.selected={role:'1',type:'CeTask'};
  const view=mountMatrix(host,{index,state,openRule:vi.fn(),test:vi.fn(),canOpen:()=>true,changed:vi.fn()});
  for(const selector of ['[data-matrix-filter="Read"]','[data-matrix-sort="coverage"]','[data-matrix-empty]','[data-matrix-action="Update"]','[data-matrix-rule]','[data-matrix-json]']){
    if(selector==='[data-matrix-json]')host.querySelector('[data-matrix-rule]').click();
    const el=host.querySelector(selector);el.focus();el.click();
    expect(document.activeElement).toBe(host.querySelector(selector));
  }
  host.querySelector('.am-collapse').focus();document.activeElement.click();
  expect(document.activeElement).toBe(host.querySelector('.am-rail button'));
  document.activeElement.click();expect(document.activeElement).toBe(host.querySelector('.am-collapse'));
  const search=host.querySelector('[data-matrix-input="roleQ"]');search.focus();search.value='One';search.setSelectionRange(0,2,'backward');search.dispatchEvent(new Event('input',{bubbles:true}));
  expect(document.activeElement.selectionStart).toBe(0);expect(document.activeElement.selectionEnd).toBe(2);
  host.querySelector('[data-matrix-sections]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  expect(document.activeElement.textContent).toBe('All sections');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
  expect(document.activeElement.textContent).toBe('Enterprise objects');
  document.activeElement.click();expect(document.activeElement.getAttribute('aria-pressed')).toBe('true');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(document.activeElement).toBe(host.querySelector('[data-matrix-sections]'));
  view.destroy();
});

it('reveals keyboard targets hidden behind sticky row and column headers',()=>{
  document.body.innerHTML='<div id="matrix"></div>';
  const index={roles:[{rid:'1',id:'one',name:'One'}],columns:[{id:'A',group:'Other types',width:100},{id:'B',group:'Other types',width:100}],cell:()=>({actions:['Read'],rules:[{}]})};
  const host=document.querySelector('#matrix'),view=mountMatrix(host,{index,state:matrixState(),openRule:vi.fn(),test:vi.fn(),canOpen:()=>true,changed:vi.fn()});
  const grid=host.querySelector('.am-grid');grid.scrollLeft=100;grid.scrollTop=60;
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){
    if(this===grid)return {left:0,top:0};
    if(this.matches('.am-role-heading'))return {width:198};
    if(this.matches('thead'))return {height:52};
    return {left:150,right:250,top:40,bottom:66};
  });
  host.querySelector('[data-grid-key="1|B"]').focus();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  expect(document.activeElement.dataset.gridKey).toBe('1|A');
  expect(grid.scrollLeft).toBe(52);expect(grid.scrollTop).toBe(48);
  rect.mockRestore();view.destroy();
});
