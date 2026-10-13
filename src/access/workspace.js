import { PBAC_ACTIONS, pbacAction, pbacEffect, pbacGrouping, pbacActions, togglePBACAction } from './pbac-syntax.js';
import { ruleDescription } from './pbac-annotations.js';
import { createPBACCatalogue } from './pbac-catalogue.js';
import { genericField, propertyChoices } from './pbac-fields.js';
import { icon } from './icons';
import { renderTrace, expandTrace, selectedRuleTrace } from './trace-view';
import { traceRules, traceOutcome, traceRequestLabel } from './trace-summary';
import { renderTestTiming } from './trace-timing';
import { createMatrixIndex, collectMatrixReferences } from './matrix-model.js';
import { matrixState, mountMatrix } from './matrix-view.js';
import { createMatrixEvidenceLoader } from './matrix-evidence-loader.js';
import { createPerformanceController } from './performance-controller.js';
import { mountPerformance, performanceViewState } from './performance-view.js';
import { renderEngineTrace, mountEngineTrace } from './trace-review';
import { createInputs, initializeCreate, readCreateValues, createFieldValue, setCreateValue, setCreateNumber, omitCreateValue, createResource, testContextRids } from './create-test-model.js';
import { renderCreateTest, renderDefaultOrigin } from './create-test-view.js';
import { useCreateDefault, resetCreateDefault, changeCreateType } from './create-default-model.js';
import { parseAccessDestination } from '../lib/access-workspace/entry';
import { referenceIdentity, selectedReferenceAccessor, chooseReference, editableReferenceValue, editReferenceText } from './reference-model.js';
import {
  changePatch,
  historyContext,
  reverseChange,
  rolePolicyMatches,
  discardRecord,
  conflictingJSONDrafts,
  copyRoleDefinitions
} from './history-model.js';
import {
  tokenizePBAC
} from './pbac-highlighting.js';
import {
  comparisonRows,
  comparisonLabels,
  comparisonHint,
  changeComparison,
  multiComparisons,
  searchChoices,
  toggleChoice,
  nextChoice
} from './picker-model.js';
import {
  resolveUser,
  userChoiceRows
} from './principal-model.js';
import {
  renameExample,
  proposedForTest,
  switchTestAction
} from './test-request-model.js';
import {
  scopeOwner,
  roleDefinitions,
  historyRecordIds,
  historyStep,
  createViewNavigation
} from './navigation-model.js';
import {
  expressionKind,
  duplicateIndices,
  transformExpression
} from './builder-model.js';
import {
  typeContext,
  fieldKind,
  listChoiceRows,
  selectedListItems,
  chooseListValue,
  changeField
} from './schema-model.js';
import {
  recordSearchRank,
  suggestedBusinessId,
  businessIdError,
  ancestry,
  moveProblem,
  renameRoleReferences,
  referencedRoleIds,
  queryMatches,
  policyMatches,
  policyDiagnostics,
  objectMatches
} from './interaction-model.js';
import { createLazyEditor } from './lazy-editor.js';
import { createPickerSearch } from './picker-search';
import { encodeWorkspaceState, decodeWorkspaceState, stateAfterApply } from './workspace-state.js';
import { roleSearchResults } from './tree-search-model.js';
import {
  unfinishedIdEdits,
  pendingRecordCount,
  changedRoleOwners,
  selectedTestContext,
  matchingSavedStatement,
  withoutTestResults
} from './workflow-model.js';

/** Compact DOM renderer retained from the approved interactive design.
 * Network, environment checks, and persistence live behind the typed host API. */
export function mountWorkspace({
  snapshot,
  saved,
  api,
  persist,
  busy,
  notice
}) {
  let applying = false,
    persistenceReady = false;
  const schemaLoaded = new Set(),
    schemaPending = new Map();
  const $ = s => document.querySelector(s),
    $$ = s => [...document.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  } [c]));
  const clone = v => JSON.parse(JSON.stringify(v));
  const ib = (name, cmd, title, extra = '') =>
    `<button type="button" class="icon-button" data-command="${cmd}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon(name)}</button>`;
  const button = (name, cmd, label, extra = '') =>
    `<button type="button" data-command="${cmd}" ${extra}>${icon(name)}<span class="button-label">${esc(label)}</span></button>`;
  const A = PBAC_ACTIONS;
  const directions = {
    InwardsReferenceRoleDelegationRule: 'Referring objects',
    OutwardsReferenceRoleDelegationRule: 'Referenced objects',
    HierarchicalDownwardsRoleDelegationRule: 'Descendants',
    HierarchicalUpwardsRoleDelegationRule: 'Ancestors'
  };
  const fields = Object.fromEntries(Object.keys(snapshot.classes).map(type => [type, []]));
  for (const a of snapshot.model.scope.filter(a => a.kind === 'RoleAssignment' && a.source && a.field)) {
    fields[a.source] ??= [];
    if (!fields[a.source].includes(a.field)) fields[a.source].push(a.field);
  }
  const context = {
    objects: [],
    prototypes: [],
    users: [],
    groups: []
  };
  let model = clone(saved?.model ?? snapshot.model),
    baseline = clone(saved?.baseline ?? snapshot.model),
    folders = model.folders;
  let revision = 0;
  const environment = {
    name: snapshot.name,
    capturedOn: snapshot.loadedAt
  };
  const history = [],
    future = [];
  const state = {
    kind: 'role', rid: '', empty: true, tabs: [],
    testing: false, objectTest: null,
    matrixShowing: false, matrixOpen: false, matrix: matrixState(), matrixTesting: false, matrixTest: null,
    performanceShowing: false, performanceOpen: false, performance: performanceViewState(),
    search: '',
    closed: new Set(model.roles.map(r => r.rid)),
    statement: 0,
    view: 'rules',
    technical: false,
    tests: new Map(),
    testOpen: new Set(),
    raw: new Map(),
    reviewOpen: false,
    reviewing: false,
    searchKind: 'all',
    roleFilter: '',
    folderClosed: new Set(folders.map(f => f.rid)),
    idDraft: new Map(),
    recentObjects: [],
    picker: null,
    drag: null
  };
  const testKey = () => state.matrixTesting ? `matrix:${state.matrixTest.role}:${state.matrixTest.type}` : state.testing ? 'object:' + state.objectTest.rid : `${state.kind}:${state.rid}:${state.kind==='policy'?state.statement:0}`;

  const activeTest = q => state.tests.get(testKey()) === q;

  function defaultTest() {
    if (state.matrixTesting) return { mode:'role', subject:state.matrixTest.role, action:'Read', resource:'', proposed:'{}', result:null, typeHint:state.matrixTest.type };
    if (state.testing) return { mode: 'user', subject: '', userId: '', action: 'Read', resource: state.objectTest.rid, proposed: '{}', result: null };
    const r = current();
    if (state.kind === 'role') return {
      mode: 'role',
      subject: r.rid,
      action: 'Read',
      resource: '',
      proposed: '{}',
      result: null
    };
    const st = r?.content?.Statement?.[state.statement];
    const subjects = Array.isArray(st?.Subject) ? st.Subject : [st?.Subject];
    const token = subjects.find(t => typeof t === 'string' && t.startsWith('role:'));
    const role = token ? model.roles.find(r => r.id === token.slice(5)) : null;
    const userToken = subjects.find(t => typeof t === 'string' && t.startsWith('user:')),
      userId = userToken?.slice(5) ?? '',
      user = resolveUser(userDirectory.users, userId);
    return {
      mode: role ? 'role' : 'user',
      subject: role?.rid ?? user?.rid ?? '',
      userId: user?.id ?? userId,
      action: pbacActions(st?.Action)[0] ?? 'Read',
      resource: '',
      proposed: '{}',
      result: null,
      ...(!role && !userId && state.testActor ? state.testActor : {})
    };
  }
  Object.defineProperty(state, 'check', {
    get() {
      const key = testKey();
      if (!state.tests.has(key)) state.tests.set(key, defaultTest());
      return state.tests.get(key);
    },
    set(value) {
      state.tests.set(testKey(), value);
    }
  });

  function clearPolicyTests() {
    const prefix = 'policy:' + state.rid + ':';
    for (const key of state.tests.keys())
      if (key.startsWith(prefix)) {
        state.tests.delete(key);
        state.testOpen.delete(key);
      }
  }

  function invalidatePolicyTests() {
    const prefix = 'policy:' + state.rid + ':';
    for (const [key, test] of state.tests)
      if (key.startsWith(prefix)) state.tests.set(key, withoutTestResults(test));
  }

  function canOpenSavedRule(rid, index) {
    return !state.raw.has(rid) && !!matchingSavedStatement(model.policies.find(p => p.rid === rid),
      baseline.policies.find(p => p.rid === rid), index);
  }

  function staleTests() {
    for (const test of state.tests.values())
      if (test.result) test.result.stale = true;
  }
  const current = () => model[state.kind === 'role' ? 'roles' : 'policies'].find(r => r.rid === state.rid);
  const roleByRid = rid => model.roles.find(r => r.rid === rid);
  const currentRole = () => !state.testing && state.kind === 'role' ? current() : null;
  const assignments = r => model.scope.filter(a => a.kind === 'RoleAssignment' && a.parent === r.rid);

  function descendants(rid, list = model.scope) {
    const found = [];

    function visit(id) {
      for (const r of list.filter(n => n.parent === id)) {
        if (found.includes(r)) continue;
        found.push(r);
        visit(r.rid);
      }
    }
    visit(rid);
    return found;
  }

  function mentions(value, id) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([k, v]) => (k === 'Subject' && (Array.isArray(v) ? v : [v]).includes('role:' + id)) || (k ===
      'Roles' && (Array.isArray(v) ? v : [v]).some(t => t === id || t === 'role:' + id)) || (typeof v === 'object' && mentions(v, id)));
  }
  const usedPolicies = r => model.policies.filter(p => mentions(p.content, r.id));
  const actions = p => [...new Set((p.content?.Statement ?? []).flatMap(s => pbacActions(s.Action)))].filter(
    Boolean);
  const option = (value, label, selected) => `<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`;
  const roleLabel = r => r.name + (model.roles.filter(x => x.name === r.name).length > 1 ? ' · ' + (r.id) : '');
  const roleOptions = selected => model.roles.map(r => option(r.rid, roleLabel(r), selected)).join('');
  const folderPath = rid => ancestry(folders, rid).map(r => r.name).join(' / ');
  const rolePath = rid => ancestry(model.roles, rid).map(r => r.name).join(' / ');
  const stamp = () => String(Date.now()) + String(Math.floor(Math.random() * 10000));
  const draftRid = () => `draft:${stamp()}`;
  const status = text => {
    $('#status').textContent = text;
  };

  let changeCache;
  function differences() {
    if (changeCache?.model === model && changeCache?.baseline === baseline) return changeCache.rows;
    const rows = [];
    for (const key of ['roles', 'policies', 'scope', 'globals', 'folders']) {
      const old = new Map(baseline[key].map(r => [r.rid, r]));
      const now = new Map(model[key].map(r => [r.rid, r]));
      for (const [rid, r] of now) {
        const before = old.get(rid);
        if (JSON.stringify(before) !== JSON.stringify(r)) rows.push({ key, r, before, kind: before ? 'Edit' : 'Create' });
      }
      for (const [rid, r] of old) if (!now.has(rid)) rows.push({ key, r, before: r, kind: 'Delete' });
    }
    changeCache = { model, baseline, rows, ids: new Set(rows.map(d => d.r.rid)) };
    return rows;
  }
  function changed(rid) {
    differences();
    return changeCache.ids.has(rid);
  }

  function openRecord(kind, rid, scopeSelection = null) {
    state.performanceShowing = false;
    if (state.rid !== rid) { state.membershipQuery = ''; state.membershipLimit = 100; }
    state.documents ??= new Map();
    captureView();
    state.testing = false;
    state.matrixShowing = false; state.matrixTesting = false;
    state.scopeSelection = scopeSelection;
    const saved = state.documents.get(kind + ':' + rid);
    state.historyShowing = false;
    state.reviewing = false;
    state.empty = false;
    state.kind = kind;
    state.rid = rid;
    state.statement = saved?.statement ?? 0;
    state.view = policyEditorView();
    if (!state.tabs.some(t => t.kind === kind && t.rid === rid)) state.tabs.push({
      kind,
      rid
    });
    if (kind === 'role') {
      state.closed.delete(rid);
      for (let parent = roleByRid(rid)?.parent; parent; parent = roleByRid(parent)?.parent) state.closed.delete(parent);
      revealDefinitionPath(scopeSelection);
    }
    if (innerWidth <= 620) document.body.classList.add('no-explorer');
    render();
    $('#editor').scrollTop = saved?.scroll ?? 0;
    $('#tree .tree-row.selected')?.scrollIntoView({
      block: 'nearest'
    });
  }

  function render() {
    queueMicrotask(saveWorkspace);
    $('#search').value = state.search;
    folders = model.folders;
    let replacedView = false;
    if (!state.empty && !current()) {
      state.empty = true;
      state.rid = '';
      replacedView = true;
    }
    if (state.scopeSelection && (state.kind !== 'role' || !model.scope.some(r => r.rid === state.scopeSelection) ||
      scopeOwner(model, state.scopeSelection) !== state.rid)) {
      state.scopeSelection = null;
      replacedView = true;
    }
    if (replacedView) navigation.sync(viewRoute(), true);
    if (!state.empty && !state.historyShowing && !state.reviewing && !state.tabs.some(t => t.rid === state.rid)) state.tabs.push({
      kind: state.kind,
      rid: state.rid
    });
    closePicker(false);
    renderToolbar();
    renderTree(true);
    renderTabs();
    renderEditor();
    $('#selection-kind').textContent = state.historyShowing ? 'History' : state.reviewing ? 'Environment' : state.performanceShowing ? 'Performance' : state.matrixShowing ? 'Access matrix' : state.testing ? 'Access test' : state.empty ? '' : state
      .kind === 'role' ? 'Role' : 'Policy';
    $('.doc-tab.active')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    });
  }

  function renderToolbarBase() {
    renderSearchTools();
    $('#environment-name').textContent = environment.name;
    $('.matrix-launch')?.setAttribute('aria-pressed',String(state.matrixShowing&&!state.historyShowing&&!state.reviewing));
    $('.performance-launch')?.setAttribute('aria-pressed',String(state.performanceShowing&&!state.historyShowing&&!state.reviewing));
    for (const cmd of ['undo', 'redo', 'explorer', 'help']) {
      $(`.icon-button[data-command="${cmd}"]`).innerHTML = icon(cmd);
    }
    for (const [cmd, entries, shortcut] of [['undo', history, 'Ctrl+Z'], ['redo', future, 'Ctrl+Shift+Z']]) {
      const control = $(`[data-command=${cmd}]`), event = entries.at(-1),
        label = (cmd === 'undo' ? 'Undo' : 'Redo') + (event ? ': ' + historyTitle(event) : '') + ' · ' + shortcut;
      control.disabled = !event;
      control.title = label;
      control.setAttribute('aria-label', label);
    }
    $$('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
    const count = differences().length;
    $('#pending-review').innerHTML =
      `<button class="review-launch ${count?'dirty':''}" data-command="review" ${!count?'disabled':''}>${icon('changes')}<span>${count?'Review pending edits':'No pending edits'}</span>${count?`<b>${count}</b>`:''}</button>`;
  }

  function renderSearchTools() {
    const input = $('#search');
    input.placeholder = state.searchKind === 'policy' ? 'Find policy name, role or rule…' : state.searchKind === 'role' ?
      'Find role, class, field or reference…' : 'Find name, ID, field or policy text…';
    input.setAttribute('aria-label', state.searchKind === 'policy' ? 'Find policies by name, ID, role or rule' :
      state.searchKind === 'role' ? 'Find roles, field assignments or delegations' : 'Find roles, assignments, delegations or policies');
    $('#search-clear').hidden = !state.search;
    $('#search-scopes').innerHTML = [
      ['all', 'All'],
      ['role', 'Roles'],
      ['policy', 'Policies']
    ].map(([v, n]) =>
      `<button data-command="search-kind" data-value="${v}" aria-pressed="${state.searchKind===v}" class="${state.searchKind===v?'active':''}">${n}</button>`
      ).join('');
    $('#search-filter').innerHTML = state.roleFilter ?
      `<button data-command="clear-role-filter" title="Clear role filter">${icon('role')}Using ${esc(roleByRid(state.roleFilter)?.name??'role')}${icon('close')}</button>` :
      '';
  }

  function highlighted(text) {
    let result = esc(text);
    if (!state.search) return result;
    const term = state.search.replace(/^"|"$/g, '').trim();
    if (!term || term.length < 2) return result;
    const start = String(text).toLowerCase().indexOf(term.toLowerCase());
    return start < 0 ? result : esc(String(text).slice(0, start)) + '<mark>' + esc(String(text).slice(start, start + term.length)) +
      '</mark>' + esc(String(text).slice(start + term.length));
  }

  function technical() {
    return '';
  }

  const collapsedSections = new Set();

  function section(title, i, tools, count = '') {
    const key = state.kind + ':' + state.rid + ':' + title;
    return `<div class="section-heading"><h2><button class="section-label" data-command="toggle-section" data-section="${esc(key)}" aria-expanded="${!collapsedSections.has(key)}"><span class="disclosure">${icon('down')}</span>${icon(i)}<span>${title}</span>${count!==''?'<span class="section-count">'+count+'</span>':''}</button></h2><span class="spacer"></span>${tools}</div>`;
  }
  let jsonEditor = null, displayedView = null, jsonOutlineVisible = false, testReturn = null, matrixView = null, matrixIndex = null, matrixBaseline = null, performanceView = null;
  const performance = createPerformanceController({api,getSnapshot:()=>({...snapshot,model:baseline}),getSeeds:performanceSeeds});
  window.addEventListener('pagehide',()=>performance.stop());
  const matrixEvidence = createMatrixEvidenceLoader({
    load:(references,signal) => api({operation:'matrixMetadata',references},{signal}),
    validate:value => {
      const next = createMatrixIndex(baseline, snapshot.classes, snapshot.typeChildren, value);
      matrixIndex = next; matrixBaseline = baseline;
    },
    changed:() => { if (state.matrixShowing) { captureView(); render(); } },
  });
  const editorLoader = createLazyEditor(() => import('./json-editor.js'));
  let pendingJSONFind = '';
  let pendingJSONStatement = null;
  const jsonBookmarks = new Map();
  const viewRoute = () => ({ surface: state.historyShowing ? 'history' : state.reviewing ? 'review' : state.performanceShowing ? 'performance' : state.matrixShowing ? 'matrix' : state.matrixTesting ? 'matrix-test' : state.testing ? 'test' : state.empty ? 'empty' : 'record',
    kind: state.kind, rid: state.matrixTesting ? testKey() : state.testing && !state.historyShowing ? state.objectTest.rid : state.rid, statement: state.statement, scopeSelection: state.scopeSelection ?? null,
    ...(state.matrixTesting ? { matrixTest: state.matrixTest } : {}),
    ...(state.historyShowing ? { returnTo: state.historyReturn } : {}) });
  function captureView(withEditor = true) {
    matrixView?.capture();
    performanceView?.capture();
    if (displayedView?.surface !== 'record') return;
    state.documents ??= new Map();
    state.documents.set(displayedView.kind + ':' + displayedView.rid, { statement: displayedView.statement,
      scopeSelection: displayedView.scopeSelection ?? null, scroll: $('#editor').scrollTop });
    if (withEditor && jsonEditor) {
      jsonBookmarks.delete(displayedView.rid);
      jsonBookmarks.set(displayedView.rid, jsonEditor.bookmark());
      // Text drafts persist separately; retain editor undo state for 20 recent policies.
      if (jsonBookmarks.size > 20) jsonBookmarks.delete(jsonBookmarks.keys().next().value);
    }
  }
  function restoreRoute(route) {
    captureView();
    displayedView = null;
    closePicker(false);
    state.kind = route.kind; state.rid = route.rid;
    state.view = policyEditorView();
    state.matrixShowing = route.surface === 'matrix';
    state.performanceShowing = route.surface === 'performance';
    state.performanceOpen ||= state.performanceShowing;
    state.matrixOpen ||= state.matrixShowing;
    state.matrixTesting = route.surface === 'matrix-test' && !!route.matrixTest && model.roles.some(r => r.rid === route.matrixTest.role);
    if (state.matrixTesting) state.matrixTest = route.matrixTest;
    state.testing = route.surface === 'test' || state.matrixTesting;
    if (state.matrixTesting) { state.testOpen.add(testKey()); state.rid=''; }
    else if (state.testing) {
      state.objectTest = context.objects.find(o => o.rid === route.rid) ?? { rid: route.rid };
      state.testOpen.add(testKey());
      state.rid = '';
    }
    state.statement = route.statement ?? 0;
    state.scopeSelection = route.surface === 'record' && route.kind === 'role' &&
      model.scope.some(r => r.rid === route.scopeSelection) && scopeOwner(model, route.scopeSelection) === route.rid ? route.scopeSelection : null;
    route.scopeSelection = state.scopeSelection;
    state.historyShowing = route.surface === 'history';
    if (state.historyShowing) state.historyReturn = route.returnTo;
    state.reviewing = route.surface === 'review';
    state.reviewOpen ||= state.reviewing;
    state.empty = route.surface === 'empty' || !current();
    if (state.empty && !state.testing && !state.matrixShowing && !state.performanceShowing && !state.historyShowing && !state.reviewing) route.surface = 'empty';
    if (!state.empty && state.kind === 'role') {
      for (const role of ancestry(model.roles, state.rid)) state.closed.delete(role.rid);
      revealDefinitionPath(state.scopeSelection);
    }
    render();
    $('#editor').scrollTop = state.documents?.get(state.kind + ':' + state.rid)?.scroll ?? 0;
    if (state.scopeSelection) revealDefinitionEditor(false);
  }
  const navigation = createViewNavigation(window.history, snapshot.environment, restoreRoute, window.sessionStorage);
  window.addEventListener('popstate', event => navigation.pop(event.state));
  $('#editor').addEventListener('scroll', () => captureView(false), { passive: true });
  function syncView() {
    displayedView = viewRoute();
    navigation.sync(displayedView);
    for (const [cmd, glyph, enabled] of [['navigate-back', 'back', navigation.back], ['navigate-forward', 'arrow', navigation.forward]]) {
      const button = $('[data-command="' + cmd + '"]');
      button.innerHTML = icon(glyph); button.disabled = !enabled;
    }
  }

  function renderEditor() {
    const previous = displayedView;
    $('#dock').hidden = true;
    $('.workarea').classList.remove('test-docked');
    captureView();
    matrixView?.destroy(); matrixView = null;
    performanceView?.destroy(); performanceView = null;
    editorLoader.cancel();
    pendingJSONFind = '';
    pendingJSONStatement = null;
    jsonEditor?.destroy();
    jsonEditor = null;
    $('#editor').classList.remove('json-workspace', 'history-workspace', 'matrix-workspace', 'performance-workspace');
    $('.workarea').classList.toggle('object-testing', state.testing && !state.historyShowing && !state.reviewing);
    syncView();
    if (state.historyShowing) {
      renderHistory();
      return;
    }
    if (state.reviewing) {
      renderReview();
      return;
    }
    if (state.performanceShowing) {
      $('#editor').classList.add('performance-workspace');
      performanceView = mountPerformance($('#editor'),{controller:performance,state:state.performance,getSnapshot:()=>({...snapshot,model:baseline}),
        hasDraftChanges:()=>!!differences().length||!!state.raw.size,
        canOpen:canOpenPerformanceRule,
        openRule:(rid,statement,measured)=>{if(canOpenPerformanceRule(rid,statement,measured))enter({kind:'policy',rid,statement});},
        openRole:rid=>enter({kind:'role',rid}),test:openPerformanceTest});
      return;
    }
    if (state.matrixShowing) {
      $('#editor').classList.add('matrix-workspace');
      void matrixEvidence.ensure(baseline,() => collectMatrixReferences(baseline));
      const evidence = matrixEvidence.read();
      if (matrixBaseline !== baseline) { matrixIndex = createMatrixIndex(baseline, snapshot.classes, snapshot.typeChildren, evidence.value); matrixBaseline = baseline; }
      matrixView = mountMatrix($('#editor'), { index:matrixIndex, state:state.matrix, metadataStatus:evidence.status, canOpen:canOpenSavedRule,
        retryEvidence:evidence.canRetry ? () => { void matrixEvidence.retry(); } : null,
        moreEvidence:!evidence.loading && evidence.remaining ? () => { void matrixEvidence.more(); } : null,
        hasDraftChanges:!!differences().length || !!draftPolicies().length || !!unfinishedIdEdits(model, state.idDraft).length,
        changed:() => { void saveWorkspace().catch(showError); },
        openRule:(rid, statement) => { captureView(); enter({kind:'policy',rid,statement}); },
        test:openMatrixTest });
      return;
    }
    if (state.testing) {
      $('#editor').innerHTML = '';
      renderDock();
      return;
    }
    if (state.empty || !current()) {
      $('#editor').innerHTML = '<div class="welcome">Select a role or policy.</div>';
      return;
    }
    if (state.kind === 'role') renderRole();
    else renderPolicy();
    mountBuilder();
    $$('.section-label').forEach(button => button.closest('.section').classList.toggle('collapsed', collapsedSections.has(button.dataset
      .section)));
    renderDock();
    mountJSON();
    mountWorkspaceUX();
    mountFastChoices();
    loadVisibleSchemas();
    const bookmark = state.documents?.get(state.kind + ':' + state.rid);
    if (bookmark && (previous?.surface !== 'record' || previous.rid !== state.rid)) $('#editor').scrollTop = bookmark.scroll ?? 0;
    displayedView = viewRoute();
    navigation.sync(displayedView);
  }

  function renderRole() {
    const r = current(), as = assignments(r), globals = model.globals.filter(g => g.parent === r.rid);
    state.membershipSections ??= new Set();
    if (!state.membershipSections.has(r.rid)) {
      state.membershipSections.add(r.rid);
      if (!globals.length) collapsedSections.add('role:' + r.rid + ':Global assignments');
    }
    let html = recordHead(r);
    html += `<section class="section">${section('Field assignments','fieldAssignment',button('plus','add-assignment','Assignment'),as.length)}<table class="grid-table"><thead><tr><th style="width:35%">Type</th><th>Field</th><th style="width:80px"></th></tr></thead><tbody>${as.map(a=>`<tr data-scope-editor="${a.rid}"><td><select data-scope="source" data-rid="${a.rid}" aria-label="Assignment source class">${!a.source?'<option value="">Not resolved</option>':''}${Object.keys(fields).map(t=>option(t,t,a.source)).join('')}</select></td><td><select data-scope="field" data-rid="${a.rid}" aria-label="Assignment field">${!a.field?'<option value="">Not configured</option>':''}${[...new Set([a.field,...(fields[a.source]??[])])].filter(Boolean).map(f=>option(f,f,a.field)).join('')}</select></td><td class="tools-cell">${ib('scope','add-path','Extend this assignment','data-parent="'+a.rid+'"')}${ib('trash','delete-scope','Remove assignment','data-rid="'+a.rid+'"')}</td></tr>`).join('')}</tbody></table>${!as.length?'<div class="empty-row">No field assignments.</div>':''}</section>`;
    html += `<section class="section">${section('Delegation','scope',button('plus','add-path','Add path',as.length?'':'disabled'))}`;
    const path = (parent, depth) => model.scope.filter(x => x.parent === parent && x.kind !== 'RoleAssignment').map(d =>
      `<div class="scope-row" data-scope-editor="${d.rid}" style="--depth:${depth}"><span class="scope-mark">${icon('scope')}</span><select data-scope="kind" data-rid="${d.rid}" aria-label="Delegation direction">${Object.entries(directions).map(([k,v])=>option(k,v,d.kind)).join('')}</select>${d.kind.startsWith('Hierarchical')?'':scopeReference(d)}${ib('plus','add-path','Continue this path','data-parent="'+d.rid+'"')}${ib('trash','delete-scope','Remove this branch','data-rid="'+d.rid+'"')}</div>` + path(d.rid, depth + 1)).join('');
    html += as.map(a => `<div class="scope-origin">${icon('fieldAssignment')}<span>${esc(a.source||'Source object')}</span><span>·</span><code>${esc(a.field||'No field')}</code></div>${path(a.rid,0)||'<div class="empty-row">Source object only.</div>'}`).join('') || '<div class="empty-row">Add a field assignment to extend its scope.</div>';
    html += `</section><section class="section global-section">${section('Global assignments','globe',button('plus','add-global','User / group'),globals.length)}${renderMemberships(r)}</section><section class="section">${rolePolicyPreview(r)}</section>`;
    $('#editor').innerHTML = html;
  }

  function showPerformance() {
    captureView();state.performanceOpen=true;state.performanceShowing=true;state.matrixShowing=false;state.matrixTesting=false;
    state.historyShowing=false;state.reviewing=false;state.testing=false;state.empty=true;state.rid='';state.kind='role';state.scopeSelection=null;
    render();
  }
  function canOpenPerformanceRule(rid,index,measured) {
    if(index===undefined)return model.policies.some(p=>p.rid===rid);
    const a=measured?.model.policies.find(p=>p.rid===rid)?.content?.Statement?.[index];
    const b=baseline.policies.find(p=>p.rid===rid)?.content?.Statement?.[index];
    return (!measured||JSON.stringify(a)===JSON.stringify(b))&&canOpenSavedRule(rid,index);
  }
  function performanceSeed(q) {
    const user=q.mode==='user'?selectedTestUser(q):null,role=q.mode==='role'?roleByRid(q.subject):null;
    if(!user&&!role)throw Error('Choose a user or role before profiling this check.');
    const chosen=context.objects.find(o=>o.rid===q.resource),proposed=proposedForTest(q,chosen);
    const resource=q.action==='Create'?createResource(q):q.resource;
    if(!resource)throw Error('Choose the object or Create destination before profiling.');
    if(q.action!=='Create'&&!chosen)throw Error('Choose an object from the picker before profiling this check.');
    const actor={...(user||role),kind:user?'user':'role'},object=q.action==='Create'?{rid:resource,id:'new '+proposed.type,name:'Proposed '+proposed.type,type:proposed.type}:chosen;
    const request={resource_rid:resource,subject_rid:actor.rid,action:q.action.toUpperCase(),...(proposed?{proposed}:{})};
    return {id:JSON.stringify(request),actor,object,action:request.action,request,
      ...(q.action==='Create'?{contextObject:context.objects.find(o=>o.rid===resource)||{rid:resource,id:resource}}:{})};
  }
  function performanceSeeds() {
    return [...state.tests.values()].flatMap(q=>{try{return [performanceSeed(q)];}catch{return [];}}).slice(0,8);
  }
  function openPerformanceTest(c) {
    // A Create's proposed type is not the class of its real parent. Keep the
    // destination identity intact in the shared object catalogue.
    enter({kind:'test',object:c.action==='CREATE'?(c.contextObject||context.objects.find(o=>o.rid===c.request.resource_rid)||{rid:c.request.resource_rid,id:c.request.resource_rid}):c.object});
    if(c.actor.kind==='user')rememberPrincipal({...c.actor,type:'User'});
    state.check={...switchTestAction(state.check,c.action[0]+c.action.slice(1).toLowerCase()),mode:c.actor.kind,subject:c.actor.rid,userId:c.actor.kind==='user'?c.actor.id:'',
      resource:c.request.resource_rid,proposed:JSON.stringify(c.request.proposed||{},null,2),updateMode:'custom',result:null,createInitialized:true,createFields:Object.keys({...c.request.proposed?.properties,...c.request.proposed?.references}),createDefault:null,createNumberDrafts:{},viewScroll:0};
    render();
  }
  function showMatrix() {
    captureView();
    state.performanceShowing=false;
    state.matrixShowing=true; state.matrixOpen=true; state.matrixTesting=false; state.testing=false;
    state.historyShowing=false; state.reviewing=false; state.empty=true; state.rid='';state.kind='role';state.scopeSelection=null;
    render();
  }

  function openMatrixTest(selection, action) {
    if (!selection || !model.roles.some(r => r.rid === selection.role)) return;
    captureView();
    state.performanceShowing=false;
    state.matrixTest={...selection}; state.matrixTesting=true; state.testing=true; state.matrixShowing=false;
    state.historyShowing=false;state.reviewing=false;state.empty=true;state.rid='';state.kind='role';state.scopeSelection=null;
    if (action && state.check.action!==action) state.check=switchTestAction(state.check,action);
    seedMatrixCreateType();
    state.check.viewScroll=0; // Preparing a test always reveals the inputs.
    state.testOpen.add(testKey());
    render();
    $('#dock [data-command="'+(state.check.action==='Create'?'create-destination':state.check.resource?'prepare-check':'choose-object')+'"]')?.focus({preventScroll:true});
  }

  function seedMatrixCreateType() {
    if (!state.matrixTesting || state.check.action !== 'Create') return;
    try {
      if (!readCreateValues(state.check.proposed).type) setCreateValue(state.check,'type','properties',state.matrixTest.type);
    } catch { /* Keep unfinished JSON editable when returning to its test. */ }
  }

  function scopeReference(row) {
    const value = editableReferenceValue(row), identity = referenceIdentity(row);
    const issue = identity.status === 'conflict' ? 'Stored class and reference disagree. Choose the intended reference.' :
      !identity.source && (row.field || row.referenceConfig) ? 'Defining class is unresolved. Choose a reference to resolve it.' : '';
    return `<span class="scope-reference"><textarea class="reference-value" rows="1" data-scope="field" data-rid="${row.rid}" aria-label="Delegation reference, class and property" placeholder="Class.property" title="${esc(issue || value)}" spellcheck="false" data-reference-list="reach-reference-options">${esc(value)}</textarea>${issue?'<small class="reference-issue">'+esc(issue)+'</small>':''}</span>`;
  }

  function testSeedLabel() {
    if (state.kind !== 'policy') return '';
    const q = state.check, seed = defaultTest();
    return q.mode === seed.mode && q.subject === seed.subject && q.action === seed.action ?
      'Inputs from rule ' + (state.statement + 1) : 'Rule ' + (state.statement + 1) + ' · custom inputs';
  }

  function renderDock() {
    const el = $('#dock');
    if (!el) return;
    const active = el.contains(document.activeElement) ? document.activeElement : null,
      focus = active ? pickerAnchorKey(active) : null,
      selection = active?.matches('input,textarea') && active.type !== 'number' ? [active.selectionStart, active.selectionEnd] : null,
      scroll = el.querySelector('.test-body')?.scrollTop ?? 0;
    el.hidden = (state.empty && !state.testing) || state.reviewing || state.historyShowing || !state.testOpen.has(testKey());
    $('.workarea').classList.toggle('test-docked', !el.hidden);
    if (el.hidden) return;
    const q = state.check;
    if (q.action === 'Create') initializeCreate(q, savedTestStatement(), Object.keys(schemaData.classes));
    hydrateTestUser(q);
    const chosen = [...context.objects, ...context.prototypes].find(o => o.rid === q.resource),
      role = q.mode === 'role' ? roleByRid(q.subject) : null,
      pending = differences().length || state.raw.size || unfinishedIdEdits(model, state.idDraft).length,
      height = Math.max(140, Math.min(Math.floor(innerHeight * .6), state.testDockHeight ?? (['Create','Update'].includes(q.action) ? 230 : 164)));
    el.style.height = height + 'px';
    el.innerHTML = `<div class="test-resize" role="separator" tabindex="0" aria-label="Resize access test" aria-orientation="horizontal" aria-valuemin="140" aria-valuemax="${Math.floor(innerHeight*.6)}" aria-valuenow="${height}" title="Drag to resize · Up / Down"></div><div class="test-heading"><strong>Access test</strong><span class="test-saved-scope" title="Tests saved PBAC policies across the environment, including policies other than the one open here.">All saved policies</span>${state.kind==='policy'?'<span class="test-seed">'+testSeedLabel()+'</span>':''}<span class="spacer"></span>${pending?'<span class="test-draft-note">Draft edits excluded</span>':''}${ib('performance','profile-check','Profile this check')}${ib('close','close-test','Close access test')}</div><div class="test-body"><div class="test-inputs ${q.action==='Create'?'is-create':''}"><div class="test-subject-field"><div class="test-field-label"><span>${q.mode==='role'?'Role':'User'}</span><button class="quiet-button" data-command="test-mode">${q.mode==='role'?'Use user':state.kind==='role'||defaultTest().mode==='role'?'Use role':'Choose role…'}</button></div>${q.mode==='role'?'<button class="test-role-value" data-command="choose-test-role" title="'+esc(role?.id??'Choose role')+'">'+icon('role')+'<strong>'+esc(role?.name??'Choose role')+'</strong>'+icon('down')+'</button>':userPickerButton(selectedTestUser(q))}</div><div class="test-action-field"><span class="test-field-label">Action</span><div class="action-segment">${A.map(a=>`<button data-command="test-action" data-action-value="${a}" class="${a===q.action?'active':''}" aria-pressed="${a===q.action}">${a}</button>`).join('')}</div></div>${q.action==='Create'?'':`<label class="object-label">Object<button class="object-picker picker-trigger ${chosen?'has-object':''}" data-command="choose-object" aria-label="Choose test object" title="${esc(chosen?[chosen.type,chosen.id,chosen.path].filter(Boolean).join(' · '):'Search by name or ID; filter by type')}">${icon('object')}<span><strong>${esc(chosen?.name??(q.resource||'Find an object…'))}</strong></span>${icon('search')}</button></label>`}<button class="primary test-run" data-command="prepare-check" title="Run access test · Ctrl+Enter" ${!q.result?.running&&(q.action==='Create'?createReady(q):q.resource)&&(q.mode==='role'?role:selectedTestUser(q))?'':'disabled'}>${icon('check')}${q.result?.running?'Testing…':'Run test'}</button>${testChangeFields(q,chosen)}</div>${q.mode==='user'?'<p class="test-scope">Includes all roles assigned to this user.</p>':''}${q.rerunRequired&&!q.result?'<p class="test-rerun" role="status">Applied. Run this test again on the saved configuration.</p>':''}<div class="check-result" id="check-result">${q.result?renderResult():''}</div></div>`;
    const resize = el.querySelector('.test-resize');
    const size = value => {
      state.testDockHeight = Math.max(140, Math.min(Math.floor(innerHeight * .6), value));
      el.style.height = state.testDockHeight + 'px';
      resize.setAttribute('aria-valuenow', String(state.testDockHeight));
    };
    let start;
    resize.addEventListener('pointerdown', event => {
      start = { y: event.clientY, height: el.getBoundingClientRect().height };
      resize.setPointerCapture(event.pointerId); event.preventDefault();
    });
    resize.addEventListener('pointermove', event => {
      if (resize.hasPointerCapture(event.pointerId)) size(start.height + start.y - event.clientY);
    });
    resize.addEventListener('pointerup', event => {
      resize.releasePointerCapture(event.pointerId); void saveWorkspace().catch(showError);
    });
    resize.addEventListener('keydown', event => {
      if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      event.preventDefault();
      size(event.key==='Home'?140:event.key==='End'?innerHeight*.6:el.getBoundingClientRect().height+(event.key==='ArrowUp'?24:-24));
      void saveWorkspace().catch(showError);
    });
    mountResult();
    fitTestDock();
    if (focus) {
      const target = pickerFocusCandidates(focus)[focus.index];
      target?.focus({ preventScroll: true });
      if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
    }
    const testBody=el.querySelector('.test-body');
    testBody.scrollTop = q.viewScroll ?? scroll;
    testBody.addEventListener('scroll',()=>{
      if (!testBody.isConnected || el.hidden || !activeTest(q)) return;
      q.viewScroll=testBody.scrollTop;void saveWorkspace().catch(showError);
    },{passive:true});
    if (q.action === 'Create') { void loadCreateSchema(q); void loadCreateLabels(q); void loadCreationRoot(q); }
  }

  function fitTestDock() {
    const dock = $('#dock');
    if (dock.hidden || state.testing || state.testDockHeight != null) return;
    const controls = dock.querySelector('.test-inputs'), body = dock.querySelector('.test-body');
    if (!controls || !body) return;
    // Show the decision and first explanation after a run. Manual sizing wins.
    const header = dock.offsetHeight - body.offsetHeight,
      resultSpace = state.check.result && !state.check.result.running ? Math.min(260, $('#check-result').offsetHeight + 16) : 28,
      height = Math.min(Math.floor(innerHeight * .6), Math.max(164, header + controls.offsetHeight + resultSpace));
    dock.style.height = height + 'px';
    dock.querySelector('.test-resize').setAttribute('aria-valuenow', String(height));
  }

  function mountResult() {
    const r=state.check.result;
    if (r?.trace) mountEngineTrace($('#check-result'),r.trace,canOpenSavedRule,r.engineState??={},()=>{void saveWorkspace().catch(showError);});
  }

  function renderResult() {
    const r = state.check.result;
    if (!r) return '';
    if (r.running) return '<span>Testing saved policies…</span>';
    if (r.error) return `<div class="test-error bad" role="alert">${icon('warning')}<div><strong>Access test failed</strong><p>${esc(r.error)}</p><small>${r.stale?'Inputs changed while this test ran. Run it again.':'For the inputs above. No access decision was returned.'}</small></div></div>`;
    const t = r.trace;
    const outcome = t ? traceOutcome(t) : { tone: 'unknown', label: 'No access decision', glyph: 'warning' };
    const selected = t && r.selectedRule && canOpenSavedRule(r.selectedRule.rid, r.selectedRule.index)
      ? selectedRuleTrace(t, r.selectedRule.rid, r.selectedRule.index) : null;
    const summary = selected ? `<div class="selected-rule-result"><span>Selected saved rule</span><button type="button" class="quiet-button" data-command="reveal-test-trace" data-trace-target="${selected.path ?? ''}">${esc(selected.label)}</button>${selected.failures.slice(0,4).map(f => `<button type="button" class="test-failure-link" data-command="focus-test-failure" data-field="${esc(f.field ?? '')}" data-trace-target="${esc(f.path)}">${esc(f.label)}${f.field && r.request?.action === 'CREATE' ? ' · edit input' : ' · show trace'}</button>`).join('')}</div>` : '';
    return `<div class="result-line" role="status" data-outcome="${r.stale?'unknown':outcome.tone}">${icon(r.stale?'history':outcome.glyph)}<strong>${r.stale?'Previous result: ':''}${esc(outcome.label)}</strong><span>${esc(t?traceRequestLabel(t):'')}</span>${r.stale?'<span class="result-stale">Changed since test \u00b7 run again</span>':''}${renderTestTiming(t?.durationMs,r.requestMs)}</div>${summary}${t?renderEngineTrace(t,canOpenSavedRule,r.engineState??={}):''}<div class="test-diagnostics">${t?'<details class="test-full-trace"><summary>'+icon('down')+icon('list')+'Raw trace tree</summary><div class="test-diagnostic-body">'+renderTrace(t, canOpenSavedRule)+'</div></details>':''}<details><summary>${icon('down')}${icon('json')}Request JSON</summary><div class="test-diagnostic-body"><pre>${esc(JSON.stringify(r.request,null,2))}</pre></div></details></div>`;
  }

  function describeChange(d) {
    if (d.kind === 'Create') return 'New ' + ({
      roles: 'role',
      policies: 'policy',
      scope: d.r.kind === 'RoleAssignment' ? 'assignment' : 'delegation',
      globals: 'global assignment',
      folders: 'folder'
    } [d.key]);
    if (d.kind === 'Delete') return 'Will be removed';
    const keys = Object.keys(d.r).filter(k => JSON.stringify(d.before?.[k]) !== JSON.stringify(d.r[k]));
    return keys.map(k => ({
      content: 'Policy rules',
      name: 'Name',
      enabled: 'Enabled',
      parent: 'Parent',
      field: 'Reference field',
      source: 'Source class',
      kind: 'Direction'
    } [k] ?? k)).join(', ');
  }

  function reviewValue(value) {
    if (value === undefined || value === null || value === '') return '—';
    if (Array.isArray(value) && value.every(v => typeof v !== 'object')) return value.join(', ') || 'None';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    const role = roleByRid(value);
    return role ? role.name : folders.some(f => f.rid === value) ? folderPath(value) : String(value);
  }

  function reviewDeltas(before, after, path = []) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (before && after && typeof before === 'object' && typeof after === 'object' && !((Array.isArray(before) || Array.isArray(after)) && [
        ...Object.values(before), ...Object.values(after)
      ].every(v => typeof v !== 'object'))) {
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => reviewDeltas(before[k], after[k], [...path, k]));
    }
    return [{
      path,
      before,
      after
    }];
  }

  function deltaLabel(path) {
    let result = [];
    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      if (key === 'content' || key === 'Resource' || key === 'Condition') continue;
      if (key === 'Statement') {
        result.push('Statement ' + (Number(path[++i]) + 1));
        continue;
      }
      if (key === 'All' || key === 'Any') {
        if (/^\d+$/.test(path[i + 1] ?? '')) result.push('Condition ' + (Number(path[++i]) + 1));
        else result.push(key);
        continue;
      }
      result.push(({
        Action: 'Actions',
        Subject: 'Who',
        Left: 'Property',
        Right: 'Value',
        Comparison: 'Comparison',
        field: 'Reference',
        parent: 'Parent',
        name: 'Name',
        enabled: 'Enabled'
      } [key] ?? key));
    }
    return result.join(' · ');
  }

  function creationSummary(d) {
    if (d.kind !== 'Create') return '';
    const r = d.r;
    const items = d.key === 'roles' ? [
      ['Business ID', r.id],
      ['Parent', roleByRid(r.parent)?.name ?? 'None']
    ] : d.key === 'policies' ? [
      ['Who', (r.content?.Statement ?? []).map(s => Array.isArray(s.Subject) ? s.Subject.join(', ') : s.Subject).join('; ')],
      ['Actions', actions(r).join(', ') || 'None'],
      ['Enabled', r.enabled ? 'Yes' : 'No']
    ] : d.key === 'folders' ? [
      ['Name', r.name],
      ['Parent folder', folderPath(r.parent) || 'Policy root']
    ] : d.key === 'scope' ? [
      ['Direction', directions[r.kind] ?? 'Field assignment'],
      ...(r.kind?.startsWith('Hierarchical') ? [] : [
        ['Type', r.source || 'Not configured'], ['Field', r.field || 'Not configured']
      ])
    ] : [
      ['Principal', r.mode + ' · ' + (r.subjectId ?? r.subject)]
    ];
    return '<dl class="creation-summary">' + items.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('') + '</dl>';
  }

  function renderReviewBase() {
    const diff = differences();
    $('#editor').innerHTML =
      `<div class="review-page"><div class="review-eyebrow">${icon('changes')}<span>${esc(environment.name)} · all pending edits</span></div><div class="review-title"><h1>Review your edits</h1><span class="review-count">${diff.length}</span></div><p class="review-intro">${diff.length?'Review the changes below, then apply them to this connection.':'Your draft matches the loaded configuration.'}</p>${diff.length?`<div class="review-actions">${button('save','apply-workspace','Apply to '+environment.name,'class="primary"')+button('copy','export','Export draft')}${button('reset','discard-all','Discard all')}</div>`:''}<div class="review-items">${diff.map(d=>{const kind=d.key==='roles'?'role':d.key==='policies'?'policy':null;const target=kind?d.r:model.roles.find(r=>r.rid===d.r.parent)||model.roles.find(r=>descendants(r.rid).some(x=>x.rid===d.r.rid));const keys=d.kind==='Edit'?reviewDeltas(d.before,d.r):[];return `<article class="review-item" tabindex="-1" data-review-rid="${d.r.rid}"><header><span class="operation ${d.kind.toLowerCase()}">${esc(d.kind)}</span><div><strong>${esc(d.r.name||d.r.field||d.r.subjectName||d.r.subjectId||d.r.subject||d.r.id)}</strong><p>${esc(describeChange(d))}${target&&target!==d.r?' · '+esc(target.name):''}</p></div><span class="spacer"></span>${target&&d.kind!=='Delete'?ib('arrow',kind?'open-'+kind:'open-role','Open edited record','data-rid="'+target.rid+'"'):''}${ib('reset','discard-one',identityLinkedChange(d)?'Role ID and references change together. Use Undo or Discard all.':'Discard this edit','data-rid="'+d.r.rid+'"'+(identityLinkedChange(d)?' disabled':''))}</header>${keys.map(k=>`<div class="review-delta"><span>${esc(deltaLabel(k.path))}</span><div class="before"><small>Before</small><pre>${esc(reviewValue(k.before))}</pre></div><div class="after"><small>Draft</small><pre>${esc(reviewValue(k.after))}</pre></div></div>`).join('')}${creationSummary(d)}${!keys.length?`<button class="review-detail" data-command="diff" data-rid="${d.r.rid}">View full definition ${icon('arrow')}</button>`:''}</article>`;}).join('')}</div></div>`;
  }

  let dialogSubmit = null;

  function dialog(title, body, submitLabel = 'OK', onSubmit = null) {
    $('#dialog-content').innerHTML =
      `<div class="dialog-head"><h2>${esc(title)}</h2>${ib('close','close-dialog','Close dialog')}</div><div class="dialog-body">${body}<div id="dialog-error" class="error-line"></div></div><div class="dialog-footer"><button type="button" data-command="close-dialog">${onSubmit?'Cancel':'Close'}</button>${onSubmit?`<button type="submit" class="primary">${esc(submitLabel)}</button>`:''}</div>`;
    dialogSubmit = onSubmit;
    $('#dialog').showModal();
    setTimeout(() => $('dialog input:not([readonly]),dialog textarea')?.focus(), 0);
  }

  async function addAssignment() {
    const r = currentRole();
    if (!r) return;
    const first = Object.keys(fields)[0];
    if (first) await loadSchema(first);
    if (currentRole() !== r) return;
    dialog('Add field assignment',
      `<label>Source class<select id="assignment-source">${Object.keys(fields).map(s=>option(s,s,Object.keys(fields)[0])).join('')}</select></label><label>People field<select id="assignment-field">${(fields[Object.keys(fields)[0]]??[]).map(f=>option(f,f,'')).join('')}</select></label>`,
      'Add', () => {
        const source = $('#assignment-source').value,
          field = $('#assignment-field').value;
        if (!field) throw Error('Choose a people reference property.');
        if (assignments(r).some(a => a.source === source && a.field === field)) throw Error('This field already assigns the role.');
        commit(() => model.scope.push({
          rid: draftRid(),
          id: 'draft_assignment_' + stamp(),
          name: field,
          kind: 'RoleAssignment',
          parent: r.rid,
          source,
          field
        }), 'Added local assignment');
      });
  }

  function addPath(parent) {
    const r = currentRole(),
      as = assignments(r);
    if (!parent) parent = as[0]?.rid;
    if (!parent) {
      status('Add a field assignment first.');
      return;
    }
    const rid = draftRid();
    commit(() => model.scope.push({
      rid,
      id: 'draft_delegation_' + stamp(),
      name: 'New delegation',
      kind: 'InwardsReferenceRoleDelegationRule',
      parent,
      field: '',
      source: ''
    }), 'Added local delegation');
    $(`[data-scope="field"][data-rid="${rid}"]`)?.focus();
  }

  function deleteScope(rid) {
    const r = model.scope.find(x => x.rid === rid),
      children = descendants(rid);
    if (!r) return;
    const fromTree = !!document.activeElement?.closest('#tree,#menu');
    const remove = () => {
      commit(() => {
        const ids = new Set([rid, ...children.map(x => x.rid)]);
        model.scope = model.scope.filter(x => !ids.has(x.rid));
        if (ids.has(state.scopeSelection)) state.scopeSelection = model.scope.some(x => x.rid === r.parent) ? r.parent : null;
      }, 'Removed local ' + (r.kind === 'RoleAssignment' ? 'assignment' : 'branch'));
      if (fromTree) queueMicrotask(() => $(`#tree [data-scope-node="${r.parent}"],#tree [data-open="${r.parent}"]`)?.focus({ preventScroll: true }));
    };
    if (children.length) dialog('Remove ' + (r.kind === 'RoleAssignment' ? 'assignment' : 'branch'),
      `<p>${esc(r.name||r.field)} and ${children.length} child rule${children.length===1?'':'s'} will be removed from the draft.</p>`,
      'Remove', remove);
    else remove();
  }

  function deleteRecord() {
    const r = current();
    if (state.kind === 'role') {
      const used = usedPolicies(r),
        children = model.roles.filter(x => x.parent === r.rid);
      if (used.length || children.length) {
        dialog('Role is still referenced',
          `<p>${used.length} policies and ${children.length} child roles reference ${esc(r.name)}. Change those references before deleting the role.</p>`
          );
        return;
      }
    }
    const kind = state.kind,
      count = kind === 'role' ? descendants(r.rid).length : 0;
    dialog('Delete ' + kind,
      `<p>Remove ${esc(r.name)}${count?' and '+count+' assignment/delegation definitions':''} from the local draft?</p>`, 'Delete',
    () => {
        commit(() => {
          if (kind === 'role') {
            const ids = new Set(descendants(r.rid).map(x => x.rid));
            model.roles = model.roles.filter(x => x.rid !== r.rid);
            model.scope = model.scope.filter(x => !ids.has(x.rid));
            model.globals = model.globals.filter(x => x.parent !== r.rid);
          } else model.policies = model.policies.filter(x => x.rid !== r.rid);
        }, 'Deleted local ' + kind);
      });
  }

  function popup(anchor, items) {
    state.menuReturn = {
      anchor,
      focusKey: anchor.getAttribute ? pickerAnchorKey(anchor) : {
        selector: '',
        index: 0
      }
    };
    const menu = $('#menu');
    menu.innerHTML = items;
    menu.hidden = false;
    positionMenu(anchor.getBoundingClientRect());
    menu.querySelector('button')?.focus();
  }

  function positionMenu(rect) {
    const menu = $('#menu');
    menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.bottom + 3, innerHeight - menu.offsetHeight - 8)) + 'px';
  }

  function conditionMenu(anchor, path) {
    return builderConditionMenu(anchor, path);
  }

  function createOnly() {
    const actions = pbacActions(statement()?.Action);
    return actions.length === 1 && actions[0] === 'Create';
  }

  function insertCondition(path, kind) {
    const scope = createOnly() ? 'new' : 'resource';
    const nodes = {
      Condition: {
        Condition: {
          Left: scope + '.type',
          Comparison: '=',
          Right: ''
        }
      },
      All: {
        All: []
      },
      Any: {
        Any: []
      },
      HasRole: {
        HasRole: {
          Reference: scope + '.',
          Roles: []
        }
      },
      HasAccessTo: {
        HasAccessTo: {
          Reference: scope + '.',
          Roles: [],
          Action: 'Read'
        }
      }
    };
    commit(() => {
      const resource = statement().Resource,
        target = getPath(resource, path);
      if (Array.isArray(target?.All)) target.All.push(clone(nodes[kind]));
      else if (Array.isArray(target?.Any)) target.Any.push(clone(nodes[kind]));
      else if (!path.length) statement().Resource = {
        All: [resource, clone(nodes[kind])]
      };
      else setPath(resource, path, {
        All: [target, clone(nodes[kind])]
      });
    }, 'Added condition');
  }

  function removeCondition(path) {
    commit(() => {
      if (!path.length) {
        statement().Resource = {
          All: []
        };
        return;
      }
      const parent = getPath(statement().Resource, path.slice(0, -1));
      if (Array.isArray(parent)) parent.splice(path.at(-1), 1);
      else setPath(statement().Resource, path, {
        All: []
      });
    }, 'Removed condition');
  }

  function editJSONNode(path, subject = false, literal = false) {
    const value = subject ? statement().Subject : getPath(statement().Resource, path);
    dialog(literal ? 'Edit value' : subject ? 'Edit subjects' : 'Edit expression',
      `${literal?'<p>Use a JSON value: text in quotes, a number, true, false, null, or an array.</p>':''}<textarea id="node-json" spellcheck="false" aria-label="JSON expression">${esc(JSON.stringify(value,null,2))}</textarea>`,
      'Update draft', () => {
        const parsed = JSON.parse($('#node-json').value);
        if (subject && typeof parsed !== 'string' && (!Array.isArray(parsed) || !parsed.every(v => typeof v === 'string'))) throw Error(
          'Use a subject string or an array of subject strings.');
        if (!subject && !literal && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw Error('Use a condition object.');
        if (literal && parsed && typeof parsed === 'object' && (!Array.isArray(parsed) || parsed.some(v => v && typeof v === 'object')))
          throw Error('Use a scalar value or an array of scalar values.');
        commit(() => {
          if (subject) statement().Subject = parsed;
          else if (!path.length) statement().Resource = parsed;
          else setPath(statement().Resource, path, parsed);
        }, 'Updated expression');
      });
  }
  const traceRuns = new Map();
  async function prepareCheck() {
    const q = state.check,
      run = Symbol(),
      key = testKey(),
      selectedRule = !state.testing && state.kind === 'policy' && canOpenSavedRule(state.rid, state.statement)
        ? { rid: state.rid, index: state.statement } : null,
      inputs = () => JSON.stringify([q.mode, q.resource, q.subject, q.action, q.proposed, q.rename, q.updateMode, q.createNumberDrafts]),
      beforeInputs = inputs(),
      beforeModel = JSON.stringify(model);
    if (q.result?.running) return;
    if (focusUnfinishedCreateNumber()) return;
    q.rerunRequired = false;
    traceRuns.set(key, run);
    try {
      const resource = q.action === 'Create' ? createResource(q) : q.resource;
      if (!/^\d+$/.test(resource)) throw Error(q.action === 'Create' ? 'Choose where to create the object.' : 'Choose a saved object.');
      if (q.mode === 'user' && !selectedTestUser(q)) throw Error('Choose a user by name or user ID.');
      const role = q.mode === 'role' ? roleByRid(q.subject) : null;
      if (q.mode === 'role' && (!role || role.rid.startsWith('draft:'))) throw Error('Apply this new role before testing access.');
      const proposed = proposedForTest(q, [...context.objects, ...context.prototypes].find(o => o.rid === q.resource));
      const request = {
        resource_rid: resource,
        subject_rid: q.subject,
        action: q.action.toUpperCase(),
        ...(proposed ? {
          proposed
        } : {})
      };
      q.result = {
        running: true,
        request
      };
      renderDock();
      const requestedAt = window.performance.now();
      const trace = await api({
        operation: 'trace',
        request
      });
      if (traceRuns.get(key) !== run || state.tests.get(key) !== q) return;
      q.result = {
        trace,
        requestMs: window.performance.now() - requestedAt,
        request,
        selectedRule,
        stale: beforeInputs !== inputs() || beforeModel !== JSON.stringify(model)
      };
    } catch (e) {
      if (traceRuns.get(key) !== run || state.tests.get(key) !== q) return;
      q.result = { error: e.message, stale: beforeInputs !== inputs() };
    } finally {
      if (traceRuns.get(key) === run) traceRuns.delete(key);
    }
    if (testKey() === key) {
      renderDock();
      if (!$('#dock').hidden && beforeInputs === inputs()) {
        $('#check-result .result-line, #check-result .bad')?.scrollIntoView({ block: 'nearest' });
      }
    }
    saveWorkspace();
  }

  function exportDraft() {
    const doc = {
      format: 'companion-access-draft',
      environment: environment.name,
      sourceDate: environment.capturedOn,
      notApplied: true,
      changes: differences().map(d => ({
        operation: d.kind,
        collection: d.key,
        before: d.before ?? null,
        after: d.kind === 'Delete' ? null : d.r
      }))
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], {
      type: 'application/json'
    }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'companion-access-draft.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('Exported local draft');
  }

  function showDiff(rid) {
    const d = differences().find(x => x.r.rid === rid);
    if (!d) return;
    dialog(d.kind + ' ' + (d.r.name || d.r.id),
      `<label>Before<textarea readonly>${esc(JSON.stringify(d.before??null,null,2))}</textarea></label><label>Draft<textarea readonly>${esc(JSON.stringify(d.kind==='Delete'?null:d.r,null,2))}</textarea></label>`
      );
  }

  function showHelp() {
    dialog('Companion · Access',
      `<div class="help-grid"><span>New role</span><kbd>Ctrl+N</kbd><span>New policy</span><kbd>Ctrl+Shift+N</kbd><span>Find a record</span><kbd>Ctrl+K</kbd><span>Show explorer</span><kbd>Ctrl+B</kbd><span>Test the current record</span><kbd>Ctrl+Enter</kbd><span>Review all pending edits</span><kbd>Ctrl+S</kbd><span>Undo / redo</span><kbd>Ctrl+Z / Ctrl+Shift+Z</kbd><span>Move a focused role</span><kbd>Space · ↑ ↓ · Enter</kbd><span>Save / cancel ID edit</span><kbd>Enter / Esc</kbd><span>Update JSON draft</span><kbd>Ctrl+S in JSON</kbd><span>Close access test</span><kbd>Esc</kbd></div><p>Drag a role onto its new parent, or onto the Roles heading for top level. Search policy names, IDs, role references, or rule text. Right-click a tree item for record actions; Shift+right-click keeps the browser menu. Text fields always keep their normal menu.</p><p>Drafts are saved on this browser. Apply writes the reviewed edits to the selected BMP connection. Access tests use saved configuration.</p>`
      );
  }

  async function command(cmd, el) {
    if (cmd === 'matrix') { showMatrix(); return; }
    if (cmd === 'performance') { showPerformance(); return; }
    if (cmd === 'close-performance') { performance.stop();state.performanceOpen=false;if(state.performanceShowing){state.performanceShowing=false;state.empty=true;}render();return; }
    if (cmd === 'profile-check') { const seed=performanceSeed(state.check);performance.stop();showPerformance();void performance.run(false,seed);return; }
    if (cmd === 'close-matrix') { state.matrixOpen=false; if(state.matrixShowing){state.matrixShowing=false;state.empty=true;} render(); return; }
    if (cmd === 'matrix-test') { openMatrixTest(state.matrixTest); return; }
    if (cmd === 'close-matrix-test') { if(state.matrixTesting){state.testOpen.delete(testKey());showMatrix();} state.matrixTest=null;renderTabs();return; }
    if (cmd === 'return-to-test' && testReturn) {
      const target = testReturn; testReturn = null;
      state.testOpen.add(target.key); restoreRoute(target.route);
      return;
    }
    if (cmd === 'navigate-back' || cmd === 'navigate-forward') { window.history.go(cmd === 'navigate-back' ? -1 : 1); return; }
    if (cmd === 'tree-more') { state.treeLimits[el.dataset.kind] += 300; renderTree(); return; }
    if (cmd === 'members-more') { state.membershipLimit = (state.membershipLimit ?? 100) + 100; renderEditor(); return; }
    if (applying) return;
    if (cmd === 'close-object-test') { if (state.testing) closeAccessTest(); else { state.objectTest = null; renderTabs(); } return; }
    if (cmd === 'open-test') { enter({ kind: 'test', object: state.objectTest }); return; }
    if (cmd === 'open-trace-policy') {
      state.check.viewScroll = $('#dock .test-body')?.scrollTop ?? 0;
      testReturn = { route: viewRoute(), key: testKey() };
      enter({ kind: 'policy', rid: el.dataset.rid, statement: Number(el.dataset.statement) }); return;
    }
    if (cmd === 'apply-workspace') return applyWorkspace();
    if (cmd === 'reload-workspace') return reloadWorkspace();
    if (await dropdownCommand(cmd, el)) return;
    if (await auditCommand(cmd, el)) return;
    if (await workspaceCommand(cmd, el)) return;
    if (await schemaCommand(cmd, el)) return;
    if (await builderCommand(cmd, el)) return;
    if (await polishCommand(cmd, el)) return;
    if (cmd === 'toggle-section') {
      const key = el.dataset.section;
      collapsedSections.has(key) ? collapsedSections.delete(key) : collapsedSections.add(key);
      el.closest('.section').classList.toggle('collapsed', collapsedSections.has(key));
      el.setAttribute('aria-expanded', String(!collapsedSections.has(key)));
      return;
    }
    if (cmd === 'new-role' || cmd === 'new-policy') return createRecord(cmd === 'new-role' ? 'role' : 'policy');
    if (cmd === 'new-policy-for-role') return createRecord('policy', false, true);
    if (cmd === 'duplicate' && !current()) return;
    if (cmd === 'delete' && !current()) return;
    if (cmd === 'duplicate') return createRecord(state.kind, true);
    if (cmd === 'delete') return deleteRecord();

    if (cmd === 'explorer') {
      document.body.classList.toggle('no-explorer');
    }
    if (cmd === 'details') $('#business-id')?.focus();
    if (cmd === 'add-assignment') await addAssignment();
    if (cmd === 'add-path') addPath(el.dataset.parent);
    if (cmd === 'delete-scope') deleteScope(el.dataset.rid);
    if (cmd === 'delete-global') commit(() => model.globals = model.globals.filter(g => g.rid !== el.dataset.rid),
      'Removed global assignment');
    if (cmd === 'add-global') {
      const role = current();
      dialog('Add global assignment',
        `<label>Assign to<select id="global-mode"><option>User</option><option>Group</option></select></label><div id="global-user-field"><input id="global-user-id" type="hidden">${userPickerButton(null,'choose-assignment-user')}</div><div id="global-group-field" hidden><input id="global-rid" type="hidden"><button type="button" class="object-picker picker-trigger" data-command="choose-assignment-group">Choose group…</button></div><p>This role will apply globally for the selected principal.</p>`,
        'Add', () => {
          const mode = $('#global-mode').value,
            user = mode === 'User' ? resolveUser(userDirectory.users, $('#global-user-id').value) : [...snapshot.groups, ...context.groups].find(g => g.rid ===
              $('#global-rid').value);
          if (!user) throw Error('Choose a ' + mode.toLowerCase() + ' by name or ID.');
          if (model.globals.some(g => g.subject === user.rid && g.parent === role.rid)) throw Error(
            'This principal already has this role.');
          collapsedSections.delete('role:' + role.rid + ':Global assignments');
          commit(() => model.globals.push({
            rid: draftRid(),
            id: 'draft_global_' + stamp(),
            parent: role.rid,
            mode,
            subject: user?.rid ?? $('#global-rid').value,
            ...(user ? {
              subjectId: user.id,
              subjectName: user.name
            } : {})
          }), 'Added global assignment');
        });
      mountAssignmentPrincipal();
      $('#dialog [data-command=choose-assignment-user]')?.focus();
    }
    if (cmd === 'open-role' || cmd === 'open-policy') openRecord(cmd === 'open-role' ? 'role' : 'policy', el.dataset.rid);
    if (cmd === 'close-tab') {
      state.tabs = state.tabs.filter(t => t.rid !== el.dataset.rid);
      if (state.rid === el.dataset.rid && state.tabs.length) {
        state.kind = state.tabs.at(-1).kind;
        state.rid = state.tabs.at(-1).rid;
      }
      if (!state.tabs.length) {
        state.empty = true;
        state.rid = '';
      }
      render();
    }
    if (cmd === 'check') {
      if (!current() || state.reviewing) return;
      const key = testKey();
      state.testOpen.has(key) ? state.testOpen.delete(key) : state.testOpen.add(key);
      renderEditor();
      if (state.testOpen.has(key)) $('#dock').scrollIntoView({
        block: 'nearest'
      });
    }
    if (cmd === 'review') {
      state.historyShowing = false;
      state.reviewOpen = true;
      state.reviewing = true;
      render();
    }
    if (cmd === 'close-review') {
      state.reviewing = false;
      state.reviewOpen = false;
      render();
    }
    if (cmd === 'close-test') {
      closeAccessTest();
    }

    if (cmd === 'close-dialog') $('#dialog').close();
    if (cmd === 'prepare-check') await prepareCheck();

    if (cmd === 'diff') showDiff(el.dataset.rid);
    if (cmd === 'discard-one') discardOne(el.dataset.rid);
    if (cmd === 'export') exportDraft();
    if (cmd === 'discard-all') dialog('Discard all local changes', '<p>Return to the captured configuration? You can undo this.</p>',
      'Discard', () => commit(() => model = clone(baseline), 'All local changes discarded'));
    if (cmd === 'help') showHelp();
    if (cmd === 'about') return connectionInfo();
    if (cmd === 'record-more') recordMenu(el, state.kind, state.rid, false);

    if (cmd === 'add-statement' || cmd === 'copy-statement') commit(() => {
      const value = cmd === 'copy-statement' ? clone(statement()) : {
        Subject: '*',
        Effect: 'Allow',
        Action: [],
        Resource: {
          All: []
        }
      };
      current().content.Statement.push(value);
      state.statement = current().content.Statement.length - 1;
    }, 'Added statement');
    if (cmd === 'delete-statement') commit(() => {
      clearPolicyTests();
      current().content.Statement.splice(state.statement, 1);
      state.statement = Math.max(0, state.statement - 1);
    }, 'Removed statement');
    if (cmd === 'add-condition') conditionMenu(el, JSON.parse(el.dataset.path ?? '[]'));
    if (cmd === 'edit-condition-value') editJSONNode([...JSON.parse(el.dataset.path), 'Condition', 'Right'], false, true);
    if (cmd === 'insert-condition') insertCondition(JSON.parse(el.dataset.path), el.dataset.node);
    if (cmd === 'remove-condition') removeCondition(JSON.parse(el.dataset.path));
    if (cmd === 'edit-node') editJSONNode(JSON.parse(el.dataset.path));
    if (cmd === 'edit-subject') editJSONNode([], true);
    if (cmd === 'json-outline') {
      jsonOutlineVisible = !jsonOutlineVisible;
      el.setAttribute('aria-pressed',String(jsonOutlineVisible));el.setAttribute('aria-expanded',String(jsonOutlineVisible));
      el.title = jsonOutlineVisible ? 'Hide outline' : 'Show outline';
      jsonEditor?.showOutline(jsonOutlineVisible);
      const outline = $('#policy-json-outline');if(outline)outline.hidden=!jsonOutlineVisible;
    }
    if (cmd === 'json-collapse-rules') jsonEditor?.foldRules();
    if (cmd === 'json-focus-rule' && !jsonEditor?.foldRules(true)) status('Place the cursor inside the rule you want to focus.');
    if (cmd === 'json-expand-all') jsonEditor?.expandAll();
    if (['json-collapse-rules','json-focus-rule','json-expand-all'].includes(cmd)) jsonEditor?.focus();
    if (cmd === 'json-reveal-issue') jsonEditor?.revealIssue(Number(el.dataset.issue));
    if (cmd === 'json-fix-issue') jsonEditor?.fixIssue(Number(el.dataset.issue),Number(el.dataset.fix));
    if (cmd === 'apply-json') {
      try {
        const parsed = JSON.parse(jsonEditor.value()),
          issues = policyDiagnostics(parsed);
        if (issues.some(i => i.severity === 'error')) throw Error(issues.filter(i => i.severity === 'error').map(i => i.message).join(
          ' '));
        commit(() => {
          invalidatePolicyTests();
          current().content = parsed;
          delete current().invalidContent;
        }, 'Policy JSON updated');
        state.raw.delete(current().rid);
        render();
      } catch (e) {
        $('#json-diagnostics').textContent = e.message;
      }
    }

  }

  document.addEventListener('click', e => {
    const el = e.target.closest('button,[data-collapse]');
    if (!el) {
      if (!e.target.closest('#menu')) $('#menu').hidden = true;
      return;
    }
    if (el.dataset.collapse) {
      e.stopPropagation();
      const closed = state.search ? state.searchClosed : state.closed;
      closed.has(el.dataset.collapse) ? closed.delete(el.dataset.collapse) : closed.add(el.dataset.collapse);
      renderTree();
      return;
    }
    if (el.dataset.group) {
      state.closed.has(el.dataset.group) ? state.closed.delete(el.dataset.group) : state.closed.add(el.dataset.group);
      renderTree();
      return;
    }
    if (el.dataset.open) {
      openRecord(el.dataset.kind, el.dataset.open);
      if (el.dataset.searchContent === 'true') {
        state.view = 'json';
        renderEditor();
        findInJSON(state.search);
      }
      return;
    }
    if (el.dataset.view) {
      closePicker();
      if (el.dataset.view === 'rules' && state.raw.has(state.rid)) {
        try {
          const parsed = JSON.parse(state.raw.get(state.rid));
          if (policyDiagnostics(parsed).some(i => i.severity === 'error')) throw Error();
          commit(() => {
            invalidatePolicyTests();
            current().content = parsed;
            delete current().invalidContent;
          }, 'JSON draft updated');
          state.raw.delete(state.rid);
          refreshDraftChrome();
        } catch {
          status('Fix or reset JSON before opening Rules.');
          jsonEditor?.focus();
          return;
        }
      }
      state.view = el.dataset.view;
      saveEditorPreference(state.view);
      renderEditor();
      return;
    }
    if (el.dataset.command) {
      if (!el.closest('#menu') || !['more', 'check-examples', 'add-condition'].includes(el.dataset.command)) $('#menu').hidden = true;
      const failureContext = errorContext();
      Promise.resolve(command(el.dataset.command, el)).catch(error => showError(error, failureContext));
    }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'statement-index') {
      state.statement = Number(el.value);
      renderEditor();
      return;
    }
    if (el.id === 'assignment-source') {
      $('#assignment-field').innerHTML = fields[el.value].map(f => option(f, f, '')).join('');
      return;
    }
    if (el.dataset.record) {
      const key = el.dataset.record,
        v = el.type === 'checkbox' ? el.checked : el.value;
      if (current()[key] === v) return;
      commit(() => current()[key] = v, 'Updated ' + key);
      return;
    }
    if (el.dataset.scope) {
      const r = model.scope.find(x => x.rid === el.dataset.rid),
        key = el.dataset.scope,
        v = el.value;
      commit(() => {
        if (key === 'field' && r.kind !== 'RoleAssignment') Object.assign(r, editReferenceText(r, v));
        else r[key] = v;
        if (key === 'source') r.field = fields[v]?.[0] ?? '';
        if (key === 'field' || key === 'source') r.referenceConfig = '';
        if (key === 'kind' && v.startsWith('Hierarchical')) {
          r.field = '';
          r.source = '';
          r.referenceConfig = '';
        }
      }, 'Updated ' + (r.kind === 'RoleAssignment' ? 'assignment' : 'delegation'));
      return;
    }
    if (el.dataset.quickAction) {
      const p = model.policies.find(x => x.rid === el.dataset.rid);
      commit(() => {
        p.content.Statement[0].Action = togglePBACAction(p.content.Statement[0].Action, el.dataset.quickAction, el.checked);
      }, 'Updated policy action');
      return;
    }
    if (el.dataset.action) {
      const checked = el.checked,
        a = el.dataset.action;
      commit(() => {
        const s = statement();
        s.Action = togglePBACAction(s.Action, a, checked);
      }, 'Updated statement action');
      return;
    }
    if (el.dataset.statement) {
      const v = el.value;
      commit(() => statement().Subject = el.dataset.statement === 'SubjectTokens' ? v.split(',').map(x => x.trim()).filter(Boolean) :
        v === '*' ? '*' : [v], 'Updated policy subjects');
      return;
    }
    if (el.dataset.grouping) {
      const path = JSON.parse(el.dataset.grouping),
        type = el.value;
      commit(() => {
        const node = getPath(statement().Resource, path),
          old = Array.isArray(node.All) ? 'All' : 'Any',
          value = node[old];
        delete node[old];
        node[type] = value;
      }, 'Changed condition grouping');
      return;
    }
    if (el.dataset.condition) {
      const path = JSON.parse(el.dataset.condition),
        value = el.dataset.array === 'true' ? el.value.split(',').map(v => v.trim()).filter(Boolean) : el.value;
      commit(() => {
        if (path.at(-2) === 'HasAccessTo' && path.at(-1) === 'Action' && value === '')
          delete getPath(statement().Resource, path.slice(0, -1)).Action;
        else setPath(statement().Resource, path, value);
      }, 'Updated condition');
      return;
    }
    if (el.dataset.check) {
      state.check[el.dataset.check] = el.value;
      if (el.dataset.check === 'mode') state.check.subject = el.value === 'role' ? (currentRole()?.rid ?? model.roles[0].rid) : '';
      staleTests();
      renderDock();
      return;
    }
  });
  let editingElement = null, treeInputTimer;
  document.addEventListener('focusout', e => {
    if (editingElement === e.target) {
      updateInputHistory();
      editingElement = null;
      inputHistory = null;
    }
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('input,textarea') && (el.dataset.record === 'name' || el.dataset.scope === 'field' || el.dataset.condition || el
        .dataset.statement)) {
      if (editingElement !== el) {
        beginInputHistory(el);
        editingElement = el;
      }
      if (el.dataset.record) {
        current().name = el.value;
      }
      if (el.dataset.statement) statement().Subject = el.value.split(',').map(v => v.trim()).filter(Boolean);
      if (el.dataset.scope) {
        const r = model.scope.find(r => r.rid === el.dataset.rid);
        Object.assign(r, editReferenceText(r, el.value));
        if (r.rid.startsWith('draft:')) r.name = directions[r.kind] + ' · ' + el.value;
      }
      if (el.dataset.condition) setPath(statement().Resource, JSON.parse(el.dataset.condition), el.dataset.array === 'true' ? el.value
        .split(',').map(v => v.trim()).filter(Boolean) : el.value);
      updateInputHistory();
      staleTests();
      renderToolbar();
      clearTimeout(treeInputTimer); treeInputTimer = setTimeout(renderTree, 120);
      renderTabs();
      status('Local changes');
    }
    if (el.id === 'search') {
      state.search = el.value;
      renderTree();
    }
    if (el.id === 'new-name' && !$('#new-id').dataset.manual) {
      $('#new-id').value = suggestedBusinessId(el.value, el.dataset.recordKind ?? 'record');
    }
    if (el.id === 'new-id') el.dataset.manual = 'true';
    if (el.id === 'policy-json') state.raw.set(current().rid, el.value);
    if (el.dataset.check) {
      state.check[el.dataset.check] = el.value;
      if (state.check.result) {
        state.check.result.stale = true;
        if ($('#check-result')) { $('#check-result').innerHTML = renderResult(); mountResult(); }
      }
      if (state.check.action === 'Create' && el.dataset.check === 'proposed') {
        const run = $('#dock [data-command="prepare-check"]');
        if (run) run.disabled = !createReady(state.check) || !!state.check.result?.running || !(state.check.mode === 'role' ? roleByRid(state.check.subject) : selectedTestUser());
        try {
          const values = readCreateValues(el.value);
          if (typeof values.parent_rid === 'string') state.check.resource = values.parent_rid;
          $('#dock [data-command="create-type"] strong').textContent = values.type || 'Choose type…';
          $('#dock [data-command="create-destination"] strong').textContent = state.check.resource ? testObjectLabel(state.check.resource) : 'Choose destination…';
        } catch { /* Retain the last readable controls while JSON is unfinished. */ }
      }
    }
    if (el.hasAttribute('data-create-value')) {
      const q = state.check, field = el.dataset.createValue;
      if (el.dataset.valueKind === 'number') setCreateNumber(q, field, el.value);
      else setCreateValue(q, field, 'properties', el.value);
      const invalid = q.createNumberDrafts?.[field] !== undefined,
        supplied = invalid || createFieldValue(readCreateValues(q.proposed), field).supplied;
      el.setAttribute('aria-invalid', String(invalid));
      el.nextElementSibling.hidden = !invalid;
      $('#dock [data-command="prepare-check"]').disabled = !createReady(q) || !!q.result?.running || !(q.mode === 'role' ? roleByRid(q.subject) : selectedTestUser(q));
      markTestChanged(q);
      const omit = el.closest('.create-value-row').querySelector('[data-command="create-omit"]');
      omit.disabled = !supplied && !q.omittedValues?.[field];
      omit.title = (supplied ? 'Omit ' : 'Restore ') + el.getAttribute('aria-label');
      omit.setAttribute('aria-label', omit.title);
      omit.innerHTML = icon(supplied ? 'close' : 'undo');
      const control = el.closest('.create-value-control');
      control.querySelector('.create-origin')?.remove();
      control.insertAdjacentHTML('beforeend', renderDefaultOrigin(q,field,icon));
    }
  });
  $('#dialog-form').addEventListener('submit', e => {
    e.preventDefault();
    const submit = e.submitter;
    if (submit) submit.disabled = true;
    Promise.resolve().then(() => dialogSubmit?.()).then(() => $('#dialog').close()).catch(error => $('#dialog-error').textContent =
      error.message).finally(() => {
      if (submit) submit.disabled = false;
    });
  });
  function closeAccessTest() {
    if (!state.testOpen.has(testKey())) return;
    state.testOpen.delete(testKey());
    if (state.matrixTesting) { showMatrix(); return; }
    if (state.testing) {
      state.testing = false; state.objectTest = null;
      const last = state.tabs.at(-1);
      if (last) openRecord(last.kind, last.rid);
      else { render(); $('#search').focus({ preventScroll: true }); }
      return;
    }
    renderEditor();
    $('.test-trigger')?.focus();
  }

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || state.picker || state.drag) return;
    const typing = e.target.matches('input,textarea,[contenteditable]');
    if (e.key === 'Escape') {
      if (!$('#menu').hidden) {
        $('#menu').hidden = true;
        return;
      }
      if ($('#dialog').open) return;
      if (state.historyShowing) {
        e.preventDefault();
        void workspaceCommand('history-close', $('.history-actions [data-command="history"]'));
        return;
      }
      if (state.testOpen.has(testKey())) {
        e.preventDefault();
        closeAccessTest();
      }
      return;
    }
    if (e.key === 'F1') {
      e.preventDefault();
      showHelp();
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || $('#dialog').open) return;
    const key = e.key.toLowerCase();
    if (key === 'k') {
      e.preventDefault();
      document.body.classList.remove('no-explorer');
      $('#search').focus();
      $('#search').select();
    } else if (key === 'b') {
      e.preventDefault();
      document.body.classList.toggle('no-explorer');
    } else if (key === 'n') {
      e.preventDefault();
      createRecord(e.shiftKey ? 'policy' : 'role');
    } else if (key === 's') {
      e.preventDefault();
      state.historyShowing = false;
      state.reviewOpen = true;
      state.reviewing = true;
      render();
    } else if (key === 'enter') {
      e.preventDefault();
      if (state.matrixShowing) { if (state.matrix.selected) openMatrixTest(state.matrix.selected); }
      else if (state.testOpen.has(testKey()) && !$('#dock').hidden) void prepareCheck();
      else { state.testOpen.add(testKey()); renderEditor(); }
    } else if (key === 'z' && !typing && !e.target.closest('.cm-editor')) {
      e.preventDefault();
      command(e.shiftKey ? 'redo' : 'undo', {});
    }
  });
  $('#tree').addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const tree = e.target.closest('[role="tree"]');
    if (!tree) return;
    e.preventDefault();
    if (state.drag) return;
    const rows = [...tree.querySelectorAll('.tree-row')],
      i = rows.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key ===
      'ArrowDown' ? 1 : -1)));
    rows[next]?.focus();
  });
  const splitter = $('.splitter');
  splitter.addEventListener('pointerdown', e => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
  });
  splitter.addEventListener('pointermove', e => {
    if (splitter.hasPointerCapture(e.pointerId)) document.documentElement.style.setProperty('--tree-width', Math.max(170, Math.min(360,
      e.clientX)) + 'px');
  });
  splitter.addEventListener('pointerup', e => {
    if (splitter.hasPointerCapture(e.pointerId)) splitter.releasePointerCapture(e.pointerId);
  });
  splitter.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const width = $('.explorer').offsetWidth;
      document.documentElement.style.setProperty('--tree-width', Math.max(170, Math.min(360, width + (e.key === 'ArrowRight' ? 10 : -
        10))) + 'px');
    }
  });
  if (innerWidth <= 620) document.body.classList.add('no-explorer');

  const encode = p => esc(JSON.stringify(p));
  const getPath = (o, p) => p.reduce((v, k) => v?.[k], o);

  function setPath(o, p, v) {
    const key = p.at(-1),
      parent = getPath(o, p.slice(0, -1));
    parent[key] = v;
  }

  function statement() {
    return current().content?.Statement?.[state.statement];
  }

  function condition(node, path) {
    return builderCondition(node, path);
  }

  function unknown(node, path) {
    return `<div class="unknown-rule">${icon('json')}<code>${esc(Object.keys(node??{}).join(', ')||'Expression')}</code><span class="spacer"></span><button data-command="edit-node" data-path='${encode(path)}'>Edit JSON</button>${ib('trash','remove-condition','Remove condition',`data-path='${encode(path)}'`)}</div>`;
  }

  function closePicker(restore = true) {
    const picker = state.picker;
    if (!picker) return;
    picker.search?.cancel();
    state.picker = null;
    $('#picker')?.remove();
    picker.anchor?.setAttribute('aria-expanded', 'false');
    if (restore) {
      if (picker.anchor?.isConnected) picker.anchor.focus();
      else restorePickerFocus(picker);
    }
  }

  function showPicker(anchor, options) {
    closePicker(false);
    state.picker = {
      anchor,
      focusKey: pickerAnchorKey(anchor),
      query: '',
      type: '',
      index: 0,
      ...options
    };
    anchor.setAttribute('aria-haspopup', 'dialog');
    anchor.setAttribute('aria-expanded', 'true');
    const host = $('#dialog').open ? $('#dialog') : document.body;
    const div = document.createElement('div');
    div.id = 'picker';
    div.className = 'picker-popover' + (options.mode === 'property' ? ' property-picker' : options.mode === 'operator' ? ' operator-picker' : options.reference || options.referenceClass ? ' reference-picker' : '');
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-label', options.title);
    host.append(div);
    div.innerHTML =
      `<div class="picker-title"><strong>${esc(options.title)}</strong>${ib('close','close-picker','Close chooser')}</div><div class="picker-search">${icon('search')}<input id="picker-query" role="combobox" aria-expanded="true" aria-controls="picker-results" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${options.kind==='object'?'Search objects by name or ID…':'Search name or ID…'}" aria-label="Search ${options.kind==='object'?'objects':options.kind==='folder'?'folders':'roles'}"><button type="button" class="picker-clear" data-command="picker-clear-query" aria-label="Clear chooser search" hidden>${icon('close')}</button></div><div id="picker-types"></div><div id="picker-results" role="listbox" aria-label="Choices" aria-multiselectable="${!!options.multi}"></div><div id="picker-footer" class="picker-footer"></div>`;
    const rect = anchor.getBoundingClientRect(),
      width = Math.min(options.width ?? (options.kind === 'object' ? 490 : 430), innerWidth - 20);
    let top = rect.bottom + 5;
    if (innerHeight - top - 10 < 240) top = Math.max(10, rect.top - Math.min(440, innerHeight - 20) - 5);
    div.style.width = width + 'px';
    div.style.left = Math.max(10, Math.min(rect.left, innerWidth - width - 10)) + 'px';
    div.style.top = top + 'px';
    div.style.maxHeight = Math.min(440, innerHeight - top - 10) + 'px';
    state.picker.entries = pickerEntries();
    const selected = state.picker.entries.findIndex(r => r.rid === options.selected);
    state.picker.index = Math.max(0, selected);
    renderPicker();
    scrollPickerChoice();
    $('#picker-query').focus();
  }

  function pickerEntries() {
    const p = state.picker;
    if (!p) return [];
    if (p.kind === 'schema') return schemaEntries(p);
    if (p.kind === 'object') {
      const list = p.prototypes ? context.prototypes : context.objects;
      const matches = list.filter(r => (!p.type || r.type === p.type) && objectMatches(r, p.query));
      return [...matches].sort((a, b) => {
        const q = p.query.trim().toLowerCase(),
          rank = r => [r.name, r.id, r.rid].some(v => String(v ?? '').toLowerCase() === q) ? 0 : r.name.toLowerCase().startsWith(q) ?
          1 : 2;
        if (q && rank(a) !== rank(b)) return rank(a) - rank(b);
        const recentA = state.recentObjects.indexOf(a.rid),
          recentB = state.recentObjects.indexOf(b.rid);
        const preferred = r => p.containerFor && r.type === p.containerFor + 'Root';
        return Number(preferred(b)) - Number(preferred(a)) || (recentB < 0 ? -999 : -recentB) - (recentA < 0 ? -999 : -recentA) || a.name.localeCompare(b.name);
      }).map(r => ({
        ...r,
        label: r.name,
        secondary: [r.id, r.type, r.path !== r.name ? r.path : ''].filter(Boolean).join(' · '),
        depth: 0
      }));
    }
    const records = p.kind === 'folder' ? folders : model.roles,
      ordered = [];

    function visit(r, depth) {
      ordered.push({
        ...r,
        label: r.name,
        secondary: p.query ? [r.id, ancestry(records, r.rid).slice(0, -1).map(r => r.name).join(' / ')].filter(Boolean).join(' · ') : r
          .id ?? '',
        depth,
        reason: p.invalid?.(r.rid) ?? ''
      });
      records.filter(x => x.parent === r.rid).forEach(x => visit(x, depth + 1));
    }
    records.filter(r => !records.some(x => x.rid === r.parent)).forEach(r => visit(r, 0));
    let results = ordered.filter(r => queryMatches(p.query, r.name, r.id, r.rid, ancestry(records, r.rid).map(x => x.name).join(' ')));
    if (p.query) {
      const q = p.query.trim().toLowerCase(),
        rank = r => r.name.toLowerCase() === q ? 0 : r.name.toLowerCase().startsWith(q) ? 1 : queryMatches(q, r.name) ? 2 : 3;
      results.sort((a, b) => rank(a) - rank(b));
    }
    const noneLabel = p.noneLabel ?? 'Top level';
    return [...(p.allowNone && queryMatches(p.query, noneLabel) ? [{
      rid: '',
      label: noneLabel,
      secondary: '',
      depth: 0,
      reason: p.invalid?.('') ?? ''
    }] : []), ...results];
  }

  const typeLabel = type => type;

  function renderPicker() {
    const p = state.picker;
    if (!p) return;
    if (p.objectTypeBrowse) { renderObjectTypes(p); return; }
    if (p.kind === 'object') scheduleObjectSearch(p);
    if (p.principalKind) schedulePrincipalSearch(p);
    if (p.listProperty?.listSet?.partial) scheduleListSearch(p);
    if (p.kind === 'schema' && p.mode === 'property' && p.browseType) {
      const type = p.browseType;
      loadSchema(type).then(() => {
        if (state.picker === p && p.browseType === type && schemaLoaded.has(type) && p.loadedType !== type) {
          p.loadedType = type;
          renderPicker();
        }
      }).catch(error => { if (state.picker === p && p.browseType === type) showError(error); });
    }
    p.entries = p.kind === 'object' && p.loadError ? [] : pickerEntries();
    $('#picker .picker-clear').hidden = !p.query;
    if (p.kind === 'schema') {
      renderSchemaPicker(p);
      positionPicker();
      return;
    }
    const shown = p.entries.slice(0, 100);
    const selectedObject = rid => p.multi ? p.selectedValues.includes(rid) : rid === p.selected;
    p.index = Math.min(Math.max(-1, p.index), shown.length - 1);
    if (p.index < 0 || shown[p.index]?.reason) p.index = nextChoice(shown, p.index, 'ArrowDown');
    if (p.kind === 'object') {
      const filter = $('#picker-types');
      // Results may arrive while the filter has keyboard focus. Keep the control
      // itself mounted unless its selected type changed.
      if (filter.querySelector('[data-command="picker-browse-types"]')?.dataset.value !== p.type) filter.innerHTML =
        `<div class="object-type-filter"><span>Type</span><button type="button" data-command="picker-browse-types" data-value="${esc(p.type)}" aria-label="Filter by object type: ${esc(p.type ? typeLabel(p.type) : 'All types')}" title="Filter by type · Alt+↓">${icon('type')}<span>${esc(p.type ? typeLabel(p.type) : 'All types')}</span>${icon('down')}</button>${p.type ? '<button type="button" class="icon-button" data-command="picker-type" data-value="" aria-label="Clear type filter" title="Clear type filter">'+icon('close')+'</button>' : ''}</div>${!p.type ? '<div class="object-type-suggestions" aria-label="Common object types">'+['Organisation','CeRiskAssessment','CeControlMeasure'].filter(type=>Object.hasOwn(schemaData.classes,type)).map(type=>'<button type="button" data-command="picker-type" data-value="'+type+'">'+esc(typeLabel(type))+'</button>').join('')+'</div>':''}`;
    }
    $('#picker-results').innerHTML = shown.map((r, i) =>
      `<button type="button" class="picker-option ${i===p.index?'focused':''} ${selectedObject(r.rid)?'chosen':''}" id="pick-${i}" role="option" tabindex="-1" aria-selected="${selectedObject(r.rid)}" aria-disabled="${!!r.reason}" style="--depth:${p.query?0:r.depth}" data-command="picker-select" data-index="${i}" title="${esc(r.reason||r.id||r.rid)}">${p.kind==='role'&&r.rid?roleMark(ancestry(model.roles,r.rid).length):icon(p.kind==='object'?'object':p.kind==='folder'?'folder':'role')}<span><strong>${esc(r.label)}</strong>${r.reason||r.secondary?'<small>'+esc(r.reason||r.secondary)+'</small>':''}</span>${selectedObject(r.rid)?icon('valid'):''}</button>`
      ).join('') || (p.loadError ? `<div class="picker-empty" role="alert">${esc(p.loadError)}<button type="button" data-command="picker-retry-search">Retry search</button></div>` : `<div class="picker-empty">${p.loading ? 'Searching…' : p.kind === 'object' ? 'No objects match this search.' : 'No matches. Try another name or ID.'}${!p.loading && p.type ? '<button type="button" data-command="picker-type" data-value="">Search all types</button>' : ''}</div>`);
    $('#picker-query').setAttribute('aria-activedescendant', p.index >= 0 ? 'pick-' + p.index : '');
    $('#picker-footer').innerHTML =
      `<span role="status">${p.loading?'Searching…':p.loadError?'Search failed':p.entries.length+' '+(p.kind==='object'?(p.entries.length===1?'object':'objects'):(p.entries.length===1?'match':'matches'))+(p.entries.length>100?' · showing first 100':'')}</span><span class="spacer"></span>${p.multi?`<button type="button" class="primary" data-command="schema-apply">Apply ${p.selectedValues.length}<kbd>Ctrl ↵</kbd></button>`:p.resultLimitReached?'<span>Refine your search for more matches</span>':'<span>↑ ↓ navigate · Enter select</span>'}`;
    positionPicker();
  }

  // Browse types inside the same chooser. Keep object query, position and selection
  // separate so dismissing a filter never discards work or starts a BMP search.
  function browseObjectTypes() {
    const p = state.picker;
    if (p?.kind !== 'object' || p.objectTypeBrowse) return;
    p.objectTypeBrowse = { query: p.query, index: p.index, scroll: $('#picker-results').scrollTop };
    if (p.loading) {
      p.search?.cancel(); p.loading = false;
    }
    p.query = ''; p.index = -1;
    $('#picker-query').value = '';
    renderPicker(); scrollPickerChoice(); $('#picker-query').focus();
  }

  function returnToObjects(type) {
    const p = state.picker, previous = p.objectTypeBrowse;
    if (!previous) return;
    const changed = type !== undefined && type !== p.type;
    if (type !== undefined) p.type = type;
    p.query = previous.query; p.index = changed ? 0 : previous.index;
    delete p.objectTypeBrowse;
    const search = $('#picker-query');
    search.value = p.query; search.placeholder = 'Search objects by name or ID…'; search.setAttribute('aria-label', 'Search objects');
    $('#picker-results').setAttribute('aria-label', 'Objects');
    $('#picker-results').setAttribute('aria-multiselectable', String(!!p.multi));
    renderPicker(); $('#picker-results').scrollTop = changed ? 0 : previous.scroll;
    search.focus();
  }

  function renderObjectTypes(p) {
    const types = [...new Set([...(p.containers ? ['Category'] : []), ...Object.keys(schemaData.classes).filter(t => ['Organisation','Scorecard'].includes(t) || /^Ce/i.test(t)), ...(p.type ? [p.type] : [])])];
    const label = type => type === 'Category' ? 'Folders' : typeLabel(type);
    const common = ['Organisation', 'CeRiskAssessment', 'CeControlMeasure', 'Scorecard'].filter(type => types.includes(type));
    p.entries = [{rid:'',label:'All types'}, ...types.sort((a,b) => (common.includes(a)?0:1)-(common.includes(b)?0:1) || label(a).localeCompare(label(b))).map(type => ({rid:type,label:label(type), common:common.includes(type)}))]
      .filter(row => queryMatches(p.query, row.rid, row.label));
    p.index = Math.min(p.index < 0 ? Math.max(0,p.entries.findIndex(row => row.rid === p.type)) : p.index, p.entries.length - 1);
    const search = $('#picker-query');
    search.placeholder = 'Find an object type…'; search.setAttribute('aria-label', 'Search object types');
    search.setAttribute('aria-activedescendant', p.index >= 0 ? 'pick-' + p.index : '');
    $('#picker .picker-clear').hidden = !p.query;
    $('#picker-types').innerHTML = `<div class="object-type-filter"><button type="button" class="type-back" data-command="picker-types-back">${icon('back')}Back to objects</button><span>Common types first</span></div>`;
    const list = $('#picker-results');
    list.setAttribute('aria-label', 'Object types'); list.setAttribute('aria-multiselectable', 'false');
    list.innerHTML = p.entries.map((row,i) => `<button type="button" class="picker-option ${i === p.index ? 'focused' : ''} ${row.rid === p.type ? 'chosen' : ''}" id="pick-${i}" role="option" tabindex="-1" aria-selected="${row.rid === p.type}" data-command="picker-select" data-index="${i}">${icon('type')}<span><strong>${esc(row.label)}</strong>${row.rid && row.label !== row.rid ? '<small>'+esc(row.rid)+'</small>' : ''}</span>${row.rid === p.type ? icon('valid') : ''}</button>`).join('') || '<div class="picker-empty">No matching types.</div>';
    $('#picker-footer').innerHTML = '<span>↑ ↓ navigate · Enter select</span><span class="spacer"></span><span>Esc back</span>';
    positionPicker();
  }

  function positionPicker() {
    const p = state.picker,
      el = $('#picker');
    if (!p || !el || !p.anchor.isConnected) return;
    const rect = p.anchor.getBoundingClientRect(),
      limit = Math.min(440, innerHeight - 20),
      width = Math.min(p.width ?? (p.kind === 'object' ? 490 : 430), innerWidth - 20);
    el.style.width = width + 'px';
    el.style.left = Math.max(10, Math.min(rect.left, innerWidth - width - 10)) + 'px';
    el.style.maxHeight = limit + 'px';
    const height = el.offsetHeight,
      below = innerHeight - rect.bottom - 15,
      above = rect.top - 15,
      up = height > below && above > below;
    const fixed = [...el.children].filter(child => child.id !== 'picker-results').reduce((sum, child) => {
      const style = getComputedStyle(child);
      return sum + child.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }, 2);
    const minimum = Math.min(height, fixed + 96),
      space = up ? above : below;
    // Preserve the title, search and context. In a tight window the menu may overlap
    // its anchor, but only the choices scroll; fixed controls never get clipped.
    el.style.maxHeight = Math.min(limit, space >= minimum ? space : limit) + 'px';
    el.style.top = Math.max(10, Math.min(innerHeight - el.offsetHeight - 10, up ? rect.top - el.offsetHeight - 5 : rect.bottom + 5)) + 'px';
    el.scrollTop = 0;
  }

  function scrollPickerChoice() {
    const list = $('#picker-results'),
      option = $('#pick-' + state.picker?.index);
    if (!list || !option) return;
    const row = option.getBoundingClientRect(),
      view = list.getBoundingClientRect();
    if (row.top < view.top) list.scrollTop += row.top - view.top;
    else if (row.bottom > view.bottom) list.scrollTop += row.bottom - view.bottom;
  }

  function choosePicker(index) {
    const p = state.picker,
      row = p?.entries[index];
    if (!row || row.reason) return;
    if (p.objectTypeBrowse) { returnToObjects(row.rid); return; }
    if (p.kind === 'schema' && p.stage === 'types') {
      p.browseType = row.rid;
      schemaHints.set(schemaKey(p.scope), row.rid);
      p.stage = '';
      p.query = '';
      $('#picker-query').value = '';
      p.index = 0;
      renderPicker();
      $('#picker-query').focus();
      return;
    }
    if (p.multi) {
      p.selectedValues = toggleChoice(p.selectedValues, row.rid, p.exclusive);
      renderPicker();
      $('#picker-query').focus();
      return;
    }
    if (p.kind === 'schema' && p.mode === 'property' && p.browseType) schemaHints.set(schemaKey(p.scope), p.browseType);
    applyPickerSelection(p, row.rid, row);
  }


  function moveRole(rid, parent) {
    const reason = moveProblem(model.roles, rid, parent);
    if (reason) {
      status(reason);
      return;
    }
    const r = roleByRid(rid),
      name = r.name,
      destination = roleByRid(parent)?.name ?? 'top level';
    commit(() => r.parent = parent, `Moved ${name} → ${destination} · Ctrl+Z to undo`);
    openRecord('role', rid);
    announce(`Moved ${name} under ${destination}.`);
  }

  function saveId() {
    const r = current(),
      value = (state.idDraft.get(r.rid) ?? r.id).trim(),
      error = $('#id-error');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      error.textContent = 'Use letters, numbers and underscores; start with a letter or underscore.';
      return;
    }
    if ((state.kind === 'role' ? [...model.roles, ...model.scope] : [...model.policies, ...model.folders]).some(x => x.rid !== r.rid && x.id === value)) {
      error.textContent = 'This ID is already used.';
      return;
    }
    if (value === r.id) {
      state.idDraft.delete(r.rid);
      refreshDraftChrome();
      renderEditor();
      return;
    }
    const changes = [];
    let count = 0;
    if (state.kind === 'role')
      for (const p of model.policies) {
        const changed = renameRoleReferences(p.content, r.id, value);
        if (changed.count) {
          changes.push({
            p,
            content: changed.content
          });
          count += changed.count;
        }
        if (state.raw.has(p.rid)) {
          try {
            const raw = renameRoleReferences(JSON.parse(state.raw.get(p.rid)), r.id, value);
            if (raw.count) {
              error.textContent = 'Update or discard the JSON edits in ' + p.name + ' before changing this role ID.';
              return;
            }
          } catch {
            error.textContent = 'Finish or discard the invalid JSON draft in ' + p.name + ' before changing a role ID.';
            return;
          }
        }
      }
    commit(() => {
      for (const change of changes) change.p.content = change.content;
      r.id = value;
      state.idDraft.delete(r.rid);
    }, `ID saved${count?' · '+count+' policy reference'+(count===1?'':'s')+' updated':''} · Ctrl+Z to undo`);
  }

  function findInJSON(query) {
    if (jsonEditor) jsonEditor.find(query);
    else pendingJSONFind = query;
  }

  function mountJSON() {
    const parent = $('#policy-json-editor');
    if (!parent) return;
    const rid = current().rid;
    parent.textContent = 'Loading JSON editor…';
    parent.setAttribute('aria-busy', 'true');
    const keep = $('[data-command="apply-json"]');
    if (keep) keep.disabled = true;
    void editorLoader.mount(parent, createJSONEditor => {
      parent.replaceChildren();
      parent.removeAttribute('aria-busy');
      jsonEditor = createJSONEditor(parent, state.raw.get(rid) ?? current().invalidContent ?? JSON.stringify(current().content, null, 2),
      text => setJSONDraft(rid, text), result => {
        const el = $('#json-diagnostics');
        if (!el) return;
        $('#json-state').textContent = state.raw.has(rid) ? 'Policy JSON · editing' : 'Policy JSON';
        el.classList.toggle('invalid', !result.valid);
        const issueRow = (i,index) => `<div class="json-issue ${i.severity}">${icon(i.severity==='error'?'warning':'help')}<button type="button" class="json-issue-location" data-command="json-reveal-issue" data-issue="${index}" title="Go to problem">${esc(i.path+': '+i.message)}</button>${i.fixes.map((label,fix)=>`<button type="button" class="json-quick-fix" data-command="json-fix-issue" data-issue="${index}" data-fix="${fix}">${esc(label)}</button>`).join('')}</div>`;
        const expanded=el.querySelector('details')?.open;
        el.innerHTML = result.issues.length ? result.issues.slice(0,2).map(issueRow).join('')+(result.issues.length>2?`<details ${expanded?'open':''}><summary>${result.issues.length-2} more problems</summary>${result.issues.slice(2).map((issue,index)=>issueRow(issue,index+2)).join('')}</details>`:'') :
          `<div>${icon('valid')}<span>Valid JSON · policy structure checked</span><span class="spacer"></span><span>Suggestions as you type · Tab accepts · Ctrl+F find</span></div>`;
        const keep = $('[data-command="apply-json"]');
        if (keep) keep.disabled = !result.valid;
      }, jsonBookmarks.get(rid), {
        catalogue: jsonCatalogue,
        outlineParent: $('#policy-json-outline'),
        layout: state.jsonLayouts?.get(rid),
        onLayout(layout) {
          state.jsonLayouts ??= new Map();state.jsonLayouts.delete(rid);state.jsonLayouts.set(rid,layout);
          if(state.jsonLayouts.size>50)state.jsonLayouts.delete(state.jsonLayouts.keys().next().value);
          void saveWorkspace().catch(showError);
        }
      });
      if (pendingJSONFind) { jsonEditor.find(pendingJSONFind); pendingJSONFind = ''; }
      if (pendingJSONStatement !== null) {
        jsonEditor.revealStatement(pendingJSONStatement); pendingJSONStatement = null;
        // Do not steal focus if the user moved elsewhere while the editor loaded.
        if (document.activeElement === $('#editor')) jsonEditor.focus();
      }
    }, error => {
      parent.removeAttribute('aria-busy');
      parent.textContent = 'Could not load the JSON editor. ' + error.message + ' ';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Retry';
      retry.addEventListener('click', mountJSON);
      parent.append(retry);
    });
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      status('Copied to clipboard');
    } catch {
      dialog('Copy value', `<input value="${esc(text)}" readonly aria-label="Value to copy">`);
      $('#dialog input').select();
    }
  }

  function recordMenu(anchor, kind = state.kind, rid = state.rid, inTree = true) {
    const row = model[kind === 'role' ? 'roles' : 'policies'].find(r => r.rid === rid);
    if (!row) return;
    const attr = `data-kind="${kind}" data-rid="${rid}"`;
    if (!inTree) {
      popup(anchor, button('edit', 'context-edit-id', 'Edit business ID', attr) +
        button('copy', 'context-copy-id', 'Copy business ID', attr) + button('copy', 'context-copy-rid', 'Copy RID', attr) +
        (kind === 'role' ? '<hr>' + button('search', 'context-find', 'Find policies using role', attr) : ''));
      return;
    }
    popup(anchor, (kind === 'role' ? button('plus', 'context-new-child', 'New role underneath', attr) + button('fieldAssignment',
          'context-add-assignment', 'Add field assignment', attr) + button('globe', 'context-add-global', 'Assign a user or group',
        attr) + '<hr>' : '') + button('edit', 'context-edit-id', 'Edit business ID', attr) + button('copy', 'context-copy-id',
        'Copy business ID', attr) + button('copy', 'context-copy-rid', 'Copy RID', attr) + '<hr>' + button(kind === 'role' ? 'scope' :
        'folder', 'context-move', 'Move in tree…', attr) + (kind === 'role' ? button('search',
        'context-find', 'Find policies using role', attr) : '') + button('history', 'context-history', 'History for this ' + kind, attr) +
      '<hr>' + button('copy', 'context-duplicate', 'Duplicate ' + kind, attr) + button('trash', 'context-delete', 'Delete ' + kind, attr));
  }

  function treeContextMenu(row, point) {
    if (row.dataset.scopeNode) {
      const definition = model.scope.find(r => r.rid === row.dataset.scopeNode);
      if (!definition) return;
      const kind = definition.kind === 'RoleAssignment' ? 'assignment' : 'delegation';
      const attr = `data-rid="${definition.rid}"`;
      popup(row, button('edit', 'open-definition', 'Edit ' + kind, attr) +
        button('plus', 'context-add-delegation', 'Add delegation underneath…', attr) + '<hr>' +
        button('trash', 'delete-scope', 'Delete ' + kind, attr));
    } else if (row.dataset.folder) folderMenu(row, row.dataset.folder);
    else recordMenu(row, row.dataset.kind, row.dataset.open);
    if (point) positionMenu({ left: point.x, bottom: point.y });
  }
  let feedbackTimer;

  function announce(message) {
    clearTimeout(feedbackTimer);
    $('#interaction-feedback').textContent = message;
    if (message && !state.drag) feedbackTimer = setTimeout(() => {
      if (!state.drag) $('#interaction-feedback').textContent = '';
    }, 2800);
  }

  function identityLinkedChange(d) {
    if (!d.before) return false;
    if (d.key === 'roles') return d.before.id !== d.r.id;
    if (d.key !== 'policies') return false;
    const ids = [...referencedRoleIds(d.before.content), ...referencedRoleIds(d.r.content)];
    return model.roles.some(r => {
      const old = baseline.roles.find(x => x.rid === r.rid);
      return old && old.id !== r.id && (ids.includes(old.id) || ids.includes(r.id));
    });
  }
  async function polishCommand(cmd, el) {
    if (cmd === 'discard-one' && identityLinkedChange(differences().find(d => d.r.rid === el.dataset.rid) ?? {})) {
      status('Role IDs and their policy references change together. Use Undo or Discard all.');
      return true;
    }

    if (cmd === 'close-picker') {
      closePicker();
      return true;
    }
    if (cmd === 'picker-select') {
      choosePicker(Number(el.dataset.index));
      return true;
    }
    if (cmd === 'picker-type') {
      state.picker.type = el.dataset.value;
      state.picker.index = 0;
      renderPicker();
      $('#picker-query').focus();
      return true;
    }
    if (cmd === 'picker-browse-types') { browseObjectTypes(); return true; }
    if (cmd === 'picker-types-back') { returnToObjects(); return true; }
    if (cmd === 'picker-retry-search') { state.picker.search?.retry(); renderPicker(); $('#picker-query').focus(); return true; }
    if (cmd === 'choose-subject') {
      const s = statement(),
        tokens = Array.isArray(s.Subject) ? s.Subject : [s.Subject],
        r = model.roles.find(r => tokens.includes('role:' + r.id));
      showPicker(el, {
        kind: 'role',
        title: 'Policy subject',
        selected: r?.rid ?? '',
        allowNone: true,
        noneLabel: 'Everyone',
        select: rid => commit(() => statement().Subject = rid ? ['role:' + roleByRid(rid).id] : '*', 'Policy subject updated')
      });
      return true;
    }

    if (cmd === 'toggle-folder') {
      state.folderClosed.has(el.dataset.folder) ? state.folderClosed.delete(el.dataset.folder) : state.folderClosed.add(el.dataset
      .folder);
      renderTree();
      return true;
    }
    if (cmd === 'choose-object') {
      showPicker(el, {
        kind: 'object',
        title: 'Choose a business object',
        type: state.check.typeHint ?? '',
        selected: state.check.resource,
        select: (rid, obj) => {
          if (state.check.resource !== rid) delete state.check.rename;
          state.check.resource = rid;
          markTestChanged();
          state.recentObjects = [rid, ...state.recentObjects.filter(x => x !== rid)].slice(0, 8);
          if ((state.check.action === 'Update' && state.check.updateMode === 'custom') && state
            .check.proposed === '{}') state.check.proposed = JSON.stringify({
            type: obj.type,
            references: {}
          }, null, 2);
          renderDock();
        }
      });
      return true;
    }
    if (cmd === 'manual-object') {
      closePicker();
      dialog('Use an object RID', '<label>RID<input id="manual-rid" inputmode="numeric" pattern="[0-9]+" required></label>', 'Use RID',
      () => {
          state.check.resource = $('#manual-rid').value;
          state.check.result = null;
          renderDock();
        });
      return true;
    }
    if (cmd === 'test-action') {
      state.check = switchTestAction(state.check, el.dataset.actionValue);
      seedMatrixCreateType();
      renderDock();
      return true;
    }
    if (cmd === 'choose-test-role') {
      const q = state.check;
      showPicker(el, { kind: 'role', title: 'Choose a role to test', selected: q.subject, select: rid => { q.subject = rid; rememberTestActor(q); markTestChanged(q); renderDock(); } });
      return true;
    }
    if (cmd === 'test-mode') {
      const q = state.check;
      if (q.mode === 'role') {
        q.mode = 'user';
        q.subject = resolveUser(userDirectory.users, q.userId)?.rid ?? '';
        rememberTestActor(q); markTestChanged(q);
        renderDock();
        if (!selectedTestUser(q)) openUserPicker($('#dock [data-command=choose-test-user]'), q.userId, user => {
          q.userId = user.id;
          q.subject = user.rid;
          rememberTestActor(q); markTestChanged(q);
          renderDock();
        });
      } else {
        const original = defaultTest(),
          rid = currentRole()?.rid ?? (original.mode === 'role' ? original.subject : '');
        if (rid) {
          q.mode = 'role';
          q.subject = rid;
          rememberTestActor(q); markTestChanged(q);
          renderDock();
        } else showPicker(el, {
          kind: 'role',
          title: 'Choose a role to test',
          selected: '',
          select: rid => {
            q.mode = 'role';
            q.subject = rid;
            rememberTestActor(q); markTestChanged(q);
            renderDock();
          }
        });
      }
      return true;
    }
    if (cmd === 'reset-json') {
      state.raw.delete(current().rid);
      render();
      status('JSON edits discarded');
      return true;
    }
    if (cmd === 'save-id') {
      saveId();
      return true;
    }
    if (cmd === 'format-json') {
      if (!jsonEditor?.format()) status('Fix JSON syntax before formatting.');
      return true;
    }
    if (cmd === 'search-kind') {
      state.searchKind = el.dataset.value;
      renderTree();
      $('#search').focus();
      return true;
    }
    if (cmd === 'clear-search') {
      state.search = '';
      $('#search').value = '';
      renderTree();
      $('#search').focus();
      return true;
    }
    if (cmd === 'clear-role-filter') {
      state.roleFilter = '';
      renderTree();
      return true;
    }
    if (cmd === 'find-role-policies') {
      state.roleFilter = state.rid;
      state.searchKind = 'policy';
      state.search = '';
      $('#search').value = '';
      renderTree();
      document.body.classList.remove('no-explorer');
      return true;
    }
    if (cmd === 'filter-policies') {
      showPicker(el, {
        kind: 'role',
        title: 'Policies using this role',
        selected: state.roleFilter,
        allowNone: true,
        noneLabel: 'All roles',
        select: rid => {
          state.roleFilter = rid;
          state.searchKind = 'policy';
          renderTree();
        }
      });
      return true;
    }
    if (cmd.startsWith('context-')) {
      const kind = el.dataset.kind,
        rid = el.dataset.rid,
        row = model[kind === 'role' ? 'roles' : 'policies'].find(r => r.rid === rid);
      if (!row) return true;
      if (cmd === 'context-copy-id' || cmd === 'context-copy-rid') {
        await copyText(cmd === 'context-copy-id' ? row.id : rid);
        return true;
      }
      openRecord(kind, rid);
      if (cmd === 'context-edit-id') {
        $('#business-id').focus();
        $('#business-id').select();
      }
      if (cmd === 'context-move') {
        state.search = '';
        state.searchKind = 'all';
        $('#search').value = '';
        renderTree();
        document.body.classList.remove('no-explorer');
        const row = $(`[data-drag-rid="${rid}"]`);
        row?.scrollIntoView({
          block: 'nearest'
        });
        row?.focus();
        startTreeDrag(kind, rid, true);
      }
      if (cmd === 'context-find') await polishCommand('find-role-policies', el);
      if (cmd === 'context-duplicate') createRecord(kind, true);
      if (cmd === 'context-delete') deleteRecord();
      return true;
    }
    if (cmd === 'new-policy-here') {
      state.newPolicyFolder = el.dataset.folder;
      createRecord('policy');
      return true;
    }
    return false;
  }

  function installPolish() {
    const feedback = document.createElement('div');
    feedback.id = 'interaction-feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    document.body.append(feedback);
    document.addEventListener('pointerdown', e => {
      if (state.picker && !e.target.closest('#picker') && !state.picker.anchor.contains(e.target)) closePicker(false);
    }, true);
    document.addEventListener('input', e => {
      if (e.target.matches('.record-name')) e.target.value = e.target.value.replace(/[\r\n]+/g, ' ');
    }, true);
    document.addEventListener('input', e => {
      if (e.target.id === 'picker-query') {
        state.picker.query = e.target.value;
        state.picker.index = 0;
        renderPicker();
      }
      if (e.target.dataset.identity) {
        const rid = e.target.dataset.identity;
        if (e.target.value === current().id) state.idDraft.delete(rid);
        else state.idDraft.set(rid, e.target.value);
        $('.id-save').hidden = e.target.value === current().id;
        $('#id-error').textContent = '';
        refreshDraftChrome();
      }
    });
    document.addEventListener('contextmenu', e => {
      if (e.shiftKey || e.target.closest('input,textarea,[contenteditable="true"],.cm-editor') || getSelection()?.toString()) {
        $('#menu').hidden = true;
        return;
      }
      const row = e.target.closest('#tree [data-open],#tree [data-folder],#tree [data-scope-node]');
      if (!row) return;
      e.preventDefault();
      treeContextMenu(row, { x: e.clientX, y: e.clientY });
    });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && e.target.closest('.cm-editor')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void command('apply-json', $('[data-command="apply-json"]'));
        return;
      }
      if (e.target.matches('.record-name') && e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.target.blur();
        return;
      }
      if (e.target.dataset.identity) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopImmediatePropagation();
          saveId();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          state.idDraft.delete(current().rid);
          e.target.value = current().id;
          $('.id-save').hidden = true;
          $('#id-error').textContent = '';
          refreshDraftChrome();
        }
        return;
      }
      if (state.picker) {
        pickerKeyboard(e);
        return;
      }
      if (e.target.id === 'search' && e.key === 'Escape' && state.search) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void polishCommand('clear-search', e.target);
        return;
      }

    }, true);
  }

  // Builder interactions operate on the same local model and Undo history.
  const reachDirections = {
    InwardsReferenceRoleDelegationRule: {
      label: 'Objects pointing here',
      verb: 'Their reference points to the previous object.',
      icon: 'delegation-in'
    },
    OutwardsReferenceRoleDelegationRule: {
      label: 'Objects linked from here',
      verb: 'Follow the reference on the previous object.',
      icon: 'delegation-out'
    },
    HierarchicalDownwardsRoleDelegationRule: {
      label: 'Descendant objects',
      verb: 'Carry the role down the object hierarchy.',
      icon: 'delegation-down'
    },
    HierarchicalUpwardsRoleDelegationRule: {
      label: 'Ancestor objects',
      verb: 'Carry the role up the object hierarchy.',
      icon: 'delegation-up'
    }
  };

  function reachNode(parent) {
    return model.scope.filter(r => r.parent === parent && r.kind !== 'RoleAssignment').map(d => {
      const meta = reachDirections[d.kind] ?? {
          label: d.kind,
          verb: 'Inspect this rule in the field view.',
          icon: 'scope'
        },
        hierarchical = d.kind.startsWith('Hierarchical');
      return `<div class="reach-branch"><div class="reach-node" data-scope-editor="${d.rid}"><div class="reach-node-line"><span class="reach-joint">also on</span><button data-command="reach-direction" data-rid="${d.rid}" class="reach-direction" title="${esc(meta.verb+' ('+d.kind+')')}">${icon(meta.icon)}${esc(meta.label)}${icon('down')}</button><span class="spacer"></span>${ib('plus','reach-add','Continue this path','data-parent="'+d.rid+'"')}${ib('trash','delete-scope','Remove this branch','data-rid="'+d.rid+'"')}</div>${!hierarchical?`<label class="reach-reference"><span>through</span>${scopeReference(d)}</label>`:''}</div>${reachNode(d.rid)}</div>`;
    }).join('');
  }

  function renderMemberships(role) {
    const all = model.globals.filter(g => g.parent === role.rid), query = state.membershipQuery ?? '';
    const rows = all.filter(g => queryMatches(query, g.subjectId, g.subjectName, g.subject));
    const limit = state.membershipLimit ?? 100;
    return `<div class="memberships">${!all.length?'<div class="empty-row">No global assignments.</div>':''}${all.length > 20 || query ? `<label class="membership-search">${icon('search')}<input data-membership-search placeholder="Find assigned user or group…" aria-label="Find assigned user or group" value="${esc(query)}"><span>${rows.length}</span></label>` : ''}<div class="membership-results">${rows.slice(0, limit).map(g=>`<div class="reach-global" data-scope-editor="${g.rid}">${icon('globe')}<span>${esc(g.mode)} <code>${esc(g.subjectId??g.subject)}</code>${g.subjectName?' · '+esc(g.subjectName):''}</span>${ib('trash','delete-global','Remove global assignment','data-rid="'+g.rid+'"')}</div>`).join('')}${rows.length > limit ? button('plus','members-more',`Show more (${limit} of ${rows.length})`) : ''}</div></div>`;
  }
  document.addEventListener('input', event => {
    if (!event.target.matches('[data-membership-search]')) return;
    state.membershipQuery = event.target.value; state.membershipLimit = 100;
    const holder = document.createElement('div'); holder.innerHTML = renderMemberships(current());
    $('.membership-results').replaceWith(holder.querySelector('.membership-results'));
    $('.membership-search span').textContent = holder.querySelector('.membership-search span').textContent;
  });
  function renderReach(role) {
    const list = assignments(role);
    return `<div class="reach-flows">${list.map(a=>`<article class="reach-flow" data-scope-editor="${a.rid}"><div class="reach-origin"><div class="reach-source-fields"><label>Type<select data-scope="source" data-rid="${a.rid}" aria-label="Assignment source class">${[...new Set([a.source,...Object.keys(fields)])].filter(Boolean).map(x=>option(x,x,a.source)).join('')}</select></label><label>Field<select data-scope="field" data-rid="${a.rid}" aria-label="Assignment field">${[...new Set([a.field,...(fields[a.source]??[])])].filter(Boolean).map(x=>option(x,x,a.field)).join('')}</select></label></div>${ib('trash','delete-scope','Remove assignment','data-rid="'+a.rid+'"')}</div><div class="reach-on-source">${icon('object')}<strong>Source object</strong><span class="spacer"></span><button data-command="reach-add" data-parent="${a.rid}" title="Extend this assignment to related objects">${icon('plus')}${model.scope.some(d=>d.parent===a.rid)?'Branch':'Extend'}</button></div>${reachNode(a.rid)}</article>`).join('')||'<div class="empty-row">No field assignments.</div>'}</div>`;
  }

  function mountBuilder() {
    if (state.kind === 'role') {
      const assignment = $$('.section').find(s => s.querySelector('.section-label')?.dataset.section.endsWith(':Field assignments'));
      const delegation = $$('.section').find(s => s.querySelector('.section-label')?.dataset.section.endsWith(':Delegation'));
      if (!assignment || !delegation) return;
      const flow = state.reachView !== 'fields';
      const switcher =
        `<div class="builder-view"><button data-command="reach-view" data-value="flow" class="${flow?'active':''}" aria-pressed="${flow}">Flow</button><button data-command="reach-view" data-value="fields" class="${!flow?'active':''}" aria-pressed="${!flow}">Fields</button></div>`;
      if (flow) {
        assignment.classList.add('reach-section');
        assignment.innerHTML = section('Field assignments', 'fieldAssignment', switcher + button('plus', 'add-assignment', 'Assignment',
          'aria-label="Add field assignment" title="Add field assignment"'), assignments(current()).length) + renderReach(current());
        delegation.remove();
      } else {
        assignment.classList.add('reach-section');
        assignment.querySelector('.section-heading>.spacer').insertAdjacentHTML('afterend', switcher);
        const add = assignment.querySelector('[data-command=add-assignment]');
        add.setAttribute('aria-label', 'Add field assignment');
        add.title = 'Add field assignment';
      }
    } else if (state.view === 'rules') {
      const target = $('.section .logic-group');
      if (target) target.closest('.section').classList.add('logic-section');
    }
    if (!$('#builder-expression-options')) {
      const data = document.createElement('datalist');
      data.id = 'builder-expression-options';
      const values = new Set(['resource.type', 'user']);

      function walk(v) {
        if (!v || typeof v !== 'object') return;
        for (const [k, value] of Object.entries(v)) {
          if (['Left', 'Reference'].includes(k) && typeof value === 'string') values.add(value);
          if (typeof value === 'object') walk(value);
        }
      }
      model.policies.forEach(p => walk(p.content));
      data.innerHTML = [...values].sort().map(v => `<option value="${esc(v)}"></option>`).join('');
      document.body.append(data);
    }
    if (!$('#reach-reference-options')) {
      const data = document.createElement('datalist');
      data.id = 'reach-reference-options';
      data.innerHTML = [...new Set(model.scope.filter(r => r.kind !== 'RoleAssignment' && r.field).map(r => r.field.split('.').at(-1)))]
        .sort().map(v => `<option value="${esc(v)}"></option>`).join('');
      document.body.append(data);
    }
  }
  const pathAttrs = path => `data-path='${encode(path)}'`;

  function logicTools(path) {
    return `<div class="logic-tools">${ib('more','logic-menu','Condition actions',pathAttrs(path))}${ib('trash','remove-condition','Remove condition',pathAttrs(path))}</div>`;
  }

  function builderCondition(node, path) {
    const key = expressionKind(node);
    if (['All', 'Any'].includes(key) && Array.isArray(node[key])) {
      const duplicates = duplicateIndices(node[key]);
      const columns = node[key].length && node[key].every(child => expressionKind(child) === 'Condition')
        ? '<div class="logic-columns" aria-hidden="true"><span>Property</span><span>Comparison</span><span>Value</span></div>' : '';
      return `<div class="logic-group ${key==='Any'?'logic-any':''}" data-logic-path='${encode(path)}'><div class="logic-heading"><div class="logic-toggle" role="group" aria-label="Condition grouping">${['All','Any'].map(k=>`<button data-command="logic-group" data-value="${k}" ${pathAttrs(path)} class="${key===k?'active':''}" aria-pressed="${key===k}">${k==='All'?'ALL':'ANY'}</button>`).join('')}</div><span>${key==='All'?'conditions must match':'condition must match'}</span><span class="spacer"></span><div class="logic-tools">${ib('more','logic-menu','Group actions',pathAttrs(path))}${path.length?ib('trash','remove-condition','Remove group',pathAttrs(path)):''}</div></div>${columns}<div class="logic-children">${node[key].map((child,i)=>`<div class="logic-child"><div class="logic-child-body">${builderCondition(child,[...path,key,i])}${duplicates.has(i)?`<div class="logic-duplicate">${icon('copy')}<span>Repeats condition ${duplicates.get(i)+1} in this group.</span><button data-command="remove-condition" ${pathAttrs([...path,key,i])}>Remove repeat</button></div>`:''}</div></div>`).join('')||'<div class="logic-empty">'+(key==='All'?'No conditions — this group matches.':'No alternatives — this group never matches.')+'</div>'}</div><button class="logic-add" data-command="add-condition" ${pathAttrs(path)}>${icon('plus')}${node[key].length?(key==='All'?'And…':'Or…'):'Add condition…'}</button></div>`;
    }
    if (key === 'Condition') return schemaCondition(node, path);
    if (key === 'HasRole' || key === 'HasAccessTo') {
      const c = node[key];
      if (!c || typeof c !== 'object') return unknown(node, path);
      const roles = (Array.isArray(c.Roles) ? c.Roles : [c.Roles]).filter(Boolean);
      return `<div class="logic-related"><div class="logic-related-heading">${icon(key==='HasRole'?'role':'policy')}<strong>${key==='HasRole'?'Role on a related object':'Access to a related object'}</strong><span class="spacer"></span>${logicTools(path)}</div><div class="logic-reference"><label>Through<textarea class="reference-value" rows="1" aria-label="Related object reference" data-condition='${encode([...path,key,'Reference'])}' data-reference-list="builder-expression-options">${esc(c.Reference)}</textarea></label>${key==='HasAccessTo'?`<label>Action<select aria-label="Nested action" data-condition='${encode([...path,key,'Action'])}'>${option('','Same action',pbacAction(c.Action))}${A.map(a=>option(a,a,pbacAction(c.Action))).join('')}</select></label>`:''}</div><div class="logic-roles"><span>Roles</span>${roles.map((token,i)=>{const r=model.roles.find(r=>r.id===String(token).replace(/^role:/,''));return `<span class="logic-role" title="${esc(token)}">${r?`<button class="logic-role-link" data-command="open-role" data-rid="${r.rid}" title="Open role: ${esc(r.name)}">${icon('role')}<span>${esc(r.name)}</span>${icon('open')}</button>`:`${icon('role')}<span>${esc(token)}</span>`}${ib('close','logic-remove-role','Remove '+(r?.name??token),pathAttrs([...path,key,'Roles'])+' data-index="'+i+'"')}</span>`;}).join('')}<button data-command="logic-add-role" ${pathAttrs([...path,key,'Roles'])}>${icon('plus')}${roles.length?'Role':'Choose roles…'}</button></div></div>`;
    }
    return unknown(node, path);
  }

  function builderConditionMenu(anchor, path) {
    popup(anchor, [
      ['Condition', 'sliders', 'Compare a property', 'Type, owner, status, or another expression'],
      ['HasRole', 'role', 'Role on a related object', 'Follow a reference, then check a role'],
      ['HasAccessTo', 'policy', 'Access to a related object', 'Check an action on a referenced object'],
      ['All', 'scope', 'All of a group', 'Every condition must match'],
      ['Any', 'scope', 'Any of a group', 'One matching condition is enough']
    ].map(([kind, i, title, description]) =>
      `<button class="builder-menu-choice" data-command="insert-condition" data-node="${kind}" ${pathAttrs(path)}>${icon(i)}<span><strong>${title}</strong><small>${description}</small></span></button>`
      ).join(''));
  }

  function directionChoices(anchor, commandName, rid) {
    const key = commandName === 'reach-insert' ? 'parent' : 'rid',
      current = model.scope.find(r => r.rid === rid);
    choicePicker(anchor, {
      title: commandName === 'reach-insert' ? 'Add delegation' : 'Delegation direction',
      width: 365,
      selected: commandName === 'reach-insert' ? '' : current?.kind,
      rows: Object.entries(reachDirections).map(([kind, d]) => ({
        rid: kind,
        label: d.label,
        secondary: d.verb,
        icon: d.icon
      })),
      select: value => builderCommand(commandName, {
        dataset: {
          [key]: rid,
          value
        }
      })
    });
  }
  async function builderCommand(cmd, el) {
    if (cmd === 'reach-view') {
      state.reachView = el.dataset.value;
      renderEditor();
      return true;
    }
    if (cmd === 'reach-add') {
      directionChoices(el, 'reach-insert', el.dataset.parent);
      return true;
    }
    if (cmd === 'reach-direction') {
      directionChoices(el, 'reach-set-direction', el.dataset.rid);
      return true;
    }
    if (cmd === 'reach-insert') {
      if (!model.scope.some(r => r.rid === el.dataset.parent)) return true;
      const rid = draftRid();
      commit(() => {
        model.scope.push({ rid, id: 'draft_delegation_' + stamp(), name: 'New delegation', kind: el.dataset.value,
          parent: el.dataset.parent, field: '', source: '' });
        state.scopeSelection = rid;
        revealDefinitionPath(rid);
      }, 'Added local delegation');
      mountFastChoices();
      revealDefinitionEditor(true);
      return true;
    }
    if (cmd === 'reach-set-direction') {
      commit(() => {
        const row = model.scope.find(r => r.rid === el.dataset.rid);
        row.kind = el.dataset.value;
        if (row.kind.startsWith('Hierarchical')) row.field = '';
        row.referenceConfig = '';
      }, 'Changed role propagation direction');
      return true;
    }
    if (cmd === 'logic-group') {
      const path = JSON.parse(el.dataset.path);
      commit(() => {
        const node = getPath(statement().Resource, path),
          old = expressionKind(node);
        if (old !== el.dataset.value) {
          node[el.dataset.value] = node[old];
          delete node[old];
        }
      }, 'Changed condition grouping');
      return true;
    }
    if (cmd === 'logic-menu') {
      const path = JSON.parse(el.dataset.path),
        node = getPath(statement().Resource, path),
        kind = expressionKind(node),
        siblings = getPath(statement().Resource, path.slice(0, -1)),
        index = path.at(-1);
      const items = [
        ['any', 'Add an alternative…'],
        ['all', 'Add a required condition…']
      ];
      if (['All', 'Any'].includes(kind) && node[kind]?.length === 1 && Object.keys(node).length === 1) items.push(['unwrap',
        'Remove group, keep condition'
      ]);
      if (Array.isArray(siblings) && Number.isInteger(index)) {
        items.push(['duplicate', 'Duplicate']);
        if (index > 0) items.push(['up', 'Move up']);
        if (index < siblings.length - 1) items.push(['down', 'Move down']);
      }
      popup(el, items.map(([operation, label]) => button(operation === 'duplicate' ? 'copy' : 'scope', 'logic-transform', label,
        pathAttrs(path) + ' data-operation="' + operation + '"')).join('') + '<hr>' + button('json', 'edit-node',
        'Edit this expression as JSON', pathAttrs(path)) + (path.length ? '<hr>' + button('trash', 'remove-condition', ['All','Any'].includes(kind) ? 'Remove group' : 'Remove condition', pathAttrs(path)) : ''));
      return true;
    }
    if (cmd === 'logic-transform') {
      const path = JSON.parse(el.dataset.path);
      commit(() => statement().Resource = transformExpression(statement().Resource, path, el.dataset.operation),
        'Updated condition structure');
      if (['all', 'any'].includes(el.dataset.operation)) {
        const group = $$('.logic-group').find(x => x.dataset.logicPath === JSON.stringify(path));
        const anchor = group?.querySelector(':scope > .logic-add');
        if (anchor) builderConditionMenu(anchor, path);
      }
      return true;
    }
    if (cmd === 'logic-add-role') {
      const path = JSON.parse(el.dataset.path),
        value = getPath(statement().Resource, path),
        tokens = (Array.isArray(value) ? value : [value]).filter(Boolean);
      showPicker(el, {
        kind: 'role',
        title: 'Add a role to this condition',
        selected: '',
        invalid: rid => tokens.some(t => String(t).replace(/^role:/, '') === roleByRid(rid)?.id) ? 'Already included' : '',
        select: rid => commit(() => setPath(statement().Resource, path, [...tokens, roleByRid(rid).id]), 'Added role to condition')
      });
      return true;
    }
    if (cmd === 'logic-remove-role') {
      const path = JSON.parse(el.dataset.path);
      commit(() => {
        const value = getPath(statement().Resource, path),
          tokens = (Array.isArray(value) ? value : [value]).filter(Boolean);
        tokens.splice(Number(el.dataset.index), 1);
        setPath(statement().Resource, path, tokens);
      }, 'Removed role from condition');
      return true;
    }
    return false;
  }

  const schemaData = {
    classes: snapshot.classes
  };
  const schemaHints = new Map();

  function schemaKey(scope) {
    return state.rid + ':' + state.statement + ':' + scope;
  }

  function schemaInfo(c, path) {
    const [scope, accessor, ...rest] = c.Left.split('.'), types = typeContext(statement().Resource, path, scope), hint = schemaHints.get(
        schemaKey(scope)) ?? '', type = types.length === 1 ? types[0] : !types.length || types.includes(hint) ? hint : '', prop = genericField(c.Left) ?? (!rest
      .length ? schemaData.classes[type]?.find(p => p.accessor === accessor) : null);
    return {
      scope,
      accessor,
      types,
      type,
      prop
    };
  }

  function schemaTypeRows() {
    const types = new Set(Object.keys(schemaData.classes));

    function walk(n) {
      if (!n || typeof n !== 'object') return;
      const c = n.Condition;
      if (c && ['resource.type', 'new.type'].includes(c.Left)) {
        for (const t of Array.isArray(c.Right) ? c.Right : [c.Right])
          if (typeof t === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(t)) types.add(t);
      }
      Object.values(n).forEach(v => {
        if (typeof v === 'object') walk(v);
      });
    }
    model.policies.forEach(p => walk(p.content));
    return [...types].sort().map(t => ({
      rid: t,
      id: t,
      label: t,
      secondary: schemaLoaded.has(t) ? schemaData.classes[t].length + ' properties' : 'Browse live properties',
      icon: 'type',
      depth: 0
    }));
  }

  function schemaFieldRows(p) {
    return propertyChoices(p.scope, schemaData.classes[p.browseType], p.browseType);
  }

  function listValuePreview(prop, items) {
    if (!items.length) return '<span><strong>Choose item…</strong><small>'+esc(prop.listSet.name)+'</small></span>';
    return '<span class="list-value-preview">'+items.map(item=>
      `<span class="list-value-pair"><strong>${esc(item.label)}</strong><code>${esc(item.id)}</code></span>`).join('')+'</span>';
  }

  function schemaCondition(node, path) {
    const c = node.Condition;
    if (!c || typeof c.Left !== 'string' || c.Right && typeof c.Right === 'object' && (!Array.isArray(c.Right) || c.Right.some(x => x &&
        typeof x === 'object'))) return unknown(node, path);
    const info = schemaInfo(c, path),
      isType = ['resource.type', 'new.type'].includes(c.Left),
      list = info.prop?.listSet,
      values = Array.isArray(c.Right) ? c.Right : [c.Right];
    const currentLabel = info.accessor === 'type' ? 'Object type' : info.prop?.label ?? ({
      model: 'Model',
      id: 'Business ID',
      name: 'Name',
      parent: 'Parent object',
      linkedTo: 'Linked object',
      createdBy: 'Created by',
      ownership: 'Owner'
    } [info.accessor] ?? info.accessor ?? c.Left);
    const selectedItems = list ? selectedListItems(info.prop, c.Right) : [],
      missing = list?.partial ? 0 : selectedItems.filter(item => !item.known).length;
    const selectValue = isType || !!list,
      unfamiliar = ['resource', 'new'].includes(info.scope) && schemaLoaded.has(info.type) && !info.prop && !['type', 'model'].includes(info
        .accessor);
    const showLabel = !info.prop?.builtin && info.prop?.label && info.prop.label !== info.accessor;
    const prefix = c.Left.match(/^(resource|new|user)\./)?.[0] ?? '';
    const hint = comparisonHint(c);
    const sourceHint = createOnly() && info.scope === 'resource' ? 'Create has no resource. Choose a new field instead.' : '';
    const literalControl = typeof c.Right==='string'?`<textarea class="condition-value" rows="1" aria-label="Condition value" title="${esc(c.Right)}" spellcheck="false" data-condition='${encode([...path,'Condition','Right'])}'>${esc(c.Right)}</textarea>`:`<button class="schema-slot schema-value" data-command="edit-condition-value" ${pathAttrs(path)} aria-label="Edit condition value as JSON" title="Edit value without changing its JSON type"><code>${esc(JSON.stringify(c.Right??null, null, 2))}</code>${icon('edit')}</button>`;
    const typePreview = '<span class="type-value-preview">'+(values.filter(Boolean).map(value=>'<code>'+esc(value)+'</code>').join('')||'<strong>Choose type…</strong>')+'</span>';
    return `<div class="schema-condition"><div class="logic-predicate"><div class="logic-comparison"><div class="schema-slot schema-source-control" data-source="${esc(info.scope)}">${['new.','resource.'].includes(prefix)?`<button type="button" class="schema-source" data-command="schema-source" ${pathAttrs(path)} aria-label="Value source: ${esc(prefix.slice(0,-1))}" title="Change value source">${esc(prefix)}</button>`:''}<button type="button" class="schema-field-picker schema-property" data-command="schema-property" ${pathAttrs(path)} aria-label="Choose property: ${esc(c.Left)}" title="${esc(c.Left+' · '+(info.prop?.description||currentLabel))}"><span><code>${esc(prefix?c.Left.slice(prefix.length):c.Left)}</code>${showLabel?'<strong>'+esc(currentLabel)+'</strong>':''}</span>${icon('down')}</button></div><button class="schema-operator" data-command="schema-operator" ${pathAttrs(path)} aria-label="Comparison: ${esc(c.Comparison??'=')}">${esc(comparisonLabels[c.Comparison]??c.Comparison??'is')}${icon('down')}</button>${!['Empty','NotEmpty'].includes(c.Comparison)?selectValue?`<button class="schema-slot schema-value ${values.every(v=>!v)?'placeholder':''}" data-command="schema-value" ${pathAttrs(path)} aria-label="Choose ${isType?'object type':'list item'}: ${esc(list?selectedItems.map(i=>i.label+' ('+i.id+')').join(', '):values.join(', '))}" title="${esc(list?selectedItems.map(i=>i.label+' — '+i.token).join('\n'):values.join(', '))}">${list?listValuePreview(info.prop,selectedItems):typePreview}${icon('down')}</button>`:literalControl:''}</div>${logicTools(path)}</div>${hint?'<div class="schema-note">'+esc(hint)+'</div>':''}${sourceHint?'<div class="schema-note">'+esc(sourceHint)+'</div>':''}${missing?'<div class="schema-note">'+missing+' selected value'+(missing===1?'':'s')+' not found in this list. Open the value to review.</div>':''}${unfamiliar?'<div class="schema-note">'+esc(c.Left)+' is not in the loaded '+esc(info.type)+' properties. Value kept.</div>':''}${info.prop&&/List|Tag/.test(info.prop.configClass)&&!list?'<div class="schema-note">List metadata is unavailable. Existing value preserved.</div>':''}</div>`;
  }

  function schemaEntries(p) {
    const rows = p.stage === 'types' ? schemaTypeRows().filter(r => !p.contextTypes.length || p.contextTypes.includes(r.rid)) : p.mode ===
      'property' ? schemaFieldRows(p) : p.rows;
    return searchChoices(rows, p.query);
  }

  function propertyContext(p) {
    const hint = p.scope === 'new' ? 'new: request fields; Create may also use defaults.'
      : createOnly() ? 'Create has no resource. Use new.' : '';
    const typeHint = p.contextTypes.length === 1 ? 'Type from this rule' : 'Browse a type to see its properties; this does not add a condition.';
    return `<div class="schema-context schema-property-context"><div class="schema-context-tools"><div class="schema-scope" role="group" aria-label="Value source">${['resource','new'].map(scope=>`<button type="button" data-command="schema-scope" data-scope="${scope}" class="${p.scope===scope?'active':''}" aria-pressed="${p.scope===scope}" title="${scope==='resource'?'Saved object':'Request fields; Create may also use defaults'}">${scope}</button>`).join('')}</div><button type="button" class="schema-browse" data-command="schema-browse" title="${typeHint}" ${p.contextTypes.length===1?'disabled':''}>${icon('type')}<span>${p.stage==='types'?'Back to properties':esc(p.browseType||'Type properties…')}</span>${icon('down')}</button></div>${hint?'<small>'+hint+'</small>':''}</div>`;
  }

  function renderSchemaPicker(p) {
    if (p.mode === 'operator') {
      renderComparisonPicker(p);
      return;
    }
    const rows = p.entries.slice(0, 100);
    p.index = Math.min(Math.max(-1, p.index), rows.length - 1);
    if (p.index < 0 || rows[p.index]?.reason) p.index = nextChoice(rows, p.index, 'ArrowDown');
    $('#picker-types').innerHTML = p.principalKinds ? `<div class="picker-type-list">${p.principalKinds.map(kind => `<button type="button" data-command="create-principal-kind" data-kind="${kind}" aria-pressed="${kind === p.principalKind}" class="${kind === p.principalKind ? 'active' : ''}">${kind === 'User' ? 'Users' : 'Groups'}</button>`).join('')}</div>` : p.referenceClass ?
      `<div class="reference-context"><span>Defined on</span><button type="button" data-command="reference-types" title="Choose another defining class">${icon('type')}<code>${esc(p.referenceClass)}</code>${icon('down')}</button></div>` : p.mode === 'property' ?
      propertyContext(p) :
      p.description ?
      `<div class="schema-context schema-list-context"><span>${esc(p.description)}</span>${p.detail?'<code>'+esc(p.detail)+'</code>':''}</div>` :
      '';
    let group = '';
    $('#picker-results').innerHTML = rows.map((r, i) => {
        const chosen = p.multi ? p.selectedValues.includes(r.rid) : r.rid === p.selected;
        const heading = r.group && r.group !== group && !p.query ? `<div class="picker-group" role="presentation">${esc(r.group)}</div>` :
          '';
        group = r.group;
        return heading +
          `<button type="button" tabindex="-1" role="option" aria-selected="${chosen}" aria-disabled="${!!r.reason}" class="picker-option ${i===p.index?'focused':''} ${chosen?'chosen':''}" id="pick-${i}" style="--depth:${p.roleHierarchy&&!p.query?Math.min(r.depth??0,3):0}" data-command="picker-select" data-index="${i}" title="${esc(r.reason||r.description||r.itemRid||r.rid)}">${p.multi?'<span class="schema-check '+(chosen?'checked':'')+'">'+(chosen?icon('valid'):'')+'</span>':''}${p.roleHierarchy&&r.level?roleMark(r.level):p.multi||p.mode==='operator'?'':icon(r.icon??'sliders')}<span><strong>${esc(r.label)}</strong><small>${esc(r.reason||r.secondary||'')}${p.roleHierarchy&&p.query&&r.detail?'<br>'+esc(r.detail):''}</small></span>${r.detail&&!p.roleHierarchy?'<em>'+esc(r.detail)+'</em>':''}${!p.multi&&chosen?icon('valid'):''}</button>`;
      }).join('') ||
      `<div class="picker-empty" ${p.loadError?'role="alert"':''}>${p.loading||p.loadError?esc(p.emptyMessage):p.query?'No matches. Try a name, ID, or a shorter phrase.':p.emptyMessage?esc(p.emptyMessage):p.mode==='property'?'Choose a type above to browse its properties.':'This list has no loaded items.'}</div>`;
    renderPickerSelection(p);
    $('#picker-query').setAttribute('aria-activedescendant', p.index >= 0 ? 'pick-' + p.index : '');
    $('#picker-footer').innerHTML =
      `<span class="picker-keys" role="status">${p.loadError?'Search failed':(p.principalKind||p.listProperty?.listSet?.partial)?(p.loading?'Searching…':p.entries.length+' results'+(p.hasMore?' · refine search':'')):(p.multi?'Enter toggles':'↑ ↓ choose · Enter select')}${p.entries.length>100?' · first 100':''}</span><span class="spacer"></span>${p.loadError?'<button type="button" data-command="reference-retry">Retry</button>':''}${p.noExpression?'':'<button type="button" data-command="schema-raw">Expression…</button>'}${p.reference&&p.query.trim()&&!p.entries.some(r=>r.rid===p.query.trim())?'<button type="button" data-command="picker-use-expression" title="Use typed expression · Ctrl+Enter">Use expression</button>':''}${p.multi?`<button type="button" class="primary" data-command="schema-apply" ${p.requireSelection&&!p.selectedValues.length?'disabled':''}>Apply ${p.selectedValues.length}<kbd>Ctrl ↵</kbd></button>`:''}`;
  }

  function openSchemaPicker(anchor, options) {
    showPicker(anchor, {
      kind: 'schema',
      ...options
    });
    $('#picker-query').setAttribute('aria-label', 'Search ' + (options.mode === 'property' ? 'properties' : options.mode === 'type' ?
      'types' : options.mode === 'list' ? 'list items' : 'comparisons'));
    $('#picker-query').placeholder = options.mode === 'operator' ? 'Find a comparison…' : options.mode === 'property' ?
      'Find a property by label or ID…' : options.mode === 'list' ? 'Find an item in this list…' : 'Search…';
  }

  function propertyPicker(anchor, path) {
    const c = getPath(statement().Resource, path).Condition,
      info = schemaInfo(c, path),
      scope = ['new', 'resource'].includes(info.scope) ? info.scope : 'resource';
    openSchemaPicker(anchor, {
      mode: 'property',
      title: 'Choose a property',
      path,
      scope,
      browseType: info.type,
      contextTypes: info.types,
      selected: c.Left,
      select: (left) => {
        commit(() => setPath(statement().Resource, [...path, 'Condition'], changeField(c, left)),
          'Property changed · choose its value');
        const next = $$('[data-command="schema-value"]').find(b => b.dataset.path === JSON.stringify(path));
        if (next) void schemaCommand('schema-value', next).catch(showError);
        else ($$('[data-command="edit-condition-value"]').find(b => b.dataset.path === JSON.stringify(path)) ??
          $$('[data-condition]').find(b => b.dataset.condition === JSON.stringify([...path, 'Condition', 'Right'])))?.focus();
      }
    });
  }

  function valuePicker(anchor, path) {
    const c = getPath(statement().Resource, path).Condition,
      info = schemaInfo(c, path),
      isType = ['resource.type', 'new.type'].includes(c.Left),
      multi = c.Comparison !== 'ExactTypeOf' && (Array.isArray(c.Right) || multiComparisons.includes(c.Comparison)),
      known = isType ? schemaTypeRows() : listChoiceRows(info.prop);
    if (!isType && !info.prop?.listSet) return;
    const values = (Array.isArray(c.Right) ? c.Right : [c.Right]).filter(v => v !== '' && v != null);
    const rows = [...known, ...values.filter(v => !known.some(r => r.rid === v)).map(v => ({
      rid: v,
      label: String(v),
      secondary: info.prop?.listSet?.partial ? 'Existing value · search to resolve' : 'Existing value · not found in this loaded list',
      icon: 'help',
      depth: 0
    }))];
    openSchemaPicker(anchor, {
      mode: isType ? 'type' : 'list',
      listProperty: isType ? undefined : info.prop,
      requireSelection: true,
      title: isType ? 'Choose object type' : 'Choose ' + (info.prop.label || info.accessor),
      path,
      rows,
      multi,
      selectedValues: [...values],
      selected: values[0],
      description: isType ? info.scope + '.type' : info.prop.listSet
        .name,
      detail: isType ? 'Names from the loaded environment' : info.type + ' / ' + info.prop.listSet.id,
      select: (value) => {
        if (!isType && known.some(r => r.rid === value)) value = chooseListValue(info.prop, [value], false);
        commit(() => c.Right = value, 'Condition value updated');
      }
    });
  }
  async function schemaCommand(cmd, el) {
    if (cmd === 'schema-source') {
      const path = JSON.parse(el.dataset.path), c = getPath(statement().Resource, path).Condition,
        [scope, ...parts] = c.Left.split('.'), accessor = parts.join('.');
      choicePicker(el, { title: 'Value source', selected: scope, rows: [
        { rid:'resource', label:'resource', secondary:'resource.' + accessor, description:'Saved object' },
        { rid:'new', label:'new', secondary:'new.' + accessor, description:'Request fields; Create may also use defaults' }
      ], select: source => {
        if (scope === source) return;
        const fromTypes = typeContext(statement().Resource, path, scope), toTypes = typeContext(statement().Resource, path, source),
          fromProp = schemaData.classes[fromTypes[0]]?.find(p => p.accessor === accessor),
          toProp = schemaData.classes[toTypes[0]]?.find(p => p.accessor === accessor),
          incompatible = fromProp && toProp && (fromProp.reference !== toProp.reference || fromProp.configClass !== toProp.configClass || fromProp.listSet?.rid !== toProp.listSet?.rid);
        commit(() => setPath(statement().Resource, [...path,'Condition'], incompatible ? changeField(c, source + '.' + accessor) : { ...c, Left:source + '.' + accessor }), incompatible ? 'Source changed · choose a compatible value' : 'Value source changed');
      } });
      return true;
    }
    if (cmd === 'schema-property') {
      // General fields work immediately, even while class metadata is loading.
      // renderPicker refreshes the class-specific rows when that read completes.
      propertyPicker(el, JSON.parse(el.dataset.path));
      return true;
    }
    if (cmd === 'schema-value') {
      const record = current(), index = state.statement;
      const info = schemaInfo(getPath(statement().Resource, JSON.parse(el.dataset.path)).Condition, JSON.parse(el.dataset.path));
      if (info.type) await loadSchema(info.type);
      if (current() !== record || state.statement !== index || !el.isConnected) return true;
      valuePicker(el, JSON.parse(el.dataset.path));
      return true;
    }
    if (cmd === 'schema-operator') {
      operatorPicker(el, JSON.parse(el.dataset.path));
      return true;
    }
    if (cmd === 'schema-scope') {
      const p = state.picker;
      p.scope = el.dataset.scope;
      const types = typeContext(statement().Resource, p.path, p.scope);
      p.contextTypes = types;
      const hint = schemaHints.get(schemaKey(p.scope)) ?? '';
      p.browseType = types.length === 1 ? types[0] : !types.length || types.includes(hint) ? hint : '';
      p.index = 0;
      renderPicker();
      return true;
    }
    if (cmd === 'schema-browse') {
      state.picker.stage = state.picker.stage === 'types' ? '' : 'types';
      state.picker.query = '';
      $('#picker-query').value = '';
      state.picker.index = 0;
      renderPicker();
      $('#picker-query').focus();
      return true;
    }
    if (cmd === 'schema-apply') {
      const p = state.picker,
        values = [...p.selectedValues];
      if (p.requireSelection && !values.length) {
        status('Choose at least one subject.');
        return true;
      }
      closePicker(false);
      p.select(values);
      return true;
    }
    if (cmd === 'schema-raw') {
      const path = state.picker.path;
      closePicker(false);
      await command('edit-node', {
        dataset: {
          path: JSON.stringify(path)
        }
      });
      return true;
    }
    return false;
  }

  function roleHasChildren(rid) {
    return model.roles.some(r => r.parent === rid) || model.scope.some(r => r.parent === rid);
  }

  function definitionLabel(row) {
    if (row.global) return row.subjectName ?? row.subjectId ?? row.subject;
    if (row.kind === 'RoleAssignment') return schemaData.classes[row.source]?.find(p => p.accessor === row.field)?.label ?? row.field ?? row
      .name;
    const meta = reachDirections[row.kind];
    return row.kind.startsWith('Hierarchical') ? meta?.label ?? row.kind : (row.field?.split('.').at(-1) || 'Choose reference…');
  }

  function definitionDescription(row) {
    if (row.global) return row.mode + ' assignment · everywhere';
    if (row.kind === 'RoleAssignment') return 'Field assignment · ' + row.source + ' · ' + row.field;
    return 'Delegation · ' + (reachDirections[row.kind]?.label ?? row.kind) + (row.field ? ' · ' + row.field : '');
  }

  function renderDefinitionTree(roleRid, depth) {
    if (treeRemaining <= 0) { treeTruncated = true; return ''; }
    const rows = roleDefinitions(model, roleRid);
    const search = treeRoleSearch.get(roleRid), closed = state.search ? state.searchClosed : state.closed;
    const byId = new Map(rows.map(r => [r.rid, r])), parents = new Set(rows.filter(r => !search || search.roleMatch ||
      search.definitions.has(r.rid)).map(r => r.parent));
    const visible = rows.filter(row => {
      if (search && !search.roleMatch && !search.definitions.has(row.rid)) return false;
      let parent = row.parent;
      while (parent !== roleRid) {
        if (closed.has(parent)) return false;
        parent = byId.get(parent)?.parent;
        if (!parent) return false;
      }
      return true;
    });
    const shown = visible.slice(0, treeRemaining);
    treeTruncated ||= shown.length < visible.length;
    treeRemaining -= shown.length;
    return shown.map(row => {
      const children = parents.has(row.rid),
        open = !closed.has(row.rid),
        selected = state.scopeSelection === row.rid && !state.historyShowing && !state.reviewing;
      const matches = search?.matches.has(row.rid), description = definitionDescription(row);
      const direction = reachDirections[row.kind]?.label;
      const secondary = row.kind === 'RoleAssignment' ? row.source : row.kind.startsWith('Hierarchical') ? '' :
        [matches && !queryMatches(state.search, definitionLabel(row), row.field, row.source, row.id, row.rid) ? direction : '',
          row.field?.includes('.') ? row.field : ''].filter(Boolean).join(' · ');
      const glyph = row.global ? 'globe' : row.kind === 'RoleAssignment' ? 'fieldAssignment' : reachDirections[row.kind]?.icon ?? 'scope';
      return `<button class="tree-row definition-tree-row ${open?'expanded':''} ${selected?'selected':''} ${search?(matches?'search-match':'search-context'):''}" role="treeitem" tabindex="-1" aria-level="${depth+row.depth+1}" aria-selected="${selected}" ${children?'aria-expanded="'+open+'"':''} style="--depth:${depth+row.depth}" data-scope-node="${row.rid}" data-owner-role="${roleRid}" data-command="open-definition" data-search-match="${!!matches}" data-search-rank="${recordSearchRank({name:definitionLabel(row),id:row.field,rid:row.rid},state.search)}" title="${esc(description)}" aria-label="${esc((row.global?'Global assignment':row.kind==='RoleAssignment'?'Assignment':'Delegation')+': '+definitionLabel(row))}"><span class="caret ${children?'':'empty'}" ${children?'data-collapse="'+row.rid+'"':''}>${icon('down')}</span>${icon(glyph)}<span class="tree-label"><span class="definition-tree-label">${highlighted(definitionLabel(row))}</span>${state.search&&secondary?'<small>'+highlighted(secondary)+'</small>':''}</span>${dirtyMark(row.rid)}</button>`;
    }).join('');
  }

  function renderRoleBranch(role, depth) {
    if (treeRemaining <= 0) { treeTruncated = true; return ''; }
    return treeRecord(role, 'role', depth) + (state.closed.has(role.rid) ? '' : (treeChildren.roles.get(role.rid) ?? []).map(r =>
      renderRoleBranch(r, depth + 1)).join('') + renderDefinitionTree(role.rid, depth));
  }

  function markScopeEditor() {
    $$('.definition-focus').forEach(el => el.classList.remove('definition-focus'));
    if (!state.scopeSelection) return null;
    const target = $(`[data-scope-editor="${CSS.escape(state.scopeSelection)}"]`);
    target?.classList.add('definition-focus');
    return target;
  }

  function openDefinition(rid) {
    const owner = scopeOwner(model, rid);
    if (!owner || !model.scope.some(row => row.rid === rid)) return;
    openRecord('role', owner, rid);
    mountFastChoices();
    revealDefinitionEditor(true);
  }

  function revealDefinitionPath(rid) {
    const seen = new Set();
    while (rid && !seen.has(rid)) {
      seen.add(rid);
      state.closed.delete(rid);
      state.searchClosed?.delete(rid);
      rid = model.scope.find(row => row.rid === rid)?.parent;
    }
  }

  function revealDefinitionEditor(focus) {
    const rid = state.scopeSelection;
    if (!rid) return;
    for (const section of $$('.reach-section,.section'))
      if (section.querySelector(`[data-scope-editor="${CSS.escape(rid)}"]`)) {
        section.classList.remove('collapsed');
        const label = section.querySelector('.section-label');
        if (label) {
          collapsedSections.delete(label.dataset.section);
          label.setAttribute('aria-expanded', 'true');
        }
      }
    const target = markScopeEditor();
    target?.scrollIntoView({
      block: 'center'
    });
    if (target && focus) {
      target.tabIndex = -1;
      (target.querySelector('textarea[data-scope="field"]:not([disabled])') ?? target.querySelector(
        'button[aria-label="Assignment field"],button[data-command="reach-direction"]') ?? target).focus({
        preventScroll: true
      });
    }
  }

  function roleTreeCommand(cmd, el) {
    if (cmd === 'open-definition') {
      openDefinition(el.dataset.scopeNode ?? el.dataset.rid);
      return true;
    }
    if (cmd === 'context-add-delegation') {
      if (!model.scope.some(r => r.rid === el.dataset.rid)) return true;
      openDefinition(el.dataset.rid);
      const anchor = $(`#tree [data-scope-node="${el.dataset.rid}"]`);
      if (anchor) directionChoices(anchor, 'reach-insert', el.dataset.rid);
      return true;
    }
    if (cmd === 'context-new-child') {
      createRecord('role', false, false, el.dataset.rid);
      return true;
    }
    if (cmd === 'context-add-assignment' || cmd === 'context-add-global') {
      openRecord('role', el.dataset.rid);
      if (cmd.endsWith('global')) void command('add-global', el).catch(error => status(error.message));
      else addAssignment();
      return true;
    }
    if (cmd === 'context-history') {
      openRecord(el.dataset.kind, el.dataset.rid);
      state.historyCurrent = true;
      state.historyQuery = '';
      state.historySelected = null;
      void workspaceCommand('history', el);
      return true;
    }
    return false;
  }

  function historyTitle(event) {
    return event.message.replace(/ · Ctrl\+Z.*$/, '').replace(/local /g, '').replace(/ · choose.*$/, '');
  }

  function historyNames(event) {
    const names = event.patch.map(p => {
      const owner = scopeOwner(event.after, p.rid) ?? scopeOwner(event.before, p.rid);
      return owner ? (event.after.roles.find(r => r.rid === owner) ?? event.before.roles.find(r => r.rid === owner))?.name : p.name;
    });
    return [...new Set(names.filter(Boolean))].join(' · ');
  }

  function historyGlyph(event) {
    const p = event.patch[0];
    return p.collection === 'roles' ? 'role' : p.collection === 'policies' ? 'policy' : p.collection === 'folders' ? 'folder' : p
      .collection === 'globals' ? 'globe' : 'scope';
  }

  function historyField(p) {
    if (p.field === 'field' && p.definitionKind === 'RoleAssignment') return 'People field';
    return p.field === 'parent' ? (p.collection === 'roles' ? 'Hierarchy' : ['policies', 'folders'].includes(p.collection) ? 'Folder' :
      'Scope') : ({
      name: 'Name',
      id: 'Business ID',
      field: 'Reference',
      kind: 'Direction',
      source: 'Object type',
      mode: 'Assign to',
      subjectId: 'User ID',
      subject: 'Principal RID',
      enabled: 'Enabled',
      content: 'Rules'
    } [p.field] ?? p.field ?? (p.before ? 'Removed record' : 'New record'));
  }

  function visibleHistory() {
    const query = (state.historyQuery ?? '').trim().toLowerCase();
    return journal.filter(e => !e.reverses && e.patch.length && (!state.historyCurrent || historyRecordIds(e).includes(state.historyRecord
      ?.rid ?? state.rid)) && (!query || (historyTitle(e) + ' ' + historyNames(e) + ' ' + JSON.stringify(e.patch)).toLowerCase()
      .includes(query))).slice().reverse();
  }

  function renderHistory() {
    $('#editor').classList.add('history-workspace');
    const record = state.historyRecord,
      recordScope = record?.rid ? (record.kind === 'role' ? 'Role: ' : 'Policy: ') + (record.name || record.rid) : 'Selected record';
    $('#editor').innerHTML =
      `<section class="history-browser"><header class="history-toolbar"><h1 id="history-title">${icon('history')}Edit history</h1><div class="choice-segment" role="group" aria-label="History scope"><button data-command="history-filter" data-value="all" aria-pressed="${!state.historyCurrent}">All records</button><button data-command="history-filter" data-value="record" aria-pressed="${!!state.historyCurrent}" ${record?.rid?'':'disabled'} title="${esc(recordScope)}">${esc(recordScope)}</button></div><label class="history-search">${icon('search')}<input type="search" id="history-search" aria-label="Search edit history" placeholder="Find a change…" value="${esc(state.historyQuery??'')}"></label>${ib('close','history-close','Return to editor')}</header><div id="history-content" class="history-content"></div><footer class="history-session-note">Local draft history · cleared after Apply or Reload</footer></section>`;
    renderHistoryContent();
  }

  function renderHistoryContent() {
    const list = visibleHistory();
    if (!list.some(e => e.id === state.historySelected)) state.historySelected = list[0]?.id;
    const selected = list.find(e => e.id === state.historySelected);
    $('#history-content').innerHTML = !list.length ?
      `<div class="history-empty">${journal.some(e=>!e.reverses)?'No matching changes. Try All changes or another search.':'No changes yet. Your edits will appear here, ready to inspect and undo.'}</div>` :
      `<div class="history-list" role="listbox" aria-label="Changes">${list.map(e=>{const step=historyStep(model,e,false),active=e.id===state.historySelected;return `<button class="history-row ${active?'selected':''}" role="option" aria-selected="${active}" tabindex="${active?0:-1}" data-command="history-select" data-event="${e.id}">${icon(historyGlyph(e))}<span class="history-row-text"><strong>${esc(historyTitle(e))}</strong><small>${esc(historyNames(e))}</small></span><span class="history-row-meta"><time>${esc(e.at)}</time><span class="history-state ${step.status==='Undone'?'is-undone':''}">${esc(step.status)}</span></span></button>`;}).join('')}</div><article id="history-detail" class="history-detail" aria-label="Selected change">${historyDetail(selected)}</article>`;
  }

  function historyDetail(event) {
    const step = historyStep(model, event),
      target = historyRecordIds(event).map(rid => model.roles.find(r => r.rid === rid) ?? model.policies.find(r => r.rid === rid)).find(
        Boolean),
      kind = target && model.roles.includes(target) ? 'role' : 'policy';
    return `<header class="history-detail-heading"><div><h2>${esc(historyTitle(event))}</h2><p>${esc(historyNames(event))}</p></div></header><div class="history-detail-actions"><button data-command="history-apply" data-event="${event.id}" ${step.reason?'disabled':''}>${icon(step.kind==='restore'?'redo':'undo')}${step.kind==='restore'?'Restore change':'Undo change'}</button>${target?button('open','history-open','Open '+kind,`data-kind="${kind}" data-rid="${target.rid}"`):''}</div>${step.reason?'<p class="history-blocked">'+esc(step.reason)+'</p>'+historyDependencies(step):''}<div class="history-diff"><div class="history-diff-head"><span>Change</span><span>Before</span><span>After</span></div>${event.patch.flatMap(historyDetails).map(p=>`<div class="history-diff-row"><div class="history-diff-field"><strong>${esc(historyField(p))}</strong>${event.patch.some(x=>x.rid!==p.rid)?'<small>'+esc(p.name)+'</small>':''}</div><div class="history-before"><span class="history-mobile-label">Before</span><pre>${esc(historyValue(p.before,p,event.before))}</pre></div><div class="history-after"><span class="history-mobile-label">After</span><pre>${esc(historyValue(p.after,p,event.after))}</pre></div></div>`).join('')}</div>`;
  }

  function historyDependencies(step) {
    const events = [...new Set((step.dependents ?? []).map(row => journal.slice().reverse().find(e => !e.reverses && e.patch.some(p => p
      .rid === row.rid))).filter(Boolean))];
    return events.length ? '<div class="history-dependencies">' + events.map(e => button('arrow', 'history-follow', 'Review: ' +
      historyTitle(e), 'data-event="' + e.id + '"')).join('') + '</div>' : '';
  }

  function historyBrowserCommand(cmd, el) {
    if (cmd === 'history-follow') {
      const event = journal.find(e => e.id === Number(el.dataset.event));
      if (!event) return true;
      state.historyQuery = '';
      state.historySelected = event.id;
      if (state.historyCurrent && !historyRecordIds(event).includes(state.historyRecord?.rid)) state.historyCurrent = false;
      renderHistory();
      return true;
    }

    if (cmd === 'history-select') {
      state.historySelected = Number(el.dataset.event);
      renderHistoryContent();
      return true;
    }
    if (cmd === 'history-filter') {
      state.historyCurrent = el.dataset.value === 'record';
      state.historySelected = null;
      renderHistory();
      return true;
    }
    if (cmd === 'history-open') {
      openRecord(el.dataset.kind, el.dataset.rid);
      return true;
    }
    if (cmd === 'history-apply') {
      const event = journal.find(e => e.id === Number(el.dataset.event));
      if (!event) return true;
      const step = historyStep(model, event);
      if (step.reason) {
        status(step.reason);
        return true;
      }
      if (historyBlocked(step.patch)) return true;
      commit(() => model = step.model, (step.kind === 'restore' ? 'Restored: ' : 'Undid: ') + historyTitle(event));
      journal.at(-1).reverses = event.id;
      state.historySelected = event.id;
      renderHistory();
      return true;
    }
    return false;
  }

  function installHistoryBrowser() {
    document.addEventListener('input', e => {
      if (e.target.id === 'history-search') {
        state.historyQuery = e.target.value;
        renderHistoryContent();
      }
    });
    document.addEventListener('keydown', e => {
      if (!e.target.matches('.history-row') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const rows = $$('.history-row'),
        i = rows.indexOf(e.target),
        next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key ===
          'ArrowDown' ? 1 : -1)));
      state.historySelected = Number(rows[next].dataset.event);
      renderHistoryContent();
      $(`.history-row[data-event="${state.historySelected}"]`)?.focus();
    });
  }

  // This iteration keeps records, previews, JSON and history on one draft model.
  const journal = [];
  let historySequence = 0,
    inputHistory = null;

  function editorPreference() {
    try {
      return localStorage.getItem('companion.access.editor') === 'json' ? 'json' : 'rules';
    } catch {
      return 'rules';
    }
  }

  function policyEditorView() {
    // An unfinished JSON draft takes precedence so navigation cannot hide it
    // behind the older Rules model. This does not change the saved preference.
    return state.raw.has(state.rid) ? 'json' : editorPreference();
  }

  function saveEditorPreference(value) {
    try {
      localStorage.setItem('companion.access.editor', value);
    } catch {
      /* Preference storage may be unavailable. */ }
    status('Default editor: ' + (value === 'json' ? 'JSON' : 'Rules'));
  }

  function newHistory(before, message, patch = changePatch(before, model)) {
    const event = {
      id: ++historySequence,
      before: historyContext(before, patch),
      after: historyContext(model, patch),
      message: message ?? 'Local change',
      at: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      patch
    };
    history.push(event);
    journal.push(event);
    if (history.length > 60) history.shift();
    if (journal.length > 80) journal.shift();
    while (history.length && !journal.includes(history[0])) history.shift();
    future.length = 0;
    return event;
  }

  function commit(fn, message) {
    changeCache = null;
    inputHistory = null;
    editingElement = null;
    const before = clone(model);
    fn();
    const patch = changePatch(before, model);
    if (!patch.length) return;
    revision++;
    newHistory(before, message, patch);
    staleTests();
    render();
    status(message ?? 'Local change');
  }

  function beginInputHistory(el) {
    const collection = el.dataset.scope ? 'scope' : state.kind === 'role' ? 'roles' : 'policies';
    const rid = el.dataset.scope ? el.dataset.rid : state.rid;
    inputHistory = {
      // An input session changes one record. Keep untouched records shared;
      // historyContext copies the retained identities before another edit starts.
      before: { ...model, [collection]: model[collection].map(row => row.rid === rid ? clone(row) : row) },
      collection,
      rid,
      lastPatch: '[]',
      event: null,
      message: el.dataset.record === 'name' ? 'Rename ' + (current()?.name ?? 'record') : el.dataset.scope ? 'Edit delegation reference' :
        'Edit condition value'
    };
  }

  function updateInputHistory() {
    if (!inputHistory) return;
    const { before, collection, rid } = inputHistory;
    const row = model[collection].find(r => r.rid === rid);
    const patch = changePatch({ [collection]: before[collection].filter(r => r.rid === rid) }, { [collection]: row ? [row] : [] });
    const patchKey = JSON.stringify(patch);
    if (patchKey !== inputHistory.lastPatch) { revision++; inputHistory.lastPatch = patchKey; }
    if (changeCache) {
      const original = baseline[collection].find(r => r.rid === rid);
      changeCache.rows = changeCache.rows.filter(d => d.r.rid !== rid);
      changeCache.ids.delete(rid);
      if (JSON.stringify(original) !== JSON.stringify(row)) {
        changeCache.rows.push({ key: collection, r: row ?? original, before: original, kind: !row ? 'Delete' : original ? 'Edit' : 'Create' });
        changeCache.ids.add(rid);
      }
    }
    if (!inputHistory.event) {
      if (!patch.length) return;
      inputHistory.event = newHistory(before, inputHistory.message, patch);
    } else {
      inputHistory.event.patch = patch;
      inputHistory.event.before = historyContext(before, patch);
      inputHistory.event.after = historyContext(model, patch);
      if (!patch.length) {
        const event = inputHistory.event;
        for (const list of [history, journal]) { const index = list.indexOf(event); if (index >= 0) list.splice(index, 1); }
        inputHistory.event = null;
      }
    }
  }

  function undoHistory(redo = false) {
    const source = redo ? future : history,
      target = redo ? history : future,
      event = source.at(-1);
    if (!event || historyBlocked(event.patch)) return;
    source.pop();
    inputHistory = null;
    editingElement = null;
    target.push(event);
    const reverted = reverseChange(model, redo ? event.patch.map(p => ({
      ...p,
      before: p.after,
      after: p.before
    })) : event.patch);
    if (reverted.reason) {
      source.push(target.pop());
      status(reverted.reason);
      return;
    }
    model = reverted.model;
    revision++;
    staleTests();
    render();
    status((redo ? 'Redid: ' : 'Undid: ') + event.message);
  }

  function historyEffective(event) {
    return history.includes(event) && !history.some(e => e.reverses === event.id && historyEffective(e));
  }

  function historyDetails(p) {
    if (p.field === null) {
      const record = p.after ?? p.before,
        publicFields = p.collection === 'scope' ? (record.kind === 'RoleAssignment' ? ['source', 'field', 'parent'] : ['kind', 'field',
          'parent'
        ]) : p.collection === 'globals' ? ['mode', record.subjectId ? 'subjectId' : 'subject', 'parent'] : ['name', 'id', 'parent',
          'enabled', 'content'
        ];
      return publicFields.filter(key => record[key] !== undefined).map(field => ({
        ...p,
        field,
        definitionKind: record.kind,
        before: p.before?.[field],
        after: p.after?.[field]
      }));
    }
    if (p.field !== 'content' || !p.before || !p.after) return [p];
    const changes = [];

    function walk(before, after, path) {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const sameArrays = Array.isArray(before) && Array.isArray(after) && before.length === after.length;
      const objects = before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array
        .isArray(after);
      if (objects || sameArrays) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) walk(before[key], after[key], [...path, key]);
        return;
      }
      const label = path.map((key, i) => i === 1 && path[0] === 'Statement' ? 'Rule ' + (Number(key) + 1) : key).filter((key, i) => i !==
        0 || key !== 'Statement').join(' › ');
      changes.push({
        ...p,
        field: label,
        before,
        after
      });
    }
    walk(p.before, p.after, []);
    return changes.length <= 30 ? changes : [p];
  }

  function historyValue(value, patch, snapshot) {
    if (value === undefined) return '—';
    if (patch?.field === 'parent') {
      if (!value) return patch.collection === 'roles' ? 'Top-level roles' : ['policies', 'folders'].includes(patch.collection) ?
        'Policy root' : '—';
      const row = [...snapshot.roles, ...snapshot.folders, ...snapshot.scope].find(r => r.rid === value);
      return row?.kind === 'RoleAssignment' ? 'Assignment · ' + row.source + ' / ' + row.field : row?.name ?? String(value);
    }
    if (patch?.field === 'kind' && reachDirections[value]) return reachDirections[value].label;
    return value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function renderTabs() {
    const root = $('#tabs'), focused = root.contains(document.activeElement) ? document.activeElement.closest('.doc-tab')?.querySelector('[role="tab"]')?.dataset.tabKey : null;
    state.tabs = state.tabs.filter(t => model[t.kind === 'role' ? 'roles' : 'policies'].some(r => r.rid === t.rid));
    const tabAttrs = (key, active) => `role="tab" data-tab-key="${esc(key)}" data-tab-kind="${esc(key.split(':')[0])}" id="access-tab-${encodeURIComponent(key)}" aria-selected="${active}" aria-controls="${['test','matrix-test'].includes(key)?'dock':'editor'}" tabindex="${active?0:-1}"`;
    root.setAttribute('role', 'tablist');
    root.innerHTML = (state.performanceOpen ? `<div class="doc-tab ${state.performanceShowing&&!state.reviewing&&!state.historyShowing?'active':''}" role="presentation"><button ${tabAttrs('performance',state.performanceShowing&&!state.reviewing&&!state.historyShowing)} data-command="performance">${icon('performance')}<span>Performance</span></button>${ib('close','close-performance','Close performance','tabindex="-1"')}</div>` : '') + (state.matrixOpen ? `<div class="doc-tab ${state.matrixShowing&&!state.reviewing&&!state.historyShowing?'active':''}" role="presentation"><button ${tabAttrs('matrix',state.matrixShowing&&!state.reviewing&&!state.historyShowing)} data-command="matrix">${icon('matrix')}<span>Access matrix</span></button>${ib('close','close-matrix','Close access matrix','tabindex="-1"')}</div>` : '') + state.tabs.map(t => {
      const r = model[t.kind === 'role' ? 'roles' : 'policies'].find(x => x.rid === t.rid);
      const active = !state.performanceShowing && !state.matrixShowing && !state.testing && !state.historyShowing && !state.reviewing && !state.empty && t.rid === state.rid;
      return `<div class="doc-tab ${active?'active':''}" role="presentation"><button ${tabAttrs(t.kind+':'+t.rid,active)} data-open="${t.rid}" data-kind="${t.kind}" title="${esc(r.name)}">${icon(t.kind)}<span class="tab-label">${esc(r.name)}</span>${dirtyMark(r.rid)}</button>${ib('close','close-tab','Close '+r.name+' (Delete)','data-rid="'+r.rid+'" tabindex="-1"')}</div>`;
    }).join('') + (state.objectTest ? `<div class="doc-tab ${state.testing&&!state.matrixTesting&&!state.reviewing&&!state.historyShowing?'active':''}" role="presentation"><button ${tabAttrs('test',state.testing&&!state.matrixTesting&&!state.reviewing&&!state.historyShowing)} data-command="open-test">${icon('check')}<span>Access test</span></button>${ib('close','close-object-test','Close access test (Delete)','tabindex="-1"')}</div>` : '') + (state.matrixTest ? `<div class="doc-tab ${state.matrixTesting&&!state.reviewing&&!state.historyShowing?'active':''}" role="presentation"><button ${tabAttrs('matrix-test',state.matrixTesting&&!state.reviewing&&!state.historyShowing)} data-command="matrix-test">${icon('run')}<span>Test · ${esc(state.matrixTest.type)}</span></button>${ib('close','close-matrix-test','Close matrix test','tabindex="-1"')}</div>` : '') + (state.reviewOpen ?
      `<div class="doc-tab review-tab ${state.reviewing&&!state.historyShowing?'active':''}" role="presentation"><button ${tabAttrs('review',state.reviewing&&!state.historyShowing)} data-command="review">${icon('changes')}<span>Pending edits</span></button>${ib('close','close-review','Close pending edits (Delete)','tabindex="-1"')}</div>` :
      '');
    const tabs = [...root.querySelectorAll('[role="tab"]')], active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    const target = tabs.find(tab => tab.dataset.tabKey === focused) ?? active ?? tabs[0];
    for (const tab of tabs) tab.tabIndex = tab === target ? 0 : -1;
    $('#editor').setAttribute('role', 'tabpanel');
    if (active) $('#editor').setAttribute('aria-labelledby', active.id);
    else $('#editor').removeAttribute('aria-labelledby');
    if (focused) target?.focus({ preventScroll: true });
    const historyButton = $('.history-actions [data-command="history"]');
    historyButton.innerHTML = icon('history');
    historyButton.setAttribute('aria-pressed', String(!!state.historyShowing));
    historyButton.setAttribute('aria-controls', 'editor');
    historyButton.title = state.historyShowing ? 'Return from history (Esc)' : 'Edit history';
    if (state.historyShowing) {
      $('#editor').setAttribute('role', 'region');
      $('#editor').setAttribute('aria-labelledby', 'history-title');
    }
  }

  $('#tabs').addEventListener('focusin', e => {
    if (!e.target.matches('[role="tab"]')) return;
    for (const tab of $$('#tabs [role="tab"]')) tab.tabIndex = tab === e.target ? 0 : -1;
  });
  $('#tabs').addEventListener('keydown', e => {
    if (!e.target.matches('[role="tab"]')) return;
    const tabs = $$('#tabs [role="tab"]'), index = tabs.indexOf(e.target);
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 :
        (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.focus();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const close = e.target.closest('.doc-tab').querySelector('[data-command="close-tab"],[data-command="close-review"],[data-command="history-close"],[data-command="close-object-test"],[data-command="close-matrix"],[data-command="close-matrix-test"],[data-command="close-performance"]');
      close?.click();
    }
  });

  function recordHead(r) {
    const id = state.idDraft.get(r.rid) ?? r.id;
    return `<header class="record-header"><span class="record-symbol ${state.kind==='role'?'role-symbol':''}">${state.kind==='role'?roleMark(ancestry(model.roles,r.rid).length):icon(state.kind)}</span><div class="record-identity"><textarea class="record-name" rows="1" data-record="name" aria-label="${state.kind==='role'?'Role':'Policy'} name" title="${esc(r.name)}" spellcheck="false">${esc(r.name)}</textarea><div class="identity-line"><label for="business-id">ID</label><textarea id="business-id" rows="1" data-identity="${r.rid}" aria-label="Business ID" spellcheck="false" title="Edit ID · Enter saves · Escape cancels">${esc(id)}</textarea><button class="id-save icon-button" data-command="save-id" title="Save ID (Enter)" aria-label="Save ID" ${id===r.id?'hidden':''}>${icon('valid')}</button></div><div id="id-error" class="field-error" role="alert"></div></div><div class="record-tools">${state.kind==='policy'?`<label class="enabled-state"><input type="checkbox" data-record="enabled" ${r.enabled?'checked':''}>Enabled</label>`:''}<button class="test-trigger ${state.testOpen.has(testKey())?'active':''}" data-command="check" aria-expanded="${state.testOpen.has(testKey())}">${icon('check')}<span>${state.kind==='role'?'Test role':'Test access'}</span></button>${ib('more','record-more','Record actions')}</div></header>`;
  }

  function ruleTitle(s, index) {
    const note = ruleDescription(s).trim();
    if (note) return note.split(/\n/)[0];
    const acts = (Array.isArray(s.Action) ? s.Action : [s.Action]).filter(Boolean).join(', ');
    const types = [];

    function visit(n) {
      if (!n || typeof n !== 'object') return;
      if (typeof n.Condition?.Left === 'string' && n.Condition.Left.endsWith('.type')) types.push(...(Array.isArray(n.Condition.Right) ? n.Condition.Right : [n.Condition.Right])
        .filter(Boolean));
      // Only PBAC groups contain nested expressions. Literal data and notes
      // must not contribute types (or fail title rendering).
      for (const group of [n.All, n.Any]) if (Array.isArray(group)) group.forEach(visit);
    }
    visit(s.Resource);
    return (acts || 'New rule') + (types.length ? ' · ' + [...new Set(types)].join(', ') : '') || 'Rule ' + (index + 1);
  }

  function modeSwitch() {
    return `<div class="view-switch" role="group" aria-label="Preferred policy editor" title="Remembered for every policy"><button data-view="rules" class="${state.view==='rules'?'active':''}" aria-pressed="${state.view==='rules'}">${icon('sliders')}Rules</button><button data-view="json" class="${state.view==='json'?'active':''}" aria-pressed="${state.view==='json'}">${icon('json')}JSON</button></div>`;
  }

  function subjectsUI(s) {
    const tokens = Array.isArray(s.Subject) ? s.Subject : [s.Subject];
    return `<div class="subject-chips">${tokens.filter(Boolean).map(token=>{const role=model.roles.find(r=>'role:'+r.id===token);return role?`<button class="subject-link" data-command="open-role" data-rid="${role.rid}" title="Open role: ${esc(role.name)}">${icon('role')}<span>${esc(role.name)}</span>${icon('open')}</button>`:`<span class="subject-static">${icon(token==='*'?'globe':'assignment')}${esc(token==='*'?'Everyone':token)}</span>`;}).join('')}<button class="subject-edit" data-command="edit-who" aria-label="Choose policy subjects" title="Add or remove subjects">${icon('edit')}</button></div>`;
  }

  function renderPolicy() {
    const p = current();
    let html = recordHead(p);
    if (!p.content) {
      $('#editor').innerHTML = html + '<div class="empty-row">Policy content is unavailable. Reload from BMP.</div>';
      return;
    }
    if (p.invalidContent || !Array.isArray(p.content.Statement) || !p.content.Statement.length) state.view = 'json';
    state.statement = Math.max(0, Math.min(state.statement, (p.content.Statement ?? []).length - 1));
    const s = statement();
    if (state.view === 'json') {
      $('#editor').classList.add('json-workspace');
      html +=
        `<div class="policy-toolbar json-toolbar">${modeSwitch()}<span id="json-state">Entire policy</span><span class="spacer"></span><div class="json-code-actions" role="group" aria-label="Code visibility"><button type="button" data-command="json-collapse-rules" title="Collapse all policy rules">Collapse rules</button><button type="button" data-command="json-expand-all" title="Expand all code">Expand all</button></div>${ib('copy','copy-policy-json','Copy policy JSON')}${ib('reset','reset-json','Discard JSON edits')}${ib('sliders','format-json','Format JSON')}<button type="button" data-command="json-outline" class="json-outline-toggle" aria-controls="policy-json-outline" aria-pressed="${jsonOutlineVisible}" aria-expanded="${jsonOutlineVisible}" title="${jsonOutlineVisible?'Hide':'Show'} outline">${icon('list')}Outline</button><button data-command="apply-json" class="primary" title="Update JSON draft · Ctrl+S">${icon('valid')}Update draft</button></div><div class="json-editor-body"><div id="policy-json-editor"></div><aside id="policy-json-outline" aria-label="Policy outline" ${jsonOutlineVisible?'':'hidden'}></aside></div><div id="json-diagnostics" role="status"></div>`;
      $('#editor').innerHTML = html;
      return;
    }
    html +=
      `<div class="policy-toolbar rule-toolbar">${modeSwitch()}<div class="rule-navigation"><button class="rule-picker" data-command="choose-rule" title="${esc(ruleTitle(s,state.statement))}"><span class="rule-index">${state.statement+1}/${p.content.Statement.length}</span><strong>${esc(ruleTitle(s,state.statement))}</strong>${icon('down')}</button>${ib('plus','add-statement','Add rule')}${ib('more','rule-menu','Rule actions')}</div></div><div class="property-grid rule-properties"><label>Effect</label><div class="rule-effect"><div class="choice-segment" role="group" aria-label="Rule effect">${['Allow','Deny'].map(effect=>`<button type="button" data-command="rule-effect" data-effect="${effect}" aria-pressed="${pbacEffect(s.Effect)===effect}">${effect}</button>`).join('')}</div>${pbacEffect(s.Effect)==='Deny'?'<span class="effect-note">Does not override grants from other rules.</span>':pbacEffect(s.Effect)!=='Allow'?'<span class="effect-note">Unknown effect: '+esc(s.Effect??'missing')+'. Choose Allow or Deny.</span>':''}</div><label>Subjects</label>${subjectsUI(s)}<label>Actions</label><div class="action-toggles">${A.map(a=>`<label><input type="checkbox" data-action="${a}" ${pbacActions(s.Action).includes(a)?'checked':''}>${a}</label>`).join('')}</div></div>`;
    html +=
      `<section class="section">${section('Conditions','sliders',button('plus','add-condition','Condition',"data-path='[]'"))}${condition(s.Resource,[])}</section>`;
    if (p.valid === false && !p.rid.startsWith('draft:')) html += '<div class="inline-warning">' + icon('help') +
      'BMP marked this saved policy invalid.</div>';
    $('#editor').innerHTML = html;
  }

  function codePreview(value, roleId, compact = false) {
    const lines = tokenizePBAC(JSON.stringify(value, null, 2));
    const match = lines.findIndex(tokens => tokens.some(t => t.text === JSON.stringify('role:' + roleId) || t.text === JSON.stringify(roleId)));
    const start = compact ? Math.max(0, Math.min(Math.max(0, match - 2), lines.length - 6)) : 0;
    const end = compact ? Math.min(lines.length, start + 6) : lines.length;
    return (start ? '<span class="code-ellipsis" aria-label="Earlier lines omitted">…</span>' : '') + lines.slice(start, end).map(tokens => {
      const line = tokens.map(t => t.text).join(''),
        hit = line.includes(JSON.stringify('role:' + roleId)) || line.includes(JSON.stringify(roleId));
      const html = tokens.map(t => t.type ? `<span class="pbac-${t.type}">${esc(t.text)}</span>` : esc(t.text)).join('');
      return `<span class="code-line ${hit?'role-match':''}">${html}</span>`;
    }).join('') + (end < lines.length ? '<span class="code-ellipsis" aria-label="Later lines omitted">…</span>' : '');
  }

  function excerptForRole(match) {
    if (match.refs.includes('Subject')) return match.statement;
    const ref = match.refs[0].split('.'),
      nodePath = ref.slice(0, -1),
      key = nodePath.at(-1);
    return {
      [key]: getPath(match.statement, nodePath)
    };
  }

  function rolePolicyPreview(r) {
    const used = usedPolicies(r), all = state.previewAll?.has(r.rid), shown = all ? used : used.slice(0, 5);
    state.previewExpanded ??= new Set();
    state.previewCodeExpanded ??= new Set();
    if (!state.previewInitialized?.has(r.rid)) {
      state.previewInitialized ??= new Set(); state.previewInitialized.add(r.rid);
      if (used[0]) state.previewExpanded.add(r.rid + ':' + used[0].rid);
    }
    return section('Policies', 'policy', ib('search', 'find-role-policies', 'Find every policy using this role') + button('plus',
      'new-policy-for-role', 'Add policy'), used.length) + `<div class="policy-previews">${shown.map(p=>{
      const matches=rolePolicyMatches(p,r.id), acts=A.filter(a=>matches.some(m=>pbacActions(m.statement.Action).includes(a))), key=r.rid+':'+p.rid;
      return `<details class="policy-preview" data-preview="${key}" ${state.previewExpanded.has(key)?'open':''}><summary><span class="preview-chevron">${icon('down')}</span>${icon('policy')}<strong>${esc(p.name)}</strong><span class="preview-actions">${acts.map(a=>'<abbr title="'+a+'">'+a[0]+'</abbr>').join('')}</span><small>${p.enabled?'':'Disabled · '}${matches.length} ${matches.length===1?'rule':'rules'}</small></summary><div class="policy-preview-content">${matches.map(m=>{
        const full=state.previewCodeExpanded.has(key+':'+m.index), excerpt=excerptForRole(m), long=JSON.stringify(excerpt,null,2).split('\n').length>6;
        return `<div class="preview-rule"><header><span>${m.refs.some(ref=>ref==='Subject')?'Subject':'Role on a related object'} · ${esc((Array.isArray(m.statement.Action)?m.statement.Action:[m.statement.Action]).filter(Boolean).join(', '))}</span><span class="spacer"></span>${long?`<button data-command="preview-code" data-rid="${p.rid}" data-index="${m.index}" aria-expanded="${full}">${full?'Less code':'Expand code'}</button>`:''}<button data-command="open-matched-rule" data-rid="${p.rid}" data-index="${m.index}" title="${esc(ruleTitle(m.statement,m.index))}">Open rule ${m.index+1}${icon('open')}</button></header><pre tabindex="0" class="${full?'expanded-code':'compact-code'}" aria-label="Matching rule ${m.index+1}">${codePreview(excerpt,r.id,!full)}</pre></div>`;
      }).join('')}<div class="preview-context">${esc(folderPath(p.parent))}</div></div></details>`;
    }).join('')||'<div class="empty-row">No policies reference this role.</div>'}${used.length>5?`<button class="preview-all" data-command="preview-all">${all?'Show first 5':'Show all '+used.length+' policies'}${icon('down')}</button>`:''}</div>`;
  }

  function mountWorkspaceUX() {
    markScopeEditor();
    if (state.kind === 'role') {
      const sectionEl = $$('.section').find(s => s.querySelector('.section-label')?.textContent.trim().startsWith('Policies'));
      if (sectionEl) sectionEl.innerHTML = rolePolicyPreview(current());
    }
    for (const related of $$('.logic-related')) {
      const input = related.querySelector('[aria-label="Related object reference"]'),
        path = JSON.parse(input.dataset.condition),
        kind = path.at(-2);
      if (kind === 'HasAccessTo') {
        const c = getPath(statement().Resource, path.slice(0, -1));
        related.querySelector('.logic-reference').insertAdjacentHTML('beforeend',
          `<label>Across objects<select data-condition='${encode([...path.slice(0,-1),'Grouping'])}' aria-label="Related-object grouping">${option('All','All must grant',pbacGrouping(c.Grouping)??'All')}${option('Any','Any can grant',pbacGrouping(c.Grouping)??'All')}</select></label>`
          );
      }
    }
  }

  function choicePicker(anchor, options) {
    showPicker(anchor, {
      kind: 'schema',
      mode: 'choice',
      noExpression: true,
      ...options
    });
    $('#picker-query').setAttribute('aria-label', options.title);
    $('#picker-query').placeholder = 'Search…';
  }

  function folderMenu(anchor, rid) {
    const attrs = 'data-folder="' + rid + '"';
    popup(anchor, button('plus', 'new-policy-here', 'New policy here', attrs) + button('folder', 'new-folder', 'New subfolder', attrs) +
      '<hr>' + button('edit', 'rename-folder', 'Rename folder', attrs) + button('trash', 'delete-folder', 'Remove empty folder', attrs));
  }
  async function workspaceCommand(cmd, el) {
    if (cmd === 'preview-code') {
      const role = currentRole(), policy = model.policies.find(p => p.rid === el.dataset.rid);
      const match = role && policy && rolePolicyMatches(policy, role.id).find(m => m.index === Number(el.dataset.index));
      if (!match) return true;
      const key = role.rid + ':' + policy.rid + ':' + match.index, full = !state.previewCodeExpanded.has(key);
      full ? state.previewCodeExpanded.add(key) : state.previewCodeExpanded.delete(key);
      const pre = el.closest('.preview-rule').querySelector('pre');
      pre.className = full ? 'expanded-code' : 'compact-code';
      pre.innerHTML = codePreview(excerptForRole(match), role.id, !full);
      el.textContent = full ? 'Less code' : 'Expand code'; el.setAttribute('aria-expanded', String(full));
      return true;
    }
    if (historyBrowserCommand(cmd, el)) return true;
    if (cmd === 'undo' || cmd === 'redo') {
      undoHistory(cmd === 'redo');
      return true;
    }
    if (cmd === 'history') {
      if (state.historyShowing) return workspaceCommand('history-close', el);
      state.historyReturn = { performanceShowing:state.performanceShowing, matrixShowing:state.matrixShowing, matrixTesting:state.matrixTesting, matrixTest:state.matrixTest, reviewing: state.reviewing, testing: state.testing, empty: state.empty,
        rid: state.rid, kind: state.kind, statement: state.statement, scopeSelection: state.scopeSelection, objectTest: state.objectTest };
      if (!state.historyShowing) state.historyRecord = {
        rid: state.rid,
        kind: state.kind,
        name: current()?.name
      };
      state.historyShowing = true;
      state.reviewing = false;
      render();
      return true;
    }
    if (cmd === 'history-close') {
      state.historyShowing = false;
      Object.assign(state, state.historyReturn ?? {});
      if (!state.testing && !state.reviewing) state.empty = !current();
      delete state.historyReturn;
      render();
      $('.history-actions [data-command="history"]').focus({ preventScroll: true });
      return true;
    }
    if (cmd === 'history-scope') {
      state.historyCurrent = !state.historyCurrent;
      renderHistory();
      return true;
    }
    if (cmd === 'history-revert') {
      const event = journal.find(e => e.id === Number(el.dataset.event));
      if (historyBlocked(event.patch)) return true;
      const result = reverseChange(model, event.patch);
      if (result.reason) {
        status(result.reason);
        return true;
      }
      commit(() => model = result.model, 'Undo edit ' + event.id + ': ' + event.message);
      journal.at(-1).reverses = event.id;
      renderHistory();
      return true;
    }
    if (cmd === 'preview-all') {
      state.previewAll ??= new Set();
      state.previewAll.has(state.rid) ? state.previewAll.delete(state.rid) : state.previewAll.add(state.rid);
      renderEditor();
      return true;
    }
    if (cmd === 'open-matched-rule') {
      const roleId = currentRole()?.id;
      openRecord('policy', el.dataset.rid);
      state.statement = Number(el.dataset.index);
      renderEditor();
      $('#editor').scrollTop = 0;
      if (state.view === 'json' && roleId) findInJSON(roleId);
      return true;
    }
    if (cmd === 'choose-rule') {
      choicePicker(el, {
        title: 'Choose a rule',
        selected: String(state.statement),
        rows: current().content.Statement.map((s, i) => ({
          rid: String(i),
          id: String(i + 1),
          searchId: false,
          label: ruleTitle(s, i),
          secondary: 'Rule ' + (i + 1) + ' · ' + (s.Effect ?? 'Missing effect') + ' · ' + (Array.isArray(s.Action) ? s.Action : [s.Action]).join(', '),
          icon: 'policy',
          depth: 0
        })),
        select: rid => {
          state.statement = Number(rid);
          renderEditor();
        }
      });
      return true;
    }
    if (cmd === 'rule-effect') {
      const effect = el.dataset.effect;
      if (['Allow', 'Deny'].includes(effect)) commit(() => statement().Effect = effect,
        'Rule ' + (state.statement + 1) + ' effect: ' + effect);
      $(`[data-command="rule-effect"][data-effect="${effect}"]`)?.focus();
      return true;
    }
    if (cmd === 'rule-menu') {
      popup(el, button('edit', 'rule-name', 'Name or describe this rule') + button('copy', 'copy-statement', 'Duplicate rule') + button(
        'json', 'copy-rule-json', 'Copy rule JSON') + button('arrow', 'rule-move-up', 'Move rule up', state.statement === 0 ?
        'disabled' : '') + button('down', 'rule-move-down', 'Move rule down', state.statement === current().content.Statement.length -
        1 ? 'disabled' : '') + '<hr>' + button('trash', 'delete-statement', 'Remove rule', current().content.Statement.length <= 1 ?
        'disabled' : ''));
      return true;
    }
    if (cmd === 'rule-name') {
      if (Object.hasOwn(statement(), 'description') && typeof statement().description !== 'string') {
        dialog('Rule description', '<p>This description contains a JSON value instead of text. Edit it in the JSON editor.</p>',
          'Open JSON', () => $('[data-view="json"]').click());
        return true;
      }
      dialog('Rule description', '<label>Description<textarea id="rule-description">' + esc(ruleDescription(statement())) +
        '</textarea></label>', 'Update draft', () => commit(() => {
          // Always author description. Preserve existing annotations verbatim;
          // an empty string explicitly clears a label inherited from _comment.
          statement().description = $('#rule-description').value.trim();
        }, 'Updated rule description'));
      return true;
    }
    if (cmd === 'rule-move-up' || cmd === 'rule-move-down') {
      const from = state.statement,
        to = from + (cmd.endsWith('up') ? -1 : 1);
      if (to < 0 || to >= current().content.Statement.length) return true;
      commit(() => {
        clearPolicyTests();
        const list = current().content.Statement;
        [list[from], list[to]] = [list[to], list[from]];
        state.statement = to;
      }, 'Moved rule ' + (from + 1) + ' to ' + (to + 1));
      return true;
    }
    if (cmd === 'copy-rule-json' || cmd === 'copy-policy-json') {
      await copyText(cmd === 'copy-rule-json' ? JSON.stringify(statement(), null, 2) : jsonEditor?.value() ?? JSON.stringify(current()
        .content, null, 2));
      return true;
    }
    if (cmd === 'edit-who') {
      const value = statement().Subject,
        tokens = Array.isArray(value) ? value : [value];
      choicePicker(el, {
        title: 'Choose subjects',
        roleHierarchy: true,
        multi: true,
        requireSelection: true,
        exclusive: '*',
        selectedValues: [...tokens],
        rows: [{
          rid: '*',
          label: 'Everyone',
          secondary: 'All users',
          icon: 'globe',
          depth: 0
        }, ...roleChoiceRows(), ...tokens.filter(t => t !== '*' && !model.roles.some(r => 'role:' + r.id === t)).map(t => ({
          rid: t,
          label: t,
          secondary: 'Existing subject · preserved',
          icon: 'assignment',
          depth: 0
        }))],
        select: values => commit(() => statement().Subject = values.includes('*') ? '*' : values, 'Updated rule subjects')
      });
      return true;
    }
    if (cmd === 'new-folder' || cmd === 'rename-folder') {
      const folder = folders.find(f => f.rid === el.dataset.folder),
        rename = cmd === 'rename-folder';
      dialog(rename ? 'Rename folder' : 'New policy folder',
        `<label>Name<input id="folder-name" required value="${esc(rename?folder.name:'')}"></label>`, rename ? 'Rename' : 'Create folder', () => {
          const name = $('#folder-name').value.trim();
          if (!name) throw Error('Enter a folder name.');
          commit(() => {
            if (rename) folder.name = name;
            else {
              const rid = draftRid();
              model.folders.push({
                rid,
                id: 'draft_folder_' + stamp(),
                name,
                parent: folder?.rid ?? ''
              });
              state.folderClosed.delete(folder?.rid);
            }
          }, rename ? 'Renamed policy folder' : 'Created policy folder');
        });
      return true;
    }
    if (cmd === 'delete-folder') {
      const folder = folders.find(f => f.rid === el.dataset.folder);
      if (model.policies.some(p => p.parent === folder.rid) || folders.some(f => f.parent === folder.rid)) {
        status('Move the folder’s policies and subfolders before removing it.');
        return true;
      }
      commit(() => model.folders = model.folders.filter(f => f.rid !== folder.rid), 'Removed empty folder ' + folder.name);
      return true;
    }
    return false;
  }

  function installWorkspaceUX() {
    document.addEventListener('toggle', e => {
      if (e.target.dataset.preview) {
        const key = e.target.dataset.preview;
        e.target.open ? state.previewExpanded.add(key) : state.previewExpanded.delete(key);
      }
      if (e.target.dataset.historyEntry && e.target.open) state.historyExpanded = Number(e.target.dataset.historyEntry);
    }, true);
    installHistoryBrowser();
    installTreeMoves();
  }

  function treeRecord(r, kind, depth = 0) {
    if (treeRemaining <= 0) { treeTruncated = true; return ''; }
    treeRemaining--;
    const search = treeRoleSearch.get(r.rid), closed = state.search ? state.searchClosed : state.closed;
    const children = kind === 'role' && (state.search ? model.scope.some(row => row.parent === r.rid) : roleHasChildren(r.rid)),
      selected = !state.historyShowing && !state.reviewing && !state.empty && !state.scopeSelection && state.rid === r.rid,
      level = kind === 'role' ? ancestry(model.roles, r.rid).length : 0;
    let match = '';
    if (state.search && kind === 'policy' && !queryMatches(state.search, r.name, r.id, r.rid)) {
      const ids = new Set(referencedRoleIds(r.content));
      const names = model.roles.filter(role => ids.has(role.id) && queryMatches(state.search, role.name, role
        .id));
      match = names.length ? 'Role: ' + names.map(r => r.name).join(', ') : JSON.stringify(r.content, null, 2).split('\n').find(line =>
        queryMatches(state.search, line))?.trim() ?? 'Match in policy rules';
    }
    const path = state.search && kind === 'role' ? ancestry(model.roles, r.rid).slice(0, -1).map(role => role.name).join(' / ') : '';
    const owner = kind === 'role' && state.scopeSelection && state.rid === r.rid && !state.historyShowing && !state.reviewing;
    return `<button class="tree-row ${selected?'selected':''} ${owner?'context-owner':''} ${!closed.has(r.rid)?'expanded':''} ${match?'has-match':''} ${search?(search.roleMatch?'search-match':'search-context'):''}" style="--depth:${depth}" role="treeitem" tabindex="-1" aria-selected="${selected}" aria-level="${depth+1}" ${children?'aria-expanded="'+!closed.has(r.rid)+'"':''} draggable="true" data-drag-kind="${kind}" data-drag-rid="${r.rid}" ${kind==='role'?'data-drop-role="'+r.rid+'"':''} data-search-content="${!!match}" data-search-match="${kind==='policy'||!!search?.roleMatch}" data-search-rank="${recordSearchRank(r,state.search)}" data-open="${r.rid}" data-kind="${kind}" title="${esc(r.name+'\n'+r.id+'\n'+(kind==='role'?'Level '+level+' · '+rolePath(r.rid):folderPath(r.parent))+'\nDrag to move. Space picks up; Enter drops; Esc cancels.')}"><span class="caret ${children?'':'empty'}" ${children?'data-collapse="'+r.rid+'"':''}>${icon('down')}</span>${kind==='role'?roleMark(level):icon(kind)}<span class="tree-label">${treeName(r.name)}${state.search?'<small>'+highlighted(r.id)+(match?' · '+highlighted(match):'')+'</small>':''}${path?'<small class="tree-result-context">'+esc(path)+'</small>':''}</span>${dirtyMark(r.rid)}<span class="tree-grip">${icon('grip')}</span></button>`;
  }

  function treeFolder(f, depth, records, needed) {
    if (!needed.has(f.rid)) return '';
    if (treeRemaining <= 0) { treeTruncated = true; return ''; }
    treeRemaining--;
    const open = !!state.search || !!state.roleFilter || !state.folderClosed.has(f.rid),
      count = treeFolderCounts.get(f.rid) ?? 0;
    return `<button class="tree-row folder-row ${open?'expanded':''}" role="treeitem" aria-expanded="${open}" aria-level="${depth+1}" style="--depth:${depth}" data-command="toggle-folder" data-folder="${f.rid}" data-drop-folder="${f.rid}" draggable="true" data-drag-kind="folder" data-drag-rid="${f.rid}" title="${esc(folderPath(f.rid)+'\nDrop a policy here to move it into this folder.')}" ><span class="caret">${icon('down')}</span>${icon('folder')}<span class="tree-label">${treeName(f.name)}</span><span class="folder-count">${count}</span><span class="tree-grip">${icon('grip')}</span></button>` +
      (open ? (treeChildren.folders.get(f.rid) ?? []).map(x => treeFolder(x, depth + 1, records, needed)).join('') + (treeChildren.policies.get(f.rid) ?? []).map(r => treeRecord(r, 'policy', depth + 1)).join('') : '');
  }

  let treeRemaining = 0, treeTruncated = false;
  let treeChildren = {}, treeFolderCounts = new Map();
  let treeRoleSearch = new Map();
  let renderedTreeKey;
  const treeFocus = new Map();
  const treeRowKey = row => row?.dataset.scopeNode ?? row?.dataset.folder ?? row?.dataset.open;
  $('#tree').addEventListener('focusin', e => {
    const row = e.target.closest('.tree-row'), tree = row?.closest('[role="tree"]');
    if (!tree) return;
    for (const item of tree.querySelectorAll('.tree-row')) item.tabIndex = item === row ? 0 : -1;
    treeFocus.set(tree.dataset.treeKind, treeRowKey(row));
  });
  function syncTreeSelection() {
    const active = !state.historyShowing && !state.reviewing && !state.empty;
    for (const tree of $$('#tree [role="tree"]')) {
      const rows = [...tree.querySelectorAll('.tree-row')];
      for (const row of rows) {
        if (!row.dataset.open && !row.dataset.scopeNode) continue;
        const selected = active && (row.dataset.scopeNode ? row.dataset.scopeNode === state.scopeSelection :
          !state.scopeSelection && row.dataset.open === state.rid);
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-selected', String(selected));
        row.classList.toggle('context-owner', !!(active && state.scopeSelection && row.dataset.kind === 'role' && row.dataset.open === state.rid));
      }
      // Each tree keeps its own keyboard entry, even when selection is in the other tree.
      const target = rows.find(row => row === document.activeElement) ?? rows.find(row => row.classList.contains('selected')) ??
        rows.find(row => treeRowKey(row) === treeFocus.get(tree.dataset.treeKind)) ?? rows[0];
      for (const row of rows) row.tabIndex = row === target ? 0 : -1;
      if (target) treeFocus.set(tree.dataset.treeKind, treeRowKey(target));
    }
  }
  function renderTree(preserve = false) {
    const focused = document.activeElement.closest?.('#tree .tree-row');
    const focusedKey = treeRowKey(focused), focusedKind = focused?.closest('[role="tree"]')?.dataset.treeKind;
    const signature = state.search + ':' + state.searchKind + ':' + state.roleFilter;
    if (state.treeSignature !== signature) {
      state.treeSignature = signature; state.treeLimits = { role: 300, policy: 300 }; state.searchClosed = new Set();
    }
    state.treeLimits ??= { role: 300, policy: 300 };
    state.searchClosed ??= new Set();
    // Keep the DOM on view-only navigation. Explicit tree refreshes (search,
    // expansion, drag/drop, input) still rebuild; configuration revisions cover edits and undo.
    const key = JSON.stringify([revision, signature, [...state.closed], [...state.folderClosed], [...state.searchClosed],
      state.treeLimits, [...state.raw.keys()], [...state.idDraft], [...schemaLoaded]]);
    if (preserve && key === renderedTreeKey) { syncTreeSelection(); return; }
    treeRoleSearch = new Map(state.search ? roleSearchResults(model, state.search, row => definitionLabel(row) + ' ' + definitionDescription(row))
      .map(result => [result.role.rid, result]) : []);
    treeChildren = Object.fromEntries(['roles', 'policies', 'folders'].map(key => {
      const children = new Map();
      for (const row of model[key]) { if (!children.has(row.parent)) children.set(row.parent, []); children.get(row.parent).push(row); }
      return [key, children];
    }));
    treeFolderCounts = new Map();
    const folderById = new Map(folders.map(f => [f.rid, f]));
    for (const row of model.policies) {
      const seen = new Set();
      for (let parent = row.parent; parent && !seen.has(parent); parent = folderById.get(parent)?.parent) {
        seen.add(parent); treeFolderCounts.set(parent, (treeFolderCounts.get(parent) ?? 0) + 1);
      }
    }
    const scroll = $$('.collection-list').map(x => x.scrollTop);
    let html = '';
    for (const kind of state.searchKind === 'all' ? ['role', 'policy'] : [state.searchKind]) {
      treeRemaining = state.treeLimits[kind]; treeTruncated = false;
      const filterRole = state.roleFilter ? roleByRid(state.roleFilter) : null,
        records = model[kind === 'role' ? 'roles' : 'policies'].filter(r => {
          if (kind === 'policy' && filterRole && !mentions(r.content, filterRole.id)) return false;
          return !state.search || (kind === 'policy' ? policyMatches(r, state.search, model.roles) : treeRoleSearch.has(r.rid));
        });
      if (state.search) records.sort((a, b) => recordSearchRank(a, state.search) - recordSearchRank(b, state.search));
      let body = '';
      if (kind === 'role') {
        if (state.search) { treeTruncated = records.length > treeRemaining; body = records.slice(0, treeRemaining).map(r => treeRecord(r, kind) + (!state.searchClosed.has(r.rid) ?
            renderDefinitionTree(r.rid, 0) : '')).join(''); }
        else {
          const visit = renderRoleBranch;
          const ids = new Set(records.map(r => r.rid));
          body = records.filter(r => !ids.has(r.parent)).map(r => visit(r, 0)).join('');
        }
      } else if (state.search) {
        treeTruncated = records.length > treeRemaining;
        body = records.slice(0, treeRemaining).map(r => treeRecord(r, 'policy')).join('');
      } else {
        const needed = !state.search && !state.roleFilter ? new Set(folders.map(f => f.rid)) : new Set(records.flatMap(r => ancestry(
          folders, r.parent).map(f => f.rid)));
        const filtered = new Set(records.map(r => r.rid));
        for (const [parent, children] of treeChildren.policies) treeChildren.policies.set(parent, children.filter(r => filtered.has(r.rid)));
        body = folders.filter(f => !folderById.has(f.parent)).map(f => treeFolder(f, 0, records, needed)).join('') + records
          .filter(r => !folderById.has(r.parent)).map(r => treeRecord(r, kind)).join('');
      }
      if (treeTruncated) body += `<button class="tree-more" data-command="tree-more" data-kind="${kind}">Show more ${kind === 'role' ? 'roles & assignments' : 'policies & folders'}…</button>`;
      html +=
        `<section class="collection ${records.length?'':'no-matches'}"><header class="collection-heading" ${kind==='role'?'data-drop-role=""':'data-drop-folder=""'} tabindex="0"><h2>${kind==='role'?'Roles':'Policies'}</h2><span>${records.length}</span><span class="spacer"></span>${kind==='policy'?ib('folder','new-folder','New policy folder')+ib('filter','filter-policies','Filter policies by role'):''}${ib('plus','new-'+kind,'New '+kind)}</header><div class="collection-list" role="tree" data-tree-kind="${kind}" aria-label="${kind==='role'?'Roles':'Policies'}">${body||'<p class="tree-empty">No matches. Try a name, ID, field, or rule.</p>'}</div></section>`;
    }
    $('#tree').innerHTML = html;
    renderedTreeKey = key;
    $$('.collection-list').forEach((tree, i) => {
      tree.scrollTop = scroll[i] ?? 0;
      const rows = [...tree.querySelectorAll('.tree-row')], kind = tree.dataset.treeKind;
      const remembered = focusedKind === kind ? focusedKey : treeFocus.get(kind);
      const target = (focusedKind === kind ? rows.find(row => treeRowKey(row) === remembered) : null) ??
        rows.find(row => row.getAttribute('aria-selected') === 'true') ?? rows.find(row => treeRowKey(row) === remembered) ?? rows[0];
      for (const row of rows) row.tabIndex = row === target ? 0 : -1;
      if (target) treeFocus.set(kind, treeRowKey(target));
      if (focusedKind === kind) target?.focus({ preventScroll: true });
    });
    renderSearchTools();
  }
  let dragExpandTimer, dragExpandTarget = '',
    dragLastPointer = null,
    dropClickUntil = 0;

  function clearDragMarks() {
    $$('.drop-target,.drop-invalid').forEach(el => {
      el.classList.remove('drop-target', 'drop-invalid');
      delete el.dataset.dropLabel;
    });
  }

  function dragRecord(kind, rid) {
    return model[kind === 'role' ? 'roles' : kind === 'folder' ? 'folders' : 'policies'].find(r => r.rid === rid);
  }

  function startTreeDrag(kind, rid, keyboard = false, event) {
    closePicker(false);
    const record = dragRecord(kind, rid);
    state.drag = {
      kind,
      rid,
      keyboard
    };
    document.body.classList.add('tree-dragging');
    $(`[data-drag-rid="${rid}"]`)?.classList.add('drag-source');
    status('Move ' + record.name + ' · ' + (kind === 'role' ? 'drop into a parent role' : 'drop into a policy folder') + ' · Esc cancels');
    if (event) {
      const ghost = document.createElement('div');
      ghost.id = 'tree-drag-ghost';
      ghost.innerHTML = icon(kind === 'folder' ? 'folder' : kind) + `<span>${esc(record.name)}</span>`;
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 16, 16);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/x-companion-record', JSON.stringify({
        kind,
        rid
      }));
      event.dataTransfer.setData('text/plain', record.name);
    }
  }

  function treeDropInfo(target) {
    const d = state.drag;
    if (!d || !target) return null;
    let rid = d.rid,
      kind = d.kind,
      parent;
    if (d.kind === 'role') {
      if (target.hasAttribute('data-drop-parent-field')) {
        rid = target.dataset.parentTarget;
        parent = d.rid;
      } else if (target.hasAttribute('data-drop-role')) parent = target.dataset.dropRole;
      else return {
        reason: 'Roles can only be nested under other roles.'
      };
    } else if (target.hasAttribute('data-drop-folder-field')) {
      if (d.kind === 'folder') {
        kind = 'policy';
        rid = target.dataset.dropFolderField;
        parent = d.rid;
      } else parent = model.policies.find(p => p.rid === target.dataset.dropFolderField)?.parent ?? '';
    } else if (target.hasAttribute('data-drop-folder')) parent = target.dataset.dropFolder;
    else return {
      reason: 'Choose a policy folder as the destination.'
    };
    const row = dragRecord(kind, rid),
      destination = parent ? dragRecord(kind === 'role' ? 'role' : 'folder', parent) : null;
    let reason = '';
    if (kind === 'role' || kind === 'folder') reason = moveProblem(model[kind === 'role' ? 'roles' : 'folders'], rid, parent).replaceAll(
      'role', 'folder' === kind ? 'folder' : 'role').replaceAll('Role', kind === 'folder' ? 'Folder' : 'Role');
    else if (row.parent === parent) reason = 'Already in this folder.';
    if (parent && !destination) reason = 'Destination is no longer available.';
    const level = kind === 'role' ? ancestry(model.roles, parent).length + 1 : null;
    return {
      kind,
      rid,
      parent,
      reason,
      label: destination?.name ?? (kind === 'role' ? 'Top-level roles' : 'Policy root'),
      level,
      name: row.name
    };
  }

  function previewTreeDrop(target, pointer) {
    clearDragMarks();
    const info = treeDropInfo(target);
    if (!info) {
      $('#drop-preview').hidden = true;
      return null;
    }
    target.classList.add(info.reason ? 'drop-invalid' : 'drop-target');
    target.dataset.dropLabel = info.reason ? 'Unavailable' : 'Inside';
    const hint = $('#drop-preview');
    hint.hidden = false;
    hint.innerHTML = info.reason ? `${icon('help')}<span>${esc(info.reason)}</span>` :
      `${icon(info.kind==='role'?'scope':'folder')}<span><small>Move ${esc(info.name)}</small><strong>Into ${esc(info.label)}${info.level?' · level '+info.level:''}</strong></span>`;
    const rect = target.getBoundingClientRect(),
      x = pointer?.x ?? rect.right,
      y = pointer?.y ?? rect.bottom;
    hint.style.left = Math.max(8, Math.min(innerWidth - hint.offsetWidth - 8, x + 14)) + 'px';
    hint.style.top = Math.max(8, Math.min(innerHeight - hint.offsetHeight - 8, y + 16)) + 'px';
    return info;
  }

  function finishTreeDrag() {
    clearTimeout(dragExpandTimer);
    dragExpandTarget = '';
    state.drag = null;
    clearDragMarks();
    $$('.drag-source').forEach(el => el.classList.remove('drag-source'));
    $('#tree-drag-ghost')?.remove();
    $('#drop-preview').hidden = true;
    document.body.classList.remove('tree-dragging');
  }

  function applyTreeDrop(target) {
    const info = treeDropInfo(target),
      mouse = !state.drag?.keyboard;
    finishTreeDrag();
    dropClickUntil = mouse ? Date.now() + 250 : 0;
    if (!info || info.reason) {
      status(info?.reason ?? 'Move cancelled');
      return;
    }
    commit(() => dragRecord(info.kind, info.rid).parent = info.parent, 'Move ' + info.name + ' → ' + info.label);
    if (info.kind === 'folder') {
      for (const f of ancestry(folders, info.parent)) state.folderClosed.delete(f.rid);
      renderTree();
    } else openRecord(info.kind, info.rid);
  }

  function expandDropTarget(target) {
    const d = state.drag;
    if (!d || !target.isConnected) return;
    const rid = d.kind === 'role' ? target.dataset.dropRole : target.dataset.dropFolder;
    if (!rid) return;
    const depth = Number(target.getAttribute('aria-level'));
    if (d.kind === 'role' && state.closed.has(rid)) {
      state.closed.delete(rid);
      target.insertAdjacentHTML('afterend', model.roles.filter(x => x.parent === rid).map(x => renderRoleBranch(x, depth)).join('') +
        renderDefinitionTree(rid, depth - 1));
    } else if (d.kind !== 'role' && state.folderClosed.has(rid)) {
      state.folderClosed.delete(rid);
      const needed = new Set(folders.map(f => f.rid));
      target.insertAdjacentHTML('afterend', folders.filter(x => x.parent === rid).map(f => treeFolder(f, depth, model.policies, needed))
        .join('') + model.policies.filter(p => p.parent === rid).map(p => treeRecord(p, 'policy', depth)).join(''));
    }
    target.classList.add('expanded');
    target.setAttribute('aria-expanded', 'true');
  }

  function installTreeMoves() {
    const hint = document.createElement('div');
    hint.id = 'drop-preview';
    hint.hidden = true;
    hint.setAttribute('role', 'status');
    document.body.append(hint);
    document.addEventListener('click', e => {
      if (Date.now() < dropClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener('dragstart', e => {
      const row = e.target.closest('[data-drag-rid]');
      if (row) startTreeDrag(row.dataset.dragKind, row.dataset.dragRid, false, e);
    });
    const dragOver = e => {
      if (!state.drag) return;
      e.preventDefault();
      dragLastPointer = {
        x: e.clientX,
        y: e.clientY
      };
      const target = e.target.closest('[data-drop-role],[data-drop-folder],[data-drop-parent-field],[data-drop-folder-field]');
      if (!target) {
        clearTimeout(dragExpandTimer);
        dragExpandTarget = '';
        clearDragMarks();
        $('#drop-preview').hidden = true;
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      const info = previewTreeDrop(target, dragLastPointer);
      e.dataTransfer.dropEffect = info && !info.reason ? 'move' : 'none';
      const list = target.closest('.collection-list');
      if (list) {
        const box = list.getBoundingClientRect();
        if (e.clientY < box.top + 24) list.scrollTop -= 10;
        if (e.clientY > box.bottom - 24) list.scrollTop += 10;
      }
      const key = target.dataset.dropRole ?? target.dataset.dropFolder ?? '';
      if (dragExpandTarget !== key) {
        clearTimeout(dragExpandTimer);
        dragExpandTarget = key;
        if (key && !info?.reason) dragExpandTimer = setTimeout(() => expandDropTarget(target), 650);
      }
    };
    document.addEventListener('dragenter', dragOver);
    document.addEventListener('dragover', dragOver);
    document.addEventListener('drop', e => {
      if (!state.drag) return;
      e.preventDefault();
      applyTreeDrop(e.target.closest('[data-drop-role],[data-drop-folder],[data-drop-parent-field],[data-drop-folder-field]'));
    });
    document.addEventListener('dragend', () => {
      if (state.drag) {
        finishTreeDrag();
        status('Move cancelled');
      }
    });
    document.addEventListener('keydown', e => {
      if (state.picker || e.target.closest('input,textarea,.cm-editor')) return;
      if (!state.drag && e.key === ' ' && e.target.matches('[data-drag-rid]')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        startTreeDrag(e.target.dataset.dragKind, e.target.dataset.dragRid, true);
        return;
      }
      if (!state.drag) return;
      if (e.key === 'Escape') {
        const rid = state.drag.rid;
        finishTreeDrag();
        $(`[data-drag-rid="${rid}"]`)?.focus();
        status('Move cancelled');
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!state.drag.keyboard) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const rows = $$(state.drag.kind === 'role' ? '#tree [data-drop-role]' : '#tree [data-drop-folder]'),
          index = rows.indexOf(document.activeElement),
          next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (e.key ===
            'ArrowDown' ? 1 : -1)));
        rows[next]?.focus();
        previewTreeDrop(rows[next]);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopImmediatePropagation();
        expandDropTarget(document.activeElement);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        applyTreeDrop(document.activeElement.closest('[data-drop-role],[data-drop-folder]'));
      }
    }, true);
  }

  // Recovery and picker refinements from the independent design / UX audits.
  function draftPolicies() {
    return model.policies.filter(p => state.raw.has(p.rid));
  }

  let roleDirtyCache;
  function dirtyMark(rid) {
    const record = state.idDraft.has(rid) ? roleByRid(rid) ?? model.policies.find(p => p.rid === rid) : null;
    if (record && state.idDraft.get(rid) !== record.id)
      return '<span class="changed json-dirty" title="Unfinished business ID edit" aria-label="Unfinished business ID edit">◇</span>';
    if (state.raw.has(rid)) return '<span class="changed json-dirty" title="Pending JSON edit" aria-label="Pending JSON edit">◇</span>';
    if (changed(rid)) return '<span class="changed" title="Pending edit" aria-label="Pending edit">•</span>';
    if (roleDirtyCache?.changes !== changeCache.rows) roleDirtyCache = {
      changes: changeCache.rows,
      owners: changedRoleOwners(model, baseline, changeCache.rows)
    };
    return roleDirtyCache.owners.has(rid) ? '<span class="changed" title="Pending membership, assignment or delegation edit" aria-label="Pending membership, assignment or delegation edit">•</span>' : '';
  }

  function refreshDraftChrome() {
    renderToolbar();
    renderTabs();
    for (const row of $$('#tree [data-open]')) {
      row.querySelector('.changed')?.remove();
      row.insertAdjacentHTML('beforeend', dirtyMark(row.dataset.open));
    }
  }

  function setJSONDraft(rid, text) {
    queueMicrotask(saveWorkspace);
    const p = model.policies.find(p => p.rid === rid), hadRaw = state.raw.has(rid);
    if (text === JSON.stringify(p?.content, null, 2)) state.raw.delete(rid);
    else state.raw.set(rid, text);
    // Refresh attribution once when entering/leaving a raw draft, without
    // remounting the request fields or rebuilding the trace on every keystroke.
    if (hadRaw !== state.raw.has(rid) && $('#check-result')) { $('#check-result').innerHTML = renderResult(); mountResult(); }
    refreshDraftChrome();
  }

  function renderToolbar() {
    renderToolbarBase();
    $('#test-return')?.remove();
    if (testReturn) $('.history-actions').insertAdjacentHTML('afterbegin', `<button id="test-return" data-command="return-to-test" title="Return to the test and its inputs">${icon('back')}Back to test</button>`);
    const ids = unfinishedIdEdits(model, state.idDraft), drafts = draftPolicies(),
      count = pendingRecordCount(differences(), drafts, ids),
      title = [count + ' records with pending edits', ids.length ? ids.length + ' unfinished ID edits' : '',
        drafts.length ? drafts.length + ' JSON drafts' : ''].filter(Boolean).join(' · ');
    $('#pending-review').innerHTML =
      `<button class="review-launch ${count?'dirty':''}" data-command="review" title="${esc(title)}" ${!count?'disabled':''}>${icon('changes')}<span>${count?'Review pending edits':'No pending edits'}</span>${count?'<b>'+count+'</b>':''}</button>`;
  }

  function idDraftRows(rows = unfinishedIdEdits(model, state.idDraft)) {
    return rows.map(({ record, kind, value }) =>
      `<div class="raw-draft-row id-draft-row"><span>${icon(kind)}</span><div><strong>${esc(record.name)}</strong><small>Business ID · ${esc(record.id)} → ${esc(value || '(empty)')}</small></div>${button('edit','finish-id-draft','Finish',`data-rid="${record.rid}" data-kind="${kind}"`)}${button('reset','cancel-id-draft','Cancel',`data-rid="${record.rid}"`)}</div>`
    ).join('');
  }

  function idDraftCommand(cmd, el) {
    if (cmd === 'finish-id-draft') {
      $('#dialog').close();
      openRecord(el.dataset.kind, el.dataset.rid);
      $('#business-id')?.focus();
      return true;
    }
    if (cmd === 'cancel-id-draft') {
      const record = [...model.roles, ...model.policies].find(r => r.rid === el.dataset.rid);
      state.idDraft.delete(el.dataset.rid);
      render();
      status('Cancelled business ID edit' + (record ? ': ' + record.name : ''));
      return true;
    }
    return false;
  }

  function rawDraftRows(rows = draftPolicies()) {
    return rows.map(p =>
      `<div class="raw-draft-row"><span>${icon('json')}</span><div><strong>${esc(p.name)}</strong><small>JSON edits · ${esc(p.id)}</small></div><button data-command="open-json-draft" data-rid="${p.rid}">Open draft${icon('open')}</button></div>`
      ).join('');
  }

  function renderReview() {
    renderReviewBase();
    const rows = draftPolicies(), ids = unfinishedIdEdits(model, state.idDraft);
    $('.review-title .review-count').textContent = String(pendingRecordCount(differences(), rows, ids));
    if (!rows.length && !ids.length) return;
    $('.review-intro').textContent = ids.length ? 'Finish or cancel the business ID edits before applying.' :
      'Update or discard these JSON edits before exporting or applying.';
    $('.review-items').insertAdjacentHTML('beforebegin',
      (ids.length ? `<section class="draft-recovery"><h2>Unfinished business ID edits</h2>${idDraftRows(ids)}</section>` : '') +
      (rows.length ? `<section class="draft-recovery"><h2>JSON edits to review</h2>${rawDraftRows(rows)}</section>` : ''));
  }

  function historyBlocked(patch) {
    const ids = conflictingJSONDrafts(patch ?? [], state.raw.keys());
    if (!ids.length) return false;
    const rows = draftPolicies().filter(p => ids.includes(p.rid));
    dialog('Resolve these JSON drafts',
      `<p>This change affects a policy with pending JSON edits. Open the policy, update or discard its JSON edits, then retry.</p>${rawDraftRows(rows)}`
      );
    return true;
  }

  function discardOne(rid) {
    const d = differences().find(x => x.r.rid === rid);
    if (!d) return;
    const result = discardRecord(model, baseline, d.key, rid);
    if (historyBlocked(result.patch)) return;
    if (result.reason) {
      dialog('Dependent changes',
        `<p>${esc(result.reason)}</p><div class="dependency-list">${(result.dependents??[]).map(r=>`<button data-command="review-dependent" data-rid="${r.rid}">${icon(r.collection==='policies'?'policy':r.collection==='folders'?'folder':'role')}<span>${esc(r.name)}</span>${icon('open')}</button>`).join('')}</div><p>Resolve the dependent edits first, or discard the complete draft together.</p>`
        );
      return;
    }
    commit(() => model = result.model, 'Discarded changes to ' + (d.r.name ?? d.r.id));
  }

  function closeRecordTab(rid) {
    state.tabs = state.tabs.filter(t => t.rid !== rid);
    const raw = state.raw.has(rid),
      name = model.policies.find(p => p.rid === rid)?.name;
    if (state.rid === rid && !state.historyShowing && !state.reviewing) {
      if (state.tabs.length) {
        const t = state.tabs.at(-1);
        openRecord(t.kind, t.rid);
      } else {
        state.empty = true;
        state.rid = '';
        render();
      }
    } else render();
    if (raw) status('JSON edits retained in Pending edits: ' + name);
  }

  function roleChoiceRows() {
    const rows = [],
      seen = new Set();

    function visit(r, depth) {
      if (seen.has(r.rid)) return;
      seen.add(r.rid);
      const parents = ancestry(model.roles, r.rid).slice(0, -1).map(p => p.name).join(' / ');
      rows.push({
        rid: 'role:' + r.id,
        id: r.id,
        label: r.name,
        secondary: r.id,
        detail: parents || 'Top-level role',
        icon: 'role',
        depth,
        level: depth + 1
      });
      model.roles.filter(c => c.parent === r.rid).forEach(c => visit(c, depth + 1));
    }
    model.roles.filter(r => !model.roles.some(p => p.rid === r.parent)).forEach(r => visit(r, 0));
    return rows;
  }

  function renderSubjectSelection(p) {
    if (!p.roleHierarchy) return;
    let strip = $('#picker-selection');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'picker-selection';
      strip.className = 'picker-selection';
      $('#picker-types').after(strip);
    }
    strip.innerHTML =
      `<span>Selected</span>${p.selectedValues.map(token=>{const r=p.rows.find(r=>r.rid===token);return `<button data-command="subject-unselect" data-token="${esc(token)}" title="Remove ${esc(r?.label??token)}">${esc(r?.label??token)}${icon('close')}</button>`;}).join('')||'<small>No subjects yet</small>'}`;
  }

  function createRecord(kind, duplicate = false, withRole = false, underRole = null) {
    const source = duplicate ? clone(current()) : null,
      role = withRole ? currentRole() : null,
      parent = underRole ?? source?.parent ?? (kind === 'policy' ? (state.newPolicyFolder ?? (state.kind === 'policy' ? current()?.parent :
        '')) : '');
    const scope = source && kind === 'role' ? descendants(source.rid) : [],
      as = scope.filter(x => x.kind === 'RoleAssignment').length,
      paths = scope.length - as;
    const copyOptions = source && kind === 'role' ?
      `<fieldset class="duplicate-options"><legend>Copy from this role</legend><label><input type="checkbox" id="copy-definitions" ${scope.length?'checked':''} ${!scope.length?'disabled':''}><span>${as} field assignment${as===1?'':'s'} and ${paths} delegation path${paths===1?'':'s'}</span></label><p>Policy references, child roles and global memberships stay with the original role.</p></fieldset>` :
      '';
    dialog(duplicate ? 'Duplicate ' + kind : underRole ? 'New child role' : 'New ' + kind,
      `${underRole?'<div class="creation-destination">'+icon('role')+'<span>Under <strong>'+esc(roleByRid(underRole)?.name)+'</strong></span></div>':''}<label>Name<input id="new-name" data-record-kind="${kind}" required value="${esc(source?source.name+' copy':'')}" autocomplete="off"></label><label>Business ID<input id="new-id" required title="Start with a letter or underscore; use letters, numbers, and underscores" value="${esc(source?source.id+'_copy':'')}" autocomplete="off" class="mono"></label><input type="hidden" id="new-parent" value="${esc(parent)}">${kind==='policy'?`<div class="creation-destination">${icon('folder')}<span>${esc(folderPath(parent)||'Policy root')}</span></div>`:''}${copyOptions}`,
      duplicate ? 'Duplicate' : 'Create', () => {
        const name = $('#new-name').value.trim(),
          id = $('#new-id').value.trim(),
          parent = $('#new-parent').value,
          copyDefinitions = $('#copy-definitions')?.checked;
        if (businessIdError(id)) throw Error(businessIdError(id));
        if (!name || (kind === 'role' ? [...model.roles, ...model.scope] : [...model.policies, ...model.folders]).some(r => r.id === id)) throw Error('Use a name and a unique business ID.');
        const rid = draftRid();
        commit(() => {
          if (kind === 'role') {
            model.roles.push({
              rid,
              id,
              name,
              parent
            });
            if (copyDefinitions) model.scope.push(...copyRoleDefinitions(model, source.rid, rid, draftRid));
          } else model.policies.push({
            rid,
            id,
            name,
            parent,
            enabled: false,
            valid: false,
            content: source?.content ?? {
              Version: '1.0',
              Statement: [{
                Subject: role ? ['role:' + role.id] : '*',
                Effect: 'Allow',
                Action: [],
                Resource: {
                  All: []
                }
              }]
            }
          });
        }, (duplicate ? 'Duplicated ' : 'Created local ') + kind);
        state.newPolicyFolder = null;
        openRecord(kind, rid);
      });
  }

  function treeName(name) {
    if (!name.includes(' ')) return `<span class="tree-name">${highlighted(name)}</span>`;
    const words = name.split(' '),
      count = words.slice(-2).join(' ').length <= 20 ? Math.min(2, words.length - 1) : 1,
      tail = words.splice(-count).join(' ');
    if (!tail) return `<span class="tree-name"><span>${highlighted(name)}</span></span>`;
    return `<span class="tree-name"><span class="tree-name-start">${highlighted(words.join(' '))} </span><span class="tree-name-end">${highlighted(tail)}</span></span>`;
  }

  function treeKeyboard(e) {
    if (state.drag || state.picker || !e.target.matches('#tree .tree-row')) return;
    const row = e.target,
      rid = row.dataset.scopeNode ?? row.dataset.folder ?? row.dataset.open,
      folder = !!row.dataset.folder,
      closed = folder ? state.folderClosed : state.search ? state.searchClosed : state.closed;
    if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      e.stopImmediatePropagation();
      treeContextMenu(row);
      return;
    }
    if (!['ArrowRight', 'ArrowLeft', 'Enter'].includes(e.key)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      row.click();
      if (!row.dataset.scopeNode) $(`#tree [data-drag-rid="${rid}"]`)?.focus();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const rows = [...row.closest('[role="tree"]').querySelectorAll('.tree-row')],
      index = rows.indexOf(row),
      level = Number(row.getAttribute('aria-level')),
      expandable = row.hasAttribute('aria-expanded');
    if (e.key === 'ArrowRight') {
      if (expandable && row.getAttribute('aria-expanded') === 'false') {
        closed.delete(rid);
        renderTree();
        $(`#tree [data-drag-rid="${rid}"],#tree [data-scope-node="${rid}"]`)?.focus();
      } else if (index >= 0 && Number(rows[index + 1]?.getAttribute('aria-level')) > level) rows[index + 1].focus();
    } else if (expandable && row.getAttribute('aria-expanded') === 'true') {
      closed.add(rid);
      renderTree();
      $(`#tree [data-drag-rid="${rid}"],#tree [data-scope-node="${rid}"]`)?.focus();
    } else {
      for (let i = index - 1; i >= 0; i--)
        if (Number(rows[i].getAttribute('aria-level')) < level) {
          rows[i].focus();
          break;
        }
    }
  }
  async function auditCommand(cmd, el) {
    if (idDraftCommand(cmd, el)) return true;
    if (roleTreeCommand(cmd, el)) return true;
    if (cmd === 'close-tab') {
      closeRecordTab(el.dataset.rid);
      return true;
    }
    if (cmd === 'open-json-draft') {
      $('#dialog').close();
      openRecord('policy', el.dataset.rid);
      state.view = 'json';
      renderEditor();
      return true;
    }
    if (cmd === 'review-dependent') {
      $('#dialog').close();
      state.historyShowing = false;
      state.reviewing = true;
      state.reviewOpen = true;
      render();
      const target = $(`[data-review-rid="${el.dataset.rid}"]`);
      target?.scrollIntoView({
        block: 'center'
      });
      target?.focus();
      return true;
    }
    if (cmd === 'subject-unselect') {
      state.picker.selectedValues = state.picker.selectedValues.filter(v => v !== el.dataset.token);
      renderPicker();
      return true;
    }
    if (cmd === 'export' && state.raw.size) {
      dialog('Review JSON edits before exporting',
        `<p>The export uses the validated draft. Update or discard these JSON edits first.</p>${rawDraftRows()}`);
      return true;
    }
    if (cmd === 'discard-all' && state.raw.size) {
      dialog('Resolve JSON drafts first',
        `<p>Update or discard these JSON edits before discarding the rest of the draft.</p>${rawDraftRows()}`);
      return true;
    }
    if ((cmd === 'delete' || cmd === 'context-delete') && state.raw.has(cmd === 'delete' ? state.rid : el.dataset.rid)) {
      const rid = cmd === 'delete' ? state.rid : el.dataset.rid;
      dialog('Resolve this JSON draft first', rawDraftRows(draftPolicies().filter(p => p.rid === rid)));
      return true;
    }
    return false;
  }
  document.addEventListener('keydown', treeKeyboard, true);

  function roleMark(level) {
    return `<span class="role-mark" data-level="${Math.min(level,4)}" title="Hierarchy level ${level}" aria-label="Level ${level}">${icon('role')}</span>`;
  }

  // Choice surfaces share navigation, search, selection, and return-focus behavior.
  function pickerAnchorKey(el) {
    const attrs = ['id', 'data-command', 'data-path', 'data-rid', 'data-native-key', 'data-parent', 'data-field', 'data-create-value', 'data-check', 'data-action-value', 'data-scope-node', 'data-open', 'data-folder'];
    const key = { attrs: attrs.filter(a => el.hasAttribute(a)).map(a => [a, el.getAttribute(a)]) };
    return { ...key, index: pickerFocusCandidates(key).indexOf(el) };
  }

  function pickerFocusCandidates(key) {
    if (!key?.attrs?.length) return [];
    return $$(key.attrs.map(([name]) => '[' + name + ']').join('')).filter(el =>
      key.attrs.every(([name, value]) => el.getAttribute(name) === value));
  }

  function restorePickerFocus(p) {
    if (state.picker || !p) return;
    if (document.activeElement !== document.body && document.activeElement?.isConnected && document.activeElement !== $('#dialog')) return;
    const target = p.anchor.isConnected ? p.anchor : pickerFocusCandidates(p.focusKey)[p.focusKey?.index];
    target?.focus({
      preventScroll: true
    });
  }

  function applyPickerSelection(p, value, row) {
    closePicker(false);
    Promise.resolve().then(() => p.select(value, row)).then(() => {
      mountFastChoices();
      if (!state.picker) restorePickerFocus(p);
    }).catch(showError);
  }

  function applyPickerMulti() {
    const p = state.picker;
    if (!p?.multi || p.requireSelection && !p.selectedValues.length) return;
    applyPickerSelection(p, [...p.selectedValues]);
  }

  function pickerKeyboard(e) {
    const p = state.picker;
    if (!p) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (p.objectTypeBrowse) { returnToObjects(); return; }
      closePicker();
      return;
    }
    if (p.kind === 'object' && !p.objectTypeBrowse && e.altKey && e.key === 'ArrowDown') {
      e.preventDefault(); e.stopImmediatePropagation(); browseObjectTypes(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && p.reference && p.query.trim()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      applyPickerSelection(p, p.query.trim());
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && p.multi && !p.objectTypeBrowse) {
      e.preventDefault();
      e.stopImmediatePropagation();
      applyPickerMulti();
      return;
    }
    if (e.key === 'Tab') {
      const controls = $$('#picker button:not([disabled]):not([role="option"]),#picker input').filter(x => x.getClientRects().length);
      const i = controls.indexOf(document.activeElement),
        next = e.shiftKey ? i - 1 : i + 1;
      if (next < 0 || next >= controls.length) {
        e.preventDefault();
        controls[e.shiftKey ? controls.length - 1 : 0]?.focus();
      }
      return;
    }
    if (e.target.id !== 'picker-query' && !e.target.matches('#picker [role="option"]')) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) {
      if ((e.key === 'Home' || e.key === 'End') && e.target.id === 'picker-query' && e.target.value && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Enter') {
        choosePicker(p.index);
        return;
      }
      p.index = nextChoice(p.entries, p.index, e.key);
      renderPicker();
      $('#picker-query')?.focus();
      scrollPickerChoice();
    }
  }

  function renderPickerSelection(p) {
    let strip = $('#picker-selection');
    if (!p.multi) {
      strip?.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'picker-selection';
      strip.className = 'picker-selection';
      $('#picker-types').after(strip);
    }
    strip.innerHTML =
      `<span>${p.selectedValues.length} selected</span>${p.selectedValues.map(token=>{const r=p.rows.find(r=>r.rid===token);return `<button type="button" data-command="picker-unselect" data-token="${esc(token)}" aria-label="Remove ${esc(r?.label??token)}${p.mode==='list'&&r?.id?' ('+esc(r.id)+')':''}" title="${esc(token)}"><span>${esc(r?.label??token)}</span>${p.mode==='list'&&r?.id?'<code>'+esc(r.id)+'</code>':''}${icon('close')}</button>`;}).join('')||'<small>Choose one or more below</small>'}`;
  }

  function renderComparisonPicker(p) {
    const rows = p.entries;
    p.index = Math.min(Math.max(0, p.index), rows.length - 1);
    $('#picker-types').innerHTML = '';
    $('#picker-selection')?.remove();
    let group = '';
    $('#picker-results').innerHTML = rows.map((row, i) => {
      const heading = row.group !== group && !p.query ? `<div class="picker-group" role="presentation">${esc(row.group)}</div>` : '';
      group = row.group;
      return heading +
        `<button type="button" tabindex="-1" role="option" aria-selected="${row.rid===p.selected}" class="picker-option ${i===p.index?'focused':''} ${row.rid===p.selected?'chosen':''}" id="pick-${i}" data-command="picker-select" data-index="${i}" title="${esc(row.rid+' · '+row.secondary)}"><strong>${esc(row.label)}</strong><small>${esc(row.secondary)}</small><span class="comparison-tick">${row.rid===p.selected?icon('valid'):''}</span></button>`;
    }).join('') || '<div class="picker-empty">No comparison matches. Try “any”, “empty”, or “equal”.</div>';
    $('#picker-query').setAttribute('aria-activedescendant', p.index >= 0 ? 'pick-' + p.index : '');
    $('#picker-footer').innerHTML = '<span class="picker-keys">↑ ↓ choose · Enter select · Esc close</span>';
  }

  function operatorPicker(anchor, path) {
    const c = getPath(statement().Resource, path).Condition,
      info = schemaInfo(c, path);
    openSchemaPicker(anchor, {
      mode: 'operator',
      title: 'Comparison',
      width: 370,
      noExpression: true,
      path,
      selected: c.Comparison ?? '=',
      rows: comparisonRows(c.Comparison, {
        multiple: Array.isArray(c.Right) || !!info.prop?.listSet,
        type: info.accessor === 'type'
      }),
      description: info.prop?.label ?? ({
        type: 'Object type',
        linkedTo: 'Linked object',
        parent: 'Parent object',
        createdBy: 'Created by',
        ownership: 'Owner'
      } [info.accessor] ?? info.accessor),
      detail: c.Left,
      select: op => {
        if (op === c.Comparison) return;
        commit(() => setPath(statement().Resource, [...path, 'Condition'], changeComparison(c, op)), 'Comparison changed');
        if (multiComparisons.includes(op)) {
          const value = $$('.schema-value').find(b => b.dataset.path === JSON.stringify(path));
          if (value) valuePicker(value, path);
          else $$('[data-condition]').find(b => b.dataset.condition === JSON.stringify([...path, 'Condition', 'Right']))?.focus();
        }
      }
    });
  }

  function nativeChoiceRows(select) {
    const source = select.id === 'assignment-field' ? $('#assignment-source')?.value : model.scope.find(r => r.rid === select.dataset.rid)
      ?.source;
    return [...select.options].map(o => {
      const prop = select.dataset.scope === 'field' || select.id === 'assignment-field' ? schemaData.classes[source]?.find(p => p
        .accessor === o.value) : null;
      const direction = select.dataset.scope === 'kind' ? reachDirections[o.value] : null;
      return {
        rid: o.value,
        label: prop?.label || direction?.label || o.textContent,
        secondary: prop ? o.value : direction?.verb ?? '',
        icon: select.dataset.scope === 'source' ? 'type' : prop ? 'fieldAssignment' : direction?.icon ?? 'sliders',
        reason: o.disabled ? 'Unavailable' : '',
        depth: 0
      };
    });
  }

  function nativeChoiceKey(el) {
    return JSON.stringify([el.id, el.dataset.scope, el.dataset.rid, el.dataset.condition, el.getAttribute('aria-label')]);
  }

  function nativeChoiceName(select) {
    return select.getAttribute('aria-label') ?? select.closest('label')?.firstChild.textContent.trim() ?? 'Choose value';
  }

  function mountFastChoices() {
    for (const select of $$('#editor select,#dialog select')) {
      const key = nativeChoiceKey(select),
        name = nativeChoiceName(select),
        rows = nativeChoiceRows(select),
        signature = JSON.stringify([rows, select.value, select.disabled]);
      if (select.dataset.fastChoice === signature) continue;
      select.dataset.fastChoice = signature;
      select.hidden = true;
      select.tabIndex = -1;
      select.setAttribute('aria-hidden', 'true');
      const wrap = select.nextElementSibling?.classList.contains('fast-choice') ? select.nextElementSibling : document.createElement(
      'span');
      wrap.className = 'fast-choice';
      wrap.dataset.nativeKey = key;
      if (select.id === 'global-mode' || select.getAttribute('aria-label') === 'Related-object grouping') {
        wrap.classList.add('choice-segment');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', name);
        wrap.innerHTML = rows.map(r =>
          `<button type="button" data-command="native-pick" data-native-key="${esc(key)}" data-value="${esc(r.rid)}" aria-pressed="${r.rid===select.value}" ${select.disabled||r.reason?'disabled':''}>${esc(r.label)}</button>`
          ).join('');
      } else {
        const row = rows.find(r => r.rid === select.value);
        wrap.innerHTML =
          `<button type="button" class="fast-choice-trigger" data-command="native-choose" data-native-key="${esc(key)}" aria-label="${esc(name)}" aria-haspopup="dialog" ${select.disabled?'disabled':''}>${icon(row?.icon??'sliders')}<span>${esc(row?.label??'Choose…')}</span>${icon('down')}</button>`;
      }
      if (select.nextElementSibling !== wrap) select.after(wrap);
    }
    for (const input of $$('#editor input[list],#editor textarea[data-reference-list]')) {
      const list = input.getAttribute('list') ?? input.dataset.referenceList;
      input.removeAttribute('list');
      delete input.dataset.referenceList;
      input.dataset.suggestionList = list;
      const wrap = document.createElement('span');
      wrap.className = 'reference-combo';
      input.before(wrap);
      wrap.append(input);
      const buttonEl = document.createElement('button');
      buttonEl.type = 'button';
      buttonEl.dataset.command = 'reference-choose';
      buttonEl.dataset.nativeKey = nativeChoiceKey(input);
      buttonEl.setAttribute('aria-label', 'Browse ' + input.getAttribute('aria-label').toLowerCase());
      buttonEl.setAttribute('aria-haspopup', 'dialog');
      buttonEl.innerHTML = icon('down');
      wrap.append(buttonEl);
    }
  }

  function nativeSelectFor(el) {
    return $$('#editor select,#dialog select').find(s => nativeChoiceKey(s) === el.dataset.nativeKey);
  }

  function commitNativeChoice(select, value) {
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', {
      bubbles: true
    }));
    mountFastChoices();
  }

  function referenceChoiceRows(input) {
    if (input.dataset.scope) {
      const values = [...new Set([...model.scope.filter(r => r.kind !== 'RoleAssignment' && r.field).map(r => r.field.split('.').at(-1)),
        input.value
      ].filter(Boolean))].sort();
      return values.map(value => {
        const labels = [...new Set(Object.values(schemaData.classes).flat().filter(p => p.accessor === value && fieldKind(p) ===
          'Reference').map(p => p.label).filter(Boolean))];
        const label = labels.length === 1 ? labels[0] : value;
        return {
          rid: value,
          label,
          secondary: label === value ? '' : value,
          icon: 'link',
          group: 'Used in delegations'
        };
      });
    }
    const rows = [],
      used = new Set();
    const path = JSON.parse(input.dataset.condition).slice(0, -2),
      types = typeContext(statement().Resource, path, 'resource');
    for (const type of types)
      for (const prop of schemaData.classes[type] ?? [])
        if (fieldKind(prop) === 'Reference') rows.push({
          rid: 'resource.' + prop.accessor,
          label: prop.label,
          secondary: 'resource.' + prop.accessor,
          icon: 'link',
          group: 'Properties · ' + type
        });

    function visit(node) {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'Reference' && typeof value === 'string' && value !== 'resource.') used.add(value);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    model.policies.forEach(p => visit(p.content));
    if (input.value && input.value !== 'resource.') used.add(input.value);
    for (const value of [...used].sort())
      if (!rows.some(r => r.rid === value)) rows.push({
        rid: value,
        label: value,
        secondary: '',
        icon: 'link',
        group: 'Used in policies'
      });
    return rows;
  }
  async function dropdownCommand(cmd, el) {
    if (await createTestCommand(cmd, el)) return true;
    if (userCommand(cmd, el) || testChangeCommand(cmd, el)) return true;
    if (cmd === 'picker-use-expression') {
      const p = state.picker;
      if (p?.query.trim()) applyPickerSelection(p, p.query.trim());
      return true;
    }
    if (cmd === 'picker-clear-query') {
      state.picker.query = '';
      state.picker.index = 0;
      $('#picker-query').value = '';
      renderPicker();
      $('#picker-query').focus();
      return true;
    }
    if (cmd === 'picker-unselect') {
      const p = state.picker,
        token = p.selectedValues.find(t => String(t) === el.dataset.token);
      p.selectedValues = p.selectedValues.filter(v => v !== token);
      renderPicker();
      $('#picker-query').focus();
      return true;
    }
    if (cmd === 'schema-apply') {
      applyPickerMulti();
      return true;
    }
    if (cmd === 'native-pick') {
      const p = {
        anchor: el,
        focusKey: pickerAnchorKey(el)
      };
      commitNativeChoice(nativeSelectFor(el), el.dataset.value);
      const wrap = $$('.fast-choice').find(x => x.dataset.nativeKey === el.dataset.nativeKey);
      if (wrap)
        for (const b of wrap.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === el.dataset.value));
      restorePickerFocus(p);
      return true;
    }
    if (cmd === 'native-choose') {
      const select = nativeSelectFor(el);
      if (select.id === 'assignment-field' || select.dataset.scope === 'field') {
        const source = select.id === 'assignment-field' ? $('#assignment-source')?.value : model.scope.find(r => r.rid === select.dataset
          .rid)?.source;
        if (source) {
          await loadSchema(source);
          const currentSource = select.id === 'assignment-field' ? $('#assignment-source')?.value : model.scope.find(r => r.rid === select.dataset.rid)?.source;
          if (!select.isConnected || !el.isConnected || currentSource !== source) return true;
          select.innerHTML = (fields[source] ?? []).map(f => option(f, f, select.value)).join('');
        }
      }
      choicePicker(el, {
        title: nativeChoiceName(select),
        width: select.options.length < 7 ? 340 : 410,
        selected: select.value,
        rows: nativeChoiceRows(select),
        select: async value => {
          if (select.dataset.scope === 'source' || select.id === 'assignment-source') await loadSchema(value);
          if (!select.isConnected) return;
          commitNativeChoice(select, value);
          if (select.dataset.scope === 'source' || select.id === 'assignment-source') {
            const next = $$('#editor select,#dialog select').find(s => select.id === 'assignment-source' ? s.id ===
              'assignment-field' : s.dataset.scope === 'field' && s.dataset.rid === select.dataset.rid);
            const trigger = next?.nextElementSibling.querySelector('button');
            if (trigger) void dropdownCommand('native-choose', trigger).catch(showError);
          }
        }
      });
      return true;
    }
    if (cmd === 'reference-types') {
      state.picker?.chooseReferenceType?.();
      return true;
    }
    if (cmd === 'reference-retry') {
      const p = state.picker;
      if (p?.search) { p.search.retry(); renderPicker(); }
      else p?.retryReferences?.();
      $('#picker-query')?.focus();
      return true;
    }
    if (cmd === 'reference-choose') {
      const input = el.previousElementSibling;
      if (input.dataset.scope) {
        await chooseScopeReference(el, input.dataset.rid);
        return true;
      }
      const rows = referenceChoiceRows(input);
      choicePicker(el, {
        title: 'Reference',
        reference: true,
        width: 390,
        selected: input.value,
        rows,
        emptyMessage: 'No saved reference matches. Use this expression to keep what you typed.',
        select: value => {
          input.value = value;
          input.dispatchEvent(new Event('change', {
            bubbles: true
          }));
        }
      });
      $('#picker-query').placeholder = 'Find a reference or type an expression…';
      $('#picker-query').setAttribute('aria-label', 'Find a reference or type an expression');
      return true;
    }
    return false;
  }

  function installDropdownUX() {
    $('#search').addEventListener('keydown', e => {
      if (!['Enter', 'ArrowDown'].includes(e.key)) return;
      const rows = state.search ? $$('#tree .tree-row[data-search-match="true"]') : $$('#tree [data-open]');
      if (!rows.length) return;
      const best = [...rows].sort((a, b) => Number(a.dataset.searchRank ?? 0) - Number(b.dataset.searchRank ?? 0))[0];
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') best.click();
      if (e.key !== 'Enter' || !best.dataset.scopeNode) {
        const key = treeRowKey(best);
        $$('#tree .tree-row').find(row => treeRowKey(row) === key)?.focus();
      }
    });
    // These two render roots also cover dialogs and the alternate assignment view.
    const observer = new MutationObserver(() => mountFastChoices());
    observer.observe($('#editor'), {
      childList: true,
      subtree: true
    });
    observer.observe($('#dialog-content'), {
      childList: true,
      subtree: true
    });
    document.addEventListener('keydown', e => {
      if (state.picker) return;
      const trigger = e.target.closest(
        'button[aria-haspopup="dialog"],.schema-slot,.schema-operator,.folder-picker,[data-command="choose-rule"],.reach-direction,[data-command="choose-object"],[data-command="edit-who"],[data-command="filter-policies"]'
        );
      if (trigger && e.key === 'ArrowDown') {
        e.preventDefault();
        trigger.click();
      }
      if (trigger && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const query = e.key;
        Promise.resolve(command(trigger.dataset.command, trigger)).then(() => {
          if (state.picker) {
            state.picker.query = query;
            state.picker.index = 0;
            $('#picker-query').value = query;
            renderPicker();
          }
        });
      }
      if (e.target.matches('[data-suggestion-list]') && e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        e.target.nextElementSibling.click();
      }
    });
    let menuTyped = '',
      menuTypedAt = 0;
    document.addEventListener('keydown', e => {
      const menu = $('#menu');
      if (menu.hidden || !menu.contains(e.target)) return;
      const items = [...menu.querySelectorAll('button:not([disabled])')],
        index = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        menu.hidden = true;
        restorePickerFocus(state.menuReturn);
        if (state.menuReturn?.anchor.isConnected) state.menuReturn.anchor.focus();
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) %
          items.length]?.focus();
        return;
      }
      if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        menuTyped = Date.now() - menuTypedAt > 600 ? e.key : menuTyped + e.key;
        menuTypedAt = Date.now();
        items.find(b => b.textContent.trim().toLowerCase().startsWith(menuTyped.toLowerCase()))?.focus();
      }
    }, true);
    window.addEventListener('resize', () => {
      if (state.picker) positionPicker();
    });
    document.addEventListener('scroll', e => {
      if (state.picker && !e.target.closest?.('#picker')) positionPicker();
    }, true);
  }

  const userDirectory = {
    users: snapshot.users
  };

  const userLookups = new WeakSet();
  function hydrateTestUser(q) {
    if (q.mode !== 'user' || !q.userId || selectedTestUser(q) || userLookups.has(q)) return;
    userLookups.add(q);
    const requestedId = q.userId, requestedSnapshot = snapshot;
    api({ operation: 'principals', kind: 'User', query: requestedId }).then(result => {
      if (snapshot !== requestedSnapshot || q.userId !== requestedId) return;
      const user = resolveUser(result.choices, requestedId);
      if (!user) return;
      rememberPrincipal(user); q.subject = user.rid;
      if (activeTest(q)) renderDock();
    }).catch(showError);
  }

  function selectedTestUser(q = state.check) {
    const user = resolveUser(userDirectory.users, q.userId);
    return user?.rid === q.subject ? user : null;
  }

  function userPickerButton(user, command = 'choose-test-user') {
    return `<button type="button" class="object-picker picker-trigger user-picker ${user?'has-object':''}" data-command="${command}" aria-label="${user?'Change user: '+esc(user.name)+' ('+esc(user.id)+')':'Choose user'}" aria-haspopup="dialog">${icon('assignment')}<span>${user?'<strong>'+esc(user.name)+'</strong><small>'+esc(user.id)+'</small>':'<strong>Choose a user…</strong><small>Search name or enter user ID</small>'}</span>${icon('search')}</button>`;
  }

  function rememberPrincipal(principal) {
    const key = principal.type === 'Group' ? 'groups' : 'users';
    context[key] = [...context[key].filter(p => p.rid !== principal.rid), principal].slice(-100);
    if (key === 'users') {
      const selected = new Set(context.users.map(u => u.rid));
      userDirectory.users = [...snapshot.users.filter(p => !selected.has(p.rid)), ...context.users];
    }
  }
  function openPrincipalPicker(anchor, kind, selected, select) {
    choicePicker(anchor, {
      title: kind === 'User' ? 'Choose user' : 'Choose group', width: 430,
      selected, rows: [], principalKind: kind,
      description: (kind === 'User' ? 'Users' : 'Groups') + ' in ' + environment.name,
      select: (_value, row) => { if (row?.principal) { rememberPrincipal(row.principal); select(row.principal); } }
    });
    $('#picker-query').setAttribute('aria-label', 'Search ' + kind.toLowerCase() + 's by name or ID');
    $('#picker-query').placeholder = 'Search name or enter ' + kind.toLowerCase() + ' ID…';
  }
  function openUserPicker(anchor, selected, select) { openPrincipalPicker(anchor, 'User', selected, select); }
  function schedulePickerSearch(p, request, accept, key = JSON.stringify(request)) {
    p.acceptSearch = accept;
    p.search ??= createPickerSearch(result => {
      if (state.picker !== p || p.objectTypeBrowse) return;
      p.loading = result.phase === 'loading';
      p.loadError = result.phase === 'failed' ? result.error || 'Search failed. Retry the request.' : '';
      if (result.phase === 'loading') {
        p.emptyMessage = 'Searching…'; p.hasMore = p.resultLimitReached = false;
        if (p.principalKind) p.rows = [];
      } else if (result.phase === 'failed') {
        p.rows = []; p.emptyMessage = p.loadError;
      } else p.acceptSearch(result.result);
      // The caller is already rendering while scheduling. Retry follows the
      // same path; only asynchronous completion needs to request a render.
      if (result.phase !== 'loading') renderPicker();
    });
    p.search.update(key, signal => api(request, { signal }));
  }
  function schedulePrincipalSearch(p) {
    schedulePickerSearch(p, { operation: 'principals', query: p.query.trim(), kind: p.principalKind }, result => {
      const choices = new Map(result.choices.map(u => [u.rid, u]));
      p.rows = userChoiceRows(result.choices).map(row => {
        const principal = choices.get(resolveUser(result.choices, row.id)?.rid);
        if (p.requestReferences && principal) { p.principalRecords.set(principal.rid, principal); return { ...row, rid: principal.rid, principal }; }
        return { ...row, principal };
      });
      p.hasMore = result.hasMore;
      p.emptyMessage = 'No ' + p.principalKind.toLowerCase() + 's match this name or ID.';
    });
  }

  function userCommand(cmd, el) {
    if (cmd === 'choose-assignment-group') {
      openPrincipalPicker(el, 'Group', '', g => {
        $('#global-rid').value = g.rid;
        el.textContent = g.name + ' · ' + g.id;
      });
      return true;
    }
    if (cmd === 'choose-test-user') {
      const q = state.check;
      openUserPicker(el, q.userId, user => {
        q.userId = user.id;
        q.subject = user.rid;
        rememberTestActor(q);
        markTestChanged(q);
        renderDock();
      });
      return true;
    }
    if (cmd === 'choose-assignment-user') {
      openUserPicker(el, $('#global-user-id').value, user => {
        $('#global-user-id').value = user.id;
        el.outerHTML = userPickerButton(user, 'choose-assignment-user');
        $('#dialog-error').textContent = '';
      });
      return true;
    }
    return false;
  }

  function mountAssignmentPrincipal() {
    const mode = $('#global-mode');
    if (!mode) return;
    $('#global-user-field').hidden = mode.value !== 'User';
    $('#global-group-field').hidden = mode.value !== 'Group';
    $('#global-rid').required = mode.value === 'Group';
  }
  document.addEventListener('change', e => {
    if (e.target.id === 'global-mode') mountAssignmentPrincipal();
  });

  function savedTestStatement() {
    return !state.testing && state.kind === 'policy' && canOpenSavedRule(state.rid, state.statement)
      ? baseline.policies.find(p => p.rid === state.rid).content.Statement[state.statement] : null;
  }

  function rememberTestActor(q = state.check) {
    state.testActor = { mode: q.mode, subject: q.subject, userId: q.userId ?? '' };
  }

  function markTestChanged(q = state.check) {
    if (q.result) q.result.stale = true;
    if ($('#check-result') && activeTest(q)) { $('#check-result').innerHTML = renderResult(); mountResult(); }
  }

  function createReady(q) {
    try { return !q.defaultLoading && !Object.keys(q.createNumberDrafts ?? {}).length && !!readCreateValues(q.proposed).type && /^\d+$/.test(createResource(q)); } catch { return false; }
  }

  function focusUnfinishedCreateNumber() {
    const q = state.check, field = Object.keys(q.createNumberDrafts ?? {})[0];
    if (q.action !== 'Create' || field === undefined) return false;
    focusCreateField(field);
    return true;
  }

  function createTypeControl(q) {
    let type = '';
    try { type = readCreateValues(q.proposed).type ?? ''; } catch { /* JSON reports the error. */ }
    return `<div class="create-context-row"><label for="create-type-picker">new.type</label><button id="create-type-picker" class="object-picker" data-command="create-type" aria-label="Choose new object type">${icon('type')}<span><strong>${esc(type || 'Choose type…')}</strong></span>${icon('down')}</button></div>`;
  }

  function testObjectLabel(rid) {
    const object = [...context.objects, ...context.prototypes, ...context.users, ...context.groups].find(o => o.rid === rid);
    return object ? object.name + (object.id ? ' · ' + object.id : '') : rid;
  }

  const createSchemaErrors = new Map();
  const creationRoots = new Map();
  const creationRootLoads = new WeakMap();
  const creationDefaultLoads = new WeakMap();
  function currentCreateContext(q,type,revision) {
    try { return (q.createRevision??0)===revision && readCreateValues(q.proposed).type===type; }
    catch { return false; } // An unfinished JSON edit is not a failed lookup.
  }
  function suggestedCreateFields(q) {
    if (state.matrixTesting && matrixIndex) return [...new Set(matrixIndex.cell(state.matrixTest.role,state.matrixTest.type).rules.filter(r=>r.actions.includes('Create')).flatMap(r=>createInputs(r.statement).fields))];
    return createInputs(savedTestStatement()).fields;
  }
  async function loadCreationRoot(q) {
    let type;try{type=readCreateValues(q.proposed).type;}catch{return;}
    if(!type?.startsWith('Ce')||q.resource||q.omittedValues?.parent||q.createRootLoaded===type)return;
    const revision=q.createRevision??0, pending=creationRootLoads.get(q);
    if(pending?.type===type&&pending.revision===revision)return;
    const request={type,revision};creationRootLoads.set(q,request);
    try{
      if(!creationRoots.has(type))creationRoots.set(type,api({operation:'creation',type}).catch(error=>{creationRoots.delete(type);throw error;}));
      const result=await creationRoots.get(type);
      if(!currentCreateContext(q,type,revision))return;
      q.createRootLoaded=type;
      if(result.root){
        context.objects=[result.root,...context.objects.filter(o=>o.rid!==result.root.rid)];
        if(!q.resource&&!q.omittedValues?.parent)setCreateValue(q,'parent','parent_rid',result.root.rid);
      }
    }catch(error){
      if(!currentCreateContext(q,type,revision))return;
      q.createRootLoaded=type;q.createContextError=error.message;delete q.createContextErrorSource;
    }finally{if(creationRootLoads.get(q)===request)creationRootLoads.delete(q);}
    if(activeTest(q)&&!$('#dock').hidden)renderDock();
    void saveWorkspace().catch(showError);
  }
  async function loadCreateDefault(q,source) {
    const type=readCreateValues(q.proposed).type,revision=q.createRevision??0,
      fields=[...new Set(['name',...suggestedCreateFields(q),...(q.createFields??[])])];
    // Adding fields can start a newer read before the previous one returns.
    // Only its owner may apply values or clear the loading indicator.
    const request={type,revision};creationDefaultLoads.set(q,request);
    const current=()=>creationDefaultLoads.get(q)===request&&currentCreateContext(q,type,revision);
    q.defaultLoading=true;delete q.createContextError;delete q.createContextErrorSource;renderDock();
    try{
      const result=await api({operation:'creation',type,source:source.rid,fields});
      if(!current())return;
      useCreateDefault(q,result.source,result.values);
      q.createLabels={...q.createLabels,...result.labels};
      q.defaultReadFields=fields;q.defaultUnsupported=result.unsupported??[];
      q.createFields=[...new Set([...(q.createFields??[]),...fields.filter(f=>!['type','parent'].includes(f))])];
      context.prototypes=[source,...context.prototypes.filter(o=>o.rid!==source.rid)];
    }catch(error){if(current()){q.createContextError=error.message;q.createContextErrorSource=source;}}
    finally{
      if(creationDefaultLoads.get(q)===request){
        creationDefaultLoads.delete(q);
        if((q.createRevision??0)===revision)delete q.defaultLoading;
      }
      if(activeTest(q)&&!$('#dock').hidden)renderDock();void saveWorkspace().catch(showError);
    }
  }
  const createSchemaLoading = new Set();
  const createLabelRequests = new Map();
  async function loadCreateLabels(q) {
    let values;
    try { values = readCreateValues(q.proposed); } catch { return; }
    const selected = (schemaData.classes[values.type] ?? []).filter(prop => prop.listSet && values.references?.[prop.accessor]);
    let changed = false;
    await Promise.all(selected.map(async prop => {
      const ids = [values.references[prop.accessor]].flat().filter(id => typeof id === 'string' && !q.createLabels?.[id]);
      if (!ids.length) return;
      const key = JSON.stringify([prop.listSet.rid, ids]);
      if (!createLabelRequests.has(key)) {
        if (createLabelRequests.size >= 100) createLabelRequests.delete(createLabelRequests.keys().next().value);
        createLabelRequests.set(key, api({operation:'listItems',set:prop.listSet.rid,query:'',selected:ids}).catch(() => null));
      }
      const result = await createLabelRequests.get(key);
      if (!result) return; // The value remains visible and the picker can retry.
      for (const item of [...(result.choices ?? []), ...(result.selected ?? [])]) if (ids.includes(item.rid)) {
        q.createLabels ??= {};
        const label = item.name + ' · ' + item.id;
        if (q.createLabels[item.rid] !== label) { q.createLabels[item.rid] = label; changed = true; }
      }
    }));
    if (changed) {
      if (activeTest(q) && q.action === 'Create' && !$('#dock').hidden) renderDock();
      void saveWorkspace().catch(showError);
    }
  }
  async function loadCreateSchema(q) {
    let type;
    try { type = readCreateValues(q.proposed).type; } catch { return; }
    if (!type || schemaLoaded.has(type) || createSchemaLoading.has(type) || createSchemaErrors.has(type)) return;
    createSchemaLoading.add(type);
    try { await loadSchema(type); } catch (error) { createSchemaErrors.set(type, error.message); }
    finally { createSchemaLoading.delete(type); }
    if (activeTest(q) && q.action === 'Create' && !$('#dock').hidden) renderDock();
  }

  function createChangeFields(q) {
    let values;
    try { values = readCreateValues(q.proposed); } catch { /* Raw JSON stays editable. */ }
    const parent = values ? createFieldValue(values, 'parent') : { supplied: false },
      destination = typeof parent.value === 'string' ? parent.value : q.resource,
      properties = schemaData.classes[values?.type] ?? [],
      suggested = suggestedCreateFields(q);
    return `<div class="create-context">${createTypeControl(q)}<div class="create-context-row create-default-source"><label for="create-default-picker">Default object<small>Optional</small></label><button id="create-default-picker" type="button" class="object-picker" data-command="create-default" title="Populate initial values from a default object" ${!values?.type||q.defaultLoading?'disabled':''}>${icon('object')}<span><strong>${esc(q.defaultLoading?'Reading default...':q.createDefault?.source.name??'Choose default...')}</strong></span>${icon('search')}</button></div>${q.createContextError?'<p class="field-error">'+esc(q.createContextError)+' <button data-command="create-retry-context">Retry ' + (q.createContextErrorSource ? 'default' : 'destination') + '</button></p>':''}${q.defaultUnsupported?.length?'<p class="field-error">Not copied: '+esc(q.defaultUnsupported.join(', '))+'. Supply these values explicitly.</p>':''}<div class="create-context-row create-destination"><label for="create-parent-picker">new.parent</label><button id="create-parent-picker" type="button" class="object-picker" data-command="create-destination" data-field="parent" aria-label="Choose creation destination" ${!values ? 'disabled' : ''}>${icon('folder')}<span><strong>${esc(destination ? testObjectLabel(destination) : 'Choose destination…')}</strong></span>${icon('search')}</button><button type="button" class="icon-button" data-command="create-omit" data-field="parent" ${!parent.supplied && !q.omittedValues?.parent ? 'disabled' : ''} title="${parent.supplied ? 'Omit new.parent for this test' : 'Restore new.parent'}" aria-label="${parent.supplied ? 'Omit new.parent' : 'Restore new.parent'}">${icon(parent.supplied ? 'close' : 'undo')}</button>${destination && (!parent.supplied || parent.value === null) ? '<span class="test-change-hint">Trace context retained · new.parent ' + (parent.supplied ? 'is null' : 'not supplied') + '</span>' : ''}</div></div>${renderCreateTest(q, { properties, suggested, objectLabel: rid => q.createLabels?.[rid] || testObjectLabel(rid), loaded: schemaLoaded.has(values?.type), icon })}${createSchemaErrors.has(values?.type) ? `<p class="field-error">${esc(createSchemaErrors.get(values.type))} <button type="button" data-command="create-retry-schema">Retry field metadata</button></p>` : ''}`;
  }

  function createProperty(q, field) {
    const values = readCreateValues(q.proposed);
    return schemaData.classes[values.type]?.find(p => p.accessor === field);
  }

  function focusCreateField(field) {
    const q = state.check;
    if (q.action !== 'Create') return false;
    q.createView = 'fields';
    if (!['type', 'parent'].includes(field)) q.createFields = [...new Set([...(q.createFields ?? []), field])];
    renderDock();
    const selector = field === 'type' ? '[data-command="create-type"]' : field === 'parent' ? '[data-command="create-destination"]' : `[data-create-row="${CSS.escape(field)}"] .create-value-control :is(input,button)`;
    const target = $('#dock ' + selector);
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
    return !!target;
  }

  function revealTestTrace(path) {
    const parts = path ? path.split('.') : [], trace = state.check.result?.trace;
    if (trace && $('#check-result .engine-review')) {
      const result=state.check.result;result.engineState??={};
      result.engineState.query='';
      const rules=traceRules(trace),rulePath=rules.find(r=>path===r.path||path.startsWith(r.path+'.'))?.path??parts[0];
      let groupStart=rules.findIndex(r=>r.path===rulePath);
      while(groupStart>0&&rules[groupStart].subject==='failed'&&rules[groupStart-1].subject==='failed'&&rules[groupStart-1].node.result!==true)groupStart--;
      result.engineState.closedGroups=(result.engineState.closedGroups??[]).filter(key=>key!==rules[groupStart]?.path);
      result.engineState.open=[...new Set([...(result.engineState.open??[]),rulePath])];
      $('#check-result').innerHTML=renderResult();mountResult();
      const row=$(`[data-engine-path="${path}"]`)??$(`[data-engine-row="${rulePath}"]`);
      row?.scrollIntoView({block:'nearest'});row?.querySelector('button')?.focus({preventScroll:true});
      return;
    }
    if (!trace) return;
    const full = $('#check-result .test-full-trace');
    if (full) full.open = true;
    let target;
    for (let i = 0; i <= parts.length; i++) {
      target = $(`[data-trace-path="${parts.slice(0, i).join('.')}"]`);
      if (!target) break;
      target.open = true; expandTrace(target, trace);
    }
    target?.querySelector('summary')?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }

  async function createTestCommand(cmd, el) {
    if(cmd==='create-default'){
      const q=state.check,type=readCreateValues(q.proposed).type;
      showPicker(el,{kind:'object',title:'Choose default object · '+type,type,prototypes:true,selected:q.createDefault?.source.rid,
        select:(_rid,source)=>{void loadCreateDefault(q,source);}});return true;
    }
    if(cmd==='create-reset-default'){resetCreateDefault(state.check,el.dataset.field);renderDock();return true;}
    if(cmd==='create-retry-context'){
      const q=state.check;
      if(q.createContextErrorSource)void loadCreateDefault(q,q.createContextErrorSource);
      else{delete q.createRootLoaded;delete q.createContextError;void loadCreationRoot(q);renderDock();}
      return true;
    }
    if (cmd === 'create-principal-kind') { state.picker.principalKind = el.dataset.kind; state.picker.index = 0; renderPicker(); $('#picker-query').focus(); return true; }
    if (cmd === 'reveal-test-trace') { revealTestTrace(el.dataset.traceTarget); return true; }
    if (cmd === 'focus-test-failure') {
      if (!el.dataset.field || !focusCreateField(el.dataset.field)) revealTestTrace(el.dataset.traceTarget);
      return true;
    }
    if (!cmd.startsWith('create-') || !['create-type', 'create-destination', 'create-reference', 'create-literal', 'create-boolean', 'create-omit', 'create-remove-field', 'create-field-menu', 'create-set-empty', 'create-set-null', 'create-add-field', 'create-view', 'create-retry-schema'].includes(cmd)) return false;
    const q = state.check, field = el.dataset.field;
    if (cmd === 'create-view') {
      if (el.dataset.createView === 'json' && focusUnfinishedCreateNumber()) return true;
      if (el.dataset.createView === 'fields') {
        try { readCreateValues(q.proposed); }
        catch { q.createView = 'json'; renderDock(); return true; }
      }
      q.createView = el.dataset.createView; renderDock(); return true;
    }
    if (cmd === 'create-retry-schema') { createSchemaErrors.delete(readCreateValues(q.proposed).type); await loadCreateSchema(q); return true; }
    const values = readCreateValues(q.proposed);
    if (cmd === 'create-type') {
      const suggestions = createInputs(savedTestStatement()).types;
      choicePicker(el, { title: 'New object type', selected: values.type, rows: schemaTypeRows().map(row => ({ ...row, group: suggestions.includes(row.rid) ? 'From the saved rule' : 'Other types' })).sort((a,b) => Number(!suggestions.includes(a.rid)) - Number(!suggestions.includes(b.rid))),
        select: type => { changeCreateType(q,type); renderDock(); } });
      return true;
    }
    if (cmd === 'create-destination') {
      showPicker(el, { kind: 'object', title: 'Create in', containers: true, containerFor: values.type, selected: typeof values.parent_rid === 'string' ? values.parent_rid : q.resource,
        select: (rid) => { setCreateValue(q, 'parent', 'parent_rid', rid); state.recentObjects = [rid, ...state.recentObjects.filter(x => x !== rid)].slice(0,8); renderDock(); } });
      return true;
    }
    if (cmd === 'create-omit') { omitCreateValue(q, field); renderDock(); return true; }
    if (cmd === 'create-remove-field') {
      if (createInputs(savedTestStatement()).fields.includes(field)) return true;
      setCreateValue(q, field, 'properties', undefined);
      q.createFields = q.createFields.filter(name => name !== field);
      if (q.omittedValues) delete q.omittedValues[field];
      renderDock(); $('#dock [data-command="create-add-field"]').focus(); return true;
    }
    if (cmd === 'create-add-field') {
      await loadSchema(values.type);
      if (!activeTest(q) || !el.isConnected) return true;
      choicePicker(el, { title: 'Add an initial value', rows: (schemaData.classes[values.type] ?? []).filter(p => !['type','parent'].includes(p.accessor)).map(p => ({ rid:p.accessor, label:p.label || p.accessor, secondary:p.accessor, detail:fieldKind(p), icon:p.reference?'link':'sliders' })),
        select: name => {
          q.createFields = [...new Set([...(q.createFields ?? []), name])];
          if (q.createDefault && !q.defaultReadFields?.includes(name)) void loadCreateDefault(q,q.createDefault.source);
          else focusCreateField(name);
        } });
      return true;
    }
    const prop = createProperty(q, field), entry = createFieldValue(values, field), kind = entry.kind ?? (prop?.reference ? 'references' : 'properties'),
      label = prop?.label || field;
    const set = value => {
      if (kind === 'references') {
        q.createLabels ??= {};
        for (const rid of [value].flat().filter(v => typeof v === 'string')) {
          const item = prop?.listSet?.items.find(item => item.rid === rid);
          q.createLabels[rid] = item ? item.name + ' · ' + item.id : testObjectLabel(rid);
        }
      }
      setCreateValue(q, field, kind, value); renderDock();
    };
    if (cmd === 'create-field-menu') {
      popup(el, button('json', 'create-literal', 'Edit JSON value…', `data-field="${esc(field)}"`) +
        button('close', 'create-omit', entry.supplied ? 'Omit field' : 'Restore omitted value', `data-field="${esc(field)}" ${!entry.supplied && !q.omittedValues?.[field] ? 'disabled' : ''}`) +
        button('edit', 'create-set-null', 'Supply null', `data-field="${esc(field)}"`) +
        (kind === 'references' && prop?.multiselect || fieldKind(prop) === 'Text' ? button('edit', 'create-set-empty', kind === 'references' ? 'Supply an empty list' : 'Supply empty text', `data-field="${esc(field)}"`) : '') +
        (!createInputs(savedTestStatement()).fields.includes(field) ? button('trash', 'create-remove-field', 'Remove field from test', `data-field="${esc(field)}"`) : ''));
      return true;
    }
    if (cmd === 'create-set-null') { set(null); return true; }
    if (cmd === 'create-set-empty') { set(kind === 'references' ? [] : ''); return true; }
    if (cmd === 'create-literal') {
      dialog('Initial value · ' + label, `<label>JSON value<textarea id="create-literal" spellcheck="false" rows="4">${esc(JSON.stringify(entry.supplied ? entry.value : '', null, 2))}</textarea></label>`, 'Use value', () => {
        const value = JSON.parse($('#create-literal').value);
        if (kind === 'properties' && value !== null && !['string','number','boolean'].includes(typeof value)) throw Error('Use text, a number, a boolean, or null.');
        if (kind === 'references' && value !== null && !([value].flat().every(v => typeof v === 'string' && /^\d+$/.test(v)))) throw Error('Reference JSON requires RID strings. Use the picker to search by name or ID.');
        set(value);
      });
      return true;
    }
    if (cmd === 'create-boolean') {
      choicePicker(el, { title: label, selected: entry.supplied ? String(entry.value) : 'omit', rows: [{rid:'true',label:'true'}, {rid:'false',label:'false'}, {rid:'omit',label:'Not supplied'}], select: value => set(value === 'omit' ? undefined : value === 'true') });
      return true;
    }
    if (cmd === 'create-reference') {
      if (!prop) { q.createView = 'json'; renderDock(); return true; }
      const ids = entry.supplied ? [entry.value].flat().filter(v => typeof v === 'string') : [], multi = prop.multiselect || Array.isArray(entry.value);
      if (prop.listSet) {
        const items = prop.listSet.items;
        openSchemaPicker(el, { mode:'list', title:label, noExpression:true, listProperty:prop, requestReferences:true, multi, selectedValues:ids, selected:ids[0],
          rows:[...items.map(item => ({ rid:item.rid, label:item.name, secondary:item.id, icon:'list' })), ...ids.filter(id => !items.some(item => item.rid === id)).map(id => ({rid:id,label:id,secondary:'Selected value · resolving…'}))],
          select:value => set(value) });
      } else {
        const targets = (prop.targets ?? '').replaceAll('[', '').replaceAll(']', '').split(/[,\s]+/).filter(Boolean).map(t => t.split('.').at(-1));
        if (targets.length && targets.every(t => ['User','Group','Principal'].includes(t))) {
          const kinds = targets.includes('Principal') ? ['User','Group'] : targets, records = new Map([...context.users, ...context.groups].map(p => [p.rid,p]));
          choicePicker(el, { title:label, principalKind:kinds[0], principalKinds:kinds, requestReferences:true, principalRecords:records,
            rows:[], multi, selectedValues:ids, selected:ids[0], select:value => {
              for (const rid of [value].flat()) { const principal = records.get(rid); if (principal) rememberPrincipal(principal); }
              set(value);
            } });
        } else {
          showPicker(el, { kind:'object', title:label, type:targets.length === 1 && Object.hasOwn(schemaData.classes, targets[0]) ? targets[0] : '', multi, selectedValues:ids, selected:ids[0],
            select:value => set(value) });
        }
      }
      return true;
    }
    return false;
  }

  function testChangeFields(q, object) {
    if (q.action === 'Create')
      return createChangeFields(q);
    if (q.action !== 'Update') return '';
    const custom = q.updateMode === 'custom';
    return `<div class="test-change"><div class="test-change-heading"><span>Test change</span><div class="choice-segment" role="group" aria-label="Update test change"><button type="button" data-command="test-update-mode" data-mode="rename" aria-pressed="${!custom}">Rename only</button><button type="button" data-command="test-update-mode" data-mode="custom" aria-pressed="${custom}">Custom change</button></div></div>${custom?`<label>Submitted changes<textarea data-check="proposed" aria-label="Proposed values" rows="4" spellcheck="false">${esc(q.proposed)}</textarea></label><p class="test-change-hint">Tests only these submitted fields. An omitted field in <code>new.*</code> does not read the saved value; use <code>resource.*</code> for that.</p>`:`<label class="test-rename">New name<input data-check="rename" aria-label="Test new name" value="${esc(q.rename??renameExample(object))}" placeholder="Choose an object first" ${object?'':'disabled'}></label><p class="test-change-hint">Simulates a rename. Use a custom change to test other fields.</p>`}</div>`;
  }

  function testChangeCommand(cmd, el) {
    if (cmd !== 'test-update-mode') return false;
    const q = state.check;
    q.updateMode = el.dataset.mode;
    q.result = null;
    if (q.updateMode === 'custom' && q.proposed === '{}') {
      const object = context.objects.find(o => o.rid === q.resource);
      q.proposed = JSON.stringify({
        type: object?.type ?? '',
        properties: object ? {
          name: q.rename ?? renameExample(object)
        } : {}
      }, null, 2);
    }
    renderDock();
    return true;
  }

  function chooseScopeReference(anchor, rid) {
    const row = model.scope.find(r => r.rid === rid);
    if (!row) return;
    const identity = referenceIdentity(row);
    const chooseType = () => choicePicker(anchor, {
      title: 'Reference defined on', reference: false,
      rows: schemaTypeRows(), selected: identity.source,
      description: 'Choose a class, then its reference property.',
      select: openReferences
    });
    function openReferences(type) {
      if (!anchor.isConnected || !model.scope.includes(row)) return;
      choicePicker(anchor, {
        title: 'Reference property', referenceClass: type,
        chooseReferenceType: chooseType,
        rows: [], selected: selectedReferenceAccessor(row, type),
        loading: true, emptyMessage: 'Loading references…',
        select: field => {
          if (!model.scope.includes(row)) return;
          commit(() => {
            Object.assign(row, chooseReference(row, type, field));
            if (row.rid.startsWith('draft:')) row.name = (directions[row.kind] ?? 'Assignment') + ' · ' + field;
          }, 'Reference: ' + type + '.' + field);
        }
      });
      const picker = state.picker;
      picker.retryReferences = () => {
        picker.loading = true; picker.loadError = '';
        picker.emptyMessage = 'Loading references…'; renderPicker();
        loadSchema(type).then(() => {
          // Closing, switching class, or navigating away cancels this view, not the shared schema load.
          if (state.picker !== picker || !anchor.isConnected || !model.scope.includes(row)) return;
          picker.loading = false;
          picker.rows = (schemaData.classes[type] ?? []).filter(p => fieldKind(p) === 'Reference').map(p => ({
            rid: p.accessor, label: p.label || p.accessor, secondary: p.accessor, icon: 'link'
          }));
          picker.emptyMessage = 'No reference properties on this class. Choose another class above.';
          const selected = picker.rows.findIndex(p => p.rid === picker.selected);
          picker.index = Math.max(0, selected);
          renderPicker(); scrollPickerChoice();
        }).catch(error => {
          if (state.picker !== picker) return;
          picker.loading = false; picker.loadError = error.message || String(error);
          picker.emptyMessage = 'Could not load references: ' + picker.loadError;
          renderPicker();
        });
      };
      picker.retryReferences();
    }
    if (identity.source) openReferences(identity.source);
    else chooseType();
  }

  function loadVisibleSchemas() {
    if (state.kind !== 'policy' || state.view === 'json' || !statement()) return;
    const rid = state.rid,
      index = state.statement,
      types = new Set();
    for (const button of $$('.schema-property')) {
      const path = JSON.parse(button.dataset.path),
        c = getPath(statement().Resource, path)?.Condition;
      if (c) {
        const info = schemaInfo(c, path);
        if (info.type && !schemaLoaded.has(info.type)) types.add(info.type);
      }
    }
    if (!types.size) return;
    const failureContext = errorContext('Could not load properties for ' + [...types].join(', '));
    Promise.all([...types].map(loadSchema)).then(() => {
      if (state.rid === rid && state.statement === index && state.view !== 'json' && !document.activeElement?.matches(
          'input,textarea,[contenteditable]')) renderEditor();
    }).catch(error => showError(error, failureContext));
  }

  function errorContext(title = 'Could not complete the operation', records = current() ? [current()] : []) {
    return { tone: 'error', title, targets: records.map(record => ({ label: record.name || record.id || record.subjectName,
      open: () => {
        const kind = model.policies.some(p => p.rid === record.rid) ? 'policy' : 'role';
        const rid = kind === 'role' ? scopeOwner(model, record.rid) ?? record.rid : record.rid;
        if ((kind === 'role' ? model.roles : model.policies).some(r => r.rid === rid)) openRecord(kind, rid, rid === record.rid ? null : record.rid);
        else { state.historyShowing = false; state.reviewing = true; state.reviewOpen = true; render(); }
      } })) };
  }
  function showError(error, context = errorContext()) {
    status(error.message ?? String(error));
    notice(error.message ?? String(error), context);
  }
  async function loadSchema(type) {
    if (!type || schemaLoaded.has(type)) return;
    if (schemaPending.has(type)) return schemaPending.get(type);
    const requestedSnapshot = snapshot;
    const promise = api({
      operation: 'schema',
      type
    }).then(props => {
      if (snapshot !== requestedSnapshot) return;
      schemaData.classes[type] = props;
      schemaLoaded.add(type);
      fields[type] = props.filter(p => p.principal === true).map(p => p.accessor);
    }).finally(() => { if (schemaPending.get(type) === promise) schemaPending.delete(type); });
    schemaPending.set(type, promise);
    return promise;
  }

  async function jsonCatalogue(request, signal) {
    return createPBACCatalogue({getSnapshot:()=>snapshot,getRoles:()=>model.roles,getClasses:()=>schemaData.classes,loadSchema,api})(request,signal);
  }

  function refreshCatalogue(preserveTestInputs = false) {
    const tests = preserveTestInputs ? [...state.tests.values()] : [],
      selected = selectedTestContext(tests, context, userDirectory.users, snapshot.users);
    environment.name = snapshot.name; environment.capturedOn = snapshot.loadedAt;
    matrixEvidence.reset(); matrixBaseline = null; performance.invalidate();
    schemaLoaded.clear(); schemaPending.clear(); schemaHints.clear(); createSchemaErrors.clear(); createLabelRequests.clear(); creationRoots.clear();
    schemaData.classes = clone(snapshot.classes);
    userDirectory.users = snapshot.users;
    context.users = []; context.groups = [];
    for (const user of selected.users) rememberPrincipal(user);
    for (const test of tests) {
      if (test.mode !== 'user') continue;
      const user = resolveUser(userDirectory.users, test.userId);
      if (user) test.subject = user.rid;
    }
    for (const key of Object.keys(fields)) delete fields[key];
    for (const type of Object.keys(snapshot.classes)) fields[type] = [];
    for (const a of model.scope.filter(a => a.kind === 'RoleAssignment' && a.source && a.field)) {
      fields[a.source] ??= [];
      if (!fields[a.source].includes(a.field)) fields[a.source].push(a.field);
    }
    context.objects = selected.objects; context.prototypes = selected.prototypes;
  }

  function scheduleObjectSearch(p) {
    schedulePickerSearch(p, { operation: 'search', query: p.query, type: p.type || undefined,
      prototypes: !!p.prototypes, containers: !!p.containers, containerFor: p.containerFor }, rows => {
      const key = p.prototypes ? 'prototypes' : 'objects',
        retained = new Set([...state.recentObjects, ...[...state.tests.values()].flatMap(testContextRids), ...(p.selectedValues ?? [])]),
        kept = context[key].filter(o => retained.has(o.rid));
      context[key] = [...rows, ...kept.filter(o => !rows.some(r => r.rid === o.rid))];
      p.resultLimitReached = rows.length >= 80;
    });
  }

  function scheduleListSearch(p) {
    const query = p.query.trim(), list = p.listProperty.listSet;
    schedulePickerSearch(p, { operation: 'listItems', set: list.rid, query,
      selected: p.selectedValues ?? (p.selected ? [p.selected] : []) }, result => {
      const selected = new Set(p.selectedValues ?? [p.selected]);
      list.items = [...new Map([...list.items.filter(item => selected.has(p.requestReferences ? item.rid : item.token)), ...result.choices, ...(result.selected ?? [])].map(item => [item.token, item])).values()];
      p.rows = [...(p.requestReferences ? list.items.map(item => ({rid:item.rid, label:item.name, secondary:item.id, icon:'list'})) : listChoiceRows(p.listProperty)), ...(p.rows ?? []).filter(row => selected.has(row.rid) && !list.items.some(item => (p.requestReferences ? item.rid : item.token) === row.rid))];
      p.hasMore = result.hasMore;
      p.emptyMessage = 'No list items match this name or ID.';
    }, JSON.stringify([list.rid, query]));
  }

  function connectionInfo() {
    dialog('Connection · ' + environment.name,
      `<p class="connection-address">${esc(snapshot.environment.split('@').slice(1).join('@'))}</p><p>Loaded ${esc(new Date(snapshot.loadedAt).toLocaleString())}. Drafts and history are kept on this browser.</p><p>Access tests evaluate saved policies. Apply checks for conflicts, previews the changes, then verifies the saved values.</p><button type="button" data-command="reload-workspace">Reload from BMP…</button>`
      );
  }
  async function applyWorkspace() {
    const unfinishedIds = unfinishedIdEdits(model, state.idDraft);
    if (unfinishedIds.length) {
      state.historyShowing = false;
      state.reviewing = state.reviewOpen = true;
      render();
      $('[data-command="finish-id-draft"]')?.focus();
      status('Finish or cancel the business ID edit for ' + unfinishedIds.map(edit => edit.record.name).join(', ') + '.');
      return;
    }
    if (state.raw.size) throw Error('Update or discard pending JSON edits before applying.');
    if (!differences().length) return;
    applying = true;
    const failureContext = errorContext('Could not apply changes', differences().map(d => d.r));
    busy('Checking and applying ' + differences().length + ' changes to ' + environment.name + '…');
    try {
      await saveWorkspace(true);
      const result = await api({
        operation: 'apply',
        baseline,
        draft: model
      });
      snapshot = result.snapshot;
      model = clone(snapshot.model);
      baseline = clone(snapshot.model);
      revision++;
      refreshCatalogue(true);
      folders = model.folders;
      Object.assign(state, stateAfterApply(state, model, result.mapping));
      traceRuns.clear();
      jsonBookmarks.clear(); displayedView = null;
      history.length = 0;
      future.length = 0;
      journal.length = 0;
      historySequence = 0;
      notice('');
      render();
      await saveWorkspace(true);
      if (result.operationId) await api({ operation: 'acknowledge', id: result.operationId });
      status('Applied and verified in ' + environment.name);
    } catch (error) {
      showError(error, failureContext);
    } finally {
      applying = false;
      busy('');
    }
  }

  function reloadWorkspace() {
    dialog('Reload from BMP',
      `<p>Replace this local draft with the current configuration from ${esc(environment.name)}? Pending edits and local history will be removed.</p><p>Export the draft first if you want to keep a copy.</p>`,
      'Reload', async () => {
        busy('Reloading ' + environment.name + '…');
        try {
          const result = await api({
            operation: 'reconcile'
          });
          snapshot = result.snapshot;
          model = clone(snapshot.model);
          baseline = clone(model);
          revision++;
          refreshCatalogue();
          history.length = 0;
          future.length = 0;
          journal.length = 0;
          state.raw.clear();
          state.idDraft.clear();
          jsonBookmarks.clear();
          displayedView = null;
          inputHistory = null; editingElement = null; historySequence = 0;
          state.tests.clear();
          state.tabs = state.tabs.filter(t => (t.kind === 'role' ? model.roles : model.policies).some(r => r.rid === t.rid));
          notice('');
          render();
          await saveWorkspace(true);
          status('Reloaded from BMP');
        } finally {
          busy('');
        }
      });
  }

  function saveWorkspace(immediate = false) {
    if (!persistenceReady) return Promise.resolve();
    // Build the snapshot only when the host debounce flushes, not on each event.
    return persist(() => {
      const compact = m => m;
      const events = journal.map(e => ({
        ...e,
        before: compact(e.before),
        after: compact(e.after)
      }));
      const serialState = {
        ...state,
        collapsedSections,
        picker: null,
        drag: null
      };
      delete serialState.menuReturn;
      const data = {
        version: 1,
        revision,
        snapshot: { ...snapshot, model: baseline },
        model,
        baseline,
        history: history.map(e => e.id),
        future: future.map(e => e.id),
        journal: events,
        historySequence,
        state: encodeWorkspaceState(serialState),
        context
      };
      return data;
    }, immediate);
  }
  if (saved?.state) {
    const restored = decodeWorkspaceState(saved.state);
    Object.assign(state, restored, {
      picker: null,
      drag: null
    });
    state.view = policyEditorView();
    for (const key of restored.collapsedSections ?? []) collapsedSections.add(key);
    if (!restored.collapsedSections) state.membershipSections = new Set();
    for (const test of state.tests.values()) {
      delete test.defaultLoading;
      if (test.result?.running) test.result = { error: 'The previous test was interrupted. Run it again.' };
      else if (test.result) test.result.stale = true;
    }
    journal.push(...(saved.journal ?? []).map(e => ({...e, before: historyContext(e.before, e.patch), after: historyContext(e.after, e.patch)})));
    historySequence = saved.historySequence ?? 0;
    history.push(...(saved.history ?? []).map(id => journal.find(e => e.id === id)).filter(Boolean));
    future.push(...(saved.future ?? []).map(id => journal.find(e => e.id === id)).filter(Boolean));
    Object.assign(context, saved.context ?? {});
    for (const principal of [...context.users, ...context.groups]) rememberPrincipal(principal);
  }
  document.addEventListener('toggle', e => {
    if (e.target.matches?.('[data-trace-path]') && state.check.result?.trace) expandTrace(e.target, state.check.result.trace, canOpenSavedRule);
  }, true);
  for (const event of ['input', 'change', 'click', 'keyup']) document.addEventListener(event, () => queueMicrotask(saveWorkspace));
  window.addEventListener('pagehide', () => {
    void saveWorkspace(true).catch(showError);
  });

  installPolish();
  installWorkspaceUX();
  installDropdownUX();
  let dockWidth = 0;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === dockWidth) return;
    dockWidth = entry.contentRect.width;
    fitTestDock();
    $('#tabs .doc-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }).observe($('.workarea'));
  if (!navigation.pop(window.history.state)) render();
  persistenceReady = true;
  saveWorkspace();
  return {
    enter,
    focusArrival() { if (!saved?.state && state.empty && !state.testing && !state.historyShowing && !state.reviewing) $('#search').focus({ preventScroll: true }); },
    flush: () => saveWorkspace(true),
    hasDraft: () => differences().length > 0 || state.raw.size > 0 || unfinishedIdEdits(model, state.idDraft).length > 0
  };

  function enter(value) {
    const target = parseAccessDestination(value);
    if (!target) return;
    if (applying) { notice('Apply is in progress. Open this link again when it finishes.'); return; }
    if (target.kind === 'test') {
      captureView();
      state.matrixShowing=false; state.matrixTesting=false; state.performanceShowing=false;
      state.testing = true; state.objectTest = target.object;
      state.historyShowing = false; state.reviewing = false; state.empty = true; state.scopeSelection = null;
      state.rid = ''; state.kind = 'role';
      context.objects = [target.object, ...context.objects.filter(o => o.rid !== target.object.rid)];
      state.testOpen.add(testKey());
      if (state.check.resource !== target.object.rid || state.check.action === 'Create') {
        state.check = { ...state.check, action: state.check.action === 'Create' ? 'Read' : state.check.action,
          resource: target.object.rid, proposed: '{}', result: null };
        delete state.check.rename;
      }
      if (innerWidth <= 620) document.body.classList.add('no-explorer');
      render();
      const q = state.check;
      const focus = q.mode === 'user' && !selectedTestUser(q) ? '[data-command="choose-test-user"]' : '[data-command="prepare-check"]';
      $('#dock ' + focus)?.focus({ preventScroll: true });
      return;
    }
    const record = model[target.kind === 'role' ? 'roles' : 'policies'].find(r => r.rid === target.rid);
    if (!record) { notice('This ' + target.kind + ' is not in the loaded configuration. Reload from BMP to check for changes.'); return; }
    if (target.kind === 'policy' && target.statement !== undefined && !canOpenSavedRule(target.rid, target.statement)) {
      notice('This saved rule differs from the local draft. Apply or reload before opening it from the trace.');
      return;
    }
    // A direct target must be visible even when the previous search excluded it.
    state.search = ''; state.searchKind = 'all'; state.roleFilter = '';
    state.documents ??= new Map();
    if (target.kind === 'policy' && target.statement !== undefined) {
      captureView();
      displayedView = null;
      state.documents.set('policy:' + target.rid, { ...state.documents.get('policy:' + target.rid),
        statement: Math.min(target.statement, Math.max(0, (record.content?.Statement?.length ?? 1) - 1)), scroll: 0 });
    }
    for (const folder of ancestry(model.folders, record.parent)) state.folderClosed.delete(folder.rid);
    renderTree();
    openRecord(target.kind, target.rid);
    // Keep the user's editor preference. JSON users land on the exact statement too.
    if (target.kind === 'policy' && target.statement !== undefined && state.view === 'json') {
      if (jsonEditor) { jsonEditor.revealStatement(state.statement); jsonEditor.focus(); return; }
      else pendingJSONStatement = state.statement;
    }
    $('#editor').focus({ preventScroll: true });
  }
}
