import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../lib/types';
import { compactActivityStatus, workStatusForMessage } from '../work-status';

describe('side-panel work status', () => {
  it('covers meaningful user waits without reporting background state sync', () => {
    expect(workStatusForMessage({ type: 'FETCH_INBOUND', rid: '42', className: 'Widget' }))
      .toMatchObject({ text: 'Loading relations…', working: true });
    expect(workStatusForMessage({ type: 'GET_SETTINGS' })).toBeNull();
  });

  it('reports progress and concise outcomes', () => {
    expect(workStatusForMessage({
      type: 'CODE_INDEX_STATUS',
      status: { environment: 'p@u', state: 'building', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 40, version: 0, progress: { phase: 'reading', read: 18, toRead: 40 } },
    })).toMatchObject({ text: 'Copying code 18/40', working: true });
  });

  it('leaves Browse searches to Browse: no footer count that could disagree with the list', () => {
    expect(workStatusForMessage({ type: 'BROWSE_SEARCH', query: 'risk', gen: 1 })).toBeNull();
    expect(workStatusForMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: 1, ok: true, totalHits: 206 })).toBeNull();
  });

  it('names page reads and the page connection without the removed inspector', () => {
    const at = (message: string) => compactActivityStatus({ id: 1, time: 1, level: 'success', message });
    expect(at('Found 3 objects').text).toBe('Read 3 page objects');
    expect(at('Content script connected').text).toBe('Page connected');
  });

  it('shortens enrichment chatter but retains the full hover title', () => {
    const entry = {
      id: 1,
      time: 1,
      level: 'success',
      message: 'Enriched 4 objects from the server cache',
    } satisfies ActivityEntry;

    expect(compactActivityStatus(entry)).toEqual({
      text: '4 badges named',
      title: entry.message,
      working: false,
    });
  });
});
