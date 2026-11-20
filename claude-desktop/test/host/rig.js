/** Shared set-up for the host scenarios: a temp folder, a Desktop-faithful host, a browser, a ledger. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopHost } from './desktop.js';
import { ScriptedBrowser } from './browser.js';
import { Ledger } from './ledger.js';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const textOf = (r) => (r?.result?.content ?? r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

/** Wait until `fn` returns something truthy, or fail after `ms`. */
export async function until(fn, ms = 10_000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/**
 * @param {object} o
 * @param {number} o.port   first port of a block of 3 (copies try them in order)
 */
export async function rig({ port, copies = 1, wait = 2, timeoutMs = 8_000, env = {}, shape = 'new', start = true, base = null } = {}) {
  const folder = base ?? mkdtempSync(join(tmpdir(), 'cc-host-'));
  const ports = [port, port + copies + 1];
  const host = new DesktopHost({
    base: folder, ports, copies, timeoutMs,
    env: { ...(wait ? { COMPANION_WAIT_SECONDS: String(wait) } : {}), ...env },
  });
  const browser = new ScriptedBrowser({ ports, shape });
  const ledger = new Ledger();
  if (start) await host.startAll();
  await sleep(200);
  return {
    base: folder, host, browser, ledger, ports,
    m: (i = 0) => host.managers[i],
    async done() { await host.close(); await sleep(150); if (!base) { try { rmSync(folder, { recursive: true, force: true }); } catch { /* left for the OS */ } } },
  };
}
