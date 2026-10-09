// Green has to mean "will pick this case up now", not "has an account" or even
// "has a tab open". A signed-in session that was left running on a laptop overnight
// is the exact thing that turns a STAT head CT into an eight-hour-old surprise, so
// presence is built from a heartbeat the reader's browser has to keep sending, and
// the colour goes red on its own the moment the tab dies.

export const HEARTBEAT_SECONDS = 20;
export const IDLE_SECONDS = 90;

export type ReaderState = 'receiving' | 'paused' | 'away' | 'offline';

export type PresenceInput = {
  state: ReaderState;
  lastSeenAt: Date | null;
  now: Date;
  openCases: number;
  maxQueueSize: number;
};

export type PresenceCode = 'available' | 'at_cap' | 'paused' | 'away' | 'idle' | 'signed_out';

export type Presence = {
  color: 'green' | 'amber' | 'red';
  /** What the dispatcher filters on. Green and routable are the same fact. */
  routable: boolean;
  code: PresenceCode;
  /** Seconds since the last heartbeat, or null when there never was one. */
  sinceSeenSeconds: number | null;
};

export function readerPresence(input: PresenceInput): Presence {
  const sinceSeenSeconds = input.lastSeenAt
    ? Math.max(0, Math.round((input.now.getTime() - input.lastSeenAt.getTime()) / 1000))
    : null;

  const at = (color: Presence['color'], code: PresenceCode): Presence => ({
    color, code, routable: code === 'available', sinceSeenSeconds,
  });

  if (sinceSeenSeconds === null) return at('red', 'signed_out');
  if (sinceSeenSeconds > IDLE_SECONDS) return at('red', 'idle');
  // A heartbeat with state 'offline' is a reader who paused the board without
  // closing it. They are visibly here and deliberately not working.
  if (input.state === 'offline') return at('red', 'signed_out');
  if (input.state === 'paused') return at('amber', 'paused');
  if (input.state === 'away') return at('amber', 'away');
  // The cap is checked last: a full queue is a reader who is present and working,
  // which is a different thing to tell an operator than a reader who walked out.
  if (input.openCases >= input.maxQueueSize) return at('amber', 'at_cap');
  return at('green', 'available');
}

export const PRESENCE_LABEL: Record<PresenceCode, string> = {
  available: 'On panel',
  at_cap: 'At capacity',
  paused: 'Paused by reader',
  away: 'Stepped away',
  idle: 'No signal',
  signed_out: 'Signed out',
};
