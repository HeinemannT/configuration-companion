import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import viteConfig from '../../../vite.config';
import { GENERATED_ROOT_DIRECTORIES, GENERATED_ROOT_FILES } from '../../../scripts/build-output-paths.mjs';

const repoRoot = join(__dirname, '../../..');

/** Top-level names the Vite build writes into dist/ (and mirrors to the repository root). */
function emittedTopLevelNames(): { files: string[]; dirs: string[] } {
  const rolldown = viteConfig.build?.rolldownOptions;
  const input = rolldown?.input as Record<string, string>;
  const output = rolldown?.output as { entryFileNames: string; chunkFileNames: string; assetFileNames: string };
  const files = new Set<string>();
  const dirs = new Set<string>();
  const add = (path: string) => {
    const [head, ...rest] = path.split('/');
    if (rest.length) dirs.add(head);
    else files.add(head);
  };
  for (const name of Object.keys(input)) add(output.entryFileNames.replace('[name]', name));
  add(output.chunkFileNames);
  add(output.assetFileNames);
  // Files a plugin emits directly (this.emitFile({ fileName })).
  const source = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
  for (const match of source.matchAll(/fileName:\s*'([^']+)'/g)) add(match[1]);
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

describe('generated build output', () => {
  it('matches the allowlist used by npm run clean and closeBundle', () => {
    const emitted = emittedTopLevelNames();
    expect(emitted.files).toEqual([...GENERATED_ROOT_FILES].sort());
    expect(emitted.dirs).toEqual([...GENERATED_ROOT_DIRECTORIES].sort());
  });

  it('is ignored by .gitignore', () => {
    const ignored = new Set(readFileSync(join(repoRoot, '.gitignore'), 'utf8')
      .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
    expect(ignored.has('dist/') || ignored.has('/dist/')).toBe(true);
    for (const file of GENERATED_ROOT_FILES) expect(ignored, file).toContain(`/${file}`);
    for (const dir of GENERATED_ROOT_DIRECTORIES) expect(ignored, dir).toContain(`/${dir}/`);
  });
});
