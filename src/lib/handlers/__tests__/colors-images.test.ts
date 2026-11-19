/**
 * The Colors and images handlers: the write is previewed on the server and
 * written only when the preview raises no warning, from this server's page
 * only; the image list is read once and kept until asked again; file bytes
 * come from the download, a few at a time.
 */
import { describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../types';
import { FILE_FIELD, FILE_ROW } from '../../colors-images/image-files';

const ENV = 'p1@https://bmp.example.test/Work/';

type Exec = (code: string, rid: string | undefined, transactional: boolean) => Promise<Record<string, unknown>>;

async function harness(exec: Exec, extra: Record<string, unknown> = {}) {
  vi.resetModules();
  const logged: unknown[][] = [];
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
    } },
  });
  const client = { serverUrl: 'https://bmp.example.test/Work/', executeEc: vi.fn(exec), ...extra };
  const ctx = { profileId: 'p1', client, settings: { activeProfileId: 'p1', profiles: [{ id: 'p1', label: 'Work' }] }, logActivity: (...a: unknown[]) => { logged.push(a); }, toast: vi.fn() };
  const { setSwContext } = await import('../../sw-context');
  setSwContext(ctx as never);
  await import('../colors-images');
  const { getHandler } = await import('../../handler-registry');
  return {
    client, logged, ctx,
    handle: (msg: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
      void getHandler(msg.type as string)!(msg as never, (r: InspectorMessage) => resolve(r as never), { ctx: ctx as never, senderKind: 'extension', isOneShot: true });
    }),
  };
}

const ok = async () => ({ ok: true, log: '' });

describe('COLORS_IMAGES_WRITE', () => {
  it('previews the script, then writes it, and says how many changes', async () => {
    const h = await harness(ok);
    const colors = [{ kind: 'change', id: 'swi_blue', hex: '#1A56A0' }];
    expect(await h.handle({ type: 'COLORS_IMAGES_WRITE', environment: ENV, colors })).toEqual({ type: 'COLORS_IMAGES_WRITE_RESULT', ok: true, written: 1 });
    expect(h.client.executeEc.mock.calls.map(c => c[2])).toEqual([false, true]);
    expect(h.client.executeEc.mock.calls[0][0]).toBe('t.swi_blue.change(color := "#1A56A0")');
    expect(h.client.executeEc.mock.calls[1][0]).toBe(h.client.executeEc.mock.calls[0][0]);
  });

  it('writes nothing when the preview warns that BMP would skip a value', async () => {
    const h = await harness(async (_c, _r, transactional) => (transactional ? { ok: true } : {
      ok: true, hasWarning: true, outputEntries: [{ logType: 'WARNING', message: 'Missing value for .swi_blue at line 1' }],
    }));
    const r = await h.handle({ type: 'COLORS_IMAGES_WRITE', environment: ENV, colors: [{ kind: 'change', id: 'swi_blue', hex: '#1A56A0' }] });
    expect(r).toMatchObject({ ok: false, written: 0 });
    expect(String(r.error)).toContain('Missing value for .swi_blue');
    expect(h.client.executeEc).toHaveBeenCalledTimes(1);
  });

  it('refuses a request for another server, and what is not an ID, a color or base64', async () => {
    const h = await harness(ok);
    expect(await h.handle({ type: 'COLORS_IMAGES_WRITE', environment: 'p9@https://other/', colors: [{ kind: 'change', id: 'a', hex: '#fff' }] })).toMatchObject({ ok: false });
    expect(await h.handle({ type: 'COLORS_IMAGES_WRITE', environment: ENV, colors: [{ kind: 'change', id: 'a); x(', hex: '#fff' }] })).toMatchObject({ ok: false });
    expect(await h.handle({ type: 'COLORS_IMAGES_WRITE', environment: ENV, files: [{ kind: 'add', folderId: 'f', id: 'a', name: 'a.png', mime: 'image/png', base64: '"' }] })).toMatchObject({ ok: false });
    expect(h.client.executeEc).not.toHaveBeenCalled();
  });

  it('writes each file as its own script and stops at the first that fails, saying how far it got', async () => {
    let n = 0;
    const h = await harness(async (_c, _r, transactional) => (transactional && ++n === 2 ? { ok: false, error: 'Duplicate ID icon_b' } : { ok: true }));
    const files = ['a', 'b', 'c'].map(x => ({ kind: 'add', folderId: 'folder_icons', id: `icon_${x}`, name: `${x}.png`, mime: 'image/png', base64: 'AAAA' }));
    const r = await h.handle({ type: 'COLORS_IMAGES_WRITE', environment: ENV, files });
    expect(r).toMatchObject({ ok: false, written: 1 });
    expect(String(r.error)).toContain('b.png');
    // Previewed and written: a, then b (failed); c never started.
    expect(h.client.executeEc.mock.calls.filter(c => c[2]).length).toBe(2);
  });

  it('is for extension pages only', async () => {
    const { MESSAGE_ACCESS } = await import('../../message-access');
    expect(MESSAGE_ACCESS.COLORS_IMAGES_WRITE).toEqual([]);
    expect(MESSAGE_ACCESS.OPEN_COLORS_IMAGES).toEqual(['frame']);
  });
});

describe('IMAGE_INDEX', () => {
  const F = FILE_FIELD, R = FILE_ROW;
  const log = `K${F}icons${F}Icons${F}EXTERNALRESOURCE${R}I${F}1524126395561369203${F}icon_erm${F}erm.png${F}icons${R}I${F}2${F}lib${F}lib.js${F}icons${R}D${F}2${R}`;

  it('reads folders and image files once, keeps them, and reads again only when asked', async () => {
    const h = await harness(async () => ({ ok: true, log }));
    const first = await h.handle({ type: 'IMAGE_INDEX' });
    expect(first).toMatchObject({ type: 'IMAGE_INDEX_DATA', ok: true, environment: ENV, files: [{ rid: '1524126395561369203', id: 'icon_erm', name: 'erm.png', folderId: 'icons' }] });
    expect(typeof first.fetchedAt).toBe('number');
    await h.handle({ type: 'IMAGE_INDEX' });
    expect(h.client.executeEc).toHaveBeenCalledTimes(1);
    await h.handle({ type: 'IMAGE_INDEX', force: true });
    expect(h.client.executeEc).toHaveBeenCalledTimes(2);
  });

  it('keeps the earlier copy, marked with the error, when a read fails', async () => {
    let fail = false;
    const h = await harness(async () => (fail ? { ok: false, error: 'time-out' } : { ok: true, log }));
    await h.handle({ type: 'IMAGE_INDEX' });
    fail = true;
    expect(await h.handle({ type: 'IMAGE_INDEX', force: true })).toMatchObject({ ok: true, error: 'time-out', files: [{ id: 'icon_erm' }] });
  });

  it('says so when there is nothing yet and the read fails', async () => {
    const h = await harness(async () => ({ ok: false, error: 'No connection' }));
    expect(await h.handle({ type: 'IMAGE_INDEX' })).toMatchObject({ ok: false, error: 'No connection' });
  });
});

describe('IMAGE_BYTES', () => {
  it('reads the bytes of the files asked for, as base64, a few at a time', async () => {
    let live = 0, peak = 0;
    const download = vi.fn(async (rid: string) => {
      live += 1; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5));
      live -= 1;
      return rid === '3' ? { ok: false, error: 'The file is too large to show.' } : { ok: true, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
    });
    const h = await harness(ok, { downloadResourceBytes: download });
    const rids = ['1', '2', '3', '4', '5', '6', '7', '8', 'x', '1'];
    const r = await h.handle({ type: 'IMAGE_BYTES', rids }) as { items: Array<Record<string, unknown>> };
    expect(r.items.map(i => i.rid)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(r.items[0]).toEqual({ rid: '1', base64: 'AQID', mime: 'image/png' });
    expect(r.items[2]).toEqual({ rid: '3', error: 'The file is too large to show.' });
    expect(peak).toBeLessThanOrEqual(4);
    expect(download).toHaveBeenCalledTimes(8);
  });
});
