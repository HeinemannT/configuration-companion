import { describe, expect, it } from 'vitest';
import type { AccessSubject } from '../../lib/types';
import { comboKey, indexSubjects, matchSubjects } from '../window/subject-search';

const users: AccessSubject[] = Array.from({ length: 214 }, (_, i) => ({ rid: String(1000 + i), name: `User ${String(i).padStart(3, '0')}`, kind: 'user', businessId: `u_${i}` }));
const named: AccessSubject[] = [
  { rid: '1', name: 'Maya', kind: 'user', businessId: 'maya_chen' },
  { rid: '2', name: 'Process Manager', kind: 'role', businessId: 'roleProcessManager' },
  { rid: '3', name: 'Organization Manager', kind: 'role', businessId: 'roleOrganizationManager' },
  { rid: '4', name: 'Germany', kind: 'role', businessId: 'roleGermany' },
];
const index = indexSubjects([...named, ...users]);

describe('subject filtering', () => {
  it('filters by name and business ID, word starts first', () => {
    const m = matchSubjects(index, 'man', 'all', []);
    expect(m.rest.map(s => s.name)).toEqual(['Process Manager', 'Organization Manager', 'Germany']);
  });

  it('filters by kind', () => {
    expect(matchSubjects(index, 'ma', 'user', []).rest.map(s => s.name)).toEqual(['Maya']);
    expect(matchSubjects(index, '', 'role', []).total).toBe(3);
  });

  it('lists recent subjects first, in recent order, and only when they match', () => {
    const m = matchSubjects(index, 'man', 'all', ['3', '1']);
    expect(m.recent.map(s => s.rid)).toEqual(['3']);
    expect(m.rest.map(s => s.rid)).toEqual(['2', '4']);
  });

  it('renders a window of the matches and says how many there are', () => {
    const m = matchSubjects(index, 'user', 'all', [], 100);
    expect(m.total).toBe(214);
    expect(m.shown).toBe(100);
    expect(m.rest).toHaveLength(100);
  });
});

describe('combobox keyboard model', () => {
  const closed = { open: false, active: 0 };
  it('arrows open the list, then move within it', () => {
    expect(comboKey(closed, 'ArrowDown', 5)).toMatchObject({ state: { open: true, active: 0 }, handled: true });
    expect(comboKey({ open: true, active: 0 }, 'ArrowDown', 5).state.active).toBe(1);
    expect(comboKey({ open: true, active: 4 }, 'ArrowDown', 5).state.active).toBe(4);
    expect(comboKey({ open: true, active: 0 }, 'ArrowUp', 5).state.active).toBe(0);
  });

  it('Home and End jump while open, and pass through while closed', () => {
    expect(comboKey({ open: true, active: 2 }, 'Home', 5).state.active).toBe(0);
    expect(comboKey({ open: true, active: 2 }, 'End', 5).state.active).toBe(4);
    expect(comboKey(closed, 'Home', 5).handled).toBe(false);
  });

  it('Enter picks the active option; Escape closes and restores; Tab closes without trapping', () => {
    expect(comboKey({ open: true, active: 3 }, 'Enter', 5)).toMatchObject({ pick: 3, handled: true, state: { open: false } });
    expect(comboKey({ open: true, active: 3 }, 'Enter', 0).pick).toBeUndefined();
    expect(comboKey({ open: true, active: 3 }, 'Escape', 5)).toMatchObject({ restore: true, handled: true, state: { open: false } });
    expect(comboKey({ open: true, active: 3 }, 'Tab', 5)).toMatchObject({ restore: true, handled: false, state: { open: false } });
  });
});
