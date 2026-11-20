# Companion for Claude Desktop

A Claude Desktop extension (`.mcpb`) that receives sketches from Configuration Companion's Point and tell ("Send to Claude"), lines them up, and lets Claude work through them in one chat. It shows Claude's answers back in the browser. It needs nothing else installed: Claude Desktop runs it with its own Node.

From 0.3.0 the installed bundle holds only mechanism (queue, files, socket, tool names and inputs). Texts, waits, extra states and limits are settings that the browser extension or a file can change, so a change of behaviour does not need a new install. `PROTOCOL.md` is the wire contract.

## Use

1. Get the bundle from Companion: Utilities > Claude Desktop > Get the extension saves `configuration-companion-<version>.mcpb`. Install it in Claude Desktop with Settings > Extensions > Advanced settings > Install extension. Files installed this way are never updated by Claude Desktop. (`npm run pack` here builds the same file into `build/`.)
2. In the browser, open Point and tell on a BMP page, draw and comment, press Send to Claude. Press "Start working chat": Claude Desktop opens a new Code session with the opening instruction filled in. Press Enter once.
3. Go on sending from any page. Claude takes the sketches in order and answers; the answers appear in the browser.

Claude Desktop shows two settings for the extension: the sessions folder, and a hand-set wait in seconds (0 lets the extension choose).

## What the host does (measured; the tests encode it)

- Claude Desktop calls an installed extension through an MCP client named `local-agent-mode-<extension name>`, with the SDK's default request timeout of 60 s. Progress notifications do not extend it, and nothing in the manifest or settings raises it. When a call times out, Desktop kills the server process and starts a new one.
- Desktop runs one to three copies at once (separate managers), starts them in the same second, and kills them at any time without clean-up.
- The Claude Code CLI moves a call to the background after 120 s, and progress keeps it alive. Codex gives a call 60 s by default.
- A running chat keeps the tool descriptions and server instructions it read at its start. So they are short and generic, and every tool result says what to do next.
- The host asks a chat for status lines during long waits, and a chat can quietly stop looping; the browser sees that from `lastCallAt` and `waiters` in the status.

## What Claude gets

| Tool | What it does |
| --- | --- |
| `next_sketch` | The next sketch (brief and picture), oldest first, or "Nothing yet" after a wait. Every hand-over ends with `Sketch N: when it is done, or you cannot do it, call reply with number N (status ...). Then call next_sketch.` |
| `reply` | Records Claude's answer: number, status (`done`, `working`, `question`, `cannot`, and settings states), text. Inputs are checked inside: a slip gives a text that says what to call next. |
| `get_sketch`, `list_sketches` | Read a sketch without taking it; list them with their state. |
| `clear_session` | Delete the session's sketches and their files. Numbers go on. |

- Wait: 45 s by default for every client, 100 s for the Claude Code CLI (a settings entry, not code). When a client cuts waits at the same length twice (cancel, a newer call, a closed connection, a copy killed in its wait), later waits for that client name are that length minus 15 s, at least 15 s, kept in `.learned.json`. They never grow by themselves; only the settings set a longer wait.
- A sketch handed to a chat and not answered is handed again, saying so: to the same chat when it calls `next_sketch` again (once), and to any chat when the copy that took it has ended, or after 20 minutes without a reply. "Send again" in the browser does the same on purpose. A `reply` for a sketch never handed out is refused.
- One wait per connection: a newer `next_sketch` ends the older one, which never takes a sketch. A cancelled wait never takes one either.
- A follow-up (an answer to a question, or corrected marks) comes with what Claude needs of the earlier sketch. A reply to an answer also closes the question it answers.

## Files

```
<sessions folder>/                 default: <your user folder>/Configuration Companion/Sessions
  2026-11-20 14-32/                one session, named by its start
    index.md                       the sketches in a table
    01 Supplier risk/              brief.md, picture.png, reply.md
```

- The folder is the session itself, shared by every copy. Names starting with a dot are bookkeeping: `.current.json` (with `fmt: 1`), `.numbers.json`, `.config.json` (settings), `.learned.json`, `.bell`, `.lock`, `.copies/`, and in each session `.sketches/` and `.keys/`.
- A session ends only by `clear_session`, or when a sketch arrives and the session's newest record is older than 12 hours. Starting or quitting Claude Desktop does not end it. Numbers never start again.
- Session folders older than 7 days are deleted when the extension starts; never the current one.
- The files hold page names, object IDs, page addresses and pictures of a company's BMP, and Claude's replies. They stay on this computer.

## Settings

`<sessions folder>/.config.json`, written by the browser extension (a `config` message) or by hand. Every key is optional and checked against a bound; unknown keys are ignored; nothing in it is run. See `PROTOCOL.md` for the table: waits per client name, result texts, extra states, limits, allowed extension ids.

## The link to the browser

- `127.0.0.1` only, port 47615, then 47616 to 47619. WebSocket from Chrome or Edge extension pages only (`Origin: chrome-extension://...`, `Host: 127.0.0.1` or `localhost`). Idle sockets are closed after 20 s; at most 8 at once, the oldest goes first.
- Checks every message: JSON shape, text at most 64 KB, picture PNG or JPEG at most 4 MB, every optional field bounded.
- Nothing goes over the network: sketches go from the browser to this process, and to Claude through Claude Desktop.

## Tests

- `npm test`: unit tests (`test/*.test.js`) and host scenarios (`test/host/scenarios.test.js`): real server processes under a host that behaves like Desktop (`test/host/desktop.js`: the client name, the 60 s timeout, kill and restart on timeout, one to three copies started together, kills at any moment), a scripted chat that follows only the result texts (`agent.js`), and a scripted browser in the 0.2.x and 0.3.0 shapes (`browser.js`). Ports 47700-47790.
- `npm run soak -- --minutes 30`: randomised traffic, settings changes and kills against three copies and two chats with the invariants of `test/host/ledger.js` checked throughout. `--bundle` runs the built bundle.
- `npm run model-run -- --minutes 15`: one headless Claude Code run (haiku) in the loop with a question, a correction and a "Send again". Costs real money.
- Variables for tests only: `COMPANION_PORT`, `COMPANION_PORTS` (a range), `COMPANION_LEARN_SCALE`, `COMPANION_DEBUG`.
