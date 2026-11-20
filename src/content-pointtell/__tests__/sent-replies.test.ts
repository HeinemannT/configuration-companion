// @vitest-environment happy-dom
/**
 * What came back: the first look counts unread replies as just arrived, later looks only what is newer; an answer
 * given in place is named in the list, and the question it answers waits as "Answered".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/messaging', () => ({ sendRequest: vi.fn(async () => undefined), sendFireForget: vi.fn() }));

import type { SketchRow } from '../../lib/claude-link';

const T0 = Date.now();
const row = (number: number, state: SketchRow['state'], rev: number, reply?: string): SketchRow => ({
  number, at: new Date(T0 + number).toISOString(), page: 'Home', pageKey: 'k', state, rev, ...(reply ? { reply: { text: reply, at: new Date(T0).toISOString() } } : {}),
});
const status = (sketches: SketchRow[]) => ({ ok: true as const, port: 1, rev: 1, agent: 'none' as const, sketches });

async function load() {
  vi.resetModules();
  const sent = await import('../sent');
  const view = await import('../sent-view');
  const { pt } = await import('../state');
  return { ...sent, ...view, pt };
}

beforeEach(() => { sessionStorage.clear(); document.body.innerHTML = ''; });

describe('replies that came back', () => {
  it('the first look brings the unread ones, later looks only what changed', async () => {
    const { applyStatus } = await load();
    expect(applyStatus(status([row(1, 'done', 10, 'ok'), row(2, 'queued', 11)]), { 1: 10 }).map(r => r.number)).toEqual([]);
    expect(applyStatus(status([row(1, 'done', 10, 'ok'), row(2, 'question', 20, 'Which?')]), {}).map(r => r.number)).toEqual([2]);
    expect(applyStatus(status([row(1, 'done', 10, 'ok'), row(2, 'question', 20, 'Which?')]), {})).toEqual([]);
    expect(applyStatus({ ok: false }, {})).toEqual([]);
  });

  it('the list names an answer and shows its question as answered', async () => {
    const m = await load();
    m.applyStatus(status([row(4, 'question', 20, 'Which tab?'), row(5, 'queued', 21)]), {});
    m.rememberAnswer(5, 4, T0 + 5);
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    m.pt.layer = layer; m.pt.active = true; m.pt.sentOpen = true;
    m.renderSent();
    const rows = [...layer.querySelectorAll('.pt-sent-row')].map(r => (r as HTMLElement).textContent);
    expect(rows[0]).toContain('Answer to 4');
    expect(rows[1]).toContain('Answered');
    expect(rows[1]).toContain('Which tab?');
  });
});
