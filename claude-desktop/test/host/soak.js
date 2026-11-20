// npm run soak [-- --minutes 30 --bundle --seed 7]
// Randomised traffic against three copies under the Desktop-faithful host (60 s timeout, kill and restart on
// timeout), two looping scripted chats, a scripted browser in old and new shapes, settings changed on the way,
// and kills at random moments (also right between a take and its result, and whole Desktop restarts). The
// invariants of ledger.js are checked all along and at the end. Ports 47786-47790, a temp folder.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopHost, SOURCE_ENTRY, BUNDLE_ENTRY } from './desktop.js';
import { ScriptedBrowser, newKey } from './browser.js';
import { Ledger } from './ledger.js';
import { ScriptedAgent } from './agent.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1] ?? true; };
const MINUTES = Number(arg('minutes', 30));
const SEED = Number(arg('seed', Date.now() % 100000));
const BUNDLE = process.argv.includes('--bundle');
const OUT = arg('out', null);
const PORTS = [47786, 47790];

// A small seeded random source, so a failing run can be repeated.
let st = SEED >>> 0 || 1;
const rand = () => { st ^= st << 13; st >>>= 0; st ^= st >> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
const pick = (p) => rand() < p;
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const log = (s) => process.stdout.write(`[${at()}] ${s}\n`);

const entry = BUNDLE ? BUNDLE_ENTRY : SOURCE_ENTRY;
if (BUNDLE && !existsSync(entry)) { console.error('Build first: npm run build'); process.exit(2); }
const base = mkdtempSync(join(tmpdir(), 'cc-soak-'));
const host = new DesktopHost({ base, ports: PORTS, copies: 3, entry });
const ledger = new Ledger();
const browser = new ScriptedBrowser({ ports: PORTS, shape: 'new' });
const oldBrowser = new ScriptedBrowser({ ports: PORTS, shape: 'old' });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pages = ['Home', 'Risks', 'Controls', 'Issues', 'Audit plan', 'Supplier risk', 'KPIs'];
const brief = (page, n) => `Change request for a Corporater BMP page, sketched in Configuration Companion.\n\nPage: "${page}" (Scorecard, ID ${page.toLowerCase().replace(/ /g, '_')})\n\n1. Comment on Table ID t${n}. The user says: "change ${n}"\n2. Comment on Chart ID c${n}. The user says: "make it blue"`;

host.on((e) => { if (e.kind === 'kill') ledger.counts.kills++; if (e.kind === 'start' && e.gen > 1) ledger.counts.restarts++; if (e.kind === 'timeout') log(`TIMEOUT manager ${e.manager} ${e.name} after ${e.ms} ms`); });

let pushN = 0;
// Old browsers send no key, so a push whose answer was lost cannot be matched; the next status adopts it.
let lostOld = 0;
async function push({ answers = null, corrects = null } = {}) {
  const old = pick(0.15);
  const b = old ? oldBrowser : browser;
  const page = pages[between(0, pages.length - 1)];
  const n = ++pushN;
  let text = brief(page, n);
  let follows;
  if (answers) { text = old ? `Answer to sketch ${answers.number}: the left one, please.` : 'The left one, please.'; follows = old ? undefined : { answers: answers.id }; }
  if (corrects) { text = old ? `1. Correction to sketch ${corrects.number}, mark 2: not blue, green.` : '1. Comment on Chart. The user says: "not blue, green"'; follows = old ? undefined : { corrects: [{ sketch: corrects.id, marks: [2] }] }; }
  const picture = pick(0.1) ? { mime: 'image/png', data: PNG, ...(pick(0.5) ? { drawn: true } : {}) } : undefined;
  const key = old ? null : newKey();
  if (!old && pick(0.1)) {
    // The answer is lost on the way (worker asleep): the browser sends the same push again with its key.
    const lost = await b.push({ text, page, picture, key, follows, drop: true });
    if (!lost.none) { await sleep(between(300, 3000)); }
  }
  let ack = await b.push({ text, page, picture, key, follows });
  for (let i = 0; (ack.lost || ack.none) && key && i < 5; i++) {
    // The copy that held the socket was killed before it answered: the browser sends again with the same key.
    await sleep(between(500, 2500));
    ack = await b.push({ text, page, picture, key, follows });
  }
  if ((ack.lost || ack.none) && !key) { lostOld++; log('an old-shape push lost its answer'); }
  if (ack.ok) ledger.pushed(ack, { key, shape: old ? 'old' : 'new' });
  else if (!ack.none) log(`push refused: ${ack.error}`);
  if (answers && ack.ok) ledger.counts.answers++;
  if (corrects && ack.ok) ledger.counts.corrections++;
  return ack;
}

let rev = 0;
async function changeSettings() {
  rev++;
  const cfg = {
    wait: { default: between(20, 45) },
    limits: { keep: between(12, 40), takenMinutes: 2 },
    states: pick(0.5) ? [{ name: 'parked', open: false, word: 'Parked' }] : [],
    texts: pick(0.5)
      ? { nothingYet: 'Quiet for now.', afterDone: 'Thanks.', afterSketch: 'Settings text without any step in it.', handedBefore: 'Look at what was done first.' }
      : {},
  };
  const r = await browser.config(Date.now(), cfg);
  ledger.counts.configs++;
  log(`settings rev ${rev}: wait ${cfg.wait.default} s, keep ${cfg.limits.keep}, texts ${Object.keys(cfg.texts).length ? 'changed' : 'built in'} -> ${r?.ok ? (r.applied ? 'applied' : 'not applied') : r?.error}`);
}

let lastStuck = 0;
async function browse() {
  const all = await browser.statusAll();
  if (!all.length) return;
  ledger.compareCopies(all);
  const s = all[0].status;
  for (const row of s.sketches) {
    if (lostOld > 0 && !ledger.byId.get(row.id)?.pushes) { lostOld--; ledger.pushed({ ok: true, id: row.id, number: row.number }, { shape: 'old' }); ledger.counts.pushes--; }
    if (row.state === 'question' && !answered.has(row.id)) { answered.add(row.id); await push({ answers: row }); }
    else if (row.state === 'done' && pick(0.01) && !corrected.has(row.id)) { corrected.add(row.id); await push({ corrects: row }); }
    else if (row.state === 'done' && pick(0.006)) { const r = await browser.requeue(row.id); if (r?.ok) { ledger.requeued(row.id); log(`Send again: sketch ${row.number}`); } }
    else if (row.state === 'queued' && pick(0.005) && row.handed === 0) { const r = await browser.withdraw(row.id); if (r?.ok) { ledger.withdrawn(row.id); log(`withdrawn: sketch ${row.number}`); } }
    // A sketch waiting while a chat waits for one is stuck: nothing takes it.
    if (row.state === 'queued' && s.waiters > 0 && Date.now() - row.rev > 90_000 && Date.now() - lastStuck > 30_000) {
      lastStuck = Date.now();
      ledger.violate('I5', `sketch ${row.number} waits ${Math.round((Date.now() - row.rev) / 1000)} s while ${s.waiters} chat(s) wait`);
    }
  }
}
const answered = new Set(), corrected = new Set();

async function chaos() {
  const r = rand();
  if (r < 0.12) { log('Desktop restart: all copies'); await host.restartAll(between(100, 2000)); return; }
  const m = host.managers[between(0, 2)];
  if (r < 0.45) {
    // Between take and result: push while that copy's chat waits, kill it a few ms later.
    log(`kill manager ${m.index} right after a push`);
    const p = push();
    await sleep(between(0, 25));
    m.restart('chaos: between take and result', between(300, 2500));
    await p;
    return;
  }
  log(`kill manager ${m.index}`);
  m.restart('chaos', between(300, 3000));
}

async function main() {
  log(`soak: ${MINUTES} min, seed ${SEED}, entry ${BUNDLE ? 'bundle' : 'source'}, folder ${base}`);
  await host.startAll();
  const agents = [0, 1].map(i => new ScriptedAgent({ name: `chat${i}`, manager: host.managers[i], ledger, rng: rand, workMs: [200, 6000], questions: 0.08, working: 0.1, bad: 0.04, cannot: 0.03 }).start());
  const end = t0 + MINUTES * 60_000;
  let nextPush = Date.now() + 3000, nextBrowse = Date.now() + 5000, nextChaos = Date.now() + between(40_000, 120_000), nextSettings = Date.now() + between(120_000, 300_000);
  while (Date.now() < end) {
    const now = Date.now();
    if (now >= nextPush) {
      const burst = pick(0.15) ? between(2, 4) : 1;
      for (let i = 0; i < burst; i++) await push();
      // Uneven gaps: mostly short, sometimes several minutes of quiet.
      nextPush = Date.now() + (pick(0.1) ? between(90_000, 240_000) : between(1000, 40_000));
    }
    if (now >= nextBrowse) { await browse(); nextBrowse = Date.now() + 7000; }
    if (now >= nextChaos) { await chaos(); nextChaos = Date.now() + between(45_000, 150_000); }
    if (now >= nextSettings) { await changeSettings(); nextSettings = Date.now() + between(180_000, 420_000); }
    await sleep(250);
  }
  log('traffic stops; waiting until every sketch is closed');
  const quietEnd = Date.now() + 6 * 60_000;
  let final = null;
  while (Date.now() < quietEnd) {
    await browse();
    final = await browser.status();
    if (final && final.sketches.every(r => !r.open)) break;
    await sleep(3000);
  }
  for (const a of agents) a.stopped = true;
  await Promise.race([Promise.all(agents.map(a => a.done)), sleep(70_000)]);
  final = await browser.status();
  ledger.finalCheck(final);
  const longest = host.longestCall();
  if (host.timeouts().length) ledger.violate('I8', `${host.timeouts().length} calls timed out`);
  const summary = {
    minutes: MINUTES, seed: SEED, entry: BUNDLE ? 'bundle' : 'source',
    ...ledger.summary(), longestCallMs: longest, timeouts: host.timeouts().length,
    toolCalls: host.events.filter(e => e.kind === 'call').length,
    openAtEnd: final ? final.sketches.filter(r => r.open).length : null,
    violations: ledger.violations,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));
  await host.close();
  await sleep(500);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* left for the OS */ }
  process.exit(ledger.violations.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
