import { describe, expect, it } from 'vitest';
import { readInk } from '../ink-read';
import { fixtureScene } from './fixture';
import { notArrows } from './not-arrows';

// Each drawing's reading as it was before arrows of any size and shape were read: kind, targets and pointer.
// A change here is a drawing that is now read differently; look at it before updating the snapshot.
describe('drawings that are no arrow keep their reading', () => {
  it('letters, digits, ticks, underlines, squiggles, loops with a tail, a sketch and a cross', () => {
    const scene = fixtureScene();
    const got: Record<string, string> = {};
    for (const d of notArrows()) {
      const r = readInk(scene, d.strokes.map(points => ({ points })));
      got[d.name] = `${r.kind} ${r.targets.join(',')}${r.pointer ? ' pointer' : ''}`.trim();
    }
    expect(got).toMatchSnapshot();
  });
});
