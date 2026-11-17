// @vitest-environment happy-dom
/* global performance, console, process */
import { expect, it, vi } from 'vitest';
import { mountMatrix, matrixState } from './matrix-view.js';
import { createMatrixIndex } from './matrix-model';

const c = (Left, Comparison, Right) => ({ Condition: { Left, Comparison, Right } });
it('scrolls 620 types x 25 roles near one frame per step', () => {
  const many = Object.fromEntries(Array.from({ length: 620 }, (_, i) => ['CeType' + String(i).padStart(3, '0'), []]));
  const roles = Array.from({ length: 25 }, (_, i) => ({ rid: String(100 + i), id: 'r' + i, name: 'Role ' + i, parent: i ? '100' : '' }));
  const statements = roles.map((r, i) => ({ Subject: ['role:' + r.id], Effect: 'Allow', Action: ['Read', 'Update'], Resource: c('resource.type', '=', 'CeType' + String(i * 20).padStart(3, '0')) }));
  statements.push({ Subject: '*', Effect: 'Allow', Action: ['Read'], Resource: c('resource.owner', '=', 'user') });
  const metadata = { types: Object.fromEntries(Object.keys(many).map(t => [t, { concrete: true, parents: [] }])), references: {} };
  const index = createMatrixIndex({ roles, policies: [{ rid: 'p', enabled: true, content: { Statement: statements } }] }, many, {}, metadata);
  document.body.innerHTML = '<div id="matrix"></div>';
  const view = mountMatrix(document.querySelector('#matrix'), { index, state: { ...matrixState(), hideEmpty: false }, changed: vi.fn(), canOpen: () => true, openRule: vi.fn(), test: vi.fn() });
  const times = [];
  for (let step = 1; step <= 60; step++) { const t0 = performance.now(); view.scrollTo(step * 96); times.push(performance.now() - t0); }
  // What makes it fast, counted (steady under load): rows are kept by
  // index, so a step renders about one screen of rows, never the 620.
  expect(document.querySelectorAll('#matrix .mr').length).toBeGreaterThan(0);
  expect(document.querySelectorAll('#matrix .mr').length).toBeLessThan(120);
  times.sort((a, b) => a - b);
  const median = times[30], p95 = times[56];
  // Wall-clock time only on request (CREV_BENCH=1): a busy machine makes
  // any time limit fail at random. About 8 ms alone (was about 115 ms before
  // rows were kept by index).
  if (process.env.CREV_BENCH) {
    console.info(`[matrix scroll bench] 60 steps of 96 px: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${times[59].toFixed(2)} ms`);
    expect(median).toBeLessThan(40);
  }
  view.destroy();
});


