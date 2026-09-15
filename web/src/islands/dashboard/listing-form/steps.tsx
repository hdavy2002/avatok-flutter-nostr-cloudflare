/* [LIST-WIZ-1] The 8 step bodies. Each is a plain function component taking
 * `draft` + `patch` (a partial-state setter) plus whatever step-specific
 * plumbing it needs (categories list, upload handler, slot API calls). All
 * validation happens in wizardLogic.ts / ListingWizard.tsx — these components
 * only render inputs and call `patch`. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Field } from '../../../components/Field';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { useCopyReview, CopyFieldAssist } from './CopyReview';
import type { CopyField } from './CopyReview';
import { TwoFieldListEditor, StringListEditor, ChatLineEditor, labelCls, inputCls, textareaCls, SectionHeader, charCount } from './Editors';
import { REFUND_WINDOWS, BOOKING_NOTICE_HOURS, LISTING_PROMOTIONS_ENABLED } from './wizardLogic';
import type { ReadinessCheck } from './wizardLogic';
import { defaultsFor } from '../../../lib/listingDefaults';
/* [CAL-AUDIT-2026-09-15 · #2] An all-day window is stored as minute 0..1440.
 * `minutesToClock(1440)` is "24:00", which an <input type="time"> refuses, so
 * the row renders an explicit All-day control instead of a blank time field. */
import { isAllDayInterval, minutesToClock } from '../../../lib/calendarCore';
import { cfImage } from '../../../lib/config';
import { MEDIA_MODES, PRICING, groupsForKind, subCategoriesFor, feeSplit, SUB_CATEGORIES } from '../../../lib/listingTaxonomy';
import type { GroupId } from '../../../lib/listingTaxonomy';
import type { ListingDraft, Kind, PosterMirror, AvailabilityRule } from './types';

type Patch = (p: Partial<ListingDraft>) => void;
type CreatorInfo = { name?: string | null; handle?: string | null; avatar?: string | null };
/* [WIZ-LANGS-1 2026-09-13] The 11 original languages first, in their original
 * order, then the rest of India's major languages, then `Others` LAST.
 *
 * ⚠️ The server stores this as a CSV in `listings.spoken_lang` and TRUNCATES it
 * at 64 characters without saying so (worker/src/routes/listings.ts:1211:
 * `String(b.spoken_lang).slice(0, 64)`). With 11 options a creator could not
 * realistically hit that; with 28 they can pick five and silently lose the last
 * two — and the loss only shows up on the published listing. LANG_CSV_MAX below
 * is the client-side guard: the toggle refuses a selection whose joined CSV
 * would exceed the column, and says so. The worker is NOT changed here. */
const LANGS = [
  'Hindi', 'English', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Gujarati', 'Punjabi', 'Urdu', 'Kannada', 'Malayalam',
  'Odia', 'Assamese', 'Maithili', 'Bhojpuri', 'Konkani', 'Kashmiri', 'Nepali', 'Sanskrit', 'Sindhi', 'Dogri',
  'Manipuri', 'Santali', 'Tulu', 'Rajasthani', 'Chhattisgarhi', 'Haryanvi',
  'Others',
];
/** Same 64 the worker slices at — see the note on LANGS. */
const LANG_CSV_MAX = 64;
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

/**
 * [UI-MOTION-1 2026-09-10] "toggle" (transitions.dev, `.t-toggle*` in
 * styles/motion.css) — a real settings switch backing a native checkbox
 * (`sr-only`, not display:none, so it stays in the tab order and keeps
 * space/enter behaviour). `.is-init` is only added after the first user
 * press, matching the snippet's intent: the little overshoot bounce plays
 * when someone flips it, never on mount just because a draft loaded with
 * this field already true.
 */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const [interacted, setInteracted] = useState(false);
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <span
        className={['t-toggle', interacted && 'is-init'].filter(Boolean).join(' ')}
        data-on={checked ? 'true' : 'false'}
        aria-hidden="true"
        style={{
          position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 'none',
          width: 'calc(var(--toggle-travel) + 22px)', height: 22, borderRadius: 999,
          border: '2px solid var(--zine-ink, #161614)',
          background: checked ? 'var(--zine-lime, #c8e85a)' : 'var(--zine-paper2, #f0e4cc)',
        }}
      >
        <span
          className="t-toggle-thumb"
          style={{
            position: 'absolute', left: 2, top: '50%', marginTop: -8, width: 16, height: 16,
            borderRadius: '50%', border: '2px solid var(--zine-ink, #161614)', background: 'var(--zine-card, #fff)',
          }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { setInteracted(true); onChange(e.target.checked); }}
        className="sr-only"
      />
      <span className="font-body font-bold text-[14px] text-ink">{label}</span>
    </label>
  );
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

// [LIVE-SCHEDULE-FIX-1 2026-09-05] A LIVE EVENT can only be a fixed date today.
//
// All four modes were offered for every kind, and for a live_event the other
// three are a dead end the creator cannot see: the wizard's own checklist goes
// all-green (wizardLogic.ts only asks for a future start when schedule_mode ===
// 'fixed_date'), the listing saves, it reaches review, an admin approves it —
// and then Publish returns "starts_at (future) and duration_min (5–480)
// required", forever. The owner lost a listing to this on 2026-09-05.
//
// The gate is not the bug. Everything downstream of a live_event assumes a real
// window: commercial_checkout refuses a ticket without one, the GetStream join
// window computes 1970→1970 and 410s the host and every viewer, and the DO
// arms a no-show refund alarm that is already in the past. Letting the listing
// through would publish something unbuyable and unjoinable, which is worse than
// refusing it.
//
// So the honest fix is to stop offering what does not work. Restoring these
// three means making the join window, the checkout guard and the money engine
// branch on schedule_mode first — see the notes in worker/src/routes/listings.ts
// at SLOT_CLAIMED_STATUSES. Consult listings are unaffected; they schedule off
// availability_rules, not off starts_at.
const LIVE_EVENT_SCHEDULE_OPTS = SCHEDULE_OPTS.filter((o) => o.key === 'fixed_date');

export function Step1Type({ draft, patch, err, freeEntryLocked }: {
  draft: ListingDraft; patch: Patch; err: FieldErr;
  /**
   * [FREE-ENTRY-GATE-1] True while this account may not be allowed to create
   * free-entry listings (server default: `freeEntryAllowlistOnly=true`, and we
   * fail closed while /api/config hasn't answered yet — see ListingWizard.tsx).
   * The server is the real gate (403 `free_entry_not_allowed` on create/update);
   * this only avoids showing a control that would 403. An EXISTING free listing
   * (draft.free_entry already true, e.g. loaded from a listing this account made
   * before the gate existed, or before its allowlist status changed) still
   * renders a checked control that can only be turned off. This gives the owner
   * a recovery path to convert the listing to paid.
   */
  freeEntryLocked: boolean;
}) {
  const showFreeEntryCard = !freeEntryLocked || draft.free_entry;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className={labelCls}>Type</span>
        {/* [LIST-RESPONSIVE-1 2026-09-05] Three columns at 360px gives each
            card ~105px, which breaks "Broadcast to ticket holders" onto four
            lines and leaves the tap target a tall thin sliver. Stacked on a
            phone (matching the Schedule list right below it), three across from
            `sm` up. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <button key={k.key} type="button" disabled={k.disabled}
              onClick={() => patch({ kind: k.key })}
              className={['flex flex-col items-start gap-1 rounded-zine border-zine border-ink p-2.5 text-left shadow-zine-xs transition-transform duration-zine',
                k.disabled ? 'opacity-40' : '', draft.kind === k.key ? 'bg-lime' : 'bg-card'].join(' ')}>
              <span className="text-[18px]">{k.chip}</span>
              <span className="font-display font-semibold text-[16px] text-ink">{k.label}</span>
              <span className="font-body font-bold text-[14px] leading-snug text-inkSoft">{k.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {showFreeEntryCard && (
        freeEntryLocked ? (
          <label className="flex items-center gap-3 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs">
            <input type="checkbox" checked={draft.free_entry}
              onChange={(e) => { if (!e.target.checked) patch({ free_entry: false }); }}
              className="h-5 w-5 rounded border-zine border-ink" />
            <span className="font-body font-bold text-[14px] text-ink">This is a free show</span>
            <span className="font-body font-bold text-[11px] text-inkSoft">Turn this off to continue as a paid listing.</span>
          </label>
        ) : (
          <label className="flex items-center gap-3 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs">
            <input type="checkbox" checked={draft.free_entry} onChange={(e) => patch({ free_entry: e.target.checked })}
              className="h-5 w-5 rounded border-zine border-ink" />
            <span className="font-body font-bold text-[14px] text-ink">This is a free show</span>
          </label>
        )
      )}
      <div>
        <span className={labelCls}>Schedule</span>
        <div className="flex flex-col gap-2">
          {(draft.kind === 'live_event' ? LIVE_EVENT_SCHEDULE_OPTS : SCHEDULE_OPTS).map((o) => (
            <button key={o.key} type="button" onClick={() => patch({ schedule_mode: o.key })}
              className={['flex items-center justify-between rounded-zine border-zine border-ink p-3 text-left shadow-zine-xs',
                draft.schedule_mode === o.key ? 'bg-lime' : 'bg-card'].join(' ')}>
              <span>
                <span className="block font-display font-semibold text-[16px] text-ink">{o.label}</span>
                <span className="block font-body font-bold text-[14px] leading-snug text-inkSoft">{o.sub}</span>
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

/** One group's blips, preferring the server's `/api/explore/categories` (which
 *  now carries `group_id` — [MKT-3GROUP-1]) and falling back to the static
 *  SUB_CATEGORIES mirror only when that fetch failed or hasn't landed yet.
 *  The server is the authority the publish route validates against, so a blip
 *  that only exists in the mirror would be rejected at publish — prefer the
 *  fetched list whenever it has anything for this group. `adda_rooms` (and
 *  any other `requiresFlag`-gated id) is hidden regardless of source. */
function blipsForGroup(
  group: GroupId,
  categories: { id: string; label: string; emoji?: string | null; group_id?: string | null }[],
  conferenceEnabled: boolean,
): { id: string; label: string; emoji?: string | null }[] {
  const gated = new Set(subCategoriesFor(group).filter((sc) => sc.requiresFlag && !conferenceEnabled).map((sc) => sc.id));
  const fromServer = categories.filter((c) => c.group_id === group && !gated.has(c.id));
  if (fromServer.length) return fromServer;
  return subCategoriesFor(group).filter((sc) => !gated.has(sc.id));
}

function BlipGroup({ heading, blips, selected, onPick }: {
  heading: string; blips: { id: string; label: string; emoji?: string | null }[];
  selected: string; onPick: (id: string) => void;
}) {
  return (
    <div>
      <span className={labelCls}>{heading}</span>
      <div className="flex flex-wrap gap-2">
        {blips.map((b) => {
          const on = selected === b.id;
          return (
            <button key={b.id} type="button" onClick={() => onPick(b.id)}
              className={['rounded-zineField border-zine border-ink px-3 py-1.5 font-body font-bold text-[13px] shadow-zine-xs',
                on ? 'bg-lime text-ink' : 'bg-card text-inkSoft'].join(' ')}>
              {b.emoji ? `${b.emoji} ` : ''}{b.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Step2Pitch({ draft, patch, err, categories, creator, conferenceEnabled, aiAssisted, onAssisted, onSkipAi }: {
  draft: ListingDraft; patch: Patch; err: FieldErr;
  categories: { id: string; label: string; emoji?: string | null; group_id?: string | null }[];
  creator?: CreatorInfo;
  /** [MKT-3GROUP-1] Hides the `adda_rooms` blip while the flag is off. */
  conferenceEnabled: boolean;
  /** [WIZ-AI-ASSIST-1] Which fields have been through the AI check — the gate
   *  on Next reads the same rule (wizardLogic.copyGateSatisfied). Since
   *  [WIZ-AI-REVIEWED-TEXT-1] these are DERIVED per render from "does this
   *  field still hold the text that was reviewed", so they go false again the
   *  moment the creator edits one of the three boxes. */
  aiAssisted: { title: boolean; blurb: boolean; description: boolean };
  /** Carries the text that was settled, not just which field settled. */
  onAssisted: (field: CopyField, text: string) => void;
  /** The escape hatch after a failed call — releases the whole gate for the rest
   *  of the sitting, including anything typed afterwards. */
  onSkipAi: () => void;
}) {
  // [MKT-3GROUP-1] Sub-categories are DRIVEN BY THE STEP-1 KIND. `live_event`
  // gets one group's blips (india_goes_live); `consult` gets TWO groups' blips
  // shown under two headings — whichever blip the creator picks is what files
  // the listing into "Find your people" or "Book their time". The group is
  // never asked separately; it is derived from the category (spec §6 step 2).
  const groups = groupsForKind(draft.kind);
  // [WIZ-AI-PERFIELD-1 2026-09-13] ONE CALL PER FIELD. Each of the three chips
  // asks the worker about its OWN field only (`field: 'blurb'` etc.), and owns
  // its own busy flag, result and error. Pressing the title chip cannot put a
  // card above the blurb — which is exactly the bug this replaced.
  const copy = useCopyReview(draft);
  const allAssisted = aiAssisted.title && aiAssisted.blurb && aiAssisted.description;
  // [WIZ-LANGS-1] Set when a language was refused because the CSV would blow
  // past the column the server silently truncates at.
  const [langCapped, setLangCapped] = useState(false);
  function toggleLang(l: string) {
    const on = draft.spoken_lang.includes(l);
    if (on) { setLangCapped(false); patch({ spoken_lang: draft.spoken_lang.filter((x) => x !== l) }); return; }
    const next = [...draft.spoken_lang, l];
    if (next.join(',').length > LANG_CSV_MAX) { setLangCapped(true); return; }
    setLangCapped(false);
    patch({ spoken_lang: next });
  }
  // [POSTER-FIRST-1 2026-09-05] The live preview card that used to sit in a
  // sticky right-hand column is GONE, and step 2 is a single full-width column.
  //
  // It was showing a card that no longer exists: the listing's face is now the
  // AI poster, generated at the end of the wizard, so a mocked-up tile of chips
  // and buttons was previewing a layout the creator will never see. Worse, it
  // updated live as they typed, which framed "how do my chips look" as the job
  // of this step — the job is the words. Step 8 shows the real poster.
  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-6">
      <div className="flex flex-col gap-5">
        <div>
          <CopyFieldAssist field="title" label="Title" state={copy} patch={patch} value={draft.title}
            assisted={aiAssisted.title} onSettled={(_how, text) => onAssisted('title', text)} />
          <Field label="Title" placeholder="e.g. Friday night live cook-along" value={draft.title}
            onChange={(e) => patch({ title: e.target.value.slice(0, 140) })} />
          <ErrLine err={err} field="title" />
        </div>
        <div>
          <CopyFieldAssist field="blurb" label="Blurb" state={copy} patch={patch} value={draft.blurb}
            assisted={aiAssisted.blurb} onSettled={(_how, text) => onAssisted('blurb', text)} />
          <Field label="Blurb (one line)" placeholder="What fans get, in one punchy line" value={draft.blurb}
            onChange={(e) => patch({ blurb: e.target.value.slice(0, 120) })} />
          <div className="mt-1 flex">{charCount(draft.blurb, 120)}</div>
          <ErrLine err={err} field="blurb" />
        </div>
        <div>
          <CopyFieldAssist field="description" label="Description" state={copy} patch={patch} value={draft.description}
            assisted={aiAssisted.description} onSettled={(_how, text) => onAssisted('description', text)} />
          <label className="block">
            <span className={labelCls}>Description</span>
            <textarea className={textareaCls} rows={4} value={draft.description} maxLength={8000}
              placeholder="Tell people what to expect" onChange={(e) => patch({ description: e.target.value })} />
          </label>
        </div>

        {/* [WIZ-AI-ASSIST-1] The escape hatch. The check is a gate on Next, so a
            500 or a dead network must not be able to trap a creator on this
            step — one failed attempt is enough to earn the way out. */}
        {copy.anyFailed && !allAssisted && (
          <Card fillClassName="bg-paper2">
            <p className="font-body font-bold text-[13px] text-coral">⚠ The AI check could not run.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void copy.retryFailed()} disabled={copy.anyBusy}
                className="rounded-zineField border-zine border-ink bg-blue px-3 py-1.5 font-body font-bold text-[12px] text-ink shadow-zine-xs">
                {copy.anyBusy ? 'Trying again…' : 'Try again'}
              </button>
              <button type="button" onClick={onSkipAi}
                className="rounded-zineField border-zine border-ink bg-card px-3 py-1.5 font-body font-bold text-[12px] text-inkSoft shadow-zine-xs">
                Continue without AI
              </button>
            </div>
          </Card>
        )}
        <ErrLine err={err} field="ai_assist" />

        {groups.map((g) => (
          <BlipGroup key={g.id} heading={groups.length > 1 ? g.heading : 'Category'}
            blips={blipsForGroup(g.id, categories, conferenceEnabled)}
            selected={draft.category} onPick={(id) => patch({ category: id })} />
        ))}
        <ErrLine err={err} field="category" />

        <div>
          <span className={labelCls}>Audio and video</span>
          <div className="flex flex-col gap-2">
            {MEDIA_MODES.map((m) => (
              <button key={m.id} type="button" onClick={() => patch({ media_mode: m.id })}
                className={['flex items-center justify-between rounded-zine border-zine border-ink p-3 text-left shadow-zine-xs',
                  draft.media_mode === m.id ? 'bg-lime' : 'bg-card'].join(' ')}>
                <span>
                  <span className="block font-display font-semibold text-[14px] text-ink">{m.label}</span>
                  <span className="block font-body font-bold text-[12px] text-inkSoft">{m.help}</span>
                </span>
                {draft.media_mode === m.id && <span className="text-[18px]">✓</span>}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className={labelCls}>Language</span>
          <div className="flex flex-wrap gap-2">
            {LANGS.map((l) => {
              const on = draft.spoken_lang.includes(l);
              return (
                <button key={l} type="button" onClick={() => toggleLang(l)}
                  className={['rounded-zineField border-zine border-ink px-3 py-2 font-body font-bold text-[13px] shadow-zine-xs', on ? 'bg-lime text-ink' : 'bg-card text-inkSoft'].join(' ')}>
                  {l}
                </button>
              );
            })}
          </div>
          {langCapped && (
            <p className="mt-2 font-body font-bold text-[13px] text-coral">
              ⚠ That is as many languages as fit ({LANG_CSV_MAX} characters in total).
              Remove one before adding another, or pick “Others”.
            </p>
          )}
        </div>
        <p className="font-body text-[13px] text-inkSoft">
          Your title and blurb are what get painted onto your poster. Everything
          else you enter — price, timing, rules — appears next to it, not on it.
          Ava reviews all three fields here, before you go on.
        </p>
      </div>
    </div>
  );
}

// ── Step 3 — Money ─────────────────────────────────────────────────────────
/* [PRICE-HOURLY-1] "Charged per" is gone — every session is priced PER HOUR,
 * and a session shorter than an hour still bills the hour. The wizard shows
 * the fee split live against whatever the creator has typed, plus a worked
 * example table, so the ₹49 floor and the ₹25-flat-plus-20% rule are legible
 * before they type anything. The server recomputes and is the authority — see
 * listingTaxonomy.ts feeSplit(). */
const FEE_EXAMPLES = [100, 500] as const;

/** [WIZ-DISCOUNT-1] What a customer pays after a 1–100% discount, rounded to a
 *  whole token (the wire unit is an integer ₹ — see the TOKENS-INR note in
 *  CLAUDE.md). Returns null when the percentage is absent or out of range, so
 *  the caller can leave the row out rather than print a nonsense price. */
function discountedPrice(price: number, pctRaw: string): number | null {
  if (!pctRaw) return null;
  const pct = Number(pctRaw);
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) return null;
  return Math.max(0, Math.round(price * (1 - pct / 100)));
}

export function Step3Money({ draft, patch, err }: { draft: ListingDraft; patch: Patch; err: FieldErr }) {
  const price = Number(draft.price) || 0;
  const split = feeSplit(price);
  /* [PROMO-SHELVE-1] With promotions shelved there is no discount to preview,
   * so both derived prices stay null and the "What a customer pays" table below
   * never renders. The creator-facing FEE SPLIT and the worked-examples table
   * are NOT promotions and stay visible unconditionally. */
  const earlyPrice = LISTING_PROMOTIONS_ENABLED ? discountedPrice(price, draft.early_bird_pct) : null;
  const promoPrice = LISTING_PROMOTIONS_ENABLED && draft.promo_code.trim() ? discountedPrice(price, draft.promo_pct) : null;
  const customerRows: { label: string; pay: number }[] = [
    { label: 'Full price', pay: price },
    ...(earlyPrice !== null ? [{ label: `Early bird −${Number(draft.early_bird_pct)}%`, pay: earlyPrice }] : []),
    ...(promoPrice !== null ? [{ label: `Code ${draft.promo_code.trim()} −${Number(draft.promo_pct)}%`, pay: promoPrice }] : []),
  ];
  return (
    <div className="flex flex-col gap-5">
      {draft.free_entry ? (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            This is a free show — attendees pay nothing.
          </p>
        </Card>
      ) : (
        <>
          <div>
            <Field label="Price per hour (Tokens = ₹)" inputMode="numeric" placeholder={`min ${PRICING.minPriceTokensPerHour}`} value={draft.price}
              onChange={(e) => patch({ price: e.target.value.replace(/[^0-9]/g, '') })} />
            <p className="mt-1 font-body font-bold text-[12px] text-inkSoft">
              Everything is priced per hour. A session shorter than an hour still bills the full hour.
            </p>
            <ErrLine err={err} field="price" />
          </div>

          {price > 0 && (
            <Card fillClassName="bg-paper2">
              <p className="font-body font-bold text-[13px] text-ink">
                At ₹{price}/hr, avaTOK takes ₹{split.fee} and you keep ₹{split.creator}.
              </p>
              <p className="mt-1 font-body text-[12px] text-inkSoft">
                ₹{PRICING.flatTokensPerHour} flat + {PRICING.commissionPct}% of what’s left. A 2-hour booking bills the flat fee twice.
              </p>
            </Card>
          )}

          <div>
            <span className={labelCls}>Worked examples</span>
            <div className="overflow-x-auto rounded-zine border-zine border-ink shadow-zine-xs">
              <table className="w-full font-body text-[13px]">
                <thead>
                  <tr className="border-b-2 border-ink bg-paper2 text-left">
                    <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">Creator sets</th>
                    <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">avaTOK takes</th>
                    <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">Creator keeps</th>
                  </tr>
                </thead>
                <tbody>
                  {[PRICING.minPriceTokensPerHour, ...FEE_EXAMPLES].map((p) => {
                    const s = feeSplit(p);
                    return (
                      <tr key={p} className="border-b border-ink/15 last:border-b-0">
                        <td className="p-2 font-bold text-ink">₹{p}/hr</td>
                        <td className="p-2 text-inkSoft">₹{s.fee}</td>
                        <td className="p-2 text-inkSoft">₹{s.creator}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* [PROMO-SHELVE-1 2026-09-13] Early-bird %, promo code and the code's
              own % are HIDDEN while promotions are shelved. The server refuses
              to create a promotion with `listingPromotionsEnabled` off, so a
              creator filling these in would only earn an error they could not
              act on. Flip LISTING_PROMOTIONS_ENABLED in ./wizardLogic.ts to bring
              them back — the fields themselves are unchanged. */}
          {LISTING_PROMOTIONS_ENABLED && (
            <>
              <div>
                <Field label="Early-bird discount % (optional)" inputMode="numeric" placeholder="e.g. 20" value={draft.early_bird_pct}
                  onChange={(e) => patch({ early_bird_pct: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} />
                <ErrLine err={err} field="early_bird_pct" />
              </div>
              <div>
                <Field label="Promo code (optional)" placeholder="e.g. FRIENDS20" value={draft.promo_code}
                  onChange={(e) => patch({ promo_code: e.target.value.toUpperCase().slice(0, 24) })} />
                <ErrLine err={err} field="promo_code" />
              </div>
              {/* [WIZ-DISCOUNT-1] The code's OWN percentage. Until now the wizard
                  posted `pct_off: 10` for a code typed without an early-bird
                  number — a discount the creator never chose, invented client-side
                  in saveEarlyBirdAndPromo(). */}
              <div>
                <Field label="Promo code discount % (needed if you set a code)" inputMode="numeric" placeholder="e.g. 15" value={draft.promo_pct}
                  onChange={(e) => patch({ promo_pct: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} />
                <ErrLine err={err} field="promo_pct" />
              </div>
            </>
          )}

          {/* [WIZ-DISCOUNT-1] What the CUSTOMER pays, live. The step showed only
              the creator's take-home at full price, so a creator typing "50" in
              early-bird had no way to see that they were about to sell an hour
              for ₹250 and keep ₹205. avaTOK's fee is charged on the DISCOUNTED
              amount (feeSplit is a pure function of what is actually paid), so
              each row is feeSplit(that row's price) — never the list-price
              split with a discount subtracted afterwards. */}
          {price > 0 && (earlyPrice !== null || promoPrice !== null) && (
            <div>
              <span className={labelCls}>What a customer pays</span>
              <div className="overflow-x-auto rounded-zine border-zine border-ink shadow-zine-xs">
                <table className="w-full font-body text-[13px]">
                  <thead>
                    <tr className="border-b-2 border-ink bg-paper2 text-left">
                      <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">Buying with</th>
                      <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">Customer pays</th>
                      <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">avaTOK takes</th>
                      <th className="p-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkSoft">You keep</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerRows.map((row) => {
                      const sp = feeSplit(row.pay);
                      return (
                        <tr key={row.label} className="border-b border-ink/15 last:border-b-0">
                          <td className="p-2 font-bold text-ink">{row.label}</td>
                          <td className="p-2 font-bold text-ink">₹{row.pay}/hr</td>
                          <td className="p-2 text-inkSoft">₹{sp.fee}</td>
                          <td className="p-2 text-inkSoft">₹{sp.creator}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 font-body text-[12px] text-inkSoft">
                avaTOK’s ₹{PRICING.flatTokensPerHour} flat + {PRICING.commissionPct}% is taken from what the
                customer actually pays, so a discount comes out of both sides — not only yours.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Step 4 — Time ──────────────────────────────────────────────────────────
/* [WIZ-SIMPLIFY-1 2026-09-13, owner decision] Two controls are GONE from this
 * step and are not coming back without a fresh decision:
 *
 *  - "Specific time slots (optional)" — the named multi-slot editor and the
 *    POST /api/listings/:id/slots + DELETE /api/slots/:id calls behind it. The
 *    worker routes still exist and are untouched; nothing in the wizard calls
 *    them any more.
 *  - "Max bookings per person" — the server defaults `max_per_booking` to 4
 *    when the key is absent, so not sending it is the same value the form used
 *    to send by default (worker/src/routes/listings.ts:1276, :1490).
 */
export function Step4Time({ draft, patch, err }: {
  draft: ListingDraft; patch: Patch; err: FieldErr;
}) {
  // [LIVE-SCHEDULE-FIX-1 2026-09-05] Rescue an EXISTING live_event that was
  // saved on one of the three modes we no longer offer (see
  // LIVE_EVENT_SCHEDULE_OPTS). Hiding the buttons is not enough on its own: the
  // draft still carries e.g. 'always_on', and every time field below is gated on
  // the mode — so the creator would open the wizard to fix the missing date and
  // find nowhere to type it. Coercing to fixed_date is what makes those listings
  // repairable instead of write-offs.
  useEffect(() => {
    if (draft.kind === 'live_event' && draft.schedule_mode !== 'fixed_date') {
      patch({ schedule_mode: 'fixed_date' });
    }
  }, [draft.kind, draft.schedule_mode, patch]);
  // [LIST-WIZ-TZ-1] Show the free-text box only when the current timezone isn't
  // one of the friendly options — i.e. it was picked "Other…", loaded from an
  // existing listing with an uncommon tz, or (pre-normalization) a legacy id.
  const [tzOther, setTzOther] = useState(!TZ_OPTIONS.some((o) => o.value === draft.timezone));
  const availabilityModes: { key: ListingDraft['availability_mode']; label: string; help: string }[] = [
    { key: 'shared', label: 'Shared creator hours', help: 'Use the working hours from your AvaCalendar.' },
    { key: 'custom', label: 'Custom hours for this listing', help: 'Narrow this consult to its own weekly windows.' },
    { key: 'exclusive', label: 'Exclusive windows', help: 'Reserve these windows so other listings cannot use them.' },
  ];
  const rules = draft.availability_rules;
  const patchRule = (index: number, next: Partial<AvailabilityRule>) => {
    patch({ availability_rules: rules.map((r, i) => i === index ? { ...r, ...next } : r) });
  };
  return (
    <div className="flex flex-col gap-5">
      {draft.kind === 'live_event' && (
        <Card fillClassName="bg-paper2">
          <p className="font-body font-bold text-[13px] text-ink">For a live event, you do not need to reserve the event time here first.</p>
          <p className="mt-1 font-body text-[12px] text-inkSoft">Set working hours only when you offer consultations. We check your connected Google Calendar for existing busy events; after this listing is published, the event itself becomes a protected commitment.</p>
        </Card>
      )}
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

      {draft.kind === 'consult' && (
        <div>
          <span className={labelCls}>Consult availability</span>
          <div className="flex flex-col gap-2">
            {availabilityModes.map((mode) => (
              <button key={mode.key} type="button" onClick={() => patch({ availability_mode: mode.key })}
                className={['flex items-center justify-between rounded-zine border-zine border-ink p-3 text-left shadow-zine-xs', draft.availability_mode === mode.key ? 'bg-lime' : 'bg-card'].join(' ')}>
                <span><span className="block font-display font-semibold text-[15px] text-ink">{mode.label}</span><span className="block font-body font-bold text-[12px] text-inkSoft">{mode.help}</span></span>
                {draft.availability_mode === mode.key && <span>✓</span>}
              </button>
            ))}
          </div>
          {/* [CAL-AUDIT-2026-09-15 · #10] Say what is inherited and what is
           *  overridden. A creator could not tell whether the notice, the gap
           *  between sessions, the daily limit or the horizon changed here, or
           *  whether they still came from the calendar. */}
          <p className="mt-2 font-body text-[12px] font-bold text-inkSoft">
            {draft.availability_mode === 'shared'
              ? 'This listing inherits your calendar’s working hours, notice, gap before and after each session, daily limit and booking horizon. Change them any time in Calendar & availability.'
              : draft.availability_mode === 'custom'
                ? 'These weekly windows replace your usual hours for this listing only. Notice, gap before and after each session, daily limit and booking horizon still come from your calendar policy.'
                : 'These windows are kept for this listing so no other listing can use that time. Notice, gap before and after each session, daily limit and booking horizon still come from your calendar policy.'}
          </p>
          {draft.availability_mode === 'custom' && (
            <div className="mt-3 flex flex-col gap-2 rounded-zine border-zine border-dashed border-ink p-3">
              <p className="font-body font-bold text-[12px] text-inkSoft">Add at least one weekly window. Times use {draft.timezone}.</p>
              {rules.map((rule, index) => {
                /* [CAL-AUDIT-2026-09-15 · #2] An all-day window (0..1440) from
                 * the app must be visible and editable here, not shown as an
                 * empty time field: "24:00" is not a value <input type="time">
                 * can hold, so the two time fields are replaced by the All-day
                 * control while the stored 1440 end is preserved untouched. */
                const wholeDay = isAllDayInterval(rule.start_min, rule.end_min);
                return (
                  <div key={`${index}-${rule.weekday}`} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                    <label className="block"><span className={labelCls}>Day</span><select className={inputCls} value={rule.weekday} onChange={(e) => patchRule(index, { weekday: Number(e.target.value) })}>{RECUR_DAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}</select></label>
                    {wholeDay ? (
                      <p className="col-span-2 pb-2 font-body font-bold text-[12px] text-inkSoft">Whole day (00:00–24:00)</p>
                    ) : (
                      <>
                        <label className="block"><span className={labelCls}>Starts</span><input className={inputCls} type="time" value={minutesToClock(rule.start_min)} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); patchRule(index, { start_min: h * 60 + m }); }} /></label>
                        <label className="block"><span className={labelCls}>Ends</span><input className={inputCls} type="time" value={minutesToClock(rule.end_min)} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); patchRule(index, { end_min: h * 60 + m }); }} /></label>
                      </>
                    )}
                    <div className="flex items-end justify-between gap-2 pb-2">
                      <label className="flex items-center gap-1 font-body font-bold text-[12px] text-ink">
                        <input type="checkbox" checked={wholeDay} onChange={(e) => patchRule(index, e.target.checked ? { start_min: 0, end_min: 1440 } : { start_min: 9 * 60, end_min: 17 * 60 })} />
                        All day
                      </label>
                      <button type="button" className="font-body font-bold text-[12px] text-coral" onClick={() => patch({ availability_rules: rules.filter((_, i) => i !== index) })}>Remove</button>
                    </div>
                  </div>
                );
              })}
              <button type="button" className="self-start font-body font-bold text-[13px] text-blueInk underline" onClick={() => patch({ availability_rules: [...rules, { weekday: 1, start_min: 9 * 60, end_min: 17 * 60 }] })}>+ Add weekly window</button>
              <ErrLine err={err} field="availability_rules" />
            </div>
          )}
        </div>
      )}

      {draft.schedule_mode === 'fixed_date' && (
        <>
          {(draft.kind !== 'consult' || draft.availability_mode === 'exclusive') && <div>
            <Field label="Starts" type="datetime-local" value={draft.starts_at} onChange={(e) => patch({ starts_at: e.target.value })} />
            <ErrLine err={err} field="starts_at" />
            <p className="mt-1 font-body text-[12px] font-bold text-inkSoft">
              This exact time is checked against your calendar as you type. It is reserved only once the listing is published (and a booking is confirmed) — a saved draft holds nothing.
            </p>
          </div>}
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

      {(draft.kind === 'consult' || draft.kind === 'ai_agent') && (
        <div>
          <Field label="Typical reply time (minutes, optional)" inputMode="numeric" value={draft.response_time_min}
            onChange={(e) => patch({ response_time_min: e.target.value.replace(/[^0-9]/g, '') })} />
          <ErrLine err={err} field="response_time_min" />
        </div>
      )}
      {draft.kind === 'consult' && <p className="font-body font-bold text-[12px] text-inkSoft">Consults always have one seat. Duration is the session length used by the calendar and checkout.</p>}
      {draft.kind !== 'consult' && (
        <label className="block">
          <span className={labelCls}>Seats (capacity)</span>
          <input type="number" min={0} max={5000} className={inputCls} value={draft.capacity || ''} placeholder="e.g. 60 — blank = unlimited"
            onChange={(e) => patch({ capacity: Number(e.target.value) || 0 })} />
          <p className="mt-1 font-body font-bold text-[12px] text-inkSoft">Total seats for this show. The page shows “32 of 60 free”; leave blank for no cap.</p>
          <ErrLine err={err} field="capacity" />
        </label>
      )}
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
        {/* [LISTING-POSTER-OPTIONAL-1] The gallery is optional. The poster is
            generated after submit from the listing copy, even when this is left
            empty. */}
        <p className="mt-1 font-body text-[13px] text-inkSoft">
          Add up to five listing photos if you have them. They appear below the
          poster, which is generated after submit from your title, category,
          tags and description.
        </p>
        {/* [LIST-RESPONSIVE-1] Two up on a phone: three square thumbs at 360px
            are ~100px each, too small to judge a photo by or to hit the ✕ on. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
      <Toggle checked={draft.adults_only} onChange={(v) => patch({ adults_only: v })} label="This is for adults only (18+)" />

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

// ── Step 8 — Summary & submit for review ────────────────────────────────────
/* [WIZ-SUBMIT-PLAIN-1 2026-09-13, owner decision] Step 8 is a PLAIN read-only
 * summary of everything the creator entered, plus Submit. Four things were
 * removed and must not come back without a fresh decision:
 *
 *  - the "Check this listing" / "Run the check" card (POST /api/listings/:id/review).
 *    It also GATED the Submit button, so removing it means Submit is enabled
 *    and the SERVER's answer on submit is the only verdict — which it always
 *    really was (POST /api/listings/:id/submit returns the listing blockers,
 *    surfaced inline below).
 *  - the CopyReview panel. The AI copy assist now lives on step 2, next to the
 *    words it is about — see CopyReview.tsx and Step2Pitch.
 *  - the "Open the public page preview" link (for a draft there is no public
 *    page worth opening; the published state still links to it).
 *  - "Runs every week? Make copies" (POST /api/listings/:id/repeat).
 *
 * The checklist that remains is `publishReadiness`, which is now informational
 * only and renders with dots, not ticks.
 */
function humanizeId(id: string): string {
  return id ? id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

/* [WIZ-CAT-LABEL-1 2026-09-14] Step 8 was showing the category ID.
 *
 * `humanizeId('live_puja_ritual')` renders "Live Puja Ritual" — a slug with the
 * underscores combed out, not a name anyone chose. The blip the creator pressed
 * on step 2 said "🕉️ Puja", and the summary of what they are submitting has to
 * say the same thing.
 *
 * Same source order as the chips (blipsForGroup): the fetched
 * /api/explore/categories list first, because D1 is what the publish route
 * validates against and a category added there must not go nameless until the
 * next web deploy; then the generated SUB_CATEGORIES mirror; and only if the id
 * is in neither — a category retired since this draft was written — the
 * humanised id, so the row still says something rather than going blank. */
function categoryLabel(
  id: string,
  categories: { id: string; label: string; emoji?: string | null }[],
): string {
  if (!id) return '';
  const hit = categories.find((c) => c.id === id) ?? SUB_CATEGORIES.find((c) => c.id === id);
  if (!hit) return humanizeId(id);
  return hit.emoji ? `${hit.emoji} ${hit.label}` : hit.label;
}

const KIND_LABEL: Record<Kind, string> = {
  live_event: 'Live event',
  consult: '1:1 consult',
  ai_agent: 'AI agent',
};

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-b border-dashed border-ink/25 py-2 last:border-b-0 sm:grid-cols-[180px_1fr] sm:gap-3">
      <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">{label}</span>
      <div className="font-body text-[14px] text-ink">{children}</div>
    </div>
  );
}

/** Renders nothing at all when the creator left this one blank — a summary of
 *  what was submitted should not be padded with rows saying "—". */
function SummaryText({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || !String(value).trim()) return null;
  return <SummaryRow label={label}><span className="whitespace-pre-wrap">{value}</span></SummaryRow>;
}

function SummaryList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <SummaryRow label={label}>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        {items.map((t, i) => <li key={`${i}-${t}`}>{t}</li>)}
      </ul>
    </SummaryRow>
  );
}

/** A YouTube id, when the link is one; otherwise null and we render a link. */
function youtubeId(url: string): string | null {
  const m = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(url);
  return m ? m[1] : null;
}

export function Step8Preview({ draft, checks, onSubmitForReview, publishing,
  published, pendingReview, approvedAwaitingPublish, rejected, publicHref, error, creator, categories = [],
}: {
  draft: ListingDraft; checks: ReadinessCheck[];
  /** [WIZ-CAT-LABEL-1] The same fetched list step 2's chips render from, so the
   *  summary names the category the creator picked instead of its id. */
  categories?: { id: string; label: string; emoji?: string | null; group_id?: string | null }[];
  /** [LIST-SUBMIT-REVIEW-1] Sends the draft into the admin approval queue —
   *  POST /api/listings/:id/submit, not the old direct-publish call. */
  onSubmitForReview: () => void; publishing: boolean;
  /** Status is now four mutually-exclusive states, not one boolean — a
   *  `pending_review` or `rejected` listing is very much not "published". */
  published: boolean; pendingReview: boolean; approvedAwaitingPublish: boolean; rejected: boolean;
  publicHref: string | null; error: string | null;
  creator?: CreatorInfo;
}) {
  // A rejected listing is an editable draft that must expose the same submit
  // action after the creator fixes the requested changes.
  const isDraftState = !published && !pendingReview && !approvedAwaitingPublish;
  const price = Number(draft.price) || 0;
  const startsAt = draft.starts_at ? draft.starts_at.replace('T', ' at ') : '';
  const schedule = draft.schedule_mode === 'fixed_date'
    ? (startsAt ? `${startsAt} (${draft.timezone}) · ${draft.duration_min} min` : `Not set (${draft.timezone})`)
    : draft.schedule_mode === 'recurring'
      ? `Every ${draft.recurrence_days.map((d) => RECUR_DAYS[d]).join(', ') || '—'} at ${draft.recurrence_time} (${draft.timezone}) · ${draft.duration_min} min`
      : draft.schedule_mode === 'on_request'
        ? `On request (${draft.timezone})`
        : `Always on (${draft.timezone})`;
  const jr = draft.join_requirements;
  const joinBits = [
    jr.mic ? 'Mic required' : null,
    jr.cam ? 'Camera required' : null,
    jr.listen_only ? 'Listen-only allowed' : null,
    jr.recording ? 'Session is recorded' : null,
    jr.replay_days ? `Replay for ${jr.replay_days} day${jr.replay_days === 1 ? '' : 's'}` : null,
  ].filter(Boolean) as string[];
  const vid = draft.video_url.trim();
  const ytId = vid ? youtubeId(vid) : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-4">
        <SectionHeader
          title={isDraftState ? 'Ready to send for review?' : 'Status'}
          hint={isDraftState ? 'Everything you entered, in one place. Go back to any step to change it.' : undefined}
        />

        {/* ── the plain summary ─────────────────────────────────────────── */}
        <Card fillClassName="bg-card">
          <div className="flex flex-col">
            <SummaryRow label="Type">
              {KIND_LABEL[draft.kind]}{draft.free_entry ? ' · Free show' : ''}
            </SummaryRow>
            <SummaryText label="Title" value={draft.title} />
            <SummaryText label="Blurb" value={draft.blurb} />
            <SummaryText label="Description" value={draft.description} />
            <SummaryText label="Category" value={categoryLabel(draft.category, categories)} />
            <SummaryText label="Languages" value={draft.spoken_lang.join(', ')} />
            <SummaryRow label="Price">
              {draft.free_entry ? 'Free' : price > 0 ? `₹${price} per hour` : 'Not set'}
            </SummaryRow>
            {/* [PROMO-SHELVE-1] No "Early bird" / "Promo code" rows while
                promotions are shelved — a summary must not report something the
                creator was never offered and the server will not store. */}
            {LISTING_PROMOTIONS_ENABLED && !draft.free_entry && draft.early_bird_pct && (
              <SummaryRow label="Early bird">{draft.early_bird_pct}% off</SummaryRow>
            )}
            {LISTING_PROMOTIONS_ENABLED && !draft.free_entry && draft.promo_code.trim() && (
              <SummaryRow label="Promo code">
                {draft.promo_code.trim()}{draft.promo_pct ? ` · ${draft.promo_pct}% off` : ''}
              </SummaryRow>
            )}
            <SummaryRow label="Schedule">{schedule}</SummaryRow>
            <SummaryRow label="Capacity">
              {draft.kind === 'consult' ? 'One seat (1:1)' : draft.capacity > 0 ? `${draft.capacity} seats` : 'Unlimited'}
            </SummaryRow>
            <SummaryText label="Typical reply" value={draft.response_time_min ? `${draft.response_time_min} min` : ''} />
            <SummaryList label="How it works" items={draft.content_how_it_works.map((h) => `${h.label} — ${h.body}`)} />
            <SummaryText label="House rules intro" value={draft.content_house_rules_intro} />
            <SummaryList label="House rules" items={draft.content_house_rules.map((r) => `${r.heading} — ${r.body}`)} />
            <SummaryList label="What you get" items={draft.content_what_you_get} />
            <SummaryList label="Who it's for" items={draft.content_who_for} />
            <SummaryList label="Not for" items={draft.content_not_for} />
            <SummaryList label="FAQ" items={draft.content_faq.map((q) => `${q.q} — ${q.a}`)} />
            <SummaryList label="Sample Q&A" items={draft.content_sample_qa.map((q) => `${q.q} — ${q.a}`)} />
            <SummaryList label="Joining" items={joinBits} />
            <SummaryRow label="Join lead time">{draft.content_join_lead_minutes} min before start</SummaryRow>
            <SummaryText label="Credential" value={draft.credential} />
            <SummaryText label="Preparation" value={draft.commercial_preparation_instructions} />
            <SummaryText label="Location" value={draft.location} />
            <SummaryRow label="Audience">{draft.adults_only ? 'Adults only (18+)' : 'Open to all ages'}</SummaryRow>
            {draft.kind === 'live_event' && (
              <SummaryRow label="Refunds">
                {draft.commercial_refund_window_hours === 0
                  ? 'No refunds'
                  : `Refundable up to ${draft.commercial_refund_window_hours} hours before the start`}
              </SummaryRow>
            )}
            {draft.kind === 'consult' && (
              <>
                <SummaryRow label="Cancellation">
                  {draft.commercial_cancellation_window_hours === 0
                    ? 'No cancellations'
                    : `Free cancellation up to ${draft.commercial_cancellation_window_hours} hours before`}
                </SummaryRow>
                <SummaryRow label="Rescheduling">{draft.commercial_reschedule_allowed ? 'Allowed' : 'Not allowed'}</SummaryRow>
                <SummaryRow label="Booking notice">{draft.commercial_booking_notice_hours} hours</SummaryRow>
                <SummaryRow label="No-show">The session is charged</SummaryRow>
              </>
            )}
          </div>
        </Card>

        {/* ── what they uploaded ────────────────────────────────────────── */}
        {(draft.cover_media.length > 0 || vid) && (
          <Card fillClassName="bg-paper2">
            {draft.cover_media.length > 0 && (
              <div>
                <span className={labelCls}>Photos ({draft.cover_media.length})</span>
                <div className="flex flex-wrap gap-2">
                  {draft.cover_media.map((c) => (
                    <img key={c.url} src={cfImage(c.url, { width: 240 })} alt=""
                      className="h-24 w-24 rounded-zine border-zine border-ink object-cover shadow-zine-xs" />
                  ))}
                </div>
              </div>
            )}
            {vid && (
              <div className={draft.cover_media.length > 0 ? 'mt-4' : ''}>
                <span className={labelCls}>Video</span>
                {ytId ? (
                  <div className="overflow-hidden rounded-zine border-zine border-ink shadow-zine-xs" style={{ aspectRatio: '16 / 9' }}>
                    <iframe src={`https://www.youtube.com/embed/${ytId}`} title="Listing video"
                      allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
                      allowFullScreen className="h-full w-full border-0" />
                  </div>
                ) : (
                  <a href={vid} target="_blank" rel="noreferrer" className="font-body font-bold text-[13px] text-blueInk underline break-all">
                    {vid}
                  </a>
                )}
              </div>
            )}
          </Card>
        )}

        {/* [WIZ-SUBMIT-PLAIN-1] Informational only — dots, never ticks, and it
            gates nothing. See publishReadiness in wizardLogic.ts. */}
        <div className="flex flex-col gap-2">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2">
              <span className={c.info ? 'text-inkMute' : c.ok ? 'text-lime' : 'text-coral'}>
                {c.info ? '·' : c.ok ? '✓' : '○'}
              </span>
              <span className={`font-body font-bold text-[14px] ${c.info ? 'text-inkSoft' : 'text-ink'}`}>{c.label}</span>
            </div>
          ))}
        </div>

        {/* [CAL-AUDIT-2026-09-15 · #5/#6] Publishing, the step-4 preview and the
            booking check all read the same Google readiness rule: the engine
            refuses a slot while the creator's Google source is not Ready
            (worker/src/cal/engine.ts → gcalAvailabilityReady). Say it here, in
            the same words the calendar uses, instead of letting the creator
            find out from a refused booking. */}
        {isDraftState && (
          <Card fillClassName="bg-paper2">
            <p className="font-body font-bold text-[13px] text-ink">Before your first booking</p>
            <p className="mt-1 font-body text-[12px] text-inkSoft">
              Bookings are accepted only while Calendar &amp; availability → Connected calendars shows <b>Ready</b> and names the calendars that block your time. If it shows Syncing or Needs attention, open that screen and use “Sync busy times now” (or Reconnect) before this listing goes live. The time you chose in step 4 is checked against the same rule.
            </p>
          </Card>
        )}

        {/* [WIZ-SUBMIT-PLAIN-1] The server's answer on submit lands here — with
            the local pre-check gone, this is where a creator finds out that a
            blocker is still open, so it must stay next to the button. */}
        {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

        {/* [LIST-SUBMIT-REVIEW-1] A real state machine — the creator can only ever
            be in exactly one of these. Publishing itself is an admin action; the
            creator's only self-serve action here is submitting a draft. */}
        {published && (
          <Card fillClassName="bg-paper2">
            <p className="font-body font-bold text-[13px] text-ink">This listing is published.</p>
            {publicHref && <a href={publicHref} className="mt-2 inline-block font-body font-bold text-[13px] text-blueInk underline">Open the public page</a>}
          </Card>
        )}
        {pendingReview && (
          <Card fillClassName="bg-lilac">
            <p className="font-body font-bold text-[13px] text-ink">Pending review</p>
            <p className="mt-1 font-body font-bold text-[13px] text-inkSoft">This listing is with the team for review. We’ll notify you as soon as it’s checked.</p>
          </Card>
        )}
        {approvedAwaitingPublish && (
          <Card fillClassName="bg-blue">
            <p className="font-body font-bold text-[13px] text-ink">Approved</p>
            <p className="mt-1 font-body font-bold text-[13px] text-inkSoft">This listing is approved and will go live shortly.</p>
          </Card>
        )}
        {rejected && (
          <Card fillClassName="bg-coral">
            <p className="font-body font-bold text-[13px] text-paper">Changes requested</p>
            <p className="mt-1 font-body font-bold text-[13px] text-paper">The team asked for changes before this can go live. Edit the earlier steps and send it for review again.</p>
          </Card>
        )}
        {isDraftState && (
          <>
            {/* [LIST-FORM-2] Renamed per spec §6 step 8 — "Submit for review"
                didn't say who reviews it or how long that takes. */}
            <Button variant="lime" label={rejected ? "Submit changes for review" : "Submit for human review"} loading={publishing} onClick={onSubmitForReview} fullWidth />
            <p className="font-body font-bold text-[12px] text-inkSoft">Usually checked within an hour; calendar or content issues can take up to 48 hours. We’ll email you when it is published or if more changes are needed.</p>
          </>
        )}
      </div>
      {/* [POSTER-FIRST-1 2026-09-05] Step 8 is the ONLY place a preview belongs,
          and it shows the real poster once one exists. Before that it explains
          what is coming rather than showing a mock of a card that no longer
          exists — a placeholder that looks like a finished product is worse
          than one that admits it is waiting. */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 text-center font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Your poster</p>
        <PosterPreview poster={draft.poster} draft={draft} creator={creator} />
      </div>
    </div>
  );
}

/** The real poster, or an honest account of why there isn't one yet. */
function PosterPreview({ poster, draft, creator }: {
  poster: PosterMirror | null; draft: ListingDraft; creator?: CreatorInfo;
}) {
  const url = poster?.variants?.portrait?.url || poster?.url;
  const status = poster?.status;

  if (url) {
    const title = poster?.copy?.title || draft.title;
    const tagline = poster?.copy?.tagline || draft.blurb;
    return (
      <div className="mx-auto w-full max-w-[320px]">
        <div className="relative overflow-hidden rounded-zine border-zine border-ink shadow-zine-xs">
          <img src={cfImage(url, { width: 640 })} alt={title || 'Listing poster'}
            className="block w-full" style={{ aspectRatio: '2 / 3', objectFit: 'cover' }} />
          {/* lettering === 'overlay' means the artwork is deliberately textless
              because the model could not be trusted to letter it — so the copy
              is drawn here, as real selectable text. */}
          {poster?.lettering === 'overlay' && (
            <div className="pointer-events-none absolute inset-x-0 top-0 p-3">
              <p className="font-display text-[26px] leading-[1.05] tracking-[0.055em] text-paper drop-shadow">{title}</p>
              {tagline && <p className="mt-1 font-body font-bold text-[13px] tracking-[0.04em] text-paper drop-shadow">{tagline}</p>}
            </div>
          )}
        </div>
        {status === 'rejected' && (
          <p className="mt-2 font-body font-bold text-[12px] text-coral">This poster was rejected — a new one will be generated.</p>
        )}
      </div>
    );
  }

  const message = status === 'generating'
    ? 'Painting your poster… this takes a few minutes. You can leave this page.'
    : status === 'failed'
      ? `We couldn’t paint a poster this time${poster?.error ? ` (${poster.error})` : ''}. Your next submission will keep this poster state; the team can retry it separately.`
      : 'Your poster is generated after you submit, from your title, category, tags and description.';

  return (
    <div className="mx-auto w-full max-w-[320px]">
      <div className="flex items-center justify-center rounded-zine border-zine border-dashed border-ink bg-paper2 p-5 text-center"
        style={{ aspectRatio: '2 / 3' }}>
        <p className="font-body text-[13px] text-inkSoft">{message}</p>
      </div>
      {creator?.name && (
        <p className="mt-2 text-center font-body text-[12px] text-inkSoft">Listing by {creator.name}</p>
      )}
    </div>
  );
}
