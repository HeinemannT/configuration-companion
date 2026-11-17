/**
 * The Extended Code window's own strip no longer repeats "Runs as … ·
 * browser session": the window's title bar names the server and the user.
 * Only an unconfirmed user is still said there (a save warning).
 */
import { describe, expect, it } from 'vitest';
import { ACTOR_NOT_CONFIRMED, actorStripText } from '../command-actor';

describe('the acting user in the window strip', () => {
  it('says nothing for a verified or still-checking user; warns when unconfirmed', () => {
    expect(actorStripText({ status: 'verified', actor: { user: 'alex', source: 'session', text: 'Runs as alex · browser session' } as never })).toBe('');
    expect(actorStripText({ status: 'checking' })).toBe('');
    expect(actorStripText({ status: 'unavailable' })).toBe(ACTOR_NOT_CONFIRMED);
  });
});
