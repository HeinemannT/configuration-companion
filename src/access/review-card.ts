// The body of a review card: what is written where, each difference as a
// sentence, then Before and After rows that carry only the differing values.
// A side with nothing to show is left out.
import { escapeHtml as esc } from '../lib/escape';
import { statementDifferences, fieldDifference, type Difference, type ShownValue, type StatementChange } from './review-differences';
import type { RoleRecord } from './statement-model';
import { statementLabel } from './access-terms';
import type { PolicyJson } from './schema-model';

function valueHtml(v: ShownValue, sign: '' | '+' | '−'): string {
  const mark = sign ? `<b class="rv-sign" aria-hidden="true">${sign}</b><span class="sr-only">${sign === '+' ? 'added: ' : 'removed: '}</span>` : '';
  return `<span class="rv-v ${sign === '+' ? 'ad' : sign === '−' ? 'rm' : ''}">${mark}<span>${esc(v.text)}</span>${v.secondary ? `<small>${esc(v.secondary)}</small>` : ''}</span>`;
}

function sideHtml(word: string, values: ShownValue[], sign: '' | '+' | '−'): string {
  return `<div class="bf rv-side"><span>${esc(word)}</span><span class="rv-vals">${values.map(v => valueHtml(v, sign)).join('')}</span></div>`;
}

/** Sentences, then one row per difference that has values. */
export function differencesHtml(diffs: Difference[], { added = false, removed = false } = {}): string {
  const sentences = diffs.filter(d => d.text).map(d => `<li>${esc(d.text)}</li>`).join('');
  const rows = diffs.filter(d => d.before.length || d.after.length).map(d => {
    const list = d.kind === 'list';
    const before = d.before.length ? sideHtml(removed ? 'Was' : 'Before', d.before, list ? '−' : '') : '';
    const after = d.after.length ? sideHtml(added ? 'New' : 'After', d.after, list ? '+' : '') : '';
    return `<div class="rv-delta" data-part="${esc(d.part)}"><span class="rv-field">${esc(d.label)}</span><div class="ba ${before && after ? '' : 'one'}">${before}${after}</div></div>`;
  }).join('');
  return (sentences ? `<ul class="rv-diffs">${sentences}</ul>` : '') + rows;
}

export interface CardTarget { policyName: string; policyId?: string; statementIndex?: number; server: string }
/** "Saves to DEV QA · policy Record owners record_owner_access, statement 1": where
 *  the change goes once saved. Nothing on the card is saved yet. */
export function targetHtml(t: CardTarget): string {
  const policy = `policy <b>${esc(t.policyName)}</b>${t.policyId ? ` <code>${esc(t.policyId)}</code>` : ''}`;
  const statement = t.statementIndex === undefined ? '' : ', ' + esc(statementLabel(t.statementIndex).toLowerCase());
  return `<p class="rv-target">Saves to <b>${esc(t.server)}</b> · ${policy}${statement}</p>`;
}

interface ScopeRow { kind?: string; field?: string; source?: string; name?: string }
const isAssignment = (row: ScopeRow) => row.kind === 'RoleAssignment';
/** "Saves to DEV QA · field assignment of role Organization Manager". */
export function scopeTargetHtml(row: ScopeRow, { roleName, server }: { roleName: string; server: string }): string {
  return `<p class="rv-target">Saves to <b>${esc(server)}</b> · ${isAssignment(row) ? 'field assignment' : 'delegation'} of role <b>${esc(roleName)}</b></p>`;
}
/** Card title for a field assignment: the role, then "field managers of Organisation".
 *  Other rows keep their own name. */
export function scopeTitle(row: ScopeRow, roleName: string): string {
  if (!isAssignment(row)) return row.name || roleName;
  const field = String(row.field ?? '').split('.').at(-1);
  return roleName + ' · ' + (field ? 'field ' + field + (row.source ? ' of ' + row.source : '') : 'no field chosen');
}

/** Card body for a statement change in a policy. */
export function statementCardHtml(change: StatementChange, { policy, roles = [], server }: { policy: { name: string; id?: string }; roles?: RoleRecord[]; server: string }): string {
  const index = change.afterIndex >= 0 ? change.afterIndex : change.beforeIndex;
  return targetHtml({ policyName: policy.name, policyId: policy.id, statementIndex: index, server }) +
    differencesHtml(statementDifferences(change, roles), { added: change.type === 'added', removed: change.type === 'removed' });
}

/** Rows for a field-assignment edit whose field changed, and the keys it covers. */
export function fieldChangeHtml(before: PolicyJson, after: PolicyJson, fieldOf: (rid: string) => string | undefined): { html: string; keys: string[] } {
  const d = fieldDifference(before, after, fieldOf);
  return d ? { html: differencesHtml([d]), keys: ['field', 'referenceConfig'] } : { html: '', keys: [] };
}
