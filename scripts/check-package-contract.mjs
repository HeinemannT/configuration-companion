// Package contract check: run after `npm run build`.
//
// Verifies that every file the extension needs at run time is in the package
// with a non-zero size, and that the package holds no source maps or tests.
//
// Usage:
//   node scripts/check-package-contract.mjs            # dist/ + manifest.json + icons/
//   node scripts/check-package-contract.mjs --dir pkg  # an assembled package tree
//
// Without --dir the package is the same view release.yml assembles: manifest.json
// and icons/ from the repository root, plus the contents of dist/ at the top level.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { dir: null, dirLabel: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      args.dirLabel = argv[++i];
      args.dir = resolve(args.dirLabel);
    }
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/** Map of package path (posix, no leading slash) -> absolute file path. */
function collectFiles(baseDir, prefix, into) {
  if (!existsSync(baseDir)) return;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const abs = join(baseDir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collectFiles(abs, rel, into);
    else if (entry.isFile()) into.set(rel, abs);
  }
}

function packageView(args) {
  const files = new Map();
  if (args.dir) {
    if (!existsSync(args.dir)) throw new Error(`Package directory not found: ${args.dir}`);
    collectFiles(args.dir, '', files);
    return { files, label: args.dirLabel };
  }
  const dist = join(repositoryRoot, 'dist');
  if (!existsSync(dist)) throw new Error('dist/ not found. Run `npm run build` first.');
  collectFiles(dist, '', files);
  collectFiles(join(repositoryRoot, 'icons'), 'icons', files);
  const manifestPath = join(repositoryRoot, 'manifest.json');
  if (existsSync(manifestPath)) files.set('manifest.json', manifestPath);
  return { files, label: 'dist/ + manifest.json + icons/' };
}

function normalize(path) {
  return posix.normalize(path.split('?')[0].split('#')[0].replace(/^\/+/, ''));
}

/** Collect manifest references as [path, reason] pairs and globs as [glob, reason]. */
function manifestRefs(manifest) {
  const refs = [];
  const globs = [];
  const add = (path, reason) => { if (typeof path === 'string' && path) refs.push([normalize(path), reason]); };
  const addIcons = (icons, reason) => {
    if (typeof icons === 'string') add(icons, reason);
    else if (icons && typeof icons === 'object') {
      for (const [size, path] of Object.entries(icons)) add(path, `${reason}[${size}]`);
    }
  };

  addIcons(manifest.icons, 'manifest icons');
  addIcons(manifest.action?.default_icon, 'manifest action.default_icon');
  add(manifest.action?.default_popup, 'manifest action.default_popup');
  add(manifest.background?.service_worker, 'manifest background.service_worker');
  add(manifest.side_panel?.default_path, 'manifest side_panel.default_path');
  add(manifest.options_page, 'manifest options_page');
  add(manifest.options_ui?.page, 'manifest options_ui.page');
  add(manifest.devtools_page, 'manifest devtools_page');
  for (const page of manifest.sandbox?.pages ?? []) add(page, 'manifest sandbox.pages');
  for (const [i, cs] of (manifest.content_scripts ?? []).entries()) {
    for (const path of [...(cs.js ?? []), ...(cs.css ?? [])]) add(path, `manifest content_scripts[${i}]`);
  }
  for (const [i, war] of (manifest.web_accessible_resources ?? []).entries()) {
    for (const resource of war.resources ?? []) {
      const reason = `manifest web_accessible_resources[${i}]`;
      if (resource.includes('*')) globs.push([normalize(resource), reason]);
      else add(resource, reason);
    }
  }
  return { refs, globs };
}

function isTestOrSourceFile(path) {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function walkSource(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'integration') walkSource(abs, out);
    } else if (/\.[cm]?[jt]s$/.test(entry.name) && !isTestOrSourceFile(entry.name)) {
      out.push(abs);
    }
  }
}

/**
 * Files the source loads by name at run time: content scripts registered with
 * chrome.scripting (`js: [...]`, `files: [...]`) and `chrome.runtime.getURL('...')`
 * literals.
 */
function sourceRefs() {
  const refs = [];
  const sources = [];
  walkSource(join(repositoryRoot, 'src'), sources);
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const where = relative(repositoryRoot, file).split(sep).join('/');
    for (const match of text.matchAll(/\b(?:js|css|files)\s*:\s*\[([^\]]*)\]/g)) {
      for (const lit of match[1].matchAll(/['"`]([^'"`$]+\.(?:js|css))['"`]/g)) {
        refs.push([normalize(lit[1]), `scripting registration in ${where}`]);
      }
    }
    for (const lit of text.matchAll(/getURL\(\s*['"]([^'"]+)['"]/g)) {
      refs.push([normalize(lit[1]), `runtime.getURL in ${where}`]);
    }
  }
  return refs;
}

/** Relative src/href references inside an HTML page, resolved to package paths. */
function htmlRefs(htmlPath, absPath) {
  const refs = [];
  const text = readFileSync(absPath, 'utf8');
  const baseDir = posix.dirname(htmlPath);
  for (const match of text.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const value = match[1].trim();
    if (!value || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) continue;
    const path = value.startsWith('/') ? normalize(value) : normalize(posix.join(baseDir, value));
    refs.push([path, `referenced by ${htmlPath}`]);
  }
  return refs;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { files, label } = packageView(args);
  const problems = [];
  const sizeOf = (path) => statSync(files.get(path)).size;

  const manifestFile = files.get('manifest.json');
  if (!manifestFile) {
    console.error(`Package contract failed (${label}):\n  missing file: manifest.json`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const { refs, globs } = manifestRefs(manifest);
  refs.push(...sourceRefs());

  const checked = new Set();
  const checkRef = ([path, reason]) => {
    const key = `${path}\u0000${reason}`;
    if (checked.has(key)) return;
    checked.add(key);
    if (!files.has(path)) problems.push(`missing file: ${path} (${reason})`);
    else if (sizeOf(path) === 0) problems.push(`empty file: ${path} (${reason})`);
  };
  refs.forEach(checkRef);

  for (const [glob, reason] of globs) {
    const re = globToRegExp(glob);
    const matches = [...files.keys()].filter((path) => re.test(path));
    if (matches.length === 0) problems.push(`missing files: nothing matches ${glob} (${reason})`);
    for (const path of matches) if (sizeOf(path) === 0) problems.push(`empty file: ${path} (matched by ${glob}, ${reason})`);
  }

  for (const [path, abs] of files) {
    if (path.endsWith('.html')) htmlRefs(path, abs).forEach(checkRef);
  }

  for (const path of files.keys()) {
    if (path.endsWith('.map')) problems.push(`source map in package: ${path}`);
    else if (isTestOrSourceFile(path)) problems.push(`test file in package: ${path}`);
  }

  if (problems.length > 0) {
    console.error(`Package contract failed (${label}): ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Package contract OK (${label}): ${checked.size} references, ${globs.length} resource patterns, ${files.size} files.`);
}

try {
  main();
} catch (error) {
  console.error(`Package contract failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
