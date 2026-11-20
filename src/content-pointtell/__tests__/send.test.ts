import { describe, expect, it } from 'vitest';
import { DRAWN_HINT, LOST, NOT_LISTENING, SENT, SENT_NO_CHAT, correctsOf, outcomeToast, pushSketch, pushedPicture, sendKey } from '../send';

describe('pushedPicture', () => {
  const pic = { mime: 'image/png' as const, data: 'iVBORw0KGgo=' };
  it('a screenshot goes as it is; the drawn picture says it is drawn', () => {
    expect(pushedPicture(pic, pic)).toEqual(pic);
    expect(pushedPicture(null, pic)).toEqual({ ...pic, drawn: true });
    expect(pushedPicture(null, null)).toBeNull();
  });
});

describe('outcomeToast', () => {
  it('says Sent to Claude Desktop on success', () => {
    expect(outcomeToast({ ok: true, port: 47615, number: 1, picture: false, queued: 0, agent: 'waiting' })).toEqual({ text: SENT, type: 'success' });
    expect(SENT).toBe('Sent to Claude Desktop.');
  });

  it('offers the working chat when no chat has asked for sketches', () => {
    expect(outcomeToast({ ok: true, port: 47615, number: 1, picture: true, queued: 1, agent: 'none' })).toEqual({ text: SENT_NO_CHAT, type: 'success', chat: true });
  });

  it('trusts the status asked after the send over the acknowledgement: a chat that stopped is no chat', () => {
    const ok = { ok: true as const, port: 47615, number: 1, picture: true, queued: 1, agent: 'recent' as const };
    expect(outcomeToast(ok, false, false, false)).toEqual({ text: SENT_NO_CHAT, type: 'success', chat: true });
    expect(outcomeToast({ ...ok, agent: 'none' }, false, false, true)).toEqual({ text: SENT, type: 'success' });
    expect(SENT_NO_CHAT).toBe('Sent. No chat is taking sketches yet.');
  });

  it('says plainly when the sketch went out and nothing confirmed it', () => {
    expect(outcomeToast({ ok: false, reason: 'lost', error: 'No answer.' })).toEqual({ text: LOST, type: 'error' });
  });

  it('says once that the picture was drawn, not captured', () => {
    const ok = { ok: true as const, port: 47615, number: 2, picture: true, queued: 0, agent: 'recent' as const };
    expect(outcomeToast(ok, true, true).text).toBe(`${SENT} ${DRAWN_HINT}`);
    expect(outcomeToast(ok, true, false).text).toBe(SENT);
    expect(outcomeToast(ok, false, true).text).toBe(SENT);
  });

  it('points to the set-up page and to Copy for AI when nothing answers, with the link', () => {
    expect(outcomeToast({ ok: false, reason: 'none' })).toEqual({ text: NOT_LISTENING, type: 'error', link: true });
    expect(outcomeToast(undefined)).toMatchObject({ text: NOT_LISTENING, link: true });
    expect(NOT_LISTENING).toBe('Claude Desktop did not answer. Open it, or set up its extension. Copy for AI works without.');
  });

  it('gives the listener\'s reason when it answered and kept nothing', () => {
    const out = outcomeToast({ ok: false, reason: 'refused', error: 'The text is larger than 64 KB.' });
    expect(out.type).toBe('error');
    expect(out.text).toContain('larger than 64 KB');
    expect(out.link).toBeUndefined();
  });
});

describe('pushSketch: a stopped worker does not make a second sketch', () => {
  it('asks again with the same key, marked as a retry, when the worker gave no answer', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const ok = { type: 'POINT_TELL_SEND_DATA' as const, result: { ok: true as const, port: 1, number: 5, picture: false, queued: 0, agent: 'waiting' as const } };
    const r = await pushSketch({ text: 'brief' }, async (m) => { asked.push(m); return asked.length === 1 ? undefined : ok; });
    expect(r).toMatchObject({ ok: true, number: 5 });
    expect(asked).toHaveLength(2);
    expect(asked[1]!.key).toBe(asked[0]!.key);
    expect(asked[0]!.retry).toBeUndefined();
    expect(asked[1]!.retry).toBe(true);
    expect(asked[1]!.since).toBe(asked[0]!.since);
  });

  it('a new key for every press of Send', () => {
    const a = sendKey(), b = sendKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it('corrections name the sketch they correct by id when known, with its mark numbers', () => {
    const sent = (sketch: number, k: number, id?: string) => ({ sketch, at: 1, k, sig: 'x', ...(id ? { id } : {}) });
    expect(correctsOf([
      { n: 1, text: '', targets: [], at: 1, sent: sent(3, 2, 'a3') },
      { n: 2, text: '', targets: [], at: 1, sent: sent(3, 1, 'a3') },
      { n: 3, text: '', targets: [], at: 1, sent: sent(1, 1) },
      { n: 4, text: '', targets: [], at: 1 },
    ])).toEqual([{ number: 1, marks: [1] }, { id: 'a3', number: 3, marks: [2, 1] }]);
  });
});