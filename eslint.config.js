import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import path from 'node:path';

// Layers point one way: `lib` (domain, transport, shared DOM helpers) imports
// no UI folder; `editor-core` (shared code-view and editor pieces) imports only
// `lib`; a surface (one extension page, or the content script) imports `lib`
// and `editor-core` but never another surface. Resolved by path, so a lib file
// named like a folder (lib/editor.ts) is not mistaken for it. Tests are exempt.
const SRC = path.join(import.meta.dirname, 'src');
const SHARED = new Set(['styles', 'assets']);
function layerOf(file) {
  const rel = path.relative(SRC, file);
  if (rel.startsWith('..')) return null;              // outside src (e.g. /icons)
  const [first, second] = rel.split(path.sep);
  if (second === undefined) return /^(content|interceptor)/.test(first) ? 'content' : first.replace(/.[jt]s$/, '');
  return first === 'content-blueprint' || first === 'content-pointtell' ? 'content' : first;
}
function allowed(from, to) {
  if (to === null || from === to || SHARED.has(to)) return true;
  if (from === 'lib') return false;
  if (from === 'editor-core') return to === 'lib';
  return to === 'lib' || to === 'editor-core';
}
const layerPlugin = {
  rules: {
    direction: {
      meta: { type: 'problem', schema: [], messages: { up: "'{{from}}' must not import from '{{to}}' ({{spec}}): move the shared piece into src/lib or src/editor-core." } },
      create(context) {
        const from = layerOf(context.filename);
        const check = (node, source) => {
          const spec = source && typeof source.value === 'string' ? source.value : null;
          if (!spec || !spec.startsWith('.')) return;
          const to = layerOf(path.resolve(path.dirname(context.filename), spec.split('?')[0]));
          if (from && !allowed(from, to)) context.report({ node, messageId: 'up', data: { from, to, spec } });
        };
        return {
          ImportDeclaration: n => check(n, n.source),
          ExportNamedDeclaration: n => check(n, n.source),
          ExportAllDeclaration: n => check(n, n.source),
          ImportExpression: n => check(n, n.source),
        };
      },
    },
  },
};

// Flat ESLint config. The two async-safety rules below are enforced as ERRORS
// (plan 010 introduced them as warnings; plan 020 burned the warnings down to
// zero and flipped them). `npm run lint` runs with --max-warnings 0, so CI
// fails on any new floating promise or misused-promise callback. The broader
// recommended / recommendedTypeChecked noise stays silenced so these two
// rules remain the signal.
export default tseslint.config(
  {
    // These globs target the BUILT copies emitted at the repo root by Vite
    // (see package.json "clean"). Source lives under src/ and is NOT ignored.
    ignores: [
      'dist/',
      'node_modules/',
      'content.js',
      'service-worker.js',
      'interceptor.js',
      'assets/',
      'chunks/',
      'sidepanel/',
      'editor/',
      'objectview/',
      'diff/',
      'codesearch/',
      'studio/',
      'transport/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // A disable comment that no longer suppresses anything is an error, and
    // so is a `let` that is never reassigned.
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    // A variable a closure reads before its single assignment stays `let`.
    rules: { 'prefer-const': ['error', { ignoreReadBeforeAssign: true }] },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The two rules this pass is about — enforced as ERROR (plan 020).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Everything else off/quiet this pass. These are the recommended /
      // recommendedTypeChecked rules that fire on the existing 43K-LOC source;
      // silencing them keeps the two async rules as the only signal and lets
      // ESLint land without a big cleanup. Ratchet path: re-enable (as 'error')
      // rule-by-rule after triage, then run with --max-warnings 0.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'no-irregular-whitespace': 'off',
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['src/access/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: Object.fromEntries(['window', 'document', 'localStorage', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'MutationObserver', 'ResizeObserver', 'Event', 'KeyboardEvent', 'navigator', 'URL', 'Blob', 'getComputedStyle', 'getSelection', 'structuredClone', 'CSS', 'Node', 'HTMLElement'].map(name => [name, 'readonly'])),
    },
    rules: { 'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-async-promise-executor': 'error', '@typescript-eslint/no-unused-vars': 'off', '@typescript-eslint/no-unused-expressions': 'off', 'no-useless-assignment': 'off', 'preserve-caught-error': 'off' },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.js'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.test.js', 'src/test-setup.ts'],
    plugins: { layers: layerPlugin },
    rules: { 'layers/direction': 'error' },
  },
);
