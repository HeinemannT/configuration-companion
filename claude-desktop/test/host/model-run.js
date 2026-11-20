// npm run model-run [-- --minutes 15 --model haiku]
// One real model in the working loop: headless Claude Code with only this server, for a fixed time, sketches pushed
// at uneven gaps, a question and its answer, a correction and one "Send again". Afterwards the stream log and the
// session status are counted. Costs real money (capped by --max-budget-usd). Port 47725, a temp folder.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptedBrowser } from './browser.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const MINUTES = Number(arg('minutes', 15));
const MODEL = arg('model', 'haiku');
const BUDGET = arg('budget', '2');
const here = dirname(fileURLToPath(import.meta.url));
const server = process.argv.includes('--bundle') ? join(here, '../../build/bundle/server/index.js') : join(here, '../../src/index.js');
const PORT = 47725;
const dir = arg('dir', mkdtempSync(join(tmpdir(), 'cc-model-')));
mkdirSync(join(dir, 'sessions'), { recursive: true });
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const events = openSync(join(dir, 'events.txt'), 'w');
const note = (s) => { writeSync(events, `[${secs()} s] ${s}\n`); process.stdout.write(`[${secs()} s] ${s}\n`); };

const cfg = join(dir, 'mcp.json');
writeFileSync(cfg, JSON.stringify({ mcpServers: { companion: { command: process.execPath, args: [server], env: { COMPANION_PORT: String(PORT), COMPANION_FOLDER: join(dir, 'sessions'), COMPANION_DEBUG: join(dir, 'debug.txt') } } } }));
const OPENING = 'Work through my Configuration Companion sketches as they arrive. Call next_sketch, do what the sketch asks in BMP, tell me and the sketch with reply, then call next_sketch again. Keep going until I say stop.';
const TEST = '\n\nThis is a test and you have no BMP tools: for each sketch only say what you would change, then reply as the sketch says.';
const out = openSync(join(dir, 'agent.log'), 'w');
const agent = spawn('claude', ['-p', OPENING + TEST, '--mcp-config', cfg, '--strict-mcp-config',
  '--allowedTools', 'mcp__companion__next_sketch,mcp__companion__reply,mcp__companion__get_sketch,mcp__companion__list_sketches',
  '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', BUDGET, '--no-session-persistence'],
{ cwd: dir, stdio: ['ignore', out, out] });
note(`agent pid ${agent.pid}, folder ${dir}`);
let exited = null;
agent.on('exit', (c) => { exited = c; note(`agent exited ${c}`); });

const browser = new ScriptedBrowser({ ports: [PORT, PORT] });
const brief = (page, id, lines) => `Change request for a Corporater BMP page, sketched in Configuration Companion.\n\nPage: "${page}" (Scorecard, ID ${id})\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nThe user's words win. Ask before changing anything that is unclear.`;
const ids = {};
const plan = [
  [25, 'home', async () => browser.push({ text: brief('Home', 'home', ['Comment on Card ID home_news. The user says: "make this card smaller"', 'Comment on Chart ID home_chart. The user says: "make it blue"']), page: 'Home' })],
  [70, 'risks', async () => browser.push({ text: brief('Risks', 'risks', ['Comment on ExtendedTable (no ID shown). The user says: "rename the table" (the user did not say to what: ask for the new name before changing anything)']), page: 'Risks' })],
  [230, 'correction', async () => browser.push({ text: brief('Home', 'home', ['Comment on Chart ID home_chart. The user says: "not blue, green"']), page: 'Home', follows: { corrects: [{ sketch: ids.home, marks: [2] }] } })],
  [330, 'send again', async () => browser.requeue(ids.home)],
  [580, 'controls', async () => browser.push({ text: brief('Controls', 'controls', ['Comment on Table ID controls_table. The user says: "add a column Owner"']), page: 'Controls' })],
  [800, 'issues', async () => browser.push({ text: brief('Issues', 'issues', ['Comment on Footer. The user says: "hide the footer"']), page: 'Issues' })],
];
const DURATION = MINUTES * 60;
for (const [s, name, fn] of plan) {
  if (s >= DURATION - 20) continue;
  setTimeout(async () => { const r = await fn(); if (r?.id && !ids[name]) ids[name] = r.id; note(`${name}: ${JSON.stringify(r).slice(0, 200)}`); }, s * 1000);
}
// The browser answers a question as the user would, through the page.
let answered = false;
const poll = setInterval(async () => {
  const st = await browser.status();
  const q = st?.sketches.find(r => r.state === 'question');
  if (q && !answered) {
    answered = true;
    const r = await browser.push({ text: 'Call it "Top risks".', page: 'Risks', follows: { answers: q.id } });
    note(`answer to sketch ${q.number}: ${JSON.stringify(r).slice(0, 160)}`);
  }
}, 5000);

await new Promise(r => setTimeout(r, DURATION * 1000));
clearInterval(poll);
const final = await browser.status();
const exitedBeforeEnd = exited !== null;
note(exited === null ? 'stopping agent' : 'agent had already exited');
if (exited === null) spawnSync('taskkill', ['/pid', String(agent.pid), '/t', '/f']);
await new Promise(r => setTimeout(r, 1500));

const lines = readFileSync(join(dir, 'agent.log'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const usage = new Map();
const calls = [];
const results = new Map();
const texts = [];
for (const e of lines) {
  if (e.type === 'assistant') {
    if (e.message.usage) usage.set(e.message.id, e.message.usage);
    for (const c of e.message.content ?? []) {
      if (c.type === 'tool_use') calls.push({ id: c.id, name: c.name.replace('mcp__companion__', ''), input: c.input });
      if (c.type === 'text' && c.text.trim()) texts.push(c.text.trim().replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  if (e.type === 'user') for (const c of e.message?.content ?? []) if (c.type === 'tool_result') results.set(c.tool_use_id, Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join(' ') : String(c.content));
}
const nexts = calls.filter(c => c.name === 'next_sketch');
const replies = calls.filter(c => c.name === 'reply');
const handed = nexts.map(c => results.get(c.id) ?? '').filter(t => /^Sketch \d+ \(id/.test(t));
const sum = (k) => [...usage.values()].reduce((a, u) => a + (u[k] ?? 0), 0);
const result = lines.find(e => e.type === 'result');
const lastCall = calls.at(-1);
const stats = {
  minutes: MINUTES, model: MODEL, agentExitedBeforeEnd: exitedBeforeEnd,
  next_sketch_calls: nexts.length, nothing_yet: nexts.filter(c => /^Nothing yet/.test(results.get(c.id) ?? '')).length,
  errors: [...results.values()].filter(t => /error|timed out/i.test(t.slice(0, 80))).length,
  handed: handed.map(t => /^Sketch (\d+)/.exec(t)[1]),
  handedBeforeNoted: handed.filter(t => /handed out before|You took this sketch/.test(t)).map(t => /^Sketch (\d+)/.exec(t)[1]),
  replies: replies.map(c => `${c.input.number}:${c.input.status}`),
  question_asked: replies.some(c => c.input.status === 'question'),
  last_tool_call: lastCall ? `${lastCall.name} ${results.has(lastCall.id) ? 'answered' : 'in flight at stop'}` : null,
  final_states: final?.sketches.map(r => `${r.number}:${r.state}${r.requeued ? ` (requeued ${r.requeued})` : ''}`),
  model_turns: usage.size, text_messages: texts.length,
  tokens: { input: sum('input_tokens'), cache_creation: sum('cache_creation_input_tokens'), cache_read: sum('cache_read_input_tokens'), output: sum('output_tokens') },
  cost: result?.total_cost_usd ?? null,
  texts,
};
writeFileSync(join(dir, 'stats.json'), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
process.exit(0);
