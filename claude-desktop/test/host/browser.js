/**
 * A browser extension that speaks the link protocol the way Configuration Companion does: open a socket, wait for
 * the hello, send one message, read the answer, close. `shape: 'old'` sends exactly what 0.19.1 to the feat/0.18
 * browsers sent before 0.3.0 (sketch with text, page, pageKey, picture{mime,data,drawn}; status), and reads only the
 * fields they read.
 */
import WebSocket from 'ws';

export const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
export const LINK_APP = 'configuration-companion-link';

/** One conversation on one port. Resolves { hello, answer } or { none: true } when nothing (or not Companion) answers. */
export function converse(port, message, { origin = ORIGIN, helloMs = 800, ackMs = 4000, dropBeforeAnswer = false, headers } = {}) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin, headers }); } catch { resolve({ none: true }); return; }
    let hello = null, settled = false, timer;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.terminate(); } catch { /* closed */ } resolve(v); };
    timer = setTimeout(() => finish({ none: true }), helloMs);
    ws.on('error', (e) => finish(hello ? { hello, error: String(e.message) } : { none: true, error: String(e.message) }));
    ws.on('close', (code) => finish(hello ? { hello, closed: code } : { none: true, closed: code }));
    ws.on('message', (d) => {
      let msg;
      try { msg = JSON.parse(String(d)); } catch { finish({ none: true }); return; }
      if (!hello) {
        if (msg.type !== 'hello' || msg.app !== LINK_APP || msg.v !== 1) { finish({ none: true }); return; }
        hello = msg;
        clearTimeout(timer);
        timer = setTimeout(() => finish({ hello, timeout: true }), ackMs);
        ws.send(JSON.stringify({ v: 1, ...message }));
        if (dropBeforeAnswer) setTimeout(() => finish({ hello, dropped: true }), 0);
        return;
      }
      finish({ hello, answer: msg });
    });
  });
}

let keySeq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(++keySeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class ScriptedBrowser {
  constructor({ ports, shape = 'new', origin = ORIGIN } = {}) {
    this.ports = Array.from({ length: ports[1] - ports[0] + 1 }, (_, i) => ports[0] + i);
    this.shape = shape;
    this.origin = origin;
    this.preferred = null;
    this.hello = null;
  }

  /** Try the ports in order (the one that answered before first), like the extension. */
  async first(message, opts = {}) {
    const order = this.preferred ? [this.preferred, ...this.ports.filter(p => p !== this.preferred)] : this.ports;
    for (const port of order) {
      const r = await converse(port, message, { origin: this.origin, ...opts });
      if (r.none) continue;
      this.preferred = port;
      this.hello = r.hello;
      return { port, ...r };
    }
    return { none: true };
  }

  /** Ask every port; for the copies-agree check. */
  async statusAll() {
    const out = [];
    for (const port of this.ports) {
      const r = await converse(port, { type: 'status' }, { origin: this.origin });
      if (r.answer?.type === 'status') out.push({ port, status: r.answer });
    }
    return out;
  }

  /** Push a sketch. New shape adds a key unless `key: null`. Old shape sends only the 0.2.x fields. */
  async push({ text, page = 'Page', pageKey = '', picture, key, follows, handover, drop = false } = {}) {
    const msg = { type: 'sketch', text, page, pageKey, ...(picture ? { picture } : {}) };
    if (this.shape === 'new') {
      const k = key === undefined ? newKey() : key;
      if (k) msg.key = k;
      if (follows) msg.follows = follows;
      if (handover) msg.handover = handover;
    }
    const r = await this.first(msg, { dropBeforeAnswer: drop });
    if (r.none) return { none: true };
    if (r.dropped) return { dropped: true, key: msg.key };
    const a = r.answer;
    if (!a) return { lost: true, key: msg.key };
    if (a.type !== 'ack') return { refused: true, error: 'Not an acknowledgement.', key: msg.key };
    if (a.ok !== true) return { refused: true, error: a.error, key: msg.key };
    // What an old browser reads: number, picture, queued, agent. A new one also reads id and duplicate.
    return this.shape === 'old'
      ? { ok: true, number: Number(a.number) || 0, picture: a.picture === true, queued: Number(a.queued) || 0, agent: a.agent, key: msg.key, id: a.id }
      : { ok: true, id: a.id, number: a.number, duplicate: a.duplicate === true, queued: a.queued, agent: a.agent, key: msg.key, session: a.session };
  }

  async status() {
    const r = await this.first({ type: 'status' });
    if (r.none || r.answer?.type !== 'status') return null;
    return { port: r.port, ...r.answer };
  }
  async send(message) { const r = await this.first(message); return r.answer ?? null; }
  requeue(ref) { return this.send({ type: 'requeue', ...(typeof ref === 'number' ? { number: ref } : { id: ref }) }); }
  withdraw(ref) { return this.send({ type: 'withdraw', ...(typeof ref === 'number' ? { number: ref } : { id: ref }) }); }
  config(rev, config) { return this.send({ type: 'config', rev, config }); }
}
