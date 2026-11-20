# Link protocol (frozen from 0.3.0)

The wire contract between Configuration Companion (the browser extension) and Companion for Claude Desktop
(this server). From 0.3.0 the contract only grows: new fields and new message types, announced in `caps`.
Nothing listed here changes meaning or goes away.

## Rules that never change

- Transport: WebSocket on `127.0.0.1`, ports 47615 to 47619 (the first free one). Text frames of JSON only.
- The browser connects, waits for the server's `hello`, sends one message, reads the answer, closes.
  A socket that sends nothing for 20 s is closed by the server. At most 8 sockets at once; when a ninth
  connects, the oldest one is closed.
- Only pages of a Chrome or Edge extension may connect: `Origin: chrome-extension://<32 letters a-p>`, `Host:
  127.0.0.1:<port>` or `localhost:<port>`. `moz-extension://` is not accepted. When the settings name
  `origins`, only those extension ids may connect.
- Every message carries `v: 1`, for good. A message with another `v` gets `ack` with `ok: false`.
- Receivers ignore fields they do not know. A message type the server does not know gets
  `{type: 'ack', v: 1, ok: false, unknown: true, got: '<the type>', error}`.
- New abilities are announced in `hello.caps`. A browser uses a field or message type only when the server
  lists its cap; a server never requires a field that 0.2.x browsers did not send.
- A message may carry `ref` (string, at most 64 characters). The answer to it carries the same `ref`.
- Times are ISO 8601 strings in UTC. Numbers of sketches are plain integers. `id`s are strings.

## Server to browser: `hello` (first frame on every socket)

```
{ type: 'hello', app: 'configuration-companion-link', v: 1,
  version: '0.3.1',                 // this server's version
  caps: ['id', 'key', 'follows', 'handover', 'drawn', 'requeue', 'withdraw', 'config', 'facts', 'states', 'ref'],
  limits: { text: 65536, picture: 4194304, page: 200, pageKey: 300, handover: 2000, key: 64,
            reply: 4000, config: 16384, keep: 30 },   // bytes for text/picture/config, characters otherwise; reply/keep as in force
  session: 's-…' | null,            // id of the current session, null before the first sketch
  wait: 45,                         // seconds next_sketch waits for this copy's chat client now
  configRev: 0,                     // rev of the settings in force (0: built-in defaults only)
  fmt: 1 }                          // on-disk format this server writes
```

0.2.2 to 0.2.5 sent only `type`, `app`, `v`, `version`; before 0.2.2 no `version`.

## Browser to server

### `sketch`: push one sketch

```
{ v: 1, type: 'sketch',
  text: '…',                        // required, non-empty, at most 64 KB UTF-8
  page: '…', pageKey: '…',          // optional; cut to 200 / 300 characters
  picture: { mime: 'image/png' | 'image/jpeg', data: '<base64>', drawn: true },  // optional; at most 4 MB; drawn optional
  key: 'k-…',                       // cap key: [A-Za-z0-9_-], 1..64. Same key again in this session = the first ack, nothing added
  follows: {                        // cap follows
    answers: 3 | 's…id',            // the sketch whose question this answers (number or id)
    corrects: [ { sketch: 3 | 's…id', marks: [1, 2] } ]   // at most 20 entries, at most 50 marks each, marks 1..999
  },
  handover: { before: '…', after: '…' } }  // cap handover: plain text, each at most 2000 characters
```

Answer, success:

```
{ type: 'ack', v: 1, ok: true, id: 'k3f9…', number: 7, kept: 5, picture: true, queued: 2,
  agent: 'waiting' | 'recent' | 'none', session: 's-…', duplicate: true /* only when the key was seen */ }
```

Answer, refused: `{ type: 'ack', v: 1, ok: false, error: '<one sentence for the user>' }`.

- `follows` without the cap (servers before 0.3.0) is ignored; those servers, and 0.3.0 when `follows` is absent,
  read the brief text instead: a text starting `Answer to sketch N:` answers sketch N; a line holding
  `Correction to sketch N, mark K` corrects mark K of sketch N. This fallback stays.
- `handover.before` is put before the brief, `handover.after` replaces the built-in advice after it. The server
  always ends a hand-over with its own fixed line: `Sketch N: when it is done, or you cannot do it, call reply
  with number N. Then call next_sketch.` `{number}` in `before`/`after` is replaced by the sketch number; nothing
  else is a placeholder.
- A field of the wrong type in `key`, `follows` or `handover` refuses the push with `ok: false`; unknown fields
  inside them are ignored.

### `status`: the session's facts

```
{ v: 1, type: 'status' }
→ { type: 'status', v: 1,
    rev: 1795199411956,             // grows with every change, also when the clock is set back
    agent: 'waiting' | 'recent' | 'none',   // kept for 0.2.x browsers (any copy waiting / a tool call in 10 min / neither)
    session: 's-…' | null, version: '0.3.1', configRev: 0, now: '<server time>', wait: 45,
    waiters: 1,                     // next_sketch calls waiting now, all copies
    lastCallAt: '…' | null,         // newest tool call of any copy
    copies: [ { copy: '1234-ab12cd34', client: 'local-agent-mode-Configuration Companion', alive: true,
                waiting: 1, beatAt: '…', lastCallAt: '…' | null, wait: 45 } ],
    sketches: [ {                   // oldest first: every open sketch, and the newest `keep` sketches
      id: 'k3f9…', number: 7, at: '…', page: '…', pageKey: '…',
      state: 'queued' | 'taken' | 'working' | 'done' | 'question' | 'cannot' | 'withdrawn' | '<settings state>',
      open: true,                   // false: finished (done, cannot, withdrawn, closed settings states)
      word: 'Waiting for review',   // only for a settings state
      rev: 1795199411956,           // this row's rev: grows with every change of the row
      handed: 1,                    // how often it was handed to a chat
      requeued: 0,                  // how often it went back to waiting (Send again, or its taker was gone)
      takenAt: '…', takenBy: { copy, client, alive },  // while taken or working
      reply: { text: '…', at: '…' } } ] }
```

The server gives facts, not judgements: the browser decides from `waiters`, `lastCallAt`, `wait` and `now`
whether a chat is looping, and from `takenAt` and `takenBy.alive` whether a sketch looks stuck.

### `requeue` (cap requeue): Send again

`{ v: 1, type: 'requeue', id: 'k3f9…' }` (or `number: 7`). Any state but `queued`. The sketch goes back to
waiting; its last reply moves into its history; the chat that takes it next is told that it was handed out
before and to check what is already done. Answer: `{ type: 'ack', v: 1, ok: true, id, number, state: 'queued' }`.

### `withdraw` (cap withdraw)

`{ v: 1, type: 'withdraw', id }` (or `number`). Only while `queued`: the sketch becomes `withdrawn` (closed)
and is never handed out. Answer: ack with `ok`, `id`, `number`, `state`.

### `config` (cap config): settings

`{ v: 1, type: 'config', rev: 12, config: { … } }`. The whole settings object, not a patch. Applied when `rev`
(integer, 1 .. 2^53-1) is higher than the rev in force; then written to `<sessions folder>/.config.json`, which
every copy reads again when it changes. Answer: `{ type: 'ack', v: 1, ok: true, rev: <rev in force>, applied: true|false }`,
or `ok: false` with `error` naming the first bad field. A person may also write the file by hand:
`{ "rev": 0, "config": { … } }`.

Settings, every key optional, unknown keys ignored, the whole message at most 16 KB, plain data only:

| key | shape | bounds |
| --- | --- | --- |
| `wait.default` | seconds | 10 .. 600 (built in: 45) |
| `wait.byClient` | `[{ match, seconds }]` | at most 10; `match` 1..60 of `A-Za-z0-9 ._-*`, compared to the chat client's name case-insensitively, `*` any run; first match wins. Built in: `[{ match: 'claude-code', seconds: 100 }]`; given, it replaces the built-in list |
| `texts.<name>` | plain text | at most 1000 characters each; names below |
| `states` | `[{ name, open, word }]` | at most 12; `name` 2..16 of `a-z`, not a built-in state; `open` boolean; `word` 1..24 characters |
| `limits.keep` | sketches listed and kept | 10 .. 500 (30) |
| `limits.keepDays` | days a session folder is kept | 1 .. 90 (7) |
| `limits.replyChars` | longest reply kept | 200 .. 20000 (4000) |
| `limits.sessionHours` | a session ends when its newest record is this old | 1 .. 168 (12) |
| `limits.takenMinutes` | a taken or working sketch with no reply and no `working` for this long goes back to waiting | 2 .. 240 (20) |
| `origins` | extension ids allowed to connect | at most 10, each 32 of `a-p`; empty: any extension. A `config` that sets `origins` must come from one of them |

`texts` names (each replaces the built-in sentence(s); the server's fixed next-step line is always added after):
`nothingYet`, `afterSketch` (advice after the brief), `afterDone`, `afterWorking`, `afterQuestion`,
`pictureNote` (a picture that may be drawn), `drawnNote` (a drawn picture), `handedBefore`, `superseded`,
`intro` (the line on what a sketch is). `{number}` is replaced by the sketch number.

Strings may hold any text but control characters other than line breaks and tabs. Nothing in the settings is
run: no code, no expressions, no paths.

## The chat side (MCP tools), for reference

Tool names and inputs are frozen: `next_sketch()`, `reply(number, status, text)`, `get_sketch(number?)`,
`list_sketches()`, `clear_session()`. Inputs are loose (`number` may be a numeric string, `status` any string)
and checked inside the tool; a bad input gives a normal result that says what to call next, never a protocol
error. Every result ends with the next step. `reply.status`: `done`, `working`, `question`, `cannot`, and the
names of the settings `states`.

## Sessions and numbers

- A session ends only by `clear_session`, or when a sketch arrives and the session's newest record (sketch
  sent, taken, replied) is older than `limits.sessionHours`. Starting or stopping Claude Desktop does not end it.
- Numbers never start again: a new session goes on from the highest number used before (also after a clear).
  `id`s are random, 16 characters `0-9a-f`, made by the server.
- A sketch handed to a chat and not answered is handed again: to the same copy when it calls `next_sketch`
  again (once per take); to any chat when the copy that took it is gone (its process ended, or it gave no
  heartbeat for 10 minutes) and it is still `taken`; to any chat when it was `taken` or `working` for
  `limits.takenMinutes` without a reply.
- `reply` for a sketch never handed out is refused with a text that says to call next_sketch.

## On disk (`fmt: 1`)

`<base>/.current.json` `{fmt, name, id, started, from}`; `<base>/.numbers.json` `{last}`; `<base>/.config.json`;
`<base>/.learned.json` (waits learned per client); `<base>/.bell` (changes on every change); `<base>/.copies/*.json`;
per session `.sketches/<n>.json`, `.keys/<key>`, `.lock`. A copy that meets a `fmt` above 1 only reads.

## Deviations from the review's design.md, and why

1. Liveness and lease are split. A copy is gone when its process has ended (all copies run on one computer, so
   this is checked directly), or when it has not beaten for 10 minutes; a heartbeat file without a process id
   counts as gone after 30 s. Heartbeats come every 10 s, every 1 s while a wait runs, so a killed wait can be
   timed. A computer waking from sleep finds all heartbeats old; checking the process keeps that from handing
   sketches to another chat. That is mechanism and fixed. A `taken` sketch of a gone copy is requeued at once; a
   `working` one is not (the chat said it works on it, and a restarted copy is the normal Desktop case): only
   `limits.takenMinutes` (default 20) without a reply or `working` requeues it. design.md had one
   `leaseSeconds` of 90 s, which would hand a sketch to a second chat while the first still works on it.
2. Adaptive wait floor is 15 s (the build brief), not 10 s. A wait shrinks only after two cuts for the same
   client name whose times lie within 5 s of each other: a timeout cuts at the same time again and again, a
   user's Stop or an app quit does not. A cut is a cancel, a newer next_sketch on the same connection, the
   connection closing, or a copy found dead while it waited (timed by its heartbeat). A learned wait is dropped
   when the settings change that client's wait.
3. Session expiry is lazy: the old session stays readable and its sketches can still be taken until a new
   sketch arrives after the idle time. Nothing is dropped early.
4. Numbers run on across all sessions (`.numbers.json`), not only within the kept window.
5. One short-lived lock file per session serialises state changes (take, reply, requeue, withdraw, the
   requeue scan); a lock whose holder's process has ended is broken at once, any lock older than 5 s too. This replaces the per-sketch claim files of 0.2.x and also
   closes the reply-against-requeue race.
6. `texts` names differ from design.md (`afterSketch`, `afterDone`, `superseded`, `intro` added;
   `reoffered` is `handedBefore`).
7. `ref`, `withdraw`, `open` and `word` in rows, and the `origins` lock-out guard are additions.
8. `moz-extension://` stays refused: the browser extension ships for Chrome and Edge only.
