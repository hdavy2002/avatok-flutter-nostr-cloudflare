/* [LIST-WIZ-1] Draft -> the REAL marketplace card. Renders the same
 * ListingTile.tsx component the bazaar uses, fed a hand-built `Card` shaped
 * from the in-progress draft, so what the creator sees while filling the
 * form is what buyers will actually see — never a separate mock. */
import { useMemo } from 'react';
import { ListingTile } from '../../../components/ListingTile';
import type { Card as CardModel } from '../../../lib/types';
import type { ListingDraft } from './types';
import { localToEpoch } from './wizardLogic';

export function draftToCard(d: ListingDraft, creator?: { name?: string | null; handle?: string | null; avatar?: string | null }): CardModel {
  return {
    id: d.id ?? 'preview',
    kind: d.kind === 'ai_agent' ? 'agent' : d.kind,
    title: d.title || 'Untitled listing',
    one_liner: d.blurb || d.description?.slice(0, 80) || null,
    cover_media: d.cover_media.length ? d.cover_media : null,
    price: d.free_entry ? 0 : (d.price ? Number(d.price) : 0),
    category: d.category || null,
    location: d.location || null,
    starts_at: d.schedule_mode === 'fixed_date' ? localToEpoch(d.starts_at) : null,
    duration_min: d.duration_min || null,
    capacity: d.kind === 'consult' ? 1 : null,
    spoken_lang: d.spoken_lang.length ? d.spoken_lang.join(',') : null,
    adults_only: d.adults_only,
    free_entry: d.free_entry ? 1 : 0,
    billing_unit: (d.billing_unit as CardModel['billing_unit']) ?? null,
    blurb: d.blurb || null,
    schedule_mode: d.schedule_mode,
    vibe_tags: d.vibe_tags,
    credential: d.credential || null,
    joined_count: 0,
    creator: creator ? { name: creator.name, handle: creator.handle, avatar_url: creator.avatar } : null,
  };
}

export function PreviewCard({ draft, creator }: { draft: ListingDraft; creator?: { name?: string | null; handle?: string | null; avatar?: string | null } }) {
  const card = useMemo(() => draftToCard(draft, creator), [draft, creator]);
  return (
    // Preview only — the tile is a real <a href="/l/...">, which would navigate
    // away from the wizard on click. Swallow the click in the capture phase
    // rather than modifying ListingTile itself (that component is out of scope
    // for this work and is shared with the live marketplace).
    <div className="mx-auto w-full max-w-[320px]" onClickCapture={(e) => e.preventDefault()}>
      <ListingTile listing={card} section="wizard_preview" width={320} />
    </div>
  );
}

export default PreviewCard;
