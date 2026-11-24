/**
 * Big and curved arrows as people draw them on a wide page: a long shaft (straight, bowed, a C or a U-turn) and
 * a head drawn as one V or two barbs after it, or in the same stroke. The five arrows the owner drew on the
 * QA page are here by name, in the coordinates of that page's screenshot (2000 px wide), scaled to the page.
 */
import { findNode } from '../../layout/model';
import type { LModel } from '../../layout/types';
import type { InkReading } from '../ink-read';
import type { PtScene } from '../resolve';
import type { PtPoint } from '../types';
import { widget } from './fixture';
import { between, dense, pen, pick, type Rnd } from './hand';

// ── The QA page ─────────────────────────────────────────────────────────────────────────────────

export function qaModel(): LModel {
  return {
    pageId: 'sc_crev_qa', pageName: 'CREV QA', pageClass: 'Scorecard', tabsetId: 'ts', target: 'template', hasTemplate: true,
    tabs: [{
      id: 'tab_qa', kind: 'tab', className: 'Tab', name: 'QA', tabsetId: 'ts', cols: { L: 6 }, children: [
        widget('qa_text', 'TextElement', 6, 'CREV QA Text'),
        widget('qa_input', 'InputView', 6, 'CREV QA Input view'),
      ],
    }],
  };
}

/** The QA page at scale `s` of the screenshot: "CREV QA Text" on top, "CREV QA Input view" below, empty header above. */
export function qaScene(s = 1): PtScene {
  const r = (left: number, top: number, width: number, height: number) => ({ left: left * s, top: top * s, width: width * s, height: height * s });
  return {
    model: qaModel(), liveTabId: 'tab_qa',
    targets: [
      { id: 'qa_text', kind: 'widget', rect: r(40, 205, 1920, 230) },
      { id: 'qa_input', kind: 'widget', rect: r(40, 460, 1920, 300) },
    ],
    pills: [],
  };
}

export const nameIn = (scene: PtScene, id: string): string => findNode(scene.model, id)?.node.name ?? id;

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────

/** A smooth path through waypoints (Catmull-Rom), as dense points. */
export function smooth(ws: PtPoint[]): PtPoint[] {
  const vs: PtPoint[] = [];
  for (let i = 0; i < ws.length - 1; i++) {
    const p0 = ws[Math.max(0, i - 1)], p1 = ws[i], p2 = ws[i + 1], p3 = ws[Math.min(ws.length - 1, i + 2)];
    for (let k = 0; k < 16; k++) {
      const t = k / 16, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      vs.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  vs.push(ws[ws.length - 1]);
  return dense(vs);
}

const scaleAll = (ps: PtPoint[], s: number): PtPoint[] => ps.map(p => [p[0] * s, p[1] * s] as PtPoint);
const wobble = (ps: PtPoint[], r: Rnd, k: number): PtPoint[] => ps.map(p => [p[0] + between(r, -k, k), p[1] + between(r, -k, k)] as PtPoint);

export type BigHead = 'v' | 'two' | 'v-reversed' | 'barb';

/**
 * Strokes of one arrow: a shaft through `ws` and a head given by its point and barb ends (a V is drawn
 * end 1, point, end 2; two barbs are each drawn toward the point; a single barb from the point back).
 */
export function drawn(ws: PtPoint[], head: { b1: PtPoint; point: PtPoint; b2?: PtPoint }, style: BigHead, r: Rnd, s = 1): PtPoint[][] {
  const k = 6 * s, step = between(r, 6, 16) * Math.max(0.6, s);
  const shaft = pen(smooth(wobble(scaleAll(ws, s), r, k)), r, { step, jit: 0.8 });
  const [b1, point, b2] = scaleAll([head.b1, head.point, head.b2 ?? head.b1], s).map(p => [p[0] + between(r, -k, k), p[1] + between(r, -k, k)] as PtPoint);
  const P = (vs: PtPoint[]) => pen(dense(vs), r, { step: between(r, 4, 10) * Math.max(0.6, s), jit: 0.6 });
  if (!head.b2 || style === 'barb') return [shaft, P([b1, point])];
  switch (style) {
    case 'v': return [shaft, P([b1, point, b2])];
    case 'v-reversed': return [shaft, P([b2, point, b1])];
    case 'two': return [shaft, P([b1, point]), P([b2, point])];
  }
}

// ── The owner's five ────────────────────────────────────────────────────────────────────────────

export interface Owner {
  name: string;
  ws: PtPoint[];
  head: { b1: PtPoint; point: PtPoint; b2?: PtPoint };
  /** The object under the tail and under the tip (screenshot coordinates). */
  from?: string; to?: string;
  tail: PtPoint; tip: PtPoint;
}

export const OWNER: Owner[] = [
  { name: '1, a long S-curved shaft from the empty header onto the input view, big V head', ws: [[1640, 110], [1480, 195], [1300, 320], [1100, 430], [850, 600]],
    head: { b1: [848, 553], point: [770, 705], b2: [900, 683] }, to: 'qa_input', tail: [1640, 110], tip: [770, 705] },
  { name: '2, a gently curved shaft up from the input view onto the text, V head', ws: [[495, 490], [528, 410], [578, 342], [640, 290]],
    head: { b1: [575, 288], point: [683, 245], b2: [665, 313] }, from: 'qa_input', to: 'qa_text', tail: [495, 490], tip: [683, 245] },
  { name: '3, a nearly straight shaft down from the text onto the input view, V head', ws: [[1870, 240], [1862, 335], [1851, 435], [1840, 530]],
    head: { b1: [1800, 505], point: [1835, 585], b2: [1908, 518] }, from: 'qa_text', to: 'qa_input', tail: [1870, 240], tip: [1835, 585] },
  { name: '4, a C-shaped shaft from the text round onto the input view, one barb along the bottom', ws: [[300, 255], [200, 385], [115, 530], [185, 628], [268, 690]],
    head: { b1: [150, 693], point: [268, 688] }, from: 'qa_text', to: 'qa_input', tail: [300, 255], tip: [268, 690] },
  { name: '5, a hook from the text that turns back left into the empty header, V head', ws: [[880, 297], [985, 268], [1060, 220], [1000, 178], [870, 165]],
    head: { b1: [897, 123], point: [830, 150], b2: [888, 203] }, from: 'qa_text', tail: [880, 297], tip: [830, 150] },
];

/** Whether a reading is that arrow: a move of the tail's object, a pointer at the tip's object, or an arrow from one to the other. */
export function readsAs(x: InkReading, from: string | undefined, to: string | undefined): boolean {
  if (x.kind === 'move') return !!from && x.targets[0] === from;
  if (x.kind === 'select' && x.pointer) return !from && !!to && x.targets[0] === to;
  const a = (x as InkReading & { arrow?: { from?: string; to?: string } }).arrow;
  return (x.kind as string) === 'arrow' && !!a && a.from === from && a.to === to;
}

// ── A generator of big and curved arrows ────────────────────────────────────────────────────────

export type ShaftShape = 'straight' | 'bowed' | 's' | 'c' | 'u';

/**
 * One big arrow from `tail` toward `tip`: a shaft of the given shape, and a head with barbs of `barb` (a share of
 * the chord, capped) whose point may sit ahead of the shaft's end and off to one side, as a big V drawn
 * afterwards does. Returns the strokes and where the arrow points.
 */
export function bigArrow(tail: PtPoint, tip: PtPoint, shape: ShaftShape, r: Rnd, o: { head?: BigHead; inline?: boolean } = {}): { strokes: PtPoint[][]; tip: PtPoint } {
  const dx = tip[0] - tail[0], dy = tip[1] - tail[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const side = r() < 0.5 ? 1 : -1;
  const at = (t: number, off: number): PtPoint => [tail[0] + dx * t + nx * off * len, tail[1] + dy * t + ny * off * len];
  let ws: PtPoint[];
  switch (shape) {
    case 'straight': ws = [at(0, 0), at(0.5, between(r, -0.02, 0.02)), at(1, 0)]; break;
    case 'bowed': { const b = side * between(r, 0.08, 0.2); ws = [at(0, 0), at(0.25, b * 0.75), at(0.5, b), at(0.75, b * 0.75), at(1, 0)]; break; }
    case 's': { const b = side * between(r, 0.05, 0.1); ws = [at(0, 0), at(0.3, b), at(0.7, -b), at(1, 0)]; break; }
    // A C: out to one side by about half the chord, and back in to the tip.
    case 'c': { const b = side * between(r, 0.35, 0.6); ws = [at(0, 0), at(0.15, b * 0.7), at(0.5, b), at(0.85, b * 0.7), at(1, 0)]; break; }
    // A U-turn: away past the tip, round, and back to it.
    case 'u': { const b = side * between(r, 0.3, 0.5), far = between(r, 1.3, 1.7); ws = [at(0, 0), at(far * 0.5, b), at(far, b * 0.5), at(far - 0.12, 0), at(1, -0.03 * b)]; break; }
  }
  const sh = smooth(ws);
  const end = sh[sh.length - 1], back = sh[Math.max(0, sh.length - 1 - Math.round(Math.min(80, 0.15 * len)))];
  const bl = Math.hypot(end[0] - back[0], end[1] - back[1]) || 1, ex = (end[0] - back[0]) / bl, ey = (end[1] - back[1]) / bl;
  const hl = Math.min(160, Math.max(24, len * between(r, 0.12, 0.3))), th = between(r, 0.35, 0.7);
  // A big V drawn afterwards: its point a little past the end of the shaft, a little to one side.
  const ahead = o.inline ? 0 : hl * between(r, 0, 0.6), lat = o.inline ? 0 : hl * between(r, -0.2, 0.2);
  const point: PtPoint = [end[0] + ex * ahead - ey * lat, end[1] + ey * ahead + ex * lat];
  const ang = Math.atan2(-ey, -ex);
  const b1: PtPoint = [point[0] + Math.cos(ang + th) * hl * between(r, 0.8, 1.2), point[1] + Math.sin(ang + th) * hl * between(r, 0.8, 1.2)];
  const b2: PtPoint = [point[0] + Math.cos(ang - th) * hl * between(r, 0.8, 1.2), point[1] + Math.sin(ang - th) * hl * between(r, 0.8, 1.2)];
  const step = between(r, 6, 16), P = (vs: PtPoint[], st = step) => pen(vs, r, { step: st, jit: 0.7 });
  if (o.inline) {
    // The head in the same stroke: a hook (one barb back) or a V (back, across to the point, out again).
    const hook = r() < 0.5;
    return { strokes: [P([...sh, ...dense(hook ? [end, b1] : [end, b1, end, b2])], Math.min(step, 9))], tip: end };
  }
  const head = o.head ?? pick(r, ['v', 'two', 'v-reversed'] as const);
  const hs = head === 'v' ? [P(dense([b1, point, b2]), 6)] : head === 'v-reversed' ? [P(dense([b2, point, b1]), 6)] : [P(dense([b1, point]), 5), P(dense([b2, point]), 5)];
  return { strokes: [P(sh), ...hs], tip: point };
}
