import { describe, expect, it } from 'vitest';
import { IDLE_SECONDS, readerPresence } from '../src/presence.js';

const NOW = new Date('2026-10-09T14:00:00Z');
const seen = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);

const base = { now: NOW, openCases: 0, maxQueueSize: 5 };

describe('readerPresence', () => {
  it('is green for a reader who is here, receiving, and has a free slot', () => {
    const p = readerPresence({ ...base, state: 'receiving', lastSeenAt: seen(8) });
    expect(p).toMatchObject({ color: 'green', routable: true, code: 'available' });
  });

  // The whole reason presence is a heartbeat and not a login: a session cookie is
  // still valid twelve hours after the laptop lid closed.
  it('is red when the last heartbeat was a night ago, whatever the session says', () => {
    const p = readerPresence({ ...base, state: 'receiving', lastSeenAt: seen(60 * 60 * 11) });
    expect(p).toMatchObject({ color: 'red', routable: false, code: 'idle', sinceSeenSeconds: 39600 });
  });

  it('is red when a reader has never sent a heartbeat at all', () => {
    expect(readerPresence({ ...base, state: 'receiving', lastSeenAt: null }))
      .toMatchObject({ color: 'red', code: 'signed_out', sinceSeenSeconds: null });
  });

  it('takes the idle edge at exactly the threshold, not before', () => {
    expect(readerPresence({ ...base, state: 'receiving', lastSeenAt: seen(IDLE_SECONDS) }).color).toBe('green');
    expect(readerPresence({ ...base, state: 'receiving', lastSeenAt: seen(IDLE_SECONDS + 1) }).color).toBe('red');
  });

  it('is amber, not green, when the reader paused or stepped away', () => {
    expect(readerPresence({ ...base, state: 'paused', lastSeenAt: seen(3) }))
      .toMatchObject({ color: 'amber', code: 'paused', routable: false });
    expect(readerPresence({ ...base, state: 'away', lastSeenAt: seen(3) }))
      .toMatchObject({ color: 'amber', code: 'away', routable: false });
  });

  // A full queue is present-and-busy; a closed tab is absent. An operator deciding
  // whom to phone needs those two to look different.
  it('is amber at capacity and stays amber when the queue has overflowed', () => {
    expect(readerPresence({ ...base, state: 'receiving', lastSeenAt: seen(2), openCases: 5, maxQueueSize: 5 }))
      .toMatchObject({ color: 'amber', code: 'at_cap' });
    expect(readerPresence({ ...base, state: 'receiving', lastSeenAt: seen(2), openCases: 7, maxQueueSize: 5 }).routable)
      .toBe(false);
  });

  it('is red when a live tab has explicitly signed the reader off the panel', () => {
    expect(readerPresence({ ...base, state: 'offline', lastSeenAt: seen(1) }))
      .toMatchObject({ color: 'red', code: 'signed_out', routable: false });
  });
});
