import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const repoRoot = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

/** Decode an 8-bit RGBA, non-interlaced PNG into its pixels. */
function decodeRgba(path: string): { width: number; height: number; at(x: number, y: number): [number, number, number, number] } {
  const bytes = readFileSync(path);
  const { width, height } = pngDimensions(path);
  expect(bytes[24], 'bit depth').toBe(8);
  expect(bytes[25], 'colour type RGBA').toBe(6);
  expect(bytes[28], 'interlace').toBe(0);
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (v + pred) & 0xff;
    }
  }
  return {
    width, height,
    at: (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)] as [number, number, number, number],
  };
}

const MARK_SIZES = [16, 24, 28, 32, 48, 128] as const;
const PURPLE: [number, number, number] = [0x8a, 0x3f, 0xfc];
const EYE: [number, number, number] = [0x1c, 0x10, 0x33];
const near = (px: number[], rgb: number[]) => rgb.every((v, i) => Math.abs(px[i] - v) <= 8) && px[3] === 255;

describe('Configuration Companion icon assets', () => {
  it('provides every manifest PNG at its declared dimensions', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      icons: Record<string, string>;
    };
    for (const [size, relativePath] of Object.entries(manifest.icons)) {
      const path = join(repoRoot, relativePath);
      expect(existsSync(path), relativePath).toBe(true);
      expect(pngDimensions(path)).toEqual({ width: Number(size), height: Number(size) });
    }
  });

  it('keeps one pixel-snapped mark drawing per size', () => {
    for (const size of MARK_SIZES) {
      const svg = read(`icons/mark-${size}.svg`);
      expect(svg, `mark-${size}`).toContain('aria-label="Configuration Companion"');
      expect(svg, `mark-${size}`).toContain(`viewBox="0 0 ${size} ${size}"`);
      // Inlined (the header) or repeated on a page: no ids.
      expect(svg, `mark-${size}`).not.toMatch(/\sid="/);
    }
    // The old small mascot is gone; the full mascot stays as the empty-state art.
    expect(existsSync(join(repoRoot, 'icons/mascot-small.svg'))).toBe(false);
    expect(read('icons/mascot.svg')).toContain('aria-label="Configuration Companion"');
    expect(read('icons/mascot.svg')).not.toMatch(/\sid="/);
    expect(existsSync(join(repoRoot, 'icons/configuration-companion.svg'))).toBe(false);
  });

  it('uses the mark of the matching size where the mark appears', () => {
    expect(read('src/sidepanel/server-control.ts')).toContain("icons/mark-28.svg?raw");
    expect(read('src/sidepanel/sidepanel.html')).toContain('icons/mark-28.svg');
    expect(read('src/access/access.html')).toMatch(/<link rel="icon" href="[^"]*icons\/mark-16\.svg">/);
    expect(read('src/lib/empty-state.ts')).toContain("icons/mascot.svg?raw");
    for (const p of ['src/sidepanel/sidepanel.ts', 'src/sidepanel/sidepanel.html', 'src/access/access.html']) {
      expect(read(p), p).not.toContain('mascot-small');
    }
  });

  it('renders the toolbar PNGs from the mark: RGBA, transparent around it, purple C, dark eyes', () => {
    // Points per size, from icons/mark-{size}.svg: a pixel on the C's left
    // stroke, one inside an eye, and the open side of the C.
    const probes: Record<number, { stroke: [number, number]; eye: [number, number] | null; open: [number, number] }> = {
      16: { stroke: [3, 7], eye: null, open: [14, 8] },
      32: { stroke: [6, 16], eye: [15, 15], open: [29, 16] },
      48: { stroke: [10, 24], eye: [22, 24], open: [44, 24] },
      128: { stroke: [27, 64], eye: [60, 66], open: [120, 64] },
    };
    for (const [size, p] of Object.entries(probes)) {
      const png = decodeRgba(join(repoRoot, `icons/icon-${size}.png`));
      expect(png.width).toBe(Number(size));
      const last = png.width - 1;
      for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
        expect(png.at(x, y)[3], `icon-${size} corner ${x},${y}`).toBe(0);
      }
      expect(near(png.at(...p.stroke), PURPLE), `icon-${size} stroke ${png.at(...p.stroke).join(',')}`).toBe(true);
      if (p.eye) expect(near(png.at(...p.eye), EYE), `icon-${size} eye ${png.at(...p.eye).join(',')}`).toBe(true);
      expect(png.at(...p.open)[3], `icon-${size} open side`).toBe(0);
    }
  });
});
