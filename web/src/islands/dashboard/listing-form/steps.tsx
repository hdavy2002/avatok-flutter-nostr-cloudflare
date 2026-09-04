/* [LIST-WIZ-1] The 8 step bodies. Each is a plain function component taking
 * `draft` + `patch` (a partial-state setter) plus whatever step-specific
 * plumbing it needs (categories list, upload handler, slot API calls). All
 * validation happens in wizardLogic.ts / ListingWizard.tsx — these components
 * only render inputs and call `patch`. */
import { useRef, useState } from 'react';
import { Field } from '../../../components/Field';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { PreviewCard } from './PreviewCard';
import { CopyReview } from './CopyReview';
import { TwoFieldListEditor, StringListEditor, ChatLineEditor, labelCls, inputCls, textareaCls, SectionHeader, charCount } from './Editors';
import { VIBE_TAGS, BILLING_UNITS, REFUND_WINDOWS, BOOKING_NOTICE_HOURS } from './wizardLogic';
import { defaultsFor, SERVICE_CATEGORY_IDS } from '../../../lib/listingDefaults';
import type { ListingDraft, DraftSlot, Kind } from './types';

type Patch = (p: Partial<ListingDraft>) => void;
type CreatorInfo = { name?: string | null; handle?: string | null; avatar?: string | null };
const LANGS = ['Hindi', 'English', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Gujarati', 'Punjabi', 'Urdu', 'Kannada', 'Malayalam'];
const RECUR_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* [LIST-WIZ-TZ-1] Common timezones a creator picks from, IST first and
 * pre-selected (the vast majority of creators today) — never the raw IANA
 * id in a free-text box. "Other…" reveals the text input for anything else,
 * still validated by wizardLogic.isValidTimezone. */
const TZ_OPTIONS: { value: string; label: string }[] = [
  { value: 'Asia/Kolkata', label: 'India (IST, Asia/Kolkata)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST, Asia/Dubai)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT, Asia/Singapore)' },
  { value: 'Europe/London', label: 'London (GMT/BST, Europe/London)' },
  { value: 'America/New_York', label: 'New York (ET, America/New_York)' },
  { value: 'America/Toronto', label: 'Toronto (ET, America/Toronto)' },
  { value: 'Australia/Sydney', label: 'Sydney (AET, Australia/Sydney)' },
];
const TZ_OTHER = '__other__';

export interface FieldErr { field: string | null; message: string | null }

function ErrLine({ err, field }: { err: FieldErr; field: string }) {
  if (err.field !== field || !err.message) return null;
  return <p className="mt-1 font-body font-bold text-[13px] text-coral">⚠ {err.message}</p>;
}

// ── Step 1 — Type ──────────────────────────────────────────────────────────
const KINDS: { key: Kind; label: string; sub: string; chip: string; disabled?: boolean }[] = [
  { key: 'live_event', label: 'Live event', sub: 'Broadcast to ticket holders', chip: '◐' },
  { key: 'consult', label: '1:1 consult', sub: 'Private video session', chip: '◑' },
  { key: 'ai_agent', label: 'AI agent', sub: 'Coming soon', chip: '✦', disabled: true },
];
const SCHEDULE_OPTS: { key: ListingDraft['schedule_mode']; label: string; sub: string }[] = [
  { key: 'fixed_date', label: 'One fixed date', sub: 'A single date and time' },
  { key: 'recurring', label: 'Recurring', sub: 'Same day(s) and time every week' },
  { key: 'on_request', label: 'On request', sub: 'People request a time, you confirm' },
  { key: 'always_on', label: 'Always on', sub: 'No fixed schedule — join any time' },
];

export function Step1Type({ draft, patch, err }: { draft: ListingDraft; patch: Patch; err: FieldErr }) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className={labelCls}>Type</span>
        <div className="grid grid-cols-3 gap-2">
          {KINDS.map((k) => (
            <button key={k.key} type="button" disabled={k.disabled}
              onClick={() => patch({ kind: k.key })}
              className={['flex flex-col items-start gap-1 rounded-zine border-zine border-ink p-2.5 text-left shadow-zine-xs transition-transform duration-zine',
                k.disabled ? 'opacity-40' : '', draft.kind === k.key ? 'bg-lime' : 'bg-card'].join(' ')}>
              <span className="text-[18px]">{k.chip}</span>
              <span className="font-display font-semibold text-[13px] text-ink">{k.label}</span>
              <span className="font-body font-bold text-[11px] text-inkSoft">{k.sub}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-3 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs">
        <input type="checkbox" checked={draft.free_entry} onChange={(e) => patch({ free_entry: e.target.checked })}
          className="h-5 w-5 rounded border-zine border-ink" />
        <span className="font-body font-bold text-[14px] text-ink">This is a free show</span>
      </label>
      {draft.free_entry && (
        <div>
          <p className="mb-2 font-body font-bold text-[13px] text-inkSoft">
            This is what you&rsquo;re willing to spend from your wallet for this show.
          </p>
          <Field label="Token cap" inputMode="numeric" placeholder="e.g. 500" value={draft.content_free_cap_tokens}
            onChange={(e) => patch({ content_free_cap_tokens: e.target.value.replace(/[^0-9]/g, '') })} />
          <ErrLine err={err} field="content_free_cap_tokens" />
        </div>
      )}

      <div>
        <span className={labelCls}>Schedule</span>
        <div className="flex flex-col gap-2">
          {SCHEDULE_OPTS.map((o) => (
            <button key={o.key} type="button" onClick={() => patch({ schedule_mode: o.key })}
              className={['flex items-center justify-between rounded-zine border-zine border-ink p-3 text-left shadow-zine-xs',
                draft.schedule_mode === o.key ? 'bg-lime' : 'bg-card'].join(' ')}>
              <span>
                <span className="block font-display font-semibold text-[14px] text-ink">{o.label}</span>
                <span className="block font-body font-bold text-[12px] text-inkSoft">{o.sub}</span>
              </span>
              {draft.schedule_mode === o.key && <span className="text-[18px]">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 2 — Pitch ─────────────────────────────────────────────────────────
export function Step2Pitch({ draft, patch, err, categories, creator, onReviewed }: {
  draft: ListingDraft; patch: Patch; err: FieldErr; categories: { id: string; label: string; emoji?: string | null }[];
  creator?: CreatorInfo;
  /** [CARD-AI-REVIEW-1] Ticks the publish checklist once a review has run. */
  onReviewed: () => void;
}) {
  // [LIST-WIZ-CAT-1] The wizard only ever creates live_event/consult/ai_agent
  // listings — /api/explore/categories has no per-row kind to filter server-side,
  // so a marketplace-goods category (Cars, Properties, Mobiles…) would otherwise
  // show up right next to Teachers and Astrologers. Filter to the fixed
  // service/creator id set before rendering the options.
  const serviceCategories = categories.filter((c) => SERVICE_CATEGORY_IDS.has(c.id));
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-5">
        <div>
          <Field label="Title" placeholder="e.g. Friday night live cook-along" value={draft.title}
            onChange={(e) => patch({ title: e.target.value.slice(0, 140) })} />
          <ErrLine err={err} field="title" />
        </div>
        <div>
          <Field label="Blurb (one line)" placeholder="What fans get, in one punchy line" value={draft.blurb}
            onChange={(e) => patch({ blurb: e.target.value.slice(0, 120) })} />
          <div className="mt-1 flex">{charCount(draft.blurb, 120)}</div>
          <ErrLine err={err} field="blurb" />
        </div>
        <label className="block">
          <span className={labelCls}>Description</span>
          <textarea className={textareaCls} rows={4} value={draft.description} maxLength={8000}
            placeholder="Tell people what to expect" onChange={(e) => patch({ description: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Category</span>
          <select className={inputCls} value={draft.category} onChange={(e) => patch({ category: e.target.value })}>
            <option value="">Choose one…</option>
            {serviceCategories.map((c) => <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.label}</option>)}
          </select>
          <ErrLine err={err} field="category" />
        </label>
        <div>
          <span className={labelCls}>Vibe (up to 2)</span>
          <div className="flex flex-wrap gap-2">
            {VIBE_TAGS.map((t) => {
              const on = draft.vibe_tags.includes(t);
              return (
                <button key={t} type="button"
                  onClick={() => patch({ vibe_tags: on ? draft.vibe_tags.filter((x) => x !== t) : draft.vibe_tags.length < 2 ? [...draft.vibe_tags, t] : draft.vibe_tags })}
                  className={['rounded-zineField border-zine border-ink px-3 py-1.5 font-body font-bold text-[12px] shadow-zine-xs', on ? 'bg-lime text-ink' : 'bg-card text-inkSoft'].join(' ')}>
                  {t.replace(/_/g, ' ')}
                </button>
              );
            })}
          </div>
          <ErrLine err={err} field="vibe_tags" />
        </div>
        <div>
          <span className={labelCls}>Language</span>
          <div className="flex flex-wrap gap-2">
            {LANGS.map((l) => {
              const on = draft.spoken_lang.includes(l);
              return (
                <button key={l} type="button"
                  onClick={() => patch({ spoken_lang: on ? draft.spoken_lang.filter((x) => x !== l) : [...draft.spoken_lang, l] })}
                  className={['rounded-zineField border-zine border-ink px-3 py-2 font-body font-bold text-[13px] shadow-zine-xs', on ? 'bg-lime text-ink' : 'bg-card text-inkSoft'].join(' ')}>
                  {l}
                </button>
              );
            })}
          </div>
        </div>
        {/* [CARD-AI-REVIEW-1] Sits directly under the fields it edits, and above
            the live preview on narrow screens, so "Use this" and the card that
            changes because of it are visible in one glance. */}
        <CopyReview draft={draft} patch={patch} onReviewed={onReviewed} />
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 text-center font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Live preview</p>
        <PreviewCard draft={draft} creator={creator} />
      </div>
    </div>
  );
}

// ── Step 3 — Money ─────────────────────────────────────────────────────────
export function Step3Money({ draft, patch, err }: { draft: ListingDraft; patch: Patch; err: FieldErr }) {
  return (
    <div className="flex flex-col gap-5">
      {draft.free_entry ? (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            This is a free show — attendees pay nothing. Your token cap
            ({draft.content_free_cap_tokens || '—'} tokens) is what you set in step 1.
          </p>
        </Card>
      ) : (
        <div>
          <Field label="Price (Tokens = ₹)" inputMode="numeric" placeholder="0 = free" value={draft.price}
            onChange={(e) => patch({ price: e.target.value.replace(/[^0-9]/g, '') })} />
          <ErrLine err={err} field="price" />
        </div>
      )}
      <label className="block">
        <span className={labelCls}>Charged per</span>
        <select className={inputCls} value={draft.billing_unit} onChange={(e) => patch({ billing_unit: e.target.value })}>
          {BILLING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <ErrLine err={err} field="billing_unit" />
      </label>
      {!draft.free_entry && (
        <>
          <div>
            <Field label="Early-bird discount % (optional)" inputMode="numeric" placeholder="e.g. 20" value={draft.early_bird_pct}
              onChange={(e) => patch({ early_bird_pct: e.target.value.replace(/[^0-9]/g, '') })} />
            <ErrLine err={err} field="early_bird_pct" />
          </div>
          <Field label="Promo code (optional)" placeholder="e.g. FRIENDS20" value={draft.promo_code}
            onChange={(e) => patch({ promo_code: e.target.value.toUpperCase().slice(0, 24) })} />
        </>
      )}
    </div>
  );
}

// ── Step 4 — Time ──────────────────────────────────────────────────────────
export function Step4Time({ draft, patch, err, slotsSupported, onAddSlot, onRemoveSlot, slotBusy }: {
  draft: ListingDraft; patch: Patch; err: FieldErr;
  slotsSupported: boolean | null; // null = unknown yet
  onAddSlot: (s: Omit<DraftSlot, 'id'>) => void;
  onRemoveSlot: (id: string) => void;
  slotBusy: boolean;
}) {
  const [slotDraft, setSlotDraft] = useState({ starts_at: '', duration_min: 60, label: '', capacity: draft.kind === 'consult' ? 1 : 10 });
  const showTimeFields = draft.schedule_mode === 'fixed_date' || draft.schedule_mode === 'recurring';
  // [LIST-WIZ-TZ-1] Show the free-text box only when the current timezone isn't
  // one of the friendly options — i.e. it was picked "Other…", loaded from an
  // existing listing with an uncommon tz, or (pre-normalization) a legacy id.
  const [tzOther, setTzOther] = useState(!TZ_OPTIONS.some((o) => o.value === draft.timezone));
  return (
    <div className="flex flex-col gap-5">
      <label className="block">
        <span className={labelCls}>Timezone</span>
        <select className={inputCls} value={tzOther ? TZ_OTHER : draft.timezone}
          onChange={(e) => {
            if (e.target.value === TZ_OTHER) { setTzOther(true); return; }
            setTzOther(false);
            patch({ timezone: e.target.value });
          }}>
          {TZ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          <option value={TZ_OTHER}>Other…</option>
        </select>
        {tzOther && (
          <input type="text" className={`${inputCls} mt-2`} placeholder="e.g. Asia/Tokyo"
            value={draft.timezone} onChange={(e) => patch({ timezone: e.target.value })} />
        )}
        <ErrLine err={err} field="timezone" />
      </label>

      {draft.schedule_mode === 'fixed_date' && (
        <>
          <div>
            <Field label="Starts" type="datetime-local" value={draft.starts_at} onChange={(e) => patch({ starts_at: e.target.value })} />
            <ErrLine err={err} field="starts_at" />
          </div>
          <label className="block">
            <span className={labelCls}>Length (minutes)</span>
            <input type="number" min={5} max={480} className={inputCls} value={draft.duration_min}
              onChange={(e) => patch({ duration_min: Number(e.target.value) })} />
            <ErrLine err={err} field="duration_min" />
          </label>
        </>
      )}

      {draft.schedule_mode === 'recurring' && (
        <>
          <div>
            <span className={labelCls}>Days</span>
            <div className="flex flex-wrap gap-2">
              {RECUR_DAYS.map((d, i) => {
                const on = draft.recurrence_days.includes(i);
                return (
                  <button key={d} type="button"
                    onClick={() => patch({ recurrence_days: on ? draft.recurrence_days.filter((x) => x !== i) : [...draft.recurrence_days, i].sort() })}
                    className={['rounded-full border-zine border-ink px-3 py-2 font-body font-bold text-[13px]', on ? 'bg-lime text-ink' : 'bg-card text-inkSoft'].join(' ')}>
                    {d}
                  </button>
                );
              })}
            </div>
            <ErrLine err={err} field="recurrence_days" />
          </div>
          <label className="block">
            <span className={labelCls}>Time</span>
            <input type="time" className={inputCls} value={draft.recurrence_time} onChange={(e) => patch({ recurrence_time: e.target.value })} />
            <ErrLine err={err} field="recurrence_time" />
          </label>
          <label className="block">
            <span className={labelCls}>Length (minutes)</span>
            <input type="number" min={5} max={480} className={inputCls} value={draft.duration_min}
              onChange={(e) => patch({ duration_min: Number(e.target.value) })} />
            <ErrLine err={err} field="duration_min" />
          </label>
        </>
      )}

      {(draft.schedule_mode === 'on_request' || draft.schedule_mode === 'always_on') && (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            {draft.schedule_mode === 'on_request'
              ? 'No fixed time — people will request a slot and you confirm it.'
              : 'No fixed time — this listing is joinable any time.'}
          </p>
        </Card>
      )}

      {showTimeFields && (
        <div>
          <SectionHeader title="Specific time slots (optional)" hint="Offer several named time options instead of one fixed start." />
          {slotsSupported === false ? (
            <p className="mt-2 font-body font-bold text-[13px] text-inkSoft">Slot booking is coming soon — for now, use the single start time above.</p>
          ) : (
            <div className="mt-2 flex flex-col gap-3">
              {draft.slots.map((s) => (
                <div key={s.id ?? s.starts_at} className="flex items-center justify-between rounded-zine border-zine border-ink bg-card p-2.5 shadow-zine-xs">
                  <span className="font-body font-bold text-[13px] text-ink">
                    {s.label || 'Slot'} · {new Date(s.starts_at).toLocaleString()} · {s.duration_min}min · cap {s.capacity}
                  </span>
                  {s.id && <button type="button" onClick={() => onRemoveSlot(s.id!)} className="font-body font-bold text-[12px] text-coral">Remove</button>}
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2 rounded-zine border-zine border-dashed border-ink p-2.5">
                <label className="block">
                  <span className={labelCls}>Slot start</span>
                  <input type="datetime-local" className={inputCls} value={slotDraft.starts_at} onChange={(e) => setSlotDraft((s) => ({ ...s, starts_at: e.target.value }))} />
                </label>
                <label className="block">
                  <span className={labelCls}>Label (optional)</span>
                  <input type="text" placeholder="e.g. Morning batch" className={inputCls} value={slotDraft.label} onChange={(e) => setSlotDraft((s) => ({ ...s, label: e.target.value }))} />
                </label>
                <label className="block">
                  <span className={labelCls}>Duration (min)</span>
                  <input type="number" placeholder="60" className={inputCls} value={slotDraft.duration_min} onChange={(e) => setSlotDraft((s) => ({ ...s, duration_min: Number(e.target.value) }))} />
                </label>
                <label className="block">
                  <span className={labelCls}>Seats</span>
                  <input type="number" placeholder="10" className={inputCls} value={slotDraft.capacity} onChange={(e) => setSlotDraft((s) => ({ ...s, capacity: Number(e.target.value) }))} />
                </label>
                <Button variant="blue" label="Add slot" loading={slotBusy} className="col-span-2"
                  onClick={() => {
                    const ms = new Date(slotDraft.starts_at).getTime();
                    if (!Number.isFinite(ms)) return;
                    onAddSlot({ starts_at: ms, duration_min: slotDraft.duration_min, label: slotDraft.label, capacity: slotDraft.capacity });
                    setSlotDraft({ starts_at: '', duration_min: 60, label: '', capacity: draft.kind === 'consult' ? 1 : 10 });
                  }} />
              </div>
            </div>
          )}
        </div>
      )}

      {(draft.kind === 'consult' || draft.kind === 'ai_agent') && (
        <div>
          <Field label="Typical reply time (minutes, optional)" inputMode="numeric" value={draft.response_time_min}
            onChange={(e) => patch({ response_time_min: e.target.value.replace(/[^0-9]/g, '') })} />
          <ErrLine err={err} field="response_time_min" />
        </div>
      )}
      {draft.kind !== 'consult' && (
        <label className="block">
          <span className={labelCls}>Seats (capacity)</span>
          <input type="number" min={0} max={5000} className={inputCls} value={draft.capacity || ''} placeholder="e.g. 60 — blank = unlimited"
            onChange={(e) => patch({ capacity: Number(e.target.value) || 0 })} />
          <p className="mt-1 font-body font-bold text-[12px] text-inkSoft">Total seats for this show. The page shows “32 of 60 free”; leave blank for no cap.</p>
          <ErrLine err={err} field="capacity" />
        </label>
      )}
      <label className="block">
        <span className={labelCls}>Max bookings per person</span>
        <input type="number" min={1} max={20} className={inputCls} value={draft.max_per_booking}
          onChange={(e) => patch({ max_per_booking: Number(e.target.value) })} />
        <p className="mt-1 font-body font-bold text-[12px] text-inkSoft">Seats one person can book in one go.</p>
        <ErrLine err={err} field="max_per_booking" />
      </label>
    </div>
  );
}

// ── Step 5 — How it works ──────────────────────────────────────────────────
export function Step5HowItWorks({ draft, patch }: { draft: ListingDraft; patch: Patch }) {
  const flavourKey = `${draft.category}:${draft.kind}`;
  function applyDefaults() {
    const d = defaultsFor(draft.category, draft.kind);
    patch({ content_how_it_works: d.howItWorks, defaultsAppliedFor: flavourKey });
  }
  return (
    <div className="flex flex-col gap-4">
      {/* [LIST-OPTIONAL-CONTENT-1] Optional — min={0}. The copy must not claim
          a minimum the validator no longer enforces; a form that says
          "minimum 2" while Next works at 0 is worse than either rule alone. */}
      <SectionHeader title="How it works" hint="Optional — up to 5 short steps explaining what happens once someone books. Skip it if you'd rather."
        action={<button type="button" onClick={applyDefaults} className="font-body font-bold text-[12px] text-blueInk underline">Use suggested</button>} />
      <TwoFieldListEditor
        items={draft.content_how_it_works as unknown as Record<string, string>[]}
        onChange={(next) => patch({ content_how_it_works: next as unknown as ListingDraft['content_how_it_works'] })}
        aKey="label" bKey="body" aLabel="Step name" bLabel="What happens" aMax={24} bMax={240}
        aPlaceholder="e.g. Join" bPlaceholder="Describe this step" min={0} max={5}
        addLabel="Add a step" itemNoun="Step" />
    </div>
  );
}

// ── Step 6 — House rules & details ─────────────────────────────────────────
export function Step6HouseRules({ draft, patch }: { draft: ListingDraft; patch: Patch }) {
  const flavourKey = `${draft.category}:${draft.kind}`;
  function applyDefaults() {
    const d = defaultsFor(draft.category, draft.kind);
    patch({
      content_house_rules_intro: d.houseRulesIntro,
      content_house_rules: d.houseRules,
      content_what_you_get: d.whatYouGet,
      content_who_for: d.whoFor,
      content_not_for: d.notFor,
      content_faq: d.faq,
      content_sample_qa: d.sampleQa ?? [],
      content_sample_chat: d.sampleChat ?? [],
      content_can_do: d.canDo ?? [],
      content_cant_do: d.cantDo ?? [],
      credential: draft.credential || d.credential || '',
      defaultsAppliedFor: flavourKey,
    });
  }
  return (
    <div className="flex flex-col gap-7">
      {/* [LIST-OPTIONAL-CONTENT-1] Optional — min={0} on the rules editor. */}
      <SectionHeader title="House rules" hint="Optional — up to 8 rules, plus a short intro line. Skip it if you'd rather."
        action={<button type="button" onClick={applyDefaults} className="font-body font-bold text-[12px] text-blueInk underline">Use suggested for this category</button>} />
      <label className="block">
        <span className={labelCls}>Intro line</span>
        <textarea className={textareaCls} rows={2} maxLength={280} value={draft.content_house_rules_intro}
          onChange={(e) => patch({ content_house_rules_intro: e.target.value })} />
        <div className="mt-1 flex">{charCount(draft.content_house_rules_intro, 280)}</div>
      </label>
      <TwoFieldListEditor
        items={draft.content_house_rules as unknown as Record<string, string>[]}
        onChange={(next) => patch({ content_house_rules: next as unknown as ListingDraft['content_house_rules'] })}
        aKey="heading" bKey="body" aLabel="Rule" bLabel="Detail" aMax={32} bMax={200}
        min={0} max={8} addLabel="Add a rule" itemNoun="Rule" />

      <div>
        <span className={labelCls}>What you get (3–5)</span>
        <StringListEditor items={draft.content_what_you_get} onChange={(next) => patch({ content_what_you_get: next })}
          itemMax={80} min={3} max={5} addLabel="Add an item" placeholder="e.g. Live Q&A" />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Who this is for (up to 3)</span>
          <StringListEditor items={draft.content_who_for} onChange={(next) => patch({ content_who_for: next })}
            itemMax={80} min={0} max={3} addLabel="Add" />
        </div>
        <div>
          <span className={labelCls}>Not for (up to 3)</span>
          <StringListEditor items={draft.content_not_for} onChange={(next) => patch({ content_not_for: next })}
            itemMax={80} min={0} max={3} addLabel="Add" />
        </div>
      </div>

      <div>
        <span className={labelCls}>FAQ (3–6)</span>
        <TwoFieldListEditor items={draft.content_faq as unknown as Record<string, string>[]}
          onChange={(next) => patch({ content_faq: next as unknown as ListingDraft['content_faq'] })}
          aKey="q" bKey="a" aLabel="Question" bLabel="Answer" aMax={120} bMax={300}
          min={3} max={6} addLabel="Add a question" itemNoun="Q" />
      </div>

      <div>
        <span className={labelCls}>Join requirements</span>
        <div className="flex flex-wrap gap-4">
          {(['mic', 'cam', 'listen_only', 'recording'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(draft.join_requirements[k])}
                onChange={(e) => patch({ join_requirements: { ...draft.join_requirements, [k]: e.target.checked } })}
                className="h-4 w-4 rounded border-zine border-ink" />
              <span className="font-body font-bold text-[13px] text-ink">{k.replace('_', ' ')}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="block max-w-[220px]">
        <span className={labelCls}>Join lead time (minutes)</span>
        <input type="number" min={0} max={60} className={inputCls} value={draft.content_join_lead_minutes}
          onChange={(e) => patch({ content_join_lead_minutes: Number(e.target.value) })} />
      </label>

      {draft.kind === 'consult' && (
        <>
          <Field label="Credential (e.g. Chartered Accountant)" value={draft.credential} maxLength={40}
            onChange={(e) => patch({ credential: e.target.value })} />
          <div>
            <span className={labelCls}>Sample Q&amp;A (up to 3)</span>
            <TwoFieldListEditor items={draft.content_sample_qa as unknown as Record<string, string>[]}
              onChange={(next) => patch({ content_sample_qa: next as unknown as ListingDraft['content_sample_qa'] })}
              aKey="q" bKey="a" aLabel="Question" bLabel="Answer" aMax={120} bMax={300}
              min={0} max={3} addLabel="Add sample Q&A" itemNoun="Q" />
          </div>
          <label className="block">
            <span className={labelCls}>Preparation instructions</span>
            <textarea className={textareaCls} rows={3} maxLength={600} value={draft.commercial_preparation_instructions}
              onChange={(e) => patch({ commercial_preparation_instructions: e.target.value })}
              placeholder="What should the buyer prepare or bring?" />
            <div className="mt-1 flex">{charCount(draft.commercial_preparation_instructions, 600)}</div>
          </label>
        </>
      )}

      {draft.kind === 'ai_agent' && (
        <>
          <div>
            <span className={labelCls}>Can do (up to 3)</span>
            <StringListEditor items={draft.content_can_do} onChange={(next) => patch({ content_can_do: next })} itemMax={80} min={0} max={3} addLabel="Add" />
          </div>
          <div>
            <span className={labelCls}>Can&rsquo;t do (up to 3)</span>
            <StringListEditor items={draft.content_cant_do} onChange={(next) => patch({ content_cant_do: next })} itemMax={80} min={0} max={3} addLabel="Add" />
          </div>
          <div>
            <span className={labelCls}>Sample chat (up to 6 lines)</span>
            <ChatLineEditor items={draft.content_sample_chat} onChange={(next) => patch({ content_sample_chat: next })} max={6} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 7 — Photos & policy ───────────────────────────────────────────────
export function Step7Photos({ draft, patch, err, onUpload, onRemoveCover, uploading }: {
  draft: ListingDraft; patch: Patch; err: FieldErr;
  onUpload: (files: FileList | null) => void;
  onRemoveCover: (url: string) => void;
  uploading: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className={labelCls}>Photos (optional · up to 5)</span>
        <p className="mt-1 font-body text-[13px] text-inkSoft">No photo? That’s okay — an AI poster will be created after approval.</p>
        <div className="grid grid-cols-3 gap-3">
          {draft.cover_media.map((c) => (
            <div key={c.url} className="relative aspect-square overflow-hidden rounded-zine border-zine border-ink shadow-zine-xs">
              <img src={c.url} alt="" className="h-full w-full object-cover" />
              <button type="button" onClick={() => onRemoveCover(c.url)}
                className="absolute right-1 top-1 rounded-full border-zine border-ink bg-card px-2 py-0.5 font-body font-bold text-[12px] text-ink">✕</button>
            </div>
          ))}
          {draft.cover_media.length < 5 && (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex aspect-square items-center justify-center rounded-zine border-zine border-dashed border-ink bg-card font-body font-bold text-[13px] text-inkSoft">
              {uploading ? 'Uploading…' : '+ Add'}
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onUpload(e.target.files)} />
        <ErrLine err={err} field="cover_media" />
      </div>

      <Field label="Video URL (optional)" placeholder="https://youtube.com/..." value={draft.video_url}
        onChange={(e) => patch({ video_url: e.target.value })} />
      <Field label="Location (optional)" placeholder="e.g. Mumbai" value={draft.location}
        onChange={(e) => patch({ location: e.target.value })} />
      <label className="flex items-center gap-3">
        <input type="checkbox" checked={draft.adults_only} onChange={(e) => patch({ adults_only: e.target.checked })}
          className="h-5 w-5 rounded border-zine border-ink" />
        <span className="font-body font-bold text-[14px] text-ink">This is for adults only (18+)</span>
      </label>

      <SectionHeader title="Booking policy" />
      {draft.kind === 'live_event' && (
        <label className="block max-w-xs">
          <span className={labelCls}>Refund window</span>
          <select className={inputCls} value={draft.commercial_refund_window_hours}
            onChange={(e) => patch({ commercial_refund_window_hours: Number(e.target.value) })}>
            {REFUND_WINDOWS.map((h) => <option key={h} value={h}>{h === 0 ? 'No refunds' : `${h} hours before start`}</option>)}
          </select>
        </label>
      )}
      {draft.kind === 'consult' && (
        <div className="flex flex-col gap-4">
          <label className="block max-w-xs">
            <span className={labelCls}>Cancellation window</span>
            <select className={inputCls} value={draft.commercial_cancellation_window_hours}
              onChange={(e) => patch({ commercial_cancellation_window_hours: Number(e.target.value) })}>
              {REFUND_WINDOWS.map((h) => <option key={h} value={h}>{h === 0 ? 'No cancellations' : `${h} hours before start`}</option>)}
            </select>
          </label>
          <label className="block max-w-xs">
            <span className={labelCls}>Minimum booking notice</span>
            <select className={inputCls} value={draft.commercial_booking_notice_hours}
              onChange={(e) => patch({ commercial_booking_notice_hours: Number(e.target.value) })}>
              {BOOKING_NOTICE_HOURS.map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={draft.commercial_reschedule_allowed}
              onChange={(e) => patch({ commercial_reschedule_allowed: e.target.checked })}
              className="h-5 w-5 rounded border-zine border-ink" />
            <span className="font-body font-bold text-[14px] text-ink">Allow rescheduling</span>
          </label>
          <p className="font-body font-bold text-[12px] text-inkSoft">No-show policy: the session is charged (fixed).</p>
        </div>
      )}
    </div>
  );
}

// ── Step 8 — Preview & publish ─────────────────────────────────────────────
export function Step8Preview({ draft, patch, checks, ready, onPublish, publishing, published, publicHref, error,
  repeatOpen, setRepeatOpen, repeatWeeks, setRepeatWeeks, onRepeat, repeating, isLive, creator, copyReviewed, onReviewed,
}: {
  draft: ListingDraft; patch: Patch; checks: { ok: boolean; label: string }[]; ready: boolean;
  /** [CARD-AI-REVIEW-1] Reviewed in this session? Drives the panel below. */
  copyReviewed: boolean; onReviewed: () => void;
  onPublish: () => void; publishing: boolean; published: boolean; publicHref: string | null; error: string | null;
  repeatOpen: boolean; setRepeatOpen: (v: boolean) => void; repeatWeeks: number; setRepeatWeeks: (n: number) => void;
  onRepeat: () => void; repeating: boolean; isLive: boolean; creator?: CreatorInfo;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-4">
        <SectionHeader title="Ready to publish?" />
        <div className="flex flex-col gap-2">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2">
              <span className={c.ok ? 'text-lime' : 'text-coral'}>{c.ok ? '✓' : '○'}</span>
              <span className="font-body font-bold text-[14px] text-ink">{c.label}</span>
            </div>
          ))}
        </div>

        {/* [CARD-AI-REVIEW-1] The review is a publish check, so the way to
            satisfy it lives HERE, next to the blocked button — not only back on
            step 2. A checklist that fails without an adjacent way to fix it is
            how a form becomes a dead end. */}
        {!published && !copyReviewed && (
          <CopyReview draft={draft} patch={patch} onReviewed={onReviewed} />
        )}

        {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

        {published ? (
          <Card fillClassName="bg-paper2">
            <p className="font-body font-bold text-[13px] text-ink">This listing is published.</p>
            {publicHref && <a href={publicHref} className="mt-2 inline-block font-body font-bold text-[13px] text-blueInk underline">Open the public page</a>}
          </Card>
        ) : (
          <Button variant="lime" label="Publish" loading={publishing} disabled={!ready} onClick={onPublish} fullWidth />
        )}
        {publicHref && !published && (
          <a href={publicHref} target="_blank" rel="noreferrer" className="font-body font-bold text-[13px] text-blueInk underline">
            Open the public page preview
          </a>
        )}

        {isLive && !published && (
          <div>
            <button type="button" onClick={() => setRepeatOpen(!repeatOpen)} className="font-body font-bold text-[13px] text-blueInk underline">
              Runs every week? Make copies (optional)
            </button>
            {repeatOpen && (
              <Card fillClassName="bg-paper2" className="mt-2">
                <div className="flex items-center gap-2">
                  <select value={repeatWeeks} onChange={(e) => setRepeatWeeks(Number(e.target.value))}
                    className={inputCls}>
                    {[1, 2, 3, 4, 6, 8, 12].map((w) => <option key={w} value={w}>{w} more week{w === 1 ? '' : 's'}</option>)}
                  </select>
                  <Button variant="blue" label="Make copies" loading={repeating} onClick={onRepeat} />
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 text-center font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Live preview</p>
        <PreviewCard draft={draft} creator={creator} />
      </div>
    </div>
  );
}
