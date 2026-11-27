/**
 * Request class of a BMP command post: started by a user action, or
 * background work (badge loading, health and recovery probes, cache refresh).
 *
 * The transport sends one post at a time. A waiting user post goes ahead of
 * every waiting background post; a post already in flight is never
 * interrupted. Background posts also get a shorter timeout.
 *
 * The class rides on the AbortSignal that every read already threads through
 * the client, so a call site marks its work without new parameters on each
 * layer in between: `client.batchEnrich(rids, backgroundSignal({ supersede }))`.
 * A post without a marked signal is a user post.
 *
 * Within the user class a post can be marked low (`lowPrioritySignal`): long
 * user work made of many posts (the code search listing and its reads). A
 * waiting user post goes ahead of a waiting low one, so opening an object or
 * a picker query during a listing goes between two of its posts instead of
 * after the whole listing. Low posts still go ahead of background posts.
 */

export type RequestClass = 'user' | 'background';

/** Upper bound for one background post. A user post keeps its own timeout. */
export const BACKGROUND_TIMEOUT = 10_000;

interface BackgroundMark {
  /** Aborting it removes a waiting post from the queue. A post in flight is
   *  not interrupted: its answer arrives and the caller discards it. */
  supersede?: AbortSignal;
  /** Background work the user asked for (Make a copy or Resume of
   *  the local code copy): paced, budgeted and stopped by an overload as
   *  background work, but the script gauge never refuses it
   *  (load-governor rule 6). A Refresh of a built copy is user work at low
   *  priority (lowPrioritySignal), not this. */
  asked?: boolean;
}

const marks = new WeakMap<AbortSignal, BackgroundMark>();

/**
 * A signal that marks every post made with it as background work.
 * `signal` cancels the work at any time, as any caller signal does.
 * `supersede` only removes posts that are still waiting in the queue.
 * `asked`: the user asked for this work (see BackgroundMark.asked).
 */
export function backgroundSignal(options: { signal?: AbortSignal; supersede?: AbortSignal; asked?: boolean } = {}): AbortSignal {
  const out = options.signal ? AbortSignal.any([options.signal]) : new AbortController().signal;
  marks.set(out, { supersede: options.supersede, ...(options.asked ? { asked: true } : {}) });
  return out;
}

/** Is a post made with `signal` background work the user asked for? */
export function isAskedByUser(signal: AbortSignal | undefined): boolean {
  return !!(signal && marks.get(signal)?.asked);
}

/** For work shared by several callers (a one-time probe): keep the class of
 *  `signal` but not its cancellation, so one caller cannot cancel the others. */
export function inheritClass(signal: AbortSignal | undefined): AbortSignal | undefined {
  // A probe the user's copy started stays work the user asked for: the
  // script gauge must not refuse it and so fail the copy.
  const c = requestClassOf(signal);
  return c.requestClass === 'background' ? backgroundSignal(c.asked ? { asked: true } : {}) : undefined;
}

/** A user action now waits on work that started as background (a hover
 *  prefetch that the following open joins). Every later post made with
 *  `signal` is a user post, and a post of it still waiting in the queue is
 *  sent as one too. Its supersede signal no longer removes it. */
export function promoteToUser(signal: AbortSignal): void {
  marks.delete(signal);
}

const low = new WeakSet<AbortSignal>();

/** A signal that marks every post made with it as low-priority user work
 *  (see the file comment). `signal` cancels it as usual; a background mark
 *  on it is kept. */
export function lowPrioritySignal(signal?: AbortSignal): AbortSignal {
  const out = signal ? AbortSignal.any([signal]) : new AbortController().signal;
  const mark = signal ? marks.get(signal) : undefined;
  if (mark) marks.set(out, mark);
  low.add(out);
  return out;
}

/** Is a post made with `signal` low-priority work? */
export function isLowPriority(signal: AbortSignal | undefined): boolean {
  return !!signal && low.has(signal);
}

const queueWaits = new WeakMap<AbortSignal, number>();

/** The transport notes how long a post made with `signal` waited in its lane
 *  before it was sent: behind other posts and held by the load governor. */
export function noteQueueWait(signal: AbortSignal | undefined, ms: number): void {
  if (!signal || !(ms > 0)) return;
  queueWaits.set(signal, (queueWaits.get(signal) ?? 0) + ms);
}

/** Milliseconds the posts made with `signal` waited in the lane so far. The
 *  difference around a call is that call's waiting, not the server's time
 *  (code-search listGroups sizes its posts by the server's time). */
export function queueWaitOf(signal: AbortSignal | undefined): number {
  return signal ? queueWaits.get(signal) ?? 0 : 0;
}

export function requestClassOf(signal: AbortSignal | undefined): { requestClass: RequestClass; supersede?: AbortSignal; asked?: boolean } {
  const mark = signal ? marks.get(signal) : undefined;
  return mark ? { requestClass: 'background', supersede: mark.supersede, ...(mark.asked ? { asked: true } : {}) } : { requestClass: 'user' };
}
