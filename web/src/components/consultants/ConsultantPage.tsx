// [AUMFE-CONSULT-F1-1 2026-10-02] /guides/<slug> — one consultant's category page (replica of Guide*.dc.html + Guide*M.dc.html).
// Desktop layout >= 1024px, mobile layout below, ONE component (CSS switches; cp-d / cp-m = desktop-only / mobile-only text).
//
// NOTE FOR AI:
//  - ADMIN-PREVIEW ONLY while the flag is off: the worker answers 404/empty for non-previewers; we then show "Opening soon"
//    and no data. usePreview() only decides which message (and shows the previewer ribbon) — the worker is the authority.
//  - Category = ?d=<discipline> if the consultant offers it, else their first discipline. The pill switcher is client-side.
//  - Book link = /guides/<slug>/book?d=<discipline>&slot=<start_ms> (lane F2 owns that page).
//  - Never type the brand name here — BRAND only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import '../../styles/consultants.css';
import './consultant-pages.css';
import PreviewRibbon from '../PreviewRibbon';
import { usePreview } from '../../lib/preview';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import { BRAND } from '../../lib/brand';
import type { ConsultantCard, Discipline } from '../../lib/consultTypes';
import { fetchDetail, fetchList, type DetailResponse } from './api';
import { catOf, fill, REMINDER_LINE } from './categoryContent';
import { dayShort, rupees } from './format';
import BookingCalendar, { type SlotChoice } from './BookingCalendar';
import CategoryHero from './CategoryHero';
import CategoryPreview, { TarotSpread } from './CategoryPreview';
import { CardHeading } from './SectionHeading';
import SectionHeading from './SectionHeading';
import Faq from './Faq';
import OtherGuides from './OtherGuides';
import PrepCard from './PrepCard';
import Reviews from './Reviews';
import RichNote from './RichNote';
import WithAuth from './WithAuth';

type Status = 'loading' | 'ok' | 'missing' | 'error';

export default function ConsultantPage({ slug, initialDiscipline }: { slug: string; initialDiscipline?: string | null }) {
  return <WithAuth><Page slug={slug} initialDiscipline={initialDiscipline ?? null} /></WithAuth>;
}

function readUrlDiscipline(fallback: string | null): string | null {
  try { return new URLSearchParams(window.location.search).get('d') ?? fallback; } catch { return fallback; }
}

function Page({ slug, initialDiscipline }: { slug: string; initialDiscipline: string | null }) {
  const { preview, loading: previewLoading } = usePreview();
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<DetailResponse | null>(null);
  const [list, setList] = useState<ConsultantCard[]>([]);
  const [picked, setPicked] = useState<string | null>(initialDiscipline);
  const [sel, setSel] = useState<SlotChoice | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { setPicked(readUrlDiscipline(initialDiscipline)); }, [initialDiscipline]);

  useEffect(() => {
    let alive = true;
    setStatus((s) => (s === 'ok' ? s : 'loading'));
    fetchDetail(slug).then((r) => {
      if (!alive) return;
      setData(r); setStatus('ok');
    }).catch((e) => {
      if (!alive) return;
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { setData(null); setStatus('missing'); }
      else { captureException(e, { where: 'consult_page', slug }); setData(null); setStatus('error'); }
    });
    return () => { alive = false; };
    // preview flips (sign-in resolved) -> ask again, the worker may now show the hidden guide.
  }, [slug, preview, attempt]);

  useEffect(() => {
    if (status !== 'ok') return;
    let alive = true;
    fetchList().then((l) => { if (alive) setList(l); }).catch((e) => captureException(e, { where: 'consult_page_list', slug }));
    return () => { alive = false; };
  }, [status, slug, preview]);

  const c = data?.consultant ?? null;
  const disc: Discipline | null = c ? (picked && (c.disciplines as string[]).includes(picked) ? (picked as Discipline) : c.disciplines[0]) : null;

  useEffect(() => {
    if (status === 'ok' && c && disc) capture('consult_page_viewed', { slug, discipline: disc });
  }, [status, slug, disc]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseDisc = useCallback((d: Discipline) => {
    setPicked(d);
    try {
      const u = new URL(window.location.href);
      if (c && d === c.disciplines[0]) u.searchParams.delete('d'); else u.searchParams.set('d', d);
      window.history.replaceState(null, '', u.toString());
    } catch { /* URL API unavailable — the pill still switches the view */ }
  }, [c]);

  const bookHref = useCallback((slot: SlotChoice | null) =>
    `/guides/${encodeURIComponent(slug)}/book?d=${disc ?? ''}${slot ? `&slot=${slot.start_ms}` : ''}`, [slug, disc]);
  const onBook = useCallback((slot: SlotChoice | null) => capture('consult_book_clicked', { slug, discipline: disc, has_slot: !!slot, slot_start_ms: slot?.start_ms ?? null }), [slug, disc]);
  const onPick = useCallback((s: SlotChoice) => capture('consult_slot_selected', { slug, discipline: disc, slot_start_ms: s.start_ms, date: s.date }), [slug, disc]);

  const cat = useMemo(() => (disc ? catOf(disc) : null), [disc]);

  if (status !== 'ok' || !c || !disc || !cat) {
    if (status === 'loading' || (status !== 'ok' && previewLoading && hasClerkSessionHint())) return <Shell><p className="cp-state" aria-busy="true">Loading…</p></Shell>;
    if (status === 'error' && preview) {
      return <Shell><div className="cp-state"><h1>We could not load this guide</h1><p>Please check your connection and try again.</p><button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div></Shell>;
    }
    if (status === 'missing' && preview) {
      return <Shell><div className="cp-state"><PreviewRibbon force /><h1>This guide is not available</h1><p>It may be paused or not published yet.</p><a className="btn ghost" href="/guides">All guides</a></div></Shell>;
    }
    return <OpeningSoon />;
  }

  const name = c.name;
  const isTarot = cat.key === 'tarot';
  const readyTitle = cat.readyTitleM ? <><h2 className="cp-d">{cat.readyTitle}</h2><h2 className="cp-m">{cat.readyTitleM}</h2></> : <h2>{cat.readyTitle}</h2>;

  return (
    <div className={`consult-ui ${cat.cls} cp-page`} data-consult-page={slug}>
      <div className="toran cp-toran" />
      <div className="cp-back"><a href="/guides">← Guides</a></div>
      {preview ? <div className="cp-previewbar"><PreviewRibbon force /></div> : null}
      <CategoryHero c={c} disc={disc} cat={cat} onDisc={chooseDisc} bookHref={bookHref(sel)} onBook={() => onBook(sel)} />
      <div className="ribbon" />

      <section className="cp-sec tint" aria-labelledby="cp-ready">
        <div className="sec-h" id="cp-ready"><span className="deva">{cat.readyDeva}</span>{readyTitle}
          <p className="cp-d">{fill(cat.readyBlurb, name)}</p><p className="cp-m">{fill(cat.readyBlurbM, name)}</p></div>
        {isTarot ? (
          <>
            <TarotSpread />
            <div className="cp-prepgrid four">{cat.prep.map((it) => <PrepCard key={it.h} item={it} name={name} />)}</div>
          </>
        ) : (
          <div className="cp-ready">
            <CategoryPreview kind={cat.key as 'astro' | 'numero' | 'palm' | 'face'} />
            <div className="cp-prepgrid">{cat.prep.map((it) => <PrepCard key={it.h} item={it} name={name} />)}</div>
          </div>
        )}
      </section>

      <section className="cp-sec">
        <SectionHeading deva="परामर्श में क्या होगा" title="What you can ask about" />
        <div className="cp-ask">
          {cat.ask.map((a) => (
            <div key={a.deva} className="card frame cp-ask-tile"><span className="deva">{a.deva}</span>
              {a.m ? <><strong className="cp-d">{a.en}</strong><strong className="cp-m">{a.m}</strong></> : <strong>{a.en}</strong>}</div>
          ))}
        </div>
      </section>

      <section className="cp-sec buti cp-two">
        <div className="card frame cp-keep">
          <CardHeading deva="तैयारी" title={cat.keepTitle} titleMobile={cat.keepTitleM} />
          {cat.keepKind === 'photo' ? (
            <div className="cp-photos">
              {cat.photoTiles.map((t) => (
                <div key={t.label}><span className={`cp-phototile${t.bad ? ' bad' : ''}`}>{t.label}</span><span>{t.note}</span></div>
              ))}
            </div>
          ) : null}
          <ul className="cp-d">{cat.keepList.map((x) => <li key={x}>{fill(x, name)}</li>)}</ul>
          <ul className="cp-m">{cat.keepListM.map((x) => <li key={x}>{fill(x, name)}</li>)}</ul>
          {cat.keepNote ? <div className="promise cp-note"><span className="cp-d"><RichNote text={cat.keepNote} name={name} /></span><span className="cp-m"><RichNote text={cat.keepNoteM ?? cat.keepNote} name={name} /></span></div> : null}
        </div>
        <div className="card frame cp-howcard">
          <CardHeading deva="विधि" title={cat.stepsTitle} titleMobile={cat.stepsTitleM} />
          <div className="cp-steps">
            {cat.steps.map((s) => <div key={s.n} className="step"><span className="n">{s.n}</span><strong>{fill(s.h, name)}</strong><span className="hint">{fill(s.hint, name)}</span></div>)}
          </div>
          <span className="hint cp-d">{REMINDER_LINE}</span>
        </div>
      </section>

      <section className="cp-sec tint cp-calrev" aria-label="Book a time and read reviews">
        <BookingCalendar key={slug} slug={slug} total={c.price.total} bookLabel={cat.bookLabel} bookHref={bookHref} onChange={setSel} onPick={onPick} onBook={onBook} />
        <Reviews key={slug} slug={slug} first={data!.reviews} pages={data!.review_pages} sample={data!.sample_reviews} deva="अनुभव" />
      </section>

      <section className="cp-sec cp-faqwrap">
        <div>
          <CardHeading deva="प्रश्नोत्तर" title="Questions people ask" size={28} />
          <Faq desktop={cat.faq} mobile={cat.faqM} name={name} />
        </div>
        <div className="promise cp-promise">
          <span className="deva">{cat.promise.deva}</span>
          <h3>{cat.promise.h}</h3>
          <p className="cp-d">{fill(cat.promise.p, name)}</p><p className="cp-m">{fill(cat.promise.pM, name)}</p>
        </div>
      </section>

      <OtherGuides list={list} slug={slug} disc={disc} />
      <div className="ribbon" />

      <div className="cp-bar" role="region" aria-label="Book this guide">
        <div className="cp-bar-price"><span>{rupees(c.price.total)}</span><span className="hint">{c.slot_minutes} min · incl. GST</span></div>
        <a className="btn cat" href={bookHref(sel)} onClick={() => onBook(sel)} style={{ flexGrow: 1 }}>{sel ? `Book ${dayShort(sel.date)} ${sel.label}` : cat.bookLabel}</a>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="consult-ui cp-page"><div className="toran cp-toran" />{children}<div className="ribbon" /></div>;
}

/** Calm state for everyone who is not allowed to see the (still hidden) guides. No data is requested or shown. */
export function OpeningSoon() {
  return (
    <Shell>
      <div className="cp-state" data-consult-dark>
        <span className="deva">जल्द ही</span>
        <h1>Opening soon</h1>
        <p>Our one-to-one guides are not open for bookings just yet. {BRAND.name} will let you know when they are.</p>
        <a className="btn" href="/">Back to the home page</a>
      </div>
    </Shell>
  );
}
