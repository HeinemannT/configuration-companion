/**
 * A host that behaves like Claude Desktop towards an installed extension, as measured:
 * - its MCP client is named `local-agent-mode-<extension name>`;
 * - every request has the SDK's default timeout of 60 s, and progress does not extend it;
 * - when a call times out it cancels the request and kills the server process, then starts a new one;
 * - it runs one to three copies (separate managers) on one folder and starts them in the same instant;
 * - it can kill a copy at any moment, without any clean-up.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_ENTRY = join(here, '../../src/index.js');
export const BUNDLE_ENTRY = join(here, '../../build/bundle/server/index.js');
export const CLIENT_NAME = 'local-agent-mode-Configuration Companion';
export const DESKTOP_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Manager {
  constructor(host, index) {
    this.host = host;
    this.index = index;
    this.gen = 0;
    this.client = null;
    this.transport = null;
    this.pid = null;
    this.ready = null;
    this.stderr = '';
    this.alive = false;
    this.restartTimer = null;
  }

  /** Start a new server process and connect. */
  start() {
    clearTimeout(this.restartTimer);
    this.ready = (async () => {
      const gen = ++this.gen;
      const transport = new StdioClientTransport({
        command: process.execPath, args: [this.host.entry], stderr: 'pipe',
        env: { ...process.env, ...this.host.env },
      });
      const client = new Client({ name: this.host.clientName, version: '1.0.0' });
      transport.stderr?.on('data', (d) => { this.stderr = (this.stderr + d).slice(-20000); });
      client.onclose = () => { if (this.gen === gen) this.alive = false; };
      await client.connect(transport);
      this.client = client; this.transport = transport; this.pid = transport.pid; this.alive = true;
      this.host.event({ kind: 'start', manager: this.index, gen, pid: this.pid });
      return gen;
    })();
    return this.ready;
  }

  /** Kill the process at once, the way an operating system ends it: no clean-up runs. */
  kill(why = 'kill') {
    const pid = this.pid;
    const t = this.transport;
    this.alive = false;
    this.client = null; this.transport = null; this.pid = null;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { void t?.close(); } catch { /* closed */ }
    this.host.event({ kind: 'kill', manager: this.index, gen: this.gen, pid, why });
  }

  /** Kill, then start again after `delayMs`. */
  restart(why, delayMs = 0) {
    this.kill(why);
    this.ready = new Promise((resolve) => { this.restartTimer = setTimeout(() => { this.start().then(resolve, resolve); }, delayMs); });
    return this.ready;
  }

  /** A tool call as the host makes it. Resolves { result, ms } or { error: 'timeout' | 'closed' | message, ms }. */
  async call(name, args = {}) {
    try { await this.ready; } catch { /* start failed: the call fails below */ }
    const client = this.client;
    const gen = this.gen;
    const t0 = Date.now();
    if (!client) return { error: 'closed', ms: 0 };
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.host.timeoutMs });
      const ms = Date.now() - t0;
      this.host.event({ kind: 'call', manager: this.index, gen, name, ms });
      return { result, ms };
    } catch (e) {
      const ms = Date.now() - t0;
      const timeout = e?.code === -32001 || /timed out/i.test(String(e?.message));
      this.host.event({ kind: timeout ? 'timeout' : 'call-failed', manager: this.index, gen, name, ms, error: String(e?.message ?? e) });
      if (timeout && this.gen === gen) {
        // Desktop: a call that timed out ends the server; the next call goes to a new one.
        await this.restart('timeout', this.host.restartDelayMs);
      }
      return { error: timeout ? 'timeout' : String(e?.message ?? e), ms };
    }
  }

  async close() {
    clearTimeout(this.restartTimer);
    const c = this.client;
    this.client = null;
    this.alive = false;
    try { await c?.close(); } catch { /* closed */ }
  }
}

export class DesktopHost {
  /**
   * @param {object} o
   * @param {string} o.base      sessions folder (a temp folder)
   * @param {[number, number]} o.ports  port range for the copies
   * @param {number} [o.copies]  1..3
   */
  constructor({ base, ports, copies = 1, timeoutMs = DESKTOP_TIMEOUT_MS, env = {}, entry = SOURCE_ENTRY, clientName = CLIENT_NAME, restartDelayMs = 300 } = {}) {
    this.base = base;
    this.ports = ports;
    this.timeoutMs = timeoutMs;
    this.entry = entry;
    this.clientName = clientName;
    this.restartDelayMs = restartDelayMs;
    this.env = { COMPANION_FOLDER: base, COMPANION_PORTS: `${ports[0]}-${ports[1]}`, ...env };
    this.managers = Array.from({ length: copies }, (_, i) => new Manager(this, i));
    this.events = [];
    this.listeners = [];
  }
  event(e) { const x = { at: Date.now(), ...e }; this.events.push(x); for (const l of this.listeners) l(x); }
  on(fn) { this.listeners.push(fn); }
  /** All copies in the same instant, as Desktop does. */
  startAll() { return Promise.all(this.managers.map(m => m.start())); }
  /** Desktop quits and starts again: every copy killed, all started together. */
  async restartAll(delayMs = 200) {
    for (const m of this.managers) m.kill('desktop restart');
    await sleep(delayMs);
    await this.startAll();
  }
  async close() { await Promise.all(this.managers.map(m => m.close())); }
  timeouts() { return this.events.filter(e => e.kind === 'timeout'); }
  longestCall() { return this.events.filter(e => e.kind === 'call').reduce((a, e) => Math.max(a, e.ms), 0); }
}
