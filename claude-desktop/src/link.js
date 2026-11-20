/**
 * The socket the browser extension talks to (PROTOCOL.md). Loopback only: the extension opens a socket, gets the
 * hello, sends one message, reads the answer and closes. Briefs and pictures are never sent back.
 */
import { WebSocketServer } from 'ws';
import {
  DEFAULT_PORT, PORT_COUNT, MAX_MESSAGE_BYTES, MAX_TEXT_BYTES, MAX_PICTURE_BYTES, MAX_PAGE_CHARS, MAX_PAGEKEY_CHARS, MAX_HANDOVER_CHARS, MAX_KEY_CHARS,
  EXTENSION_VERSION, ack, extensionIdOf, hello, hostAllowed, originAllowed, parseMessage, statusMessage,
} from './protocol.js';
import { MAX_CONFIG_BYTES } from './config.js';

export const MAX_CLIENTS = 8;
/** A socket that sends nothing for this long is closed: the browser needs a second or two per message. */
export const IDLE_MS = 20_000;

/**
 * Listen on the first free port of the range. Resolves { port, close }.
 * @param {object} o.facts  () => { wait } for the hello and the status: what this copy's chat client gets now
 */
export async function startLink(store, { basePort = DEFAULT_PORT, count = PORT_COUNT, onPush = () => {}, facts = () => ({}), idleMs = IDLE_MS, log = () => {} } = {}) {
  for (let i = 0; i < count; i++) {
    const port = basePort === 0 ? 0 : basePort + i;
    try { return await listen(store, port, { onPush, facts, idleMs, log }); }
    catch (e) { if (e?.code !== 'EADDRINUSE' || basePort === 0) throw e; }
  }
  throw new Error(`No free port from ${basePort} to ${basePort + count - 1}.`);
}

function listen(store, requestedPort, { onPush, facts, idleMs, log }) {
  const origins = () => { try { return store.settings.get().config.origins; } catch { return []; } };
  return new Promise((resolve, reject) => {
    let boundPort = requestedPort;
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: requestedPort,
      maxPayload: MAX_MESSAGE_BYTES,
      verifyClient: ({ origin, req }) => originAllowed(origin, origins()) && hostAllowed(req.headers.host, boundPort),
    });
    const sockets = []; // valid sockets only, oldest first
    wss.once('error', reject);
    wss.once('listening', () => {
      boundPort = wss.address().port;
      wss.off('error', reject);
      wss.on('error', () => {});
      wss.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        sockets.push(ws);
        while (sockets.length > MAX_CLIENTS) { const old = sockets.shift(); try { old.terminate(); } catch { /* gone */ } }
        let idle = null;
        const arm = () => { clearTimeout(idle); idle = setTimeout(() => { try { ws.close(1000, 'idle'); } catch { /* gone */ } setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000).unref?.(); }, idleMs); idle.unref?.(); };
        const drop = () => { clearTimeout(idle); const i = sockets.indexOf(ws); if (i >= 0) sockets.splice(i, 1); };
        ws.on('close', drop);
        ws.on('error', drop);
        arm();
        const send = (data) => { try { ws.send(data); } catch { /* closed */ } };
        send(helloFor(store, facts));
        ws.on('message', (data, isBinary) => {
          arm();
          try {
            if (isBinary) { send(ack({ ok: false, error: 'Binary messages are not accepted.' })); return; }
            send(answer(store, data.toString('utf8'), { origin, onPush, facts }));
          } catch (e) {
            log(`link: ${e?.stack ?? e}\n`);
            send(ack({ ok: false, error: `Companion for Claude Desktop could not handle the message: ${e?.message ?? e}` }));
          }
        });
      });
      resolve({
        port: boundPort,
        close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
      });
    });
  });
}

export function helloFor(store, facts) {
  let session = null, configRev = 0, cfg = null;
  try { session = store.session(); } catch { /* none */ }
  try { const s = store.settings.get(); configRev = s.rev; cfg = s.config; } catch { /* defaults */ }
  return hello({
    limits: {
      text: MAX_TEXT_BYTES, picture: MAX_PICTURE_BYTES, page: MAX_PAGE_CHARS, pageKey: MAX_PAGEKEY_CHARS, handover: MAX_HANDOVER_CHARS, key: MAX_KEY_CHARS,
      reply: cfg?.limits?.replyChars ?? 4000, config: MAX_CONFIG_BYTES, keep: cfg?.limits?.keep ?? 30,
    },
    session, wait: facts().wait ?? null, configRev,
  });
}

/** The answer to one message, as the text frame to send. */
export function answer(store, raw, { origin = null, onPush = () => {}, facts = () => ({}) } = {}) {
  const res = parseMessage(raw);
  const tag = res.tag !== undefined ? { ref: res.tag } : {};
  if (!res.ok) return ack({ ok: false, error: res.error, ...(res.unknown ? { unknown: true, got: res.got } : {}), ...tag });
  if (res.type === 'status') {
    const s = store.status();
    const set = store.settings.get();
    return statusMessage({ ...s, version: EXTENSION_VERSION, configRev: set.rev, now: new Date().toISOString(), wait: facts().wait ?? null, ...(set.error ? { configError: set.error } : {}), ...tag });
  }
  if (res.type === 'sketch') {
    let r;
    try { r = store.add(res.sketch); }
    catch (e) { return ack({ ok: false, error: e?.code === 'FULL' || e?.code === 'READONLY' ? e.message : `The sketch could not be saved: ${e?.message ?? e}`, ...tag }); }
    if (!r.duplicate) { try { onPush(r.sketch); } catch { /* a log line only */ } }
    const status = store.status();
    return ack({
      ok: true, id: r.sketch.id, number: r.sketch.number, kept: status.sketches.length, picture: !!r.sketch.picture,
      queued: status.sketches.filter(x => x.state === 'queued').length, agent: status.agent, session: status.session,
      ...(r.duplicate ? { duplicate: true } : {}), ...tag,
    });
  }
  if (res.type === 'requeue' || res.type === 'withdraw') {
    try { return ack({ ...store[res.type](res.ref), ...tag }); }
    catch (e) { return ack({ ok: false, error: e?.message ?? String(e), ...tag }); }
  }
  if (res.type === 'config') {
    const by = extensionIdOf(origin) ?? '';
    const cur = store.settings.get();
    if (res.config && Array.isArray(res.config.origins) && res.config.origins.length && !res.config.origins.includes(by)) {
      return ack({ ok: false, error: 'The settings would shut out the extension that sends them: put its id in origins.', rev: cur.rev, ...tag });
    }
    let r;
    try { r = store.settings.apply(res.rev, res.config, by); }
    catch (e) { return ack({ ok: false, error: `The settings could not be saved: ${e?.message ?? e}`, rev: cur.rev, ...tag }); }
    return ack({ ...r, ...tag });
  }
  return ack({ ok: false, unknown: true, got: res.type, error: 'Unknown message type.', ...tag });
}
