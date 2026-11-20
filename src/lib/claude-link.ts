/**
 * Send to Claude: talk to the Companion desktop extension that Claude Desktop runs on this computer. The worker opens
 * WebSockets to 127.0.0.1 (no host permission needed), reads each listener's hello, picks one copy, sends its
 * messages, reads the answers and closes. Nothing stays open.
 *
 * Claude Desktop can run one to three copies of the desktop extension at once, each on its own port of the range;
 * they share one working session on disk. All ports are asked at once and the newest copy is used (an update leaves
 * an older copy running until Claude Desktop restarts). The port that answered is remembered for the session.
 *
 * The protocol is `v: 1` for good and grows by capabilities: a hello from 0.3.0 on names `caps`, `limits` and the
 * settings revision it holds; a feature is used only when its capability is named. Desktop extensions 0.2.1 to 0.2.5
 * name no capabilities and keep working in the old way. Mirror of claude-desktop/src/protocol.js and PROTOCOL.md.
 */

export const LINK_APP = 'configuration-companion-link';
export const LINK_BASE_PORT = 47615;
export const LINK_PORT_COUNT = 5;
/** The wait for a hello. All ports are asked at once, so this is the most a look costs; a busy copy can take a moment. */
export const LINK_TIMEOUT_MS = 1500;
/** After the hello the listener has the message to keep; the picture can be a few MB. */
export const LINK_ACK_TIMEOUT_MS = 4000;

/** Capabilities a hello can name. Each one switches on one part of the protocol; none is needed for Send to Claude. */
export const CAP = {
  /** A push may carry `key`; a second push with the same key returns the first acknowledgement and keeps nothing. */
  key: 'key',
  /** A push may carry `follows` (what an answer or a correction belongs to), instead of the server reading it from the text. */
  follows: 'follows',
  /** A push may carry `handover` (the text around the brief), which replaces the server's own foot. */
  handover: 'handover',
  /** `{type: 'requeue', id}` puts a sketch nobody works on back in line. */
  requeue: 'requeue',
  /** `{type: 'config', rev, config}` sets the settings (texts, waits, limits). */
  config: 'config',
} as const;
export type Cap = (typeof CAP)[keyof typeof CAP];

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** What one copy said in its hello. */
export interface LinkHello {
  port: number;
  /** Absent before 0.2.2. */
  version?: string;
  /** Empty before 0.3.0. */
  caps: string[];
  /** Largest text (bytes), picture (bytes) and reply (characters) the copy takes, when it says. */
  limits: { text?: number; picture?: number; reply?: number };
  /** The working session's name. */
  session?: string;
  /** How long next_sketch waits for this copy's client, seconds. */
  wait?: number;
  /** The settings revision this copy holds (0: built-in settings). */
  configRev?: number;
}

const posInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? Math.floor(v) : undefined);
const shortText = (v: unknown, max = 120): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** The hello of a Companion listener, or null when the message is not one. */
export function parseHello(msg: Record<string, unknown>, port: number): LinkHello | null {
  if (msg.type !== 'hello' || msg.app !== LINK_APP || msg.v !== 1) return null;
  const caps = Array.isArray(msg.caps) ? (msg.caps as unknown[]).filter((c): c is string => typeof c === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(c)).slice(0, 32) : [];
  const l = msg.limits && typeof msg.limits === 'object' ? msg.limits as Record<string, unknown> : {};
  const limits: LinkHello['limits'] = {};
  const text = posInt(l.text), picture = posInt(l.picture), reply = posInt(l.reply);
  if (text) limits.text = text;
  if (picture) limits.picture = picture;
  if (reply) limits.reply = reply;
  const version = typeof msg.version === 'string' && VERSION_RE.test(msg.version) ? msg.version : undefined;
  const session = shortText(msg.session);
  const wait = posInt(msg.wait, 3600);
  const configRev = typeof msg.configRev === 'number' && Number.isFinite(msg.configRev) && msg.configRev >= 0 ? msg.configRev : undefined;
  return { port, caps, limits, ...(version ? { version } : {}), ...(session ? { session } : {}), ...(wait ? { wait } : {}), ...(configRev !== undefined ? { configRev } : {}) };
}

export const hasCap = (h: Pick<LinkHello, 'caps'> | undefined, cap: Cap): boolean => !!h?.caps.includes(cap);

/** What an answer or a correction belongs to, by the server's sketch id when it is known, else by number. */
export interface SketchFollows {
  answers?: string | number;
  corrects?: Array<{ sketch: string | number; marks: number[] }>;
}

export interface SketchPush {
  text: string;
  page?: string;
  /** Which page it is from (address without noise), so a reply can be shown on that page. */
  pageKey?: string;
  /** `drawn`: Companion drew it from the page because there was no screenshot (servers before 0.2.4 ignore it). */
  picture?: { mime: 'image/png' | 'image/jpeg'; data: string; drawn?: true };
  /** One per send attempt, the same on a retry: a server with `key` keeps the sketch once. */
  key?: string;
  follows?: SketchFollows;
  /** The text around the brief in the hand-over, from Companion's wording (lib/point-tell/desktop-texts.ts). */
  handover?: { before?: string; after?: string };
}

/** The settings Companion gives the desktop extension, with their revision (lib/point-tell/desktop-texts.ts). */
export interface LinkConfig { rev: number; config: Record<string, unknown> }

/** Whether a Claude chat has asked for sketches lately: waiting in next_sketch now, called a tool in the last 10 minutes, or not at all. */
export type LinkAgent = 'waiting' | 'recent' | 'none';

export type LinkResult =
  | {
    ok: true; port: number; number: number; picture: boolean; queued: number; agent: LinkAgent;
    /** The server's id of the sketch (0.3.0 on). */
    id?: string;
    /** The server had this key already: nothing new was kept. */
    dup?: boolean;
    /** An older server without `key`: after a lost answer the sketch was found in its list instead of being sent twice. */
    found?: boolean;
    hello?: LinkHello;
  }
  /**
   * `none`: nothing answered on the range. `refused`: the desktop extension answered and did not keep the sketch.
   * `lost`: the sketch went out and no answer came back, so it may or may not be kept.
   */
  | { ok: false; reason: 'none' | 'refused' | 'lost'; error?: string };

export type SketchState = 'queued' | 'taken' | 'working' | 'done' | 'question' | 'cannot';
const STATES: readonly SketchState[] = ['queued', 'taken', 'working', 'done', 'question', 'cannot'];
const OPEN_STATES: ReadonlySet<SketchState> = new Set(['queued', 'taken', 'working']);

export interface SketchRow {
  /** The server's id (0.3.0 on); numbers alone repeat across working sessions on older servers. */
  id?: string;
  number: number;
  /** ISO time. */
  at: string;
  page: string;
  pageKey: string;
  state: SketchState;
  rev: number;
  reply?: { text: string; at: string };
  /** When the sketch was handed to a chat, and which copy and client took it (0.3.0 on). */
  takenAt?: string;
  takenBy?: { copy?: string; client?: string; alive?: boolean };
  /** The word for a state the settings added, or for `withdrawn` (0.3.0 on). */
  word?: string;
  /** How often it went back to waiting: Send again, or its taker was gone (0.3.0 on). */
  requeued?: number;
}

/** One running copy of the desktop extension, as the status reports it (0.3.0 on). */
export interface CopyFact {
  copy?: string;
  client?: string;
  /** next_sketch calls waiting in this copy now. */
  waiting: number;
  /** The last Companion tool call of its chat (ISO). */
  lastCallAt?: string;
  /** Its last heartbeat (ISO). */
  beatAt?: string;
  /** The server's own reading of the heartbeat: false when the copy is gone. */
  alive?: boolean;
}

export type StatusResult =
  | {
    ok: true; port: number; rev: number; agent: LinkAgent; sketches: SketchRow[];
    /** The desktop extension's version from its hello; absent before 0.2.2. */
    version?: string;
    caps?: string[];
    /** The running copies and their chats (0.3.0 on). */
    copies?: CopyFact[];
    /** next_sketch's wait in seconds, when the server says. */
    wait?: number;
    session?: string;
    /** The settings revision the server holds now (after a push this request made). */
    configRev?: number;
    /** Every copy that answered on the range, with its version. */
    answered?: Array<{ port: number; version?: string }>;
  }
  | { ok: false };

/** The part of a WebSocket that the link uses, so a test can stand in for it. */
export interface LinkSocket {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type LinkSocketFactory = (url: string) => LinkSocket;

export interface SendDeps {
  open?: LinkSocketFactory;
  /** The port that answered before: preferred among copies of the same version. */
  preferred?: number | null;
  basePort?: number;
  count?: number;
  timeoutMs?: number;
  ackTimeoutMs?: number;
  /** Settings to give a copy that holds an older revision (and names `config`). */
  config?: LinkConfig;
}

export const linkPorts = (base = LINK_BASE_PORT, count = LINK_PORT_COUNT): number[] => Array.from({ length: count }, (_, i) => base + i);

/** The ports in the order they are tried: the remembered one, then the range. */
export function portOrder(preferred: number | null | undefined, base = LINK_BASE_PORT, count = LINK_PORT_COUNT): number[] {
  const all = linkPorts(base, count);
  return preferred != null && all.includes(preferred) ? [preferred, ...all.filter(p => p !== preferred)] : all;
}

/** True when version `a` is lower than `b` (both "x.y.z"). An unknown version counts as lower. */
export function versionBelow(a: string | undefined, b: string): boolean {
  if (!a || !VERSION_RE.test(a)) return true;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// ── One connection ─────────────────────────────────────────────────────────────────────────────

type Reader<R> = (msg: Record<string, unknown>) => R | null;
type Asked<R> = { kind: 'answer'; value: R } | { kind: 'lost' };

/** An open connection to one copy, after its hello. Messages go one at a time; each waits for its answer. */
interface Conn {
  hello: LinkHello;
  ask<R>(message: Record<string, unknown>, read: Reader<R>, ms: number): Promise<Asked<R>>;
  close(): void;
}

/** Open one port and wait for Companion's hello. Null when nothing (or something else) is there. */
function connect(port: number, open: LinkSocketFactory, helloMs: number): Promise<Conn | null> {
  return new Promise((resolve) => {
    let ws: LinkSocket;
    try { ws = open(`ws://127.0.0.1:${port}`); } catch { resolve(null); return; }
    let closed = false;
    let pending: { read: Reader<unknown>; done: (a: Asked<unknown>) => void } | null = null;
    let helloTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => shut(), helloMs);
    let got: LinkHello | null = null;
    const shut = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(helloTimer); helloTimer = undefined;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
      const p = pending; pending = null;
      p?.done({ kind: 'lost' });
      if (!got) resolve(null);
    };
    ws.onerror = shut;
    ws.onclose = shut;
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(e.data)) as Record<string, unknown>; } catch { if (!got) shut(); return; }
      if (!got) {
        // Anything else on this port is not Companion's listener, and gets nothing.
        const h = msg && typeof msg === 'object' ? parseHello(msg, port) : null;
        if (!h) { shut(); return; }
        got = h;
        clearTimeout(helloTimer); helloTimer = undefined;
        resolve({
          hello: h,
          ask: <R>(message: Record<string, unknown>, read: Reader<R>, ms: number) => new Promise<Asked<R>>((done) => {
            if (closed) { done({ kind: 'lost' }); return; }
            const timer = setTimeout(() => { if (pending?.done === finish) { pending = null; done({ kind: 'lost' }); } }, ms);
            function finish(a: Asked<unknown>): void { clearTimeout(timer); done(a as Asked<R>); }
            pending = { read: read as Reader<unknown>, done: finish };
            try { ws.send(JSON.stringify({ v: 1, ...message })); } catch { pending = null; finish({ kind: 'lost' }); }
          }),
          close: shut,
        });
        return;
      }
      const p = pending;
      if (!p) return;
      const value = p.read(msg);
      if (value === null) return;
      pending = null;
      p.done({ kind: 'answer', value });
    };
  });
}

/** Newest version first; among the same version the remembered port, then the lower port. */
export function rankCopies<T extends { port: number; version?: string }>(copies: readonly T[], preferred?: number | null): T[] {
  const newer = (a?: string, b?: string): number => {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return versionBelow(a, b) ? 1 : versionBelow(b, a) ? -1 : 0;
  };
  return [...copies].sort((a, b) => {
    const v = newer(a.version, b.version);
    if (v) return v;
    if (a.port === preferred) return -1;
    if (b.port === preferred) return 1;
    return a.port - b.port;
  });
}

/** Ask every port of the range at once; the copies that answered, best first. The caller closes them. */
async function probe(deps: SendDeps): Promise<Conn[]> {
  const open = deps.open ?? ((url: string) => new WebSocket(url) as unknown as LinkSocket);
  const helloMs = deps.timeoutMs ?? LINK_TIMEOUT_MS;
  const conns = (await Promise.all(portOrder(deps.preferred, deps.basePort, deps.count).map(p => connect(p, open, helloMs)))).filter((c): c is Conn => !!c);
  const ranked = rankCopies(conns.map(c => ({ port: c.hello.port, version: c.hello.version, c })), deps.preferred);
  return ranked.map(r => r.c);
}

const closeAll = (conns: readonly Conn[]): void => { for (const c of conns) c.close(); };

const readAck: Reader<Record<string, unknown>> = (msg) => (msg.type === 'ack' ? msg : null);

/** Give the copy Companion's settings when it holds an older revision. Returns the revision it holds afterwards. */
async function giveConfig(conn: Conn, deps: SendDeps): Promise<number | undefined> {
  const have = conn.hello.configRev;
  const cfg = deps.config;
  if (!cfg || !hasCap(conn.hello, CAP.config) || (have ?? 0) >= cfg.rev) return have;
  const a = await conn.ask({ type: 'config', rev: cfg.rev, config: cfg.config }, readAck, deps.ackTimeoutMs ?? LINK_ACK_TIMEOUT_MS);
  if (a.kind === 'answer' && a.value.ok === true) return typeof a.value.rev === 'number' ? a.value.rev : cfg.rev;
  return have;
}

// ── Messages ───────────────────────────────────────────────────────────────────────────────────

const AGENTS: LinkAgent[] = ['waiting', 'recent', 'none'];
const agentOf = (v: unknown): LinkAgent => ((AGENTS as unknown[]).includes(v) ? v as LinkAgent : 'none');
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined);

/** The push as this copy takes it: fields it has no capability for are left out. */
export function pushFor(push: SketchPush, hello: LinkHello): SketchPush {
  const { key, follows, handover, ...rest } = push;
  return {
    ...rest,
    ...(key && hasCap(hello, CAP.key) ? { key } : {}),
    ...(follows && hasCap(hello, CAP.follows) ? { follows } : {}),
    ...(handover && hasCap(hello, CAP.handover) ? { handover } : {}),
  };
}

function ackResult(msg: Record<string, unknown>, hello: LinkHello): LinkResult {
  if (msg.ok !== true) return { ok: false, reason: 'refused', error: typeof msg.error === 'string' ? msg.error : 'The sketch was not kept.' };
  const id = idOf(msg.id);
  return {
    ok: true, port: hello.port, number: Number(msg.number) || 0, picture: msg.picture === true, queued: Number(msg.queued) || 0, agent: agentOf(msg.agent),
    ...(id ? { id } : {}), ...(msg.duplicate === true ? { dup: true } : {}), hello,
  };
}

/** Push a sketch to the best copy. One attempt: a lost answer is reported as `lost`, not retried here. */
export async function sendSketch(push: SketchPush, deps: SendDeps = {}): Promise<LinkResult> {
  const conns = await probe(deps);
  const best = conns[0];
  if (!best) return { ok: false, reason: 'none' };
  closeAll(conns.slice(1));
  try {
    await giveConfig(best, deps);
    const a = await best.ask({ type: 'sketch', ...pushFor(push, best.hello) }, readAck, deps.ackTimeoutMs ?? LINK_ACK_TIMEOUT_MS);
    return a.kind === 'answer' ? ackResult(a.value, best.hello) : { ok: false, reason: 'lost', error: 'No answer.' };
  } finally { best.close(); }
}

function rowOf(r: unknown): SketchRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.number !== 'number' || typeof o.at !== 'string' || typeof o.state !== 'string') return null;
  // A state the settings add (or `withdrawn`) is shown by its word and handled by whether it is still open.
  const known = (STATES as readonly string[]).includes(o.state);
  const state: SketchState = known ? o.state as SketchState : o.open === true ? 'working' : 'done';
  const word = known ? undefined : shortText(o.word, 24) ?? (o.state === 'withdrawn' ? 'Withdrawn' : undefined);
  const id = idOf(o.id);
  const reply = o.reply && typeof o.reply === 'object' && typeof (o.reply as { text?: unknown }).text === 'string'
    ? { text: (o.reply as { text: string }).text, at: String((o.reply as { at?: unknown }).at ?? o.at) } : undefined;
  const by = o.takenBy && typeof o.takenBy === 'object' ? o.takenBy as Record<string, unknown> : null;
  const takenBy = by ? { ...(shortText(by.copy) ? { copy: by.copy as string } : {}), ...(shortText(by.client) ? { client: by.client as string } : {}), ...(typeof by.alive === 'boolean' ? { alive: by.alive } : {}) } : undefined;
  return {
    ...(id ? { id } : {}),
    number: o.number, at: o.at, page: typeof o.page === 'string' ? o.page : '', pageKey: typeof o.pageKey === 'string' ? o.pageKey : '',
    state, rev: Number(o.rev) || 0,
    ...(reply ? { reply } : {}),
    ...(typeof o.takenAt === 'string' ? { takenAt: o.takenAt } : {}),
    ...(takenBy ? { takenBy } : {}),
    ...(word ? { word } : {}),
    ...(typeof o.requeued === 'number' && o.requeued > 0 ? { requeued: o.requeued } : {}),
  };
}

function copyOf(c: unknown): CopyFact | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  return {
    ...(shortText(o.copy) ? { copy: o.copy as string } : {}),
    ...(shortText(o.client) ? { client: o.client as string } : {}),
    waiting: Number(o.waiting) > 0 ? Number(o.waiting) : 0,
    ...(typeof o.lastCallAt === 'string' ? { lastCallAt: o.lastCallAt } : {}),
    ...(typeof o.beatAt === 'string' ? { beatAt: o.beatAt } : {}),
    ...(typeof o.alive === 'boolean' ? { alive: o.alive } : {}),
  };
}

/** The status message as the browser keeps it. */
export function statusOf(msg: Record<string, unknown>, hello: LinkHello): Extract<StatusResult, { ok: true }> {
  const rows = Array.isArray(msg.sketches) ? (msg.sketches as unknown[]).map(rowOf).filter((r): r is SketchRow => !!r) : [];
  const copies = Array.isArray(msg.copies) ? (msg.copies as unknown[]).map(copyOf).filter((c): c is CopyFact => !!c) : undefined;
  const wait = posInt(msg.wait, 3600) ?? hello.wait;
  const session = shortText(msg.session) ?? hello.session;
  return {
    ok: true, port: hello.port, rev: Number(msg.rev) || 0, agent: agentOf(msg.agent), sketches: rows,
    ...(hello.version ? { version: hello.version } : {}),
    caps: hello.caps,
    ...(copies ? { copies } : {}),
    ...(wait ? { wait } : {}),
    ...(session ? { session } : {}),
  };
}

/** Ask the best copy for the sketches of the working session with their states and replies (another copy when it fails). */
export async function fetchStatus(deps: SendDeps = {}): Promise<StatusResult> {
  const conns = await probe(deps);
  try {
    const answered = conns.map(c => ({ port: c.hello.port, ...(c.hello.version ? { version: c.hello.version } : {}) }));
    for (const c of conns) {
      const configRev = await giveConfig(c, deps);
      const a = await c.ask({ type: 'status' }, (m) => (m.type === 'status' ? m : null), deps.ackTimeoutMs ?? LINK_ACK_TIMEOUT_MS);
      if (a.kind !== 'answer') continue;
      const s = statusOf(a.value, c.hello);
      const rev = typeof a.value.configRev === 'number' ? a.value.configRev : configRev;
      return { ...s, ...(rev !== undefined ? { configRev: rev } : {}), answered };
    }
    return { ok: false };
  } finally { closeAll(conns); }
}

export type RequeueResult = { ok: true; number?: number } | { ok: false; reason: 'none' | 'unsupported' | 'refused'; error?: string };

/** "Send again" on a sketch nobody works on: back in line on a server with `requeue`. */
export async function requeueSketch(id: string, deps: SendDeps = {}): Promise<RequeueResult> {
  const conns = await probe(deps);
  const best = conns[0];
  if (!best) return { ok: false, reason: 'none' };
  closeAll(conns.slice(1));
  try {
    if (!hasCap(best.hello, CAP.requeue)) return { ok: false, reason: 'unsupported' };
    const a = await best.ask({ type: 'requeue', id }, readAck, deps.ackTimeoutMs ?? LINK_ACK_TIMEOUT_MS);
    if (a.kind !== 'answer') return { ok: false, reason: 'refused', error: 'No answer.' };
    if (a.value.ok !== true) return { ok: false, reason: 'refused', error: typeof a.value.error === 'string' ? a.value.error : 'Not put back in line.' };
    return { ok: true, ...(typeof a.value.number === 'number' ? { number: a.value.number } : {}) };
  } finally { best.close(); }
}

/**
 * A send that survives a lost answer. A server with `key` gets the same push again (it keeps the sketch once). An older
 * one is asked for its list first: a row from this page made since the send started is the sketch, and nothing goes
 * twice. `retry`: this is the page's second try after the worker gave no answer at all (the worker may have stopped
 * mid-send), so the list is looked at before anything is sent.
 */
export async function deliverSketch(push: SketchPush, deps: SendDeps = {}, opts: { retry?: boolean; since?: number } = {}): Promise<LinkResult> {
  const since = opts.since ?? Date.now();
  const find = async (): Promise<LinkResult | null> => {
    const st = await fetchStatus(deps);
    if (!st.ok || st.caps?.includes(CAP.key)) return null;
    const mine = st.sketches.filter(r => r.pageKey === (push.pageKey ?? '') && Date.parse(r.at) >= since - 2000);
    const r = mine.sort((a, b) => b.number - a.number)[0];
    return r ? { ok: true, port: st.port, number: r.number, picture: !!push.picture, queued: st.sketches.filter(x => x.state === 'queued').length, agent: st.agent, found: true, ...(r.id ? { id: r.id } : {}) } : null;
  };
  if (opts.retry) { const f = await find(); if (f) return f; }
  const first = await sendSketch(push, deps);
  if (first.ok || first.reason !== 'lost') return first;
  const f = await find();
  if (f) return f;
  const again = await sendSketch(push, deps);
  return again.ok || again.reason !== 'none' ? again : first;
}

// ── Versions and words ─────────────────────────────────────────────────────────────────────────

/**
 * The desktop extension this build ships (claude-setup/configuration-companion.mcpb, packed from claude-desktop/ by
 * the build). Mirror of claude-desktop/manifest.json; a test keeps them equal.
 */
export const DESKTOP_EXTENSION_VERSION = '0.3.1';
/** The name the shipped file is saved under. */
export const DESKTOP_BUNDLE_NAME = `configuration-companion-${DESKTOP_EXTENSION_VERSION}.mcpb`;

/**
 * The oldest desktop extension Send to Claude works with. 0.2.2 is the first that says its version; 0.2.0 kept the
 * session in one copy's memory, so with the two copies Claude Desktop starts a sketch could reach a copy no chat
 * used, and 0.2.1 cannot be told apart from it. Everything newer works; newer features need their capability.
 */
export const DESKTOP_MIN_VERSION = '0.2.2';

/** "Update" is offered only below the minimum, or when something in use needs a capability the copy lacks. */
export function needsUpdate(version: string | undefined, caps: readonly string[] = [], needed: readonly Cap[] = []): boolean {
  return versionBelow(version, DESKTOP_MIN_VERSION) || needed.some(c => !caps.includes(c));
}

/** What a state is called in the dock. */
export const STATE_WORDS: Record<SketchState, string> = {
  queued: 'Waiting for Claude', taken: 'Claude has it', working: 'Working', done: 'Done', question: 'Question', cannot: 'Could not',
};

export const isOpenState = (s: SketchState): boolean => OPEN_STATES.has(s);

/** For each sketch number, the newest reply revision the user has looked at. */
export type Seen = Record<string, number>;

/** A sketch Claude has answered since the user last looked at it. */
export const isNews = (r: SketchRow, seen: Seen): boolean => !!r.reply && r.rev > (seen[String(r.number)] ?? 0);

/** The picture's size after it is scaled to fit `maxEdge` on the long side (never enlarged). */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
