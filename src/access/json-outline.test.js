// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { createJSONOutline } from './json-outline.js';
import { analyzePBAC } from './pbac-document.js';
import { ChangeSet } from '@codemirror/state';

const policy = () => ({Statement:[{Subject:'*',Effect:'Allow',Action:['Read'],Resource:{All:[{Condition:{Left:'resource.name',Comparison:'=',Right:'first'}}]}},
  {Subject:'*',Effect:'Deny',Action:['Read'],Resource:{Condition:{Left:'resource.name',Comparison:'=',Right:'second'}}}]});

it('is lazy while hidden, refreshes on reopen, and clears unsafe targets on invalid JSON', () => {
  const parent = document.createElement('aside');parent.hidden = true;document.body.append(parent);
  const jumps = [], outline = createJSONOutline(parent, pos => jumps.push(pos));
  const doc = '{"Statement":[{"Subject":"*","Resource":{"Condition":{"Left":"new.name","Comparison":"NotEmpty"}}}]}';
  try {
    outline.update(analyzePBAC(doc), 0);expect(parent.querySelectorAll('button')).toHaveLength(0);
    parent.hidden = false;outline.update(analyzePBAC(doc), 0);
    expect(parent.querySelectorAll('.json-outline-disclosure[aria-expanded="false"]')).toHaveLength(0);
    const buttons = parent.querySelectorAll('.json-outline-location');buttons[2].click();
    expect(doc.slice(jumps[0])).toContain('"Left":"new.name"');
    parent.querySelector('.json-outline-disclosure').click();expect(outline.bookmark().collapsed).toHaveLength(1);
    parent.hidden = true;outline.update(analyzePBAC('{'), 0);parent.hidden = false;outline.update(analyzePBAC('{'), 0);
    expect(parent.querySelectorAll('button')).toHaveLength(0);expect(parent.textContent).toContain('Finish the JSON');
  } finally {outline.destroy();parent.remove();}
});

it('retains outline rows, focus and scroll while labels and navigation ranges change', () => {
  const parent=document.createElement('aside');document.body.append(parent);
  const jumps=[],outline=createJSONOutline(parent,p=>jumps.push(p));
  try {
    const source=JSON.stringify(policy());outline.update(analyzePBAC(source),0);
    const row=parent.querySelector('.json-outline-row'),go=parent.querySelectorAll('.json-outline-location')[3],tree=parent.querySelector('.json-outline-tree');
    go.focus();tree.scrollTop=120;
    const at=source.indexOf('first'), changes=ChangeSet.of({from:at,insert:'updated '},source.length),next=source.slice(0,at)+'updated '+source.slice(at);
    outline.update(analyzePBAC(next),at,changes);
    expect(parent.querySelector('.json-outline-row')).toBe(row);expect(document.activeElement).toBe(go);
    expect(go.textContent).toContain('updated first');expect(tree.scrollTop).toBe(120);
    const last=parent.querySelectorAll('.json-outline-location');last[last.length-1].click();
    expect(next.slice(jumps[0])).toContain('"Right":"second"');
    // A temporary syntax error clears targets, but correcting it keeps our place.
    outline.update(analyzePBAC(next.slice(0,-1)),at);
    tree.scrollTop=0;tree.dispatchEvent(new Event('scroll'));
    outline.update(analyzePBAC(next),at);expect(tree.scrollTop).toBe(120);
  } finally {outline.destroy();parent.remove();}
});

it('restores scroll after hiding and remounting; collapse state follows surviving tokens after deletion', () => {
  const parent=document.createElement('aside');document.body.append(parent);
  let outline=createJSONOutline(parent,()=>{});
  try {
    const source=JSON.stringify(policy()),analysis=analyzePBAC(source);outline.update(analysis,0);
    const tree=parent.querySelector('.json-outline-tree');tree.scrollTop=180;
    parent.querySelectorAll('.json-outline-row.rule .json-outline-disclosure')[1].click();tree.scrollTop=180;
    outline.show(false,analysis,0);
    const first=analysis.locations.get('["Statement",0]'),second=analysis.locations.get('["Statement",1]');
    const changes=ChangeSet.of({from:first.from,to:second.from,insert:''},source.length),next=source.slice(0,first.from)+source.slice(second.from);
    outline.update(analyzePBAC(next),0,changes);outline.show(true,analyzePBAC(next),0);
    expect(tree.scrollTop).toBe(180);expect(parent.querySelector('.json-outline-disclosure').getAttribute('aria-expanded')).toBe('false');
    const bookmark=outline.bookmark();outline.destroy();outline=createJSONOutline(parent,()=>{},bookmark);outline.update(analyzePBAC(next),0);
    expect(parent.querySelector('.json-outline-tree').scrollTop).toBe(180);
    expect(parent.querySelector('.json-outline-disclosure').getAttribute('aria-expanded')).toBe('false');
    // Replacing all code must not assign an old collapsed index to a different rule.
    const replace=ChangeSet.of({from:0,to:next.length,insert:source},next.length);outline.update(analysis,0,replace);
    expect(parent.querySelector('.json-outline-disclosure').getAttribute('aria-expanded')).toBe('true');
  } finally {outline.destroy();parent.remove();}
});
