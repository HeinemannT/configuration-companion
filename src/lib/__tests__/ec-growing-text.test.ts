/**
 * A ratchet on Extended Code scripts that append rows straight to one result text
 * (`_r := _r + …`, `_out := _out + …`, `appendRowEc('_r', …)`).
 *
 * The server copies the left operand of every text `+`, so a script that loops over N objects and
 * appends each row to one growing text costs N squared. The files below were looked at for that.
 * Most loop over one object's parts, are capped inside the script (`.first(n)`, a counter) or collect rows in
 * a short chunk first (ec-parser.ts). The large listings (code index, code search, transport)
 * join their rows per type, so their result grows once per type.
 *
 * This test fails when a file gains such a line or a new file has one. Before raising a number:
 * build the rows with `list.calculate( … row )` and `.join("")` (linear),
 * or cap the loop in the script, and say in a comment what bounds it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GROWING = /_(r|out) := _(r|out) \+|appendRowEc\('_(r|out)'/;

/** Lines per file as counted. Lower a number when lines go; do not raise one without
 *  the check described above. */
const REVIEWED: Record<string, number> = {
  'src/lib/access-workspace/read.ts': 1,
  'src/lib/bmp-type-knowledge.ts': 3,
  'src/lib/browse-tree.ts': 1,
  'src/lib/code-index-sync.ts': 4, // one of them appends once per type
  'src/lib/code-scope-read.ts': 2, // one of them appends once per type
  'src/lib/compare-read.ts': 6,
  'src/lib/connections.ts': 2,
  'src/lib/ec-codegen.ts': 2,
  'src/lib/ec-guards.ts': 1,
  'src/lib/ec-parser.ts': 1,
  'src/lib/ec-query-service.ts': 7,
  'src/lib/handlers/ai-tools.ts': 1,
  'src/lib/handlers/objects.ts': 1,
  'src/lib/handlers/studio.ts': 1,
  'src/lib/layout/blast-radius.ts': 2,
  'src/lib/layout/portable-ids.ts': 1,
  'src/lib/layout/sync.ts': 20,
  'src/lib/object-structure.ts': 2,
  'src/lib/ref-rid.ts': 1,
  'src/lib/transport-bundle.ts': 2,
  'src/lib/transport-patch.ts': 24,
  'src/lib/transport-read.ts': 2,
  'src/lib/transport-undo.ts': 4,
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? (e.name === '__tests__' ? [] : sources(join(dir, e.name)))
    : (/\.(ts|js)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []));
}

describe('Extended Code scripts that grow one result text', () => {
  it('no file has more such lines than were counted', () => {
    const over: string[] = [];
    for (const file of sources('src')) {
      const key = file.split('\\').join('/');
      const n = readFileSync(file, 'utf8').split('\n').filter(l => GROWING.test(l)).length;
      if (n > (REVIEWED[key] ?? 0)) over.push(`${key}: ${n} (counted: ${REVIEWED[key] ?? 0})`);
    }
    expect(over, 'See the comment at the top of this test before changing the numbers.').toEqual([]);
  });
});
