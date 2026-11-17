/**
 * Transport (beta), files: the size decision ("Carry the content of files
 * up to n KB", never more than fits in one script part), the read that
 * never loads a larger file's content, the Add without content, the
 * comparison that leaves the content out, and what the person is told:
 * the comment lines and the log entry.
 */
import { describe, expect, it, vi } from 'vitest';
import { framedText } from '../ec-parser';
import {
  assembleBundle, NEVER_CARRIED, withoutNeverCarried, FILE_LIMIT_KB_DEFAULT, FILE_PART_ROOM, fileContent, fileLimitChars, fileLimitKb, sizeKb, uploadText, type BundleInput,
} from '../transport-bundle';
import { assemblePatch, buildProbe, parseProbeAnswer, propertyDefinitionRids, PROBE_MARKER, PROBE_VERSION, transportSummary, type ProbeAnswer, type TransportProbe } from '../transport-patch';
import {
  buildTransportCreationEc, buildTransportObjectNoContentEc, buildTransportFileTextEc, buildTransportNeighboursEc, buildTransportObjectEc,
  readTransportObjects,
} from '../transport-read';
import type { EcResult } from '../bmp-client';

const RID_S = '9007199254740993', RID_L = '9223372036854775801';

describe('the size decision', () => {
  it('KB is 1,000 characters of the generated text; the limit is 1 to 19 (one script part), default 19', () => {
    expect(FILE_LIMIT_KB_DEFAULT).toBe(19);
    expect([fileLimitKb(0), fileLimitKb(150), fileLimitKb(12.4), fileLimitKb('x')]).toEqual([1, 19, 12, 19]);
    expect(fileLimitChars(3)).toBe(3_000);
    expect(fileLimitChars(19)).toBe(FILE_PART_ROOM);
    expect(fileContent(3_000, 19)).toEqual({ carried: true, part: false });
    expect(fileContent(412_000, 19)).toEqual({ carried: false, part: false });
    expect([sizeKb(412_340), sizeKb(1_200), sizeKb(120)]).toEqual(['412 KB', '1 KB', 'under 1 KB']);
    expect(uploadText({ rid: '1', address: 'r.logo', name: 'logo.png' })).toBe('r.logo (logo.png)');
  });

  it('file content off: no script calls genedit() or generate(true) without value names on a file', () => {
    const off = buildTransportObjectNoContentEc();
    const fileBranch = off.slice(off.indexOf("IF _o.className = 'FileResource' THEN"), off.indexOf('ELSE'));
    expect(fileBranch).toContain('_t := str(_o.genedit(id, name))');
    expect(fileBranch).toContain('_s := "?"');
    expect(fileBranch).not.toContain('genedit()');
    // generate(true) runs only for a property definition (a class name with MethodConfig).
    expect(buildTransportCreationEc()).toContain('_x := _c.indexOf("MethodConfig").whenMissing(-1)');
    // The address of a neighbour that is a file: its genedit(id), one value.
    expect(buildTransportNeighboursEc()).not.toContain('genedit()');
  });

  it('a read with file content off: one post of the object script without content; a file is not measured and its content is never asked for', async () => {
    const executeEcPairs = vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => (p.code === buildTransportObjectNoContentEc()
      ? { ok: true, log: framedText([[p.objectRid!, 'FileResource', "t.logo.change(id := 'logo', name := 'logo.png') //FileResource", '?']]) }
      : { ok: true, log: framedText([['', '', '', '', '', 'false', '', '', '', '']]) })));
    const [r] = await readTransportObjects({ executeEcPairs }, [RID_L], undefined, [RID_L], 0);
    expect(r).toMatchObject({ ok: true, isFile: true, contentCarried: false });
    expect(r).not.toHaveProperty('fileSize');
    expect(executeEcPairs).toHaveBeenCalledTimes(1);
    expect(executeEcPairs.mock.calls[0][0].map(x => x.code)).not.toContain(buildTransportObjectEc());
  });
});

describe('the read of a file', () => {
  const near = (): EcResult => ({ ok: true, log: framedText([['7000000000000000001', '', '', 'files', 'Category', 'false', '', "t.files.change(id := 'files') //Category", '', '']]) });
  const fileRow = (rid: string, size: number): EcResult => ({ ok: true, log: framedText([[rid, 'FileResource', `t.f${rid.slice(-3)}.change(id := 'f${rid.slice(-3)}', name := 'logo.svg') //FileResource`, String(size)]]) });

  it('a file is measured first; only one within the limit gets its whole text, in one more post; no creation text', async () => {
    const codes: string[][] = [];
    const executeEcPairs = vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => {
      codes.push(pairs.map(p => `${p.objectRid}:${p.code === buildTransportObjectEc() ? 'own' : p.code === buildTransportNeighboursEc() ? 'near' : p.code === buildTransportCreationEc() ? 'made'
        : p.code === buildTransportFileTextEc() ? 'text' : '?'}`));
      return pairs.map(p => {
        if (p.code === buildTransportObjectEc()) return fileRow(p.objectRid!, p.objectRid === RID_S ? 3_000 : 412_000);
        if (p.code === buildTransportCreationEc()) return { ok: true, log: framedText([[p.objectRid!, 'N', '']]) };
        if (p.code === buildTransportFileTextEc()) return { ok: true, log: framedText([[p.objectRid!, "t.f993.change(id := 'f993', name := 'logo.svg', content := 'logo.svg;image/svg+xml;H4s') //FileResource"]]) };
        return near();
      });
    });
    const read = await readTransportObjects({ executeEcPairs }, [RID_S, RID_L], undefined, [], fileLimitChars(20));
    expect(codes[0].filter(c => c.endsWith(':made'))).toEqual([]);
    expect(codes[1]).toEqual([`${RID_S}:text`]);
    expect(read[0]).toMatchObject({ fileSize: 3_000, contentCarried: true, genedit: expect.stringContaining('content :=') });
    expect(read[0]).not.toHaveProperty('generate');
    expect(read[1]).toMatchObject({ fileSize: 412_000, contentCarried: false, genedit: "t.f801.change(id := 'f801', name := 'logo.svg') //FileResource" });
    expect(read[1]).not.toHaveProperty('generate');
    // The larger file's content was never asked for.
    expect(codes.flat().filter(c => c.startsWith(RID_L) && /text/.test(c))).toEqual([]);
  });

});

/** A file of 412 KB whose content is not carried, and a small one that travels. */
const big = (extra: Partial<BundleInput> = {}): BundleInput => ({
  rid: RID_L, id: 'logo_big', className: 'FileResource', isNew: true,
  genedit: "\nt.logo_big.change(id := 'logo_big', name := 'logo.png') //FileResource\n",
  parentAddress: 't.files', previousAddress: '', nextAddress: '', file: { size: 412_000, carried: false }, ...extra,
});
const small = (): BundleInput => ({
  rid: RID_S, id: 'logo_small', className: 'FileResource', isNew: true,
  genedit: "\nt.logo_small.change(id := 'logo_small', name := 'icon.svg', content := 'icon.svg;image/svg+xml;H4s') //FileResource\n",
  parentAddress: 't.files', previousAddress: '', nextAddress: '', file: { size: 3_000, carried: true },
});

describe('scripts without comparison', () => {
  it('a larger file is added without content under its parent; a comment line says to upload it; the report compares it without the content', () => {
    const b = assembleBundle([big(), small()]);
    // The comment is in the part that adds the file, right after its header.
    const addPart = b.parts.find(p => p.step === 'create')!.text.split('\n');
    expect(addPart[3]).toBe('// Upload afterwards: t.logo_big (logo.png, 412 KB)');
    const adds = b.parts.filter(p => p.step === 'create').map(p => p.text).join('\n');
    expect(adds).toContain("t.files.add(FileResource, id := 'logo_big', name := 'logo.png')");
    expect(adds).toContain("content := 'icon.svg;image/svg+xml;H4s'");
    expect(b.uploads).toEqual([{ rid: RID_L, address: 't.logo_big', name: 'logo.png', size: 412_000 }]);
    expect(b.preamble).toContain('// Upload afterwards: t.logo_big (logo.png, 412 KB)');
    expect(b.preamble).not.toContain('logo_small (');
    const report = b.parts.find(p => p.step === 'report')!.text;
    expect(report).toContain('_g := str(t.logo_big.genedit(id, name))');
    expect(report).toContain('_g := str(t.logo_small.genedit())');
    expect(uploadText(b.uploads[0])).toBe('t.logo_big (logo.png, 412 KB)');
  });
});

describe('values never carried', () => {
  it('steadfastAgentConfiguration is left out of what is written and of the comparison', () => {
    expect(NEVER_CARRIED).toEqual(['steadfastAgentConfiguration']);
    expect(withoutNeverCarried("id := 'a', steadfastAgentConfiguration := '{\"x\": 1}', name := 'A'")).toBe("id := 'a', name := 'A'");
    const tab: BundleInput = {
      rid: RID_S, id: 'tab', className: 'Tab', isNew: false, parentAddress: 't.page', previousAddress: '', nextAddress: '',
      genedit: "\nt.tab.change(id := 'tab', name := 'Tab', steadfastAgentConfiguration := 'cfg') //Tab\n",
    };
    const b = assembleBundle([tab]);
    // Not written (the preview Report still compares the whole text as the target prints it).
    expect(b.parts.filter(x => x.step !== 'report').map(x => x.text).join('')).not.toContain('steadfastAgentConfiguration');
    // The target (5.6.10) has no such value: the same, not "to change".
    const probe = buildProbe([tab]);
    const text = `${PROBE_MARKER} v${PROBE_VERSION} part 1/1 key ${probe.key}\nP t 3:tab 4:page 0: 0:\nO 5:t.tab Tab ${"\nt.tab.change(id := 'tab', name := 'Tab') //Tab\n".length}:\nt.tab.change(id := 'tab', name := 'Tab') //Tab\n 0:\nE 6:t.page Category 0:\n${PROBE_MARKER} end part 1/1 key ${probe.key}`;
    const r = parseProbeAnswer(text, probe);
    if (!r.ok) throw new Error(r.error);
    const p = assemblePatch([tab], r.answer);
    expect(p.review[0].outcome).toBe('same');
    expect(p.nothingToDo).toBe(true);
  });
});

describe('a comparison', () => {
  const answerOf = (probe: TransportProbe, has: Record<string, string | undefined>): ProbeAnswer => {
    const text = probe.parts.map(part => {
      let s = `${PROBE_MARKER} v${PROBE_VERSION} part ${part.index}/${part.total} key ${probe.key}`;
      for (const e of probe.entries.filter(x => x.part === part.index)) {
        const g = has[e.address];
        const a = `${e.address.length}:${e.address}`;
        if (g == null) s += `\nM ${a}`;
        else if (e.kind === 'object') s += `\nP t ${e.address.length - 2}:${e.address.slice(2)} 5:files 0: 0:\nO ${a} FileResource ${g.length}:${g} 0:`;
        else s += `\nE ${a} Category 0:`;
      }
      return `${s}\n${PROBE_MARKER} end part ${part.index}/${part.total} key ${probe.key}`;
    }).join('\n');
    const r = parseProbeAnswer(text, probe);
    if (!r.ok) throw new Error(r.error);
    return r.answer;
  };

  it('reads a larger file without its content on the target; one the target lacks is added without content and no creation text is read', () => {
    const probe = buildProbe([big()]);
    expect(probe.text).toContain('_g := str(t.logo_big.genedit(id, name))');
    expect(probe.entries[0]).toMatchObject({ address: 't.logo_big', short: true });
    // The key follows how the file is read.
    expect(buildProbe([big({ file: { size: 3_000, carried: true } })]).key).not.toBe(probe.key);
    const answer = answerOf(probe, { 't.files': '' });
    expect(propertyDefinitionRids([big()])).toEqual([]);
    const p = assemblePatch([big()], answer, { record: { entryId: 'cc_tr_1', title: 'Release' } });
    expect(p.review[0]).toMatchObject({ outcome: 'create', upload: true });
    expect(p.uploads).toEqual([{ rid: RID_L, address: 't.logo_big', name: 'logo.png', size: 412_000 }]);
    expect(p.parts.find(x => x.step === 'create')!.text).toContain("t.files.add(FileResource, id := 'logo_big', name := 'logo.png')");
    expect(p.preamble).toContain('// Upload afterwards: t.logo_big (logo.png, 412 KB)');
    // The log entry lists it.
    const log = p.parts.find(x => x.step === 'record')!.text;
    expect(log).toContain('Upload afterwards:\\nt.logo_big (logo.png, 412 KB)');
  });

  it('one the target has: its content is not compared, the Check and the report read it without content, other values follow the rules', () => {
    const probe = buildProbe([big({ isNew: false })]);
    const same = assemblePatch([big({ isNew: false })], answerOf(probe, { 't.logo_big': "\nt.logo_big.change(id := 'logo_big', name := 'logo.png') //FileResource\n", 't.files': '' }));
    expect(same.review[0]).toMatchObject({ outcome: 'same', contentNotCompared: true });
    expect(same.uploads).toEqual([]);
    const renamed = assemblePatch([big({ isNew: false })], answerOf(probe, { 't.logo_big': "\nt.logo_big.change(id := 'logo_big', name := 'old.png') //FileResource\n", 't.files': '' }));
    expect(renamed.review[0]).toMatchObject({ outcome: 'change', contentNotCompared: true });
    const check = renamed.parts.find(x => x.step === 'check')!.text;
    expect(check).toContain('_g := str(_o.genedit(id, name))');
    expect(renamed.parts.find(x => x.step === 'set')!.text).toContain("t.logo_big.change(name := 'logo.png')");
    expect(renamed.text).not.toContain('content :=');
  });

  it('the log entry text: the files to upload first', () => {
    expect(transportSummary({ review: [], leftOut: [], uploads: [{ rid: '1', address: 't.a', name: 'a.png', size: 2_500 }] })).toBe('Added 0, changed 0, moved 0, deleted 0, ID changed 0, the same 0, left out 0.\nUpload afterwards:\nt.a (a.png, 3 KB)');
  });
});
