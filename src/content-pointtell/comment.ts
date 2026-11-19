/**
 * Point and tell: the comment field. A small card that opens beside where the pen lifted, already
 * focused: one quiet line saying how the drawing was read (with a small x that drops the reading), and a
 * text area. Enter saves, Shift+Enter makes a new line, Escape closes it; either way the mark stays.
 * Starting the next stroke closes it too (see draw-tool). It never covers the ink, and it is placed once,
 * when it opens, so it does not jump.
 *
 * For a note on an object (a click, no drawing) the quiet line is the object's name.
 */
import { ICON_TRASH, ICON_X } from '../lib/icons';
import { findNode } from '../lib/layout/model';
import { tagSpec } from '../lib/point-tell/tag-words';
import { getTypeAbbr, getTypeColor } from '../lib/type-registry';
import { dropReading, forgetGroup, liftPoint, markBox, markStrokes, removeMark } from './ink-marks';
import { closeEditor, markByNumber } from './marks';
import { noteInput } from './mascot';
import { pt, type PtEditor } from './state';
import { VOICE_HOLD_KEY } from '../lib/point-tell/voice';
import { Z, placed } from './view';
import { endVoice, listening, micButton, startVoice, voiceOffered } from './voice';
import { fetchFanout } from './service';
import { isDraftId, isTabMark } from '../lib/point-tell/drafts';

const WIDTH = 268;
const GAP = 14;
/** Room kept clear at the bottom of the window for the dock. */
const DOCK_ROOM = 84;

/** Sample points of a mark's ink (page coordinates), for keeping the card off it. */
function inkPoints(n: number): Array<[number, number]> {
  const m = markByNumber(n);
  const strokes = m ? markStrokes(m) : null;
  if (!strokes) return [];
  const out: Array<[number, number]> = [];
  for (const s of strokes) {
    let px = 1e9, py = 1e9;
    s.points.forEach((p, i) => { if (i === 0 || i === s.points.length - 1 || Math.hypot(p[0] - px, p[1] - py) >= 6) { out.push([p[0], p[1]]); px = p[0]; py = p[1]; } });
  }
  return out;
}

/** The field's place (page coordinates): the first candidate that keeps off the ink and inside the window. */
function place(card: HTMLElement, ed: PtEditor): { left: number; top: number } {
  const W = card.offsetWidth || WIDTH, H = card.offsetHeight || 96;
  const vx0 = window.scrollX + 8, vx1 = window.scrollX + document.documentElement.clientWidth - 8;
  const vy0 = window.scrollY + 8, vy1 = window.scrollY + window.innerHeight - DOCK_ROOM;
  const clamp = (l: number, t: number): { left: number; top: number } => ({ left: Math.max(vx0, Math.min(vx1 - W, l)), top: Math.max(vy0, Math.min(vy1 - H, t)) });

  const m = ed.n !== null ? markByNumber(ed.n) : undefined;
  const box = m ? markBox(m) : null;
  if (m && box) {
    const lift = ed.lift ?? liftPoint(m) ?? [box.left + box.width, box.top + box.height];
    const pts = inkPoints(m.n);
    const hits = (c: { left: number; top: number }): number => {
      const pad = 8;
      return pts.filter(p => p[0] >= c.left - pad && p[0] <= c.left + W + pad && p[1] >= c.top - pad && p[1] <= c.top + H + pad).length;
    };
    const bottom = box.top + box.height, right = box.left + box.width;
    const candidates = [
      clamp(lift[0] + GAP, lift[1] - 10),
      clamp(lift[0] - W / 2, lift[1] + GAP + 2),
      clamp(lift[0] - W - GAP, lift[1] - 10),
      clamp(lift[0] - W / 2, lift[1] - H - GAP),
      clamp(box.left, bottom + GAP),
      clamp(box.left, box.top - H - GAP),
      clamp(right + GAP, lift[1] - H / 2),
      clamp(box.left - W - GAP, lift[1] - H / 2),
    ];
    let best = candidates[0], bestHits = Infinity;
    for (const c of candidates) { const h = hits(c); if (h === 0) return c; if (h < bestHits) { best = c; bestHits = h; } }
    return best;
  }
  // A mark with no stroke (the menu's new page): under the place it was asked at.
  if (m && ed.lift) return clamp(ed.lift[0] - 20, ed.lift[1] + GAP);
  // A note on an object: under it, else over it.
  const target = ed.targets[0] ? (pt.scene?.targets.find(t => t.id === ed.targets[0]) ?? pt.scene?.pills.find(t => t.id === ed.targets[0]))?.rect : undefined;
  if (target) {
    const below = target.top + target.height + GAP / 2;
    const left = target.left + 12;
    if (below + H <= vy1) return clamp(left, below);
    if (target.top - H - GAP / 2 >= vy0) return clamp(left, target.top - H - GAP / 2);
    return clamp(left, vy1 - H);
  }
  // A note for the page: above the dock, centred.
  return clamp(window.scrollX + (document.documentElement.clientWidth - W) / 2, vy1 - H);
}

function readingRow(ed: PtEditor): HTMLElement | null {
  const m = ed.n !== null ? markByNumber(ed.n) : undefined;
  const row = document.createElement('div');
  row.className = 'pt-read';
  // The tag already says this in the same words ("2 objects"): the line would only repeat it.
  const tagged = m ? tagSpec(m, id => (pt.model ? findNode(pt.model, id)?.node.className : undefined))?.word : undefined;
  if (m?.reading && tagged?.toLowerCase() === m.reading.toLowerCase()) return null;
  if (m?.reading) {
    const text = document.createElement('span');
    text.className = 'pt-read-text';
    text.textContent = m.reading;
    text.title = m.reading;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'pt-read-x';
    x.innerHTML = ICON_X; x.title = 'Drop this reading'; x.setAttribute('aria-label', 'Drop this reading');
    // Mouse down must not move the focus out of the text area.
    x.addEventListener('mousedown', (e) => e.preventDefault());
    x.addEventListener('click', (e) => { e.stopPropagation(); dropReading(m.n); });
    row.append(text, x);
    return row;
  }
  // No drawing: the object the note is on.
  const node = ed.targets.length && pt.model ? findNode(pt.model, ed.targets[0])?.node : null;
  if (node && !m?.ink) {
    const typ = document.createElement('span');
    typ.className = 'pt-typ';
    typ.textContent = getTypeAbbr(node.className);
    typ.style.setProperty('--type-color', getTypeColor(node.className));
    typ.title = node.className;
    const name = document.createElement('span');
    name.className = 'pt-read-text';
    name.textContent = node.name + (ed.targets.length > 1 ? ` +${ed.targets.length - 1}` : '');
    row.append(typ, name);
    return row;
  }
  if (!m && ed.page) {
    const name = document.createElement('span');
    name.className = 'pt-read-text';
    name.textContent = `Page${pt.model?.pageName ? ` · ${pt.model.pageName}` : ''}`;
    row.appendChild(name);
    return row;
  }
  return null;
}

/** Pages per template, read once per template and kept for the session. */
const fanouts = new Map<string, number | null>();

/** The one muted line under the reading when the tab or widget goes to a shared template: "On template X, 295 pages". */
function templateLine(ed: PtEditor): HTMLElement | null {
  const m = ed.n !== null ? markByNumber(ed.n) : undefined;
  const onTab = !!m && (isTabMark(m) || isDraftId(m.ink?.place.tabId));
  const model = pt.model;
  if (!onTab || !model || pt.scope !== 'template' || !pt.ctx?.templateRid) return null;
  const line = document.createElement('div');
  line.className = 'pt-read-sub';
  const say = (n: number | null | undefined): void => { line.textContent = `On template ${model.pageName ?? model.pageId}${n ? `, ${n} page${n === 1 ? '' : 's'}` : ''}`; };
  say(fanouts.get(model.pageId));
  if (!fanouts.has(model.pageId)) {
    fanouts.set(model.pageId, null);
    void fetchFanout(model.pageId).then(n => { fanouts.set(model.pageId, n); say(n); });
  }
  return line;
}

const placeholderFor = (ed: PtEditor): string => {
  const m = ed.n !== null ? markByNumber(ed.n) : undefined;
  if (m?.meaning?.kind === 'add' && m.meaning.tab) return 'Tab name';
  if (m?.meaning?.kind === 'add' && m.meaning.page) return 'Page name';
  if (m?.ink && !m.reading) return 'What do you want here?';
  if (m?.ink) return 'Add words (optional)';
  return ed.page ? 'What should change on this page?' : 'What should change here?';
};

const keyOf = (ed: PtEditor): string => {
  const m = ed.n !== null ? markByNumber(ed.n) : undefined;
  return `${m?.reading ?? ''}|${m?.ink ? 1 : 0}`;
};

export function renderField(): void {
  const layer = pt.layer;
  if (!layer) return;
  const ed = pt.editor;
  if (!ed) { pt.fieldEl?.remove(); pt.fieldEl = null; return; }

  // Open: only the quiet line is refreshed (the reading may have changed); the text area is never rebuilt.
  if (pt.fieldEl?.isConnected) {
    const key = keyOf(ed);
    if (pt.fieldEl.dataset.key !== key) {
      pt.fieldEl.dataset.key = key;
      pt.fieldEl.querySelector('.pt-read')?.remove();
      const row = readingRow(ed);
      if (row) pt.fieldEl.insertBefore(row, pt.fieldEl.firstChild);
      const area = pt.fieldEl.querySelector('textarea');
      if (area) area.placeholder = placeholderFor(ed);
    }
    return;
  }

  const card = placed(document.createElement('div'), 'absolute', Z.field);
  card.className = 'pt-field';
  card.style.width = `${WIDTH}px`;
  card.style.left = '0'; card.style.top = '0';
  card.style.visibility = 'hidden'; // measured, then placed, before it is ever seen: no jump
  card.style.pointerEvents = 'auto';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', ed.n === null ? 'New comment' : `Comment on mark ${ed.n}`);
  card.dataset.key = keyOf(ed);

  const row = readingRow(ed);
  if (row) card.appendChild(row);
  const sub = templateLine(ed);
  if (sub) card.appendChild(sub);

  const wrap = document.createElement('div');
  wrap.className = 'pt-area-wrap';
  const area = document.createElement('textarea');
  area.className = 'pt-area';
  area.value = ed.text;
  area.rows = 2;
  area.placeholder = placeholderFor(ed);
  area.setAttribute('aria-label', 'Comment');
  area.title = 'Enter saves. Shift+Enter makes a new line.';
  // BMP's own shortcuts and listeners must not see what is typed here.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) area.addEventListener(type, (e) => e.stopPropagation());
  const ghost = document.createElement('div');
  ghost.className = 'pt-interim'; ghost.hidden = true; ghost.setAttribute('aria-live', 'polite');
  const listen = (): void => { void startVoice(card, area, ghost); };
  area.addEventListener('keydown', (e) => {
    // Voice: hold the key to listen; Escape while listening only cancels the listening.
    if (e.key === VOICE_HOLD_KEY && voiceOffered()) { e.preventDefault(); if (!e.repeat && !listening()) listen(); return; }
    if (listening()) {
      if (e.key === 'Escape') { e.preventDefault(); endVoice(false); return; }
      if (e.key === 'Enter' && !e.shiftKey) endVoice(true);
    }
    // Closing the field on purpose means this mark is done: the next stroke starts a new one.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); forgetGroup(); closeEditor(true, area.value); }
    else if (e.key === 'Escape') { e.preventDefault(); forgetGroup(); closeEditor(true, area.value); }
  });
  area.addEventListener('input', noteInput);
  area.addEventListener('keyup', (e) => { if (e.key === VOICE_HOLD_KEY && listening()) endVoice(true); });
  area.addEventListener('blur', () => { if (listening()) endVoice(true); });
  wrap.appendChild(area);
  if (voiceOffered()) {
    const mic = micButton(() => { if (listening()) endVoice(true); else listen(); });
    wrap.appendChild(mic);
  }

  if (ed.n !== null) {
    const n = ed.n;
    const trash = document.createElement('button');
    trash.type = 'button'; trash.className = 'pt-trash';
    trash.innerHTML = ICON_TRASH; trash.title = 'Delete this mark'; trash.setAttribute('aria-label', 'Delete this mark');
    trash.addEventListener('mousedown', (e) => e.preventDefault());
    trash.addEventListener('click', (e) => { e.stopPropagation(); closeEditor(false); removeMark(n); });
    wrap.appendChild(trash);
  }
  card.appendChild(wrap);
  card.appendChild(ghost);
  layer.appendChild(card);
  pt.fieldEl = card;

  const at = place(card, ed);
  card.style.left = `${Math.round(at.left)}px`;
  card.style.top = `${Math.round(at.top)}px`;
  card.style.visibility = '';
  area.focus({ preventScroll: true });
  area.setSelectionRange(area.value.length, area.value.length);
}
