// [SAATHUM-PREETI-1] Event / article cards rendered inside the chat thread.
import type { PreetiCard } from '../../lib/preetiTypes';
import { safeHref } from './richText';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function formatIst(ms: number): string {
  return `${IST_FMT.format(new Date(ms))} IST`;
}

export function formatRupees(n: number): string {
  return n <= 0 ? 'Free' : `₹${n.toLocaleString('en-IN')}`;
}

interface Props {
  card: PreetiCard;
  onClick: (type: 'event' | 'article', id: string, action: string) => void;
}

export function CardView({ card, onClick }: Props) {
  if (card.type === 'article') {
    const href = safeHref(card.url);
    return (
      <article className="pt-card">
        {card.image && <img className="pt-card-img" src={card.image} alt="" loading="lazy" decoding="async" />}
        <div className="pt-card-body">
          <h4 className="pt-card-title">{card.title}</h4>
          <div className="pt-card-actions">
            {href && (
              <a className="pt-btn pt-btn--primary" href={href} onClick={() => onClick('article', card.slug, 'read')}>
                Read
              </a>
            )}
          </div>
        </div>
      </article>
    );
  }
  const read = safeHref(card.read_more_url);
  const book = safeHref(card.book_url);
  return (
    <article className="pt-card">
      {card.image && (
        <div className="pt-card-media">
          <img className="pt-card-img" src={card.image} alt="" loading="lazy" decoding="async" />
          {card.live_now && <span className="pt-badge-live">LIVE now</span>}
        </div>
      )}
      <div className="pt-card-body">
        {!card.image && card.live_now && <span className="pt-badge-live pt-badge-live--inline">LIVE now</span>}
        <h4 className="pt-card-title">{card.title}</h4>
        <p className="pt-card-meta">
          {card.starts_at_ms != null && <span>{formatIst(card.starts_at_ms)}</span>}
          {card.price_rupees != null && <span className="pt-card-price">{formatRupees(card.price_rupees)}</span>}
        </p>
        <div className="pt-card-actions">
          {read && (
            <a className="pt-btn" href={read} onClick={() => onClick('event', card.id, 'read_more')}>
              Read more
            </a>
          )}
          {card.booking_open && book ? (
            <a className="pt-btn pt-btn--primary" href={book} onClick={() => onClick('event', card.id, 'book')}>
              Book now
            </a>
          ) : (
            <span className="pt-btn pt-btn--disabled" aria-disabled="true">
              Booking closed
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
