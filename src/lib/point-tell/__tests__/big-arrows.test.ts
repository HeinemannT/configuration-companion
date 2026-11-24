import { appendFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { markLine } from '../brief';
import { readInk, type InkReading } from '../ink-read';
import type { PtMark, PtPoint } from '../types';
import { bigArrow, drawn, OWNER, qaScene, readsAs, type BigHead, type ShaftShape } from './big-arrows';
import { between } from './hand';
import { rng } from './strokes';

const N = Number(process.env.INK_N ?? 120);
const rows: Array<[string, number]> = [];
const report = (): void => {
  if (process.env.INK_REPORT) appendFileSync(process.env.INK_REPORT, `\n== big arrows\n${rows.map(([k, v]) => `${k.padEnd(72)} ${(v * 100).toFixed(1)}%`).join('\n')}\n`);
};
const read = (scene: ReturnType<typeof qaScene>, strokes: PtPoint[][]): InkReading => readInk(scene, strokes.map(points => ({ points })));

describe('the five arrows the owner drew', () => {
  for (const scale of [1, 0.5]) {
    const scene = qaScene(scale);
    for (const o of OWNER) {
      const styles: BigHead[] = o.head.b2 ? ['v', 'two', 'v-reversed'] : ['barb'];
      it(`${o.name} (scale ${scale})`, () => {
        let ok = 0, n = 0;
        for (const style of styles) for (let i = 0; i < 20; i++) {
          n++;
          if (readsAs(read(scene, drawn(o.ws, o.head, style, rng(500 + i * 31), scale)), o.from, o.to)) ok++;
        }
        rows.push([`owner ${o.name.slice(0, 50)} @${scale}`, ok / n]);
        expect(ok / n).toBeGreaterThanOrEqual(0.9);
      });
    }
  }
});

describe('big and curved arrows, drawn by the hand generator', () => {
  const scene = qaScene(1);
  // From the empty header onto the input view (a pointer), or from the text into the empty header (an arrow from it).
  const families: Array<[string, ShaftShape, { inline?: boolean }, number]> = [
    ['straight, 250-950 px, separate big head', 'straight', {}, 0.9],
    ['bowed, separate big head', 'bowed', {}, 0.9],
    ['S-curved, separate big head', 's', {}, 0.9],
    ['C-shaped, separate big head', 'c', {}, 0.9],
    ['U-turn (hook), separate big head', 'u', {}, 0.9],
    ['C-shaped, head in the same stroke', 'c', { inline: true }, 0.9],
    ['U-turn (hook), head in the same stroke', 'u', { inline: true }, 0.9],
  ];
  for (const [name, shape, o, min] of families) {
    it(`pointer onto the input view: ${name}`, () => {
      let ok = 0;
      for (let i = 0; i < N; i++) {
        const r = rng(9000 + i * 7919), len = between(r, 250, 950);
        const tip: PtPoint = [between(r, 300, 1700), between(r, 560, 720)], a = between(r, -2.6, -0.55);
        const tail: PtPoint = [tip[0] + Math.cos(a) * len, Math.max(40, Math.min(180, tip[1] + Math.sin(a) * len))];
        const t = bigArrow(tail, tip, shape, r, o);
        if (readsAs(read(scene, t.strokes), undefined, 'qa_input')) ok++;
      }
      rows.push([`pointer: ${name}`, ok / N]);
      expect(ok / N).toBeGreaterThanOrEqual(min);
    });
    it(`from the text into empty space: ${name}`, () => {
      let ok = 0;
      for (let i = 0; i < N; i++) {
        const r = rng(4000 + i * 7919);
        const tail: PtPoint = [between(r, 300, 1700), between(r, 250, 420)], tip: PtPoint = [tail[0] + between(r, -600, 600), between(r, 40, 150)];
        if (Math.hypot(tip[0] - tail[0], tip[1] - tail[1]) < 180) tip[0] += 300;
        const t = bigArrow(tail, tip, shape, r, o);
        const x = read(scene, t.strokes);
        if (readsAs(x, 'qa_text', undefined)) ok++;
      }
      rows.push([`from text to empty: ${name}`, ok / N]);
      expect(ok / N).toBeGreaterThanOrEqual(min);
    });
  }
  afterAll(report);
});

describe('what the brief says about each of the five', () => {
  const scene = qaScene(0.5);
  const lines = OWNER.map((o, i) => {
    const strokes = drawn(o.ws, o.head, o.head.b2 ? 'v' : 'barb', rng(77 + i), 0.5);
    const r = read(scene, strokes);
    const mark: PtMark = {
      n: i + 1, text: '', targets: r.targets, at: i, ...(r.meaning ? { meaning: r.meaning } : {}), ...(r.reading ? { reading: r.reading } : {}),
      ...(r.pointer ? { pointer: true as const } : {}), ...(r.arrow ? { arrow: r.arrow } : {}), ink: { strokes: strokes.map(points => ({ points })), place: r.place },
    };
    return { r, line: markLine(mark, { model: scene.model, liveTabId: scene.liveTabId }).text };
  });
  it('every one is an arrow, with its direction, and none is unrecognised ink', () => {
    for (const { line } of lines) {
      expect(line).not.toContain('not a shape Companion recognised');
      expect(line).toMatch(/^\d\. Arrow /);
    }
    expect(lines[0].line).toBe('1. Arrow pointing at "CREV QA Input view" (InputView, qa_input).');
    expect(lines[4].line).toMatch(/^5\. Arrow from "CREV QA Text" \(TextElement, qa_text\) to empty space.*\. The user did not say what it means: ask before changing anything\.$/);
    for (const { r } of lines.slice(1, 4)) expect(['move', 'arrow']).toContain(r.kind);
  });
  if (process.env.INK_REPORT) afterAll(() => appendFileSync(process.env.INK_REPORT!, `\n== brief lines\n${lines.map(l => l.line).join('\n')}\n`));
});
