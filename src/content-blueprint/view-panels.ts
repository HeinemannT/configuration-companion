/**
 * Blueprint chrome panels — the self-contained overlay surfaces that frame the editor: the command
 * chip, the apply-preview modal, the pending-changes tray, and the gesture hint bar. These are pure
 * builders: they read `bp`/the model and wire controller actions onto buttons, but never call
 * `render()` themselves (the actions do), so there's no import cycle with view.ts. The box/zone
 * builders and the tab/picker/rename cluster (which is coupled to inline-rename + render) stay in
 * view.ts.
 */
import { withShortcut, shortcutLabel } from '../lib/shortcuts';
import { planStepId, type LModel, type LNode, type PlanNote, type PlanStep } from '../lib/layout/types';
import type { BlueprintCtx } from '../lib/layout/sync';
import { findNode, isResultTab, eachInSubtree } from '../lib/layout/model';
import { getTypeAbbr, getTypeColor } from '../lib/types';
import { lint } from '../lib/layout/constraints';
import { diff, summarizeChanges } from '../lib/layout/diff';
import { flowDiff } from '../lib/layout/flow';
import { compile } from '../lib/layout/ec';
import { ICON_PLUS, ICON_PENCIL, ICON_TRASH, ICON_X, ICON_SWAP, ICON_ARROW_RIGHT, ICON_ARROW_UNDO, ICON_ARROW_REDO, ICON_LIST, ICON_BLUEPRINT, ICON_PAINT, ICON_WARNING, ICON_SLIDERS, ICON_COPY, ICON_EYE_SLASH } from '../lib/icons';
import { objectChip } from '../lib/object-chip';
import {
  PORTABLE_ID_TOKENS,
  portableIdExample,
  portableIdPatternError,
} from '../lib/layout/portable-ids';
import { copyWithToast } from '../lib/copy-feedback';
import { bp, model, type ApplyOutcome } from './state';
import type { ApplyReview } from './apply-session';
import { currentCommandActor, onCommandActorChange, readCommandActor } from '../lib/command-actor';
import { setIcon, mkBtn, mkIconBtn, mkUserBtn, sp } from './geometry';
import { isUserAction } from '../lib/trusted-event';
import { closePreview, confirmApply, revertNode, undo, redo, toggleTray, togglePeek, toggleSettings, closeSettings, discard, armDiscard, disarmDiscard, openApplyPreview, exitBlueprint, setMode, dismissApplyOutcome } from './actions';
import { setEditTarget } from '../content-blueprint'; // runtime-only (click handler) — no init-time cycle
import { setNativeEditPageSuppressed } from './edit-page-native';
import {
  persistPortableIdPattern,
  portableIdsAvailable,
  setPortableIdPatternDraft,
  setPortableIdsEnabled,
} from './id-config';

function setPeekPresentation(active: boolean): void {
  const layer = bp.layer;
  if (!layer) return;
  layer.classList.toggle('bp-peek', active);
  setNativeEditPageSuppressed(!active);
  const workspace = layer.querySelector<HTMLElement>('.bp-editpage-workspace');
  if (!workspace) return;
  workspace.inert = active;
  workspace.setAttribute('aria-hidden', String(active));
}

const VERB_ICON: Record<PlanNote['verb'], string> = { create: ICON_PLUS, update: ICON_PENCIL, move: ICON_ARROW_RIGHT, reorder: ICON_SWAP, delete: ICON_TRASH };

/** Scope accent class for the chip / header / modal: TEMPLATE = blue (` tmpl`), an instance reusing a
 *  template = orange (` inst`), a plain page = none. One place so the three surfaces can't disagree. */
export function scopeClass(ctx: BlueprintCtx): string {
  if (ctx.target === 'template') return ' tmpl';
  if (ctx.templateId) return ' inst';
  return '';
}

/** A warning banner row: a leading warning-triangle icon followed by the message
 *  text (replaces the former text '⚠ ' prefix). */
function warnRow(text: string): HTMLElement {
  const w = document.createElement('div'); w.className = 'bp-modal-warn';
  const ic = document.createElement('span'); ic.className = 'bp-modal-warn-ic'; setIcon(ic, ICON_WARNING);
  w.append(ic, document.createTextNode(text));
  return w;
}

/** A neutral scope-note row (muted, no warning weight) — for "this applies to the instance" and the
 *  like, which a user should see but which isn't a hazard. */
function infoRow(text: string): HTMLElement {
  const w = document.createElement('div'); w.className = 'bp-modal-info';
  const dot = document.createElement('span'); dot.className = 'bp-modal-info-dot';
  w.append(dot, document.createTextNode(text));
  return w;
}

/** Does the staged plan touch the shared Result tab, and does it touch CONTAINERS there? Built from the
 *  union of the Result subtree in baseline + desired (so a move IN, a move OUT, and a staged add are all
 *  caught), then matched against the plan's step ids. Container impact is called out louder. */
function resultImpact(base: LModel, desired: LModel, plan: readonly PlanStep[]): { touched: boolean; containers: boolean } {
  const subtree = (mm: LModel): Map<string, LNode['kind']> => {
    const ids = new Map<string, LNode['kind']>();
    const t = mm.tabs.find(isResultTab);
    if (t) eachInSubtree(t, n => ids.set(n.id, n.kind));
    return ids;
  };
  const ids = new Map([...subtree(base), ...subtree(desired)]);
  let touched = false, containers = false;
  for (const s of plan) {
    const sid = planStepId(s); // create/flowCreate carry the id on `node`
    const k = ids.get(sid);
    if (k !== undefined) { touched = true; if (k === 'container') containers = true; }
  }
  return { touched, containers };
}

/** One log row of a plan note. Structured notes (action/object/where/detail from the compiler)
 *  render as fixed columns — icon | ACTION | type chip + object | → where | detail | ec — every row one
 *  line tall, so the log scans like a table. A note without the structured fields (defensive) falls
 *  back to its `text` sentence in the object column. The SAME builder renders the apply log (`full`)
 *  and the pending tray (compact: no detail/ec columns), so the two surfaces can't drift. */
function planRow(note: PlanNote, full = true): HTMLElement {
  const row = document.createElement('div'); row.className = `bp-prow v-${note.verb}`;
  const ic = document.createElement('span'); ic.className = 'ic'; setIcon(ic, VERB_ICON[note.verb]);
  const act = document.createElement('span'); act.className = 'act'; act.textContent = note.action ?? note.verb;
  row.append(ic, act);
  const obj = document.createElement('span'); obj.className = 'obj';
  if (note.object || note.objectType) {
    if (note.objectType) {
      const typ = document.createElement('span'); typ.className = 'typ';
      typ.textContent = getTypeAbbr(note.objectType);
      typ.style.setProperty('--type-color', getTypeColor(note.objectType));
      typ.title = note.objectType;
      obj.appendChild(typ);
    }
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = note.object ?? '';
    nm.title = note.object ?? '';
    obj.appendChild(nm);
  } else {
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = note.text;
    obj.appendChild(nm);
  }
  row.appendChild(obj);
  const whr = document.createElement('span'); whr.className = 'whr';
  if (note.where) {
    const arr = document.createElement('span'); arr.className = 'bp-ic'; setIcon(arr, ICON_ARROW_RIGHT);
    const wnm = document.createElement('span'); wnm.className = 'wnm'; wnm.textContent = note.where;
    whr.append(arr, wnm); whr.title = note.where;
  }
  row.appendChild(whr);
  if (!full) return row;
  const det = document.createElement('span'); det.className = 'det';
  // "5/6" alone says nothing: spell a column width out.
  const colFrac = note.detail?.match(/^(\d+)\/6$/);
  det.textContent = colFrac ? `${colFrac[1]} of 6 col` : note.detail ?? '';
  if (note.detail) det.title = colFrac ? `Width: ${colFrac[1]} of 6 columns` : note.detail;
  row.appendChild(det);
  if (note.ec) {
    const ec = document.createElement('code');
    const clean = note.ec.replace(/ \/\/ BMP assigns id$/, '');
    ec.textContent = clean; ec.title = clean;
    row.appendChild(ec);
  }
  return row;
}

const OUTCOME_TITLE: Record<ApplyOutcome['kind'], string> = {
  partial: 'Partial apply — verify the layout',
  failed: 'Apply failed',
  stale: 'Page changed — reloaded',
};

/** The persistent, dismissible outcome panel for a non-clean apply (stale / partial / failed). Unlike
 *  the preview it is NOT modal — it docks bottom-centre and leaves the canvas interactive so the user can
 *  compare it against the refreshed layout. It reuses `planRow`, so the actions listed here read exactly
 *  like the preview that staged them. Success reloads the page and so never lands here. */
export function outcomePanel(outcome: ApplyOutcome, ctx: BlueprintCtx): HTMLElement {
  const card = document.createElement('div');
  card.className = `bp-outcome k-${outcome.kind}` + scopeClass(ctx);
  const head = document.createElement('div'); head.className = 'bp-outcome-h';
  const ic = document.createElement('span'); ic.className = 'bp-outcome-ic'; setIcon(ic, ICON_WARNING);
  const title = document.createElement('span'); title.className = 'bp-outcome-t'; title.textContent = OUTCOME_TITLE[outcome.kind];
  const x = mkIconBtn(ICON_X, dismissApplyOutcome, 'Dismiss'); x.classList.add('bp-outcome-x');
  head.append(ic, title, x);
  card.appendChild(head);
  const msg = document.createElement('div'); msg.className = 'bp-outcome-msg'; msg.textContent = outcome.message;
  card.appendChild(msg);
  if (outcome.notes.length) {
    const cap = document.createElement('div'); cap.className = 'bp-outcome-cap';
    cap.textContent = outcome.kind === 'partial'
      ? `These ${outcome.notes.length} step${outcome.notes.length === 1 ? '' : 's'} were requested — some may not have landed:`
      : `These ${outcome.notes.length} step${outcome.notes.length === 1 ? '' : 's'} were requested:`;
    card.appendChild(cap);
    const list = document.createElement('div'); list.className = 'bp-outcome-list';
    for (const note of outcome.notes) list.appendChild(planRow(note));
    card.appendChild(list);
  }
  return card;
}

/** The apply-preview: the exact plan as a scannable log + the blast-radius warnings, behind a confirm. */
const ACTOR_UNVERIFIED = 'Companion could not confirm which BMP user these changes run as. They run with your current BMP sign-in; open the side panel connection to check it.';

/** "Runs as …" in the review: the acting user of this tab's profile. Taken
 *  from what content.js last learned; when it has nothing yet, asked for on
 *  demand (GET_CONNECTION_STATE, answered for this tab's own profile), and
 *  kept current while the review is open. */
export function actorRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'bp-modal-actor';
  const show = (actor: ReturnType<typeof currentCommandActor>, settled: boolean) => {
    row.textContent = actor?.text ?? (settled ? ACTOR_UNVERIFIED : 'Checking which BMP user these changes run as…');
    row.classList.toggle('unverified', !actor);
  };
  const warm = currentCommandActor();
  show(warm, !!warm);
  if (!warm) void readCommandActor().then(actor => { if (!row.dataset.live) show(actor, true); }).catch(() => show(null, true));
  const off = onCommandActorChange(() => {
    if (!row.isConnected && row.dataset.bound) { off(); return; }
    row.dataset.live = '1';
    show(currentCommandActor(), true);
  });
  row.dataset.bound = '1';
  return row;
}

export function previewModal(review: ApplyReview, ctx: BlueprintCtx, applying = false): HTMLElement {
  const notes = review.notes;
  const shared = ctx.target === 'template';
  const back = document.createElement('div'); back.className = 'bp-modal-back';
  if (!applying) back.addEventListener('mousedown', (e) => { if (e.target === back) closePreview(); });
  const card = document.createElement('div'); card.className = 'bp-modal' + scopeClass(ctx);
  const h = document.createElement('div'); h.className = 'bp-modal-h';
  // Headline = logical changes; "(N actions)" exposes the raw EC step count when it differs (an insert
  // can compile to a create + a moveAfter chain). The list below still enumerates every action.
  const changes = review.changes;
  const actions = review.actions;
  h.textContent = `Review ${changes} change${changes === 1 ? '' : 's'}`
    + (actions !== changes ? ` (${actions} actions)` : '')
    + ` to ${ctx.pageClass} ${ctx.pageId}`;
  card.appendChild(h);
  const sub = document.createElement('div'); sub.className = 'bp-modal-sub';
  sub.textContent = 'Nothing is saved until you confirm. Discard a row to take that change out and review again.';
  card.appendChild(sub);
  // Warnings render as ONE full-bleed strip under the header (edge-to-edge rows, hairline-separated) —
  // not stacked boxes floating in the card. Order: blast radius, Result-tab impact, deletes, lint.
  const strip = document.createElement('div'); strip.className = 'bp-modal-strip';
  const warn = (text: string) => { strip.appendChild(warnRow(text)); };
  // ONE shared-template warning: the fanout version (with the live instance count) supersedes the static
  // one when the probe has returned — they otherwise both say "this is a template" and read as redundant.
  const impact = review.impact.status === 'ready' ? review.impact.value : null;
  const fanout = impact?.fanout;
  if (fanout?.isMaster) {
    const n = fanout.instances.length;
    warn(`This is a shared template; ${n} linked scorecard${n === 1 ? '' : 's'} inherit from it. `
      + 'Widget edits propagate to them; tab or container edits change every one.');
  } else if (shared) {
    warn('This is a shared template. These changes affect every instance that uses it.');
  }
  const xfam = impact?.blast;
  if (xfam && xfam.otherFamilies > 0) {
    const names = xfam.families.map(f => f.name).filter(Boolean).slice(0, 2).join(', ');
    warn(`Some containers here are shared with ${xfam.otherFamilies} page${xfam.otherFamilies === 1 ? '' : 's'} `
      + `outside this template${names ? ` (${names}${xfam.otherFamilies > 2 ? ', …' : ''})` : ''}. Your structural changes affect them too.`);
  }
  const flowBlast = impact?.flowBlast;
  if (flowBlast && flowBlast.sharedContainers > 0) {
    const usages = flowBlast.containers.flatMap(container => container.usages);
    const names = usages.map(usage => usage.name).filter(Boolean).slice(0, 2).join(', ');
    warn(`${flowBlast.sharedContainers} edited form definition${flowBlast.sharedContainers === 1 ? ' is' : 's are'} shared by multiple views`
      + `${names ? ` (${names}${usages.length > 2 ? ', …' : ''})` : ''}. Child changes appear in every referencing form.`);
  }
  // Shared Result-tab warning. The Result tab lives in the SHARED default_tabset, so structural edits
  // there (above all a new/moved container) land on every scorecard that uses it — louder than a normal
  // widget edit, which only touches this scorecard's own objects. Computed locally (no probe needed).
  const ri = resultImpact(review.baseline, review.desired, review.plan);
  if (ri.touched) {
    warn(ri.containers
      ? 'You are changing containers on the shared Result tab. A container added or moved here appears on EVERY scorecard that uses the default tab set, not just this one.'
      : "You are editing the shared Result tab. These widgets are this scorecard's own, but the tab is shared across scorecards — review before applying.");
  }
  // Blast-radius warning. Deleting a tab cascades to every container/widget under it (a tab's contents
  // can't re-home the way a deleted container's widgets do), so one delete gesture can stage many. Make
  // that scope explicit at the confirm gate — the rows below enumerate it, but the count is the headline.
  const deletes = notes.filter(n => n.verb === 'delete').length;
  if (deletes > 0) {
    warn(`${deletes} object${deletes === 1 ? '' : 's'} will be permanently deleted. This can't be undone after Apply.`);
  }
  // Pre-commit lint: empty-tab and structural-on-instance warnings (undo is frozen while this modal
  // is open, so the model behind these matches exactly what Confirm will apply).
  const lm = review.desired;
  if (review.baseline) {
    for (const msg of lint(lm, lm.target, diff(review.baseline, lm))) {
      strip.appendChild(msg.level === 'info' ? infoRow(msg.text) : warnRow(msg.text));
    }
  }
  if (strip.children.length) card.appendChild(strip);
  const list = document.createElement('div'); list.className = 'bp-modal-list';
  // Same numbering as the canvas markers and the tray: first note per object id, in plan order.
  // Each numbered row shows BEFORE → AFTER and can be discarded; discarding leaves the review (the
  // reviewed plan would no longer match), reverts that object, and the user reviews again.
  const revertTarget = new Map(review.plan.map(step => [
    planStepId(step),
    step.kind === 'flowReorder' || step.kind === 'flowDelete' ? step.parentId : planStepId(step),
  ]));
  const numbered = new Set<string>();
  for (const note of notes) {
    const row = planRow(note);
    const first = !!note.id && !numbered.has(note.id);
    if (first) {
      numbered.add(note.id!);
      row.insertBefore(markerEl(numbered.size, note.verb), row.firstChild);
      const ba = beforeAfter(review.baseline, review.desired, note.id!);
      if (ba) {
        const cmp = document.createElement('span'); cmp.className = 'bp-ba';
        const b = document.createElement('span'); b.className = 'bp-ba-b'; b.title = `Before: ${ba.before}`;
        const bl = document.createElement('span'); bl.className = 'bp-ba-l'; bl.textContent = 'Before';
        const bv = document.createElement('span'); bv.className = 'bp-ba-v'; bv.textContent = ba.before; b.append(bl, bv);
        const arr = document.createElement('span'); arr.className = 'bp-ic'; setIcon(arr, ICON_ARROW_RIGHT);
        const a = document.createElement('span'); a.className = 'bp-ba-a'; a.title = `After: ${ba.after}`;
        const al = document.createElement('span'); al.className = 'bp-ba-l'; al.textContent = 'After';
        const av = document.createElement('mark'); av.className = 'bp-ba-v'; av.textContent = ba.after; a.append(al, av);
        cmp.append(b, arr, a);
        row.insertBefore(cmp, row.querySelector('.det'));
      }
      if (!applying) {
        const id = note.id!;
        const x = document.createElement('button'); x.className = 'bp-pop-x'; setIcon(x, ICON_X);
        x.title = 'Discard this change and leave the review';
        x.setAttribute('aria-label', `Discard change ${numbered.size}`);
        x.addEventListener('mousedown', (e) => { e.stopPropagation(); closePreview(); revertNode(revertTarget.get(id) ?? id); });
        row.appendChild(x);
      }
    } else {
      row.classList.add('bp-prow-sub');
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  card.appendChild(actorRow());
  const foot = document.createElement('div'); foot.className = 'bp-modal-foot';
  // Copy EC (left) — the WHOLE compiled program, ready to paste into the EC console / a transport script.
  if (review.script) {
    const copy = mkIconBtn(ICON_COPY, () => {
      void copyWithToast(review.script, { okMessage: 'EC copied to clipboard', key: 'bp-copy-ec' });
    }, 'Copy EC');
    copy.classList.add('bp-copy-ec');
    copy.title = 'Copy the full Extended Code program these changes compile to';
    foot.appendChild(copy);
  }
  foot.append((() => {
    const cancel = mkBtn('Cancel', closePreview);
    cancel.disabled = applying;
    return cancel;
  })(), (() => {
    // While the impact probe runs, Confirm is disabled and labelled — a commit must not race ahead of
    // the fan-out / shared-structure warning (the highest-consequence one). The session clears the gate.
    const pending = review.impact.status === 'checking';
    const b = mkUserBtn(pending ? 'Checking impact…' : 'Confirm & apply', confirmApply);
    b.className = 'apply';
    if (applying) b.textContent = 'Applying…';
    if (applying || pending) {
      b.disabled = true;
      b.classList.add('disabled');
      b.title = applying
        ? 'The reviewed changes are being committed'
        : 'Checking how many objects this edit affects before you commit';
    }
    return b;
  })());
  card.appendChild(foot);
  back.appendChild(card);
  return back;
}

/** BEFORE / AFTER for one object of the review: the fields that differ between baseline and the
 *  staged model (container, width, height, name), or the position for a pure reorder. Null for
 *  objects outside the layout tree (flow rows), whose detail column already says what changes. */
function beforeAfter(base: LModel | null | undefined, desired: LModel, id: string): { before: string; after: string } | null {
  const b = base ? findNode(base, id) : null, d = findNode(desired, id);
  if (!b && !d) return null;
  const where = (f: NonNullable<ReturnType<typeof findNode>>): string => f.parent?.name || f.parent?.id || 'tab';
  const desc = (f: NonNullable<ReturnType<typeof findNode>>): string => `${where(f)}, ${f.node.cols.L} col`;
  if (!b) return { before: 'none', after: desc(d!) };
  if (!d) return { before: desc(b), after: 'removed' };
  const bs: string[] = [], as: string[] = [];
  if ((b.parent?.id ?? null) !== (d.parent?.id ?? null)) { bs.push(where(b)); as.push(where(d)); }
  if (b.node.cols.L !== d.node.cols.L) { bs.push(`${b.node.cols.L} col`); as.push(`${d.node.cols.L} col`); }
  if ((b.node.height ?? null) !== (d.node.height ?? null)) { bs.push(b.node.height != null ? `${b.node.height} px` : 'auto'); as.push(d.node.height != null ? `${d.node.height} px` : 'auto'); }
  if (b.node.name !== d.node.name) { bs.push(b.node.name); as.push(d.node.name); }
  if (!bs.length && b.index !== d.index) { bs.push(`position ${b.index + 1}`); as.push(`position ${d.index + 1}`); }
  if (!bs.length) return null;
  return { before: bs.join(', '), after: as.join(', ') };
}

/** A minimal PlanNote for one step — the tray's fallback when compile() rejects the plan (e.g. a
 *  malformed colour id). Same verbs/actions as the compiler, just without where/detail/ec. */
const STEP_ACTION: Record<PlanStep['kind'], PlanNote['action']> = { create: 'Add', update: 'Change', reparent: 'Move', reorder: 'Reorder', delete: 'Delete', flowCreate: 'Add', flowReorder: 'Reorder', flowDelete: 'Delete', flowFlag: 'Change', flowWire: 'Change', flowRename: 'Change', flowProperty: 'Change' };
const STEP_VERB: Record<PlanStep['kind'], PlanNote['verb']> = { create: 'create', update: 'update', reparent: 'move', reorder: 'reorder', delete: 'delete', flowCreate: 'create', flowReorder: 'reorder', flowDelete: 'delete', flowFlag: 'update', flowWire: 'update', flowRename: 'update', flowProperty: 'update' };
function stepNote(base: LModel, m: LModel, s: PlanStep): PlanNote {
  const id = planStepId(s);
  // create/flowCreate carry their subject on `node`; flow steps otherwise name their subject by id
  // (flow rows live outside the LNode tree, so findNode can't see them).
  const node = s.kind === 'create' ? s.node
    : s.kind === 'flowCreate' ? { name: s.node.name, className: s.node.className }
    : s.kind === 'flowReorder' || s.kind === 'flowDelete' || s.kind === 'flowFlag' || s.kind === 'flowWire' || s.kind === 'flowRename' || s.kind === 'flowProperty' ? { name: s.kind === 'flowRename' ? s.name : s.kind === 'flowDelete' ? s.name ?? id : id, className: s.kind === 'flowFlag' || s.kind === 'flowRename' || s.kind === 'flowDelete' ? s.className : s.kind === 'flowProperty' ? 'EditField' : undefined }
    : (findNode(m, id)?.node ?? findNode(base, id)?.node ?? null);
  return { verb: STEP_VERB[s.kind], id, text: node?.name ?? id, action: STEP_ACTION[s.kind], object: node?.name ?? id, objectType: node?.className };
}

/** Docked pending-changes tray — one row per changed node, each with a revert. Toggled from the chip.
 *  Rows are the apply log's own rows (same compiler notes, same planRow builder, deduped to the first
 *  note per node) minus the detail/ec columns — a strict subset, so the two logs read the same. */
interface TrayPlan { plan: PlanStep[]; notes: PlanNote[]; changes: number; rows: PlanNote[] }
/** The tray's rows: the compiler notes deduped to the first note per object id, in plan order. The
 *  canvas markers, the tray and the review all number changes from this one list, so a marker's
 *  number always matches its row. */
function trayPlan(base: LModel, m: LModel): TrayPlan {
  const plan = [...diff(base, m), ...flowDiff(base, m)];
  const { changes } = summarizeChanges(plan, m);
  let notes: PlanNote[] = [];
  if (plan.length) {
    try { notes = compile(plan, m).notes; }
    catch { notes = plan.map(s => stepNote(base, m, s)); }
  }
  const seen = new Set<string>();
  const rows: PlanNote[] = [];
  for (const note of notes) {
    if (!note.id || seen.has(note.id)) continue;
    seen.add(note.id); rows.push(note);
  }
  return { plan, notes, changes, rows };
}

/** Object id → { row number, verb } for the numbered change markers. */
export function changeMarks(base: LModel, m: LModel): Map<string, { n: number; verb: string }> {
  const out = new Map<string, { n: number; verb: string }>();
  trayPlan(base, m).rows.forEach((note, i) => out.set(note.id!, { n: i + 1, verb: note.verb }));
  return out;
}

/** The numbered marker shape shared by canvas, tray and review: a small triangle filled with the
 *  state colour carrying the row number (shape + number, never colour alone). */
export function markerEl(n: number | string, verb: string): HTMLElement {
  const mk = document.createElement('span');
  mk.className = `bp-mark v-${verb}`;
  mk.textContent = String(n);
  return mk;
}

export function trayPanel(base: LModel, m: LModel): HTMLElement {
  // The tray is the pre-apply plan, so it must use the same layout+flow composition as Apply.
  const { plan, notes, changes, rows } = trayPlan(base, m);
  // Compiler notes are the visible execution actions shown by Apply Review.
  // They can include implicit support objects (for example the Category and
  // TabSet needed by a virtual TabSet), so plan-step counts are insufficient.
  const actions = notes.length;
  const wrap = document.createElement('div'); wrap.className = 'bp-tray';
  // Headline = logical changes; the "· N actions" exposes the underlying EC steps without hiding them
  // (one insert can compile to a create + a moveAfter chain). Singular-aware.
  const h = document.createElement('div'); h.className = 'bp-tray-h';
  h.textContent = `${changes} change${changes === 1 ? '' : 's'}`
    + (actions !== changes ? ` · ${actions} action${actions === 1 ? '' : 's'}` : '');
  wrap.appendChild(h);
  if (!plan.length) { const e = document.createElement('div'); e.className = 'bp-tray-empty'; e.textContent = 'No unsaved changes'; wrap.appendChild(e); return wrap; }
  // A flow reorder step names the moved child, while the staged order belongs to its parent flow
  // entry. Revert that entry; other flow/layout steps already use their own subject id.
  const revertTarget = new Map(plan.map(step => [
    planStepId(step),
    step.kind === 'flowReorder' || step.kind === 'flowDelete' ? step.parentId : planStepId(step),
  ]));
  rows.forEach((note, i) => {
    const id = note.id!;
    const row = planRow(note, false);
    row.insertBefore(markerEl(i + 1, note.verb), row.firstChild);
    const x = document.createElement('button'); x.className = 'bp-pop-x'; setIcon(x, ICON_X); x.title = 'Discard this change';
    x.setAttribute('aria-label', `Discard change ${i + 1}`);
    x.addEventListener('mousedown', (e) => { e.stopPropagation(); revertNode(revertTarget.get(id) ?? id); });
    row.appendChild(x);
    wrap.appendChild(row);
  });
  return wrap;
}

/** Key hints shown beside a gesture hint. Generated from the shortcut registry, never typed here. */
const HINT_KEYS: ReadonlyArray<{ id: 'blueprint.back' | 'blueprint.undo' | 'sheet.open'; verb: string }> = [
  { id: 'blueprint.back', verb: 'cancel' },
  { id: 'blueprint.undo', verb: 'undo' },
  { id: 'sheet.open', verb: 'all keys' },
];
export function hintBar(text: string): HTMLElement {
  const h = document.createElement('div'); h.className = 'bp-hint';
  h.setAttribute('role', 'status');
  const t = document.createElement('span'); t.className = 'bp-hint-t'; t.textContent = text;
  h.appendChild(t);
  for (const k of HINT_KEYS) {
    if (k.id === 'blueprint.back' && !bp.dragging) continue;
    const label = shortcutLabel(k.id);
    if (!label) continue;
    const g = document.createElement('span'); g.className = 'bp-hint-k';
    const kbd = document.createElement('kbd'); kbd.textContent = label;
    g.append(kbd, ` ${k.verb}`);
    h.appendChild(g);
  }
  return h;
}


/** The vertical mode switch mounted at the LEFT of the header — top = Layout (blueprint), bottom =
 *  Style (paint). A physical-feeling toggle that spans the header + tab rows; flipping it morphs the
 *  whole editor (the chip wordmark + the per-widget toolbar) between structure and appearance. */
export function modeSwitch(): HTMLElement {
  const sw = document.createElement('div'); sw.className = 'bp-vswitch';
  const seg = (mode: 'layout' | 'style', icon: string, title: string): HTMLElement => {
    const b = document.createElement('button');
    b.className = 'bp-vsw-b' + (mode === 'style' ? ' style' : '') + (bp.mode === mode ? ' on' : '');
    setIcon(b, icon); b.title = title;
    b.addEventListener('click', () => setMode(mode));
    return b;
  };
  sw.append(
    seg('layout', ICON_BLUEPRINT, 'Layout: structure, columns, position'),
    seg('style', ICON_PAINT, 'Style: colours, shadow, border, header'),
  );
  return sw;
}

/** Command chip — page id, undo/redo, pending tray toggle, discard, apply, exit. */
export function renderChip(ctx: BlueprintCtx, pending: number): HTMLElement {
  const c = document.createElement('div'); c.className = 'bp-chip' + scopeClass(ctx);
  c.appendChild(objectChip({
    rid: ctx.pageRid ?? ctx.pageId,
    businessId: ctx.pageId,
    type: ctx.pageClass,
    name: ctx.pageId,
  }, {
    label: ctx.pageId,
    className: 'bp-page-chip',
  }));
  const settings = mkIconBtn(ICON_SLIDERS, toggleSettings);
  settings.classList.add('plain', 'bp-settings-trigger');
  settings.classList.toggle('on', bp.settingsOpen);
  settings.title = 'Blueprint settings';
  settings.setAttribute('aria-label', 'Blueprint settings');
  settings.setAttribute('aria-expanded', String(bp.settingsOpen));
  c.appendChild(settings);
  // F: template/instance target toggle — shown whenever this page reuses a template (you can edit the
  // shared template OR just this instance). Default is the template. The active segment + the tmpl
  // styling on the chip ARE the "what am I editing" indicator (E), so no free-flowing warning text that
  // could shove the buttons out of alignment.
  if (ctx.templateId) {
    const seg = document.createElement('div'); seg.className = 'bp-target';
    const tBtn = document.createElement('button');
    tBtn.className = 'bp-target-b' + (bp.editingTemplate ? ' on' : '');
    tBtn.textContent = 'Template';
    tBtn.title = `Editing the shared template ${ctx.templateId}. Changes affect every instance.`;
    tBtn.addEventListener('click', () => setEditTarget(true));
    const iBtn = document.createElement('button');
    iBtn.className = 'bp-target-b' + (!bp.editingTemplate ? ' on' : '');
    iBtn.textContent = 'This instance';
    iBtn.title = `Editing only ${ctx.instanceId ?? 'this instance'}. Overrides the template here.`;
    iBtn.addEventListener('click', () => setEditTarget(false));
    seg.append(tBtn, iBtn);
    c.appendChild(seg);
  }
  // (No "affects all instances" banner here — the template scope is shown by the Template/Instance
  // toggle above, and the full blast-radius warning is spelled out in the apply-preview modal.)
  c.appendChild(sp());
  // Hover temporarily reveals BMP's live widgets; click keeps that state on. This frequent spatial
  // check belongs in the header, not in the settings panel.
  const peek = mkIconBtn(ICON_EYE_SLASH, togglePeek);
  peek.classList.add('plain', 'bp-peek-trigger');
  peek.classList.toggle('on', bp.peek);
  peek.title = 'Show live page. Hover to peek; click to keep it visible. The paper is solid while changes are unsaved; Peek always shows the live page.';
  peek.setAttribute('aria-label', 'Show live page');
  peek.setAttribute('aria-pressed', String(bp.peek));
  peek.addEventListener('mouseenter', () => setPeekPresentation(true));
  peek.addEventListener('mouseleave', () => setPeekPresentation(bp.peek));
  c.appendChild(peek);
  // Undo/redo are borderless: frequent, low-stakes nudges that should not crowd out Exit.
  const undoB = mkIconBtn(ICON_ARROW_UNDO, undo); undoB.title = withShortcut('Undo', 'blueprint.undo'); undoB.setAttribute('aria-label', 'Undo'); undoB.disabled = !bp.history?.canUndo(); undoB.classList.add('plain'); c.appendChild(undoB);
  const redoB = mkIconBtn(ICON_ARROW_REDO, redo); redoB.title = withShortcut('Redo', 'blueprint.redo'); redoB.setAttribute('aria-label', 'Redo'); redoB.disabled = !bp.history?.canRedo(); redoB.classList.add('plain'); c.appendChild(redoB);
  const trayB = mkIconBtn(ICON_LIST, toggleTray, pending ? `${pending} unsaved` : 'No changes');
  trayB.title = pending ? `${pending} unsaved change${pending === 1 ? '' : 's'}. Show the list` : 'No unsaved changes'; trayB.disabled = pending === 0;
  trayB.classList.add('bp-pending'); if (pending) trayB.classList.add('has');
  trayB.setAttribute('aria-label', trayB.title); trayB.setAttribute('aria-expanded', String(bp.trayOpen));
  if (bp.trayOpen) trayB.classList.add('on'); c.appendChild(trayB);
  // Discard is a two-step confirm on the SAME button: first click arms ("Sure?"), a second within a few
  // seconds discards. Non-intrusive — no modal — and it auto-disarms. A zero-pending render clears any arm.
  if (pending === 0 && bp.discardArm) disarmDiscard();
  const armed = bp.discardArm;
  const discardB = mkBtn(armed ? 'Sure?' : 'Discard', armed ? discard : armDiscard);
  const applyPhase = bp.applySession?.state.phase;
  const applyBusy = applyPhase === 'preparing' || applyPhase === 'applying';
  discardB.disabled = pending === 0 || applyBusy;
  if (armed) discardB.classList.add('bp-danger');
  discardB.title = armed ? 'Click again to discard all unsaved changes' : 'Discard all unsaved changes';
  const applyLabel = applyPhase === 'preparing' ? 'Checking IDs…' : applyPhase === 'applying' ? 'Applying…' : 'Review and apply';
  const applyB = mkUserBtn(applyLabel, openApplyPreview);
  applyB.className = 'apply'; applyB.disabled = pending === 0 || !!bp.applySession;
  const exit = mkIconBtn(ICON_X, exitBlueprint);
  exit.classList.add('bp-exit');
  exit.title = withShortcut('Exit blueprint mode', 'browser.blueprint');
  exit.setAttribute('aria-label', 'Exit blueprint mode');
  const commitActions = document.createElement('div');
  commitActions.className = 'bp-commit-actions';
  commitActions.append(discardB, applyB, exit);
  c.appendChild(commitActions);
  return c;
}

/** Compact settings popover anchored below the command header. Keep this surface for Blueprint-wide
 *  behaviour; object editing remains in the canvas/toolbars. */
export function settingsPanel(anchor: { left: number; top: number }): HTMLElement {
  const back = document.createElement('div');
  back.className = 'bp-settings-back';
  back.addEventListener('mousedown', (event) => {
    if (event.target === back) closeSettings();
  });

  const panel = document.createElement('section');
  panel.className = 'bp-settings-panel';
  panel.style.left = `${anchor.left}px`;
  panel.style.top = `${anchor.top}px`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Blueprint settings');
  panel.addEventListener('mousedown', (event) => event.stopPropagation());

  const head = document.createElement('header');
  head.className = 'bp-settings-head';
  const title = document.createElement('strong');
  title.textContent = 'Blueprint settings';
  const close = mkIconBtn(ICON_X, closeSettings);
  close.classList.add('plain');
  close.title = 'Close settings';
  close.setAttribute('aria-label', 'Close settings');
  head.append(title, close);

  const idSection = document.createElement('div');
  idSection.className = 'bp-settings-section';
  const idsEligible = portableIdsAvailable(bp.ctx);
  const idsLoading = bp.idConfigStatus === 'loading';
  const idRow = document.createElement('button');
  idRow.className = 'bp-settings-row';
  idRow.type = 'button';
  idRow.setAttribute('role', 'switch');
  idRow.setAttribute('aria-checked', String(bp.idConfig.enabled));
  idRow.disabled = !idsEligible || idsLoading;
  idRow.addEventListener('click', (event) => { if (isUserAction(event)) setPortableIdsEnabled(!bp.idConfig.enabled); });
  const idCopy = document.createElement('span');
  idCopy.className = 'bp-settings-copy';
  const idLabel = document.createElement('span');
  idLabel.className = 'bp-settings-label';
  idLabel.textContent = 'Automatic ID Assignment';
  const idHelp = document.createElement('span');
  idHelp.className = 'bp-settings-help';
  idHelp.textContent = idsLoading
    ? 'Loading ID settings…'
    : idsEligible
      ? bp.ctx?.surface === 'edit-page'
        ? 'Assign readable IDs to new fields and breaks on this EditPage.'
        : 'Assign readable IDs to new template and Shared Web Items.'
      : 'Available while editing Template; instances keep BMP-generated IDs.';
  idCopy.append(idLabel, idHelp);
  const idToggle = document.createElement('span');
  idToggle.className = 'bp-settings-switch' + (bp.idConfig.enabled ? ' on' : '');
  idToggle.setAttribute('aria-hidden', 'true');
  idToggle.appendChild(document.createElement('span'));
  idRow.append(idCopy, idToggle);
  idSection.appendChild(idRow);

  if (idsEligible && bp.idConfig.enabled) {
    const form = document.createElement('div');
    form.className = 'bp-id-form';
    const formLabel = document.createElement('label');
    formLabel.className = 'bp-id-form-label';
    formLabel.textContent = 'ID pattern';
    const input = document.createElement('input');
    input.className = 'bp-id-pattern';
    input.value = bp.idConfig.pattern;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Automatic ID pattern');
    const feedback = document.createElement('div');
    feedback.className = 'bp-id-feedback';
    const example = document.createElement('code');
    example.className = 'bp-id-example';
    const error = document.createElement('span');
    error.className = 'bp-id-error';
    const refreshFeedback = (): string | null => {
      const issue = portableIdPatternError(input.value);
      input.classList.toggle('invalid', !!issue);
      input.setAttribute('aria-invalid', String(!!issue));
      error.textContent = issue ?? '';
      example.textContent = issue ? '' : portableIdExample(input.value, model()?.pageName || bp.ctx?.pageId || 'Risk register');
      return issue;
    };
    // The pattern names every ID an Apply assigns: only the user's own typing saves it.
    // `typed` is the last value real input produced; a value page script put into the field
    // (and a blur it causes with `input.blur()`, which the browser reports as trusted) is not saved.
    let typed = input.value;
    input.addEventListener('input', (event) => {
      if (!isUserAction(event)) { input.value = typed; return; }
      typed = input.value;
      setPortableIdPatternDraft(typed);
      refreshFeedback();
    });
    input.addEventListener('blur', () => {
      if (input.value !== typed) input.value = typed;
      setPortableIdPatternDraft(typed);
      if (!refreshFeedback()) persistPortableIdPattern();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    });
    formLabel.appendChild(input);

    const tags = document.createElement('div');
    tags.className = 'bp-id-tags';
    for (const token of PORTABLE_ID_TOKENS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `{${token}}`;
      button.title = `Insert {${token}}`;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (!isUserAction(event)) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const tag = `{${token}}`;
        input.value = input.value.slice(0, start) + tag + input.value.slice(end);
        input.setSelectionRange(start + tag.length, start + tag.length);
        typed = input.value;
        setPortableIdPatternDraft(typed);
        refreshFeedback();
        input.focus();
      });
      tags.appendChild(button);
    }
    const note = document.createElement('p');
    note.className = 'bp-id-note';
    note.textContent = 'New objects only. Name edits made before Apply are included. Collisions use _2, _3, and so on.';
    feedback.append(error, example);
    form.append(formLabel, tags, feedback, note);
    idSection.appendChild(form);
    refreshFeedback();
  }

  panel.append(head, idSection);
  back.appendChild(panel);
  return back;
}
