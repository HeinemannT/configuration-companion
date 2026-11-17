/**
 * One word for the local code copy: every string the code search window and
 * the side panel show (and the modules that write their sentences) says
 * "copy", never "index". Internal names stay: message types (CODE_INDEX_*),
 * module and storage names, log categories (`codeIndex:sync`) and the
 * search source kind 'index' are identifiers, not words the user reads.
 *
 * The scan reads every string literal of the source (TypeScript's parser;
 * the text and attributes of HTML) and flags each one that holds the word,
 * except the identifiers listed in ALLOWED.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..', '..');

/** The windows and the modules that write their sentences about the copy. */
const SCANNED = [
  'src/codesearch', 'src/sidepanel',
  'src/lib/code-index-service.ts', 'src/lib/code-copy.ts', 'src/lib/code-index-store.ts', 'src/lib/used-in-code.ts',
  'src/lib/coverage-line.ts', 'src/lib/object-search.ts', 'src/lib/object-search-sources.ts', 'src/lib/object-picker.ts',
];

/** Strings with the word that no one reads as a word, with why. */
const ALLOWED: Array<{ file: string; text: string; why: string }> = [
  { file: 'src/codesearch/codesearch.ts', text: 'index', why: 'the search source kind (CodeSearchSource kind), compared in code' },
  { file: 'src/lib/code-index-store.ts', text: 'crev-code-index', why: 'the IndexedDB database name (persisted)' },
  ...['src/lib/coverage-line.ts', 'src/lib/used-in-code.ts', 'src/lib/object-search.ts'].map(file => ({ file, text: 'index', why: 'the coverage kind (Coverage kind), compared in code' })),
];

const WORD = /\bindex(?:es|ed|ing)?\b/i;

function files(path: string): string[] {
  const abs = join(ROOT, path);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter(f => /\.(ts|html)$/.test(f) && !/(^|[\\/])__tests__[\\/]/.test(f) && !/\.test\.ts$/.test(f))
    .map(f => join(abs, f));
}

/** The string literals of TypeScript source (template literals by their
 *  fixed parts), read with the TypeScript parser: comments and regular
 *  expressions are not strings. */
export function literals(src: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    // Module paths are not text.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportTypeNode(n) || (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) { out.push(n.head.text); for (const span of n.templateSpans) out.push(span.literal.text); }
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true));
  return out;
}

/** HTML text: the source with tags' attribute values and text nodes. */
function htmlStrings(src: string): string[] {
  const noComments = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  return [...noComments.split(/<[^>]*>/), ...[...noComments.matchAll(/="([^"]*)"/g)].map(m => m[1])];
}

describe('the local code copy is called a copy', () => {
  it('no string shown in the code search window or the side panel says "index" for it', () => {
    const found: string[] = [];
    for (const path of SCANNED) {
      for (const f of files(path)) {
        const rel = relative(ROOT, f).replace(/\\/g, '/');
        const src = readFileSync(f, 'utf8');
        for (const text of f.endsWith('.html') ? htmlStrings(src) : literals(src)) {
          if (!WORD.test(text)) continue;
          if (ALLOWED.some(a => a.file === rel && a.text === text)) continue;
          found.push(`${rel}: ${text.trim()}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('the scan finds the word in strings, not in comments or regular expressions', () => {
    const src = [
      "// the index",
      "/* Index */",
      "const a = 'Building the index';",
      "const b = `Index of ${t('x')} done`;",
      "const k = 'index';",
      "const r = /'index'/;",
      "const c = \"No index.\";",
    ].join('\n');
    expect(literals(src).filter(t => WORD.test(t))).toEqual(['Building the index', 'Index of ', 'index', 'No index.']);
  });
});
