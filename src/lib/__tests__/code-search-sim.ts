/**
 * A simulated BMP for the code search tests: answers the scan, list, count
 * and read scripts of code-index-sync and code-search from a list of objects.
 */
import { framedText, STATIC_EC_FRAME as F } from '../ec-parser';

/** One framed row (ec-parser length framing). */
const row = (...fields: Array<string | number>) => framedText([fields.map(String)], false);

/** The text of the framed literal `<n>:<text>` at `at` in a script. */
function framedKeyAfter(text: string, at: number): string {
  const m = /^(\d+):/.exec(text.slice(at));
  if (!m) return '';
  return text.slice(at + m[0].length, at + m[0].length + Number(m[1]));
}
import type { IndexClient } from '../code-index-sync';
import type { EcResult } from '../bmp-client';

// ── a simulated BMP ───────────────────────────────────────────────

export interface SimObject {
  rid: string; type: string; id: string; name: string; stamp: string; code: Record<string, string>;
  /** Root accessor (default `expression`). */
  root?: string;
  /** Own organisation (organisation root). */
  org?: string;
  /** Template (`linkedTo`). */
  tmpl?: string;
  /** Day of the last change (yyyy-mm-dd), for the stamp filter. */
  day?: string;
  /** Organisation root, without an organisation of its own: the top it lies under. */
  top?: string;
  /** Parent object (RID): an object's script as the context lists what is under it. */
  parent?: string;
}

export interface SimOrg { rid: string; name: string; parent: string }

const ROOT_NAMES: Record<string, string> = { expression: 'Expression', templateCategory: 'Template category', organisation: 'Organization', portal: 'Portal' };
/** Each root's RID (a count runs with the root as the command's context). */
export const ROOT_RIDS: Record<string, string> = { expression: '901', templateCategory: '902', organisation: '903', portal: '904' };
const rootByRid = (rid: string) => Object.keys(ROOT_RIDS).find(k => ROOT_RIDS[k] === rid);

/** The server's time the listing reports (the stamps' format). */
export const SIM_NOW = 'Nov 12, 2026 12:00:00';

/** `context`: the client has the context path (executeEcPairs and
 *  executeEcEach, like BmpClient): a script's `this.object` is the command's
 *  object, answered as the same script with `lookup(<RID>)`. */
export function server(objects: SimObject[], opts: { lookup?: boolean; failType?: string; failRid?: string; orgs?: SimOrg[]; failOrgType?: string; overload?: (code: string) => boolean; context?: boolean; failNarrowType?: string; failCount?: (source: string) => boolean } = {}) {
  const posts: string[][] = [];
  const orgs = opts.orgs ?? [];
  const under = (org: string | undefined, top: string): boolean => {
    for (let cur = org; cur; cur = orgs.find(g => g.rid === cur)?.parent) if (cur === top) return true;
    return false;
  };
  const rootOf = (o: SimObject) => o.root ?? 'expression';
  const inGroup = (o: SimObject, g: string, own: boolean) => {
    const m = /^(?:root\.(\w+)|lookup\((-?\d+)\))$/.exec(g)!;
    if (m[2] && rootByRid(m[2])) return rootOf(o) === rootByRid(m[2]);
    if (m[2] && !own && below(o, m[2])) return true;
    return m[1] ? rootOf(o) === m[1] : own ? o.org === m[2] : under(o.org, m[2]) || (!o.org && o.top === m[2]);
  };
  const below = (o: SimObject, rid: string): boolean => {
    for (let cur = o.parent, n = 0; cur && n < 32; cur = objects.find(x => x.rid === cur)?.parent, n++) if (cur === rid) return true;
    return false;
  };
  const dayOf = (o: SimObject) => o.day ?? '2999-01-01';
  const client: IndexClient & { posts: string[][] } = {
    posts,
    ensureLookupSupport: async () => opts.lookup !== false,
    resolveRefs: async rids => new Map(rids.map(r => [r, `lookup(${r})`])),
    executeEcBatch: async codes => {
      posts.push([...codes]);
      return codes.map((code): EcResult => {
        if (opts.overload?.(code)) return { ok: false, error: 'java.lang.OutOfMemoryError: Java heap space' };
        if (code.includes(`${F.row}1:L`)) {
          // the live search's listing (code-scope-read buildSourceListEc):
          // every object with code of each type in the source
          const from = /^_g := (\S+)$/m.exec(code)![1];
          const out: string[] = [];
          for (const m of code.matchAll(/_l := SELECT (\w+) FROM _g\n/g)) {
            const type = m[1];
            if (type === opts.failType) return { ok: false, error: 'Unknown class', errorKind: 'server' };
            for (const o of objects.filter(x => x.type === type && (from === 'root' || inGroup(x, from, false)))) {
              const len = Object.values(o.code).join('').length;
              if (len > 0) out.push(row('L', type, o.rid, o.stamp, len));
            }
          }
          out.push(row('T', '', '', SIM_NOW, ''));
          return { ok: true, log: `${out.join('')}${F.done}` };
        }
        const anc = /^_p := lookup\((-?\d+)\)\.parent$/m.exec(code);
        if (anc) {
          // the change feed's ancestors (code-scope-read buildAncestorsEc):
          // parent objects, then the organisation and those above it
          const chain: string[] = [];
          let o = objects.find(x => x.rid === anc[1]);
          if (!o) return { ok: false, error: 'Object not found', errorKind: 'server' };
          for (let n = 0; o && n < 40; n++) {
            if (o.parent) { chain.push(o.parent); const next = objects.find(x => x.rid === o!.parent); if (next) { o = next; continue; } }
            for (let g = o.parent ? undefined : o.org; g; g = orgs.find(x => x.rid === g)?.parent) chain.push(g);
            break;
          }
          return { ok: true, log: `${chain.join(',')}${chain.length ? ',' : ''}TOP=${o?.root === 'organisation' || o?.org ? 'Organisation' : 'Portal'}Root#END` };
        }
        if (code.includes('#END')) {
          // a narrowing script (code-scope-read buildHitScanEcs)
          const type = /SELECT (\w+) FROM|LIST\(lookup/.exec(code)?.[1];
          if (type && type === opts.failNarrowType) return { ok: false, error: 'Unknown class', errorKind: 'server' };
          const from = /FROM (lookup\(-?\d+\))/.exec(code)?.[1];
          const self = /LIST\(lookup\((-?\d+)\)\)/.exec(code)?.[1];
          const needles = [...code.matchAll(/_q\d+ := "((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
          const props = [...code.matchAll(/_w := output\(_o\.(\w+)\)/g)].map(m => m[1]);
          const list = self ? objects.filter(o => o.rid === self) : objects.filter(o => o.type === type && from && inGroup(o, from, false));
          const hit = list.filter(o => props.some(p => needles.some(n => (o.code[p] ?? '').includes(n))));
          return { ok: true, log: `${hit.map(o => o.rid).join(',')}${hit.length ? ',' : ''}#END` };
        }
        if (code.includes('"~CREV_R~1:I"') && /^_g := /m.test(code) && code.includes('SELECT ')) {
          // a bulk read of one type in a source (code-scope-read buildSourceCodeEc)
          const from = /^_g := (\S+)$/m.exec(code)![1];
          const type = /_l := SELECT (\w+) FROM _g/.exec(code)![1];
          const part = /_len > 0 AND _n = (\d+)/.exec(code);
          const parts = /IF _n >= (\d+) THEN _n := 0 ENDIF/.exec(code);
          const props = new Set([...code.matchAll(/output\(_o\.(\w+)\.whenMissing/g)].map(m => m[1]));
          const withCode = objects.filter(o => o.type === type && inGroup(o, from, false) && Object.values(o.code).join('').length > 0);
          const out: string[] = [];
          withCode.forEach((o, i) => {
            if (part && parts && i % Number(parts[1]) !== Number(part[1])) return;
            out.push(row('I', o.rid, o.id, o.name, 'Parent', 'Grand', o.stamp, o.tmpl ?? ''));
            for (const [p, t] of Object.entries(o.code)) if (props.has(p)) out.push(row('C', o.rid, p, t));
          });
          return { ok: true, log: `${out.join('')}${F.done}` };
        }
        if (code.includes('_x := root.')) {
          const rows = [...code.matchAll(/_x := root\.(\w+)/g)].map(m => m[1])
            .filter(k => ROOT_NAMES[k] && (objects.some(o => rootOf(o) === k) || k === 'organisation' && orgs.length))
            .map(k => row('R', k, ROOT_RIDS[k], ROOT_NAMES[k], ''));
          if (code.includes('SELECT Organisation')) for (const g of orgs) rows.push(row('G', g.rid, g.name, g.parent || '9', g.parent ? 'Organisation' : 'OrganisationRoot'));
          return { ok: true, log: `${rows.join('')}${F.done}` };
        }
        if (code.includes(`"${F.row}1:S`)) {
          const out: string[] = [];
          // The day is in the text, or the context's end (`_since := this.end`).
          const contextDay = /_since := date\("([\d-]+)"\)/.exec(code)?.[1] ?? '0000-00-00';
          for (const m of code.matchAll(/_c := SELECT (\w+) FROM (\S+) WHERE lastModifiedDate >= (?:date\("([\d-]+)"\)|_since)/g)) {
            const [, type, src] = m;
            const since = m[3] ?? contextDay;
            const all = objects.filter(o => o.type === type && (src === 'root' || rootOf(o) === src.slice(5)));
            const ch = all.filter(o => dayOf(o) >= since);
            const newest = ch.map(o => `${dayOf(o)} ${o.stamp}`).sort().at(-1) ?? '';
            out.push(row('S', src, type, all.length, ch.length, newest));
          }
          return { ok: true, log: `${out.join('')}${F.done}` };
        }
        if (code.includes(`"${F.row}1:N`)) {
          const out: string[] = [];
          const g = /^_g := (\S+)$/m.exec(code)![1];
          if (opts.failCount?.(g)) return { ok: false, error: 'Count refused', errorKind: 'server' };
          for (const m of code.matchAll(/_l := SELECT (\w+) FROM _g( WHERE organisation = _g)?\n_n := _l\.size\(\)\n[^\n]*\n_r := _r \+ \("~CREV_R~1:N/g)) {
            const [, type, own] = m;
            const key = framedKeyAfter(code, m.index! + m[0].length);
            if (type === opts.failType) return { ok: false, error: 'Unknown class', errorKind: 'server' };
            out.push(row('N', key, type, objects.filter(o => o.type === type && inGroup(o, g, !!own)).length));
          }
          return { ok: true, log: `${out.join('')}${F.done}` };
        }
        if (code.includes('_hit := FALSE') && code.includes('_g := ')) {
          // live scan of one or more sources: H rows (candidates), T rows (totals)
          const needles = [...code.matchAll(/_q\d+ := "((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
          const pat = /_p := "([^"]*)"/.exec(code)?.[1];
          const out: string[] = [];
          code.split(/\n_g := /).slice(1).forEach((block, si) => {
            const from = block.slice(0, block.indexOf('\n'));
            for (const m of block.matchAll(/_list := SELECT (\w+) FROM _g/g)) {
              const type = m[1];
              const list = objects.filter(o => o.type === type && (from === 'root' || inGroup(o, from, false)));
              const hit = (o: SimObject) => Object.values(o.code).some(t => needles.length ? needles.some(n => t.includes(n))
                : pat ? new RegExp(`^${pat.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`, 'i').test(t) : true);
              for (const o of list.filter(hit)) out.push(row('H', si, type, o.rid));
              out.push(row('T', si, type, list.filter(o => Object.values(o.code).join('')).length));
            }
          });
          return { ok: true, log: `${out.join('')}${F.done}` };
        }
        const g = /_g := (\S+)\n/.exec(code);
        if (g && code.includes('_x := _l.calculate(')) {
          const ridsOnly = !code.includes('lastModifiedDate.whenMissing');
          const out: string[] = [];
          for (const m of code.matchAll(/_l := SELECT (\w+) FROM _g(?: WHERE ([^\n]+))?\n/g)) {
            const type = m[1];
            const conds = m[2] ?? '';
            if (type === opts.failType) return { ok: false, error: 'Unknown class', errorKind: 'server' };
            const since = /date\("([\d-]+)"\)/.exec(conds)?.[1];
            const orgless = code.includes('organisation.rid.whenMissing("")) = ""');
            const here = objects.filter(o => o.type === type && inGroup(o, g[1], conds.includes('organisation = _g')) && (!since || dayOf(o) >= since) && (!orgless || !o.org));
            for (const o of here) out.push(ridsOnly ? row('O', type, o.rid, '', '') : row('O', type, o.rid, o.stamp, o.org ?? ''));
          }
          return { ok: true, log: `${out.join('')}${F.done}\nDuration : 3ms` };
        }
        const sel = /SELECT (\w+) FROM (\S+)/.exec(code);
        if (sel && !code.includes('LIST(')) {
          const type = sel[1];
          if (type === opts.failType) return { ok: false, error: 'Unknown class' };
          const list = objects.filter(o => o.type === type);
          if (code.includes('_hit := FALSE')) {
            // candidate scan: indexOf needles or a wildcard
            const needles = [...code.matchAll(/_q\d+ := "((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
            const pat = /_p := "([^"]*)"/.exec(code)?.[1];
            const hit = (o: SimObject) => Object.values(o.code).some(t => needles.length ? needles.some(n => t.includes(n))
              : pat ? new RegExp(`^${pat.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`, 'i').test(t) : true);
            return { ok: true, log: `${list.filter(hit).map(o => row(o.rid)).join('')}${F.done}` };
          }
          const rows = list.map(o => row(o.rid, o.stamp, Object.values(o.code).join('').length));
          return { ok: true, log: `${rows.join('')}${F.done}\nDuration : 3ms` };
        }
        if (code.includes('"~CREV_R~1:I"')) {
          const rids = [...code.matchAll(/lookup\((-?\d+)\)/g)].map(m => m[1]);
          if (opts.failRid && rids.includes(opts.failRid)) return { ok: false, error: 'cannot be cast to BusinessTreeObject' };
          const props = new Set([...code.matchAll(/output\(_o\.(\w+)\.whenMissing/g)].map(m => m[1]));
          const out: string[] = [];
          for (const rid of rids) {
            const o = objects.find(x => x.rid === rid);
            if (!o) continue; // a MISSING list element writes no row
            out.push(row('I', rid, o.id, o.name, 'Parent', 'Grand', o.stamp, o.tmpl ?? ''));
            for (const [p, t] of Object.entries(o.code)) if (props.has(p)) out.push(row('C', rid, p, t));
          }
          return { ok: true, log: `${out.join('')}${F.done}\nDuration : 5ms` };
        }
        if (code.includes('_hit := FALSE') && code.includes('.forEach(_o:')) {
          // live scan of listed objects (a scope): H rows, one T row
          const needles = [...code.matchAll(/_q\d+ := "((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
          const listed = [...code.matchAll(/lookup\((-?\d+)\)/g)].map(m => objects.find(o => o.rid === m[1])).filter((o): o is SimObject => !!o);
          const pat = /_p := "([^"]*)"/.exec(code)?.[1];
          const withCode = listed.filter(o => Object.values(o.code).join(''));
          const out = withCode.filter(o => Object.values(o.code).some(t => needles.length ? needles.some(n => t.includes(n))
            : pat ? new RegExp(`^${pat.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`, 'i').test(t) : true))
            .map(o => row('H', 0, o.type, o.rid));
          out.push(row('T', 0, '*', withCode.length));
          return { ok: true, log: `${out.join('')}${F.done}` };
        }
        return { ok: false, error: 'unexpected script' };
      });
    },
  };
  if (opts.context) {
    // The context path: the same script with the object by its RID.
    const text = (code: string, rid?: string) => (rid ? code.split('this.object').join(`lookup(${rid})`) : code);
    // The context's end date (`this.end`) as the day it stands for.
    const end = (code: string, endMs?: number) => (endMs != null ? code.split('_since := this.end').join(`_since := date("${new Date(endMs).toISOString().slice(0, 10)}")`) : code);
    client.executeEcPairs = async pairs => client.executeEcBatch(pairs.map(p => end(text(p.code, p.objectRid), p.endMs)));
    client.executeEcEach = async (code, rids) => { const r = await client.executeEcBatch(rids.map(rid => text(code, rid))); return new Map(rids.map((rid, i) => [rid, r[i]])); };
  }
  return client;
}

export const sim = (): SimObject[] => [
  { rid: '9007199254740993', type: 'ExtendedExpression', id: 'assessment_basis_values', name: 'Assessment basis values', stamp: 'Nov 1, 2026 10:00:00',
    code: { expression: 'LIST(today, "x")\n// TODAY in a comment\n_v := whenMissing(1)' } },
  { rid: '9007199254740995', type: 'ExtendedExpression', id: 'assessment_issue_single', name: 'Assessment issue single', stamp: 'Nov 1, 2026 10:00:00',
    code: { expression: '_b := t.assessment_basis_values.expression\n"t.assessment_basis_values in a string"\n// t.assessment_basis_values commented\n_c := {assessment_basis_values}\n_d := lookup(9007199254740993)' } },
  { rid: '9007199254740997', type: 'ExtendedTable', id: 'tbl_one', name: 'Table one', stamp: 'Nov 1, 2026 10:00:00',
    code: { expression: 'IF a < Today THEN\n  todays := 1\nENDIF\n_o := o.assessment_basis_values' } },
  { rid: '9007199254740999', type: 'ButtonInput', id: 'btn', name: 'Button', stamp: 'Nov 1, 2026 10:00:00',
    code: { initExpression: '_x := 1', afterExpression: '_d := today' } },
];

// ── roots, stages, instances ──────────────────────────────────────

/** A small server with templates, two top-level organisations (one with a
 *  sub-organisation) and instances of the templates in each. */
export function orgWorld() {
  const orgs: SimOrg[] = [
    { rid: '100', name: 'Group', parent: '' },
    { rid: '110', name: 'Europe', parent: '100' },
    { rid: '200', name: 'Administration', parent: '' },
  ];
  const objects: SimObject[] = [
    { rid: '1', type: 'ExtendedTable', id: 't1', name: 'Risks table', stamp: 's', root: 'templateCategory', code: { expression: 'SELECT CeRisk WHERE due < today' } },
    { rid: '2', type: 'ActionButton', id: 'b1', name: 'Close', stamp: 's', root: 'templateCategory', code: { expression: '_x := today', afterExpression: '_y := 1' } },
    { rid: '3', type: 'ExtendedExpression', id: 'e1', name: 'Expr', stamp: 's', root: 'expression', code: { expression: 'today + 1' } },
  ];
  let n = 1000;
  for (const org of ['100', '110', '200']) {
    objects.push({ rid: String(n++), type: 'ExtendedTable', id: `t${n}`, name: 'Risks table', stamp: 's', root: 'organisation', org, tmpl: '1', code: { expression: 'SELECT CeRisk WHERE due < today' } });
    objects.push({ rid: String(n++), type: 'ActionButton', id: `b${n}`, name: 'Close', stamp: 's', root: 'organisation', org, tmpl: '2', code: { expression: '_x := today', afterExpression: '_y := 1' } });
  }
  // One instance overrides the button's after expression.
  objects.push({ rid: String(n++), type: 'ActionButton', id: 'b_over', name: 'Close', stamp: 's', root: 'organisation', org: '110', tmpl: '2', code: { expression: '_x := today', afterExpression: '_y := today' } });
  return { orgs, objects };
}
