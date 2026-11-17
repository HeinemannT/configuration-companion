import { describe, it, expect } from 'vitest';
import {
  refFieldsFromSchema, buildConnectionsEc, parseConnections,
  buildJunctionEc, parseJunctions, pickFarSide,
  buildInboundEc, parseInbound, INBOUND_CAP,
  REVERSE_REF_FIELD_CAP, REVERSE_REF_TOTAL_CAP,
  type SchemaProp, type RefField, type ConnTarget,
} from '../connections';
import { TEST_FRAME } from './ec-frame-fixtures';
import { framedText } from '../ec-parser';

const prop = (accessor: string, configClass: string, label = ''): SchemaProp =>
  ({ accessor, configClass, label, systemobject: false });

describe('refFieldsFromSchema', () => {
  it('extracts forward and reverse refs, ignoring non-ref props', () => {
    const fields = refFieldsFromSchema([
      prop('mitigated_risk', 'ReferenceMethodConfig'),
      prop('risk_mitigations', 'ReverseReferenceMethodConfig'),
      prop('status', 'EnumMethodConfig'),
      prop('expression', 'ExpressionMethodConfig'),
      prop('last_reviewed', 'HistoricalReferenceMethodConfig'),
    ]);
    expect(fields.map(f => [f.accessor, f.direction])).toEqual([
      ['mitigated_risk', 'out'],
      ['risk_mitigations', 'in'],
      ['last_reviewed', 'out'],
    ]);
  });

  it('prefers the config label, falls back to a de-snaked accessor', () => {
    const fields = refFieldsFromSchema([
      prop('mitigating_control', 'ReferenceMethodConfig', 'Mitigating Control'),
      prop('risk_mitigations', 'ReverseReferenceMethodConfig'),
    ]);
    expect(fields[0].label).toBe('Mitigating Control');
    expect(fields[1].label).toBe('risk mitigations');
  });

  it('skips entries with no accessor', () => {
    expect(refFieldsFromSchema([prop('', 'ReferenceMethodConfig')])).toEqual([]);
  });
});

describe('buildConnectionsEc', () => {
  const fields: RefField[] = [
    { accessor: 'mitigated_risk', label: 'mitigated risk', direction: 'out' },
    { accessor: 'risk_mitigations', label: 'risk mitigations', direction: 'in' },
  ];

  it('reads every ref via forEach and bounds reverse-ref payloads', () => {
    const ec = buildConnectionsEc('t.99', fields);
    expect(ec).toContain('_o := t.99');
    // both directions → forEach (verified live to handle single + multi)
    expect(ec).toContain('_o.mitigated_risk.forEach(_t:');
    expect(ec).toContain('_o.risk_mitigations.forEach(_t:');
    // Reverse rows are emitted only inside the per-field + total caps.
    expect(ec).toContain(`IF _fieldN <= ${REVERSE_REF_FIELD_CAP + 1} AND _reverseN <= ${REVERSE_REF_TOTAL_CAP + 1} THEN`);
    // Rows [kind, accessor, rid, id, name, type]; a count row per reverse field.
    expect(ec).toContain('"~CREV_R~1:n16:risk_mitigations"');
    expect(ec).toContain('"~CREV_R~1:f14:mitigated_risk"');
    expect(ec).toContain('"~CREV_R~1:f16:risk_mitigations"');
    expect(ec.trimEnd().endsWith('_r + "~CREV_D~"')).toBe(true);
  });

  it('refuses to interpolate an unsafe accessor', () => {
    const ec = buildConnectionsEc('t.99', [
      { accessor: 'x := lookup(1)', label: 'bad', direction: 'out' },
      { accessor: 'good_ref', label: 'good', direction: 'out' },
    ]);
    expect(ec).not.toContain('lookup(1)');
    expect(ec).toContain('good_ref');
  });
});

/** Test rows written as `rid|id|name|type` lines, as framed rows of
 *  `kind` and `key`. */
const fr = (kind: string, key: string, text: string) => text.split('\n').filter(Boolean)
  .map(line => [kind, key, ...line.split('|')]);
const done = (rows: string[][]) => framedText(rows);

describe('parseConnections', () => {
  const fields: RefField[] = [
    { accessor: 'mitigated_risk', label: 'mitigated risk', direction: 'out' },
    { accessor: 'mitigating_control', label: 'mitigating control', direction: 'out' },
    { accessor: 'risk_mitigations', label: 'risk mitigations', direction: 'in' },
  ];

  const log = done([
    ...fr('f', 'mitigated_risk', '111|ceras.7|Ransomware|CeRiskAssessment'),
    ...fr('f', 'risk_mitigations', '201|cewf.1|Patch SMB|CeWorkflow\n202|cewf.2|Segment|CeWorkflow'),
  ]);

  it('maps fields to groups, preserving order + direction', () => {
    const groups = parseConnections(log, fields);
    expect(groups.map(g => [g.field, g.direction, g.targets.length])).toEqual([
      ['mitigated_risk', 'out', 1],
      ['mitigating_control', 'out', 0],
      ['risk_mitigations', 'in', 2],
    ]);
    expect(groups[0].targets[0]).toMatchObject({ rid: '111', name: 'Ransomware', type: 'CeRiskAssessment', businessId: 'ceras.7' });
    expect(groups[2].targets.map(t => t.name)).toEqual(['Patch SMB', 'Segment']);
  });

  it('flags a target that resolves to a rid but no identity as broken', () => {
    const brokenLog = done([['f', 'mitigated_risk', '999', '', '', '']]);
    const groups = parseConnections(brokenLog, [fields[0]]);
    expect(groups[0].targets[0]).toMatchObject({ rid: '999', broken: true });
  });

  it('returns empty groups for fields entirely absent from the log, and rejects a cut-off answer', () => {
    const groups = parseConnections(TEST_FRAME.done, fields);
    expect(groups.every(g => g.targets.length === 0)).toBe(true);
    expect(groups).toHaveLength(3);
    expect(() => parseConnections('', fields)).toThrow(/incomplete/);
  });

  it('caps declared reverse groups and reports additional targets', () => {
    const reverse = fields[2];
    const rows = Array.from(
      { length: REVERSE_REF_FIELD_CAP + 1 },
      (_, i) => `${i}|b${i}|Target ${i}|CeIssue`,
    ).join('\n');
    const cappedLog = done([...fr('f', reverse.accessor, rows), ['n', reverse.accessor, String(REVERSE_REF_FIELD_CAP + 20), '', '', '']]);

    const [group] = parseConnections(cappedLog, [reverse]);
    expect(group.targets).toHaveLength(REVERSE_REF_FIELD_CAP);
    expect(group.capped).toBe(true);
  });
});

describe('junction inlining (C2)', () => {
  const fwd: RefField[] = [
    { accessor: 'mitigated_risk', label: 'mitigated risk', direction: 'out' },
    { accessor: 'mitigating_control', label: 'mitigating control', direction: 'out' },
  ];

  it('buildJunctionEc reads each junction\'s forward refs in one loop, guarding non-numeric rids', () => {
    const ec = buildJunctionEc(['202', 'bad;rid', '201'], fwd);
    expect(ec).toContain('_list := LIST(lookup(201), lookup(202))');
    expect(ec).not.toContain('bad;rid');
    expect(ec).toContain('_jid := str(_j.rid)');
    expect(ec.match(/_j\.mitigating_control\.forEach\(_t:/g)).toHaveLength(1);
  });

  it('parseJunctions maps junction rid → forward-ref targets', () => {
    const log = done([
      ...fr('j', '201', '111|loc_ddos|DDoS Risk|CeRiskAssessment\n301|cloc_waf|WAF|CeControlMeasure'),
      ...fr('j', '202', '111|loc_ddos|DDoS Risk|CeRiskAssessment'),
    ]);
    const m = parseJunctions(log);
    expect(m.get('201')!.map(t => t.rid)).toEqual(['111', '301']);
    expect(m.get('202')!.map(t => t.rid)).toEqual(['111']);
  });

  it('pickFarSide returns the ref that is not the source (back-edge) nor the junction', () => {
    const fars: ConnTarget[] = [
      { rid: '111', name: 'DDoS Risk', type: 'CeRiskAssessment', businessId: 'loc_ddos' }, // back-edge (source)
      { rid: '301', name: 'WAF', type: 'CeControlMeasure', businessId: 'cloc_waf' },        // far side
    ];
    const far = pickFarSide('111', '201', fars);
    expect(far?.rid).toBe('301');
  });

  it('pickFarSide returns undefined when only the back-edge is present', () => {
    const fars: ConnTarget[] = [{ rid: '111', name: 'R', type: 'CeRiskAssessment', businessId: 'r' }];
    expect(pickFarSide('111', '201', fars)).toBeUndefined();
  });

  it('pickFarSide skips a broken far-side (so viaRow never sees one)', () => {
    const fars: ConnTarget[] = [
      { rid: '301', name: '', type: '', businessId: '', broken: true }, // dangling
      { rid: '302', name: 'WAF', type: 'CeControlMeasure', businessId: 'waf' },
    ];
    expect(pickFarSide('111', '201', fars)?.rid).toBe('302');
    // …and undefined when the only candidate is broken.
    expect(pickFarSide('111', '201', [{ rid: '301', name: '', type: '', businessId: '', broken: true }])).toBeUndefined();
  });
});

describe('inbound scan (C3)', () => {
  it('buildInboundEc walks rref() emitting identity rows, capped server-side', () => {
    const ec = buildInboundEc('lookup(123)');
    expect(ec).toContain('_o := lookup(123)');
    expect(ec).toContain('_o.rref().forEach(_t:');
    expect(ec).toContain('_t.rid.whenMissing("")');
    // Server-side cap so a heavily-referenced object can't emit thousands of
    // rows just for the client to keep INBOUND_CAP.
    expect(ec).toContain(`IF _n <= ${INBOUND_CAP + 1} THEN`);
  });

  const inbound = (text: string, total: number) => done([...fr('i', '', text), ['n', String(total)]]);

  it('parseInbound parses referrer rows', () => {
    const log = inbound('201|mit_ddos|DDoS mitigation|CeWorkflow\n402|issue_cap|Capacity issue|CeIssue', 2);
    const { targets, capped, total } = parseInbound(log);
    expect(targets.map(t => t.type)).toEqual(['CeWorkflow', 'CeIssue']);
    expect(capped).toBe(false);
    expect(total).toBe(2);
  });

  it('keeps referrer names with |, ||| and line breaks and rejects a cut-off scan', () => {
    const log = done([['i', '', '201', 'w1', 'A | B|||C\nD ~CREV_R~ ~CREV_D~', 'CeWorkflow'], ['n', '1']]);
    expect(parseInbound(log).targets[0]).toMatchObject({ rid: '201', name: 'A | B|||C\nD ~CREV_R~ ~CREV_D~', type: 'CeWorkflow' });
    expect(() => parseInbound(framedText(fr('i', '', '201|w1|A|CeWorkflow'), false))).toThrow(/incomplete/i);
  });

  it('keeps a connection target name with | intact (before: the type shifted)', () => {
    const f: RefField = { accessor: 'owner', label: 'owner', direction: 'out' };
    const log = done([['f', 'owner', '111', 'o1', 'Risk | Ops', 'Organisation']]);
    expect(parseConnections(log, [f])[0].targets[0]).toMatchObject({ name: 'Risk | Ops', type: 'Organisation' });
  });

  it('parseInbound caps and flags when over the limit', () => {
    const log = inbound(Array.from({ length: 5 }, (_, i) => `${i}|b${i}|n${i}|CeIssue`).join('\n'), 5);
    const { targets, capped } = parseInbound(log, 3);
    expect(targets).toHaveLength(3);
    expect(capped).toBe(true);
  });
});
