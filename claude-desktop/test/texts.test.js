// What Claude reads: thin descriptions, and results that always end with the next step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSession } from '../src/session.js';
import { createMcp, DESCRIPTIONS, INSTRUCTIONS, OPENING, STEP, closeAnswered, followUpsOf, handoverResult, replyResult } from '../src/mcp.js';
import { nextStep } from './host/agent.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const brief = (n) => `Page: "P${n}" (Scorecard)\n\n1. Comment on Card ID c1. The user says: "smaller"\n2. Comment on Chart ID c2. The user says: "blue"`;
const text = (r) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

async function connect(store, o = {}) {
  const server = createMcp(store, { waitMs: 50, ...o });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'local-agent-mode-Configuration Companion', version: '1' });
  await client.connect(b);
  return { client, call: async (name, args = {}) => text(await client.callTool({ name, arguments: args })) };
}

test('descriptions and instructions are thin: no version, no wait length, no state list; they say to call again on failure', async () => {
  const store = createSession();
  try {
    const { client } = await connect(store);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['clear_session', 'get_sketch', 'list_sketches', 'next_sketch', 'reply']);
    for (const t of tools) {
      assert.doesNotMatch(t.description, /\d+\.\d+\.\d+|\d+ ?s(econds)?\b|done, working|working, done|status line/, t.name);
      assert.equal(t.description, DESCRIPTIONS[t.name]);
    }
    const ins = client.getInstructions();
    assert.equal(ins, INSTRUCTIONS);
    assert.match(ins, /If next_sketch fails or times out, call it again\./);
    assert.match(ins, /Every result says what to do next/);
    assert.doesNotMatch(ins, /\d+\.\d+\.\d+|\d+ ?s(econds)?\b/);
    assert.equal(OPENING, 'Work through my Configuration Companion sketches as they arrive. Call next_sketch, do what the sketch asks in BMP, tell me and the sketch with reply, then call next_sketch again. Keep going until I say stop.');
  } finally { store.close(); }
});

test('every result ends with a step a chat can follow, also errors and odd inputs', async () => {
  const store = createSession();
  try {
    const { call } = await connect(store);
    const results = [];
    results.push(await call('next_sketch'));
    results.push(await call('get_sketch'));
    results.push(await call('get_sketch', { number: 4 }));
    results.push(await call('get_sketch', { number: 'x!' }));
    results.push(await call('list_sketches'));
    results.push(await call('reply', { number: 1, status: 'done', text: 'x' }));
    store.add({ text: brief(1), page: 'P1', picture: { mime: 'image/png', data: PNG } });
    store.add({ text: brief(2), page: 'P2' });
    results.push(await call('get_sketch', { number: '1' }));
    results.push(await call('list_sketches'));
    results.push(await call('reply', { number: 2, status: 'done', text: 'x' }));
    results.push(await call('next_sketch'));
    results.push(await call('reply', { number: 1, status: 'nope', text: 'x' }));
    results.push(await call('reply', { number: 1, status: 'done' }));
    results.push(await call('reply', { status: 'done', text: 'x' }));
    results.push(await call('reply', { number: 1, status: 'working', text: 'started' }));
    results.push(await call('reply', { number: 1, status: 'question', text: 'Which card?' }));
    results.push(await call('next_sketch'));
    results.push(await call('reply', { number: 2, status: 'cannot', text: 'No access.' }));
    results.push(await call('clear_session'));
    for (const r of results) {
      const step = nextStep(r);
      assert.ok(step, `no next step in: ${r.slice(-160)}`);
      assert.match(r.trimEnd(), /call (next_sketch|reply)[^.]*\.$/i, `the last sentence is a step: ${r.slice(-160)}`);
    }
  } finally { store.close(); }
});

test('hand-over: head with id, intro, brief, picture note, advice, version line, fixed step last', () => {
  const s = { id: 'abcdef0123456789', number: 3, at: new Date(), text: brief(3), page: 'P3', picture: { mime: 'image/png', data: PNG, drawn: true }, handed: 1, history: [] };
  const t = text(handoverResult({ sketch: s, handedBefore: false }, null, { version: '0.3.0' }));
  assert.match(t, /^Sketch 3 \(id abcdef0123456789\), sent .*, page: P3, with a picture\.\n\nA sketch is a change request/);
  assert.match(t, /The picture is drawn from the page layout: values in it can be cut short\./);
  assert.match(t, /Configuration Companion 0\.3\.0\.\nSketch 3: when it is done, or you cannot do it, call reply with number 3 \(status done, working, question or cannot\)\. Then call next_sketch\.$/);
  const maybe = text(handoverResult({ sketch: { ...s, picture: { mime: 'image/png', data: PNG } } }, null, {}));
  assert.match(maybe, /If the picture is drawn from the page layout rather than a screenshot/);
  const custom = text(handoverResult({ sketch: s }, null, { cfg: { texts: { afterSketch: 'Do it well, {number}.', intro: 'Intro.' } } }));
  assert.match(custom, /Intro\./);
  assert.match(custom, /Do it well, 3\.\nConfiguration Companion/);
});

test('follow-ups: text markers for older browsers; an answer comes with the earlier sketch and its question', async () => {
  assert.deepEqual(followUpsOf('Answer to sketch 3: "left"'), { answers: 3, corrects: [] });
  assert.deepEqual(followUpsOf('1. Correction to sketch 2, mark 1: x\n2. Correction to sketch 2 mark 3'), { answers: null, corrects: [{ number: 2, marks: [1, 3] }] });
  const store = createSession();
  try {
    const { call } = await connect(store);
    store.add({ text: brief(1), page: 'P1' });
    await call('next_sketch');
    await call('reply', { number: 1, status: 'question', text: 'Which card?' });
    store.add({ text: 'Answer to sketch 1: the left one', page: 'P1' });
    const h = await call('next_sketch');
    assert.match(h, /This is the user's answer to your question on sketch 1\. Act on it as part of sketch 1\. Reply with number 2; that also closes sketch 1\./);
    assert.match(h, /Your reply to sketch 1: "Which card\?"/);
    const r = await call('reply', { number: 2, status: 'done', text: 'Made the left card smaller.' });
    assert.match(r, /The same reply was recorded for sketch 1, whose question it answers\./);
    assert.equal(store.get(1).reply.text, 'In sketch 2: Made the left card smaller.');
    assert.deepEqual(closeAnswered(store, 2, 'done', 'again'), [], 'once closed, nothing more moves');
  } finally { store.close(); }
});

test('reply: a status word from the settings is accepted; the result texts come from the settings, the steps do not', async () => {
  const store = createSession();
  try {
    store.settings.apply(1, { states: [{ name: 'parked', open: false, word: 'Parked' }], texts: { afterDone: 'Noted.' } });
    store.add({ text: brief(1), page: 'P1' });
    await store.next(10);
    const cfg = store.settings.get().config;
    const t = text(replyResult(store, { number: 1, status: 'Parked', text: 'Later.' }, { cfg }));
    assert.equal(t, `Noted. ${STEP.afterReply}`);
  } finally { store.close(); }
});
