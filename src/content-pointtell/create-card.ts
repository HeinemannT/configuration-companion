/**
 * Point and tell: the card that creates a drawn page. Small and quiet: the kind (Scorecard or Model page), the ID
 * proposed from the name, where it goes, one line saying what is created, and the button "Create page". Changing
 * anything asks BMP for a dry run ("Checking…"); BMP's refusal shows as one sentence; the button works only after a
 * good dry run and only for a real press. The page created is empty: its tabs and widgets are staged in Blueprint
 * next, where they are reviewed and applied as always.
 */
import { sendRequest } from '../lib/messaging';
import { showToast } from '../lib/toast';
import { PAGE_KINDS, proposePageId, checkCreatePage, type PageKind } from '../lib/point-tell/create-page';
import { BP_RESUME_KEY } from '../lib/blueprint-resume';
import { encodeResume } from '../content-blueprint/resume-note';
import { recordStaged, saveMarks, stashStage } from '../lib/point-tell/store';
import type { InspectorMessage } from '../lib/types';
import { isUserAction } from '../lib/trusted-event';
import { holdReading } from './mascot';
import { forgetPage } from './page-draft';
import { hooks } from './marks';
import { pt, type PtCard } from './state';
import { Z, placed } from './view';

type Result = Extract<InspectorMessage, { type: 'POINT_TELL_CREATE_PAGE_RESULT' }>;
type Parents = Extract<InspectorMessage, { type: 'POINT_TELL_PARENTS_DATA' }>;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let checkTimer = 0;

const KIND_WORDS: Record<PageKind, string> = { Scorecard: 'Scorecard', ModelPage: 'Model page' };

/** Open the card for what was drawn on the paper page (`input`: what Blueprint is to be given). */
export function openCard(input: PtCard['input']): void {
  const name = pt.page?.name ?? '';
  pt.card = { input, kind: 'Scorecard', id: proposePageId('Scorecard', name), idEdited: false, parentRid: '', parents: [], status: 'checking' };
  hooks.render();
  const gen = pt.gen;
  const done = holdReading();
  void sendRequest<Parents>({ type: 'POINT_TELL_PARENTS', rid: pt.rid }).then(res => {
    done();
    if (!pt.active || pt.gen !== gen || !pt.card) return;
    const viewed = pt.page?.shelf.model;
    const list = (res?.ok ? res.parents ?? [] : []).map(p => ({ rid: p.rid, name: p.name || p.type }));
    // The page being viewed is a place too (a model page may sit under some pages); BMP's dry run says when it cannot.
    if (viewed?.pageRid) list.push({ rid: viewed.pageRid, name: viewed.pageName ?? viewed.pageId });
    pt.card.parents = list;
    pt.card.parentRid = list[0]?.rid ?? '';
    if (!list.length) { pt.card.status = 'error'; pt.card.error = 'Companion could not tell where this page lives.'; }
    hooks.render();
    if (list.length) schedule(0);
  });
}

export function closeCard(): void {
  pt.card = null;
  pt.cardEl?.remove(); pt.cardEl = null;
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = 0; }
}

const planOf = (c: PtCard) => ({ parentRid: c.parentRid, kind: c.kind, id: c.id, name: pt.page?.name ?? '' });

/** Ask BMP for a dry run shortly after the last change. */
function schedule(ms = 450): void {
  const c = pt.card;
  if (!c) return;
  if (checkTimer) clearTimeout(checkTimer);
  c.status = 'checking'; delete c.error; delete c.previewId;
  paintStatus();
  const mine = c;
  checkTimer = window.setTimeout(() => { checkTimer = 0; void check(mine); }, ms);
}

async function check(c: PtCard): Promise<void> {
  const bad = checkCreatePage(planOf(c));
  if (bad) { c.status = 'error'; c.error = bad; paintStatus(); return; }
  const done = holdReading();
  const res = await sendRequest<Result>({ type: 'POINT_TELL_CREATE_PAGE', phase: 'preview', plan: planOf(c), environment: pt.env ?? '' }).finally(done);
  if (pt.card !== c) return;
  if (res?.ok && res.previewId) { c.status = 'ready'; c.previewId = res.previewId; delete c.error; }
  else { c.status = 'error'; c.error = res?.error || 'BMP did not answer.'; }
  paintStatus();
}

/** The environment token comes with the first answer; until then a preview carries an empty one and the worker refuses it with the reason. */
async function createNow(c: PtCard, leave: () => void): Promise<void> {
  if (c.status !== 'ready' || !c.previewId) return;
  c.status = 'creating'; paintStatus();
  const done = holdReading();
  const res = await sendRequest<Result>({ type: 'POINT_TELL_CREATE_PAGE', phase: 'commit', plan: planOf(c), environment: pt.env ?? '', previewId: c.previewId }).finally(done);
  if (pt.card !== c) return;
  if (!res?.ok || !res.rid) {
    c.status = 'error';
    c.error = res?.outcomeUnknown ? `Whether the page was created is not known. Look under ${c.parents.find(p => p.rid === c.parentRid)?.name ?? 'its parent'} before trying again.` : res?.error || 'The page was not created.';
    delete c.previewId;
    paintStatus();
    return;
  }
  // Done: the sketch moves to the new page, Blueprint is asked to open there, and the page loads it.
  const newRid = res.rid;
  const { input } = c;
  const marks = { marks: pt.marks, next: pt.next };
  saveMarks(newRid, marks);
  const applied: number[] = [], kept: number[] = [];
  for (const r of input.result.reports) {
    if (!r.n || !r.results.some(x => x.verdict === 'ok')) continue;
    const leftovers = r.results.some(x => x.verdict !== 'ok') || r.questions.length > 0 || r.cannot.length > 0;
    (leftovers ? kept : applied).push(r.n);
  }
  recordStaged(newRid, { applied, kept });
  stashStage(newRid, { answer: input.text, snapshot: input.snapshot, ready: input.result.ready }, Date.now());
  forgetPage();
  try { sessionStorage.setItem(BP_RESUME_KEY, encodeResume('instance', 'Page created. Nothing else is written until you review and apply.', Date.now())); } catch { /* the page then opens without Blueprint */ }
  leave();
  try {
    const url = new URL(location.href);
    url.searchParams.set('rid', newRid);
    location.assign(url.toString());
  } catch { showToast('The page was created. Open it to continue.', 'success'); }
}

const whatLine = (c: PtCard): string => `Creates an empty ${KIND_WORDS[c.kind]} under ${c.parents.find(p => p.rid === c.parentRid)?.name ?? 'the chosen page'}. Tabs and widgets are reviewed in Blueprint next.`;

function paintStatus(): void {
  const c = pt.card, root = pt.cardEl;
  if (!c || !root?.isConnected) return;
  // The places arrive after the card is drawn.
  const sel = root.querySelector<HTMLSelectElement>('.pt-card-under');
  if (sel && sel.options.length !== c.parents.length) {
    sel.textContent = '';
    for (const p of c.parents) { const o = document.createElement('option'); o.textContent = p.name; o.value = p.rid; sel.appendChild(o); }
    sel.value = c.parentRid;
    const what = root.querySelector<HTMLElement>('.pt-card-what');
    if (what) what.textContent = whatLine(c);
  }
  const line = root.querySelector<HTMLElement>('.pt-card-status');
  const btn = root.querySelector<HTMLButtonElement>('.pt-primary');
  if (line) {
    line.textContent = c.status === 'checking' ? 'Checking…' : c.status === 'creating' ? 'Creating…' : c.status === 'error' ? c.error ?? '' : '';
    line.classList.toggle('pt-card-err', c.status === 'error');
  }
  if (btn) btn.disabled = c.status !== 'ready';
}

/** Draw the card (built once per opening; the fields keep what is typed). */
export function renderCard(leave: () => void): void {
  const layer = pt.layer;
  const c = pt.card;
  if (!layer) return;
  if (!c) { pt.cardEl?.remove(); pt.cardEl = null; return; }
  if (pt.cardEl?.isConnected) { paintStatus(); return; }
  const card = placed(el('div', 'pt-card'), 'fixed', Z.field);
  card.style.bottom = '84px'; card.style.right = '24px'; card.style.width = '340px'; card.style.pointerEvents = 'auto';
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Create page');
  for (const type of ['keydown', 'keyup', 'keypress'] as const) card.addEventListener(type, (e) => e.stopPropagation());

  const row = (label: string, ctl: HTMLElement): HTMLElement => { const r = el('div', 'pt-card-row'); r.append(el('span', 'pt-card-l', label), ctl); return r; };
  const kinds = el('div', 'pt-card-kinds');
  for (const k of PAGE_KINDS) {
    const b = el('button', 'pt-card-kind' + (k.kind === c.kind ? ' on' : ''), k.label);
    b.type = 'button'; b.dataset.kind = k.kind;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      c.kind = k.kind;
      if (!c.idEdited) { c.id = proposePageId(c.kind, pt.page?.name ?? ''); const f = card.querySelector<HTMLInputElement>('.pt-card-id'); if (f) f.value = c.id; }
      kinds.querySelectorAll('button').forEach(x => x.classList.toggle('on', (x as HTMLElement).dataset.kind === c.kind));
      schedule();
    });
    kinds.appendChild(b);
  }
  const id = el('input', 'pt-card-id'); id.type = 'text'; id.value = c.id; id.spellcheck = false; id.setAttribute('aria-label', 'ID');
  id.addEventListener('input', () => { c.id = id.value.trim(); c.idEdited = true; schedule(); });
  const under = el('select', 'pt-card-under'); under.setAttribute('aria-label', 'Under');
  for (const p of c.parents) { const o = el('option', '', p.name); o.value = p.rid; under.appendChild(o); }
  under.value = c.parentRid;
  under.addEventListener('change', () => { c.parentRid = under.value; schedule(0); updateLine(); });
  const what = el('div', 'pt-card-what');
  const updateLine = (): void => { what.textContent = whatLine(c); };
  kinds.addEventListener('click', updateLine);
  updateLine();
  const status = el('div', 'pt-card-status');
  const foot = el('div', 'pt-card-foot');
  const close = el('button', 'pt-btn', 'Cancel'); close.type = 'button';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeCard(); hooks.render(); });
  const go = el('button', 'pt-btn pt-primary', 'Create page'); go.type = 'button'; go.disabled = true;
  go.addEventListener('click', (e) => { e.stopPropagation(); if (isUserAction(e)) void createNow(c, leave); });
  foot.append(close, go);
  card.append(row('Kind', kinds), row('ID', id), row('Under', under), what, status, foot);
  layer.appendChild(card);
  pt.cardEl = card;
  paintStatus();
}
