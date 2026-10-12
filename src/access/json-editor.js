import {
  EditorState, StateField, Prec
} from '@codemirror/state';
import {
  EditorView, Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  isolateHistory,
  indentWithTab
} from '@codemirror/commands';
import { bracketMatching, codeFolding, foldKeymap, foldedRanges, foldEffect, unfoldEffect, unfoldAll, indentOnInput } from '@codemirror/language';
import {
  searchKeymap,
  highlightSelectionMatches
} from '@codemirror/search';
import {
  closeBrackets,
  closeBracketsKeymap, autocompletion, completionKeymap, acceptCompletion
} from '@codemirror/autocomplete';
import {
  lintGutter,
  linter
} from '@codemirror/lint';
import { json } from '@codemirror/lang-json';
import { analyzePBAC } from './pbac-document.js';
import { policyFolds, diagnosticFixes, documentFingerprint } from './pbac-assist.js';
import { pbacCompletionSource } from './pbac-completion.js';
import { createJSONOutline } from './json-outline.js';
import { pbacFoldGutter, expandFoldWidget } from './json-folding.js';
import { jsonFormattingChanges } from './json-format.js';
import { icon } from './icons';

const analyze = text => {
  const result = analyzePBAC(text);
  const folds = policyFolds(text,result), foldAt = new Map(folds.map(f => [f.from + ':' + f.to, f]));
  return { ...result, folds, foldAt, fixes: diagnosticFixes(text,result), decorations: Decoration.set(result.spans.map(span =>
    Decoration.mark({ class: 'pbac-' + span.type }).range(span.from, span.to))) };
};
const analysisCache = new WeakMap();
const analyzeDocument = doc => {
  if (!analysisCache.has(doc)) analysisCache.set(doc, analyze(doc.toString()));
  return analysisCache.get(doc);
};
const documentAnalysis = StateField.define({
  create: state => analyzeDocument(state.doc),
  update: (value, transaction) => transaction.docChanged ? analyzeDocument(transaction.newDoc) : value,
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});
const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    color: '#403048',
    backgroundColor: '#fff'
  },
  '.cm-scroller': {
    fontFamily: 'Consolas, monospace',
    lineHeight: '1.65'
  },
  '.cm-content': {
    padding: '10px 0'
  },
  '.cm-gutters': {
    backgroundColor: '#f5f0f9',
    color: '#91809e',
    borderRight: '1px solid #ddd5e7'
  },
  '.cm-activeLine': {
    backgroundColor: '#f6f1fc'
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#e8def4',
    color: '#7d5fa0'
  },
  '&.cm-focused': {
    outline: 'none'
  },
  '.cm-cursor': {
    borderLeftColor: '#794caa'
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: '#eee6f7'
  },
  '.cm-matchingBracket': {
    backgroundColor: '#eee6f7',
    outline: '1px solid #cbb2e3'
  },
  '.cm-panels': {
    backgroundColor: '#eee9f5'
  }
});
export function createJSONEditor(parent, value, onChange, onState, bookmark, options = {}) {
  let view, outline;
  const analysisFor = state => state.field(documentAnalysis);
  const layout = state => {
    const folds=[];foldedRanges(state).between(0,state.doc.length,(from,to)=>{folds.push({from,to});});
    return {fingerprint:documentFingerprint(state.doc.toString()),folds};
  };
  const reveal = (from,to=from) => {
    const effects=[];
    // Outline nodes point at the opening brace; the folded interior starts one character later.
    foldedRanges(view.state).between(0,view.state.doc.length,(start,end)=>{if(start<=to+1 && end>=from)effects.push(unfoldEffect.of({from:start,to:end}));});
    effects.push(EditorView.scrollIntoView(from,{y:'start',yMargin:38}));
    view.dispatch({effects,selection:{anchor:from,head:to}});view.focus();
  };
  const fixIssue = (index,fixIndex=0) => {
    const fix=analysisFor(view.state).fixes.get(index)?.[fixIndex];
    if(!fix)return false;
    const first=fix.changes[0];
    view.dispatch({changes:fix.changes,selection:{anchor:first.from,head:first.from+first.insert.length},scrollIntoView:true,
      annotations:isolateHistory.of('full'),userEvent:'input.pbac-fix'});view.focus();return true;
  };
  const report = state => {
    const { valid, issues, fixes } = analysisFor(state);
    onState({ valid, issues:issues.map((issue,index)=>({...issue,fixes:(fixes.get(index)??[]).map(f=>f.label)})) });
  };
  const configuration = {
      doc: value,
      extensions: [lineNumbers(), history(), drawSelection(), highlightActiveLine(), highlightSelectionMatches(), bracketMatching(),
        closeBrackets(), json(), indentOnInput(), documentAnalysis, theme,
        EditorState.transactionExtender.of(tr => {
          if (!tr.docChanged || !foldedRanges(tr.startState).size) return null;
          const effects = [], valid = analyzeDocument(tr.newDoc).foldAt;
          // Refresh labels and error counts after edits, including rule renumbering.
          foldedRanges(tr.startState).map(tr.changes).between(0,tr.newDoc.length,(from,to) => {
            effects.push(unfoldEffect.of({from,to}));
            if (valid.has(from + ':' + to)) effects.push(foldEffect.of({from,to}));
          });
          return {effects};
        }), pbacFoldGutter(), codeFolding({
          preparePlaceholder(state,range) {return analysisFor(state).foldAt.get(range.from + ':' + range.to);},
          placeholderDOM(widgetView,_onclick,fold) {
            const button=document.createElement('button');button.type='button';button.className='pbac-fold'+(fold?.errors?' has-errors':'');
            button.textContent=' … '+(fold?.label??'');button.title=fold?.title??'Expand folded code';button.setAttribute('aria-label','Expand '+(fold?.label??'folded code'));
            button.addEventListener('mousedown',event=>event.preventDefault());
            button.addEventListener('click',event=>{event.preventDefault();expandFoldWidget(widgetView,button);});return button;
          }
        }), autocompletion({override:[pbacCompletionSource(analysisFor,options.catalogue)],activateOnTypingDelay:120,maxRenderedOptions:40,icons:false,
          addToOptions:[{position:10,render:completion=>{const glyph=document.createElement('span');glyph.className='pbac-completion-icon';glyph.innerHTML=icon(completion.glyph??'json');return glyph;}}]}),
        Prec.highest(keymap.of([{key:'Tab',run:acceptCompletion}])),
        lintGutter(), linter(v => {const revision=v.state.doc;return analysisFor(v.state).issues.map((issue,index) => ({
          from: issue.from, to: issue.to, severity: issue.severity, message: issue.path + ': ' + issue.message,
          actions:(analysisFor(v.state).fixes.get(index)??[]).map((fix,fixIndex)=>({name:fix.label,apply:()=>{if(view.state.doc===revision)fixIssue(index,fixIndex);}}))
        }));}, {
          delay: 180
        }), keymap.of([...completionKeymap, ...foldKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]), EditorView
        .contentAttributes.of({
          'aria-label': 'Policy JSON',
          'role': 'textbox',
          'aria-multiline': 'true'
        }), EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
            report(update.state);
          }
          if (update.docChanged || update.transactions.some(tr=>tr.effects.some(e=>e.is(foldEffect)||e.is(unfoldEffect)))) options.onLayout?.(layout(update.state));
          if (update.selectionSet || update.docChanged) {
            const pos = update.state.selection.main.head,
              line = update.state.doc.lineAt(pos);
            parent.dataset.position = `Ln ${line.number}, Col ${pos-line.from+1}`;
            outline?.update(analysisFor(update.state),pos,update.docChanged ? update.changes : undefined);
          }
        })
      ]
  };
  const resume = bookmark?.state?.doc === value;
  view = new EditorView({ parent, scrollTo: resume ? bookmark.scrollTo : undefined, state: resume
    ? EditorState.fromJSON(bookmark.state, configuration, { history: historyField })
    : EditorState.create(configuration) });
  // Recreate placeholders from current PBAC analysis. CodeMirror's serialized
  // fold state only retains ranges, not semantic placeholder data.
  const savedLayout=resume?bookmark.layout:options.layout;
  if(savedLayout?.fingerprint===documentFingerprint(value)) {
    const valid=analysisFor(view.state).foldAt;
    const effects=(savedLayout.folds??[]).filter(f=>valid.has(f.from + ':' + f.to)).map(f=>foldEffect.of(f));
    if(effects.length)view.dispatch({effects});
  }
  report(view.state);
  if(options.outlineParent) {
    outline=createJSONOutline(options.outlineParent,reveal,resume?bookmark.outline:[]);
    outline.update(analysisFor(view.state),view.state.selection.main.head);
  }
  return {
    destroy: () => {outline?.destroy();view.destroy();},
    value: () => view.state.doc.toString(),
    bookmark: () => ({ state: view.state.toJSON({ history: historyField }), layout:layout(view.state), scrollTo: view.scrollSnapshot(),outline:outline?.bookmark() }),
    layout: () => layout(view.state),
    focus: () => view.focus(),
    showOutline(visible) {outline?.show(visible,analysisFor(view.state),view.state.selection.main.head);},
    revealIssue(index) {const issue=analysisFor(view.state).issues[index];if(issue)reveal(issue.from,issue.to);},
    fixIssue,
    foldRules(focusCurrent=false) {
      const pos=view.state.selection.main.head, folds=analysisFor(view.state).folds.filter(f=>f.path.length===2&&f.path[0]==='Statement'),
        current=folds.find(f=>f.from-1<=pos&&f.to+1>=pos);
      if(focusCurrent&&!current)return false;
      unfoldAll(view);
      view.dispatch({effects:folds.filter(f=>!focusCurrent||f!==current).map(f=>foldEffect.of({from:f.from,to:f.to}))});
      if(focusCurrent)view.dispatch({scrollIntoView:true});
      return true;
    },
    expandAll() {const scroll=view.scrollSnapshot();unfoldAll(view);view.dispatch({effects:scroll});},
    revealStatement(index) {
      const range = view.state.field(documentAnalysis).locations.get(JSON.stringify(['Statement', index]));
      if (range) reveal(Math.min(range.from+1,range.to));
    },
    find(query) {
      const text = view.state.doc.toString().toLowerCase(),
        term = query.replace(/^"|"$/g, '').toLowerCase(),
        from = text.indexOf(term);
      if (from >= 0) reveal(from,from+term.length);
    },
    format() {
      const edits = jsonFormattingChanges(view.state.doc.toString());
      if (!edits) return false;
      if (edits.length) {
        const changes = view.state.changes(edits), scroll = view.scrollSnapshot().map(changes);
        view.dispatch({ changes, effects: scroll ? [scroll] : [],
          annotations: isolateHistory.of('full'), userEvent: 'input.format' });
      }
      view.focus();
      return true;
    }
  };
}
