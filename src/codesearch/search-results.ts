/**
 * The results of one search in the code search window. One scan gives every
 * matching row (identity, counts, the matched lines and the lines around
 * them); the window keeps them for that query and shows them a page at a
 * time, so "Show more" never searches again. While a live scan runs, the
 * rows found so far stand in (unsorted, instances not yet folded), with the
 * scan's progress; the complete, sorted answer replaces them when it ends.
 * No DOM.
 */

import { runCodeSearch, type CodeSearchHit, type CodeSearchOptions, type CodeSearchOutcome, type CodeSearchProgress, type CodeSearchRequest, type CodeSearchSource } from '../lib/code-search';

/** Rows shown at first and added by each "Show more". */
export const PAGE_ROWS = 200;
/** A search asks for every row: the window pages through them itself. */
export const ALL_ROWS = 1_000_000;

export class ResultList {
  private rows: CodeSearchHit[] = [];
  private partial: CodeSearchHit[] = [];
  private shownRows: number;
  private cache: CodeSearchHit[] | null = null;
  outcome?: CodeSearchOutcome;
  progress?: CodeSearchProgress;

  constructor(shown = PAGE_ROWS) { this.shownRows = Math.max(PAGE_ROWS, shown); }

  /** Rows found so far by a running live scan. */
  addPartial(hits: readonly CodeSearchHit[], progress?: CodeSearchProgress): void {
    if (progress) this.progress = progress;
    if (!hits.length) return;
    this.partial.push(...hits);
    if (!this.rows.length) this.cache = null;
  }

  /** Rows of the complete answer (they arrive in order, in groups). */
  addRows(hits: readonly CodeSearchHit[]): void {
    if (!hits.length) return;
    this.rows.push(...hits);
    this.cache = null;
  }

  /** The search ended: the outcome says whether more rows than shown exist. */
  finish(outcome: CodeSearchOutcome): CodeSearchOutcome {
    this.partial = [];
    this.progress = undefined;
    this.cache = null;
    this.outcome = { ...outcome, more: this.rows.length > this.shownRows };
    return this.outcome;
  }

  /** The next page, from the rows already here. Returns the rows added. */
  showMore(): number {
    const before = this.hits.length;
    this.shownRows += PAGE_ROWS;
    this.cache = null;
    if (this.outcome) this.outcome = { ...this.outcome, more: this.rows.length > this.shownRows };
    return this.hits.length - before;
  }

  get shown(): number { return this.shownRows; }
  get total(): number { return this.rows.length; }

  /** What the window shows: the complete rows a page at a time, or, while a
   *  live scan runs, the rows found so far. The same array until it changes. */
  get hits(): CodeSearchHit[] {
    if (!this.cache) this.cache = this.rows.length || this.outcome ? this.rows.slice(0, this.shownRows) : [...this.partial];
    return this.cache;
  }
}

/** A search over a local source (the index): every row in one run. */
export async function runAll(req: CodeSearchRequest, source: CodeSearchSource, list: ResultList, opts: CodeSearchOptions = {}): Promise<CodeSearchOutcome> {
  const outcome = await runCodeSearch({ ...req, offset: 0, limit: ALL_ROWS }, source, hits => list.addRows(hits), opts);
  return list.finish(outcome);
}
