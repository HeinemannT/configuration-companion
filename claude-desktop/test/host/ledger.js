/**
 * What the harness saw, and the invariants it checks:
 *  I1  numbers and ids never collide: one id per number, one number per id, across the whole run
 *  I2  a sketch closed by a reply is never handed out again unless the browser sent it again
 *  I3  every hand-out after the first says the sketch was handed out before
 *  I4  nothing is handed out that was not pushed
 *  I5  every pushed sketch ends closed (checked at the end, after a quiet time)
 *  I6  a reply lands on the sketch it names
 *  I7  the status from every copy agrees
 *  I8  no call reaches the host's timeout
 *  I9  every result has a next step the agent can follow
 *  I10 a push key gives one sketch
 */
const HEAD = /^Sketch (\d+) \(id ([0-9a-f]{16})\)/;
const NOTE = /handed out before|You took this sketch/;

export class Ledger {
  constructor() {
    this.byId = new Map();      // id -> { number, key, pushes, deliveries: [], replies: [], closedAt, requeuedAt: [], withdrawn }
    this.byNumber = new Map();  // number -> id
    this.byKey = new Map();     // key -> id
    this.violations = [];
    this.unacked = new Set();  // ids handed out before their push was acknowledged
    this.counts = { pushes: 0, duplicatePushes: 0, droppedPushes: 0, oldShapePushes: 0, deliveries: 0, redeliveries: 0, replies: 0, badInputs: 0, questions: 0, answers: 0, corrections: 0, requeues: 0, withdrawals: 0, configs: 0, kills: 0, restarts: 0, timeouts: 0, statusChecks: 0, nothingYet: 0, superseded: 0, callErrors: 0 };
  }
  violate(code, detail) { if (this.violations.length < 200) this.violations.push({ code, at: new Date().toISOString(), detail }); }
  entry(id) {
    let e = this.byId.get(id);
    if (!e) { e = { id, number: null, key: null, pushes: 0, deliveries: [], replies: [], closedAt: 0, requeuedAt: [], withdrawn: false }; this.byId.set(id, e); }
    return e;
  }
  link(id, number) {
    const e = this.entry(id);
    if (e.number !== null && e.number !== number) this.violate('I1', `id ${id} had number ${e.number}, now ${number}`);
    e.number = number;
    const other = this.byNumber.get(number);
    if (other && other !== id) this.violate('I1', `number ${number} has ids ${other} and ${id}`);
    this.byNumber.set(number, id);
    return e;
  }
  pushed(ack, { key, shape = 'new' } = {}) {
    this.counts.pushes++;
    if (shape === 'old') this.counts.oldShapePushes++;
    if (!ack?.ok) return;
    const e = this.link(ack.id, ack.number);
    e.pushes++;
    this.unacked.delete(ack.id);
    if (key) {
      const was = this.byKey.get(key);
      if (was && was !== ack.id) this.violate('I10', `key ${key} gave ${was} and ${ack.id}`);
      this.byKey.set(key, ack.id);
      e.key = key;
    }
    if (ack.duplicate) this.counts.duplicatePushes++;
  }
  /** A next_sketch result. Returns the parsed hand-over or null. */
  delivered(agent, text) {
    const m = HEAD.exec(text);
    if (!m) return null;
    const number = Number(m[1]), id = m[2];
    // A hand-out can reach the harness before the push's ack reaches the browser: I4 is checked at the end.
    if (!this.byId.get(id)?.pushes) this.unacked.add(id);
    const e = this.link(id, number);
    const noted = NOTE.test(text);
    const lastRequeue = e.requeuedAt.at(-1) ?? 0;
    // 200 ms grace: a hand-out made just before a reply from another chat can reach the harness just after it.
    if (e.closedAt && e.closedAt > lastRequeue && Date.now() - e.closedAt > 200) this.violate('I2', `sketch ${number} handed again to ${agent} after it was closed, no Send again since`);
    if (e.deliveries.length && !noted) this.violate('I3', `sketch ${number} handed a ${e.deliveries.length + 1}. time to ${agent} without saying so`);
    if (e.deliveries.length) this.counts.redeliveries++;
    e.deliveries.push({ agent, at: Date.now(), noted });
    this.counts.deliveries++;
    return { number, id, noted, entry: e };
  }
  replied(number, status, words, ok) {
    this.counts.replies++;
    if (!ok) return;
    const id = this.byNumber.get(number);
    if (!id) { this.violate('I6', `reply recorded for sketch ${number}, which no ack or hand-out named`); return; }
    const e = this.entry(id);
    e.replies.push({ status, words, at: Date.now() });
    if (status === 'done' || status === 'cannot') e.closedAt = Date.now();
  }
  closedByChain(number) { const id = this.byNumber.get(number); if (id) this.entry(id).closedAt = Date.now(); }
  requeued(id) { this.counts.requeues++; const e = this.entry(id); e.requeuedAt.push(Date.now()); e.closedAt = 0; }
  withdrawn(id) { this.counts.withdrawals++; this.entry(id).withdrawn = true; }

  /** I7: rows of copies that answered with the same rev must be equal. */
  compareCopies(all) {
    this.counts.statusChecks++;
    const byRev = new Map();
    const rowOf = (r) => JSON.stringify([r.number, r.state, r.rev, r.reply?.text ?? null]);
    for (const { port, status } of all) {
      const rows = new Map(status.sketches.map(r => [r.id, rowOf(r)]));
      const k = String(status.rev);
      const was = byRev.get(k);
      if (was) {
        // Every sketch both list must be the same. Which closed ones are listed follows limits.keep, and a copy
        // reads changed settings within a second, so the lists may differ in length only while settings change.
        for (const [id, row] of rows) if (was.rows.has(id) && was.rows.get(id) !== row) this.violate('I7', `copies on ports ${was.port} and ${port} disagree on sketch ${id} at rev ${k}`);
        if (was.configRev === status.configRev && was.rows.size !== rows.size) this.violate('I7', `copies on ports ${was.port} and ${port} list ${was.rows.size} and ${rows.size} sketches at rev ${k}`);
      }
      if (!was) byRev.set(k, { port, rows, configRev: status.configRev });
      if (status.session && all.some(o => o.status.rev === status.rev && o.status.session !== status.session)) this.violate('I7', `copies disagree on the session at rev ${k}`);
    }
  }

  /** I5 and I6 at the end, from one status. */
  finalCheck(status) {
    for (const id of this.unacked) this.violate('I4', `sketch ${this.byId.get(id)?.number} (${id}) was handed out but no push was acknowledged with it`);
    const rows = new Map((status?.sketches ?? []).map(r => [r.id, r]));
    for (const e of this.byId.values()) {
      if (!e.pushes || e.withdrawn) continue;
      const r = rows.get(e.id);
      if (!r) { if (e.deliveries.length === 0) this.violate('I5', `sketch ${e.number} is not in the status and was never handed out`); continue; }
      if (r.open) this.violate('I5', `sketch ${e.number} is still ${r.state} at the end (handed ${r.handed}, requeued ${r.requeued})`);
      const last = e.replies.at(-1);
      if (last && r.reply && r.reply.text !== last.words && !/^In sketch \d+: /.test(r.reply.text)) {
        this.violate('I6', `sketch ${e.number} shows reply "${r.reply.text.slice(0, 60)}", the last one sent was "${last.words.slice(0, 60)}"`);
      }
    }
  }
  summary() {
    return { ...this.counts, sketches: this.byId.size, violations: this.violations.length };
  }
}
