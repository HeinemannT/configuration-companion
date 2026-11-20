// Used by shared.test.js: one more copy on the same folder, in its own process. It takes sketches until the queue
// stays empty, answers each, then prints the numbers it got as JSON.
import { createSession } from '../src/session.js';

const [base, idleMs] = process.argv.slice(2);
const store = createSession({ base });
const got = [];
process.stdout.write('ready\n');
for (;;) {
  const r = await store.next(Number(idleMs));
  if (!r.sketch) break;
  got.push(r.sketch.number);
  store.reply(r.sketch.number, 'done', `taken by ${process.pid}`);
}
store.close();
process.stdout.write(`${JSON.stringify(got)}\n`);
