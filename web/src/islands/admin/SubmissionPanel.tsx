// "What the creator submitted" — the heart of MKT-ADMIN-UI-1. Renders every
// creator-facing field grouped and labelled, a real image gallery for
// cover_media, and a safety-net "Other submitted fields" section for any
// attrs key not explicitly handled below (the creator form spans ~60 fields
// across three surfaces and grows).
import { useMemo } from 'react';
import { Field, Group, fmt, isEmptyValue, money, pick } from './adminListingsShared';
import { humanise, kindLabel, sectionLabel, scheduleLabel, mediaModeLabel } from './labels';
import type { CategoryInfo, CreatorInfo, ListingDetail } from './adminListingsShared';

// Every attrs/listing key rendered explicitly by a named group below. Used
// only to compute the "Other submitted fields" leftovers from `attrs`.
const HANDLED_ATTR_KEYS = new Set([
  'poster',
  'title', 'blurb', 'description', 'category', 'proposed_category', 'kind', 'vertical', 'section', 'slug',
  'vibe_tags', 'spoken_lang', 'credential',
  'price', 'billing_unit', 'free_entry', 'content_free_cap_tokens', 'max_per_booking', 'currency_display',
  'schedule_mode', 'starts_at', 'duration_min', 'recurrence_days', 'recurrence_time', 'timezone', 'capacity', 'response_time_min',
  'cover_media', 'video_url',
  'content_how_it_works', 'content_house_rules', 'content_house_rules_intro', 'content_what_you_get',
  'content_who_for', 'content_not_for', 'content_faq', 'content_sample_qa', 'content_sample_chat',
  'content_can_do', 'content_cant_do', 'join_requirements',
  'commercial_refund_window_hours', 'commercial_cancellation_window_hours', 'commercial_reschedule_allowed',
  'commercial_booking_notice_hours', 'commercial_preparation_instructions', 'commercial_no_show_policy',
  'agent_instructions', 'public_agent_brief', 'seller_private_rules', 'never_disclose', 'floor_price', 'ask_before_commit',
  'adults_only', 'country', 'location', 'translation_enabled',
  'badges', 'creator_id', 'created_at', 'updated_at', 'id', 'status',
]);

export default function SubmissionPanel({ listing, creator, category }: { listing: ListingDetail; creator: CreatorInfo; category: CategoryInfo }) {
  const attrs = listing.attrs ?? {};
  const p = (key: string) => pick(listing, attrs, key);
  // [ADMIN-PLAIN-1] Marketplace kinds are the genuinely multi-currency ones;
  // live events and 1:1 sessions are priced in tokens (1 token = ₹1).
  const isMarketKind = ['sell', 'buy', 'social'].includes(String(listing.kind ?? ''));

  const otherAttrKeys = useMemo(
    () => Object.keys(attrs).filter((k) => !HANDLED_ATTR_KEYS.has(k) && !k.startsWith('commercial_') && !isEmptyValue(attrs[k])),
    [attrs],
  );
  // commercial_* keys not in the named list above — the owner form can add more.
  const otherCommercialKeys = useMemo(
    () => Object.keys(attrs).filter((k) => k.startsWith('commercial_') && !HANDLED_ATTR_KEYS.has(k) && !isEmptyValue(attrs[k])),
    [attrs],
  );

  const cover = Array.isArray(listing.cover_media) ? listing.cover_media : [];
  const videoUrl = p('video_url');
  const categoryLabel = category?.label ?? (p('category') as string | undefined);

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <h3 className="font-display text-[18px] font-semibold text-ink">What the creator submitted</h3>
      <div className="mt-4 grid gap-3">
        <Group title="Identity">
          <div className="flex items-center gap-3 py-1.5">
            {creator?.avatar_url ? (
              <img src={creator.avatar_url} alt={creator?.display_name ?? creator?.handle ?? 'Creator avatar'} className="h-12 w-12 rounded-full border-zine border-ink object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full border-zine border-ink bg-paper2 font-display text-[16px] text-inkMute">?</div>
            )}
            <div className="min-w-0">
              <div className="truncate font-body text-[15px] font-extrabold text-ink">{creator?.display_name ?? 'No display name'}</div>
              <div className="truncate font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkSoft">@{creator?.handle ?? 'unknown'}</div>
            </div>
          </div>
          {/* [ADMIN-PLAIN-1] The uid is kept but named for what it is and put
              LAST, under the human details — a reviewer needs the name; the id
              is for when they have to quote it to an engineer. */}
          <Field label="Identity check" value={humanise(creator?.kyc_status)} allowEmptyLabel="not verified" />
          <Field label="Submitted" value={fmt(listing.created_at as number | undefined)} />
          <Field label="Last updated" value={fmt(listing.updated_at as number | undefined)} />
          <Field label="Account id (for support)" value={listing.creator_id ?? creator?.id} allowEmptyLabel="not provided" />
        </Group>

        <Group title="Basics">
          <Field label="Title" value={listing.title} allowEmptyLabel="not provided" />
          <Field label="Blurb" value={p('blurb')} allowEmptyLabel="not provided" />
          <Field label="Description" value={listing.description} allowEmptyLabel="not provided" />
          <Field label="Category" value={categoryLabel} allowEmptyLabel="not provided" />
          <Field label="Proposed category" value={p('proposed_category')} />
          <Field label="Type" value={kindLabel(listing.kind)} allowEmptyLabel="not provided" />
          <Field label="Shown in" value={sectionLabel(p('section'))} />
          <Field label="Web address" value={p('slug')} />
          <Field label="Vibe tags" value={p('vibe_tags')} />
          <Field label="Spoken languages" value={p('spoken_lang')} />
          <Field label="Credential" value={p('credential')} />
        </Group>

        <Group title="Money">
          <Field label="Price" value={money(p('price') as number | undefined)} />
          <Field label="Charged" value={p('billing_unit') === 'hour' ? 'per hour' : humanise(p('billing_unit'))} />
          <Field label="Free entry" value={Number(p('free_entry')) === 1 ? 'yes' : 'no'} />
          <Field label="Free-entry cap (tokens)" value={p('content_free_cap_tokens')} />
          <Field label="Max per booking" value={p('max_per_booking')} />
          {/* [ADMIN-PLAIN-1 2026-09-05] `currency_display` is hidden for live
              events and 1:1 sessions, and it was showing "USD" on a listing
              priced in rupees.
              It is not a bug in the data so much as a column that does not apply:
              creator sessions are priced in TOKENS, 1 token = ₹1, and the price
              above already prints ₹. The web wizard never sets this field, so
              every web-created listing carries the schema default 'USD'
              (migrations/listings.sql) — a value nobody chose, describing a
              currency nobody is charged in. It stays visible for marketplace
              kinds, which ARE genuinely multi-currency, and it is not deleted
              from the DB because shipped clients still read the column. */}
          {isMarketKind && <Field label="Listing currency" value={p('currency_display')} />}
        </Group>

        <Group title="Time & availability">
          <Field label="Schedule" value={scheduleLabel(p('schedule_mode'))} />
          <Field label="Starts at" value={p('starts_at') ? fmt(Number(p('starts_at'))) : undefined} />
          <Field label="Duration (min)" value={p('duration_min')} />
          <Field label="Recurrence days" value={p('recurrence_days')} />
          <Field label="Recurrence time" value={p('recurrence_time')} />
          <Field label="Timezone" value={p('timezone')} />
          <Field label="Capacity" value={p('capacity')} />
          {/* [SESSION-MEDIA-1 2026-09-05] Owner request: the reviewer must see
              whether this session is audio+video or audio only. It is a real
              `listings` column and has been collected by the wizard since
              [MKT-3GROUP-1], but no surface ever displayed it. It matters to a
              reviewer because audio_video means the creator may NOT turn video
              off — they sold a video session, and one that goes audio-only
              mid-way is a refund. */}
          <Field label="Audio/video" value={mediaModeLabel(p('media_mode'))} />
          <Field label="Response time (min)" value={p('response_time_min')} />
        </Group>

        <Group title="Media">
          {cover.length > 0 ? (
            <div className="py-2">
              <div className="mb-2 font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkMute">Cover media ({cover.length})</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {cover.map((m, i) => (
                  m?.url ? (
                    <a key={i} href={m.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-zineField border-zine border-ink">
                      <img src={m.url} alt={`${listing.title ?? 'Listing'} cover photo ${i + 1}`} className="aspect-square w-full object-cover" />
                    </a>
                  ) : null
                ))}
              </div>
            </div>
          ) : (
            <Field label="Cover media" value={undefined} allowEmptyLabel="creator submitted no cover photos" />
          )}
          {videoUrl ? (
            <div className="py-2">
              <div className="mb-2 font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkMute">Video</div>
              <video src={String(videoUrl)} controls className="w-full max-w-md rounded-zineField border-zine border-ink" />
            </div>
          ) : (
            <Field label="Video URL" value={undefined} allowEmptyLabel="not provided" />
          )}
        </Group>

        <Group title="Content blocks">
          <Field label="How it works" value={p('content_how_it_works')} />
          <Field label="House rules intro" value={p('content_house_rules_intro')} />
          <Field label="House rules" value={p('content_house_rules')} />
          <Field label="What you get" value={p('content_what_you_get')} />
          <Field label="Who it's for" value={p('content_who_for')} />
          <Field label="Not for" value={p('content_not_for')} />
          <Field label="Can do" value={p('content_can_do')} />
          <Field label="Can't do" value={p('content_cant_do')} />
          <Field label="FAQ" value={p('content_faq')} />
          <Field label="Sample Q&A" value={p('content_sample_qa')} />
          <Field label="Sample chat" value={p('content_sample_chat')} />
          <Field label="Join requirements" value={p('join_requirements')} />
          <Field label="Refund window (hrs)" value={p('commercial_refund_window_hours')} />
          <Field label="Cancellation window (hrs)" value={p('commercial_cancellation_window_hours')} />
          <Field label="Reschedule allowed" value={p('commercial_reschedule_allowed')} />
          <Field label="Booking notice (hrs)" value={p('commercial_booking_notice_hours')} />
          <Field label="Preparation instructions" value={p('commercial_preparation_instructions')} />
          <Field label="No-show policy" value={p('commercial_no_show_policy')} />
          {otherCommercialKeys.map((k) => <Field key={k} label={k.replace(/^commercial_/, '')} value={attrs[k]} />)}
        </Group>

        <Group title="Agent mandate" note="Private — admin only">
          <Field label="Agent instructions" value={p('agent_instructions')} />
          <Field label="Public agent brief" value={p('public_agent_brief')} />
          <Field label="Seller private rules" value={p('seller_private_rules')} />
          <Field label="Never disclose" value={p('never_disclose')} />
          <Field label="Floor price" value={p('floor_price') != null ? money(Number(p('floor_price'))) : undefined} />
          <Field label="Ask before commit" value={p('ask_before_commit')} />
        </Group>

        <Group title="Flags">
          <Field label="Adults only" value={p('adults_only')} />
          <Field label="Country" value={p('country')} />
          <Field label="Location" value={p('location')} />
          <Field label="Translation enabled" value={p('translation_enabled')} />
        </Group>

        {otherAttrKeys.length > 0 && (
          <details className="rounded-zineField border-zine border-ink bg-paper2 p-4">
            <summary className="cursor-pointer font-display text-[15px] font-semibold uppercase tracking-[0.02em] text-ink">
              Other submitted fields ({otherAttrKeys.length})
            </summary>
            <p className="mt-1 font-body text-[12px] font-bold text-inkMute">Not yet mapped to a named section above — shown raw so nothing the creator wrote goes unseen.</p>
            <div className="mt-2 divide-y divide-ink/10">
              {otherAttrKeys.map((k) => <Field key={k} label={k} value={attrs[k]} />)}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
