/**
 * IDs of any characters: addressed as `<space>.get("<ID>")` (measured on
 * 5.6.17 for each ID below; on 5.6.10 for `ap.get("Everyone profile")`),
 * read from generated text by the space and the `id` argument, written
 * into every script, and read back from the comparison's answer.
 */
import { describe, expect, it } from 'vitest';
import { addressOf, assembleBundle, checkAddress, parseGenedit, splitAddress, UNADDRESSABLE_REASON, type BundleInput } from '../../lib/transport-bundle';
import { assemblePatch, buildProbe, parseProbeAnswer } from '../../lib/transport-patch';
import { probeAnswer } from './fakes';

const BS = '\\';
/** An ID as 5.6.17 escapes it inside single quotes: `\'`, `\"`, `\/`, `\\`, `\uXXXX`. */
const esc = (id: string) => [...id].map(c => (c === BS ? BS + BS : c === "'" ? `${BS}'` : c === '"' ? `${BS}"` : c === '/' ? `${BS}/`
  : c.charCodeAt(0) > 127 ? `${BS}u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('');

const IDS: Array<[string, string]> = [
  ['crev-qa-dash', 't.get("crev-qa-dash")'],
  ['crev qa space', 't.get("crev qa space")'],
  ['crev.qa.dot', 't.get("crev.qa.dot")'],
  ["crev'qa'single", 't.get("crev\'qa\'single")'],
  ['crev"qa"double', 't.get("crev\\"qa\\"double")'],
  ['crev/qa#odd:chars(1)', 't.get("crev/qa#odd:chars(1)")'],
  ['crevÄö', 't.get("crevÄö")'],
  ['9starts_with_digit', 't.get("9starts_with_digit")'],
];

describe('an address for any ID', () => {
  it('plain IDs stay short; any other is written with .get("…"), \\ and " escaped', () => {
    expect(addressOf('t', 'plain_id')).toBe('t.plain_id');
    expect(addressOf('cepro', '108')).toBe('cepro.108');
    for (const [id, address] of IDS) {
      expect(addressOf('t', id), id).toBe(address);
      expect(splitAddress(address), id).toEqual({ space: 't', id });
      expect(checkAddress(address), id).toEqual({ ok: true, space: 't', id, numeric: false });
    }
    expect(addressOf('t', 'a\\b')).toBe('t.get("a\\\\b")');
    // A line break or another control character cannot be written.
    expect(addressOf('t', 'a\nb')).toBe('');
    expect(addressOf('t', 'a\u0007b')).toBe('');
  });

  it('read from generated text: the space before the first dot, the ID from the id argument (5.6.17 .get form, 5.6.10 bare form)', () => {
    for (const [id, address] of IDS) {
      const v17 = `\nt.get('${esc(id)}').change(id := '${esc(id)}', name := 'x') //InputSet\n`;
      const bare = `t.${id}.change(id := '${esc(id)}', name := 'x') //InputSet`;
      expect(parseGenedit(v17)?.address, id).toBe(address);
      expect(parseGenedit(bare)?.address, id).toBe(address);
    }
    expect(parseGenedit("ap.Everyone profile.change(id := 'Everyone profile') //ScorecardAccessProfile")?.address).toBe('ap.get("Everyone profile")');
    // Without an id argument: the text as it is.
    expect(parseGenedit("t.x.change(name := 'y') //A")?.address).toBe('t.x');
  });

  it('written into every script, and read back from the answer by its size', () => {
    const inputs: BundleInput[] = IDS.map(([id], i) => ({
      rid: String(9007199254741200n + BigInt(i)), id, className: 'InputSet', isNew: true,
      genedit: `\nt.get('${esc(id)}').change(id := '${esc(id)}', name := 'X ${i}') //InputSet\n`, parentAddress: 't.cc_folder',
    }));
    const b = assembleBundle(inputs);
    expect(b.leftOut).toEqual([]);
    const add = b.parts.find(p => p.step === 'create')!.text;
    for (const [id, address] of IDS) expect(add, id).toContain(`IF ${address} = MISSING THEN`);
    // The guards: one loop over the IDs that can be shown from the loop, each
    // shown as addressOf writes it; one line for the ID with a quote.
    expect(add).toContain('list("9starts_with_digit", "crev qa space", "crev\'qa\'single", "crev-qa-dash", "crev.qa.dot", "crev/qa#odd:chars(1)", "crevÄö").forEach(_x:');
    expect(add).toContain('IF _o != MISSING AND _o.className != \'InputSet\' THEN _w := _w + " " + "t.get(\\"" + _x + "\\")" + " (" + str(_o.className) + ")" ELSE "" ENDIF');
    expect(add).toContain('IF t.get("crev\\"qa\\"double") != MISSING AND t.get("crev\\"qa\\"double").className != \'InputSet\' THEN');
    expect(b.parts.find(p => p.step === 'set')!.text).toContain('t.get("crev qa space").change(id := ');
    // The comparison: the places in one loop over the IDs, each address framed in the answer.
    const probe = buildProbe(inputs.map(i => ({ ...i, isNew: false })));
    expect(probe.parts[0].text).toContain('list("9starts_with_digit", "crev qa space", "crev\'qa\'single", "crev-qa-dash", "crev.qa.dot", "crev/qa#odd:chars(1)", "crev\\"qa\\"double", "crevÄö").forEach(_x:');
    expect(probe.parts[0].text).toContain(`\\nO 21:t.get(\\"crev-qa-dash\\") `);
    const half = Object.fromEntries(IDS.filter((_, i) => i % 2 === 0).map(([, a], i) => [a, { cls: 'InputSet', genedit: inputs[i * 2].genedit, parent: 'cc_folder' }]));
    const r = parseProbeAnswer(probeAnswer(probe, { ...half, 't.cc_folder': { cls: 'Category' } }), probe);
    if (!r.ok) throw new Error(r.error);
    for (const [id, address] of IDS) expect(r.answer.states[address]?.state, id).toBe(IDS.findIndex(x => x[0] === id) % 2 === 0 ? 'present' : 'missing');
    const patch = assemblePatch(inputs.map(i => ({ ...i, isNew: false })), r.answer);
    expect(patch.review.map(x => x.outcome).sort()).toEqual(['create', 'create', 'create', 'create', 'same', 'same', 'same', 'same']);
    // The Check loop holds the IDs of the objects the target has.
    const check = patch.parts.find(p => p.step === 'check')!.text;
    // The ID with a quote is checked on its own; the loop shows the others as .get("…").
    expect(check).toContain('list("crev-qa-dash", "crev.qa.dot", "crevÄö").forEach(_x:');
    expect(check).toContain('_r := _r + "\\nCHANGED since the comparison " + "t.get(\\"" + _x + "\\")"');
    expect(check).toContain('IF _g.size() = ');
    expect(check).toContain('_e := "|crev-qa-dash=');
    // Those the target lacks: still missing.
    expect(check).toContain('IF t.get("crev qa space") != MISSING THEN');
  });

  it('an ID with a line break is left out', () => {
    const b = assembleBundle([{ rid: '9007199254741300', id: 'a\nb', className: 'InputSet', isNew: true, genedit: "t.get('a\\nb').change(id := 'a\\nb') //InputSet", parentAddress: 't.p' }]);
    expect(b.leftOut).toMatchObject([{ reason: 'unaddressable', detail: UNADDRESSABLE_REASON }]);
  });
});
