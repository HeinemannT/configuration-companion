// Transposed access matrix: object types run down in collapsible bands, roles run
// across under a sticky header. Rows are virtualised and kept by index: scrolling
// only adds the rows that enter the window and removes the ones that leave it.
// The view owns rendering, focus and its filters; the workspace owns navigation,
// saved models and tests. No backend requests originate here.
import { icon } from './icons';
import { PBAC_ACTIONS } from './pbac-syntax';
import { ANY_TYPE, typeName, BANDS, MARKS, KINDS, kindWords, cellKinds, cellInherited, matrixGridState, transposeMatrix, cellMarks, cellWhy, rowOffsets, visibleRange, unresolvedWords, selectionVisible } from './matrix-grid.js';
import { statementSummary } from './statement-model';
import { UNDECIDED, UNDECIDED_GLYPH, UNDECIDED_MEANING } from './access-terms';

import { escapeHtml as esc } from '../lib/escape';
const key = (rid, type = '') => rid + '|' + type;
export const GLYPH = { granted: '✓', inherited: '↓', conditional: '◐', unresolved: UNDECIDED_GLYPH, none: '' };
// The marks after a conditional letter, one per kind of condition: a dot (the user themself),
// an arrow (another object), a square (a model), a star (some objects). Drawn on one 8px grid.
const MARK_SPRITE = '<svg class="mk-sprite" width="0" height="0" aria-hidden="true">'
  + '<symbol id="mk-own" viewBox="0 0 8 8"><circle cx="4" cy="4" r="2.3" fill="currentColor"/></symbol>'
  + '<symbol id="mk-related" viewBox="0 0 8 8"><path d="M1.6 6.4 6.2 1.8M2.9 1.6h3.5v3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>'
  + '<symbol id="mk-model" viewBox="0 0 8 8"><rect x="1.4" y="1.4" width="5.2" height="5.2" rx=".6" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>'
  + '<symbol id="mk-more" viewBox="0 0 8 8"><path d="M4 1.2v5.6M1.2 4h5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>'
  + '<symbol id="mk-some" viewBox="0 0 8 8"><path d="M4 .9v6.2M1.3 2.45l5.4 3.1M6.7 2.45l-5.4 3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></symbol></svg>';
const kindMark = kind => `<svg class="mk ${kind}" aria-hidden="true"><use href="#mk-${kind}"/></svg>`;
/** One operation of a cell: its letter, bold when unconditional, with up to two marks when it
 *  hangs on a condition (with three or more kinds: the first and a plus), faded when it comes from a parent role or Everyone. The marks sit in a
 *  small column after the letter: one mark raised, two marks one above the other. */
export function slotHTML(action, mark, kinds = [], inherited = false) {
  if (mark === 'none') return '<span class="m none"></span>';
  if (mark === 'unresolved') return `<span class="m unresolved" title="${esc(action + ': ' + UNDECIDED.toLowerCase())}">${GLYPH.unresolved}</span>`;
  const conditional = mark === 'conditional';
  const title = action + ': ' + (conditional ? kindWords(kinds) : 'all objects') + (inherited ? ', inherited' : '');
  return `<span class="m ${conditional ? 'conditional' : 'granted'}${inherited ? ' inh' : ''}" title="${esc(title)}">${action[0]}${conditional ? `<span class="mks${kinds.length > 1 ? ' two' : ''}">${(kinds.length > 2 ? [kinds[0], 'more'] : kinds).map(kindMark).join('')}</span>` : ''}</span>`;
}
const BAND_H = 34, ROW_H = 28, OVERSCAN = 12;
const DEFINITE = new Set(['granted', 'inherited', 'conditional']);

export function matrixState() {
  return { ...matrixGridState(), width: 320 };
}

/** Bring an older saved matrix state into the current shape. */
function normalise(s) {
  const fresh = matrixState();
  for (const k of Object.keys(fresh)) if (s[k] === undefined) s[k] = fresh[k];
  if (!['All', ...PBAC_ACTIONS].includes(s.lens)) s.lens = 'All';
  s.closed = Array.isArray(s.closed) ? s.closed.filter(b => BANDS.includes(b)) : [];
  if (!Array.isArray(s.scroll)) s.scroll = [0, 0];
  if (s.selected && (typeof s.selected.role !== 'string' || typeof s.selected.type !== 'string')) s.selected = null;
  if (!PBAC_ACTIONS.includes(s.action)) s.action = 'Read';
}

export function mountMatrix(host, { index, state: s, openRule, test, canOpen, changed, metadataStatus = '', pending = false, retryEvidence, moreEvidence, hasDraftChanges = false }) {
  normalise(s);
  let grid, offsets, columns = '', frame = 0, disposed = false, resizeObserver, shownRange = [0, 0], tabbable = null;
  const mounted = new Map(), cellCache = new Map(), template = document.createElement('template');
  const q = selector => host.querySelector(selector);
  const roleById = rid => index.roles.find(r => r.rid === rid);

  /** Cell content and name, computed once per render state. */
  function cell(role, type) {
    const k = role.rid + '|' + type;
    if (cellCache.has(k)) return cellCache.get(k);
    const marks = cellMarks(index, role.rid, type), ops = s.lens === 'All' ? PBAC_ACTIONS : [s.lens];
    const kinds = a => marks[a] === 'conditional' ? cellKinds(index, role.rid, type, a) : [];
    const inherited = a => marks[a] !== 'none' && marks[a] !== 'unresolved' && cellInherited(index, role.rid, type, a);
    let html;
    if (s.lens !== 'All') {
      const mark = marks[s.lens];
      // One operation: the answer in words. A condition says its kind; "?" stays a muted mark.
      html = mark === 'conditional' ? `<span class="lw conditional${inherited(s.lens) ? ' inh' : ''}" title="${esc(s.lens + ': ' + kindWords(kinds(s.lens)))}">${kinds(s.lens).slice(0, 2).map(kindMark).join('')}<span class="lwt">${esc(kinds(s.lens).map(k => KINDS[k].short).join(', '))}</span></span>`
        : DEFINITE.has(mark) ? `<span class="lw ${mark}">${esc(MARKS[mark].word)}</span>` : `<span class="m ${mark}">${GLYPH[mark]}</span>`;
    } else html = `<span class="slots">${PBAC_ACTIONS.map(a => slotHTML(a, marks[a], kinds(a), inherited(a))).join('')}</span>`;
    const say = a => a + ' ' + MARKS[marks[a]].word.toLowerCase() + (marks[a] === 'conditional' ? ' (' + kindWords(kinds(a)) + ')' : '');
    const value = { html, label: role.name + ', ' + typeName(type) + ': ' + ops.map(say).join(', '), open: ops.some(a => marks[a] === 'unresolved') };
    cellCache.set(k, value);
    return value;
  }

  function grantedBy(rid, type) {
    const why = cellWhy(index, rid, type).filter(w => s.lens === 'All' || w.action === s.lens);
    const rules = [...new Map(why.flatMap(w => w.rules).map(r => [r.rule.key, r])).values()];
    if (!rules.length) return '';
    const first = rules.slice(0, 2).map(r => `${esc(r.rule.policy.name)} #${r.rule.index + 1}${r.via !== 'own' ? ' · <em>' + esc(r.label) + '</em>' : ''}`).join('; ');
    return first + (rules.length > 2 ? `; <em>+${rules.length - 2} more</em>` : '');
  }

  function rowHTML(row, i) {
    const top = offsets[i];
    if (row.kind === 'band') {
      const label = row.open ? `${row.shown} of ${row.total} types shown` : `${row.total} types`;
      return `<div class="mb" role="row" aria-rowindex="${i + 2}" style="top:${top}px;${columns}"><div class="mc type" role="rowheader"><button type="button" class="band-toggle" title="${esc(row.group)}, ${label}" data-matrix-band="${esc(row.group)}" data-grid-key="${esc(key('band', row.group))}" tabindex="-1" aria-expanded="${row.open}"><span class="cv ${row.open ? '' : 'cl'}">${icon('down')}</span><b>${esc(row.group)}</b><span class="ct">${label}</span></button></div>${grid.roles.map(r => `<div class="mc cnt ${s.selected?.role === r.rid ? 'hl' : ''}" role="gridcell">${esc(row.counts.get(r.rid)?.text ?? '')}</div>`).join('')}${s.role ? '<div class="mc" role="gridcell"></div>' : ''}</div>`;
    }
    const selectedRow = s.selected?.type === row.id;
    return `<div class="mr ${row.any ? 'any ' : ''}${selectedRow ? 'rowsel' : ''}" role="row" aria-rowindex="${i + 2}" style="top:${top}px;${columns}"><div class="mc type" role="rowheader"><span class="nm" title="${esc(row.any ? 'Statements that name no object type. They apply to every type, in addition to what each type shows.' : row.id)}">${esc(typeName(row.id))}</span></div>${grid.roles.map(r => {
      const on = s.selected?.role === r.rid && s.selected?.type === row.id, c = cell(r, row.id);
      return `<div class="mc cell ${on ? 'on' : ''} ${s.selected?.role === r.rid ? 'hl' : ''}" role="gridcell"><button type="button" class="mx-cell" data-grid-key="${esc(key(r.rid, row.id))}" data-matrix-cell="${esc(r.rid)}" data-type="${esc(row.id)}" tabindex="-1" aria-pressed="${on}" aria-label="${esc(c.label)}">${c.html}</button></div>`;
    }).join('')}${s.role ? `<div class="mc why" role="gridcell">${grantedBy(s.role, row.id)}</div>` : ''}</div>`;
  }

  function roleHeader(r) {
    return `<div class="mc role ${s.selected?.role === r.rid ? 'hl' : ''}" role="columnheader"><button type="button" data-matrix-role="${esc(r.rid)}" aria-label="${esc(r.name + ' (' + r.id + '). ' + (s.role ? 'Show all roles' : 'Show only this role'))}" title="${esc(r.name + '\n' + r.id + '\n' + (s.role ? 'Show all roles' : 'Show only this role'))}"><b>${esc(r.name)}</b></button></div>`;
  }

  function why() {
    const sel = s.selected, role = sel && roleById(sel.role);
    if (!role) return `<aside class="mside" aria-label="Cell details"><p class="qt big">Select a cell to see which statements produce it.</p></aside>`;
    const rows = cellWhy(index, role.rid, sel.type);
    const reasons = unresolvedWords(rows.flatMap(w => w.unresolved.flatMap(u => u.reasons ?? [])));
    const word = w => w.mark === 'none' ? 'not granted: no statement grants it' : w.mark === 'unresolved' ? UNDECIDED.toLowerCase()
      : w.mark === 'conditional' ? 'only ' + kindWords(w.kinds) + (w.inherited ? ', inherited' : '') : MARKS[w.mark].word.toLowerCase();
    return `<aside class="mside" aria-label="Why ${esc(role.name)} on ${esc(typeName(sel.type))}"><div class="ch"><div class="pn"><b>${esc(role.name)} on ${esc(sel.type === ANY_TYPE ? 'any type' : sel.type)}</b><code>${esc(role.id)}</code></div></div><div class="cband">Why, by operation</div>${rows.map(w => `<div class="wy"><div class="wh"><b>${w.action}</b><span aria-hidden="true">${slotHTML(w.action, w.mark, w.kinds, w.inherited)}</span><span class="st2">${esc(word(w))}</span></div>${w.rules.map(r => { const sum = statementSummary(r.rule.statement, index.roles); return `<button type="button" class="gl" data-matrix-open="${esc(r.rule.policy.rid)}" data-statement="${r.rule.index}" ${canOpen(r.rule.policy.rid, r.rule.index) ? '' : 'disabled title="The saved statement differs from your unsaved changes; save or reload to open it"'}><span class="pl">${esc(r.rule.policy.name)}</span><span class="sn">#${r.rule.index + 1}</span><span class="open-label">Open</span><span class="why">${esc(sum.effect + ' ' + sum.subjects.map(c => c.name).join(', ') + ', ' + sum.resource.text)}${r.label ? ' · ' + esc(r.label) : ''}${r.kinds?.length ? ' · only ' + esc(kindWords(r.kinds)) : ''}</span></button>`; }).join('')}</div>`).join('')}${rows.some(w => w.mark === 'conditional') ? '<p class="qt">Under a condition: the statement grants it for some objects of this type only. Test a real object to settle one case.</p>' : ''}${reasons.length ? `<p class="qt">${esc(UNDECIDED_MEANING)} Why here: ${esc(reasons.join('; '))}.</p>` : ''}<div class="actrow"><label class="chk">Operation <select data-matrix-action aria-label="Operation to test">${PBAC_ACTIONS.map(a => `<option value="${a}" ${s.action === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label><button type="button" class="ui-btn sm" data-matrix-test>${icon('run')}Test as ${esc(role.name)}</button></div></aside>`;
  }

  function legend() {
    return `<div class="legend" role="note"><span><span aria-hidden="true">${slotHTML('Read', 'granted')}</span>all objects</span>${Object.keys(KINDS).map(k => `<span title="${esc(KINDS[k].title)}"><span aria-hidden="true">${slotHTML('Read', 'conditional', [k])}</span>${esc(KINDS[k].word)}</span>`).join('')}<span><span aria-hidden="true">${slotHTML('Read', 'granted', [], true)}</span>inherited</span><span><span class="m unresolved" aria-hidden="true">${GLYPH.unresolved}</span>${esc(UNDECIDED.toLowerCase())}</span><span class="spacer"></span><span class="mfoot">Saved policies${hasDraftChanges ? ' · Unsaved changes are not included' : ''}. No mark: not granted.${metadataStatus ? ' · ' + esc(metadataStatus) : ''}</span>${retryEvidence ? '<button type="button" class="ui-tbtn" data-matrix-retry>Retry evidence</button>' : ''}${moreEvidence ? '<button type="button" class="ui-tbtn" data-matrix-more>Load next references</button>' : ''}</div>`;
  }

  function toolbar() {
    const role = s.role && roleById(s.role);
    return `<div class="mt" role="toolbar" aria-label="Matrix filters">${role ? `<span class="chip filter-chip">${icon('role')}Role: ${esc(role.name)}<button type="button" class="ui-ibtn ui-ibtn-sm" data-matrix-role-clear aria-label="Show all roles">${icon('close')}</button></span>` : `<label class="srch ui-search">${icon('search')}<input data-matrix-input="roleQ" value="${esc(s.roleQ)}" placeholder="Find role" aria-label="Find role"></label>`}<label class="srch ui-search">${icon('search')}<input data-matrix-input="typeQ" value="${esc(s.typeQ)}" placeholder="Find type" aria-label="Find type"></label><div class="seg" role="group" aria-label="Operations shown"><span class="sl" aria-hidden="true">Show</span>${['All', ...PBAC_ACTIONS].map(a => `<button type="button" data-matrix-lens="${a}" aria-pressed="${s.lens === a}">${a}</button>`).join('')}</div><label class="chk" title="Hide types where no shown role has a grant"><input type="checkbox" data-matrix-empty ${s.hideEmpty ? 'checked' : ''}>Hide empty</label><span class="sr-only" role="status" aria-live="polite">${esc(liveSummary())}</span></div>`;
  }

  function liveSummary() {
    const types = grid.rows.filter(r => r.kind === 'type').length;
    return `${grid.roles.length} ${grid.roles.length === 1 ? 'role' : 'roles'}, ${types} types shown, operation ${s.lens}.`;
  }

  function emptyMessage() {
    if (!grid.roles.length) return '<p class="state-note">No role matches the filter.</p>';
    if (grid.rows.some(r => r.kind === 'type') || grid.rows.every(r => !r.open)) return '';
    return `<div class="state-note mempty" role="status">No type has a grant ${s.role ? 'for this role ' : ''}under ${s.lens === 'All' ? 'any operation' : s.lens}.${s.hideEmpty ? ' <button type="button" class="ui-tbtn" data-matrix-show-empty>Show empty rows</button>' : ''}</div>`;
  }

  function capture() {
    const scroller = q('.mscroll');
    if (scroller) s.scroll = [scroller.scrollLeft, scroller.scrollTop];
  }

  function render() {
    grid = transposeMatrix(index, s, { pending });
    if (s.selected && !selectionVisible(grid, s.selected)) s.selected = null; // the panel follows only cells on the grid
    offsets = rowOffsets(grid.rows, BAND_H, ROW_H);
    columns = `grid-template-columns: var(--mx-type) repeat(${grid.roles.length}, var(--mx-role))${s.role ? ' minmax(240px, 1fr)' : ''};`;
    cellCache.clear(); mounted.clear(); shownRange = [0, 0]; tabbable = null;
    const active = document.activeElement && host.contains(document.activeElement) ? document.activeElement : null;
    const attr = active && [...active.attributes].find(a => a.name.startsWith('data-matrix-'))?.name;
    const focus = active ? { key: active.dataset.gridKey, attr, value: attr ? active.getAttribute(attr) : null, selection: active.matches('input:not([type=checkbox])') ? [active.selectionStart, active.selectionEnd] : null } : null;
    const anyOpen = grid.roles.some(r => grid.rows.some(row => row.kind === 'type' && cell(r, row.id).open));
    host.innerHTML = `<div class="mx ui">${MARK_SPRITE}${toolbar()}${anyOpen ? '<p class="mnote">? means Companion could not read or load what it needs to tell. Select the cell for the reason.</p>' : ''}<div class="mwork"><div class="mscroll" role="grid" aria-label="Access matrix: object types by role" aria-rowcount="${grid.rows.length + 1}" aria-colcount="${grid.roles.length + 1 + (s.role ? 1 : 0)}"><div class="mh" role="row" aria-rowindex="1" style="${columns}"><div class="mc type corner" role="columnheader">Object type</div>${grid.roles.map(roleHeader).join('')}${s.role ? '<div class="mc role" role="columnheader"><b>Granted by</b><span class="sub">statements in saved policies</span></div>' : ''}</div><div class="mbody" style="height:${offsets[grid.rows.length]}px"></div>${emptyMessage()}</div>${why()}</div>${legend()}</div>`;
    const scroller = q('.mscroll');
    [scroller.scrollLeft, scroller.scrollTop] = s.scroll;
    renderRows();
    scroller.addEventListener('scroll', () => { capture(); if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderRows(); }); }, { passive: true });
    resizeObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => { if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; renderRows(true); }); });
      resizeObserver.observe(scroller);
    }
    if (focus) {
      const target = focus.key ? gridTarget(focus.key) : focus.attr ? [...host.querySelectorAll(`[${focus.attr}]`)].find(el => el.getAttribute(focus.attr) === focus.value) : null;
      target?.focus({ preventScroll: true });
      if (target && focus.selection && target.setSelectionRange) target.setSelectionRange(...focus.selection);
    }
  }

  /** Mount rows entering the window, drop rows leaving it; no work while the window is unchanged. */
  function renderRows(force = false) {
    const body = q('.mbody'), scroller = q('.mscroll');
    if (!body) return;
    const [from, to] = visibleRange(offsets, Math.max(0, scroller.scrollTop - 40), scroller.clientHeight || 720, OVERSCAN);
    if (!force && from === shownRange[0] && to === shownRange[1] && mounted.size) { syncTabStop(); return; }
    shownRange = [from, to];
    for (const [i, el] of mounted) if (i < from || i >= to) { el.remove(); mounted.delete(i); }
    let html = '';
    const added = [];
    for (let i = from; i < to; i++) if (!mounted.has(i)) { html += rowHTML(grid.rows[i], i); added.push(i); }
    if (added.length) {
      template.innerHTML = html;
      const elements = [...template.content.children];
      added.forEach((i, k) => mounted.set(i, elements[k]));
      body.append(template.content);
    }
    syncTabStop();
  }

  /** One tab stop in the grid: the focused, remembered or selected cell, else the first. */
  function syncTabStop() {
    const active = host.contains(document.activeElement) ? document.activeElement.dataset.gridKey : null;
    const target = gridTarget(active ?? s.focus) || gridTarget(s.selected ? key(s.selected.role, s.selected.type) : '') || q('.mbody [data-grid-key]');
    if (tabbable === target) return;
    if (tabbable) tabbable.tabIndex = -1;
    if (target) target.tabIndex = 0;
    tabbable = target;
  }

  function gridTarget(value) {
    if (!value) return null;
    const [rid, type] = value.split('|');
    const i = rid === 'band' ? grid.rows.findIndex(r => r.kind === 'band' && r.group === type) : grid.rows.findIndex(r => r.kind === 'type' && r.id === type);
    const row = mounted.get(i);
    return row ? [...row.querySelectorAll('[data-grid-key]')].find(el => el.dataset.gridKey === value) ?? null : null;
  }

  /** Navigable rows: bands and types, in display order. */
  function moveFocus(from, rowStep, colStep, e) {
    const [rid, type] = from.split('|');
    const rowIndex = rid === 'band' ? grid.rows.findIndex(r => r.kind === 'band' && r.group === type) : grid.rows.findIndex(r => r.kind === 'type' && r.id === type);
    let col = rid === 'band' ? 0 : grid.roles.findIndex(r => r.rid === rid) + 1;
    let row = rowIndex;
    if (e.key === 'PageUp' || e.key === 'PageDown') rowStep *= Math.max(1, Math.floor((q('.mscroll').clientHeight || 600) / ROW_H) - 2);
    row = Math.max(0, Math.min(grid.rows.length - 1, row + rowStep));
    col = Math.max(0, Math.min(grid.roles.length, col + colStep));
    if (e.key === 'Home') { col = 0; if (e.ctrlKey) row = 0; }
    if (e.key === 'End') { col = grid.roles.length; if (e.ctrlKey) row = grid.rows.length - 1; }
    const target = grid.rows[row];
    const next = target.kind === 'band' || col === 0 ? (target.kind === 'band' ? key('band', target.group) : key(grid.roles[0]?.rid ?? '', target.id)) : key(grid.roles[col - 1].rid, target.id);
    const scroller = q('.mscroll');
    if (offsets[row] < scroller.scrollTop + ROW_H) scroller.scrollTop = Math.max(0, offsets[row] - ROW_H);
    else if (offsets[row + 1] > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = offsets[row + 1] - scroller.clientHeight;
    capture();
    s.focus = next;
    renderRows();
    gridTarget(next)?.focus({ preventScroll: true });
    syncTabStop();
  }

  const toggle = (values, v) => values.includes(v) ? values.filter(x => x !== v) : [...values, v];
  function click(e) {
    const b = e.target.closest('button'); if (!b || !host.contains(b)) return;
    capture();
    if (b.hasAttribute('data-matrix-retry')) { retryEvidence?.(); return; }
    if (b.hasAttribute('data-matrix-more')) { moreEvidence?.(); return; }
    if (b.dataset.matrixLens) s.lens = b.dataset.matrixLens;
    else if (b.dataset.matrixBand) { s.closed = toggle(s.closed, b.dataset.matrixBand); s.focus = b.dataset.gridKey; }
    else if (b.dataset.matrixCell) { s.selected = { role: b.dataset.matrixCell, type: b.dataset.type }; s.focus = b.dataset.gridKey; }
    else if (b.dataset.matrixRole) { s.role = s.role === b.dataset.matrixRole ? '' : b.dataset.matrixRole; s.scroll = [0, s.scroll[1]]; }
    else if (b.hasAttribute('data-matrix-role-clear')) s.role = '';
    else if (b.hasAttribute('data-matrix-show-empty')) s.hideEmpty = false;
    else if (b.hasAttribute('data-matrix-test')) { test(s.selected.type === ANY_TYPE ? { ...s.selected, type: '' } : s.selected, s.action); return; } // the Any type row names no type to test
    else if (b.dataset.matrixOpen) { openRule(b.dataset.matrixOpen, Number(b.dataset.statement)); return; }
    else return;
    render(); changed();
    if (b.hasAttribute('data-matrix-role-clear')) q('[data-matrix-input="roleQ"]')?.focus();
  }
  function input(e) { if (!e.target.dataset.matrixInput) return; capture(); s[e.target.dataset.matrixInput] = e.target.value; s.scroll = [0, 0]; render(); changed(); }
  function change(e) {
    if (e.target.hasAttribute('data-matrix-action')) { s.action = e.target.value; changed(); return; }
    if (!e.target.hasAttribute('data-matrix-empty')) return;
    capture(); s.hideEmpty = e.target.checked; s.scroll = [0, 0]; render(); changed();
  }
  function focusin(e) { if (!e.target.dataset.gridKey) return; s.focus = e.target.dataset.gridKey; syncTabStop(); }
  function keyboard(e) {
    if (!e.target.dataset?.gridKey) return;
    const steps = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-1, 0], PageDown: [1, 0], Home: [0, 0], End: [0, 0] };
    if (!steps[e.key]) return;
    e.preventDefault(); e.stopPropagation();
    moveFocus(e.target.dataset.gridKey, ...steps[e.key], e);
    changed();
  }
  host.addEventListener('click', click); host.addEventListener('input', input); host.addEventListener('change', change);
  host.addEventListener('focusin', focusin); host.addEventListener('keydown', keyboard);
  render();
  /** Scroll and render synchronously (the scroll bench uses this). */
  function scrollTo(top) { const scroller = q('.mscroll'); scroller.scrollTop = top; capture(); renderRows(); }
  return { capture, scrollTo, destroy() {
    if (disposed) return; disposed = true; capture(); cancelAnimationFrame(frame); resizeObserver?.disconnect();
    host.removeEventListener('click', click); host.removeEventListener('input', input); host.removeEventListener('change', change);
    host.removeEventListener('focusin', focusin); host.removeEventListener('keydown', keyboard);
  } };
}
