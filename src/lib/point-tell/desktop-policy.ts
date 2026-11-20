/**
 * What Companion tells the agent in Claude Desktop, and the settings it gives the desktop extension. The installed
 * desktop extension keeps only mechanism (queue, files, socket, tool names); the words an agent reads in tool results
 * and the timing come from here, so a change to them ships with the browser extension and needs no reinstall.
 *
 *   per sketch    the hand-over text around the brief (`handover.before/after`) and what it follows (`follows`)
 *   settings      texts of the tool results, the wait per client, limits; given with a revision (`config` message)
 *   opening       the first message of a working chat (Start working chat, claude://code/new?q=)
 *
 * Written for an agent that has real BMP tools in the same chat: short sentences, one instruction each, and every
 * text says what to do next. Plain text only, no Markdown. Pure: no DOM, no chrome.
 */
import type { LinkConfig, SketchFollows } from '../claude-link';

/** The settings revision. Raise it with every change below; the desktop extension keeps the highest it was given. */
export const CONFIG_REV = 2026112002;

/** The picture that goes with a sketch: at most this long on its long side, and PNG only up to this size (else JPEG). */
export const PICTURE = { maxEdge: 1568, maxPngBytes: 900_000 } as const;

/** A working loop, as every hand-over and the opening state it. */
export const LOOP_RULES =
  'After reply, call next_sketch again. When next_sketch says "Nothing yet", call it again at once. Write nothing to the user for an empty wait, unless the app asks for a status line: then write one short line. '
  + 'If a call fails or times out, call next_sketch again. Do not stop by yourself. Stop only when the user tells you to stop.';

/** What the agent does with one sketch: put after the brief in every hand-over. */
export const HANDOVER_AFTER = [
  'Do what the sketch asks in BMP with your BMP tools.',
  'When you are finished, call reply with status done and one short sentence: what you changed and where (object name and ID). The user reads this sentence on the page, next to the drawing.',
  'If something is unclear, do not guess. Call reply with status question and one question the user can answer in one sentence.',
  'If you cannot do it, call reply with status cannot and say why in one sentence.',
  'If the work takes more than 5 minutes, call reply with status working and one line about the progress, then continue.',
  LOOP_RULES,
].join('\n');

/**
 * The hand-over text around the brief (each part at most 2000 characters). Only `after`: an answer or a correction
 * needs no words of its own here, since the desktop extension puts what it follows (the earlier sketch's marks and
 * reply) before the brief from `follows`, and a sketch sent again says so in its brief. The desktop extension then
 * adds its version and its fixed line "Sketch N: when it is done, or you cannot do it, call reply with number N".
 */
export function handoverFor(): { before?: string; after: string } {
  return { after: HANDOVER_AFTER };
}

/** `follows` as the desktop extension takes it: by the server's id when Companion has one, else by number. */
export function followsOf(answers?: { id?: string; number: number }, corrects: ReadonlyArray<{ id?: string; number: number; marks: readonly number[] }> = []): SketchFollows | undefined {
  const f: SketchFollows = {
    ...(answers ? { answers: answers.id ?? answers.number } : {}),
    ...(corrects.length ? { corrects: corrects.map(c => ({ sketch: c.id ?? c.number, marks: [...c.marks] })) } : {}),
  };
  return f.answers !== undefined || f.corrects ? f : undefined;
}

/**
 * The texts of the tool results, by the names the desktop extension knows (claude-desktop/PROTOCOL.md). Each replaces
 * the built-in sentence; the desktop extension adds its fixed next step after it ("Call next_sketch again now.",
 * "Call next_sketch now.", the reply line), so these texts do not say it again. `{number}` is the sketch number.
 * `handedBefore` follows the desktop extension's own lead ("This sketch was handed out before, last at 14:02.").
 */
export const RESULT_TEXTS = {
  intro: 'A sketch is a change request for a Corporater BMP page. The user drew and wrote it on the live page in Configuration Companion. Do the work with your BMP tools. The Companion tools only deliver sketches and record your replies.',
  nothingYet: 'Nothing yet. Write nothing to the user, unless the app asks for a status line: then write one short line. Only the user ends this loop.',
  afterSketch: HANDOVER_AFTER,
  afterDone: 'Recorded.',
  afterQuestion: 'Recorded. The user sees your question next to the drawing and answers there. The answer comes back through next_sketch as a new sketch. If the user answers in this chat instead, continue with sketch {number}.',
  afterWorking: 'Recorded. Continue with sketch {number}.',
  pictureNote: 'If the picture is drawn from the page layout and not a screenshot, values in it can be cut short. Take names and IDs from the text.',
  drawnNote: 'The picture is drawn from the page layout, not a screenshot. Values in it can be cut short. Take names and IDs from the text.',
  handedBefore: 'It got no reply; the first hand-over may also have been lost on the way. Check in BMP what is already done before you change anything.',
} as const;

/**
 * How long next_sketch waits for a sketch, by the client's name. Claude Desktop gives up on a tool call after about 60 s
 * and restarts the extension, so its wait stays well under that; the Claude Code CLI moves a call to the background
 * after 120 s.
 */
export const WAIT = { default: 45, byClient: [{ match: 'claude-code', seconds: 100 }] } as const;

/**
 * Sketches kept and for how long (days), the longest reply, when a quiet session ends (hours), and when a taken sketch
 * with no reply goes back in line by itself (minutes).
 */
export const LIMITS = { keep: 30, keepDays: 7, replyChars: 4000, sessionHours: 12, takenMinutes: 20 } as const;

/** The settings message's content. */
export const DESKTOP_CONFIG: LinkConfig = {
  rev: CONFIG_REV,
  config: { texts: { ...RESULT_TEXTS }, wait: { default: WAIT.default, byClient: WAIT.byClient.map(c => ({ ...c })) }, limits: { ...LIMITS } },
};

/** The first message of a working chat: the loop, and what to do with each sketch. */
export const WORKING_CHAT_OPENING =
  'Work through my Configuration Companion sketches. Call next_sketch. For each sketch: do what it asks in BMP, '
  + 'then call reply with the sketch number. ' + LOOP_RULES;

/** Claude Desktop's link that opens a new Code session with the text filled in (not sent): that is where BMP work can be done. */
export const workingChatLink = (): string => `claude://code/new?q=${encodeURIComponent(WORKING_CHAT_OPENING)}`;
