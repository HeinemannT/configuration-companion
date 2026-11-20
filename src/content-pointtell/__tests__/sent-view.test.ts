/**
 * @vitest-environment happy-dom
 *
 * The sent list's bar: the way to the Claude Desktop page, and Start working chat unless a chat already waits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pt } from '../state';
import { sent } from '../sent';
import { renderSent } from '../sent-view';

const sendMessage = vi.fn(async () => undefined);

beforeEach(() => {
  sendMessage.mockClear();
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage } };
  document.body.innerHTML = '';
  const layer = document.createElement('div');
  document.body.appendChild(layer);
  pt.layer = layer;
  pt.sentOpen = true;
  sent.rows = [{ number: 1, at: new Date().toISOString(), page: 'Risks', pageKey: 'k', state: 'queued', rev: 1 }];
  sent.reachable = true;
  sent.listed = true;
  sent.facts = { agent: 'none' };
});

const bar = () => pt.sentEl!.querySelector('.pt-sent-bar')!;

describe('the sent list bar', () => {
  it('offers Start working chat when no chat waits, and Set up', () => {
    renderSent();
    expect(bar().querySelector('.pt-sent-start')?.textContent).toBe('Start working chat');
    expect(bar().querySelector('.pt-sent-waiting')).toBeNull();
    expect(bar().querySelector('.pt-sent-setup')?.textContent).toBe('Set up');
  });

  it('says Claude is taking sketches instead of the button when a chat waits', () => {
    sent.facts = { agent: 'waiting' };
    renderSent();
    expect(bar().querySelector('.pt-sent-start')).toBeNull();
    expect(bar().querySelector('.pt-sent-waiting')?.textContent).toBe('Claude is taking sketches');
  });

  it('opens the Claude Desktop page from Set up', () => {
    renderSent();
    (bar().querySelector('.pt-sent-setup') as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'OPEN_CLAUDE_SETUP' });
  });
});
