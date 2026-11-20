/**
 * What Claude sees: the working-session tools (next_sketch, reply), the readers, and two prompts.
 *
 * A running chat keeps the tool descriptions and the server instructions it read at its start, so they stay thin and
 * generic. Behaviour lives in the tool RESULTS, which are made fresh on every call from the settings in force, and
 * every result ends with the next step.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';
import { configuredWait } from './config.js';
import { EXTENSION_VERSION, sketchRef } from './protocol.js';

/** A waiting next_sketch sends a progress notification this often, when the client asked for them. */
export const PROGRESS_MS = 10_000;

/** The text of the link that starts a working chat, and of the prompt of the same name. Mirrored in src/lib/claude-link.ts. */
export const OPENING =
  'Work through my Configuration Companion sketches as they arrive. Call next_sketch, do what the sketch asks in BMP, '
  + 'tell me and the sketch with reply, then call next_sketch again. Keep going until I say stop.';

/** Server instructions: generic on purpose, since a running chat keeps them. */
export const INSTRUCTIONS =
  'Configuration Companion hands you sketches: change requests the user draws on a Corporater BMP page. '
  + 'Call next_sketch to take the next one. Every result says what to do next: follow it. '
  + 'If next_sketch fails or times out, call it again. Only the user ends the loop.';

export const DESCRIPTIONS = {
  next_sketch: 'Takes the next sketch from Configuration Companion, or waits a while for one. The result says what to do next. If this call fails or times out, call it again.',
  reply: 'Records your answer to a sketch: its number, a status word (such as done) and a short text. The sketch you got names the status words. The result says what to do next.',
  get_sketch: 'Shows a sketch without taking it: the newest, or one by number.',
  list_sketches: 'Lists the sketches kept, newest first, with their states.',
  clear_session: 'Deletes the sketches of this session and their files. Use it only when the user asks.',
};

export const DRAWN_NOTE = 'The picture is drawn from the page layout: values in it can be cut short. Take names and IDs from the text.';
export const MAYBE_DRAWN_NOTE = 'If the picture is drawn from the page layout rather than a screenshot, values in it can be cut short. Take names and IDs from the text.';

/** The built-in texts; each can be replaced by settings (texts.<name>). The fixed next steps below cannot. */
export const DEFAULT_TEXTS = {
  intro: 'A sketch is a change request the user drew on a live Corporater BMP page in Configuration Companion. '
    + "Act on it with the BMP tools you have in this chat. What the brief labels as a guess is a guess; the user's own words win.",
  afterSketch: 'The user sees the first sentence of your reply on the page, next to the drawing: keep it short and plain, and say what you changed and where. '
    + 'If something is unclear, call reply with status question and one concrete question that the user can answer in one sentence.',
  nothingYet: 'Nothing yet. Write nothing to the user, unless the app asks you for a status line: then write one short line. Only the user ends this loop.',
  afterDone: 'Recorded.',
  afterWorking: 'Recorded. Carry on with sketch {number}.',
  afterQuestion: 'Recorded. The user sees your question next to the drawing and can answer there; the answer comes through next_sketch as a new sketch. '
    + 'If the user answers in this chat instead, carry on with sketch {number}.',
  pictureNote: MAYBE_DRAWN_NOTE,
  drawnNote: DRAWN_NOTE,
  handedBefore: 'It has no answer yet. Check what is already done in BMP before you change anything.',
  superseded: 'This call was replaced by a newer next_sketch call.',
};
/** 0.2.x names, kept for callers. */
export const NOTHING_YET = `${DEFAULT_TEXTS.nothingYet} Call next_sketch again now.`;
export const NONE_YET = 'No sketch has arrived yet. In Configuration Companion, open Point and tell on a BMP page, draw and comment, then press Send to Claude.';

/** The fixed next steps. Settings never change these, so every result ends with a step a chat can follow. */
export const STEP = {
  sketch: (n, words) => `Sketch ${n}: when it is done, or you cannot do it, call reply with number ${n} (status ${words}). Then call next_sketch.`,
  nothing: 'Call next_sketch again now.',
  afterReply: 'Call next_sketch now.',
  working: (n) => `When it is done, call reply with number ${n} again. Then call next_sketch.`,
  superseded: 'Use the result of the newer call. If you have none, call next_sketch again.',
  again: (n) => `Call reply again with number ${n}.`,
  readers: 'To take sketches in order, call next_sketch.',
};

const text = (t) => ({ type: 'text', text: t });
const image = (s) => ({ type: 'image', data: s.picture.data, mimeType: s.picture.mime });
const say = (body) => ({ content: [text(body)] });
const fill = (t, n) => String(t).replaceAll('{number}', String(n));
const clock = (d) => d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
const hhmm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const firstWords = (t, n = 12) => String(t).split(/\s+/).filter(Boolean).slice(0, n).join(' ');
const quote = (t, max = 300) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const STATE_WORDS = { queued: 'waiting', taken: 'taken', working: 'working', done: 'done', question: 'question', cannot: 'could not', withdrawn: 'withdrawn' };
const stateWord = (s) => s.word ?? STATE_WORDS[s.state] ?? s.state;
/** "done, working, question or cannot" */
const orList = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`);

/** The texts in force: settings over the built-in ones. */
export const textsOf = (cfg) => ({ ...DEFAULT_TEXTS, ...(cfg?.texts ?? {}) });

/**
 * How older browsers mark follow-ups in the brief (src/lib/point-tell/brief.ts): an answer in place starts
 * `Answer to sketch 3: "..."`; a changed mark's line holds `Correction to sketch 3, mark 1`. Newer browsers send
 * `follows` instead; the text is read only when they do not.
 */
const ANSWER = /^\s*answer to sketch (\d+):/i;
const CORRECTION = /correction to sketch (\d+),? mark (\d+)/gi;

/** What a sketch follows up, from its text: { answers: number|null, corrects: [{ number, marks }] }. */
export function followUpsOf(t) {
  const s = String(t ?? '');
  const a = ANSWER.exec(s);
  const corrects = new Map();
  for (const m of s.matchAll(CORRECTION)) {
    const n = Number(m[1]), k = Number(m[2]);
    const ks = corrects.get(n) ?? [];
    if (!ks.includes(k)) ks.push(k);
    corrects.set(n, ks);
  }
  return { answers: a ? Number(a[1]) : null, corrects: [...corrects].map(([number, marks]) => ({ number, marks })) };
}

/** What a sketch follows up: from `follows` when the browser sent it (ids resolved against the kept list), else from its text. */
export function followsOf(s, kept) {
  if (!s.follows) return followUpsOf(s.text);
  const num = (r) => (r?.number ?? kept.find(k => k.id === r?.id)?.number ?? null);
  const corrects = new Map();
  for (const c of s.follows.corrects ?? []) {
    const n = num(c.sketch);
    if (n === null) continue;
    const ks = corrects.get(n) ?? [];
    for (const k of c.marks ?? []) if (!ks.includes(k)) ks.push(k);
    corrects.set(n, ks);
  }
  return { answers: s.follows.answers ? num(s.follows.answers) : null, corrects: [...corrects].map(([number, marks]) => ({ number, marks })) };
}

/** What Claude needs of an earlier sketch to act on a follow-up: its page, its marks (all, or the ones named), and the reply. */
export function earlierContext(number, earlier, only = null) {
  if (!earlier) return `Sketch ${number} is no longer kept.`;
  const lines = earlier.text.split(/\r?\n/).map(l => l.trim());
  const marks = lines.filter(l => /^\d+\.\s/.test(l));
  const page = lines.find(l => /^Page:/.test(l));
  const what = only?.length
    ? only.map(k => marks.find(l => l.startsWith(`${k}.`)) ?? `${k}. (no such mark in sketch ${number})`)
    : marks.length ? marks.slice(0, 8) : [quote(earlier.text, 400)];
  const out = [`Sketch ${number}${earlier.page ? ` (page: ${earlier.page})` : ''}, state: ${stateWord(earlier)}${only?.length ? `, the ${only.length === 1 ? 'mark' : 'marks'} corrected` : ''}:`];
  if (page && !only?.length) out.push(page);
  out.push(...what.map(l => quote(l)));
  if (!only?.length && marks.length > what.length) out.push(`(${marks.length - what.length} more marks: get_sketch ${number})`);
  out.push(earlier.reply ? `Your reply to sketch ${number}: "${quote(earlier.reply.text)}"` : `You have not replied to sketch ${number} yet.`);
  return out.join('\n');
}

/** The block put before a follow-up's own text, or '' for an ordinary sketch. */
export function followUpBlock(s, listKept) {
  const kept = listKept();
  const f = followsOf(s, kept);
  if (f.answers === null && !f.corrects.length) return '';
  const find = (n) => kept.find(i => i.number === n) ?? null;
  const parts = [];
  if (f.answers !== null && f.answers !== s.number) {
    parts.push(`This is the user's answer to your question on sketch ${f.answers}. Act on it as part of sketch ${f.answers}. `
      + `Reply with number ${s.number}${find(f.answers) ? `; that also closes sketch ${f.answers}` : ''}.\n${earlierContext(f.answers, find(f.answers))}`);
  }
  const corrects = f.corrects.filter(c => c.number !== s.number);
  if (corrects.length) {
    parts.push(`Marks in this sketch correct marks of an earlier sketch. What they correct:\n${corrects.map(c => earlierContext(c.number, find(c.number), c.marks)).join('\n\n')}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n\n` : '';
}

/** The head line of a sketch. */
export function sketchHead(s) {
  return `Sketch ${s.number} (id ${s.id}), sent ${clock(s.at)}${s.page ? `, page: ${s.page}` : ''}${s.picture ? ', with a picture' : ', no picture'}.`;
}
/** The text block for one kept sketch, as the readers show it. */
export function sketchText(s) { return `${sketchHead(s)}\n\n${s.text}`; }

/**
 * The result of next_sketch for a sketch handed over. `taken` is what the store gave: { sketch, handedBefore, rehand }.
 * A follow-up comes with what Claude needs of the earlier sketch, read from the store.
 */
export function handoverResult(taken, store, { cfg, version = EXTENSION_VERSION, replyWords = ['done', 'working', 'question', 'cannot'] } = {}) {
  const s = taken.sketch;
  const T = textsOf(cfg);
  const parts = [sketchHead(s)];
  if (taken.handedBefore || s.handed > 1) {
    const when = s.lastTakenAt ? `, last at ${hhmm(s.lastTakenAt)}` : '';
    const lead = taken.rehand ? `You took this sketch${when ? ` at ${hhmm(s.lastTakenAt)}` : ''} and did not reply.` : `This sketch was handed out before${when}.`;
    const last = [...(s.history ?? [])].reverse().find(h => h.reply?.text);
    parts.push(`${lead} ${fill(T.handedBefore, s.number)}${last ? `\nThe last reply to it was (${last.state}): "${quote(last.reply.text)}"` : ''}`);
  }
  parts.push(fill(T.intro, s.number));
  let middle = '';
  try { middle = followUpBlock(s, () => (store ? store.list() : [])); } catch { /* the sketch itself still goes */ }
  const body = `${middle}${s.handover?.before ? `${fill(s.handover.before, s.number)}\n\n` : ''}${String(s.text).trimEnd()}`;
  parts.push(body);
  const tail = [];
  if (s.picture) tail.push(fill(s.picture.drawn ? T.drawnNote : T.pictureNote, s.number));
  tail.push(s.handover?.after ? fill(s.handover.after, s.number) : fill(T.afterSketch, s.number));
  tail.push(`Configuration Companion ${version}.`);
  tail.push(STEP.sketch(s.number, orList(replyWords)));
  parts.push(tail.join('\n'));
  return { content: [text(parts.join('\n\n')), ...(s.picture?.data ? [image(s)] : [])] };
}

/** 0.2.x shape: the result for a sketch just taken, or for a wait that found none. */
export function nextSketchResult(s, store, version = EXTENSION_VERSION, cfg = null) {
  if (!s) return say(`${textsOf(cfg).nothingYet} ${STEP.nothing}`);
  return handoverResult({ sketch: s, handedBefore: false }, store, { cfg, version });
}

export function getSketchResult(store, number) {
  if (number === undefined) {
    const s = store.get();
    if (!s) return say(`${NONE_YET} ${STEP.readers}`);
    return { content: [text(`${sketchText(s)}\n\nThis shows the sketch only; it is not handed to you. ${STEP.readers}`), ...(s.picture?.data ? [image(s)] : [])] };
  }
  const s = store.get(number);
  if (!s) {
    const kept = store.list().map(i => i.number);
    return say(`Sketch ${number} is not kept. ${kept.length ? `Kept: ${kept.join(', ')}.` : NONE_YET} Call get_sketch with one of the kept numbers, or call next_sketch.`);
  }
  return { content: [text(`${sketchText(s)}\n\nThis shows the sketch only; it is not handed to you. ${STEP.readers}`), ...(s.picture?.data ? [image(s)] : [])] };
}

export function listSketchesResult(store, keep) {
  const rows = store.list();
  if (!rows.length) return say(`${NONE_YET} Call next_sketch to take sketches as they come.`);
  const lines = rows.map(s => `${s.number}. ${clock(s.at)} | ${s.page || 'no page name'} | ${stateWord(s)} | ${firstWords(s.text)}${s.picture ? ' | picture' : ''}`);
  const where = store.folder() ? ` Files: ${store.folder()}` : '';
  return say(`Newest first. Every open sketch and the last ${keep} are listed.${where}\n${lines.join('\n')}\nCall next_sketch to go on.`);
}

/**
 * A reply to an answer (sketch 10 answers sketch 9's question) also moves on the sketch whose question it answers,
 * and that one's own question further back, while they still wait in state question. They take the reply's state
 * and its words after "In sketch 10: ". Returns the numbers moved.
 */
export function closeAnswered(store, number, status, words) {
  const moved = [];
  let kept;
  try { kept = store.list(); } catch { return moved; }
  const byNumber = new Map(kept.map(i => [i.number, i]));
  let at = byNumber.get(number);
  while (at && moved.length < 10) {
    const n = followsOf(at, kept).answers;
    const asked = n === null ? null : byNumber.get(n);
    if (!asked || asked.state !== 'question' || n === number || moved.includes(n)) break;
    try { if (!store.reply(n, status, `In sketch ${number}: ${words}`, { chain: true })?.sketch) break; } catch { break; }
    moved.push(n);
    at = asked;
  }
  return moved;
}

/** The result of reply. Every input is checked here, so a bad one gives a text with the next step, never a protocol error. */
export function replyResult(store, args, { cfg } = {}) {
  const T = textsOf(cfg);
  const ref = sketchRef(typeof args?.number === 'string' ? args.number.replace(/^#/, '') : args?.number);
  let number = ref?.number;
  if (ref?.id) number = store.list().find(s => s.id === ref.id)?.number;
  if (!number) return say('reply needs the number of the sketch, as its last line shows. Call reply again with that number; if you do not know it, call next_sketch.');
  const allowed = store.replyStates();
  const status = String(args?.status ?? '').trim().toLowerCase();
  if (!allowed.includes(status)) {
    return say(`${status ? `"${quote(status, 40)}" is not a status for reply.` : 'reply needs a status.'} Use one of: ${orList(allowed)}. ${STEP.again(number)}`);
  }
  const words = typeof args?.text === 'string' ? args.text : args?.text === undefined || args?.text === null ? '' : String(args.text);
  if (!words.trim()) return say(`reply needs a text: for ${status === 'question' ? 'a question, the one question' : 'the user, one short sentence on what you did'}. ${STEP.again(number)}`);
  const r = store.reply(number, status, words);
  if (r.error === 'unknown') {
    const kept = store.list().map(i => i.number);
    return say(`Sketch ${number} is not in this session${kept.length ? ` (kept: ${kept.join(', ')})` : ''}. Check the number on the last line of the sketch and call reply again, or call next_sketch.`);
  }
  if (r.error === 'not-handed') return say(`Sketch ${number} has not been handed to a chat yet; it waits in the queue. Call next_sketch to take it.`);
  if (r.error === 'withdrawn') return say(`The user withdrew sketch ${number}; it needs no reply. ${STEP.afterReply}`);
  const moved = status === 'working' ? [] : closeAnswered(store, number, status, words);
  const also = moved.length ? ` The same reply was recorded for sketch ${moved.join(' and ')}, whose question it answers.` : '';
  const cut = r.cut ? ` Your text was longer than ${r.cut} characters and was cut.` : '';
  if (status === 'working') return say(`${fill(T.afterWorking, number)}${cut} ${STEP.working(number)}`);
  if (status === 'question') return say(`${fill(T.afterQuestion, number)}${also}${cut} ${STEP.afterReply}`);
  return say(`${fill(T.afterDone, number)}${also}${cut} ${STEP.afterReply}`);
}

/** The text of an unexpected failure, with the step that recovers from it. */
export function failureResult(e, step) {
  if (e?.code === 'READONLY') return say(`${e.message} Tell the user in one line to restart Claude Desktop. ${step}`);
  if (e?.code === 'LOCKED') return say(`Companion's session folder was busy. ${step}`);
  return say(`Companion could not use its session folder (${quote(e?.message ?? e, 200)}). ${step}`);
}

/**
 * @param {object} store  createSession()
 * @param {object} o
 * @param {(name: string) => number} o.waitFor   ms next_sketch waits for a client
 * @param {(name: string, elapsedMs: number, why: string) => void} [o.onCut]  a wait the client cut
 */
export function createMcp(store, { version = EXTENSION_VERSION, waitFor = null, waitMs, onCut = () => {}, log = null } = {}) {
  const server = new McpServer({ name: 'configuration-companion', version }, { instructions: INSTRUCTIONS });
  const cfg = () => store.settings.get().config;
  const clientName = () => server.server.getClientVersion()?.name ?? '';
  const wait = () => (waitFor ? waitFor(clientName()) : waitMs ?? configuredWait(cfg(), clientName()) * 1000);
  server.server.oninitialized = () => {
    const c = server.server.getClientVersion();
    try { store.setClient?.(c, Math.round(wait() / 1000)); } catch { /* best effort */ }
    if (log) log(`Configuration Companion ${version}: client ${c?.name ?? '?'} ${c?.version ?? '?'}, next_sketch waits ${Math.round(wait() / 1000)} s\n`);
  };
  const guard = (step, fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { return failureResult(e, step); }
  };

  server.registerTool('next_sketch', {
    title: 'Take the next sketch from Configuration Companion',
    description: DESCRIPTIONS.next_sketch,
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(STEP.nothing, async (extra) => {
    const token = extra?._meta?.progressToken;
    store.sweep?.(); // a copy killed in its wait tells how long the client allows, before this wait is chosen
    const ms = wait();
    try { store.setClient?.(server.server.getClientVersion(), Math.round(ms / 1000)); } catch { /* best effort */ }
    // COMPANION_DEBUG names a file that a test reads to see what the client sent. People never set it.
    if (process.env.COMPANION_DEBUG) {
      try { appendFileSync(process.env.COMPANION_DEBUG, `${new Date().toISOString()} next_sketch client=${clientName() || '?'} wait=${ms} progressToken=${token === undefined ? 'none' : token}\n`); } catch { /* test aid only */ }
    }
    let beat = null;
    if (token !== undefined) {
      let n = 0;
      beat = setInterval(() => { extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: 'Waiting for a sketch' } }).catch(() => {}); }, PROGRESS_MS);
    }
    try {
      const r = await store.next(ms, extra?.signal);
      if (r.cut) {
        try { onCut(clientName(), r.elapsed, r.cut, ms); } catch { /* learning is best effort */ }
        return say(`${textsOf(cfg()).superseded} ${STEP.superseded}`);
      }
      if (r.sketch) {
        if (extra?.signal?.aborted) { store.untake(r.sketch.number); return say(`${textsOf(cfg()).superseded} ${STEP.superseded}`); }
        return handoverResult(r, store, { cfg: cfg(), version, replyWords: store.replyStates() });
      }
      return say(`${textsOf(cfg()).nothingYet} ${STEP.nothing}`);
    } finally { clearInterval(beat); }
  }));

  // Loose inputs: anything is accepted here and checked in replyResult, so a model's slip gives a text, not -32602.
  const loose = z.union([z.number(), z.string()]).optional();
  server.registerTool('reply', {
    title: 'Answer a sketch',
    description: DESCRIPTIONS.reply,
    inputSchema: {
      number: loose.describe('The sketch number, as the sketch shows.'),
      status: z.string().optional().describe('A status word the sketch names, such as done.'),
      text: z.string().optional().describe('First sentence: what you changed and where, or your one question. Short and plain.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, guard('Call reply again in a moment. If it fails again, tell the user in one line, then call next_sketch.', async (args) => replyResult(store, args, { cfg: cfg() })));

  server.registerTool('get_sketch', {
    title: 'Get a sketch from Configuration Companion',
    description: DESCRIPTIONS.get_sketch,
    inputSchema: { number: loose.describe('Number of an earlier sketch. Leave out for the newest.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guard(STEP.readers, async ({ number }) => {
    store.touch();
    if (number === undefined || number === null || number === '') return getSketchResult(store, undefined);
    const r = sketchRef(number);
    if (!r?.number) return say(`"${quote(number, 40)}" is not a sketch number. Call get_sketch with a number, or call next_sketch.`);
    return getSketchResult(store, r.number);
  }));

  server.registerTool('list_sketches', {
    title: 'List sketches from Configuration Companion',
    description: DESCRIPTIONS.list_sketches,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guard(STEP.readers, async () => { store.touch(); return listSketchesResult(store, cfg().limits.keep); }));

  server.registerTool('clear_session', {
    title: 'Clear the working session',
    description: DESCRIPTIONS.clear_session,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guard('Tell the user in one line, then call next_sketch.', async () => {
    store.touch();
    const n = store.clear();
    return say(`${n ? `Cleared ${n} sketch${n === 1 ? '' : 'es'}.` : 'Nothing to clear.'} New sketches get new numbers. Call next_sketch to go on.`);
  }));

  server.registerPrompt('working-session', {
    title: 'Start working session',
    description: 'Work through the sketches sent from Configuration Companion, one after another.',
  }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: OPENING } }] }));

  server.registerPrompt('companion-sketch', {
    title: 'Companion sketch',
    description: 'Insert the newest sketch sent from Configuration Companion.',
  }, async () => {
    let s;
    try { s = store.get(); } catch { s = null; }
    if (!s) return { messages: [{ role: 'user', content: { type: 'text', text: NONE_YET } }] };
    return {
      description: `Sketch ${s.number}`,
      messages: [
        { role: 'user', content: { type: 'text', text: `${DEFAULT_TEXTS.intro}\n\n${sketchText(s)}` } },
        ...(s.picture?.data ? [{ role: 'user', content: image(s) }] : []),
      ],
    };
  });
  return server;
}
