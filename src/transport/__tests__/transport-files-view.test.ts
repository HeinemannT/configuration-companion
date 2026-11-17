// @vitest-environment happy-dom
/**
 * Files in the Transport window: the Files option (visible before a
 * comparison, kept with the draft, the limit sent with the read), the needs
 * line with the files to upload, the row's content line and tags, the map,
 * the confirmation before Apply and the outcome after it.
 */
import { describe, expect, it } from 'vitest';
import { CHECK_READY_LINE } from '../../lib/transport-patch';
import type { InspectorMessage } from '../../lib/types';
import { CHOICE_ANY, TransportController } from '../transport-controller';
import { draftKey } from '../transport-collection';
import { FILES_OFF_HELP, FILES_ON_HELP, mountTransportView } from '../transport-view';
import { ENV, fakeWorker, flush, memoryStore, objectsResult, probeAnswer, readOk, row, scanResult, type Sent } from './fakes';

const TARGET_ENV = 'p2@https://bmp.example.test/Test/';

function setup() {
  const big = row({ id: 'logo_big', name: 'logo.png', className: 'FileResource' });
  const small = row({ id: 'icon', name: 'icon.svg', className: 'FileResource' });
  // With file content off (fileLimit 0) a file is read with its values only, not measured.
  const read = (rid: string, limit: number) => (limit === 0
    ? readOk(rid, rid === big.rid ? 'logo_big' : 'icon', { className: 'FileResource', genedit: rid === big.rid ? "t.logo_big.change(id := 'logo_big', name := 'logo.png') //FileResource" : "t.icon.change(id := 'icon', name := 'icon.svg') //FileResource", generate: undefined, isFile: true, contentCarried: false })
    : rid === big.rid
    ? readOk(rid, 'logo_big', { className: 'FileResource', genedit: "t.logo_big.change(id := 'logo_big', name := 'logo.png') //FileResource", generate: undefined, fileSize: 412_000, contentCarried: false })
    : readOk(rid, 'icon', { className: 'FileResource', genedit: "t.icon.change(id := 'icon', name := 'icon.svg', content := 'icon.svg;image/svg+xml;H4s') //FileResource", fileSize: 3_000, contentCarried: true }));
  const store = memoryStore();
  let applied = false;
  const w = fakeWorker();
  w.targets = [{ environment: TARGET_ENV, label: 'Test', host: 'bmp.example.test' }];
  const ctl = new TransportController({ ...w.deps, store }, { since: '2026-11-08' });
  const result = (msg: Sent, over: Record<string, unknown>) => ({ type: 'TRANSPORT_PART_RESULT', requestId: msg.requestId, environment: ENV, target: msg.target, ok: true, ...over }) as InspectorMessage;
  w.answer = m => {
    if (m.type === 'TRANSPORT_READ_OBJECTS') return objectsResult(m, (m.rids as string[]).map(rid => read(rid, m.fileLimit as number)));
    if (m.type === 'TRANSPORT_RUN_PART') {
      const probe = ctl.bundle!.target!.probe;
      const part = probe.parts.find(p => p.text === m.code);
      // After the committed parts the target holds both files, without content.
      const held = applied ? {
        't.logo_big': { cls: 'FileResource', genedit: "\nt.logo_big.change(id := 'logo_big', name := 'logo.png') //FileResource\n" },
        't.icon': { cls: 'FileResource', genedit: "\nt.icon.change(id := 'icon', name := 'icon.svg') //FileResource\n" },
      } : {};
      if (!m.transactional) return result(m, { log: part ? probeAnswer(probe, { 't.page': { cls: 'Category' }, ...held }, { parts: [part.index] }) : CHECK_READY_LINE });
      applied = true;
      return result(m, { log: 'done' });
    }
    if (m.type === 'TRANSPORT_READ_CREATION') return { type: 'TRANSPORT_CREATION_RESULT', requestId: m.requestId, environment: ENV, ok: true, texts: (m.rids as string[]).map(rid => ({ rid, ok: true, generate: "t.page.add(FileResource, id := 'icon', name := 'icon.svg', content := 'x')" })) } as InspectorMessage;
    return scanResult(m, { rows: m.root === 'externalResource' ? [big, small] : [] });
  };
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  mountTransportView(host, ctl, { now: () => new Date(2026, 10, 16, 12, 0, 0) });
  const $ = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
  const $$ = <T extends Element = HTMLElement>(s: string) => [...host.querySelectorAll<T>(s)];
  return { w, ctl, store, big, small, $, $$ };
}

async function filled() {
  const s = setup();
  await s.ctl.loadTargets();
  await s.ctl.scan();
  s.ctl.setGroupTicked('externalResource', true);
  s.ctl.showTab('transport');
  return s;
}

describe('the Files option', () => {
  it('off by default: a switch with both lines under it; on, "up to n KB" (1 to 19); both kept with the draft and sent with the read', async () => {
    const { $, $$, ctl, w, store } = await filled();
    expect($('.tr-optblk > summary')!.textContent).toBe('Options');
    const sw = $<HTMLButtonElement>('.tr-filesw')!;
    expect([sw.getAttribute('role'), sw.getAttribute('aria-checked')]).toEqual(['switch', 'false']);
    expect($$('.tr-filesopt .tr-help').map(x => x.textContent)).toEqual([FILES_OFF_HELP, FILES_ON_HELP]);
    expect(FILES_OFF_HELP).toBe('Off: files are added without content. Upload them on the target afterwards.');
    expect(FILES_ON_HELP).toBe('On: reading and writing file content can be slow on the workspace and makes the scripts large.');
    expect($('.tr-filelimit')).toBeNull();
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_OBJECTS').map(m => m.fileLimit)).toEqual([0]);
    $<HTMLButtonElement>('.tr-filesw')!.click();
    expect(ctl.fileContent).toBe(true);
    const field = $<HTMLInputElement>('.tr-filelimit')!;
    expect([field.type, field.value, field.min, field.max]).toEqual(['number', '19', '1', '19']);
    expect($('.tr-filelimit-l')!.textContent).toBe('up toKB');
    field.value = '250';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    expect(ctl.fileLimitKb).toBe(19);
    $<HTMLInputElement>('.tr-filelimit')!.value = '5';
    $<HTMLInputElement>('.tr-filelimit')!.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(store.data[draftKey(ENV)]).toMatchObject({ fileLimitKb: 5, fileContent: true });
    await ctl.buildBundle();
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_OBJECTS').map(m => m.fileLimit)).toEqual([0, 5_000]);
  });
});

describe('telling the person', () => {
  it('off: every file is added without content, no size anywhere; the comment line is in the part that adds it', async () => {
    const { $, $$, ctl, big } = await filled();
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    expect($('details.tr-uploads > summary')!.textContent).toBe('2 files are added without content: upload them on the target');
    expect($$('.tr-uploads li').map(l => l.textContent).sort()).toEqual(['t.icon · icon.svg', 't.logo_big · logo.png']);
    ctl.toggleRow(big.rid);
    const content = [...$(`.tr-detail[data-rid="${big.rid}"]`)!.querySelectorAll('.tr-dsec')].find(x => x.querySelector('.tr-dsec-h')!.textContent === 'Content')!;
    expect(content.querySelector('.tr-dsec-b')!.textContent).toBe('not carried');
    const add = ctl.bundle!.result!.parts.find(x => x.step === 'create')!.text.split('\n');
    // Near the top of the part that adds the file, after its header.
    expect(add.slice(3, 5).sort()).toEqual(['// Upload afterwards: t.icon (icon.svg)', '// Upload afterwards: t.logo_big (logo.png)']);
    expect(ctl.bundle!.result!.text).not.toMatch(/\.genedit\(\)|generate\(true\)/);
  });

  it('on: the needs line lists the larger file with its size; the rows say what happens to their content; the map counts them', async () => {
    const { $, $$, ctl, big, small } = await filled();
    ctl.setFileContent(true);
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    const need = $<HTMLDetailsElement>('details.tr-uploads')!;
    expect(need.querySelector('summary')!.textContent).toBe('1 file is added without content: upload it on the target');
    expect($$('.tr-uploads li').map(l => l.textContent)).toEqual(['t.logo_big · logo.png · 412 KB']);
    expect($(`.tr-trow[data-rid="${big.rid}"] .tr-tag.file`)!.textContent).toBe('upload needed');
    expect($(`.tr-trow[data-rid="${small.rid}"] .tr-tag.file`)).toBeNull();
    ctl.toggleRow(big.rid);
    ctl.toggleRow(small.rid);
    const content = (rid: string) => [...$(`.tr-detail[data-rid="${rid}"]`)!.querySelectorAll('.tr-dsec')].find(x => x.querySelector('.tr-dsec-h')!.textContent === 'Content')!.querySelector('.tr-dsec-b')!.textContent;
    expect(content(big.rid)).toBe('not carried (412 KB, over the 19 KB limit)');
    expect(content(small.rid)).toBe('carried (3 KB)');
    ctl.setTransportView('map');
    expect($('.tr-mleft .tr-mbox .tr-mbox-c.warn')!.textContent).toBe('1 to upload');
  });

  it('the confirmation repeats the count; after Apply only the outcome line, then the files to upload', async () => {
    const { $, ctl } = await filled();
    await ctl.buildBundle();
    expect(ctl.bundle!.target!.patch!.uploads.map(u => u.address).sort()).toEqual(['t.icon', 't.logo_big']);
    ctl.requestApply();
    expect($('.tr-confirm-upload')!.textContent).toBe('2 files are added without content: upload them on Test');
    await ctl.apply();
    await flush(40);
    expect(ctl.direct!.phase.kind).toBe('done');
    expect($('.tr-outcome')!.textContent).toBe('Applied. Test matches.');
    // The summary does not say it a second time.
    expect(ctl.bundle!.target!.patch!.nothingToDo).toBe(true);
    expect($('.tr-sum')).toBeNull();
    expect($('.tr-outcome-uploads p')!.textContent).toBe('Upload these files on Test:');
    expect([...$('.tr-outcome-uploads')!.querySelectorAll('li')].map(l => l.textContent).sort()).toEqual(['t.icon (icon.svg)', 't.logo_big (logo.png)']);
  });
});
