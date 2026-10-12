// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { forEachDiagnostic, forceLinting } from '@codemirror/lint';
import { createJSONEditor } from './json-editor.js';
import { currentCompletions } from '@codemirror/autocomplete';

it('aligns a typed closing delimiter with its opening block', () => {
  const parent=document.createElement('div');document.body.append(parent);
  const source='{\n  "Statement": []\n  ',editor=createJSONEditor(parent,source,()=>{},()=>{});
  try {
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    view.dispatch({selection:{anchor:source.length}});
    view.dispatch({changes:{from:source.length,insert:'}'},selection:{anchor:source.length+1},userEvent:'input.type'});
    expect(editor.value()).toBe('{\n  "Statement": []\n}');
    expect(undo(view)).toBe(true);expect(editor.value()).toBe(source);
  } finally {editor.destroy();parent.remove();}
});

it('automatically completes as users type and accepts with Tab without inserting indentation', async () => {
  const parent=document.createElement('div');document.body.append(parent);
  const source='{"Statement":[{"Effect":""}]}',editor=createJSONEditor(parent,source,()=>{},()=>{});
  try {
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor')),at=source.indexOf('""')+1;view.focus();
    view.dispatch({changes:{from:at,insert:'Al'},selection:{anchor:at+2},userEvent:'input.type'});
    await vi.waitFor(()=>expect(currentCompletions(view.state).map(c=>c.label)).toEqual(['Allow']));
    // CodeMirror ignores acceptance during the popup's initial interaction guard.
    await new Promise(resolve=>setTimeout(resolve,100));
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',keyCode:9,bubbles:true,cancelable:true}));
    expect(JSON.parse(editor.value()).Statement[0].Effect).toBe('Allow');
  } finally {editor.destroy();parent.remove();}
});

it('retains outline groups with editor bookmarks and navigates without adding a JSON undo step', () => {
  const parent=document.createElement('div'),aside=document.createElement('aside');document.body.append(parent,aside);
  const source=foldingPolicy('='),changed=vi.fn();let editor=createJSONEditor(parent,source,changed,()=>{},undefined,{outlineParent:aside});
  try {
    editor.foldRules();const links=aside.querySelectorAll('.json-outline-location');links[0].click();
    expect(editor.layout().folds).toHaveLength(1); // Root navigation also opens the folded interior.
    editor.foldRules();links[2].click();
    expect(editor.layout().folds).toHaveLength(1);expect(editor.value()).toBe(source);expect(changed).not.toHaveBeenCalled();
    aside.querySelector('.json-outline-disclosure').click();const saved=editor.bookmark();editor.destroy();
    editor=createJSONEditor(parent,source,changed,()=>{},saved,{outlineParent:aside});
    expect(aside.querySelector('.json-outline-disclosure').getAttribute('aria-expanded')).toBe('false');
    expect(undo(EditorView.findFromDOM(parent.querySelector('.cm-editor')))).toBe(false);
  } finally {editor.destroy();parent.remove();aside.remove();}
});

it('recolors earlier array entries when a later value changes and restores them on undo', async () => {
  const parent = document.createElement('div'); document.body.append(parent);
  const source = JSON.stringify({ Condition: { Left: 'resource.name', Comparison: 'ContainsAny', Right: ['Organisation:a', 'Organisation:b'] } }, null, 2);
  const report = vi.fn();
  const editor = createJSONEditor(parent, source, () => {}, report);
  try {
    const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    expect([...parent.querySelectorAll('.pbac-typed')].map(el => el.textContent)).toEqual(['"Organisation:a"', '"Organisation:b"']);
    const from = source.indexOf('Organisation:b');
    view.dispatch({ changes: { from, to: from + 'Organisation:b'.length, insert: 'literal' } });
    expect(parent.querySelector('.pbac-typed')).toBeNull();
    expect([...parent.querySelectorAll('.pbac-string')].map(el => el.textContent)).toContain('"Organisation:a"');
    // The delayed linter and cursor changes reuse the revision's analysis.
    expect(report).toHaveBeenCalledTimes(2);
    forceLinting(view);
    view.dispatch({ selection: { anchor: 1 } });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(report).toHaveBeenCalledTimes(2);
    expect(undo(view)).toBe(true);
    expect([...parent.querySelectorAll('.pbac-typed')].map(el => el.textContent)).toEqual(['"Organisation:a"', '"Organisation:b"']);
  } finally { editor.destroy(); parent.remove(); }
});

it('CodeMirror marks the actual invalid comparison and clears it after a repair', async () => {
  const parent = document.createElement('div'); document.body.append(parent);
  const source = JSON.stringify({ Version: '1.0', Statement: [{ Subject: '*', Effect: 'Allow', Action: ['Read'],
    Resource: { All: [{ Condition: { Left: 'resource.name', Comparison: '=', Right: 'a' } },
      { Condition: { Left: 'resource.name', Comparison: '>=', Right: 'b' } }] } }] }, null, 2);
  const editor = createJSONEditor(parent, source, () => {}, () => {});
  try {
    const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    const diagnostics = () => {
      const issues = []; forEachDiagnostic(view.state, (issue, from, to) => issues.push({ ...issue, from, to })); return issues;
    };
    forceLinting(view);
    await vi.waitFor(() => expect(diagnostics()).toHaveLength(1));
    const [issue] = diagnostics();
    expect(source.slice(issue.from, issue.to)).toBe('">="');
    view.dispatch({ changes: { from: issue.from, to: issue.to, insert: '"="' } });
    forceLinting(view);
    await vi.waitFor(() => expect(diagnostics()).toHaveLength(0));
  } finally { editor.destroy(); parent.remove(); }
});

it('renders PBAC semantic classes in CodeMirror and updates them after an edit', async () => {
  const parent = document.createElement('div'); document.body.append(parent);
  const source = '{"Subject":["role:reviewer"],"Resource":{"Any":[{"Condition":{"Left":"new.name","Comparison":"!=","Right":"example"}},{"HasAccessTo":"reversed.parent"}]}}';
  const editor = createJSONEditor(parent, source, () => {}, () => {});
  try {
    await vi.waitFor(() => expect(parent.querySelector('.pbac-role')?.textContent).toBe('"role:reviewer"'));
    expect([...parent.querySelectorAll('.pbac-logic')].map(node => node.textContent)).toContain('"Any"');
    expect(parent.querySelector('.pbac-reference')?.textContent).toBe('"new.name"');
    expect([...parent.querySelectorAll('.pbac-reference')].map(node => node.textContent)).toContain('"reversed.parent"');
    const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    const from = source.indexOf('"Subject"');
    view.dispatch({ changes: { from, to: from + '"Subject"'.length, insert: '"Name"' } });
    await vi.waitFor(() => expect(parent.querySelector('.pbac-role')).toBeNull());
    expect([...parent.querySelectorAll('.pbac-string')].map(node => node.textContent)).toContain('"role:reviewer"');
  } finally { editor.destroy(); parent.remove(); }
});

it('reclassifies an unchanged expression when its enclosing PBAC field changes', async () => {
  const parent = document.createElement('div'); document.body.append(parent);
  const source = '{\n"Resource": {\n"HasRole": "reversed.owner"\n}\n}';
  const editor = createJSONEditor(parent, source, () => {}, () => {});
  try {
    await vi.waitFor(() => expect(parent.querySelector('.pbac-reference')?.textContent).toBe('"reversed.owner"'));
    const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    view.dispatch({ changes: { from: source.indexOf('Resource'), to: source.indexOf('Resource') + 8, insert: 'Metadata' } });
    await vi.waitFor(() => expect(parent.querySelector('.pbac-reference')).toBeNull());
    expect(parent.querySelector('.pbac-logic')).toBeNull();
  } finally { editor.destroy(); parent.remove(); }
});

it('preserves the JSON cursor and editor undo across record switches without reusing old callbacks', () => {
  const first = document.createElement('div'), second = document.createElement('div');
  document.body.append(first, second);
  const original = '{"Statement":[]}', changes = [];
  const editor = createJSONEditor(first, original, text => changes.push(text), () => {});
  const view = EditorView.findFromDOM(first.querySelector('.cm-editor'));
  view.dispatch({ changes: { from: 1, insert: ' ' }, selection: { anchor: 2 } });
  const bookmark = editor.bookmark(); editor.destroy();
  const restored = [];
  const next = createJSONEditor(second, bookmark.state.doc, text => restored.push(text), () => {}, bookmark);
  const nextView = EditorView.findFromDOM(second.querySelector('.cm-editor'));
  expect(nextView.state.selection.main.head).toBe(2);
  expect(undo(nextView)).toBe(true);
  expect(next.value()).toBe(original); expect(restored).toEqual([original]); expect(changes).toHaveLength(1);
  next.destroy(); first.remove(); second.remove();
});

const foldingPolicy = comparison => JSON.stringify({Version:'1.0',Statement:[
  {Subject:'*',Effect:'Allow',Action:['Read'],Resource:{Condition:{Left:'resource.name',Comparison:comparison,Right:'A'}}},
  {Subject:'*',Effect:'Deny',Action:['Delete'],Resource:{Condition:{Left:'resource.name',Comparison:'=',Right:'B'}}}
]},null,2);

it('formats without losing the selection, folded rules or the previous typing undo step', () => {
  const parent=document.createElement('div');document.body.append(parent);
  const source=foldingPolicy('=').replaceAll('\n  ', '\n '), editor=createJSONEditor(parent,source,()=>{},()=>{});
  try {
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    editor.foldRules();
    const at=source.indexOf('resource.name');
    view.dispatch({changes:{from:at+9,insert:'x'},selection:{anchor:at,head:at+14},userEvent:'input.type'});
    const before=editor.value(), selection=view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to);
    const folds=editor.layout().folds.length;
    expect(editor.format()).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to)).toBe(selection);
    expect(editor.layout().folds).toHaveLength(folds);
    expect(undo(view)).toBe(true);expect(editor.value()).toBe(before);
    expect(undo(view)).toBe(true);expect(editor.value()).toBe(source);
  } finally {editor.destroy();parent.remove();}
});

it('does not add history for already formatted JSON and rejects invalid formatting', () => {
  const parent=document.createElement('div');document.body.append(parent);
  const changed=vi.fn(), source=foldingPolicy('='),editor=createJSONEditor(parent,source,changed,()=>{});
  try {
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    expect(editor.format()).toBe(true);expect(changed).not.toHaveBeenCalled();expect(undo(view)).toBe(false);
    view.dispatch({changes:{from:0,to:1,insert:''}});
    const invalid=editor.value();expect(editor.format()).toBe(false);expect(editor.value()).toBe(invalid);
  } finally {editor.destroy();parent.remove();}
});

it('folds without changing policy text, restores semantic labels, and reveals errors inside folds', () => {
  const parent=document.createElement('div');document.body.append(parent);
  const source=foldingPolicy('contains any'),changed=vi.fn();
  let editor=createJSONEditor(parent,source,changed,()=>{});
  try {
    editor.foldRules();
    expect(editor.layout().folds).toHaveLength(2);
    expect([...parent.querySelectorAll('.pbac-fold')].map(e=>e.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Rule 1 · Allow · Read · 1 error'),expect.stringContaining('Rule 2 · Deny · Delete')
    ]));
    const bookmark=editor.bookmark(),layout=editor.layout();editor.destroy();
    editor=createJSONEditor(parent,source,changed,()=>{},bookmark);
    expect(parent.querySelector('.pbac-fold')?.textContent).toContain('Rule 1 · Allow · Read');
    expect(editor.layout()).toEqual(layout);
    editor.revealIssue(0);
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor')),selection=view.state.selection.main;
    expect(view.state.sliceDoc(selection.from,selection.to)).toBe('"contains any"');
    expect(editor.layout().folds).toHaveLength(1);
    editor.foldRules(true);expect(editor.layout().folds).toHaveLength(1);
    expect(parent.querySelector('.pbac-fold')?.textContent).toContain('Rule 2');
    editor.destroy();editor=createJSONEditor(parent,source,changed,()=>{},undefined,{layout});
    expect(editor.layout()).toEqual(layout);
    editor.destroy();editor=createJSONEditor(parent,source+' ',changed,()=>{},undefined,{layout});
    expect(editor.layout().folds).toHaveLength(0); // A different document cannot reuse saved offsets.
    expect(changed).not.toHaveBeenCalled();
  } finally {editor.destroy();parent.remove();}
});

it('keeps fold labels current and makes a repair a separate undo step from typing', () => {
  const parent=document.createElement('div');document.body.append(parent);
  const source=foldingPolicy('='),editor=createJSONEditor(parent,source,()=>{},()=>{});
  try {
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    editor.foldRules();
    const from=source.indexOf('"="');
    view.dispatch({changes:{from,to:from+3,insert:'"contains any"'},userEvent:'input.type'});
    const beforeFix=editor.value();
    expect(parent.querySelector('.pbac-fold')?.textContent).toContain('1 error');
    expect(editor.fixIssue(0)).toBe(true);
    expect(JSON.parse(editor.value()).Statement[0].Resource.Condition.Comparison).toBe('ContainsAny');
    expect(editor.layout().folds).toHaveLength(1);
    expect(undo(view)).toBe(true);expect(editor.value()).toBe(beforeFix);
    expect(undo(view)).toBe(true);expect(editor.value()).toBe(source);
  } finally {editor.destroy();parent.remove();}
});

it('removes trailing commas as one undoable repair without changing commas in strings', () => {
  const parent=document.createElement('div');document.body.append(parent);
  const source='{"description":"Keep ,}","Statement":[],}',editor=createJSONEditor(parent,source,()=>{},()=>{});
  try {
    const view=EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    expect(editor.fixIssue(0)).toBe(true);
    expect(editor.value()).toBe('{"description":"Keep ,}","Statement":[]}');
    expect(undo(view)).toBe(true);expect(editor.value()).toBe(source);
  } finally {editor.destroy();parent.remove();}
});
