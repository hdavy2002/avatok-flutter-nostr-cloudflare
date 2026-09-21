// [SHV2-S3 contracts.md §2a] Proves the optional `action` prop is additive:
// absent → identical markup/data-cta contract to before; present → replaces
// the tile's own action button(s) with one link carrying `action.cta`.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListingTile } from './ListingTile';
import type { Card } from '../lib/types';

function baseListing(overrides: Partial<Card> = {}): Card {
  return {
    id: 'evt_1',
    kind: 'live_event',
    title: 'Morning Aarti',
    one_liner: 'Live from the ghat',
    price: 199,
    creator: { uid: 'u1', handle: 'pandit-ram', name: 'Pandit Ram' },
    status: 'published',
    starts_at: Date.now() + 3_600_000,
    duration_min: 60,
    ...overrides,
  } as Card;
}

describe('ListingTile action prop (AC-14)', () => {
  it('renders the lane-driven primary/secondary buttons and quick_info cta when action is absent', () => {
    const html = renderToStaticMarkup(<ListingTile listing={baseListing()} section="home_live" position={0} />);
    // Non-poster-first path (no aiPoster/poster on the fixture): primary + secondary spans present.
    expect(html).toContain('data-cta="book"');
    expect(html).toContain('data-cta="details"');
    expect(html).not.toContain('data-cta="join_now"');
    expect(html).not.toContain('data-cta="view_details"');
  });

  it('replaces the internal buttons with a single action link carrying cta="join_now"', () => {
    const html = renderToStaticMarkup(
      <ListingTile
        listing={baseListing()}
        section="home_live"
        position={0}
        action={{ label: 'Join now', href: '/l/evt_1', cta: 'join_now' }}
      />,
    );
    expect(html).toContain('data-cta="join_now"');
    expect(html).toContain('Join now');
    // The lane's own buttons must not also render alongside the override.
    expect(html).not.toContain('data-cta="book"');
    expect(html).not.toContain('data-cta="details"');
  });

  it('replaces the internal buttons with a single action link carrying cta="view_details"', () => {
    const html = renderToStaticMarkup(
      <ListingTile
        listing={baseListing()}
        section="home_live"
        position={0}
        action={{ label: 'View details', href: '/l/evt_1', cta: 'view_details' }}
      />,
    );
    expect(html).toContain('data-cta="view_details"');
    expect(html).toContain('View details');
  });
});
