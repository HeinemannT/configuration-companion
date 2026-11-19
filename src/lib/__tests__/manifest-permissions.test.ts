/** The manifest's permission contract: no host access at install, `activeTab` for Point and tell's pictures. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(__dirname, '../../..', 'manifest.json'), 'utf8')) as {
  permissions: string[]; host_permissions?: string[]; content_scripts?: unknown;
  commands: Record<string, { suggested_key?: unknown; description: string }>;
};

describe('manifest permissions', () => {
  it('asks for activeTab and for no host access at install', () => {
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).not.toContain('<all_urls>');
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('has a Point and tell command with no default key', () => {
    expect(manifest.commands['toggle-point-tell']).toBeDefined();
    expect(manifest.commands['toggle-point-tell'].suggested_key).toBeUndefined();
  });
});
