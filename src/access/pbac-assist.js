import { PBAC_COMPARISONS, pbacActions } from './pbac-syntax.js';
import { typeContext } from './schema-model.js';

const decode = (text, node) => { try { return JSON.parse(text.slice(node.from, node.to)); } catch { return undefined; } };
const children = node => { const result=[]; for(let child=node?.firstChild;child;child=child.nextSibling) result.push(child); return result; };
const isValue = node => ['Object','Array','String','Number','True','False','Null'].includes(node.name);
const at = (value, path) => path.reduce((node,key) => node?.[key], value);

// Recover complete siblings while the token at the caret is still being written.
// Property names remain data (including __proto__), never object prototypes.
function recover(text, node) {
  if (node?.name === 'Object') return Object.fromEntries(children(node).filter(n=>n.name==='Property').flatMap(prop => {
    const key=decode(text,prop.firstChild), value=children(prop).find(isValue);
    return typeof key === 'string' ? [[key,recover(text,value)]] : [];
  }));
  if (node?.name === 'Array') return children(node).filter(isValue).map(n=>recover(text,n));
  return node ? decode(text,node) : undefined;
}
function nodePath(text, node) {
  const path=[];
  for(let n=node;n?.parent;n=n.parent) {
    if(n.parent.name==='Property' && n.name!=='PropertyName') path.unshift(decode(text,n.parent.firstChild));
    if(n.parent.name==='Array') path.unshift(children(n.parent).filter(child=>isValue(child)&&child.to<=n.from).length);
  }
  return path;
}
export function completionSite(text, analysis, pos) {
  let node=analysis.tree.resolveInner(pos,-1);
  const unfinished=node.type.isError && text[node.from]==='"' && pos>node.from;
  if(!unfinished) while(node.parent && node.type.isError) node=node.parent;
  const value=analysis.value ?? recover(text,analysis.tree.topNode.firstChild);
  if ((unfinished || ['String','PropertyName'].includes(node.name)) && pos>node.from && pos<=node.to) {
    const raw=text.slice(node.from+1,!unfinished&&pos===node.to?pos-1:pos);
    let prefix; try {prefix=JSON.parse('"'+raw+'"');} catch {prefix=raw;}
    const key=node.name==='PropertyName'||unfinished&&node.parent.name==='Object', object=key?(unfinished?node.parent:node.parent.parent):null;
    return {kind:key?'key':'value',path:key?nodePath(text,object):nodePath(text,node),from:node.from,to:node.to,prefix,value,
      colon:key&&!unfinished&&children(node.parent).some(n=>n.name===':'),keyName:key?decode(text,node):undefined,keys:object?Object.keys(recover(text,object)):[]};
  }
  // Whitespace after an opening delimiter or comma, or a missing value after ':' .
  const previous=text.slice(0,pos).trimEnd().at(-1);
  while(node.parent && !['Object','Array','Property'].includes(node.name)) node=node.parent;
  if(node.name==='Property') {
    const colon=children(node).find(n=>n.name===':');
    if(colon && pos>=colon.to && previous===':') return {kind:'value',path:[...nodePath(text,node),decode(text,node.firstChild)],from:pos,to:pos,prefix:'',value};
    node=node.parent;
  }
  if(node.name==='Object' && ['{',','].includes(previous)) return {kind:'key',path:nodePath(text,node),from:pos,to:pos,prefix:'',value,keys:Object.keys(recover(text,node)),colon:false};
  if(node.name==='Array' && ['[',','].includes(previous)) return {kind:'value',path:[...nodePath(text,node),children(node).filter(n=>isValue(n)&&n.to<=pos).length],from:pos,to:pos,prefix:'',value};
  return null;
}

// Semantic scope is a path grammar, not a key-name match inside arbitrary JSON.
export function pbacScope(path) {
  let scope='document';
  for(const key of path) {
    if(scope==='document' && key==='Statement') scope='statements';
    else if(scope==='statements' && typeof key==='number') scope='statement';
    else if(scope==='statement' && key==='Resource') scope='expression';
    else if(scope==='expression' && ['All','Any'].includes(key)) scope='expressions';
    else if(scope==='expressions' && typeof key==='number') scope='expression';
    else if(scope==='expression' && ['Condition','HasRole','HasAccessTo'].includes(key)) scope=key;
    else return 'literal';
  }
  return scope;
}
export const scopeKeys = {
  document:['Version','Statement','description','comment'],
  statement:['Subject','Effect','Action','Resource','description','comment'],
  expression:['All','Any','Condition','HasRole','HasAccessTo','description','comment'],
  Condition:['Left','Comparison','Right','description','comment'],
  HasRole:['Reference','Roles','description','comment'],
  HasAccessTo:['Reference','Roles','Action','Grouping','description','comment']
};

export function completionTarget(site) {
  const array=typeof site.path.at(-1)==='number', path=array?site.path.slice(0,-1):site.path,
    field=path.at(-1), parent=path.slice(0,-1), scope=pbacScope(parent), owner=at(site.value,parent);
  const statement=site.value?.Statement?.[site.path[1]], conditionPath=scope==='expression'?parent.slice(3):parent.slice(3,-1);
  const sources = operand => {
    if(typeof operand!=='string') return {types:[]};
    const source=operand?.split('.')[0];
    return {scope:source,types:['resource','new'].includes(source)?typeContext(statement?.Resource,conditionPath,source):[],field:operand?.split('.').slice(1).join('.')};
  };
  if(site.kind==='key') return {kind:'keys',keys:scopeKeys[pbacScope(site.path)] ?? []};
  if(scope==='document' && field==='Version') return {kind:'version'};
  if(scope==='statement' && field==='Subject' || ['HasRole','HasAccessTo'].includes(scope) && field==='Roles')
    return {kind:'subjects',bare:!array,rolePrefix:field==='Subject',query:site.prefix};
  if(scope==='statement' && field==='Action' || scope==='HasAccessTo' && field==='Action') return {kind:'actions',bare:!array&&scope==='statement'};
  if(scope==='statement' && field==='Effect') return {kind:'effects'};
  if(scope==='HasAccessTo' && field==='Grouping') return {kind:'grouping'};
  if(scope==='Condition' && field==='Comparison') return {kind:'comparisons'};
  if(scope==='Condition' && field==='Left' || ['HasRole','HasAccessTo'].includes(scope) && field==='Reference' || scope==='expression' && ['HasRole','HasAccessTo'].includes(field)) {
    const source=site.prefix.split('.')[0];
    return {kind:'properties',reference:field!=='Left',...sources(site.prefix),types:['resource','new'].includes(source)?typeContext(statement?.Resource,conditionPath,source):[]};
  }
  if(scope==='Condition' && field==='Right') {
    if(['resource.type','new.type'].includes(owner?.Left)) return {kind:'types'};
    return {kind:'values',...sources(owner?.Left),comparison:owner?.Comparison,query:site.prefix};
  }
  return {kind:'none'};
}

export function policyFolds(text, analysis) {
  const result=[];
  for(const [encoded,range] of analysis.locations) {
    const path=JSON.parse(encoded), value=at(analysis.value,path), from=range.from+1,to=range.to-1;
    if(to<=from || !'{['.includes(text[range.from]) || text[to]!== (text[range.from]==='{'?'}':']')) continue;
    let label='…';
    if(path.length===2 && path[0]==='Statement' && typeof path[1]==='number') {
      const nativeActions=pbacActions(value?.Action),actions=nativeActions.join(', '),types=typeContext(value?.Resource,[],nativeActions.length===1&&nativeActions[0]==='Create'?'new':'resource');
      label=['Rule '+(path[1]+1),value?.Effect,actions,types.join(', ')].filter(Boolean).join(' · ');
    } else if(Array.isArray(value)) label=value.length+' '+(['All','Any'].includes(path.at(-1))?'conditions':path.at(-1)==='Statement'?'rules':'values');
    else if(value?.Left) label=[value.Left,value.Comparison].filter(Boolean).join(' ');
    else if(value?.Reference) label=value.Reference;
    else if(value && typeof value==='object') label=Object.keys(value).filter(k=>!['description','comment','_comment'].includes(k)).join(', ');
    const errors=analysis.issues.filter(i=>i.severity==='error' && i.from>=range.from && i.from<range.to).length;
    const description=value?.description ?? value?.comment ?? value?._comment;
    result.push({path,from,to,label:label.slice(0,100)+(errors?' · '+errors+' error'+(errors===1?'':'s'):''),errors,title:typeof description==='string'?description:label});
  }
  return result;
}

export function documentFingerprint(text) {
  let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
  return text.length+':'+(hash>>>0).toString(16);
}

// Only offer deterministic repairs. Never invent permissions or delete unknown keys.
export function diagnosticFixes(text, analysis) {
  const fixes=new Map(), value=analysis.value;
  if(value===undefined) {
    let quoted=false,escaped=false;const changes=[];
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(quoted) { if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false; }
      else if(c==='"')quoted=true;
      else if(c===',' && /^\s*[}\]]/.test(text.slice(i+1))) changes.push({from:i,to:i+1,insert:''});
    }
    if(changes.length) {
      let repaired=text;for(const change of [...changes].reverse())repaired=repaired.slice(0,change.from)+repaired.slice(change.to);
      try {JSON.parse(repaired);fixes.set(0,[{label:'Remove trailing comma'+(changes.length===1?'':'s'),changes}]);}catch { /* Other syntax errors need manual repair. */ }
    }
    return fixes;
  }
  analysis.issues.forEach((issue,index)=>{
    const token=at(value,issue.segments), key=issue.segments.at(-1);
    if(key==='Comparison' && typeof token==='string') {
      const normalized=token.replace(/\s/g,'').toLowerCase(), canonical=[...PBAC_COMPARISONS].find(v=>v.toLowerCase()===normalized);
      if(canonical && canonical!==token) fixes.set(index,[{label:'Use '+canonical,changes:[{from:issue.from,to:issue.to,insert:JSON.stringify(canonical)}]}]);
    }
  });
  return fixes;
}
