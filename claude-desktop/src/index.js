/**
 * Entry of the desktop extension: Claude Desktop starts this with its own Node and talks to it over stdio.
 * The same process listens on loopback for sketches from the browser extension. stdout belongs to the MCP
 * protocol, so anything written for a person goes to stderr.
 *
 * Environment (the manifest's user_config fills the first two; the rest are for tests):
 *   COMPANION_FOLDER        the sessions folder
 *   COMPANION_WAIT_SECONDS  a hand-set wait for next_sketch; 0 or empty: by the settings
 *   COMPANION_PORT          one fixed port; COMPANION_PORTS "47700-47704" a range
 *   COMPANION_DEBUG         a file that records what the client sent with next_sketch
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startLink } from './link.js';
import { createMcp } from './mcp.js';
import { cleanOld, createSession, defaultBase } from './session.js';
import { configStore, configuredWait, learnedWaits } from './config.js';
import { EXTENSION_VERSION } from './protocol.js';

const log = (line) => { try { process.stderr.write(line); } catch { /* no stderr */ } };

// One bad write or a stray rejection must not end the server: Claude Desktop would show the extension as failed.
process.on('uncaughtException', (e) => {
  if (e?.code === 'EPIPE' || e?.code === 'ERR_STREAM_DESTROYED') process.exit(0); // the host has gone
  log(`Configuration Companion: ${e?.stack ?? e}\n`);
});
process.on('unhandledRejection', (e) => { log(`Configuration Companion: ${e?.stack ?? e}\n`); });

/** A number from the environment, or null. An unfilled manifest placeholder counts as not set. */
function envNumber(name) {
  const v = String(process.env[name] ?? '').trim();
  if (!v || v.includes('${')) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ports() {
  const range = /^(\d+)-(\d+)$/.exec(String(process.env.COMPANION_PORTS ?? '').trim());
  if (range && Number(range[2]) >= Number(range[1])) return { basePort: Number(range[1]), count: Number(range[2]) - Number(range[1]) + 1 };
  const only = envNumber('COMPANION_PORT');
  return only ? { basePort: only, count: 1 } : {};
}

async function main() {
  const base = defaultBase();
  const settings = configStore(base, { log });
  try { cleanOld(base, settings.get().config.limits.keepDays); } catch { /* clean-up is best effort */ }
  // COMPANION_LEARN_SCALE shrinks the learning times so a test can see waits adapt in seconds; people never set it.
  const scale = Math.min(1, envNumber('COMPANION_LEARN_SCALE') ?? 1);
  const learned = learnedWaits(base, { minCutMs: 20_000 * scale, marginMs: 15_000 * scale, floorMs: 15_000 * scale, nearMs: 5_000 * scale });
  const handSet = envNumber('COMPANION_WAIT_SECONDS');
  /** ms the next_sketch wait is set to for a client, before learning. */
  const configuredMs = (name) => Math.round((handSet ?? configuredWait(settings.get().config, name)) * 1000);
  const waitFor = (name) => {
    const c = configuredMs(name);
    const l = learned.get(name, c);
    return l !== null ? Math.min(c, l) : c;
  };
  const onCut = (name, elapsed, why) => {
    const c = configuredMs(name);
    const changed = learned.cut(name, elapsed, c, waitFor(name));
    log(`Configuration Companion: a wait of client ${name || '?'} ended by ${why} after ${Math.round(elapsed / 1000)} s${changed ? `; it now waits ${Math.round(changed / 1000)} s` : ''}\n`);
  };
  const store = createSession({ base, config: settings, waitBeatMs: Math.max(100, 1000 * scale), onDeadWait: (name, elapsed) => onCut(name, elapsed, 'a closed copy') });
  const mcp = createMcp(store, { waitFor, onCut, log });
  const clientName = () => mcp.server.getClientVersion()?.name ?? '';
  const facts = () => ({ wait: Math.round(waitFor(clientName()) / 1000) });

  let link = null;
  try {
    link = await startLink(store, { ...ports(), facts, log });
    log(`Configuration Companion ${EXTENSION_VERSION} link listening on 127.0.0.1:${link.port}, folder ${base}\n`);
  } catch (e) {
    // Claude still gets its tools; another copy may hold the port, and the folder is shared.
    log(`Configuration Companion link is not listening: ${e?.message ?? e}\n`);
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try { store.close(); } catch { /* exiting */ }
    void (link ? link.close() : Promise.resolve()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await mcp.connect(new StdioServerTransport());
}

main().catch((e) => { log(`${e?.stack ?? e}\n`); process.exit(1); });
