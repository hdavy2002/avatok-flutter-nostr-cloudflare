import { describe, expect, it } from 'vitest';
import { formatLocalStart, toPseudoCard } from './SpiritualEventShelves';
import type { CardView } from '../../lib/types';

function baseCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'evt_1',
    kind: 'live_event',
    title: 'Morning Aarti',
    oneLiner: 'Live from the ghat',
    poster: 'https://example.com/poster.jpg',
    aiPoster: null,
    category: 'live_puja',
    categoryLabel: 'Puja',
    price: 199,
    listPrice: 199,
    promoPct: 0,
    currency: 'INR',
    ratingAvg: null,
    ratingCount: 0,
    reviewCount: 0,
    joinedCount: 0,
    startsAt: Date.now() + 3_600_000,
    durationMin: 60,
    capacity: null,
    spokenLang: 'Hindi,English',
    location: 'Haridwar',
    country: 'IN',
    adultsOnly: false,
    seatsLeft: null,
    watching: null,
    status: 'published',
    scheduleState: 'upcoming',
    live: false,
    favorited: false,
    createdAt: Date.now(),
    creator: { id: 'u1', handle: 'pandit-ram', name: 'Pandit Ram', avatar: null, verified: false },
    ...overrides,
  };
}

describe('toPseudoCard', () => {
  it('losslessly maps normalized CardView fields back onto the wire shape', () => {
    const c = baseCard();
    const card = toPseudoCard(c);
    expect(card.id).toBe('evt_1');
    expect(card.title).toBe('Morning Aarti');
    expect(card.starts_at).toBe(c.startsAt);
    expect(card.duration_min).toBe(60);
    expect(card.currency_display).toBe('INR');
    expect(card.creator?.name).toBe('Pandit Ram');
    expect(card.creator?.handle).toBe('pandit-ram');
    expect(card.schedule_state).toBe('upcoming');
  });

  it('never fabricates a creator when none is supplied', () => {
    const card = toPseudoCard(baseCard({ creator: null }));
    expect(card.creator).toBeNull();
  });

  it('leaves Card-only fields (free_entry, schedule_mode) absent rather than guessed', () => {
    const card = toPseudoCard(baseCard()) as unknown as Record<string, unknown>;
    expect(card.free_entry).toBeUndefined();
    expect(card.schedule_mode).toBeUndefined();
  });
});

describe('formatLocalStart', () => {
  it('returns null when there is no start time', () => {
    expect(formatLocalStart(null)).toBeNull();
    expect(formatLocalStart(0)).toBeNull();
  });

  it('produces a machine-readable ISO string and a visible zone label', () => {
    const ms = Date.UTC(2026, 9, 5, 14, 30);
    const result = formatLocalStart(ms);
    expect(result).not.toBeNull();
    expect(result?.iso).toBe(new Date(ms).toISOString());
    expect(result?.zone.length).toBeGreaterThan(0);
    expect(result?.label.length).toBeGreaterThan(0);
  });
});
