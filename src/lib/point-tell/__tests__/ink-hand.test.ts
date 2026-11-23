import { appendFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureScene } from './fixture';
import { ARROW_LAB, CIRCLE_LAB, CROSS_LAB, FALSE_LAB, type Case } from './hand-lab';

const scene = fixtureScene();
const N = Number(process.env.INK_N ?? 150);

function rate(cases: Case[]): number {
  let ok = 0;
  cases.forEach(c => { if (c.ok(scene)) ok++; });
  return ok / Math.max(1, cases.length);
}

const report = (title: string, rows: Array<[string, number]>): void => {
  if (!process.env.INK_REPORT) return;
  appendFileSync(process.env.INK_REPORT, `\n== ${title}\n${rows.map(([k, v]) => `${k.padEnd(56)} ${(v * 100).toFixed(1)}%`).join('\n')}\n`);
};

describe('hand-drawn circles', () => {
  const rows: Array<[string, number]> = [];
  for (const [name, make, min] of CIRCLE_LAB) {
    it(`${name}`, () => {
      const r = rate(make(N));
      rows.push([name, r]);
      expect(r).toBeGreaterThanOrEqual(min);
    });
  }
  afterAll(() => report('', rows));
});

describe('hand-drawn arrows', () => {
  const rows: Array<[string, number]> = [];
  for (const [name, make, min] of ARROW_LAB) {
    it(`${name}`, () => {
      const r = rate(make(N));
      rows.push([name, r]);
      expect(r).toBeGreaterThanOrEqual(min);
    });
  }
  afterAll(() => report('', rows));
});

describe('hand-drawn crosses', () => {
  const rows: Array<[string, number]> = [];
  for (const [name, make, min] of CROSS_LAB) {
    it(`${name}`, () => {
      const r = rate(make(N));
      rows.push([name, r]);
      expect(r).toBeGreaterThanOrEqual(min);
    });
  }
  afterAll(() => report('', rows));
});

describe('things that must keep their reading', () => {
  const rows: Array<[string, number]> = [];
  for (const [name, make, min] of FALSE_LAB) {
    it(`${name}`, () => {
      const r = rate(make(N));
      rows.push([name, r]);
      expect(r).toBeGreaterThanOrEqual(min);
    });
  }
  afterAll(() => report('', rows));
});
