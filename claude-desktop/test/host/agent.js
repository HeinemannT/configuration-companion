/**
 * A chat that follows only what the server's texts say: it calls the tool the last result names, and replies to the
 * sketch number the result names. It knows one thing besides: the server instructions' "if next_sketch fails or
 * times out, call it again". Anything else it would need is a failure of the texts (invariant I9).
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** The server's fixed refusals of a reply (not changeable by settings). */
const REFUSED = /is not a status for reply|needs a status|needs a text|needs the number|is not in this session|has not been handed|withdrew sketch|could not use|was busy/;
const textOf = (r) => (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

/** The next step a result names. */
export function nextStep(text) {
  const again = /call reply again with number (\d+)/i.exec(text);
  if (again) return { tool: 'reply', number: Number(again[1]), retry: true };
  const reply = /call reply with number (\d+)/i.exec(text);
  if (reply) return { tool: 'reply', number: Number(reply[1]) };
  if (/call next_sketch/i.test(text)) return { tool: 'next_sketch' };
  return null;
}

export class ScriptedAgent {
  /**
   * @param {object} o
   * @param {import('./desktop.js').Manager} o.manager  the copy this chat talks to (Desktop restarts it; the chat stays)
   * @param {import('./ledger.js').Ledger} o.ledger
   */
  constructor({ name, manager, ledger, rng = Math.random, workMs = [50, 400], questions = 0.1, working = 0.1, bad = 0.05, cannot = 0.03, log = () => {} }) {
    Object.assign(this, { name, manager, ledger, rng, workMs, questions, working, bad, cannot, log });
    this.stopped = false;
    this.seq = 0;
    this.lastText = '';
    this.done = null;
    this.calls = 0;
  }
  pick(p) { return this.rng() < p; }
  between([a, b]) { return a + Math.floor(this.rng() * (b - a + 1)); }

  start() { this.done = this.loop(); return this; }
  async stop() { this.stopped = true; await this.done; }

  async call(tool, args) {
    this.calls++;
    const r = await this.manager.call(tool, args);
    if (r.error) { this.ledger.counts.callErrors++; if (r.error === 'timeout') this.ledger.counts.timeouts++; }
    return r;
  }

  async loop() {
    let step = { tool: 'next_sketch' };
    let pending = null; // { number, status } a reply to finish after 'working'
    while (!this.stopped) {
      if (step.tool === 'next_sketch') {
        const r = await this.call('next_sketch', {});
        if (r.error) { await sleep(50); step = { tool: 'next_sketch' }; continue; } // the instructions: call it again
        const text = textOf(r.result);
        this.lastText = text;
        if (/^Nothing yet/.test(text)) this.ledger.counts.nothingYet++;
        if (/replaced by a newer/.test(text)) this.ledger.counts.superseded++;
        const d = this.ledger.delivered(this.name, text);
        const s = nextStep(text);
        if (!s) { this.ledger.violate('I9', `next_sketch result without a next step: ${text.slice(0, 200)}`); step = { tool: 'next_sketch' }; continue; }
        if (s.tool === 'reply') {
          if (!d) { this.ledger.violate('I9', `reply asked without a sketch head: ${text.slice(0, 200)}`); }
          const isAnswer = /This is the user's answer to your question on sketch/.test(text);
          await sleep(this.between(this.workMs));
          let status = 'done';
          if (!isAnswer && this.pick(this.questions)) status = 'question';
          else if (this.pick(this.working)) { status = 'working'; pending = { number: s.number }; }
          else if (this.pick(this.cannot)) status = 'cannot';
          step = { tool: 'reply', number: s.number, status, bad: this.pick(this.bad) };
          continue;
        }
        step = s;
        continue;
      }
      // reply
      const words = step.status === 'question'
        ? `Agent ${this.name} asks on sketch ${step.number}: which card do you mean?`
        : `Agent ${this.name}: sketch ${step.number} ${step.status} #${++this.seq}.`;
      const args = { number: this.pick(0.3) ? String(step.number) : step.number, status: step.bad ? 'completed' : step.status, text: words };
      if (step.bad) this.ledger.counts.badInputs++;
      if (step.status === 'question') this.ledger.counts.questions++;
      const r = await this.call('reply', args);
      if (r.error) {
        // A failed reply: a model would mostly try it again; sometimes it moves on to next_sketch.
        step = this.pick(0.5) ? { ...step, bad: false } : { tool: 'next_sketch' };
        await sleep(50);
        continue;
      }
      const text = textOf(r.result);
      this.lastText = text;
      const ok = !REFUSED.test(text);
      this.ledger.replied(step.number, step.status, words, ok && !step.bad);
      const chain = /recorded for sketch ([\d and]+), whose question it answers/.exec(text);
      if (chain && step.status !== 'question') for (const n of chain[1].split(' and ').map(Number)) this.ledger.closedByChain(n);
      const s = nextStep(text);
      if (!s) { this.ledger.violate('I9', `reply result without a next step: ${text.slice(0, 200)}`); step = { tool: 'next_sketch' }; continue; }
      if (s.tool === 'reply') {
        if (s.retry) { step = { ...step, bad: false }; continue; }
        // "carry on ... call reply with number N again": finish the work, then reply done.
        await sleep(this.between(this.workMs));
        step = { tool: 'reply', number: s.number, status: 'done', bad: false };
        pending = null;
        continue;
      }
      if (pending && step.status === 'working') pending = null;
      step = s;
    }
  }
}
