/**
 * Point and tell: creating the empty page a blank-page sketch stands for. The one write of the feature that is not
 * a Blueprint apply: an empty Scorecard or Model Page under a parent, written by one small script that is previewed
 * on the server first, confirmed by the user, and read back after. Pure: the plan check, the script and its answer.
 * Tabs and widgets are not written here; Blueprint reviews and applies them next.
 */
import { ecString, validateRid } from '../ec-guards';

export type PageKind = 'Scorecard' | 'ModelPage';
export const PAGE_KINDS: ReadonlyArray<{ kind: PageKind; label: string }> = [{ kind: 'Scorecard', label: 'Scorecard' }, { kind: 'ModelPage', label: 'Model page' }];

export interface CreatePagePlan { parentRid: string; kind: PageKind; /** Empty: BMP gives it one. */ id: string; name: string }

export const MARKER = '<<<CREV_NEWPAGE>>>';
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

/** What is wrong with a plan, in one sentence; null when it can be written. */
export function checkCreatePage(plan: CreatePagePlan): string | null {
  if (plan.kind !== 'Scorecard' && plan.kind !== 'ModelPage') return 'Choose Scorecard or Model page.';
  if (!/^-?\d{1,20}$/.test(plan.parentRid)) return 'Choose where the page goes.';
  const name = plan.name.trim();
  if (!name || name.length > 120 || /[\r\n]/.test(name)) return 'A name is 1 to 120 characters on one line.';
  if (plan.id && !ID_RE.test(plan.id)) return 'An ID starts with a letter and has letters, digits and _ only.';
  return null;
}

/** The script. Every part is checked or escaped: the kind is one of two words, the rid digits, the id letters and digits, the name an escaped string. */
export function buildCreatePageEc(plan: CreatePagePlan): string {
  const bad = checkCreatePage(plan);
  if (bad) throw new Error(bad);
  validateRid(plan.parentRid);
  return [
    `_p := lookup(${plan.parentRid})`,
    `_n := _p.add(${plan.kind}, ${plan.id ? `id := ${ecString(plan.id)}, ` : ''}name := ${ecString(plan.name.trim())})`,
    `"${MARKER}" + str(_n.rid) + "|" + _n.className.whenMissing("") + "|" + _n.id.whenMissing("") + "|" + str(_n.parent.rid.whenMissing(""))`,
  ].join('\n');
}

export interface CreatedPage { rid: string; className: string; id: string; parentRid: string }

/** The answer of the script: the new page's rid, class, id and parent. Null when the marker is missing or malformed. */
export function parseCreatePage(log: string): CreatedPage | null {
  const m = new RegExp(`${MARKER}(-?[0-9]{1,20})[|]([A-Za-z]{1,40})[|]([^|\r\n]{0,120})[|](-?[0-9]{0,20})`).exec(log);
  return m ? { rid: m[1], className: m[2], id: m[3], parentRid: m[4] } : null;
}

/** The read-only script that reads a page back by rid (the same marker line). */
export function buildReadBackEc(rid: string): string {
  validateRid(rid);
  return [`_n := lookup(${rid})`, `"${MARKER}" + str(_n.rid) + "|" + _n.className.whenMissing("") + "|" + _n.id.whenMissing("") + "|" + str(_n.parent.rid.whenMissing(""))`].join('\n');
}

/** A page's ID from its name: `sc_` or `mp_`, the words of the name; the neighbours' prefix when they share one. */
export function proposePageId(kind: PageKind, name: string, neighbourPrefix = ''): string {
  const words = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48).replace(/_+$/, '');
  if (!words) return '';
  const prefix = neighbourPrefix || (kind === 'Scorecard' ? 'sc_' : 'mp_');
  const id = `${prefix}${words}`;
  return ID_RE.test(id) ? id : '';
}
